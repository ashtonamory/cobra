// The person's routes for a project's records and the account's Google
// connection: the phone's Settings → Integrations → Google and a project's
// Records section with Undo and Open sheet, and the desk's same.
//
//   GET  /integrations/google            whether THIS computer's agent can use the account's Google (contracts GoogleIntegration)
//   GET  /db/journal?project=&limit=     the project's journal, newest first, masked (JournalReply)
//   POST /db/undo  {project, journal}    undoes one entry as "person"; answers that entry after (JournalEntry)
//   GET  /db/mirror?project=             the project's sheet and how its last push went (MirrorStatus)
//   GET  /views?project=                 the trade's dashboards without their SQL, and the form of each button's write (ViewList)
//   GET  /view?project=&view=&id=&q=&range=&key=&month=&filter=   one dashboard, run, sensitive values masked (ViewResult); a chart's range and drilled-from key
//   POST /view/write  {project, mutation, args}   a button's change, one of the trade's named writes a view names, journaled as "person"
//   POST /view/reveal {project, view, field, id?, block?, row?}   one hidden value, for the Show button (the phone asks Face ID first)
//
// A phone's or a desk's key only: a Lead or Foreman key reaches /orch/* and
// nothing else (auth.ts), and is refused here too, so an orchestrator never
// undoes on the person's behalf. The GETs need `read`, the POST `act`
// (auth.ts scopeFor, by method).
//
// The database is reached only through dbRoutes.ts handleDb, as a Foreman's
// db_ tools reach it: the same masking, the same refusals in words (400),
// the mirror scheduled after the undo. A project whose trade keeps no
// database answers an empty journal and an empty mirror status, so the app
// draws "no records yet" and not an error. After an undo the project's
// Foreman hears it as a [cobra] line (finishes.ts tell), as it hears what
// became of an action after Allow.
//
// Google comes through the person's own OAuth client, signed in on this
// computer (googleLocal.ts, googleAuth.ts). The route asks for a grant (held in
// memory, so cheap once connected) and answers what it learned, with whether a
// client is saved and the return address Google needs: never a token or the
// client secret.
import type { GoogleIntegration, JournalEntry as JournalView, JournalReply, MirrorStatus as MirrorView, Project } from "@cobra/contracts";

import { BY_PERSON, handleDb, liveDbDeps, type DbDeps, type Reply } from "./dbRoutes.ts";
import { UNDO_DAYS, type JournalEntry, type UndoResult } from "./dbTypes.ts";
import { actionMutations, currencyOf, listViews, revealCell, runView, viewsFor, ViewError } from "./views.ts";
import { openingMonth } from "./viewSpecs/finance.ts";
import { publicBoards, readBoards, writeBoards } from "./spaceBoards.ts";
import { seatOf, spaceKindOf, SPACES_DIR } from "./spaces.ts";
import { GoogleAuthError, googleGrant, googleStatus, type GoogleStatus } from "./googleAuth.ts";
import { googleLocalHere, type GoogleLocalView } from "./googleLocal.ts";
import type { MirrorStatus } from "./mirror.ts";

export const PERSON_ROUTES: ReadonlySet<string> = new Set(["/integrations/google", "/db/journal", "/db/undo", "/db/mirror", "/views", "/view", "/view/write", "/view/reveal", "/boards", "/board/view", "/boards/remove"]);
export const PERSON_POSTS: ReadonlySet<string> = new Set(["/db/undo", "/view/write", "/view/reveal", "/boards/remove"]);

/** The key kinds these routes answer: the person's own phone and desk. */
export const PERSON_KINDS: ReadonlySet<string> = new Set(["phone", "desk"]);

const DAY_MS = 86_400_000;

export type PersonDeps = {
  /** The projects registered on this computer. */
  projects: () => Promise<Project[]>;
  db: DbDeps;
  /** googleAuth.ts googleGrant: a GoogleAuthError when there is none. What it returns is never read here, so the token never reaches a reply. */
  grant: () => Promise<unknown>;
  status: () => GoogleStatus;
  /** The Google client saved here (googleLocal.ts): whether there is one, its ID and the return address. Never the secret. */
  local?: () => GoogleLocalView;
  /** finishes.ts tell: one [cobra] line for an owner (here a project's Foreman). */
  tell: (owner: string, text: string) => void;
  now: () => number;
  log: (line: string) => void;
  /** Where Spaces are opened (spaces.ts), for the boards Cobra made; tests name their own. */
  spacesRoot?: string;
  /** After the person allows a bank import from a dashboard: Cobra's bill finder reads the Space now (billFinder.ts). */
  importAllowed?: (project: string) => void;
};

/** The live deps, with the registry and the Foreman's line from index.ts. */
export function livePersonDeps(projects: () => Promise<Project[]>, tell: (owner: string, text: string) => void, log: (line: string) => void, importAllowed?: (project: string) => void): PersonDeps {
  return { projects, db: liveDbDeps(), grant: googleGrant, status: googleStatus, local: () => googleLocalHere().view(), tell, now: Date.now, log, ...(importAllowed ? { importAllowed } : {}) };
}

const message = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));

function parse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A journal entry as the person reads it: the engine's (args already masked) with whether it was undone and whether Undo may be offered. */
export function personEntry(entry: JournalEntry, now: number): JournalView {
  const age = now - Date.parse(entry.at);
  return {
    id: entry.id,
    at: entry.at,
    by: entry.by,
    mutation: entry.mutation,
    summary: entry.summary,
    args: entry.args,
    changes: entry.changes,
    undone: entry.undoneAt !== null,
    // As db.ts undo refuses: one already undone, an undo itself, or one past UNDO_DAYS. A row changed since is found only by trying.
    undoable: entry.undoneAt === null && entry.undoOf === null && age <= UNDO_DAYS * DAY_MS,
    undoneAt: entry.undoneAt,
    undoOf: entry.undoOf,
  };
}

/** No sheet, nothing pushed, nothing owed. */
export function emptyMirror(project: string): MirrorView {
  return { project, spreadsheetId: null, url: null, createdBy: null, lastSync: null, lastError: null, pending: false };
}

/** The mirror's status with every field the app reads present, so an entry mirror.json kept from before a field existed reads null for it. */
function mirrorView(status: MirrorStatus): MirrorView {
  return { ...emptyMirror(status.project), ...status };
}

async function googleIntegration(deps: PersonDeps): Promise<GoogleIntegration> {
  try {
    await deps.grant();
  } catch (caught) {
    // A GoogleAuthError is what the status below says, in its own words; anything else is the agent's and goes to the log.
    if (!(caught instanceof GoogleAuthError)) deps.log(`google: ${message(caught)}`);
  }
  const status = deps.status();
  return {
    cloudLinked: status.problem !== "no_cloud_link",
    connected: status.connected,
    email: status.email,
    scopes: status.scopes,
    problem: status.problem,
    checkedAt: status.checkedAt,
    ...(deps.local ? deps.local() : {}),
  };
}

/**
 * One person route. `bodyText` is the raw body of a POST ("" for a GET).
 * `caller` is the key that passed auth.ts; anything but a phone's or a
 * desk's is refused 403 before anything is read.
 */
export async function handlePerson(route: string, method: string | undefined, url: URL, bodyText: string, caller: { kind: string }, deps: PersonDeps): Promise<Reply> {
  if (!PERSON_KINDS.has(caller.kind)) {
    return { status: 403, body: { error: "only the desk app you linked reads a project's records or the Google connection here; a Foreman uses its db_ tools" } };
  }
  const post = PERSON_POSTS.has(route);
  if (post && method !== "POST") return { status: 405, body: { error: "POST only" } };
  if (!post && method !== "GET") return { status: 405, body: { error: "GET only" } };

  if (route === "/integrations/google") return { status: 200, body: await googleIntegration(deps) };

  let body: Record<string, unknown> = {};
  if (post) {
    const parsed = parse(bodyText);
    if (!parsed) return { status: 400, body: { error: "invalid JSON body" } };
    body = parsed;
  }
  const raw = post ? body.project : url.searchParams.get("project");
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id) return { status: 400, body: { error: "project is needed: the project's id, as /projects lists it" } };
  const project = (await deps.projects()).find((candidate) => candidate.id === id);
  if (!project) return { status: 404, body: { error: `no project "${id}" on this computer` } };
  const schema = deps.db.schemaFor(project.foremanTemplate);

  if (route === "/db/journal") {
    // A trade without a schema keeps no database: no records yet, not an error.
    if (!schema) return { status: 200, body: { project: project.id, entries: [] } satisfies JournalReply };
    const reply = await handleDb("/orch/db/journal", url, {}, project, deps.db, deps.log);
    if (reply.status !== 200) return reply;
    const now = deps.now();
    const entries = (reply.body as { entries: JournalEntry[] }).entries.map((entry) => personEntry(entry, now));
    return { status: 200, body: { project: project.id, entries, records: true } satisfies JournalReply };
  }

  if (route === "/db/mirror") {
    if (!schema) return { status: 200, body: emptyMirror(project.id) };
    const reply = await handleDb("/orch/db/mirror", url, {}, project, deps.db, deps.log);
    if (reply.status !== 200) return reply;
    return { status: 200, body: mirrorView(reply.body as MirrorStatus) };
  }

  if (route === "/db/undo") {
    // handleDb checks the journal id, answers 409 for a trade with no database and 400 with the engine's words for a refused undo, and schedules the mirror.
    const reply = await handleDb("/orch/db/undo", url, { journal: body.journal }, project, deps.db, deps.log, BY_PERSON);
    if (reply.status !== 200 || !schema) return reply;
    const result = reply.body as UndoResult;
    const entry = undoneEntry(project, deps, schema, result);
    const what = entry ? ` (${entry.mutation})` : "";
    deps.tell(
      project.id,
      `The person undid journal ${result.undid}${what} from the ${caller.kind}: its rows are back as they were before it, and the sheet follows. Read db_journal before you change those rows again.`,
    );
    if (!entry) return { status: 500, body: { error: `journal ${result.undid} was undone (journal ${result.journal}), but its entry could not be read back` } };
    return { status: 200, body: personEntry(entry, deps.now()) };
  }

  if (route === "/views" || route === "/view" || route === "/view/write" || route === "/view/reveal") {
    return await viewRoute(route, url, body, project, schema, deps, caller.kind);
  }

  if (route === "/boards" || route === "/board/view" || route === "/boards/remove") return boardRoute(route, url, body, project, schema, deps, caller.kind);

  return { status: 404, body: { error: `no route ${route}` } };
}

const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * The dashboards (views.ts). A project whose trade ships none answers an
 * empty list, so the app keeps its Records section. A refusal in words is a
 * 400, as the db routes give; a person's write goes through handleDb as
 * "person", so it is journaled, masked and mirrored like any other, and the
 * project's Foreman hears it as a [cobra] line.
 */
async function viewRoute(route: string, url: URL, body: Record<string, unknown>, project: Project, schema: ReturnType<DbDeps["schemaFor"]>, deps: PersonDeps, callerKind: string): Promise<Reply> {
  const trade = project.foremanTemplate ?? "";
  const kind = spaceKindOf(project.id, deps.spacesRoot ?? SPACES_DIR);
  // An older phone (no surface) lists its own boards; the desk asks for its rail with surface=desk, and a phone
  // that draws the rail with surface=phone. Everything else takes the rail's set,
  // which holds the old phone's, so a view or button either app shows answers.
  const surface = url.searchParams.get("surface");
  const desk = route !== "/views" || surface === "desk" || surface === "phone";
  const specs = viewsFor(project.foremanTemplate, kind, desk);
  if (!schema || specs.length === 0) {
    return route === "/views"
      ? { status: 200, body: { project: project.id, trade, views: [], mutations: {}, currency: "USD" } }
      : { status: 404, body: { error: `${project.name} has no dashboards: its trade (${trade || "none"}) ships none` } };
  }
  const named = (key: string): string => trimmed(route === "/view" ? url.searchParams.get(key) : body[key]);
  if (route === "/view/write") {
    const mutation = trimmed(body.mutation);
    if (!mutation) return { status: 400, body: { error: "mutation is needed: the name of a button's change" } };
    if (!actionMutations(specs).has(mutation)) return { status: 400, body: { error: `${mutation} is not something a dashboard of ${project.name} changes` } };
    const reply = await handleDb("/orch/db/write", url, { mutation, args: body.args }, project, deps.db, deps.log, BY_PERSON);
    if (reply.status === 200) {
      const result = reply.body as { journal: number; summary: string };
      deps.tell(project.id, `The person ran ${mutation} from the ${callerKind}'s dashboard (journal ${result.journal}): ${result.summary} Read db_journal before you change those rows again.`);
      if (mutation === "transactions_allow") deps.importAllowed?.(project.id);
    }
    return reply;
  }

  const db = deps.db.open(project.id, schema);
  try {
    if (route === "/views") {
      const list = listViews(project.id, trade, schema, specs, currencyOf(db, schema));
      const opensOn = desk && trade === "money" ? openingMonth(new Date(deps.now()).toISOString().slice(0, 10), kind === "family" ? "family" : "business") : undefined;
      return { status: 200, body: opensOn && opensOn !== new Date(deps.now()).toISOString().slice(0, 7) ? { ...list, opensOn } : list };
    }

    const spec = specs.find((candidate) => candidate.id === named("view"));
    if (!spec) return { status: 404, body: { error: `no view "${named("view")}" in ${project.name}; /views lists them` } };
    const input = { id: named("id") || undefined, q: named("q") || undefined, range: named("range") || undefined, key: named("key") || undefined, month: named("month") || undefined, filter: named("filter") || undefined };
    const now = new Date(deps.now());

    if (route === "/view") return { status: 200, body: runView(db, spec, input, now) };

    // /view/reveal
    const field = trimmed(body.field);
    if (!field) return { status: 400, body: { error: "field is needed: the hidden column's name" } };
    const value = revealCell(db, spec, { view: spec.id, field, id: input.id, ...(typeof body.block === "number" ? { block: body.block } : {}), ...(trimmed(body.row) ? { row: trimmed(body.row) } : {}) }, input, now);
    // The fact of a reveal, never the value.
    deps.log(`view ${project.id}: ${spec.id} ${field} shown to a ${callerKind}`);
    return { status: 200, body: { value } };
  } catch (caught) {
    if (caught instanceof ViewError) return { status: 400, body: { error: caught.message } };
    throw caught;
  } finally {
    db.close();
  }
}

/**
 * The boards Cobra made for the Space a project is seated in (spaceBoards.ts): any seat of the
 * Space reads the same ones, since they read its one store. `/boards` lists them without SQL (none
 * for a project in no Space), `/board/view` runs one widget as `/view` runs a trade's, and
 * `/boards/remove` takes one off the Space; Cobra hears it.
 */
function boardRoute(route: string, url: URL, body: Record<string, unknown>, project: Project, schema: ReturnType<DbDeps["schemaFor"]>, deps: PersonDeps, callerKind: string): Reply {
  const root = deps.spacesRoot ?? SPACES_DIR;
  const seat = schema?.trade === "space" ? seatOf(project.id, root) : null;
  if (route === "/boards" && !seat) return { status: 200, body: { project: project.id, space: null, currency: "USD", boards: [] } };
  if (!seat || !schema) return { status: 404, body: { error: `${project.name} is not in a Space, so it has no boards` } };
  const boards = readBoards(seat.space, root);
  const named = (key: string): string => trimmed(route === "/boards/remove" ? body[key] : url.searchParams.get(key));

  if (route === "/boards/remove") {
    const board = boards.find((b) => b.id === named("board"));
    if (!board) return { status: 404, body: { error: `no board "${named("board")}" in this Space` } };
    writeBoards(seat.space, root, boards.filter((b) => b.id !== board.id));
    deps.tell("lead", `The person removed the ${board.title} board (${board.id}) from the Space ${seat.space} on the ${callerKind}. Make it again only if they ask.`);
    return { status: 200, body: { removed: board.id } };
  }

  const db = deps.db.open(project.id, schema);
  try {
    if (route === "/boards") return { status: 200, body: { project: project.id, space: seat.space, currency: currencyOf(db, schema), boards: publicBoards(boards) } };
    const board = boards.find((b) => b.id === named("board"));
    if (!board) return { status: 404, body: { error: `no board "${named("board")}" in this Space; /boards lists them` } };
    const spec = board.views.find((v) => v.id === named("view"));
    if (!spec) return { status: 404, body: { error: `no widget "${named("view")}" on the ${board.title} board` } };
    return { status: 200, body: runView(db, spec, { range: named("range") || undefined, key: named("key") || undefined, month: named("month") || undefined }, new Date(deps.now())) };
  } catch (caught) {
    if (caught instanceof ViewError) return { status: 400, body: { error: caught.message } };
    // A board that no longer runs (a column renamed under it) says so, rather than failing the screen.
    return { status: 400, body: { error: `this widget no longer runs: ${message(caught)}` } };
  } finally {
    db.close();
  }
}

/**
 * The entry an undo just reversed, read back through the same opener
 * handleDb uses (DbDeps.open). The journal is read newest first down to it:
 * its ids only grow and nothing is deleted from it, so the page from the
 * undo's own entry to the one it reversed holds it, with a little room for a
 * write that came in between.
 */
function undoneEntry(project: Project, deps: PersonDeps, schema: NonNullable<ReturnType<DbDeps["schemaFor"]>>, result: UndoResult): JournalEntry | null {
  const db = deps.db.open(project.id, schema);
  try {
    return db.journal(result.journal - result.undid + 1 + 20).find((entry) => entry.id === result.undid) ?? null;
  } catch (caught) {
    deps.log(`db ${project.id}: could not read journal ${result.undid} back after its undo: ${message(caught)}`);
    return null;
  } finally {
    db.close();
  }
}
