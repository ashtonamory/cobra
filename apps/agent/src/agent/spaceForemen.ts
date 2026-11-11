// How a Space's Foremen work (JK-PLAN-WF-001 part B; decisions D2 and D4):
// `standing`, the system of today, or `on-call`, where Cobra starts a Worker
// herself for a light task (directWorkers.ts) and a Foreman wakes only for
// deep work. The setting lives in the Space's own space.json on the computer
// that runs it (spaces.ts), next to everything else that Space keeps there;
// absent is standing, so no Space changes until someone sets it.
//
//   cobra-agent space get <space>                       its name and setting
//   cobra-agent space set <space> foremen on-call|standing
//   GET  /spaces/<id>/foremen                            {space, name, foremen}
//   POST /spaces/<id>/foremen {foremen}                  the same, after the change
//
// The routes are the person's: the desk's key. The Lead and the Foremen
// never change it.
//
// A project's mode is its Space's. A project with no trade (a code project)
// is always standing: a merge always needs its Foreman (O4).
import { SpaceError, listSpaces, readSpace, seatOf, spaceDir, SPACES_DIR, type SpaceRecord } from "./spaces.ts";
import { writePrivateFile } from "./private.ts";
import { join } from "node:path";

export const FOREMEN_MODES = ["standing", "on-call"] as const;
export type ForemenMode = (typeof FOREMEN_MODES)[number];

export function isForemenMode(value: unknown): value is ForemenMode {
  return (FOREMEN_MODES as readonly unknown[]).includes(value);
}

/** A Space's setting, or null when no Space `id` is open on this computer. */
export function spaceForemen(id: string, root = SPACES_DIR): ForemenMode | null {
  let record: SpaceRecord | null;
  try {
    record = readSpace(id, root);
  } catch {
    return null;
  }
  return record ? (record.foremen ?? "standing") : null;
}

/** Sets a Space's setting in its space.json; 404 for a Space not open here. Returns the record as kept. */
export function setSpaceForemen(id: string, mode: ForemenMode, root = SPACES_DIR): SpaceRecord {
  if (!isForemenMode(mode)) throw new SpaceError(400, "foremen is standing or on-call");
  const record = readSpace(id, root);
  if (!record) throw new SpaceError(404, `no Space ${id} is open on this computer`);
  const { foremen: _old, ...rest } = record;
  const next: SpaceRecord = mode === "on-call" ? { ...rest, foremen: "on-call" } : rest;
  writePrivateFile(join(spaceDir(id, root), "space.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** The Spaces on this computer set to on-call. */
export function onCallSpaces(root = SPACES_DIR): SpaceRecord[] {
  return listSpaces(root).filter((space) => space.foremen === "on-call");
}

/** A project's mode, its Space, and why, in words for a refusal. */
export type ProjectMode = { mode: ForemenMode; space: string | null; why: string };

export type ProjectModeDeps = {
  /** The Space (the org's company) the project sits in on this computer, or null. */
  spaceOf: (project: string) => string | null;
  /** That Space's setting, or null when it is not open here. */
  mode: (space: string) => ForemenMode | null;
};

/** A project's mode: its Space's, except a code project (no trade), which is always standing. */
export function projectForemen(project: { id: string; foremanTemplate?: string }, deps: ProjectModeDeps): ProjectMode {
  if (!project.foremanTemplate) return { mode: "standing", space: null, why: `${project.id} is a code project, and a merge always needs its Foreman` };
  let space: string | null = null;
  try {
    space = deps.spaceOf(project.id);
  } catch {
    space = null;
  }
  if (!space) return { mode: "standing", space: null, why: `${project.id} is in no Space here` };
  const mode = deps.mode(space);
  if (mode === null) return { mode: "standing", space, why: `its Space ${space} is not open on this computer` };
  return { mode, space, why: mode === "standing" ? `its Space ${space} has standing Foremen` : `its Space ${space} is on-call` };
}

/** The live lookups: the org's seat (as wakes.ts reads it), else the Space store's seat; the setting from space.json. */
export function liveProjectModeDeps(spaceOfOrg: (project: string) => string | null, root = SPACES_DIR): ProjectModeDeps {
  return {
    spaceOf: (project) => spaceOfOrg(project) ?? seatOf(project, root)?.space ?? null,
    mode: (space) => spaceForemen(space, root),
  };
}

// --- the person's route --------------------------------------------------------

export const SPACE_FOREMEN_ROUTE = /^\/spaces\/([^/]{1,64})\/foremen$/;
const PERSON_KINDS: ReadonlySet<string> = new Set(["desk"]);

type Reply = { status: number; body: unknown };

/** GET or POST /spaces/<id>/foremen, for the person's phone or desk. */
export function handleSpaceForemen(id: string, method: string | undefined, bodyText: string, caller: { kind: string; name?: string }, log: (line: string) => void, root = SPACES_DIR): Reply {
  if (!PERSON_KINDS.has(caller.kind)) return { status: 403, body: { error: "only the desk app you linked reads or sets how a Space's Foremen work" } };
  try {
    if (method === "POST") {
      let raw: unknown;
      try {
        raw = JSON.parse(bodyText);
      } catch {
        return { status: 400, body: { error: "the body is JSON: {foremen: \"standing\" | \"on-call\"}" } };
      }
      const mode = (raw as { foremen?: unknown } | null)?.foremen;
      if (!isForemenMode(mode)) return { status: 400, body: { error: "foremen is standing or on-call" } };
      const record = setSpaceForemen(id, mode, root);
      log(`Space ${id}: Foremen ${mode}, set by ${caller.kind} ${caller.name ?? ""}`.trim());
      return { status: 200, body: { space: record.id, name: record.name, foremen: record.foremen ?? "standing" } };
    }
    if (method !== "GET") return { status: 405, body: { error: "GET or POST" } };
    const record = readSpace(id, root);
    if (!record) return { status: 404, body: { error: `no Space ${id} is open on this computer` } };
    return { status: 200, body: { space: record.id, name: record.name, foremen: record.foremen ?? "standing" } };
  } catch (caught) {
    if (caught instanceof SpaceError) return { status: caught.status, body: { error: caught.message } };
    throw caught;
  }
}

// --- the command ---------------------------------------------------------------

export const SPACE_USAGE = "cobra-agent space get <space> | space set <space> foremen on-call|standing";

/** `cobra-agent space …`: returns the line to print, or throws SpaceError with what is wrong. */
export function spaceCommand(args: readonly string[], root = SPACES_DIR): string {
  const [verb, id, key, value] = args;
  if (verb === "get" && id && args.length === 2) {
    const record = readSpace(id, root);
    if (!record) throw new SpaceError(404, `no Space ${id} is open on this computer`);
    return `${record.id} (${record.name}): foremen ${record.foremen ?? "standing"}`;
  }
  if (verb === "set" && id && key === "foremen" && args.length === 4) {
    if (!isForemenMode(value)) throw new SpaceError(400, "foremen is on-call or standing");
    const record = setSpaceForemen(id, value, root);
    const after = value === "on-call" ? "Cobra may start a Worker herself for a light task there; start a New conversation for her to read it" : "every task goes through its Foremen, as before";
    return `${record.id} (${record.name}): foremen ${value}. ${after}.`;
  }
  throw new SpaceError(400, `usage: ${SPACE_USAGE}`);
}
