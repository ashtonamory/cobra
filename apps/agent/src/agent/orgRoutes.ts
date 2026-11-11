// My Organization (packages/contracts/src/org.ts the rules): which company
// each Foreman works for, kept on the Lead's computer in org.json.
//
// For the person's desk (their own keys, never a Lead's):
//   GET  /org                              {org, home}: home when this computer keeps the fleet's (the Lead's)
//   POST /org {change, revision?}          200 {org, created?}: one change at the next revision;
//                                           409 when `revision` is not the file's (someone changed it first)
//
// For the Lead on this computer, through orch.ts with its Lead key:
//   GET  /orch/org                         {org, text}
//   POST /orch/org/set {change}            200 {org, said}: what the person told Cobra in chat, done at once
//   POST /orch/org/propose {seat, foreman, company? | companyName?, why}
//                                           202 {approval}: "Move Mae to Happy Tails?", kind `org`; the
//                                           person's Allow makes the move (a new company first, if named)
//
// The Lead hears the person's answer to a proposal as a [cobra] line.
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { applyOrg, cleanCompanyName, describeOrgChange, EMPTY_ORG, OrgError, orgText, parseOrg, parseOrgChange, type Org, type OrgChange, type OrgProposal } from "../../../../packages/contracts/src/org.ts";

import { allower, makeApproval, settle, type StoredApproval } from "./approvals.ts";
import { CONFIG_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";

export const ORG_PATH = process.env.COBRA_ORG ?? join(CONFIG_DIR, "org.json");

export const PERSON_ORG_ROUTES: ReadonlySet<string> = new Set(["/org"]);
export const ORCH_ORG_ROUTES: ReadonlySet<string> = new Set(["/orch/org", "/orch/org/set", "/orch/org/propose"]);
export const ORCH_ORG_POSTS: ReadonlySet<string> = new Set(["/orch/org/set", "/orch/org/propose"]);
const PERSON_KINDS: ReadonlySet<string> = new Set(["desk"]);
const WHY_MAX = 400;

export type Reply = { status: number; body: unknown };
type Caller = { id: string; kind: string; project?: string };

export type OrgDeps = {
  load: () => Org;
  save: (org: Org) => void;
  /** Whether this computer keeps the fleet's org: the Lead's (morning.ts sendsHere). */
  home: () => boolean;
  approvals: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };
  notify: (approval: StoredApproval) => Promise<void>;
  tell: (owner: string, text: string) => void;
  log: (line: string) => void;
  now: () => number;
};

export function loadOrg(path = ORG_PATH): Org {
  try {
    return parseOrg(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...EMPTY_ORG, companies: [], seats: {} };
  }
}

export function saveOrg(org: Org, path = ORG_PATH): void {
  writePrivateFile(path, `${JSON.stringify(org, null, 2)}\n`);
}

export function liveOrgDeps(input: Pick<OrgDeps, "home" | "approvals" | "notify" | "tell" | "log">): OrgDeps {
  return { ...input, load: () => loadOrg(), save: (org) => saveOrg(org), now: Date.now };
}

const bad = (status: number, error: string): Reply => ({ status, body: { error } });

function parse(bodyText: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(bodyText) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function change(deps: OrgDeps, raw: unknown, revision?: unknown): Reply {
  try {
    const parsed = parseOrgChange(raw);
    const org = deps.load();
    if (revision !== undefined && revision !== org.revision) return { status: 409, body: { error: "the organization changed since you read it", org } };
    const done = applyOrg(org, parsed);
    deps.save(done.org);
    return { status: 200, body: { org: done.org, ...(done.created ? { created: done.created } : {}) } };
  } catch (caught) {
    if (caught instanceof OrgError) return bad(caught.status, caught.message);
    throw caught;
  }
}

/** GET and POST /org, for the person's the desk. */
export async function handleOrgPerson(route: string, method: string | undefined, bodyText: string, caller: Caller, deps: OrgDeps): Promise<Reply> {
  if (!PERSON_KINDS.has(caller.kind)) return bad(403, "only the desk app changes the organization");
  if (route !== "/org") return bad(404, "no such route");
  if (method === "GET") return { status: 200, body: { org: deps.load(), home: deps.home() } };
  if (method !== "POST") return bad(405, "GET or POST");
  const body = parse(bodyText);
  if (!body) return bad(400, "invalid JSON body");
  const reply = change(deps, body.change, body.revision);
  if (reply.status === 200) deps.log(`org: ${describeOrgChange(deps.load(), parseOrgChange(body.change))} (by ${caller.id})`);
  return reply;
}

/** The Lead's org routes (orch.ts): the Lead only; a Foreman's key is refused. */
export async function handleOrgOrch(route: string, bodyText: string, caller: Caller, deps: OrgDeps): Promise<Reply> {
  if (caller.kind !== "lead" || caller.project !== undefined) return bad(403, "only the Lead keeps the organization");
  if (route === "/orch/org") {
    const org = deps.load();
    return { status: 200, body: { org, text: orgText(org) } };
  }
  const body = parse(bodyText);
  if (!body) return bad(400, "invalid JSON body");
  if (route === "/orch/org/set") {
    const before = deps.load();
    const reply = change(deps, body.change);
    if (reply.status !== 200) return reply;
    const said = describeOrgChange(before, parseOrgChange(body.change));
    deps.log(`org: ${said} (by Cobra)`);
    return { status: 200, body: { ...(reply.body as object), said } };
  }
  if (route === "/orch/org/propose") return proposeOrg(deps, caller.id, body);
  return bad(404, "no such route");
}

/** Cobra's suggestion as an approval card; a newer one for the same seat replaces one not answered yet. */
export async function proposeOrg(deps: OrgDeps, requestedBy: string, body: Record<string, unknown>): Promise<Reply> {
  const org = deps.load();
  let proposal: OrgProposal;
  try {
    const { seat } = parseOrgChange({ op: "retire", seat: body.seat }) as { seat: string };
    const foreman = typeof body.foreman === "string" && body.foreman.trim() ? body.foreman.trim().slice(0, 40) : seat;
    if (typeof body.company === "string") {
      const company = org.companies.find((c) => c.id === body.company);
      if (!company) return bad(404, `no company ${body.company}: name a new one with companyName`);
      if (org.seats[seat]?.company === company.id && !org.seats[seat]?.retired) return bad(409, `${foreman} already works for ${company.name}`);
      proposal = { seat, foreman, company: company.id, companyName: company.name };
    } else {
      const companyName = cleanCompanyName(body.companyName);
      if (!companyName) return bad(400, "company (an id) or companyName (a new company) is required");
      const existing = org.companies.find((c) => c.name.toLowerCase() === companyName.toLowerCase());
      proposal = existing ? { seat, foreman, company: existing.id, companyName: existing.name } : { seat, foreman, company: null, companyName };
    }
  } catch (caught) {
    if (caught instanceof OrgError) return bad(caught.status, caught.message);
    throw caught;
  }
  const why = typeof body.why === "string" ? body.why.replace(/\s+/g, " ").trim().slice(0, WHY_MAX) : "";
  const fresh = proposal.company === null;
  const title = `Move ${proposal.foreman} to ${proposal.companyName}?`;
  const text = [why || `Cobra thinks ${proposal.foreman} works for ${proposal.companyName}.`, fresh ? `${proposal.companyName} is a new company: Allow opens it too.` : ""].filter(Boolean).join(" ");
  const now = deps.now();
  const approval = makeApproval({ kind: "org", title, body: text, requestedBy, org: proposal }, now);
  const replaced = (a: StoredApproval) => a.kind === "org" && a.state === "pending" && a.org?.seat === proposal.seat;
  const list = settle(deps.approvals.load(), now).map((a) => (replaced(a) ? { ...a, state: "expired" } : a));
  deps.approvals.save([...list, approval]);
  deps.log(`org proposal ${approval.id}: ${title}`);
  await deps.notify(approval);
  return { status: 202, body: { approval: approval.id, title } };
}

/**
 * After the person answered an org card (index.ts handleApprovals): Allow
 * makes the move (opening the company first when the card named a new one),
 * Deny changes nothing, and the Lead hears which.
 */
export function settleOrgApproval(deps: OrgDeps, approval: StoredApproval): StoredApproval {
  const proposal = approval.org;
  if (approval.kind !== "org" || !proposal) return approval;
  if (approval.state !== "allowed") {
    deps.tell("lead", `The person said not now to moving ${proposal.foreman} (${proposal.seat}) to ${proposal.companyName ?? "New arrivals"}; leave it unless they bring it up.`);
    return approval;
  }
  const result = (ok: boolean, message: string): StoredApproval => ({ ...approval, results: [{ ok, message }] });
  try {
    let org = deps.load();
    let company = proposal.company;
    if (company === null && proposal.companyName) {
      const existing = org.companies.find((c) => c.name.toLowerCase() === proposal.companyName!.toLowerCase());
      if (existing) company = existing.id;
      else {
        const opened = applyOrg(org, { op: "company", name: proposal.companyName });
        org = opened.org;
        company = opened.created ?? null;
      }
    }
    const move: OrgChange = { op: "assign", seat: proposal.seat, company };
    org = applyOrg(org, move).org;
    deps.save(org);
    const said = describeOrgChange(org, move, () => proposal.foreman);
    deps.tell("lead", `${allower(approval)} allowed it: ${said}.`);
    deps.log(`org: ${said} (allowed ${approval.id})`);
    return result(true, said);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    deps.tell("lead", `${allower(approval)} allowed moving ${proposal.foreman}, but it could not be done (${message}).`);
    return result(false, message);
  }
}
