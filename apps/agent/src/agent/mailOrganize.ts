import type { ApprovalAction } from "@cobra/contracts";

import { MAIL_QUERY_MAX, MESSAGE_ID, queryText, readable, ReadRequestError } from "./mailShapes.ts";

/**
 * Organizing a Space's own mailbox for a Foreman (boxMail.ts does the work
 * over IMAP): archive, mark read, flag, move to a folder and trash. This
 * file holds what the request, the card and the result share.
 *
 * Nothing here deletes for good: trash is the strongest thing a batch does.
 *
 * A change is a batch, and a batch is frozen. When a Foreman proposes, the
 * agent searches (or takes the ids it was given), drops what the operation
 * would not change, and keeps the exact ids with a breakdown it counted
 * itself. That becomes an approval; the person's Allow applies the operation
 * to those ids and no others, so mail that arrived after the card was made
 * is never swept in, and a model cannot reword what the card says.
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
/** The senders a card lists by name; the rest are counted together. */
const SENDERS_LISTED = 8;
/** The messages a card shows as examples. */
const SAMPLES = 5;
/** A label name, at most. */
export const LABEL_MAX = 100;

/** Names a person's own folder may not take: they are the mailbox's own places, and a "Trash" folder would only confuse. */
const RESERVED = new Set(["inbox", "sent", "draft", "drafts", "spam", "trash", "unread", "starred", "important", "chat", "all mail", "scheduled", "snoozed", "category_personal", "category_social", "category_promotions", "category_updates", "category_forums"]);

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
  if (RESERVED.has(name.toLowerCase())) throw new ReadRequestError(`"${name}" is one of the mailbox's own places, not a folder; archive, mark_read, star and trash do those`);
  return name;
}

export const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** What Allow will do, as the card's first line. */
export function mailboxHeadline(batch: Pick<MailboxBatch, "op" | "label" | "newLabel" | "ids" | "box">): string {
  const n = plural(batch.ids.length, "message", "messages");
  // A Space's own mailbox (boxMail.ts) has folders and flags; a card made before it named its box keeps the plain words below.
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
      return `Move ${n} to the trash; nothing is deleted for good`;
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
      return `moved ${n} to the trash`;
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

/** The address in a From header, lower case, for counting senders. */
function addressOf(from: string): string {
  const bracket = /<([^>]+)>/.exec(from)?.[1];
  return (bracket ?? from).trim().toLowerCase();
}

/** The card's numbers for the messages a batch changes, counted here: who they are from (the most frequent first) and a few examples. boxMail.ts freezes its batches with it. */
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
  /** Messages the mailbox refused. */
  failed: number;
  /** Why the first failure failed, in the mailbox's words. */
  failure?: string;
  /** The label Allow created, when it did. */
  createdLabel?: string;
};
