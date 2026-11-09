import type { ApprovalAction } from "@cobra/contracts";

import { type GoogleReadDeps, LIVE_READ_DEPS, queryText, readable, ReadRequestError } from "./calendar.ts";
import { googleRefusal } from "./gmail.ts";
import { GMAIL_API, inTurn, MAIL_QUERY_MAX, MESSAGE_ID } from "./gmailRead.ts";
import { GoogleAuthError, type GoogleGrant, SCOPE_GMAIL_MODIFY } from "./googleAuth.ts";

/**
 * Organizing the person's mail for a Foreman: label, archive, mark read, star and trash, on the
 * account's Google connection with the `gmail.modify` scope, which the
 * person turns on as its own step ("Organize mail"). It is never in the
 * first Connect, and without it the work is a MailboxOffError that says where.
 *
 * Nothing here deletes for good. `gmail.modify` cannot, Cobra never asks
 * for the scope that can, and trash is the strongest thing a batch does:
 * Gmail keeps trashed mail 30 days and `untrash` brings it back.
 *
 * A change is a batch, and a batch is frozen. `resolveMailbox` runs when a
 * Foreman proposes: it searches (or takes the ids it was given), reads each
 * message's labels and sender, drops what the operation would not change, and
 * returns the exact ids with a breakdown the agent counted itself. That
 * becomes an approval; the person's Allow makes `organizeMail` apply the
 * operation to those ids and no others, so mail that arrived after the card
 * was made is never swept in, and a model cannot reword what the card says.
 *
 * Mail is other people's text: a subject passes `scrubSecrets` (readable)
 * before the card or a model shows it. The sender's address stays as it is.
 */

export type MailboxBatch = NonNullable<ApprovalAction["mailbox"]>;

export const MAILBOX_OPS = ["archive", "unarchive", "mark_read", "mark_unread", "star", "unstar", "label", "unlabel", "trash", "untrash"] as const;
export type MailboxOp = (typeof MAILBOX_OPS)[number];

/** The most messages one card holds. */
export const MAX_BATCH = 200;
/** The most messages the agent changes in 24 hours, across every card (pending, allowed or done). */
export const MAILBOX_DAILY = 1000;
/** Metadata reads and single trashes in flight at once, under Gmail's per-user rate. */
const AT_ONCE = 5;
/** One call to Gmail must answer in this long. */
export const ORGANIZE_TIMEOUT_MS = 30_000;
/** The senders a card lists by name; the rest are counted together. */
const SENDERS_LISTED = 8;
/** The messages a card shows as examples. */
const SAMPLES = 5;
/** A label name, at most. */
export const LABEL_MAX = 100;

/** Names a person's own label may not take: they are Gmail's, and a "Trash" label would only confuse. */
const RESERVED = new Set(["inbox", "sent", "draft", "drafts", "spam", "trash", "unread", "starred", "important", "chat", "all mail", "scheduled", "snoozed", "category_personal", "category_social", "category_promotions", "category_updates", "category_forums"]);

const TURN_ON = "Cobra cannot organize the person's mail yet: its Google connection does not carry Organize mail (gmail.modify). The person turns on Mail in the app (Settings → Integrations → Google), which allows it";

/** The Google connection works but does not carry gmail.modify: a 409 whose message is the step to take. */
export class MailboxOffError extends GoogleAuthError {
  constructor() {
    super("google_reconnect");
    this.message = TURN_ON;
  }
}

export type MailboxDeps = GoogleReadDeps;

// --- the request ---------------------------------------------------------------------

export type MailboxRequest = { op: MailboxOp; label?: string; query?: string; ids?: string[] };

/** A mailbox request, or a ReadRequestError saying the one thing wrong. */
export function mailboxRequest(body: Record<string, unknown>): MailboxRequest {
  const op = typeof body.op === "string" ? body.op.trim().toLowerCase() : "";
  if (!(MAILBOX_OPS as readonly string[]).includes(op)) throw new ReadRequestError(`op is one of ${MAILBOX_OPS.join(", ")}`);
  const request: MailboxRequest = { op: op as MailboxOp };
  const named = op === "label" || op === "unlabel";
  if (named) request.label = labelName(body.label);
  else if (body.label !== undefined) throw new ReadRequestError(`${op} takes no label`);
  const query = queryText(body.query, MAIL_QUERY_MAX, false);
  const hasIds = body.ids !== undefined;
  if (query !== undefined && hasIds) throw new ReadRequestError("give a query or ids, not both");
  if (query === undefined && !hasIds) throw new ReadRequestError("give a query (Gmail's search words) or ids (from mail_search)");
  if (query !== undefined) request.query = query;
  if (hasIds) {
    if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > MAX_BATCH) throw new ReadRequestError(`ids is a list of 1 to ${MAX_BATCH} message ids from mail_search`);
    const seen = new Set<string>();
    for (const raw of body.ids) {
      if (typeof raw !== "string" || !MESSAGE_ID.test(raw.trim())) throw new ReadRequestError("ids holds only message ids from mail_search: letters and digits, 8 to 64 of them");
      seen.add(raw.trim());
    }
    request.ids = [...seen];
  }
  return request;
}

function labelName(raw: unknown): string {
  if (typeof raw !== "string") throw new ReadRequestError("label is the name of one of the person's labels");
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name || name.length > LABEL_MAX) throw new ReadRequestError(`label is a name of 1 to ${LABEL_MAX} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ReadRequestError("label has a character a label cannot hold");
  if (RESERVED.has(name.toLowerCase())) throw new ReadRequestError(`"${name}" is one of Gmail's own places, not a label; archive, mark_read, star and trash do those`);
  return name;
}

// --- Gmail ---------------------------------------------------------------------------

type Call = { method: "GET" | "POST"; path: string; body?: unknown };

const SCOPE_REFUSED = /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i;

async function modifyGrant(deps: MailboxDeps): Promise<GoogleGrant> {
  const grant = await deps.grant();
  if (!grant.scopes.includes(SCOPE_GMAIL_MODIFY)) throw new MailboxOffError();
  return grant;
}

async function once(deps: MailboxDeps, grant: GoogleGrant, call: Call): Promise<Response> {
  try {
    return await deps.fetcher(`${GMAIL_API}${call.path}`, {
      method: call.method,
      headers: { authorization: `Bearer ${grant.accessToken}`, accept: "application/json", ...(call.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
      signal: AbortSignal.timeout(ORGANIZE_TIMEOUT_MS),
    });
  } catch (caught) {
    const why = caught instanceof Error ? (caught.name === "TimeoutError" ? `no answer in ${ORGANIZE_TIMEOUT_MS / 1000} s` : caught.message) : String(caught);
    throw new Error(`Gmail could not be reached: ${why}`);
  }
}

/** One call as JSON ({} for an empty answer, or null for a 404), on a modify grant: a 401 asks once more on a fresh one. Google's refusals are Errors in googleRefusal's words, never the token. */
async function gmail(deps: MailboxDeps, call: Call): Promise<unknown> {
  let grant = await modifyGrant(deps);
  let response = await once(deps, grant, call);
  if (response.status === 401) {
    await response.text().catch(() => "");
    deps.clearGrant();
    grant = await modifyGrant(deps);
    response = await once(deps, grant, call);
    if (response.status === 401) {
      await response.text().catch(() => "");
      deps.clearGrant();
      throw new GoogleAuthError("google_reconnect", "Gmail refused a fresh sign-in too");
    }
  }
  const text = await response.text().catch(() => "");
  if (response.status === 404) return null;
  if (!response.ok) {
    if (response.status === 403 && SCOPE_REFUSED.test(text)) throw new MailboxOffError();
    throw new Error(googleRefusal("Gmail", response.status, text));
  }
  try {
    return text.trim() === "" ? {} : (JSON.parse(text) as unknown);
  } catch {
    throw new Error("Gmail answered with something that is not JSON");
  }
}

type Label = { id: string; name: string };

async function listLabels(deps: MailboxDeps): Promise<Label[]> {
  const body = (await gmail(deps, { method: "GET", path: "/labels" })) as { labels?: Array<{ id?: unknown; name?: unknown; type?: unknown }> } | null;
  return (body?.labels ?? []).filter((label): label is { id: string; name: string; type?: unknown } => typeof label.id === "string" && typeof label.name === "string" && label.type !== "system").map(({ id, name }) => ({ id, name }));
}

const sameName = (a: string, b: string): boolean => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

// --- what an operation changes -------------------------------------------------------

type Verdict = "change" | "already" | "starred";

/** What `op` would do to a message that carries `labels` (Gmail label ids, the person's label by its id in `labelId`). */
function verdictFor(op: MailboxOp, labels: readonly string[], labelId: string | undefined): Verdict {
  const has = (id: string) => labels.includes(id);
  const yes = (changes: boolean): Verdict => (changes ? "change" : "already");
  switch (op) {
    case "archive":
      return yes(has("INBOX"));
    case "unarchive":
      return yes(!has("INBOX") && !has("TRASH") && !has("SPAM"));
    case "mark_read":
      return yes(has("UNREAD"));
    case "mark_unread":
      return yes(!has("UNREAD"));
    case "star":
      return yes(!has("STARRED"));
    case "unstar":
      return yes(has("STARRED"));
    case "label":
      return yes(labelId === undefined || !has(labelId));
    case "unlabel":
      return yes(labelId !== undefined && has(labelId));
    case "trash":
      if (has("TRASH")) return "already";
      // Starred mail is the person's own mark of "keep": a batch never trashes it.
      return has("STARRED") ? "starred" : "change";
    case "untrash":
      return yes(has("TRASH"));
  }
}

/** The label ids an operation adds and removes. */
function changesOf(op: MailboxOp, labelId: string | undefined): { add: string[]; remove: string[] } {
  switch (op) {
    case "archive":
      return { add: [], remove: ["INBOX"] };
    case "unarchive":
      return { add: ["INBOX"], remove: [] };
    case "mark_read":
      return { add: [], remove: ["UNREAD"] };
    case "mark_unread":
      return { add: ["UNREAD"], remove: [] };
    case "star":
      return { add: ["STARRED"], remove: [] };
    case "unstar":
      return { add: [], remove: ["STARRED"] };
    case "label":
      return { add: labelId ? [labelId] : [], remove: [] };
    case "unlabel":
      return { add: [], remove: labelId ? [labelId] : [] };
    default:
      return { add: [], remove: [] };
  }
}

export const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** What Allow will do, as the card's first line. */
export function mailboxHeadline(batch: Pick<MailboxBatch, "op" | "label" | "newLabel" | "ids" | "box">): string {
  const n = plural(batch.ids.length, "message", "messages");
  // A Space's own mailbox (boxMail.ts) has folders where Gmail has labels, and a flag where Gmail has a star.
  if (batch.box) {
    switch (batch.op) {
      case "archive":
        return `Archive ${n}: out of the inbox, into the Archive folder`;
      case "star":
        return `Flag ${n}`;
      case "unstar":
        return `Take the flag off ${n}`;
      case "label":
        return `Move ${n} into the folder "${batch.label ?? ""}"${batch.newLabel ? " (a new folder Allow creates)" : ""}`;
      case "unlabel":
        return `Move ${n} out of the folder "${batch.label ?? ""}", back to the inbox`;
      case "trash":
        return `Move ${n} to the Trash folder; nothing is deleted for good`;
      case "untrash":
        return `Move ${n} out of the Trash, back to the inbox`;
    }
  }
  switch (batch.op) {
    case "archive":
      return `Archive ${n}: out of the inbox, still in All Mail`;
    case "unarchive":
      return `Move ${n} back to the inbox`;
    case "mark_read":
      return `Mark ${n} as read`;
    case "mark_unread":
      return `Mark ${n} as unread`;
    case "star":
      return `Star ${n}`;
    case "unstar":
      return `Take the star off ${n}`;
    case "label":
      return `Label ${n} "${batch.label ?? ""}"${batch.newLabel ? " (a new label Allow creates)" : ""}`;
    case "unlabel":
      return `Take the label "${batch.label ?? ""}" off ${n}`;
    case "trash":
      return `Move ${n} to the trash: Gmail keeps them 30 days, and nothing is deleted for good`;
    case "untrash":
      return `Move ${n} out of the trash, back where they were`;
    default:
      return `${batch.op} ${n}`;
  }
}

/** What was done, past tense, for the result line the Foreman and the person read. */
export function mailboxDone(batch: Pick<MailboxBatch, "op" | "label" | "box">, count: number): string {
  const n = plural(count, "message", "messages");
  if (batch.box) {
    switch (batch.op) {
      case "archive":
        return `archived ${n} into the Archive folder`;
      case "star":
        return `flagged ${n}`;
      case "unstar":
        return `took the flag off ${n}`;
      case "label":
        return `moved ${n} into the folder "${batch.label ?? ""}"`;
      case "unlabel":
        return `moved ${n} out of the folder "${batch.label ?? ""}" to the inbox`;
      case "trash":
        return `moved ${n} to the Trash folder`;
      case "untrash":
        return `moved ${n} out of the Trash to the inbox`;
    }
  }
  switch (batch.op) {
    case "archive":
      return `archived ${n}`;
    case "unarchive":
      return `moved ${n} back to the inbox`;
    case "mark_read":
      return `marked ${n} as read`;
    case "mark_unread":
      return `marked ${n} as unread`;
    case "star":
      return `starred ${n}`;
    case "unstar":
      return `took the star off ${n}`;
    case "label":
      return `labelled ${n} "${batch.label ?? ""}"`;
    case "unlabel":
      return `took the label "${batch.label ?? ""}" off ${n}`;
    case "trash":
      return `moved ${n} to the trash (Gmail keeps them 30 days)`;
    case "untrash":
      return `moved ${n} out of the trash`;
    default:
      return `${batch.op}: ${n}`;
  }
}

/** The operation that puts a batch back, for the undo hint. Null for none. */
export function inverseOf(op: MailboxOp): MailboxOp {
  const pairs: Record<MailboxOp, MailboxOp> = { archive: "unarchive", unarchive: "archive", mark_read: "mark_unread", mark_unread: "mark_read", star: "unstar", unstar: "star", label: "unlabel", unlabel: "label", trash: "untrash", untrash: "trash" };
  return pairs[op];
}

// --- at propose: freeze the batch ----------------------------------------------------

type Seen = { id: string; labels: string[]; from: string; subject: string };

const flat = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/** The address in a From header, lower case, for counting senders. */
function addressOf(from: string): string {
  const bracket = /<([^>]+)>/.exec(from)?.[1];
  return (bracket ?? from).trim().toLowerCase();
}

/**
 * The batch a request means, worked out now and frozen: the messages the
 * search (or the ids) found, those the operation would change, and what the
 * card shows of them. `remaining` is how many more messages today's limit
 * lets the agent change. A ReadRequestError says what to change in the
 * request; a MailboxOffError says the step the person takes.
 */
export async function resolveMailbox(deps: Partial<MailboxDeps>, request: MailboxRequest, remaining: number = MAILBOX_DAILY): Promise<MailboxBatch> {
  const live: MailboxDeps = { ...LIVE_READ_DEPS, ...deps };
  if (remaining <= 0) throw new ReadRequestError(`the limit of ${MAILBOX_DAILY} messages changed in a day is reached; it opens up again as the day's cards age out`);

  let label: Label | undefined;
  let newLabel = false;
  if (request.label !== undefined) {
    const labels = await listLabels(live);
    label = labels.find((candidate) => sameName(candidate.name, request.label!));
    if (!label && request.op === "unlabel") {
      const known = labels.map((candidate) => candidate.name).slice(0, 20);
      throw new ReadRequestError(`no label called "${request.label}"${known.length ? `; the person's labels include ${known.map((name) => `"${name}"`).join(", ")}` : ""}`);
    }
    newLabel = !label && request.op === "label";
  }

  let ids = request.ids ?? [];
  let more = false;
  if (request.query !== undefined) {
    const params = new URLSearchParams({ q: request.query, maxResults: String(MAX_BATCH) });
    // Spam and trash stay out of a search unless the operation is about the trash.
    if (request.op === "untrash") params.set("includeSpamTrash", "true");
    const listed = (await gmail(live, { method: "GET", path: `/messages?${params}` })) as { messages?: Array<{ id?: unknown }>; nextPageToken?: unknown } | null;
    ids = (listed?.messages ?? []).map((message) => (typeof message?.id === "string" ? message.id : "")).filter((id) => MESSAGE_ID.test(id));
    more = typeof listed?.nextPageToken === "string" && listed.nextPageToken !== "";
  }
  if (ids.length === 0) throw new ReadRequestError("no message matches that");

  const metadata = new URLSearchParams({ format: "metadata" });
  for (const name of ["From", "Subject"]) metadata.append("metadataHeaders", name);
  const read = await inTurn(ids, AT_ONCE, async (id): Promise<Seen | null> => {
    const raw = (await gmail(live, { method: "GET", path: `/messages/${encodeURIComponent(id)}?${metadata}` })) as { labelIds?: unknown; payload?: { headers?: Array<{ name?: unknown; value?: unknown }> } } | null;
    if (!raw) return null;
    const headers = raw.payload?.headers ?? [];
    const named = (wanted: string) => flat(headers.find((header) => typeof header?.name === "string" && header.name.toLowerCase() === wanted)?.value);
    return { id, labels: Array.isArray(raw.labelIds) ? raw.labelIds.filter((entry): entry is string => typeof entry === "string") : [], from: named("from").slice(0, 100), subject: named("subject") };
  });

  const skipped = { alreadyDone: 0, starred: 0, missing: 0 };
  const changing: Seen[] = [];
  for (const seen of read) {
    if (!seen) {
      skipped.missing += 1;
      continue;
    }
    const verdict = verdictFor(request.op, seen.labels, label?.id);
    if (verdict === "change") changing.push(seen);
    else if (verdict === "starred") skipped.starred += 1;
    else skipped.alreadyDone += 1;
  }
  if (changing.length === 0) {
    const why = [skipped.alreadyDone ? `${skipped.alreadyDone} already as asked` : "", skipped.starred ? `${skipped.starred} starred, which a batch never trashes` : "", skipped.missing ? `${skipped.missing} gone` : ""].filter(Boolean).join(", ");
    throw new ReadRequestError(`nothing to change: ${plural(ids.length, "message", "messages")} found, ${why || "none changed"}`);
  }
  if (changing.length > remaining) {
    throw new ReadRequestError(`this would change ${changing.length} messages and only ${remaining} more may be changed today (limit ${MAILBOX_DAILY} a day); narrow the search`);
  }

  return frozenBatch(request, changing, { matched: ids.length, skipped, more, label: label?.name, newLabel });
}

/** The card's numbers for the messages a batch changes, counted here: who they are from (the most frequent first) and a few examples. Gmail's and a mailbox's batches alike (boxMail.ts). */
export function frozenBatch(
  request: MailboxRequest,
  changing: readonly { id: string; from: string; subject: string }[],
  found: { matched: number; skipped: MailboxBatch["skipped"]; more: boolean; label?: string | undefined; newLabel: boolean },
): MailboxBatch {
  const counted = new Map<string, { from: string; count: number }>();
  for (const seen of changing) {
    const key = addressOf(seen.from);
    const entry = counted.get(key);
    if (entry) entry.count += 1;
    else counted.set(key, { from: seen.from || "(no sender)", count: 1 });
  }
  const ranked = [...counted.values()].sort((a, b) => b.count - a.count);
  const senders = ranked.slice(0, SENDERS_LISTED).map(({ from, count }) => ({ from, count }));
  const rest = ranked.slice(SENDERS_LISTED);
  if (rest.length > 0) senders.push({ from: `${rest.length} other sender${rest.length === 1 ? "" : "s"}`, count: rest.reduce((sum, entry) => sum + entry.count, 0) });

  return {
    op: request.op,
    ...(request.label !== undefined ? { label: found.label ?? request.label } : {}),
    ...(found.newLabel ? { newLabel: true } : {}),
    ...(request.query !== undefined ? { query: request.query } : {}),
    ids: changing.map((seen) => seen.id),
    matched: found.matched,
    skipped: found.skipped,
    more: found.more,
    senders,
    samples: changing.slice(0, SAMPLES).map((seen) => ({ from: seen.from || "(no sender)", subject: readable(seen.subject || "(no subject)", 120) })),
  };
}

// --- at Allow: apply it --------------------------------------------------------------

export type MailboxOutcome = {
  /** Messages changed. */
  changed: number;
  /** Messages Gmail refused (a trash that failed); 0 for the batch calls, which are all or nothing. */
  failed: number;
  /** Why the first failure failed, in Google's words. */
  failure?: string;
  /** The label Allow created, when it did. */
  createdLabel?: string;
};

/** Applies the batch's operation to its ids and no others. Errors say what Gmail said; a MailboxOffError says the step to take. */
export async function organizeMail(deps: Partial<MailboxDeps>, batch: MailboxBatch): Promise<MailboxOutcome> {
  const live: MailboxDeps = { ...LIVE_READ_DEPS, ...deps };
  const op = batch.op as MailboxOp;
  if (!(MAILBOX_OPS as readonly string[]).includes(op)) throw new Error(`no mailbox operation called ${batch.op}`);
  if (batch.ids.length === 0 || batch.ids.length > MAX_BATCH || !batch.ids.every((id) => MESSAGE_ID.test(id))) throw new Error("the card holds no usable message ids");

  if (op === "trash" || op === "untrash") {
    let changed = 0;
    let failed = 0;
    let failure: string | undefined;
    await inTurn(batch.ids, AT_ONCE, async (id) => {
      try {
        // 404: the message is gone since the card, so there is nothing to move.
        if ((await gmail(live, { method: "POST", path: `/messages/${encodeURIComponent(id)}/${op}` })) !== null) changed += 1;
      } catch (caught) {
        // The connection itself failing stops the batch's every message the same way; report it once.
        if (caught instanceof GoogleAuthError) throw caught;
        failed += 1;
        failure ??= caught instanceof Error ? caught.message : String(caught);
      }
    });
    return { changed, failed, ...(failure ? { failure } : {}) };
  }

  let labelId: string | undefined;
  let createdLabel: string | undefined;
  if (batch.label !== undefined) {
    const labels = await listLabels(live);
    labelId = labels.find((candidate) => sameName(candidate.name, batch.label!))?.id;
    if (!labelId && op === "label") {
      const made = (await gmail(live, { method: "POST", path: "/labels", body: { name: batch.label, labelListVisibility: "labelShow", messageListVisibility: "show" } })) as { id?: unknown } | null;
      if (typeof made?.id !== "string") throw new Error(`Gmail did not create the label "${batch.label}"`);
      labelId = made.id;
      createdLabel = batch.label;
    }
    if (!labelId) throw new Error(`the label "${batch.label}" is no longer in Gmail`);
  }
  const { add, remove } = changesOf(op, labelId);
  await gmail(live, { method: "POST", path: "/messages/batchModify", body: { ids: batch.ids, addLabelIds: add, removeLabelIds: remove } });
  return { changed: batch.ids.length, failed: 0, ...(createdLabel ? { createdLabel } : {}) };
}
