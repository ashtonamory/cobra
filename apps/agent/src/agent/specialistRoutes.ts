import type { Project } from "@cobra/contracts";

import { allower, makeApproval, settle, type StoredApproval } from "./approvals.ts";
import { changeCrew, crewFor, CrewError } from "./crew.ts";
import {
  cleanTitle,
  defaultTitle,
  describeProposal,
  keepSpecialistProposal,
  parseChange,
  proposalHash,
  readSpecialist,
  setSpecialist,
  takeSpecialistProposal,
  type SpecialistChange,
  type SpecialistProposal,
  type SpecialistRecord,
} from "./specialists.ts";

/**
 * How a specialist changes (specialists.ts the record and its rules).
 *
 * The person: POST /specialists/set, their own act, so no card.
 *
 * The Lead: specialist_set proposes a change, which becomes one approval of
 * kind `specialist` showing every word it would set and every word it
 * replaces (a newer one for the same specialist replaces a card not yet
 * answered). Allow applies exactly the change the card was made from, Deny
 * writes nothing, and the Lead hears which. Cobra never allows this kind
 * herself (instinctActs.ts, unanswered.ts list what she may; it is in
 * neither).
 */

export type SpecialistDeps = {
  approvals: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };
  notify: (approval: StoredApproval) => Promise<void>;
  tell: (owner: string, text: string) => void;
  log: (line: string) => void;
  /** The repositories here: only one of them has a Foreman to change. */
  projects: () => Promise<readonly Project[]>;
  tradeName: (id: string) => string | undefined;
  read: (id: string) => SpecialistRecord | null;
  apply: (id: string, change: SpecialistChange, by: SpecialistRecord["updatedBy"], actor: string) => SpecialistRecord;
  keep: (approvalId: string, proposal: SpecialistProposal) => void;
  take: (approvalId: string) => SpecialistProposal | null;
  crew: (project: Project) => { name: string } | undefined;
  now: () => number;
};

export function liveSpecialistDeps(input: Pick<SpecialistDeps, "approvals" | "notify" | "tell" | "log" | "projects" | "tradeName">): SpecialistDeps {
  return {
    ...input,
    read: (id) => readSpecialist(id),
    apply: (id, change, by, actor) => setSpecialist(id, change, by, actor),
    keep: (id, proposal) => keepSpecialistProposal(id, proposal),
    take: (id) => takeSpecialistProposal(id),
    crew: (project) => crewFor([project])[project.id],
    now: Date.now,
  };
}

export type SpecialistOutcome = { status: number; body: Record<string, unknown> };

const isRepository = (project: Project): boolean => project.parent === undefined && !project.lead && !project.foreman;

/** What a specialist reads as now, defaults filled in: what a card says a change replaces. */
function currentOf(deps: Pick<SpecialistDeps, "read" | "tradeName">, project: Project): { title: string; instructions: string; model: string } {
  const record = deps.read(project.id);
  return { title: record?.title ?? defaultTitle(project.foremanTemplate, deps.tradeName), instructions: record?.instructions ?? "", model: record?.model ?? "" };
}

/** POST /orch/specialist/set {specialist, title?, instructions?, model?}: the card, or why not. Who may call it is orch.ts's to check. */
export async function proposeSpecialist(deps: SpecialistDeps, requestedBy: string, raw: unknown): Promise<SpecialistOutcome> {
  const asked = String((raw as { specialist?: unknown } | null)?.specialist ?? "").trim();
  const projects = (await deps.projects()).filter(isRepository);
  const wanted = asked.replace(/^@/, "").toLowerCase();
  const project = projects.find((candidate) => candidate.id === asked) ?? projects.find((candidate) => deps.crew(candidate)?.name.toLowerCase() === wanted);
  if (!project) return { status: 404, body: { error: `no specialist "${asked}" here: give its name or its project id from the status tool` } };
  const change = parseChange(raw);
  if (typeof change === "string") return { status: 400, body: { error: change } };
  const current = currentOf(deps, project);
  // Only what would differ goes on the card: a field already so is not a change.
  const differs: SpecialistChange = {};
  if (change.title !== undefined && (change.title || defaultTitle(project.foremanTemplate, deps.tradeName)) !== current.title) differs.title = change.title;
  if (change.instructions !== undefined && change.instructions !== current.instructions) differs.instructions = change.instructions;
  if (change.model !== undefined && change.model !== current.model) differs.model = change.model;
  const name = deps.crew(project)?.name ?? project.name;
  if (Object.keys(differs).length === 0) return { status: 200, body: { unchanged: true, specialist: project.id, name } };
  const proposal: SpecialistProposal = { id: project.id, change: differs };
  const words = describeProposal(proposal, { name, project: project.name }, current);
  const now = deps.now();
  const approval = makeApproval({ kind: "specialist", title: words.title, body: words.body, requestedBy, specialist: words.specialist }, now);
  // The person allows exactly what they read: a card cut short would not be that.
  if (approval.body !== words.body) return { status: 400, body: { error: `the card would be over ${approval.body.length} characters, so it cannot show every word: shorten the instructions` } };
  // A newer proposal for the same specialist replaces a card not answered yet.
  const replaced = (a: StoredApproval) => a.kind === "specialist" && a.state === "pending" && a.specialist?.id === project.id;
  const list = settle(deps.approvals.load(), now);
  for (const old of list.filter(replaced)) deps.take(old.id);
  deps.keep(approval.id, proposal);
  deps.approvals.save([...list.map((a) => (replaced(a) ? { ...a, state: "expired" } : a)), approval]);
  deps.log(`specialist ${project.id}: change proposed (${approval.id}) by ${requestedBy}`);
  await deps.notify(approval);
  return { status: 202, body: { approval: approval.id, specialist: project.id, name, fields: Object.keys(differs) } };
}

/**
 * After the person answered a specialist card (index.ts handleApprovals):
 * Allow applies the kept change if its hash is still the card's, Deny drops
 * it, and the Lead hears which. Returns the approval as it stands.
 */
export function settleSpecialistApproval(deps: SpecialistDeps, approval: StoredApproval, actor: string): StoredApproval {
  if (approval.kind !== "specialist" || !approval.specialist) return approval;
  const proposal = deps.take(approval.id);
  const { name, id } = approval.specialist;
  if (approval.state !== "allowed") {
    deps.tell("lead", `The person declined the change to ${name} (${id}); nothing was changed.`);
    deps.log(`specialist ${id}: change declined (${approval.id})`);
    return approval;
  }
  const result = (ok: boolean, message: string): StoredApproval => ({ ...approval, results: [{ ok, message }] });
  // Only the person's own Allow changes a specialist: one Cobra gave herself, by whatever path, applies nothing.
  if (approval.allowedBy === "cobra") {
    deps.log(`specialist ${id}: an Allow that was not the person's (${approval.id}); nothing was changed`);
    return result(false, "Only you can allow a change to a specialist; nothing was changed.");
  }
  if (!proposal || proposal.id !== id || proposalHash(proposal) !== approval.specialist.sha256) {
    deps.tell("lead", `${allower(approval)} allowed the change to ${name}, but it was not the one on the card, so nothing was changed: specialist_set it again.`);
    deps.log(`specialist ${id}: no matching proposal for ${approval.id}`);
    return result(false, "The change was not the one shown; nothing was changed.");
  }
  try {
    deps.apply(id, proposal.change, "lead", actor);
    deps.tell("lead", `${allower(approval)} allowed the change to ${name} (${id}). It applies from ${name}'s next conversation.`);
    deps.log(`specialist ${id}: changed (${Object.keys(proposal.change).join(", ")})`);
    return result(true, `Changed ${name}.`);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    deps.tell("lead", `${allower(approval)} allowed the change to ${name}, but it could not be kept (${message}).`);
    deps.log(`specialist ${id}: change failed: ${message}`);
    return result(false, `Not changed: ${message}`);
  }
}

/**
 * POST /specialists/set, the person's own change from the desk: a name
 * (crew.ts keeps names unique), a title, instructions, a model. Everything
 * is checked before anything is written, so a bad field changes nothing.
 */
export function setByPerson(
  project: Project,
  raw: unknown,
  actor: string,
  deps: { rename: (project: Project, name: string | null) => { name: string }; apply: SpecialistDeps["apply"] } = { rename: (target, name) => changeCrew(target, { name }), apply: (id, change, by, who) => setSpecialist(id, change, by, who) },
): SpecialistOutcome {
  if (!isRepository(project)) return { status: 400, body: { error: `"${project.id}" has no specialist of its own` } };
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const named = body.name !== undefined;
  if (named && body.name !== null && typeof body.name !== "string") return { status: 400, body: { error: "name is text, or null for the one it would be given" } };
  const fields = ["title", "instructions", "model"].some((key) => body[key] !== undefined);
  const change = fields ? parseChange(body) : null;
  if (typeof change === "string") return { status: 400, body: { error: change } };
  if (!named && !change) return { status: 400, body: { error: "send at least one of name, title, instructions, model" } };
  let name: string | undefined;
  if (named) {
    try {
      name = deps.rename(project, body.name as string | null).name;
    } catch (caught) {
      if (caught instanceof CrewError) return { status: caught.status, body: { error: caught.message } };
      throw caught;
    }
  }
  const record = change ? deps.apply(project.id, change, "person", actor) : null;
  return { status: 200, body: { specialist: project.id, ...(name ? { name } : {}), ...(record ? { record } : {}) } };
}

/** A new specialist's title at foreman_create: checked like any other; "" means none was given. */
export function createTitle(raw: unknown): { title: string } | { error: string } {
  return raw === undefined ? { title: "" } : cleanTitle(raw);
}
