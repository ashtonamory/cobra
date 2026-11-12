import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { ApprovalSpecialistAttach, Project } from "@cobra/contracts";

import { allower, makeApproval, settle, type StoredApproval } from "./approvals.ts";
import { crewFor } from "./crew.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { isAttachable, isRepository, readSpecialist, REPOS_MAX, setAttached, type SpecialistRecord } from "./specialists.ts";

/**
 * Attaching a specialist to a project the person already has.
 *
 * A specialist stands on its own; a repository is something it is attached
 * to, not something it must own. Attached, it reads that project's files and
 * its Workers may live there (orch.ts workScope), each change still coming
 * to the person before it is published. It gets nothing else of that
 * project: not its store, its mail and calendar reads, its routines or its
 * memory.
 *
 * The person: POST /specialists/attach and /specialists/detach, their own
 * act, so no card.
 *
 * The Lead: specialist_attach makes one card of kind `specialist-attach`
 * naming the specialist, the project and its folder. Only the person's Allow
 * attaches, and exactly the pair the card was made from. Cobra never allows
 * this kind herself (instinctActs.ts lists what she may; it is not there).
 * specialist_detach only takes access away, so it applies at once.
 *
 * Its reads change at the specialist's next conversation (foreman.ts reads
 * the list at each start); where its Workers may live changes at once.
 */

export const SPECIALIST_ATTACH = "specialist-attach";
/** The Lead's attach proposals not yet answered, each by its approval's id. */
export const ATTACH_PROPOSALS_DIR = join(STATE_DIR, "specialist-attach-proposals");

/** What a card was made from: the specialist and the repository, by project id. */
export type AttachProposal = { id: string; repo: string };

/** The hash Allow checks: the card attaches exactly this pair, or nothing. */
export function attachHash(proposal: AttachProposal): string {
  return createHash("sha256").update(JSON.stringify({ id: proposal.id, repo: proposal.repo })).digest("hex");
}

export function keepAttachProposal(approvalId: string, proposal: AttachProposal, dir = ATTACH_PROPOSALS_DIR): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateFile(join(dir, `${approvalId}.json`), JSON.stringify(proposal));
}

/** The proposal a card is for, or null when it is gone; removed once read. */
export function takeAttachProposal(approvalId: string, dir = ATTACH_PROPOSALS_DIR): AttachProposal | null {
  if (!/^ap_[A-Za-z0-9_-]+$/.test(approvalId)) return null;
  const path = join(dir, `${approvalId}.json`);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AttachProposal;
    rmSync(path, { force: true });
    return typeof parsed?.id === "string" && typeof parsed.repo === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** A Worker as detach needs to know it: where it lives, whose it is, and whether it still runs. */
export type AttachedWorker = { id: string; name: string; parent: string; owner?: string; running: boolean };

export type AttachDeps = {
  approvals: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };
  notify: (approval: StoredApproval) => Promise<void>;
  tell: (owner: string, text: string) => void;
  log: (line: string) => void;
  /** The projects on this computer. */
  projects: () => Promise<readonly Project[]>;
  read: (id: string) => SpecialistRecord | null;
  apply: (id: string, repo: string, attach: boolean, known: ReadonlySet<string>, by: SpecialistRecord["updatedBy"], actor: string) => SpecialistRecord;
  keep: (approvalId: string, proposal: AttachProposal) => void;
  take: (approvalId: string) => AttachProposal | null;
  crew: (project: Project) => { name: string } | undefined;
  /** Every Worker here, for the check before a detach. */
  workers: () => Promise<readonly AttachedWorker[]>;
  now: () => number;
};

export function liveAttachDeps(input: Pick<AttachDeps, "approvals" | "notify" | "tell" | "log" | "projects" | "workers">): AttachDeps {
  return {
    ...input,
    read: (id) => readSpecialist(id),
    apply: (id, repo, attach, known, by, actor) => setAttached(id, repo, attach, known, by, actor),
    keep: (id, proposal) => keepAttachProposal(id, proposal),
    take: (id) => takeAttachProposal(id),
    crew: (project) => crewFor([project])[project.id],
    now: Date.now,
  };
}

export type AttachOutcome = { status: number; body: Record<string, unknown> };

/** When a change to the list reaches the specialist, said the same way on the card and in every reply. */
export const APPLIES = "It reads the project's files from its next conversation.";

type Pair = { specialist: Project; repo: Project; name: string; repositories: Project[] };

/** The specialist and the repository a request names, or why not. A specialist is named by its project id or its own name; a repository by its id or its name. */
async function pairOf(deps: Pick<AttachDeps, "projects" | "crew">, raw: unknown, keys: { specialist: string; repo: string }): Promise<Pair | AttachOutcome> {
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const asked = String(body[keys.specialist] ?? "").trim();
  const wantedRepo = String(body[keys.repo] ?? "").trim();
  if (!asked || !wantedRepo) return { status: 400, body: { error: `send ${keys.specialist} (the specialist) and ${keys.repo} (the project to attach)` } };
  const repositories = (await deps.projects()).filter(isRepository);
  const wanted = asked.replace(/^@/, "").toLowerCase();
  const specialist = repositories.find((candidate) => candidate.id === asked) ?? repositories.find((candidate) => deps.crew(candidate)?.name.toLowerCase() === wanted);
  if (!specialist) return { status: 404, body: { error: `no specialist "${asked}" here: give its name or its project id` } };
  const named = repositories.filter((candidate) => candidate.name.toLowerCase() === wantedRepo.toLowerCase());
  const repo = repositories.find((candidate) => candidate.id === wantedRepo) ?? (named.length === 1 ? named[0] : undefined);
  if (!repo) return { status: 404, body: { error: named.length > 1 ? `more than one project is named "${wantedRepo}": give its id` : `no project "${wantedRepo}" on this computer` } };
  // Another specialist's own folder is not one of the person's projects: brief that specialist instead.
  if (!isAttachable(repo)) return { status: 400, body: { error: `"${repo.name}" is ${deps.crew(repo)?.name ?? "a specialist"}'s own work, not one of the person's projects: nobody else is attached to it` } };
  return { specialist, repo, name: deps.crew(specialist)?.name ?? specialist.name, repositories };
}

const isOutcome = (value: Pair | AttachOutcome): value is AttachOutcome => "status" in value;

/** Why this pair cannot be attached, or null. */
function refusal(deps: Pick<AttachDeps, "read">, pair: Pair): AttachOutcome | null {
  if (pair.repo.id === pair.specialist.id) return { status: 400, body: { error: `${pair.name} already works on ${pair.repo.name}: it is its own project` } };
  const known = new Set(pair.repositories.map((project) => project.id));
  const current = (deps.read(pair.specialist.id)?.repos ?? []).filter((id) => known.has(id));
  if (current.includes(pair.repo.id)) return { status: 200, body: { unchanged: true, specialist: pair.specialist.id, name: pair.name, project: pair.repo.id } };
  if (current.length >= REPOS_MAX) return { status: 409, body: { error: `${pair.name} is attached to ${REPOS_MAX} projects already, the most one specialist has: detach one first` } };
  return null;
}

/** POST /specialists/attach {id, project}: the person's own act, at once. */
export async function attachByPerson(deps: AttachDeps, raw: unknown, actor: string): Promise<AttachOutcome> {
  const pair = await pairOf(deps, raw, { specialist: "id", repo: "project" });
  if (isOutcome(pair)) return pair;
  const refused = refusal(deps, pair);
  if (refused) return refused;
  const record = deps.apply(pair.specialist.id, pair.repo.id, true, new Set(pair.repositories.map((project) => project.id)), "person", actor);
  deps.log(`specialist ${pair.specialist.id}: attached to ${pair.repo.id} by the person`);
  return { status: 200, body: { specialist: pair.specialist.id, name: pair.name, project: pair.repo.id, repos: record.repos ?? [], note: APPLIES } };
}

/**
 * Detaches, for the person (POST /specialists/detach) and for the Lead
 * (specialist_detach) alike: it only takes access away, so it asks no card.
 * Refused while a Worker this specialist started there still runs: detached
 * under it, nobody could stop it or read what it did.
 */
export async function detach(deps: AttachDeps, raw: unknown, by: SpecialistRecord["updatedBy"], actor: string, keys = { specialist: "id", repo: "project" }): Promise<AttachOutcome> {
  const pair = await pairOf(deps, raw, keys);
  if (isOutcome(pair)) return pair;
  if (!(deps.read(pair.specialist.id)?.repos ?? []).includes(pair.repo.id)) return { status: 200, body: { unchanged: true, specialist: pair.specialist.id, name: pair.name, project: pair.repo.id } };
  const live = (await deps.workers()).filter((worker) => worker.running && worker.parent === pair.repo.id && worker.owner === pair.specialist.id);
  if (live.length > 0) {
    const names = live.map((worker) => worker.name || worker.id).join(", ");
    return { status: 409, body: { error: `${pair.name} still has work running in ${pair.repo.name} (${names}). Stop it or let it finish, then detach.`, workers: live.map((worker) => worker.id) } };
  }
  const record = deps.apply(pair.specialist.id, pair.repo.id, false, new Set(pair.repositories.map((project) => project.id)), by, actor);
  deps.log(`specialist ${pair.specialist.id}: detached from ${pair.repo.id} by ${by === "person" ? "the person" : actor}`);
  return { status: 200, body: { specialist: pair.specialist.id, name: pair.name, project: pair.repo.id, repos: record.repos ?? [] } };
}

/** The card in words: who, which project, where it is, and what Allow gives. */
export function describeAttach(proposal: AttachProposal, who: { name: string }, repo: Pick<Project, "name" | "path">): { attach: ApprovalSpecialistAttach; title: string; body: string } {
  return {
    attach: { id: proposal.id, name: who.name, repo: { id: proposal.repo, name: repo.name, path: repo.path }, sha256: attachHash(proposal) },
    title: `Attach ${who.name} to ${repo.name}?`,
    body: [
      `Cobra wants to attach ${who.name} to your project ${repo.name}.`,
      "",
      "Folder:",
      repo.path,
      "",
      `If you allow it, ${who.name} can read this project's files and start Workers that change them. Every change still comes to you before it is published.`,
      "",
      `${who.name} gets nothing else of this project: not its records, its routines or its memory. ${APPLIES} You can detach it at any time.`,
    ].join("\n"),
  };
}

/** POST /orch/specialist/attach {specialist, project}: the card, or why not. Who may call it is orch.ts's to check. */
export async function proposeAttach(deps: AttachDeps, requestedBy: string, raw: unknown): Promise<AttachOutcome> {
  const pair = await pairOf(deps, raw, { specialist: "specialist", repo: "project" });
  if (isOutcome(pair)) return pair;
  const refused = refusal(deps, pair);
  if (refused) return refused;
  const proposal: AttachProposal = { id: pair.specialist.id, repo: pair.repo.id };
  const words = describeAttach(proposal, { name: pair.name }, pair.repo);
  const now = deps.now();
  const approval = makeApproval({ kind: SPECIALIST_ATTACH, title: words.title, body: words.body, requestedBy, attach: words.attach }, now);
  // The person allows exactly what they read: a card cut short would not name the whole folder.
  if (approval.body !== words.body) return { status: 400, body: { error: "the project's folder is too long to show whole on a card: the person can attach it themselves in the desk app" } };
  // Asking again for the same pair replaces a card not answered yet.
  const replaced = (a: StoredApproval) => a.kind === SPECIALIST_ATTACH && a.state === "pending" && a.attach?.id === proposal.id && a.attach.repo.id === proposal.repo;
  const list = settle(deps.approvals.load(), now);
  for (const old of list.filter(replaced)) deps.take(old.id);
  deps.keep(approval.id, proposal);
  deps.approvals.save([...list.map((a) => (replaced(a) ? { ...a, state: "expired" } : a)), approval]);
  deps.log(`specialist ${proposal.id}: attach to ${proposal.repo} proposed (${approval.id}) by ${requestedBy}`);
  await deps.notify(approval);
  return { status: 202, body: { approval: approval.id, specialist: proposal.id, name: pair.name, project: proposal.repo } };
}

/**
 * After the person answered an attach card (index.ts handleApprovals): Allow
 * attaches the kept pair if its hash is still the card's and both projects
 * are still here, Deny drops it, and the Lead hears which.
 */
export async function settleAttachApproval(deps: AttachDeps, approval: StoredApproval, actor: string): Promise<StoredApproval> {
  if (approval.kind !== SPECIALIST_ATTACH || !approval.attach) return approval;
  const proposal = deps.take(approval.id);
  const { name, id, repo } = approval.attach;
  if (approval.state !== "allowed") {
    deps.tell("lead", `The person declined attaching ${name} to ${repo.name} (${repo.id}); nothing was changed.`);
    deps.log(`specialist ${id}: attach to ${repo.id} declined (${approval.id})`);
    return approval;
  }
  const result = (ok: boolean, message: string): StoredApproval => ({ ...approval, results: [{ ok, message }] });
  // Only the person's own Allow gives a specialist a project: one Cobra gave herself, by whatever path, attaches nothing.
  if (approval.allowedBy === "cobra") {
    deps.log(`specialist ${id}: an Allow that was not the person's (${approval.id}); nothing was attached`);
    return result(false, "Only you can attach a specialist to a project; nothing was changed.");
  }
  if (!proposal || proposal.id !== id || proposal.repo !== repo.id || attachHash(proposal) !== approval.attach.sha256) {
    deps.tell("lead", `${allower(approval)} allowed attaching ${name} to ${repo.name}, but it was not the one on the card, so nothing was changed: specialist_attach it again.`);
    deps.log(`specialist ${id}: no matching attach proposal for ${approval.id}`);
    return result(false, "It was not the one shown; nothing was changed.");
  }
  try {
    const repositories = (await deps.projects()).filter(isRepository);
    const known = new Set(repositories.map((project) => project.id));
    const there = repositories.find((project) => project.id === repo.id);
    // The card named a folder: a project re-made elsewhere under the same id is not what the person read.
    if (!known.has(id) || !there || !isAttachable(there) || there.path !== repo.path) throw new Error("the specialist or the project is no longer on this computer as the card showed it");
    deps.apply(id, repo.id, true, known, "lead", actor);
    deps.tell("lead", `${allower(approval)} allowed it: ${name} (${id}) is attached to ${repo.name} (${repo.id}) and may start Workers there now. ${APPLIES}`);
    deps.log(`specialist ${id}: attached to ${repo.id}`);
    return result(true, `Attached ${name} to ${repo.name}.`);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    deps.tell("lead", `${allower(approval)} allowed attaching ${name} to ${repo.name}, but it could not be done (${message}).`);
    deps.log(`specialist ${id}: attach failed: ${message}`);
    return result(false, `Not attached: ${message}`);
  }
}
