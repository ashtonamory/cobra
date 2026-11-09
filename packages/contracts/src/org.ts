/**
 * My Organization: which company each Foreman works for, kept on the Lead's
 * computer in `~/.config/cobra-agent/org.json` (`GET /org`, `POST /org`).
 *
 * A seat is one project's Foreman, keyed `<machine>/<project id>` (the
 * project's `machine` as `/projects` and `/orch/status` name it), so the same
 * repository on two computers is two seats. A seat with no company sits in New
 * arrivals; a retired one in the Outskirts.
 *
 * No zod here: the agent imports this file by path and runs with no
 * node_modules (`apps/agent/scripts/package.sh` ships it).
 */
import { HOME_NAME, isSpaceKind, SPACE_KIND_INFO, type SpaceKind } from "./spaces.ts";

/**
 * `sensitive`: the company's memory holds other people's details, so it never
 * leaves the computer that runs its projects, not even as a line in Cobra's
 * index. Off when absent.
 */
export type OrgCompany = {
  id: string;
  name: string;
  color: string;
  sensitive?: boolean;
  /**
   * A Space: what it is, and the one computer that runs
   * it (a seat's `<machine>`), which its store, brain and Foremen never leave.
   * Both or neither; a company with neither is a plain label, as before.
   */
  kind?: SpaceKind;
  home?: string;
};
export type OrgSeat = { company?: string; retired?: boolean };
export type Org = { revision: number; companies: OrgCompany[]; seats: Record<string, OrgSeat> };

/** What `GET /org` answers: the file, and whether this computer keeps the fleet's (the Lead's computer). */
export type OrgReply = { org: Org; home: boolean };

/** One change to the org, as the apps, the Lead and an Allowed proposal send it. */
export type OrgChange =
  | { op: "company"; name: string; color?: string; kind?: SpaceKind; home?: string }
  /** Makes an existing company a Space (adoption), or changes its kind; its home, once set, stays. */
  | { op: "space"; company: string; kind: SpaceKind; home: string }
  | { op: "rename"; company: string; name: string }
  | { op: "sensitive"; company: string; on: boolean }
  | { op: "remove"; company: string }
  | { op: "assign"; seat: string; company: string | null }
  | { op: "retire"; seat: string }
  | { op: "bring-back"; seat: string };

/** What a proposal Cobra makes carries on its approval (`Approval.org`): one seat to one company. */
export type OrgProposal = { seat: string; foreman: string; company: string | null; companyName?: string };

export const EMPTY_ORG: Org = { revision: 0, companies: [], seats: {} };

/** Company colours, handed out in turn; earthy so they sit on the town's signs. */
export const COMPANY_COLORS = ["#c0763a", "#4f9d69", "#3f86c4", "#9c6ad6", "#d6a12c", "#3aa6a0", "#d65f8c", "#7fae3f", "#6b7288", "#c4523f"] as const;

export const COMPANY_NAME_MAX = 32;
export const MAX_COMPANIES = 40;

export class OrgError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const seatKey = (machine: string, project: string): string => `${machine}/${project}`;

export function seatParts(seat: string): { machine: string; project: string } | null {
  const at = seat.indexOf("/");
  return at > 0 && at < seat.length - 1 ? { machine: seat.slice(0, at), project: seat.slice(at + 1) } : null;
}

const SEAT = /^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._-]{1,120}$/;
const COMPANY_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A company id, for the places that name a company in a path (spaces.ts). */
export const COMPANY_ID_PATTERN = COMPANY_ID;
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** A company's name as kept: one line, trimmed, at most COMPANY_NAME_MAX characters. */
export function cleanCompanyName(name: unknown): string {
  return typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, COMPANY_NAME_MAX) : "";
}

/** A new company's id from its name, unlike any taken. */
export function companyIdFor(name: string, taken: readonly string[]): string {
  const base = cleanCompanyName(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "company";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** Read an org file or reply leniently: anything malformed is dropped, never thrown. */
export function parseOrg(value: unknown): Org {
  if (!value || typeof value !== "object") return { ...EMPTY_ORG, companies: [], seats: {} };
  const raw = value as Record<string, unknown>;
  const companies: OrgCompany[] = [];
  for (const item of Array.isArray(raw.companies) ? raw.companies : []) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const name = cleanCompanyName(c.name);
    if (typeof c.id !== "string" || !COMPANY_ID.test(c.id) || !name || companies.some((known) => known.id === c.id)) continue;
    companies.push({
      id: c.id,
      name,
      color: typeof c.color === "string" && COLOR.test(c.color) ? c.color : COMPANY_COLORS[companies.length % COMPANY_COLORS.length]!,
      ...(c.sensitive === true ? { sensitive: true } : {}),
      ...(isSpaceKind(c.kind) && typeof c.home === "string" && HOME_NAME.test(c.home) ? { kind: c.kind, home: c.home } : {}),
    });
  }
  const seats: Record<string, OrgSeat> = {};
  const rawSeats = raw.seats && typeof raw.seats === "object" ? (raw.seats as Record<string, unknown>) : {};
  for (const [seat, item] of Object.entries(rawSeats)) {
    if (!SEAT.test(seat) || !item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const kept: OrgSeat = {};
    if (typeof s.company === "string" && companies.some((c) => c.id === s.company)) kept.company = s.company;
    if (s.retired === true) kept.retired = true;
    if (kept.company || kept.retired) seats[seat] = kept;
  }
  const revision = typeof raw.revision === "number" && Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  return { revision, companies, seats };
}

/** A Space's kind and home from a request body: both are required together. */
function spaceFields(c: Record<string, unknown>, bad: (why: string) => OrgError): { kind: SpaceKind; home: string } {
  if (!isSpaceKind(c.kind)) throw bad("kind must be client, own, team or family");
  if (typeof c.home !== "string" || !HOME_NAME.test(c.home)) throw bad("home must be the computer's name, as a seat names it");
  return { kind: c.kind, home: c.home };
}

/** Read one change from a request body; throws OrgError(400) naming what is wrong. */
export function parseOrgChange(value: unknown): OrgChange {
  const bad = (why: string) => new OrgError(400, why);
  if (!value || typeof value !== "object") throw bad("change must be an object");
  const c = value as Record<string, unknown>;
  const seat = () => {
    if (typeof c.seat !== "string" || !SEAT.test(c.seat)) throw bad("seat must be <machine>/<project>");
    return c.seat;
  };
  const company = () => {
    if (typeof c.company !== "string" || !COMPANY_ID.test(c.company)) throw bad("company must be a company id");
    return c.company;
  };
  const name = () => {
    const kept = cleanCompanyName(c.name);
    if (!kept) throw bad("name must not be empty");
    return kept;
  };
  switch (c.op) {
    case "company": {
      if (c.color !== undefined && (typeof c.color !== "string" || !COLOR.test(c.color))) throw bad("color must be #rrggbb");
      const space = c.kind !== undefined || c.home !== undefined ? spaceFields(c, bad) : null;
      return { op: "company", name: name(), ...(typeof c.color === "string" ? { color: c.color } : {}), ...(space ?? {}) };
    }
    case "space":
      return { op: "space", company: company(), ...spaceFields(c, bad) };
    case "rename":
      return { op: "rename", company: company(), name: name() };
    case "remove":
      return { op: "remove", company: company() };
    case "sensitive":
      if (typeof c.on !== "boolean") throw bad("on must be true or false");
      return { op: "sensitive", company: company(), on: c.on };
    case "assign":
      return { op: "assign", seat: seat(), company: c.company === null ? null : company() };
    case "retire":
      return { op: "retire", seat: seat() };
    case "bring-back":
      return { op: "bring-back", seat: seat() };
    default:
      throw bad("op must be company, space, rename, sensitive, remove, assign, retire or bring-back");
  }
}

function withSeat(seats: Record<string, OrgSeat>, seat: string, next: OrgSeat): Record<string, OrgSeat> {
  const out = { ...seats };
  if (next.company || next.retired) out[seat] = next;
  else delete out[seat];
  return out;
}

/**
 * The org after one change, at the next revision. Throws OrgError(404) for a
 * company that does not exist and 409 for a name already taken. A new company
 * takes `companyIdFor` its name; `created` says which id it got.
 */
export function applyOrg(org: Org, change: OrgChange): { org: Org; created?: string } {
  const find = (id: string) => {
    const company = org.companies.find((c) => c.id === id);
    if (!company) throw new OrgError(404, `no company ${id}`);
    return company;
  };
  const named = (name: string, except?: string) => {
    if (org.companies.some((c) => c.id !== except && c.name.toLowerCase() === name.toLowerCase())) throw new OrgError(409, `there is already a company called ${name}`);
  };
  const next = (patch: Partial<Org>): Org => ({ ...org, ...patch, revision: org.revision + 1 });
  switch (change.op) {
    case "company": {
      named(change.name);
      if (org.companies.length >= MAX_COMPANIES) throw new OrgError(409, `at most ${MAX_COMPANIES} companies`);
      const id = companyIdFor(change.name, org.companies.map((c) => c.id));
      const used = new Set(org.companies.map((c) => c.color));
      const color = change.color ?? COMPANY_COLORS.find((c) => !used.has(c)) ?? COMPANY_COLORS[org.companies.length % COMPANY_COLORS.length]!;
      const space = change.kind && change.home ? { kind: change.kind, home: change.home } : {};
      return { org: next({ companies: [...org.companies, { id, name: change.name, color, ...space }] }), created: id };
    }
    case "space": {
      const company = find(change.company);
      if (company.home && company.home !== change.home) throw new OrgError(409, `${company.name} stays on ${company.home}: a Space is pinned to one computer`);
      return { org: next({ companies: org.companies.map((c) => (c.id === change.company ? { ...c, kind: change.kind, home: change.home } : c)) }) };
    }
    case "rename":
      find(change.company);
      named(change.name, change.company);
      return { org: next({ companies: org.companies.map((c) => (c.id === change.company ? { ...c, name: change.name } : c)) }) };
    case "sensitive":
      find(change.company);
      return {
        org: next({
          companies: org.companies.map((c) => {
            if (c.id !== change.company) return c;
            const { sensitive: _, ...rest } = c;
            return change.on ? { ...rest, sensitive: true } : rest;
          }),
        }),
      };
    case "remove": {
      find(change.company);
      // Its Foremen go back to New arrivals; a retired one stays retired.
      const seats: Record<string, OrgSeat> = {};
      for (const [seat, s] of Object.entries(org.seats)) {
        const kept = s.company === change.company ? { ...(s.retired ? { retired: true } : {}) } : s;
        if (kept.company || kept.retired) seats[seat] = kept;
      }
      return { org: next({ companies: org.companies.filter((c) => c.id !== change.company), seats }) };
    }
    case "assign":
      // A move also brings a retired Foreman back.
      if (change.company !== null) find(change.company);
      return { org: next({ seats: withSeat(org.seats, change.seat, change.company ? { company: change.company } : {}) }) };
    case "retire": {
      const seat = org.seats[change.seat] ?? {};
      return { org: next({ seats: withSeat(org.seats, change.seat, { ...seat, retired: true }) }) };
    }
    case "bring-back": {
      const { retired: _retired, ...seat } = org.seats[change.seat] ?? {};
      return { org: next({ seats: withSeat(org.seats, change.seat, seat) }) };
    }
  }
}

/** The change in words, for the Lead's reply, the log and toasts. `names` turns a seat into its Foreman's name. */
export function describeOrgChange(org: Org, change: OrgChange, names: (seat: string) => string = (seat) => seat): string {
  const companyName = (id: string | null) => (id === null ? "New arrivals" : (org.companies.find((c) => c.id === id)?.name ?? id));
  switch (change.op) {
    case "company":
      return change.kind ? `Opened ${change.name} as a ${SPACE_KIND_INFO[change.kind].label.toLowerCase()} Space on ${change.home}` : `Opened ${change.name}`;
    case "space":
      return `${companyName(change.company)} is now a ${SPACE_KIND_INFO[change.kind].label.toLowerCase()} Space on ${change.home}`;
    case "rename":
      return `Renamed ${companyName(change.company)} to ${change.name}`;
    case "sensitive":
      return change.on ? `${companyName(change.company)} is sensitive: its memory stays on its own computer` : `${companyName(change.company)} is no longer sensitive`;
    case "remove":
      return `Closed ${companyName(change.company)}; its Foremen went to New arrivals`;
    case "assign":
      return `${names(change.seat)} now works for ${companyName(change.company)}`;
    case "retire":
      return `${names(change.seat)} moved to the Outskirts`;
    case "bring-back":
      return `${names(change.seat)} is back from the Outskirts`;
  }
}

/** The org in plain lines for the Lead (`org_read`): each company and who works there, then New arrivals' and the Outskirts' seats it knows. */
export function orgText(org: Org): string {
  const lines = [`Companies (revision ${org.revision}):`];
  if (!org.companies.length) lines.push("- none yet: every Foreman is in New arrivals");
  for (const company of org.companies) {
    const seats = Object.entries(org.seats).filter(([, s]) => s.company === company.id && !s.retired).map(([seat]) => seat);
    const space = company.kind ? ` [${SPACE_KIND_INFO[company.kind].label} Space, runs on ${company.home}]` : "";
    lines.push(`- ${company.id}: ${company.name}${space}${company.sensitive ? " (sensitive: its memory stays on this computer)" : ""} · ${seats.length ? seats.join(", ") : "nobody yet"}`);
  }
  const retired = Object.entries(org.seats).filter(([, s]) => s.retired).map(([seat]) => seat);
  lines.push(`Outskirts (retired): ${retired.length ? retired.join(", ") : "none"}.`);
  lines.push("Any other project's Foreman is in New arrivals. Seats are <machine>/<project id> as the status tool names them.");
  return lines.join("\n");
}

/** Where a project's Foreman sits, in Cobra's words: its company's name, "retired (Outskirts)", or null in New arrivals. */
export function seatPlace(org: Org, machine: string, project: string): string | null {
  const seat = org.seats[seatKey(machine, project)];
  if (seat?.retired) return "retired (Outskirts)";
  return org.companies.find((company) => company.id === seat?.company)?.name ?? null;
}

/**
 * The line a brief from Cobra starts with when its Foreman works for a
 * company: the company and the company's other Foremen (by project, with
 * their computer when it is another), whom the Foreman never reaches itself.
 * Null in New arrivals or the Outskirts.
 */
export function companyNote(org: Org, machine: string, project: string): string | null {
  const key = seatKey(machine, project);
  const seat = org.seats[key];
  if (!seat?.company || seat.retired) return null;
  const company = org.companies.find((candidate) => candidate.id === seat.company);
  if (!company) return null;
  const others = Object.entries(org.seats)
    .filter(([other, s]) => other !== key && s.company === company.id && !s.retired)
    .map(([other]) => seatParts(other))
    .filter((parts): parts is { machine: string; project: string } => parts !== null)
    .map((parts) => (parts.machine === machine ? parts.project : `${parts.project} on ${parts.machine}`));
  const alongside = others.length ? `, alongside the Foremen of ${others.join(", ")}` : "";
  return `[Company: your project works for ${company.name}${alongside}. Their work reaches you only through Cobra: say in your report what of theirs this touches.]`;
}
