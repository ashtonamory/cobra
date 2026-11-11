/**
 * Trust and receipts, as words (contracts trust.ts; the agent's actionTrust.ts). When you have allowed the same action
 * three times running (the same project, the same people, the same templates), Cobra offers trust:
 * an approval of kind `trust`, drawn on Ops and in the popup as a card with Trust and Keep asking
 * (trustApprovalView). A trusted action then runs as soon as the Foreman proposes it, and lands as a
 * receipt: an approval carrying `trusted`, listed under Landed on Ops and on the project page.
 * The project page lists the grants (`GET /trust?project=`) with Revoke, and the keys you said keep
 * asking with Clear (`POST /trust/revoke|clear {key}`). Pure.
 *
 * The key is the agent's and never worked out here: Revoke and Clear send it back as it came. Every
 * field is read leniently. Times are this desktop's local time, 24-hour.
 */
import { LEAD_NAME } from "./appName.ts";
import { fold, type ActionView } from "./approvalAction.ts";
import { isDict, type Dict, type Json } from "./json.ts";
import { runTime } from "./routines.ts";

export const YES = "Trust";
export const NO = "Keep asking";
export const ALLOW = `Trust lets ${LEAD_NAME} do these with no card; each one lands as a receipt under Landed. Keep asking leaves it as it is, and ${LEAD_NAME} does not offer again until you clear it.`;
export const NOTE = "Revoke takes trust back: those are cards to allow again, and the Foreman is told. A new recipient or a changed template always asks.";

function str(value: Json): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: Json): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.trim()).map((v: string) => v.trim()) : [];
}

const clock = (at: Date) => `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

/** What trust lets the Foreman do, as the agent says it: "send pay-stub", "save invoice", "leave notes". */
export function doWords(subject: Dict): string {
  const what = str(subject.what) || "these";
  if (subject.channel === "file") return `save ${what}`;
  if (subject.channel === "note") return `leave ${what}`;
  return `send ${what}`;
}

/** Who it reaches: the addresses (email), the folder (file), or "" for a note. */
export function toWords(subject: Dict): string {
  return subject.channel === "note" ? "" : strings(subject.to).join(", ");
}

// --- the trust card ----------------------------------------------------------------------

/** The trust an approval carries (kind `trust`), when it carries one. */
export function trustOf(approval: Json): Dict | null {
  if (!isDict(approval) || !isDict(approval.trust)) return null;
  const trust: Dict = approval.trust;
  return typeof trust.key === "string" ? trust : null;
}

/** "3 times in a row". */
export function runsWords(runs: Json): string {
  const n = typeof runs === "number" && Number.isFinite(runs) && runs > 0 ? Math.round(runs) : 0;
  if (n === 0) return "Several times in a row";
  return n === 1 ? "Once" : `${n} times in a row`;
}

/** The card for a trust approval: who it reaches, the templates, how often you allowed it, then the cards it was. */
export function trustApprovalView(approval: Json): ActionView | null {
  const trust = trustOf(approval);
  if (trust === null) return null;
  const fields: Array<[string, string]> = [];
  const to = toWords(trust);
  if (to) fields.push(["To", to]);
  const templates = strings(trust.templates);
  fields.push(["Templates", templates.length ? templates.join(", ") : "None: the text is the Foreman's each time"]);
  fields.push(["Project", str(trust.projectName) || str(trust.project) || "—"]);
  fields.push(["You allowed", runsWords(trust.runs)]);
  const text = strings(trust.examples).map((e) => `• ${e}`).join("\n");
  return {
    channel: "trust",
    word: "TRUST",
    summary: doWords(trust),
    fields,
    text,
    ...fold(text),
    filesLabel: "Files",
    files: [],
    allow: ALLOW,
    yes: YES,
    no: NO,
  };
}

// --- taint ---------------------------------------------------------------------------------

/**
 * Why a card asks when its turn read text from outside (contracts ApprovalTaint; the agent's
 * taint.ts): "Cobra read an email from outside in this conversation, so it asks you before this goes out."
 * Trust and Instinct never skip such a card. Null on any other card.
 */
export function taintNote(approval: Json): string | null {
  if (!isDict(approval) || !isDict(approval.taint)) return null;
  return str(approval.taint.note) || null;
}

// --- receipts ------------------------------------------------------------------------------

/** Whether an approval is a receipt: an action that ran on trust. */
export function isReceipt(approval: Json): boolean {
  return isDict(approval) && isDict(approval.trusted);
}

export interface ReceiptView {
  id: string;
  /** HH:MM today; else the day and time. */
  time: string;
  title: string;
  /** SENT, SAVED, READ, FAILED, or RUNNING while the agent carries it out. */
  word: string;
  tone: "ink" | "signal" | "dim";
  /** The project · what happened. */
  detail: string;
  failed: boolean;
  project: string;
}

/** What it was, in the board's word. */
function doneWord(approval: Dict): string {
  const channel = isDict(approval.action) ? approval.action.channel : "";
  if (channel === "file") return "SAVED";
  if (channel === "note") return "READ";
  return "SENT";
}

export function receiptView(approval: Dict, now: number = Date.now()): ReceiptView {
  const at = new Date(typeof approval.createdAt === "string" ? approval.createdAt : "");
  const ok = Number.isFinite(at.getTime());
  const sameDay = ok && at.toDateString() === new Date(now).toDateString();
  const failed = approval.state === "failed";
  const running = approval.state === "allowed";
  const results = (Array.isArray(approval.results) ? approval.results : []).filter(isDict).map((r: Dict) => str(r.message)).filter((m: string) => m);
  const action: Dict = isDict(approval.action) ? approval.action : {};
  const project = str(action.projectName) || str(action.project);
  const outcome = running ? `${LEAD_NAME} is doing it now` : results[0] || (failed ? "it did not go through" : "done");
  return {
    id: String(approval.id ?? ""),
    time: !ok ? "—" : sameDay ? clock(at) : runTime(approval.createdAt, now),
    title: str(approval.title) || str(action.summary) || "Done on trust",
    word: failed ? "FAILED" : running ? "RUNNING" : doneWord(approval),
    tone: failed ? "signal" : running ? "ink" : "dim",
    detail: [project, outcome].filter((s) => s).join(" · "),
    failed,
    project: str(action.project),
  };
}

/** A computer's receipts from `GET /trust`; anything that is not one is left out. */
export function receiptsOf(list: Json): Dict[] {
  const all = isDict(list) && Array.isArray(list.receipts) ? list.receipts : [];
  return all.filter((a: Json) => isReceipt(a) && typeof (a as Dict).id === "string");
}

/** Landed on Ops: today's receipts on every computer, newest first, each with its computer. */
export function landedToday(lists: ReadonlyArray<readonly [string, Json]>, now: number = Date.now()): Array<{ machine: string; approval: Dict }> {
  const today = new Date(now).toDateString();
  const out: Array<{ machine: string; approval: Dict; at: number }> = [];
  for (const [machine, list] of lists) {
    for (const approval of receiptsOf(list)) {
      const at = Date.parse(String(approval.createdAt ?? ""));
      if (Number.isFinite(at) && new Date(at).toDateString() === today) out.push({ machine, approval, at });
    }
  }
  return out.sort((a, b) => b.at - a.at).map(({ machine, approval }) => ({ machine, approval }));
}

/** The soonest routine on any computer that runs next, as one line, or null when none is set. */
export function nextRoutine(lists: ReadonlyArray<readonly [string, Json]>, now: number = Date.now()): { machine: string; routine: Dict; line: string } | null {
  let best: { machine: string; routine: Dict; at: number } | null = null;
  for (const [machine, list] of lists) {
    const all = isDict(list) && Array.isArray(list.routines) ? list.routines : [];
    for (const routine of all) {
      if (!isDict(routine) || routine.enabled === false || typeof routine.nextRun !== "string") continue;
      const at = Date.parse(routine.nextRun);
      if (Number.isFinite(at) && (best === null || at < best.at)) best = { machine, routine, at };
    }
  }
  if (best === null) return null;
  const r = best.routine;
  const line = [`Next: ${str(r.name) || "a routine"}`, str(r.projectName), runTime(r.nextRun, now)].filter((s) => s).join(" · ");
  return { machine: best.machine, routine: r, line };
}

// --- the project page ---------------------------------------------------------------------

/** A project's grants and the keys that always ask, from `GET /trust?project=`. */
export function trustFor(list: Json, project: string): { grants: Dict[]; always: Dict[]; receipts: Dict[] } {
  const pick = (key: string) => (isDict(list) && Array.isArray(list[key]) ? list[key] : []).filter((x: Json) => isDict(x) && typeof x.key === "string" && x.project === project);
  const receipts = receiptsOf(list).filter((a) => isDict(a.action) && a.action.project === project);
  return { grants: pick("grants"), always: pick("always"), receipts };
}

/** Whether the section is drawn: only when there is something to show. */
export function showsTrust(t: { grants: Dict[]; always: Dict[]; receipts: Dict[] } | null): boolean {
  return t !== null && (t.grants.length > 0 || t.always.length > 0 || t.receipts.length > 0);
}

export interface GrantView {
  key: string;
  /** "Send pay-stub". */
  title: string;
  /** To · the templates. */
  detail: string;
  /** Trusted since … · N runs since · last … */
  since: string;
}

function capital(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function templatesWords(subject: Dict): string {
  const templates = strings(subject.templates);
  return templates.length ? `from ${templates.join(", ")}` : "";
}

export function grantView(grant: Dict, now: number = Date.now()): GrantView {
  const runs = typeof grant.runsSince === "number" ? grant.runsSince : 0;
  const to = toWords(grant);
  return {
    key: String(grant.key),
    title: capital(doWords(grant)),
    detail: [to ? `To ${to}` : "", templatesWords(grant)].filter((s) => s).join(" · "),
    since: [
      `Trusted since ${runTime(grant.grantedAt, now)}`,
      runs === 1 ? "1 run since" : `${runs} runs since`,
      typeof grant.lastUsed === "string" ? `last ${runTime(grant.lastUsed, now)}` : "",
    ].filter((s) => s).join(" · "),
  };
}

/** A key you said keeps asking: Clear lets it earn trust again. */
export function askView(ask: Dict, now: number = Date.now()): GrantView {
  const to = toWords(ask);
  return {
    key: String(ask.key),
    title: capital(doWords(ask)),
    detail: [to ? `To ${to}` : "", templatesWords(ask)].filter((s) => s).join(" · "),
    since: `Keeps asking since ${runTime(ask.at, now)}`,
  };
}

/** The toast after each action. */
export function doneWords(action: "revoke" | "clear", title: string): string {
  return action === "revoke" ? `${title}: asks again from now on` : `${title}: ${LEAD_NAME} may offer trust again`;
}

/** What a computer whose agent has no trust yet (404) is shown as: nothing, said once here. */
export function updateAgentLine(computer: string): string {
  return `Update the agent on ${computer} to see trust here.`;
}
