// A Space's folder on its home computer: one
// folder per Space under ~/Spaces, with `space.json` (what it is), `profile.json`
// and `profile.md` (what the intake learned, the second for a Foreman to read)
// and, later, a folder for each Foreman seat inside it. The org says which
// company is a Space and which computer runs it (contracts org.ts); this file
// is what that computer keeps. A Space is pinned to one computer: it opens its
// folder only there.
//
// Nothing here starts a Foreman, writes a store or touches a project: the
// intake (wave 4) and the shared store (wave 3) build on these paths.
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { COMPANY_ID_PATTERN } from "../../../../packages/contracts/src/org.ts";
import { baselineSeats, HOME_NAME, isSpaceKind, parseProfile, profileText, SEAT_ROLES, type SeatRole, type SpaceKind, type SpaceProfile } from "../../../../packages/contracts/src/spaces.ts";

import { awayFromLive } from "./paths.ts";
import { writePrivateFile } from "./private.ts";

export const SPACES_DIR = process.env.COBRA_SPACES_DIR ?? awayFromLive(join(homedir(), "Spaces"));

export class SpaceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** What a Space keeps about itself in its folder. */
export type SpaceRecord = {
  version: 1;
  id: string;
  name: string;
  kind: SpaceKind;
  /** The computer that runs it, as a seat names it. */
  home: string;
  sensitive: boolean;
  /** When it was first opened here, ISO. */
  opened: string;
  /**
   * How its Foremen work (JK-PLAN-WF-001 part B, spaceForemen.ts): "on-call"
   * lets Cobra start a Worker herself for a light task. Absent is
   * "standing", the system before it.
   */
  foremen?: "on-call";
};

export type OpenInput = { id: string; name: string; kind: SpaceKind; home: string; sensitive: boolean };

const SEAT_DIRECTORY = /^[a-z0-9-]{1,32}$/;
const PROJECT_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** A Space's folder; throws for an id that is not a company id, so nothing leaves the root. */
export function spaceDir(id: string, root = SPACES_DIR): string {
  if (!COMPANY_ID_PATTERN.test(id)) throw new SpaceError(400, "a Space id is lower-case letters, digits and dashes");
  return join(root, id);
}

/** Where one Foreman seat's project folder goes inside its Space (made when the Foreman is). */
export function seatDir(id: string, directory: string, root = SPACES_DIR): string {
  if (!SEAT_DIRECTORY.test(directory)) throw new SpaceError(400, "a seat folder is lower-case letters, digits and dashes");
  return join(spaceDir(id, root), directory);
}

/** The baseline seats of a Space's kind with the folder each gets, in the order the intake starts them. */
export function baselineFolders(id: string, kind: SpaceKind, root = SPACES_DIR): { role: string; name: string; path: string }[] {
  return baselineSeats(kind).map((seat) => ({ role: seat.role, name: seat.name, path: seatDir(id, seat.directory, root) }));
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Read a space.json leniently; null unless it is whole. */
function parseRecord(value: unknown): SpaceRecord | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || !COMPANY_ID_PATTERN.test(r.id)) return null;
  if (typeof r.name !== "string" || !r.name || !isSpaceKind(r.kind) || typeof r.home !== "string" || !HOME_NAME.test(r.home)) return null;
  const opened = typeof r.opened === "string" && !Number.isNaN(Date.parse(r.opened)) ? r.opened : new Date(0).toISOString();
  return { version: 1, id: r.id, name: r.name, kind: r.kind, home: r.home, sensitive: r.sensitive === true, opened, ...(r.foremen === "on-call" ? { foremen: "on-call" as const } : {}) };
}

export function readSpace(id: string, root = SPACES_DIR): SpaceRecord | null {
  return parseRecord(readJson(join(spaceDir(id, root), "space.json")));
}

/** Every Space opened on this computer, by id. */
export function listSpaces(root = SPACES_DIR): SpaceRecord[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: SpaceRecord[] = [];
  for (const name of names.sort()) {
    if (!COMPANY_ID_PATTERN.test(name)) continue;
    const record = readSpace(name, root);
    if (record) out.push(record);
  }
  return out;
}

/**
 * Open a Space's folder here, or bring it up to date: it creates the folder
 * and `space.json`, and keeps the first `opened`. `machine` is this computer;
 * a Space pinned elsewhere (409), or one already here under another home, is
 * refused rather than moved.
 */
export function openSpace(input: OpenInput, machine: string, root = SPACES_DIR, now: () => Date = () => new Date()): SpaceRecord {
  const dir = spaceDir(input.id, root);
  if (!isSpaceKind(input.kind)) throw new SpaceError(400, "kind must be client, own, team or family");
  if (!HOME_NAME.test(input.home)) throw new SpaceError(400, "home must be a computer's name");
  if (input.home !== machine) throw new SpaceError(409, `${input.name} runs on ${input.home}, not on ${machine}`);
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name) throw new SpaceError(400, "a Space needs a name");
  const known = readSpace(input.id, root);
  if (known && known.home !== input.home) throw new SpaceError(409, `${known.name} is pinned to ${known.home}`);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  // Opening it again keeps how its Foremen work: only `cobra-agent space set` and the phone change that.
  const record: SpaceRecord = { version: 1, id: input.id, name, kind: input.kind, home: input.home, sensitive: input.sensitive, opened: known?.opened ?? now().toISOString(), ...(known?.foremen ? { foremen: known.foremen } : {}) };
  writePrivateFile(join(dir, "space.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function readProfile(id: string, root = SPACES_DIR): SpaceProfile | null {
  return parseProfile(readJson(join(spaceDir(id, root), "profile.json")));
}

/** What a Foreman reads: profile.md, or null when the intake has not written one. */
export function readProfileText(id: string, root = SPACES_DIR): string | null {
  try {
    return readFileSync(join(spaceDir(id, root), "profile.md"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Keep what the intake learned: `profile.json` for the agent and `profile.md`
 * for a Foreman, in an opened Space. A profile without a purpose and people is
 * refused (400); a Space not opened here is 404. Returns what was kept.
 */
export function writeProfile(id: string, raw: unknown, root = SPACES_DIR, now: () => Date = () => new Date()): { profile: SpaceProfile; text: string } {
  const record = readSpace(id, root);
  if (!record) throw new SpaceError(404, `no Space ${id} is open on this computer`);
  const profile = parseProfile({ ...(raw && typeof raw === "object" ? raw : {}), updated: now().toISOString() });
  if (!profile) throw new SpaceError(400, "a profile needs a purpose and who it serves");
  const dir = spaceDir(id, root);
  const text = profileText(record.name, record.kind, profile);
  writePrivateFile(join(dir, "profile.json"), `${JSON.stringify(profile, null, 2)}\n`);
  writePrivateFile(join(dir, "profile.md"), text);
  return { profile, text };
}

/** Whether a folder is an opened Space's here, for callers that only need the yes. */
export function isSpaceFolder(path: string): boolean {
  try {
    return statSync(join(path, "space.json")).isFile();
  } catch {
    return false;
  }
}

// --- seats and the shared store ----------------------------------------------

type Seats = Record<string, SeatRole>;

function readSeats(id: string, root: string): Seats {
  const value = readJson(join(spaceDir(id, root), "seats.json"));
  const out: Seats = {};
  if (!value || typeof value !== "object") return out;
  for (const [project, role] of Object.entries(value as Record<string, unknown>)) {
    if ((SEAT_ROLES as readonly unknown[]).includes(role)) out[project] = role as SeatRole;
  }
  return out;
}

/**
 * Seat a project in a Space: its Foreman writes the Space's store as `role`.
 * Re-seating the same project in its own Space under a new role changes the
 * role; a project already seated in another Space is refused (409), since a
 * project belongs to one company.
 */
export function registerSeat(id: string, project: string, role: SeatRole, root = SPACES_DIR): void {
  if (!readSpace(id, root)) throw new SpaceError(404, `no Space ${id} is open on this computer`);
  if (!PROJECT_ID.test(project)) throw new SpaceError(400, "a project id is letters, digits, dots, dashes and underscores");
  const elsewhere = seatOf(project, root);
  if (elsewhere && elsewhere.space !== id) throw new SpaceError(409, `${project} is already a seat of ${elsewhere.space}`);
  const seats = readSeats(id, root);
  seats[project] = role;
  writePrivateFile(join(spaceDir(id, root), "seats.json"), `${JSON.stringify(seats, null, 2)}\n`);
}

/** The Space a project is seated in on this computer, with the role its Foreman writes as; null for any other project. */
export function seatOf(project: string, root = SPACES_DIR): { space: string; role: SeatRole } | null {
  for (const space of listSpaces(root)) {
    const role = readSeats(space.id, root)[project];
    if (role) return { space: space.id, role };
  }
  return null;
}

/** The project seated in a Space under a role (the first by name), or null when none is. */
export function seatFor(id: string, role: SeatRole, root = SPACES_DIR): string | null {
  return Object.entries(readSeats(id, root)).filter(([, r]) => r === role).map(([project]) => project).sort()[0] ?? null;
}

/** The kind of the Space a project is seated in; null for a project in no Space. */
export function spaceKindOf(project: string, root = SPACES_DIR): SpaceKind | null {
  for (const space of listSpaces(root)) if (readSeats(space.id, root)[project]) return space.kind;
  return null;
}

/** The store key a seated project opens instead of its own, `space-<id>`; null for a project not seated. */
export function sharedStoreKey(project: string, root = SPACES_DIR): string | null {
  const seat = seatOf(project, root);
  return seat ? `space-${seat.space}` : null;
}
