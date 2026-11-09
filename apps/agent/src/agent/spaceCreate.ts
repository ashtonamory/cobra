// Opening a Space from an intake. The Lead has
// asked the person a few plain questions in chat and calls `space_create` with
// the answers; this file turns that into one card ("Open Maya's Soccer?") and,
// on Allow, into a real Space: the company in My Organization with its kind and
// home computer, its folder and profile, and its brain seeded from the answers.
// It opens with no Foremen: Cobra hires each skill the first time a request
// needs it (foreman_create with space).
//
//   POST /orch/space/create {name, kind, sensitive?, profile, adopt?}
//                                   202 {approval, title}: the Lead on this computer only
//
// A Space is pinned to the computer that opens it (this one). A Foreman hired
// into it later is created, seated in the Space's one store and put in the org
// before it starts (orch.ts foreman_create), so its first write already lands
// in the shared store.
import {
  applyOrg,
  cleanCompanyName,
  seatKey,
  COMPANY_NAME_MAX,
  MAX_COMPANIES,
  OrgError,
  type Org,
  type OrgCompany,
} from "../../../../packages/contracts/src/org.ts";
import { baselineSeats, isSpaceKind, MAX_SPACE_FOREMEN, parseProfile, SENSITIVE_BY_DEFAULT, SPACE_KIND_INFO, type BaselineSeat, type SpaceKind, type SpaceProfile } from "../../../../packages/contracts/src/spaces.ts";

import { allower, makeApproval, settle, type StoredApproval } from "./approvals.ts";
import { openSpace, readSpace, registerSeat, writeProfile, type SpaceRecord } from "./spaces.ts";

export type Reply = { status: number; body: unknown };

export type SpaceDeps = {
  /** This computer, as a seat names it (os.hostname()). */
  machine: string;
  spacesRoot: string;
  org: { load: () => Org; save: (org: Org) => void };
  approvals: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };
  notify: (approval: StoredApproval) => Promise<void>;
  tell: (owner: string, text: string) => void;
  log: (line: string) => void;
  now: () => number;
  /** Makes the Spaces folder a place projects may be created in (folders.json). */
  addRoot: () => Promise<void> | void;
  /** Writes the company's brain from the intake, when it has none yet. */
  seedBrain: (company: { id: string; name: string; sensitive: boolean }, text: string) => void;
};

const bad = (status: number, error: string): Reply => ({ status, body: { error } });

function parse(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The brain's first text, from what the person said: what it is, who is in it, and the rules for the work (voice, tools, money). */
export function seedBrainText(name: string, kind: SpaceKind, profile: SpaceProfile, day: string): string {
  const rules = [profile.voice && `Voice: ${profile.voice}`, profile.tools && `Already uses: ${profile.tools}`, profile.money && `Money: ${profile.money}`, profile.notes && `Also: ${profile.notes}`].filter((line): line is string => Boolean(line));
  const section = (heading: string, lines: string[]) => [`## ${heading}`, ...lines];
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  return `${[
    `# ${name}`,
    "",
    `_Updated ${day}._`,
    "",
    ...section("What it is", [`${SPACE_KIND_INFO[kind].label}. ${oneLine(profile.purpose)}`]),
    "",
    ...section("People", [oneLine(profile.people)]),
    "",
    ...section("Decisions", []),
    "",
    ...section("Rules for the work", rules.map((rule) => `- ${oneLine(rule)}`)),
    "",
    ...section("Open threads", []),
  ].join("\n")}\n`;
}

/** What each baseline seat does first, in the Space's own words. */
function firstJob(kind: SpaceKind, seat: BaselineSeat): string {
  const family = kind === "team" || kind === "family";
  if (seat.role === "outreach") return `Read the company brief you start with, then draft one first message the Space needs (a welcome, an announcement or an introduction) in its own voice, as a draft the person approves: open a campaign for it and propose it with action_propose when it is ready. Write nothing to anyone who is not in the people table.`;
  if (seat.role === "people") return `Set up this Space's stages: propose a sensible set for ${kind === "team" ? "a team (for example invited, confirmed, declined)" : kind === "family" ? "a household's contacts" : "a business (for example lead, talking, won, lost)"} and add them with stage_set. Then set up what this Space tracks on each person beyond name, business, email, phone and stage: pick the few fields that fit what it is for from your brief, add them with field_set, and tell the person which you chose so they can change them. Then ask the person who the first people are, or bring them in from a sheet they keep with sheet_import. Do not invent anyone.`;
  return family
    ? `Set up how this Space handles money: read the money notes in your brief, ask the person which currency they count in and set it with home_currency_set (with the Space's name), ask which accounts they keep (cash, a bank account, a card, savings, investments, loans, each with its currency when it is not that one) and what each holds, ask whether they want monthly limits now (propose them with limits_propose once they say, or after a month of spending), tell the person what you still need to know, and ask before you record anything. Never invent an amount.`
    : `Set the business up with business_set from what the brief says, its currency among it (ask the person for what it does not), then tell the person what you still need to know, such as its tax details and payment terms. Never invent a figure.`;
}

/** The first brief a seat's Foreman gets: who it is in this Space, the profile it can read in the company brain, and its first job. One line. */
export function seatBrief(spaceName: string, kind: SpaceKind, seat: BaselineSeat): string {
  return `[Space: ${spaceName}, a ${SPACE_KIND_INFO[kind].label.toLowerCase()}] You are the ${seat.name} Foreman of this Space. The person told Cobra what it is for and who it serves, and it is in your company brief; read it before you do anything. First job: ${firstJob(kind, seat)}`;
}

/** Cobra's request to open a Space, as one card. A newer card for the same name replaces one not answered yet. */
export async function proposeSpace(deps: SpaceDeps, requestedBy: string, raw: unknown): Promise<Reply> {
  const body = parse(raw);
  if (!body) return bad(400, "invalid JSON body");
  const org = deps.org.load();
  const kind = body.kind;
  if (!isSpaceKind(kind)) return bad(400, "kind must be client, own, team or family");
  const profile = parseProfile(body.profile);
  if (!profile) return bad(400, "profile needs a purpose (what it is for) and people (who it serves or who is in it)");
  const sensitive = typeof body.sensitive === "boolean" ? body.sensitive : SENSITIVE_BY_DEFAULT[kind];
  let name: string;
  let adopt: string | undefined;
  if (typeof body.adopt === "string") {
    const company = org.companies.find((c) => c.id === body.adopt);
    if (!company) return bad(404, `no company ${body.adopt}: leave adopt out to open a new Space`);
    // A company a failed opening left marked as a Space, with no folder here, is finished by asking again.
    if (company.kind && (company.home !== deps.machine || readSpace(company.id, deps.spacesRoot))) return bad(409, `${company.name} is already a Space`);
    name = company.name;
    adopt = company.id;
  } else {
    name = cleanCompanyName(body.name);
    if (!name) return bad(400, `name is required (at most ${COMPANY_NAME_MAX} characters)`);
    if (org.companies.some((c) => c.name.toLowerCase() === name.toLowerCase())) return bad(409, `there is already a company called ${name}: use adopt with its id to make it a Space`);
    if (org.companies.length >= MAX_COMPANIES) return bad(409, `at most ${MAX_COMPANIES} companies`);
  }
  // No baseline seats: the Space starts empty and Cobra brings in each skill on first need.
  const seats: Array<{ role: string; name: string; trade: string }> = [];
  const { version: _version, updated: _updated, ...answers } = profile;
  const space = { name, spaceKind: kind, sensitive, ...(adopt ? { adopt } : {}), seats, profile: answers };
  const clip = (text: string) => (text.length > 240 ? `${text.slice(0, 237)}...` : text);
  const text = [
    `${SPACE_KIND_INFO[kind].label}, on ${deps.machine}. ${sensitive ? "Sensitive: its details stay on this computer." : "Not sensitive."}`,
    "Cobra brings in each skill it needs the first time you ask for something there.",
    `For: ${clip(profile.purpose)}`,
    `Serves: ${clip(profile.people)}`,
    adopt ? `${name} is already in your organization: Allow makes it a Space.` : "",
  ].filter(Boolean).join("\n");
  const now = deps.now();
  const approval = makeApproval({ kind: "space", title: `Open ${name}?`, body: text, requestedBy, space }, now);
  const replaced = (a: StoredApproval) => a.kind === "space" && a.state === "pending" && a.space?.name.toLowerCase() === name.toLowerCase();
  const list = settle(deps.approvals.load(), now).map((a) => (replaced(a) ? { ...a, state: "expired" } : a));
  deps.approvals.save([...list, approval]);
  deps.log(`space proposal ${approval.id}: ${approval.title}`);
  await deps.notify(approval);
  return { status: 202, body: { approval: approval.id, title: approval.title } };
}

/**
 * After the person answered a Space card (index.ts handleApprovals): Allow
 * opens the Space and starts its Foremen; Deny changes nothing. The Lead hears
 * which, and which seats started.
 */
export async function settleSpaceApproval(deps: SpaceDeps, approval: StoredApproval): Promise<StoredApproval> {
  const sp = approval.space;
  if (approval.kind !== "space" || !sp) return approval;
  if (approval.state !== "allowed") {
    deps.tell("lead", `The person said not now to opening ${sp.name}; leave it unless they bring it up.`);
    return approval;
  }
  const finish = (ok: boolean, message: string): StoredApproval => ({ ...approval, state: ok ? "done" : "failed", results: [{ ok, message }] });
  const kind = sp.spaceKind as SpaceKind;
  const profile = parseProfile({ ...sp.profile, updated: new Date(deps.now()).toISOString() });
  if (!isSpaceKind(kind) || !profile) {
    deps.tell("lead", `${allower(approval)} allowed opening ${sp.name}, but the card was not readable (${String(sp.spaceKind)}); propose it again.`);
    return finish(false, "unreadable card");
  }
  const lines: string[] = [];
  let id: string;
  let record: SpaceRecord;
  try {
    let org = deps.org.load();
    if (sp.adopt) {
      const marked = org.companies.find((c) => c.id === sp.adopt);
      // Already marked by an opening that failed before its folder was made: nothing to mark again.
      if (!(marked?.kind === kind && marked.home === deps.machine)) org = applyOrg(org, { op: "space", company: sp.adopt, kind, home: deps.machine }).org;
      id = sp.adopt;
    } else {
      const opened = applyOrg(org, { op: "company", name: sp.name, kind, home: deps.machine });
      org = opened.org;
      id = opened.created as string;
    }
    const company = org.companies.find((c) => c.id === id)!;
    if ((company.sensitive === true) !== sp.sensitive) org = applyOrg(org, { op: "sensitive", company: id, on: sp.sensitive }).org;
    // The org is saved last: a step that fails (the folder, the profile, the brain) leaves no company marked as a Space, so asking again starts clean.
    await deps.addRoot();
    record = openSpace({ id, name: company.name, kind, home: deps.machine, sensitive: sp.sensitive }, deps.machine, deps.spacesRoot, () => new Date(deps.now()));
    writeProfile(id, sp.profile, deps.spacesRoot, () => new Date(deps.now()));
    deps.seedBrain({ id, name: company.name, sensitive: sp.sensitive }, seedBrainText(company.name, kind, profile, new Date(deps.now()).toISOString().slice(0, 10)));
    deps.org.save(org);
    lines.push(`${company.name} is open on ${deps.machine} as a ${SPACE_KIND_INFO[kind].label.toLowerCase()} Space.`);
  } catch (caught) {
    const message = caught instanceof OrgError || caught instanceof Error ? caught.message : String(caught);
    deps.tell("lead", `${allower(approval)} allowed opening ${sp.name}, but it could not be opened (${message}).`);
    return finish(false, message);
  }
  deps.log(`space: opened ${record.name} (${id}) by ${approval.id}, with no Foremen yet`);
  deps.tell("lead", `${allower(approval)} allowed it. ${lines.join(" ")} It has no Foremen yet: hire each skill with foreman_create and space "${id}" the first time a request needs it. Tell the person it is open and what you will do first.`);
  return finish(true, lines.join(" "));
}

/**
 * The first brief of a Foreman Cobra hires into a Space on first need: a
 * People, Outreach or Money seat gets the first job a Space used to start it
 * with (seatBrief), then the request that brought it in; any other trade gets
 * the request alone. At most 3800 characters, inside typeBrief's line.
 */
export function hireBrief(company: Pick<OrgCompany, "name" | "kind"> | undefined, role: string | null, asked: string | undefined): string | null {
  const request = asked?.trim() || null;
  const seat = company?.kind && role && isSpaceKind(company.kind) ? baselineSeats(company.kind).find((candidate) => candidate.role === role) : undefined;
  const firstJob = company?.kind && seat && isSpaceKind(company.kind) ? seatBrief(company.name, company.kind, seat) : null;
  const joined = [firstJob, request && firstJob ? `Then, for the request that brought you in: ${request}` : request].filter(Boolean).join(" ");
  return joined ? joined.slice(0, 3800) : null;
}

/**
 * Whether the Lead may hire another Foreman into a Space (foreman_create with
 * `space`): the Space must exist, be this computer's, be opened here (its
 * folder made) and have room. Up to
 * MAX_SPACE_FOREMEN she hires on her own; past it she asks the person and calls
 * again with `confirmed`.
 */
export function checkHire(org: Org, spaceId: string, machine: string, confirmed: boolean, opened = true): { company: OrgCompany } | { status: number; error: string } {
  const company = org.companies.find((c) => c.id === spaceId);
  if (!company) return { status: 404, error: `no company ${spaceId}: space is a company id from org_read` };
  if (!company.kind || !company.home) return { status: 409, error: `${company.name} is not a Space yet: make it one with space_create and adopt` };
  if (company.home !== machine) return { status: 409, error: `${company.name} runs on ${company.home}, not on ${machine}: a Space's Foremen run on its own computer` };
  // Marked as a Space by an opening that never finished: no folder, no store to seat a Foreman in.
  if (!opened) return { status: 409, error: `${company.name} is marked as a Space but never finished opening, so it has no folder here yet. Finish it first: call space_create with adopt "${company.id}" and its profile (the person's one Allow opens it), then hire.` };
  const count = Object.values(org.seats).filter((seat) => seat.company === company.id && !seat.retired).length;
  if (count >= MAX_SPACE_FOREMEN && !confirmed) {
    return { status: 409, error: `${company.name} already has ${count} Foremen, the most Cobra hires on her own. Ask the person whether to hire another, then call foreman_create again with confirmed true.` };
  }
  return { company };
}
