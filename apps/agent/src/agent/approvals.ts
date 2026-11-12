import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import type { Approval, ApprovalAction, ApprovalBoard, ApprovalEmailTemplate, ApprovalBrand, ApprovalExpenses, ApprovalBudget, ApprovalBills, ApprovalImport, ApprovalLand, ApprovalOrg, ApprovalPlan, ApprovalPr, ApprovalRoutine, ApprovalSite, ApprovalSpace, ApprovalSpecialist, ApprovalSpecialistAttach, ApprovalTrade, ApprovalTrust, ApprovalTrusted, McpPin } from "@cobra/contracts";

import { audit, recipients, type AuditFields } from "./auditTrail.ts";
import { landLine, landOne, type LandDeps } from "./landing.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { SessionError } from "./sessions.ts";
import { taintNote, taintRead, type Taint } from "./taint.ts";

/**
 * Approvals: what an orchestrator may ask for and only you may allow.
 *
 * The Lead can propose a merge (and, from phase 2, Workers on another
 * computer), but the decision is a tap on your phone, not a sentence in its
 * conversation: a Lead talked into something by a repository could otherwise
 * ask itself and answer. So an approval lives here, in the agent; it is pushed
 * to your phones with Allow and Deny; and it is answered on a route a Lead key
 * cannot reach (/approvals/answer needs a phone's or desktop's `act`).
 *
 * What an approval allows is fixed when it is made. A merge names each PR and
 * the head commit you are shown, and the merge after Allow is refused if any
 * PR moved on since (repo.ts mergePr, and GitHub's own --match-head-commit).
 * A land (a project with no remote, landing.ts) names each branch's tip and
 * main as you were shown it, and is refused if either moved.
 */

export const APPROVALS_PATH = join(STATE_DIR, "approvals.json");

/** How long a question waits for you before it lapses. */
export const PENDING_MS: Record<string, number> = {
  merge: 6 * 60 * 60_000,
  land: 6 * 60 * 60_000,
  "mcp-verify": 30 * 60_000,
  // A plan waits as long as a merge: you may answer it after a meeting.
  plan: 6 * 60 * 60_000,
  // An action (an email to send) waits a day: payroll is read in the morning and allowed after lunch.
  action: 24 * 60 * 60_000,
  // A routine (routines.ts) waits a day too: it is set once and runs for months.
  routine: 24 * 60 * 60_000,
  trust: 3 * 24 * 60 * 60_000,
  // A new trade (tradeRoutes.ts) is read at leisure: three days, as trust.
  trade: 3 * 24 * 60 * 60_000,
  // A change to a specialist (specialistRoutes.ts) is read with care, every word of it: three days, as a trade.
  specialist: 3 * 24 * 60 * 60_000,
  // Attaching a specialist to a project (specialistAttach.ts) gives it that project's files: read at leisure, as a change to it.
  "specialist-attach": 3 * 24 * 60 * 60_000,
  // A move in My Organization (orgRoutes.ts) is never urgent: three days.
  org: 3 * 24 * 60 * 60_000,
  // A new Space (spaceCreate.ts) opens with its folder, profile and brain: read at leisure, as a trade.
  space: 3 * 24 * 60 * 60_000,
  // Files for a Worker (workerImport.ts) wait as long as a merge: the Worker is parked until then.
  import: 6 * 60 * 60_000,
  // A brand kit (designer.ts) is read at leisure, as a trade: every design waits on it anyway.
  brand: 3 * 24 * 60 * 60_000,
  // A website version (site.ts) waits a day, as an email: the preview is looked at between other things.
  site: 24 * 60 * 60_000,
  // An email template version (emailRoutes.ts) is read at leisure, as a brand kit: sends wait on it anyway.
  email_template: 3 * 24 * 60 * 60_000,
  // A board Cobra made (spaceBoards.ts) only reads: three days, as a trade.
  board: 3 * 24 * 60 * 60_000,
  // A form on a site Cobra did not build (formLinks.ts) only reads: three days, as a board.
  form: 3 * 24 * 60 * 60_000,
  // A Website Builder asking to work on a site someone else coded (outsideSite.ts): three days, as a form.
  "site-link": 3 * 24 * 60 * 60_000,
  // Receipts Cobra read (receipts.ts): a week, since a stack of them can wait for the weekend.
  expenses: 7 * 24 * 60 * 60_000,
  // A budget's limits (budgetCard.ts) are set once a month at most: three days, as a board.
  budget: 3 * 24 * 60 * 60_000,
  // Bills Cobra found (billsCard.ts): a week, as receipts; she looks again the week after.
  bills: 7 * 24 * 60 * 60_000,
};
/** How much body a card may hold, by kind: an action carries its whole email, so the person allows exactly what they read (actions.ts refuses one that would not fit). */
export const BODY_MAX: Record<string, number> = { action: 8000, routine: 2600, trust: 2600, trade: 8000, specialist: 18000, import: 4000, space: 4000, board: 2600, expenses: 6000, budget: 4000, bills: 4000 };
const KEEP = 100;

/** The agent's own record: the contract's shape, and who asked. */
export type StoredApproval = Approval & {
  /** The caller id of the Lead that asked. */
  requestedBy: string;
  /** Set when Cobra allowed it herself under Instinct (index.ts notifyOrAct), not the person. */
  allowedBy?: "cobra";
  /** The key the person answered from (POST /approvals/answer), for the audit log (auditTrail.ts). */
  answeredBy?: string;
  /** Set when a card nobody answered went to the judge (unanswered.ts): once only, whatever it said. */
  judged?: { at: string; verdict: "allow" | "refuse" | "escalate"; reason: string };
  /** A close-sessions card's sessions (sessionKeeper.ts): the agent's own, never sent to the apps. */
  closes?: string[];
  /** The Worker whose Space tool made it (workerSpace.ts), its body saying so; the agent's own. */
  byWorker?: string;
  /** That Worker had read web pages in its task (taint.ts): Cobra never allows it herself (instinctActs.ts, unanswered.ts). */
  byTaintedWorker?: true;
  /** Made by a Worker Cobra started herself (directWorkers.ts): what becomes of it is told to her, not to the project's Foreman. */
  byLeadWorker?: true;
};

/** Who allowed it, as a sentence's subject for what the Lead or a Foreman hears: the person, or Cobra under Instinct. */
export function allower(approval: Pick<StoredApproval, "allowedBy">): string {
  return approval.allowedBy === "cobra" ? "Cobra (under Instinct; the person can undo it)" : "The person";
}

export function loadApprovals(path = APPROVALS_PATH): StoredApproval[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { approvals?: unknown };
    return Array.isArray(raw.approvals) ? (raw.approvals as StoredApproval[]).filter((a) => typeof a?.id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Every change of an approval is written here, so this is where the audit
 * log (auditTrail.ts) learns of each one: asked, allowed (and by whom),
 * refused, lapsed, judged, carried out or failed. The record is written once
 * the file is, so a write that failed is not logged as a change.
 */
export function saveApprovals(list: StoredApproval[], path = APPROVALS_PATH): void {
  const before = loadApprovals(path);
  writePrivateFile(path, `${JSON.stringify({ approvals: list.slice(-KEEP) }, null, 2)}\n`);
  auditApprovals(before, list);
}

/** The project or Space a card is about, from whichever part it carries. */
function cardProject(approval: StoredApproval): string | undefined {
  for (const part of Object.values(approval)) {
    if (part && typeof part === "object" && !Array.isArray(part)) {
      const value = (part as { project?: unknown; space?: unknown }).project ?? (part as { space?: unknown }).space;
      if (typeof value === "string" && value) return value;
    }
  }
  return approval.prs?.[0]?.repo ?? approval.lands?.[0]?.project;
}

/** What the log keeps of a card: its kind and one-line title, and for an action the counts, never its body. */
function cardDetail(approval: StoredApproval): NonNullable<AuditFields["detail"]> {
  const action = approval.action;
  const to = action?.email ? [...action.email.to, ...(action.email.cc ?? [])] : [];
  return {
    card: approval.kind,
    title: approval.title,
    ...(approval.taint ? { tainted: true } : {}),
    ...(approval.byWorker ? { worker: approval.byWorker } : {}),
    ...(action ? { channel: action.channel } : {}),
    ...(to.length ? recipients(to) : {}),
    ...(approval.prs?.length ? { prs: approval.prs.map((pr) => `${pr.repo}#${pr.number}`) } : {}),
    ...(approval.lands?.length ? { lands: approval.lands.map((land) => `${land.project}:${land.branch}`) } : {}),
    ...(approval.trusted ? { trust: approval.trusted.key } : {}),
  };
}

/** Who allowed or refused it: the person (and from which key), trust, Instinct or the judge. */
function decider(approval: StoredApproval, allowed: boolean): string {
  if (allowed && approval.trusted) return "trust";
  if (allowed && approval.allowedBy === "cobra") return approval.judged?.verdict === "allow" ? "judge" : "instinct";
  if (!allowed && approval.judged?.verdict === "refuse") return "judge";
  return approval.answeredBy ? `person:${approval.answeredBy}` : "person";
}

/**
 * The audit records for what changed between two versions of the list. A
 * card made already allowed (on trust) or already carried out (a merge on
 * green) is allowed by that, then done; a pending one that was trimmed off
 * the end of the file is not a change.
 */
export function auditApprovals(before: readonly StoredApproval[], after: readonly StoredApproval[], log: typeof audit = audit): void {
  const was = new Map(before.map((approval) => [approval.id, approval]));
  for (const approval of after) {
    const prior = was.get(approval.id);
    if (prior && prior.state === approval.state && (prior.judged || !approval.judged)) continue;
    const base = { subject: { card: approval.id, ...(cardProject(approval) ? { project: cardProject(approval)! } : {}) }, detail: cardDetail(approval) };
    const record = (kind: string, actor: string, extra: Partial<AuditFields> = {}) => log(kind, { ...base, actor, ...extra, detail: { ...base.detail, ...extra.detail } });
    const from = prior?.state;
    if (!prior && approval.state === "pending") {
      record("approval.proposed", approval.byWorker ? `worker:${approval.byWorker}` : approval.requestedBy);
      continue;
    }
    if (prior && !prior.judged && approval.judged) {
      record("approval.judged", "judge", { detail: { verdict: approval.judged.verdict, reason: approval.judged.reason } });
      if (prior.state === approval.state) continue;
    }
    const answered = approval.state !== "pending" && approval.state !== "expired" && approval.state !== "denied";
    if ((from === undefined || from === "pending") && answered) {
      // Made already past pending: on trust, or a merge on green (orch.ts), or by the agent itself.
      const actor = prior ? decider(approval, true) : approval.trusted ? "trust" : approval.kind === "merge" ? "merge-on-green" : "agent";
      record("approval.allowed", actor);
    }
    if (approval.state === "denied" && from !== "denied") record("approval.refused", decider(approval, false), { outcome: "refused" });
    if (approval.state === "expired" && from !== "expired") {
      // Before its time: a newer card of the same thing replaced it (spaceBoards.ts, formLinks.ts).
      const early = Date.parse(approval.expiresAt) > Date.now();
      record("approval.expired", early ? "agent" : "time", { outcome: "expired", ...(early ? { detail: { replaced: true } } : {}) });
    }
    if ((approval.state === "done" || approval.state === "failed") && from !== approval.state) {
      const results = approval.results ?? [];
      record(approval.state === "done" ? "approval.done" : "approval.failed", "agent", {
        outcome: approval.state === "done" ? "ok" : "failed",
        detail: { results: results.length, failedResults: results.filter((result) => !result.ok).length },
      });
    }
  }
}

/** Pending ones past their time read as expired, and are written back that way. */
export function settle(list: StoredApproval[], now: number): StoredApproval[] {
  return list.map((a) => (a.state === "pending" && Date.parse(a.expiresAt) <= now ? { ...a, state: "expired" } : a));
}

/**
 * Writes down the cards that lapsed since the file was last written. Readers
 * settle as they read, so nothing waits on this; it is so a lapse reaches the
 * audit log near its time (index.ts runs it each minute). Returns how many.
 */
export function writeLapsed(now: number, path = APPROVALS_PATH): number {
  const list = loadApprovals(path);
  const settled = settle(list, now);
  const lapsed = settled.filter((approval, index) => approval.state !== list[index]!.state).length;
  if (lapsed) saveApprovals(settled, path);
  return lapsed;
}

export type NewApproval = {
  kind: string;
  title: string;
  body: string;
  requestedBy: string;
  prs?: ApprovalPr[];
  lands?: ApprovalLand[];
  mcpPin?: McpPin;
  mcpReplaces?: string | null;
  plan?: ApprovalPlan;
  action?: ApprovalAction;
  routine?: ApprovalRoutine;
  trust?: ApprovalTrust;
  /** An action that runs on trust: made already allowed (the propose route), never pending. */
  trusted?: ApprovalTrusted;
  trade?: ApprovalTrade;
  specialist?: ApprovalSpecialist;
  attach?: ApprovalSpecialistAttach;
  org?: ApprovalOrg;
  space?: ApprovalSpace;
  imports?: ApprovalImport;
  brand?: ApprovalBrand;
  site?: ApprovalSite;
  board?: ApprovalBoard;
  expenses?: ApprovalExpenses;
  budget?: ApprovalBudget;
  bills?: ApprovalBills;
  emailTemplate?: ApprovalEmailTemplate;
};

export function makeApproval(
  input: NewApproval,
  now: number,
  machine = os.hostname(),
  random: (size: number) => Uint8Array = randomBytes,
): StoredApproval {
  const ttl = PENDING_MS[input.kind] ?? 60 * 60_000;
  return {
    id: `ap_${Buffer.from(random(12)).toString("base64url")}`,
    machine,
    kind: input.kind,
    title: input.title.slice(0, 120),
    body: input.body.slice(0, BODY_MAX[input.kind] ?? 2000),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    state: "pending",
    requestedBy: input.requestedBy,
    ...(input.prs ? { prs: input.prs } : {}),
    ...(input.lands ? { lands: input.lands } : {}),
    ...(input.mcpPin ? { mcpPin: input.mcpPin } : {}),
    ...(input.mcpReplaces !== undefined ? { mcpReplaces: input.mcpReplaces } : {}),
    ...(input.plan ? { plan: input.plan } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(input.routine ? { routine: input.routine } : {}),
    ...(input.trust ? { trust: input.trust } : {}),
    ...(input.trade ? { trade: input.trade } : {}),
    ...(input.specialist ? { specialist: input.specialist } : {}),
    ...(input.attach ? { attach: input.attach } : {}),
    ...(input.org ? { org: input.org } : {}),
    ...(input.space ? { space: input.space } : {}),
    ...(input.imports ? { imports: input.imports } : {}),
    ...(input.brand ? { brand: input.brand } : {}),
    ...(input.site ? { site: input.site } : {}),
    ...(input.board ? { board: input.board } : {}),
    ...(input.expenses ? { expenses: input.expenses } : {}),
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.bills ? { bills: input.bills } : {}),
    ...(input.emailTemplate ? { emailTemplate: input.emailTemplate } : {}),
    ...(input.trusted ? { trusted: input.trusted, state: "allowed", answeredAt: new Date(now).toISOString() } : {}),
  };
}

/**
 * A card made in a tainted turn (taint.ts): it says why it asks, in its
 * `taint` for the apps and at the end of its body for a push, and it is
 * never allowed by Cobra herself (instinctActs.ts, unanswered.ts). A card
 * already stamped is left as it is. One that is no longer pending (a trusted
 * run) is not a card: the caller never makes one in a tainted turn.
 */
export function stampTaint(approval: StoredApproval, who: string, taint: Pick<Taint, "sources" | "hosts">): StoredApproval {
  if (approval.taint || approval.state !== "pending") return approval;
  const note = taintNote(who, taint);
  return { ...approval, body: `${approval.body}\n\n${note}`, taint: { read: taintRead(taint), note } };
}

/** What the phone and the Lead see: the record without who asked. */
export function publicView(a: StoredApproval): Approval {
  const { requestedBy: _drop, closes: _closes, byWorker: _worker, byTaintedWorker: _tainted, byLeadWorker: _lead, answeredBy: _by, ...rest } = a;
  return rest;
}

/** Answers a pending approval. Anything but pending is a 409: an answer counts once. */
export function answer(list: StoredApproval[], id: string, allow: boolean, now: number): { list: StoredApproval[]; approval: StoredApproval } {
  const current = settle(list, now);
  const found = current.find((a) => a.id === id);
  if (!found) throw new SessionError("no such approval", 404);
  if (found.state !== "pending") throw new SessionError(`that approval is already ${found.state}`, 409);
  const approval: StoredApproval = { ...found, state: allow ? "allowed" : "denied", answeredAt: new Date(now).toISOString() };
  return { list: current.map((a) => (a.id === id ? approval : a)), approval };
}

// --- merges -------------------------------------------------------------------

export type MergeDeps = {
  /** The PR's state, title, head commit and link, read from GitHub now. */
  readPr: (repo: string, number: number) => Promise<{ state: string; title: string; head: string; url: string; base?: string }>;
  /** Squash-merges one PR at exactly `head`, or throws why not. */
  merge: (repo: string, number: number, head: string) => Promise<void>;
};

/** The PRs to put in front of you: each must be open now; its head is the one you will be shown. */
export async function mergeCandidates(
  deps: Pick<MergeDeps, "readPr">,
  wanted: ReadonlyArray<{ repo: string; number: number; worker?: string }>,
): Promise<ApprovalPr[]> {
  if (wanted.length === 0) throw new SessionError("name at least one PR", 400);
  const prs: ApprovalPr[] = [];
  for (const pr of wanted) {
    const read = await deps.readPr(pr.repo, pr.number);
    if (read.state !== "OPEN") throw new SessionError(`${pr.repo}#${pr.number} is ${read.state.toLowerCase()}, not open`, 409);
    prs.push({ number: pr.number, title: read.title, repo: pr.repo, head: read.head, url: read.url, ...(pr.worker ? { worker: pr.worker } : {}) });
  }
  return prs;
}

/** A PR title without its conventional prefix ("feat(site): booking page" reads "booking page"). */
export function changeTitle(title: string): string {
  return title.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, "").trim() || title;
}

/** The plain words a Foreman gave merge_request for what the person gets, kept short and with no question mark. */
export function plainWhat(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const words = value.replace(/\s+/g, " ").trim().replace(/[?.!]+$/, "");
  return words ? words.slice(0, 120) : undefined;
}

const projectOf = (repo: string) => repo.split("/").pop() ?? repo;

/**
 * The card for PRs, in the person's words (docs/voice.md V3, V8): what goes
 * live, never a PR number. `plain` is the Foreman's own words for it; without
 * them the PR's title, stripped of its prefix. The numbers, heads and links
 * stay on the approval's `prs` for the Allow and for the apps that draw them.
 */
export function mergeText(prs: readonly ApprovalPr[], plain?: string): { title: string; body: string } {
  const what = plain ?? (prs.length === 1 ? `"${changeTitle(prs[0]!.title)}"` : `${prs.length} updates`);
  const title = `Publish ${what}?`;
  const body = prs.map((pr) => `${changeTitle(pr.title)} (${projectOf(pr.repo)})`).join("\n");
  return { title, body };
}

/** The receipt for a merge on green: what went live, in the person's words. */
export function publishedText(prs: readonly ApprovalPr[], merged: number, plain?: string): { title: string; body: string } {
  const what = plain ?? (prs.length === 1 ? `"${changeTitle(prs[0]!.title)}"` : `${prs.length} updates`);
  const title = merged === prs.length ? `Published ${what}` : `Published ${merged} of ${prs.length} updates`;
  return { title, body: prs.map((pr) => `${changeTitle(pr.title)} (${projectOf(pr.repo)})`).join("\n") };
}

/**
 * The question for PRs and local lands together (kind land when any branch
 * lands). The body carries the facts, so an app that knows nothing of
 * `lands` still shows what Allow does; a land stays on this computer, so it
 * is "added", not published.
 */
export function landText(prs: readonly ApprovalPr[], lands: readonly ApprovalLand[], plain?: string): { title: string; body: string } {
  if (lands.length === 0) return mergeText(prs, plain);
  const count = prs.length + lands.length;
  const what = plain ?? (count === 1 ? "the finished change" : `${count} finished changes`);
  const title = prs.length === 0 ? `Add ${what} to your project?` : `Publish and add ${what}?`;
  const lines = [
    ...(prs.length ? [mergeText(prs).body] : []),
    ...lands.map(landLine),
    prs.length === 0
      ? "It stays on this computer: nothing goes online, and no tests ran."
      : `The changes to ${[...new Set(lands.map((land) => land.project))].join(", ")} stay on this computer, and no tests ran on them.`,
  ];
  return { title, body: lines.join("\n") };
}

/** After Allow: each PR in turn, at the head you were shown. One failing does not stop the rest. */
export async function runMerge(deps: Pick<MergeDeps, "merge">, approval: StoredApproval): Promise<StoredApproval> {
  const results: NonNullable<Approval["results"]> = [];
  for (const pr of approval.prs ?? []) {
    try {
      await deps.merge(pr.repo, pr.number, pr.head);
      results.push({ number: pr.number, ok: true, message: `merged #${pr.number}` });
    } catch (caught) {
      results.push({ number: pr.number, ok: false, message: caught instanceof Error ? caught.message : String(caught) });
    }
  }
  return { ...approval, state: results.every((r) => r.ok) ? "done" : "failed", results };
}

/**
 * After Allow: each land in order, after any PRs runMerge did. Each lands onto
 * main as you were shown it, or onto the land before it in the same project;
 * one failing changes nothing and does not stop the rest. A land that fails
 * is not retried: it needs a new question.
 */
export async function runLand(deps: LandDeps, approval: StoredApproval): Promise<StoredApproval> {
  const results: NonNullable<Approval["results"]> = [...(approval.results ?? [])];
  const expected = new Map<string, string>();
  for (const land of approval.lands ?? []) {
    let outcome;
    try {
      outcome = await landOne(deps, land, expected.get(land.project) ?? land.base);
    } catch (caught) {
      outcome = { ok: false as const, reason: caught instanceof Error ? caught.message : String(caught) };
    }
    if (outcome.ok) {
      expected.set(land.project, outcome.sha);
      results.push({ ok: true, message: `landed ${land.branch} as ${outcome.sha.slice(0, 7)}` });
    } else {
      results.push({ ok: false, message: `${land.branch} not landed: ${outcome.reason}` });
    }
  }
  return { ...approval, state: results.every((r) => r.ok) ? "done" : "failed", results };
}
