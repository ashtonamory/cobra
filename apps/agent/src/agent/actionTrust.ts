import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Approval, ApprovalAction, ApprovalActionAttachment, ApprovalTrust, TrustAsk, TrustGrant, TrustList, TrustSubject } from "@cobra/contracts";

import type { NewApproval, StoredApproval } from "./approvals.ts";
import { publicView } from "./approvals.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { renderOf, type RenderEntry } from "./renders.ts";

/**
 * Trust. A new Foreman asks for everything. When the person has allowed
 * the same action three times running (the same project, channel, people and
 * templates; nothing denied between), the agent proposes trust as Cobra, one
 * card of kind `trust`. Its Allow writes a grant, and from then on that action
 * runs as soon as the Foreman proposes it and lands as a receipt under Landed,
 * with no card. Its Deny ("Keep asking") marks the key as always asking, so it
 * is never proposed again until the person clears it. Revoke on the project
 * page takes a grant back, and the count starts again.
 *
 * The key is worked out here, never by a model: the project, the channel,
 * every address (to and cc, as a set) or the folder, and each attachment's
 * template with the sha256 of its source, read from the render ledger
 * (renders.ts). So a new recipient, a changed template or a file the agent
 * did not render is a different key, or none, and asks. No channel moves
 * money or files anything with an authority yet; when one does, it never
 * takes trust. A trusted key still runs at most TRUSTED_PER_DAY times a day;
 * past that it asks.
 *
 * Kept in `~/.local/state/cobra-agent/trust.json` (0600): the grants, the
 * keys that always ask, and the running counts.
 */

export const TRUST_PATH = join(STATE_DIR, "trust.json");
/** Allows in a row, with nothing denied between, before trust is proposed. */
export const CLEAN_RUNS = 3;
/** A trusted key's runs in 24 hours before it asks again. */
export const TRUSTED_PER_DAY = 10;
/** How long receipts stay on the apps' lists. */
export const RECEIPT_DAYS = 7;
const EXAMPLES = 3;
const RECEIPTS_MAX = 30;
const DAY_MS = 24 * 60 * 60_000;

export type Counted = { key: string; clean: number; examples: string[]; last: string };
export type TrustState = { grants: TrustGrant[]; always: TrustAsk[]; counts: Counted[] };
export type TrustStore = { load: () => TrustState; save: (state: TrustState) => void };

export const EMPTY_TRUST: TrustState = { grants: [], always: [], counts: [] };

export function loadTrust(path = TRUST_PATH): TrustState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TrustState>;
    return {
      grants: Array.isArray(raw.grants) ? raw.grants.filter((g) => typeof g?.key === "string") : [],
      always: Array.isArray(raw.always) ? raw.always.filter((a) => typeof a?.key === "string") : [],
      counts: Array.isArray(raw.counts) ? raw.counts.filter((c) => typeof c?.key === "string") : [],
    };
  } catch {
    return { grants: [], always: [], counts: [] };
  }
}

export function saveTrust(state: TrustState, path = TRUST_PATH): void {
  writePrivateFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function trustFileStore(path = TRUST_PATH): TrustStore {
  return { load: () => loadTrust(path), save: (state) => saveTrust(state, path) };
}

// --- the key ------------------------------------------------------------------

export type Keyed = { trustable: true; subject: TrustSubject } | { trustable: false; why: string };

function attachmentsOf(action: ApprovalAction): readonly ApprovalActionAttachment[] {
  return action.email?.attachments ?? action.files?.items ?? action.note?.attachments ?? [];
}

const lower = (addresses: readonly string[] | undefined): string[] => [...new Set((addresses ?? []).map((a) => a.toLowerCase()))].sort();

/**
 * The action key and what it covers, or why this action can never be
 * trusted (an attachment the agent did not render here). Two proposals with
 * the same key differ only in their text, their summary and which rows a
 * document was rendered from.
 */
export function actionKey(action: ApprovalAction, renders: Record<string, RenderEntry>): Keyed {
  // Every template and source hash its files came from: two pay stubs printed either side of a template change are two.
  const sources = new Set<string>();
  const named = new Set<string>();
  for (const file of attachmentsOf(action)) {
    const render = renderOf(renders, action.project, file.sha256);
    if (!render) return { trustable: false, why: `${file.name} is not a document the agent rendered from a template` };
    sources.add(`template:${render.template}:${render.templateSha}`);
    named.add(render.template);
  }
  // A branded email (emailRoutes.ts) is trusted per template version, whoever it goes to: one person each time, from an allowed version.
  if (action.channel === "branded" && action.branded) {
    const b = action.branded;
    if (b.emailKind !== "transactional") return { trustable: false, why: "only transactional email is trusted" };
    const key = createHash("sha256").update(["v1", action.project, "branded", b.space, b.template, b.templateSha].join("\n")).digest("hex");
    return { trustable: true, subject: { key, project: action.project, projectName: action.projectName, channel: "branded", what: `"${b.name}" emails (v${b.version})`, to: ["one person at a time"], templates: [b.template] } };
  }
  const names = [...named].sort();
  const parts: string[] = ["v1", action.project, action.channel];
  let to: string[] = [];
  if (action.channel === "email" && action.email) {
    parts.push(`to:${lower(action.email.to).join(",")}`, `cc:${lower(action.email.cc).join(",")}`);
    to = [...action.email.to, ...(action.email.cc ?? []).map((address) => `cc ${address}`)];
  } else if (action.channel === "file" && action.files) {
    parts.push(`folder:${action.files.to}:${action.files.path}`);
    to = [`${action.files.label} (${action.files.path})`];
  } else if (action.channel !== "note") {
    return { trustable: false, why: `channel ${action.channel} is never trusted` };
  }
  parts.push(...[...sources].sort());
  const key = createHash("sha256").update(parts.join("\n")).digest("hex");
  const listed = names.join(" and ");
  const what = action.channel === "note" ? (names.length ? `notes with ${listed}` : "notes") : names.length ? listed : "a message";
  return { trustable: true, subject: { key, project: action.project, projectName: action.projectName, channel: action.channel, what, to, templates: names } };
}

// --- running on trust -----------------------------------------------------------

export function grantFor(state: TrustState, key: string): TrustGrant | undefined {
  return state.grants.find((grant) => grant.key === key);
}

/** How many times this key ran on trust in the last day, from the approvals file. */
export function trustedRuns(list: readonly StoredApproval[], key: string, now: number): number {
  return list.filter((a) => a.trusted?.key === key && Date.parse(a.createdAt) > now - DAY_MS).length;
}

/**
 * The grant an action runs on now, or null when it asks: no grant for its
 * key, its key marked always asking, or already TRUSTED_PER_DAY runs today.
 */
export function mayRunTrusted(state: TrustState, keyed: Keyed, list: readonly StoredApproval[], now: number): TrustGrant | null {
  if (!keyed.trustable) return null;
  const key = keyed.subject.key;
  if (state.always.some((ask) => ask.key === key)) return null;
  const grant = grantFor(state, key);
  if (!grant) return null;
  return trustedRuns(list, key, now) < TRUSTED_PER_DAY ? grant : null;
}

/** A trusted run counted on its grant. */
export function useGrant(state: TrustState, key: string, now: number): TrustState {
  const at = new Date(now).toISOString();
  return { ...state, grants: state.grants.map((grant) => (grant.key === key ? { ...grant, runsSince: grant.runsSince + 1, lastUsed: at } : grant)) };
}

// --- earning it -------------------------------------------------------------------

/**
 * After the person answered an action card (not a trusted run): a clean Allow
 * that went out adds one to its key's count, a Deny starts it again, and a
 * failure or a lapse changes nothing. `propose` is the count when trust should
 * be proposed now: CLEAN_RUNS reached, no grant, not always asking, and no
 * trust card waiting for this key.
 */
export function noteOutcome(state: TrustState, keyed: Keyed, approval: Pick<StoredApproval, "state" | "title">, list: readonly StoredApproval[], now: number): { state: TrustState; propose: Counted | null } {
  if (!keyed.trustable) return { state, propose: null };
  const key = keyed.subject.key;
  if (approval.state === "denied") return { state: { ...state, counts: state.counts.filter((c) => c.key !== key) }, propose: null };
  if (approval.state !== "done") return { state, propose: null };
  const before = state.counts.find((c) => c.key === key);
  const counted: Counted = {
    key,
    clean: (before?.clean ?? 0) + 1,
    examples: [...(before?.examples ?? []), approval.title].slice(-EXAMPLES),
    last: new Date(now).toISOString(),
  };
  const next = { ...state, counts: [...state.counts.filter((c) => c.key !== key), counted] };
  const waiting = list.some((a) => a.kind === "trust" && a.state === "pending" && a.trust?.key === key);
  const eligible = counted.clean >= CLEAN_RUNS && !grantFor(state, key) && !state.always.some((ask) => ask.key === key) && !waiting;
  return { state: next, propose: eligible ? counted : null };
}

function verb(channel: string): string {
  if (channel === "file") return "save";
  if (channel === "note") return "leave";
  return "send";
}

function people(subject: TrustSubject): string {
  if (subject.channel === "note") return "";
  if (subject.channel === "file") return ` to ${subject.to[0] ?? "the folder"}`;
  return subject.to.length === 1 ? ` to ${subject.to[0]}` : ` to these ${subject.to.length} addresses`;
}

/** The trust card Cobra proposes: kind `trust`, carrying exactly the key and what it covers. */
export function trustApproval(subject: TrustSubject, counted: Counted): NewApproval {
  const trust: ApprovalTrust = { ...subject, runs: counted.clean, examples: counted.examples };
  const title = `Let ${subject.projectName} ${verb(subject.channel)} ${subject.what}${people(subject)} without asking?`;
  const lines = [
    `You allowed this ${counted.clean} times in a row with nothing changed:`,
    ...counted.examples.map((example) => `- ${example}`),
    "",
    ...(subject.channel === "note" ? [] : [`To: ${subject.to.join(", ")}`]),
    ...(subject.templates.length ? [`Templates: ${subject.templates.join(", ")}`] : ["No attachments: the text is the Foreman's each time."]),
    "",
    subject.channel === "branded"
      ? "From now on Cobra sends this email version to one person at a time without a card, whoever it is for, and each one lands as a receipt under Landed. A changed template asks again. Revoke it any time on the project page."
      : "From now on Cobra does these without a card, and each one lands as a receipt under Landed. A new recipient, a changed template or anything else still asks. Revoke it any time on the project page.",
  ];
  return { kind: "trust", title, body: lines.join("\n"), requestedBy: "agent", trust };
}

/**
 * The person answered a trust card: Allow writes the grant (and the approval
 * reads done), Deny marks the key always asking. Either way the count is
 * cleared, and the project's Foreman gets `news`.
 */
export function settleTrust(state: TrustState, approval: StoredApproval, now: number): { state: TrustState; approval: StoredApproval; news: string | null } {
  const trust = approval.trust;
  if (!trust) return { state, approval, news: null };
  const { runs: _runs, examples: _examples, ...subject } = trust;
  const at = new Date(now).toISOString();
  const counts = state.counts.filter((c) => c.key !== trust.key);
  const what = `${verb(trust.channel)} ${trust.what}${people(trust)}`;
  if (approval.state === "allowed") {
    const grant: TrustGrant = { ...subject, grantedAt: at, runsSince: 0 };
    return {
      state: { grants: [...state.grants.filter((g) => g.key !== trust.key), grant], always: state.always.filter((a) => a.key !== trust.key), counts },
      approval: { ...approval, state: "done", results: [{ ok: true, message: "trusted" }] },
      news: `The person now trusts you to ${what}. From now on an action_propose of that kind, to the same people from the same templates, is carried out at once with no card, and its [cobra] line comes as before. Anything else still asks.`,
    };
  }
  if (approval.state === "denied") {
    const ask: TrustAsk = { ...subject, at };
    return {
      state: { grants: state.grants, always: [...state.always.filter((a) => a.key !== trust.key), ask], counts },
      approval,
      news: `The person wants to keep allowing each time you ${what}; propose them as before.`,
    };
  }
  return { state, approval, news: null };
}

/** Revoke on the project page: the grant goes, and the count starts again. */
export function revokeTrust(state: TrustState, key: string): { state: TrustState; removed: TrustGrant | null } {
  const removed = grantFor(state, key) ?? null;
  return { state: { ...state, grants: state.grants.filter((g) => g.key !== key), counts: state.counts.filter((c) => c.key !== key) }, removed };
}

/** Clear on the project page: a key that always asked may be proposed again after CLEAN_RUNS more. */
export function clearAsk(state: TrustState, key: string): { state: TrustState; removed: TrustAsk | null } {
  const removed = state.always.find((a) => a.key === key) ?? null;
  return { state: { ...state, always: state.always.filter((a) => a.key !== key) }, removed };
}

export function revokeNews(grant: TrustGrant): string {
  return `The person stopped trusting you to ${verb(grant.channel)} ${grant.what}${people(grant)}: those are cards to allow again.`;
}

// --- receipts ---------------------------------------------------------------------

/** What ran on trust lately, newest first: the receipts under Landed. */
export function receipts(list: readonly StoredApproval[], now: number, project?: string): Approval[] {
  return list
    .filter((a) => a.trusted && Date.parse(a.createdAt) > now - RECEIPT_DAYS * DAY_MS && (project === undefined || a.action?.project === project))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, RECEIPTS_MAX)
    .map(publicView);
}

export function trustList(state: TrustState, list: readonly StoredApproval[], now: number, project?: string): TrustList {
  const mine = <T extends { project: string }>(items: readonly T[]): T[] => items.filter((item) => project === undefined || item.project === project);
  return { grants: mine(state.grants), always: mine(state.always), receipts: receipts(list, now, project) };
}

/** The push and notice for a trusted run once it was carried out. */
export function receiptNotice(approval: Pick<StoredApproval, "state" | "title" | "results" | "action" | "trusted">): { title: string; body: string } {
  const project = approval.action?.projectName ?? "A Foreman";
  const outcome = (approval.results ?? []).map((result) => result.message).join("; ");
  const how = approval.trusted?.audited ? "on trust, checked for planted content first" : "on trust";
  if (approval.state === "done") return { title: `${project}: ${approval.title}`, body: `Done ${how}: ${outcome || "done"}.` };
  return { title: `${project}: not done`, body: `${approval.title} ran ${how} and failed: ${outcome || "failed"}.` };
}
