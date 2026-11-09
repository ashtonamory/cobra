// Forms on websites Cobra did not build (a site the person made by hand, an
// older one): their sign-ups into a Space's People, read from the person's own
// D1 database with the Cloudflare connection cloudflare.ts keeps. A site Cobra
// built pulls its own form already (sitePull.ts); this is for every other one.
//
// The Lead finds the database with form_sources (the account's databases, then
// one database's tables and columns: names and counts, never a row) and asks
// with form_link: which table, which column holds the email (and the name,
// phone, message), which columns go to the Space's own fields, and which column
// says a row is new or changed (the cursor). The agent checks every column
// against the table and counts its rows, then one card of kind `form`; Allow
// keeps the link in `form-links/<id>.json` and adds any field the Space lacks.
//
// The pull runs with the website one, every 5 minutes. Cobra only reads: every
// query it sends is a SELECT or a PRAGMA, never a write, since the database is
// the person's and its site may rely on every row. So it keeps its place
// itself: rows in cursor order, then key order, after the last one it took
// (`form-links/<id>.pull.json`). A row whose key it has seen before (a person
// who signed up again) updates their fields and says nothing; a new one adds
// the person by email (or finds them), a timeline entry, and a notice.
// form_unlink stops the reading; the people stay.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { makeApproval, settle, type StoredApproval } from "./approvals.ts";
import { cloudflareHere } from "./cloudflare.ts";
import { openProjectDb, quote, RefusedError } from "./db.ts";
import { BY_AGENT, type ProjectDb } from "./dbTypes.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { d1Query, listDatabases, type D1Value, type Fetch, type Grant } from "./siteDeploy.ts";
import { noticesFor, oneLine, WAITLIST_SOURCE, WEBSITE_SOURCE, type PullNotice } from "./sitePull.ts";
import { readSpace, SPACES_DIR } from "./spaces.ts";
import { BUILT_IN, FIELD_NAME } from "./trades/people.ts";
import { SPACE_SCHEMA } from "./trades/space.ts";

export const FORM_LINKS_DIR = join(STATE_DIR, "form-links");
export const ORCH_FORM_ROUTES: ReadonlySet<string> = new Set(["/orch/form/sources", "/orch/form/link", "/orch/form/unlink"]);

const BATCH = 100;
/** Batches in one pull, so a long list arrives over a few ticks and never holds up the others. */
const BATCHES = 10;
const FIELDS_MAX = 10;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const KINDS = ["waitlist", "inquiry"] as const;
type FormKind = (typeof KINDS)[number];

/** A form Cobra reads: where it is, which columns mean what, and the Space it fills. */
export type FormLink = {
  version: 1;
  id: string;
  space: string;
  spaceName: string;
  /** The form as the person knows it: "example.com early access". */
  label: string;
  kind: FormKind;
  accountId: string;
  database: { id: string; name: string };
  table: string;
  columns: { email: string; name?: string; phone?: string; message?: string };
  /** One value per row (an id, or the email when one row is kept per person). */
  key: string;
  /** Grows when a row is added or changed (an id, created_at, updated_at). */
  cursor: string;
  /** Columns kept in the Space's own fields, by the field's name. */
  fields: { column: string; field: string }[];
  linkedAt: string;
};

/** Where the pull is: the cursor and key of the last row it took; null before the first. */
export type FormPullState = { after: { cursor: D1Value; key: D1Value } | null };

export type FormDeps = {
  dir: string;
  spacesRoot: string;
  grant: () => Promise<Grant>;
  fetch: Fetch;
  /** The databases Cobra's own sites keep their forms in (sitePull.ts reads those). */
  ownDatabases: () => string[];
  /** The Space's store, for the agent's own writes; null when it is not open here. The caller closes it. */
  store: (space: string) => ProjectDb | null;
  stored: (space: string) => void;
  notify: (notice: PullNotice) => Promise<void>;
  approvals: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };
  card: (approval: StoredApproval) => Promise<void>;
  tell: (owner: string, text: string) => void;
  log: (line: string) => void;
  now: () => number;
};

type Reply = { status: number; body: unknown };

export class FormError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const fail = (message: string, status = 400): never => {
  throw new FormError(status, message);
};
const why = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));

// --- the links on disk ----------------------------------------------------------

export function readLinks(dir: string): FormLink[] {
  if (!existsSync(dir)) return [];
  const links: FormLink[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^[a-z0-9-]+\.json$/.test(name) || name.endsWith(".pull.json")) continue;
    try {
      const link = JSON.parse(readFileSync(join(dir, name), "utf8")) as FormLink;
      if (link?.version === 1 && link.id === name.slice(0, -".json".length)) links.push(link);
    } catch {
      // half-written or not one of ours
    }
  }
  return links.sort((a, b) => a.id.localeCompare(b.id));
}

export function readFormPull(dir: string, id: string): FormPullState {
  try {
    const state = JSON.parse(readFileSync(join(dir, `${id}.pull.json`), "utf8")) as FormPullState;
    if (state && (state.after === null || typeof state.after === "object")) return state;
  } catch {
    // none yet
  }
  return { after: null };
}

const pendingDir = (dir: string) => join(dir, "pending");

function linkId(label: string, taken: readonly string[]): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "form";
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

// --- reading the person's database ----------------------------------------------

type Column = { name: string; type: string; pk: number };

async function tables(deps: Pick<FormDeps, "fetch">, grant: Grant, database: string): Promise<string[]> {
  const rows = await d1Query<{ name: string }>(deps.fetch, grant, database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name");
  return rows.map((row) => row.name).filter((name) => IDENTIFIER.test(name));
}

async function columnsOf(deps: Pick<FormDeps, "fetch">, grant: Grant, database: string, table: string): Promise<Column[]> {
  return d1Query<Column>(deps.fetch, grant, database, `PRAGMA table_info(${quote(table)})`);
}

async function countOf(deps: Pick<FormDeps, "fetch">, grant: Grant, database: string, table: string): Promise<number> {
  const rows = await d1Query<{ n: number }>(deps.fetch, grant, database, `SELECT COUNT(*) AS n FROM ${quote(table)}`);
  return Number(rows[0]?.n ?? 0);
}

async function findDatabase(deps: Pick<FormDeps, "fetch">, grant: Grant, wanted: string): Promise<{ id: string; name: string }> {
  const all = await listDatabases(deps.fetch, grant);
  const found = all.find((db) => db.id === wanted) ?? all.find((db) => db.name === wanted);
  if (!found) fail(`no D1 database ${wanted} in the connected Cloudflare account: form_sources lists them`, 404);
  return found!;
}

/** form_sources: the account's databases, or one database's tables with their columns and row counts. Names only, never a row. */
export async function formSources(deps: FormDeps, raw: unknown): Promise<string> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const grant = await deps.grant();
  const own = new Set(deps.ownDatabases());
  const linked = readLinks(deps.dir);
  if (typeof body.database !== "string" || !body.database.trim()) {
    const all = await listDatabases(deps.fetch, grant);
    if (all.length === 0) return "The connected Cloudflare account has no D1 databases.";
    return [
      `D1 databases in the connected Cloudflare account (${all.length}):`,
      ...all.map((db) => {
        const links = linked.filter((link) => link.database.id === db.id);
        const note = own.has(db.id) ? " (a website Cobra built: its form is read already)" : links.length ? ` (linked: ${links.map((link) => `${link.id} into ${link.spaceName}`).join(", ")})` : "";
        return `- ${db.name} (${db.id})${note}`;
      }),
      "Call form_sources with database to see one's tables and columns.",
    ].join("\n");
  }
  const database = await findDatabase(deps, grant, body.database.trim());
  const lines = [`${database.name} (${database.id}):`];
  for (const table of await tables(deps, grant, database.id)) {
    const columns = await columnsOf(deps, grant, database.id, table);
    const count = await countOf(deps, grant, database.id, table);
    lines.push(`- table ${table}, ${count} ${count === 1 ? "row" : "rows"}: ${columns.map((c) => `${c.name} ${c.type || "any"}${c.pk ? " (primary key)" : ""}`).join(", ")}`);
  }
  if (lines.length === 1) lines.push("No tables.");
  if (own.has(database.id)) lines.push("This is a website Cobra built: its form reaches People already, so it needs no link.");
  return lines.join("\n");
}

// --- form_link: the card ----------------------------------------------------------

type Proposal = Omit<FormLink, "id" | "linkedAt">;

function text(body: Record<string, unknown>, key: string, required: true): string;
function text(body: Record<string, unknown>, key: string, required?: false): string | undefined;
function text(body: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") return required ? fail(`${key} is required`) : undefined;
  if (typeof value !== "string") return fail(`${key} is text`);
  return value.trim();
}

/** The cursor when none is given: updated_at, then created_at, then an integer key. */
function guessCursor(columns: readonly Column[], key: string): string | null {
  for (const name of ["updated_at", "updatedAt", "created_at", "createdAt"]) if (columns.some((c) => c.name === name)) return name;
  const keyColumn = columns.find((c) => c.name === key);
  return keyColumn && /int/i.test(keyColumn.type) ? key : null;
}

/** form_link: checks the table and its columns, counts the rows, and makes one card. 202 with the card's id. */
export async function proposeLink(deps: FormDeps, requestedBy: string, raw: unknown): Promise<Reply> {
  try {
    const body = (raw && typeof raw === "object" ? raw : fail("invalid JSON body")) as Record<string, unknown>;
    const spaceId = text(body, "space", true);
    const space = readSpace(spaceId, deps.spacesRoot);
    if (!space) fail(`no Space ${spaceId} is open on this computer: space is a company id from org_read`, 404);
    const label = text(body, "label", true);
    if (label.length > 60) fail("label is at most 60 characters");
    const kind = (text(body, "kind") ?? "waitlist") as FormKind;
    if (!KINDS.includes(kind)) fail("kind is waitlist (sign-ups) or inquiry (messages)");

    const grant = await deps.grant();
    const database = await findDatabase(deps, grant, text(body, "database", true));
    if (deps.ownDatabases().includes(database.id)) fail(`${database.name} is the form of a website Cobra built: it reaches People already`, 409);
    const table = text(body, "table", true);
    if (!IDENTIFIER.test(table) || !(await tables(deps, grant, database.id)).includes(table)) fail(`${database.name} has no table ${table}: form_sources with database lists them`);
    const columns = await columnsOf(deps, grant, database.id, table);
    const names = new Set(columns.map((c) => c.name));
    const column = (key: string, required = false): string | undefined => {
      const name = required ? text(body, key, true) : text(body, key);
      if (name !== undefined && !names.has(name)) fail(`${key}: ${table} has no column ${name}; its columns are ${[...names].join(", ")}`);
      // The pull puts each name into SQL (quoted as db.ts quotes); a plain identifier keeps it a name whatever the quoting.
      if (name !== undefined && !IDENTIFIER.test(name)) fail(`${key}: ${name} is not a plain column name (letters, digits and _); rename the column or pick another`);
      return name;
    };
    const email = column("email", true)!;
    const picked = { name: column("name"), phone: column("phone"), message: column("message") };
    const key = column("key") ?? email;
    const cursor = column("cursor") ?? guessCursor(columns, key) ?? fail(`say which column grows when a row is added or changed (cursor): ${table} has no updated_at or created_at, and ${key} is not a number`);

    const fieldsRaw = body.fields === undefined ? [] : Array.isArray(body.fields) ? body.fields : fail("fields is a list of {column, field}");
    if (fieldsRaw.length > FIELDS_MAX) fail(`at most ${FIELDS_MAX} fields`);
    const fields = fieldsRaw.map((item, i) => {
      const entry = (item && typeof item === "object" ? item : fail(`fields[${i}] is {column, field}`)) as Record<string, unknown>;
      const from = text(entry, "column", true);
      if (!names.has(from)) fail(`fields[${i}]: ${table} has no column ${from}`);
      if (!IDENTIFIER.test(from)) fail(`fields[${i}]: ${from} is not a plain column name (letters, digits and _); rename the column or pick another`);
      const field = text(entry, "field", true).replace(/\s+/g, " ");
      if (!FIELD_NAME.test(field)) fail(`fields[${i}]: ${field} is not a field name (a letter first, at most 40 characters)`);
      if (BUILT_IN.has(field.toLowerCase())) fail(`fields[${i}]: ${field} is on every person's card already; map it with ${field.toLowerCase()} instead`);
      return { column: from, field };
    });
    if (new Set(fields.map((f) => f.field.toLowerCase())).size !== fields.length) fail("two fields have the same name");

    const count = await countOf(deps, grant, database.id, table);
    const proposal: Proposal = {
      version: 1,
      space: space!.id,
      spaceName: space!.name,
      label,
      kind,
      accountId: grant.accountId,
      database,
      table,
      columns: { email, ...Object.fromEntries(Object.entries(picked).filter(([, v]) => v !== undefined)) },
      key,
      cursor,
      fields,
    };
    const relinking = readLinks(deps.dir).find((link) => link.database.id === database.id && link.table === table);
    const reads = [`email from ${email}`, ...Object.entries(picked).flatMap(([what, from]) => (from ? [`${what} from ${from}`] : [])), ...fields.map((f) => `${f.field} from ${f.column}`)];
    const now = deps.now();
    const approval = makeApproval(
      {
        kind: "form",
        title: `Bring ${label} ${kind === "waitlist" ? "sign-ups" : "messages"} into ${space!.name}?`,
        body: [
          `Cobra reads the ${table} table in your Cloudflare database ${database.name} every 5 minutes and adds each ${kind === "waitlist" ? "sign-up" : "message"} to ${space!.name}'s People, matched by email so nobody is added twice. ${count} ${count === 1 ? "row is" : "rows are"} there now.`,
          `It reads: ${reads.join(", ")}.`,
          ...(fields.length ? [`New fields on each person's card, when ${space!.name} does not have them yet: ${fields.map((f) => f.field).join(", ")}.`] : []),
          relinking ? `This replaces the link ${relinking.id}; nobody is added twice.` : "",
          "Cobra only reads it: nothing in that database is changed or deleted. Ask Cobra to stop any time.",
        ].filter(Boolean).join("\n"),
        requestedBy,
      },
      now,
    );
    const replaced = (a: StoredApproval) => a.kind === "form" && a.state === "pending" && pendingFor(deps.dir, a.id)?.database.id === database.id && pendingFor(deps.dir, a.id)?.table === table;
    deps.approvals.save([...settle(deps.approvals.load(), now).map((a) => (replaced(a) ? { ...a, state: "expired" } : a)), approval]);
    mkdirSync(pendingDir(deps.dir), { recursive: true, mode: 0o700 });
    writePrivateFile(join(pendingDir(deps.dir), `${approval.id}.json`), `${JSON.stringify(proposal)}\n`);
    deps.log(`form link proposal ${approval.id}: ${approval.title}`);
    await deps.card(approval);
    return { status: 202, body: { approval: approval.id, title: approval.title, rows: count, cursor, key } };
  } catch (caught) {
    if (caught instanceof FormError) return { status: caught.status, body: { error: caught.message } };
    throw caught;
  }
}

function pendingFor(dir: string, approvalId: string): Proposal | null {
  try {
    return JSON.parse(readFileSync(join(pendingDir(dir), `${approvalId}.json`), "utf8")) as Proposal;
  } catch {
    return null;
  }
}

/** After the person answered a form card (index.ts): Allow keeps the link and adds the Space's missing fields; the Lead hears either. */
export function settleFormApproval(deps: Pick<FormDeps, "dir" | "store" | "tell" | "now">, approval: StoredApproval): StoredApproval {
  if (approval.kind !== "form") return approval;
  const proposal = pendingFor(deps.dir, approval.id);
  rmSync(join(pendingDir(deps.dir), `${approval.id}.json`), { force: true });
  if (approval.state !== "allowed") {
    if (proposal) deps.tell("lead", `The person said not now to reading ${proposal.label} into ${proposal.spaceName}; leave it unless they ask again.`);
    return approval;
  }
  const finish = (ok: boolean, message: string): StoredApproval => ({ ...approval, state: ok ? "done" : "failed", results: [{ ok, message }] });
  if (!proposal) return finish(false, "the link was not kept; ask Cobra to propose it again");
  const links = readLinks(deps.dir);
  const before = links.find((link) => link.database.id === proposal.database.id && link.table === proposal.table);
  const id = before?.id ?? linkId(proposal.label, links.map((link) => link.id));
  const db = deps.store(proposal.space);
  if (!db) return finish(false, `${proposal.spaceName} is not open on this computer`);
  const notAdded: string[] = [];
  try {
    for (const { field } of proposal.fields) {
      const held = db.queryRaw("SELECT archived_at FROM person_fields WHERE lower(name) = lower(?) LIMIT 1", [field]).rows[0];
      if (held && held.archived_at === null) continue;
      try {
        db.write("field_set", { name: field, kind: "text", describe: `From ${proposal.label}` }, BY_AGENT);
      } catch (caught) {
        if (!(caught instanceof RefusedError)) throw caught;
        notAdded.push(`${field} (${caught.message})`);
      }
    }
  } finally {
    db.close();
  }
  const link: FormLink = { ...proposal, id, linkedAt: new Date(deps.now()).toISOString() };
  mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
  writePrivateFile(join(deps.dir, `${id}.json`), `${JSON.stringify(link, null, 2)}\n`);
  // A changed link keeps its place only when it reads the same rows the same way.
  if (before && (before.key !== link.key || before.cursor !== link.cursor)) rmSync(join(deps.dir, `${id}.pull.json`), { force: true });
  const fieldNote = notAdded.length ? ` These fields could not be added, so they are skipped: ${notAdded.join("; ")}.` : "";
  deps.tell("lead", `The person allowed it: ${proposal.label} is linked to ${proposal.spaceName} as ${id}. Its rows come into People within 5 minutes, and a notice says each new one.${fieldNote} form_unlink with link ${id} stops it.`);
  return finish(true, `Linked ${proposal.label} to ${proposal.spaceName}${fieldNote}`);
}

/** form_unlink: stops reading a form. Its people stay in the Space. */
export function unlinkForm(deps: Pick<FormDeps, "dir" | "log">, raw: unknown): Reply {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = typeof body.link === "string" ? body.link : "";
  const link = readLinks(deps.dir).find((l) => l.id === id);
  if (!link) return { status: 404, body: { error: `no linked form ${id || "(none given)"}: form_sources lists the links` } };
  rmSync(join(deps.dir, `${id}.json`), { force: true });
  rmSync(join(deps.dir, `${id}.pull.json`), { force: true });
  deps.log(`form link ${id} removed`);
  return { status: 200, body: { removed: id, text: `Cobra no longer reads ${link.label}. The people it brought in stay in ${link.spaceName}.` } };
}

// --- the pull ---------------------------------------------------------------------

/** The one query a pull sends: the next rows in cursor, then key, order. Read-only by construction. */
export function pullSql(link: FormLink): string {
  const picks = [
    `${quote(link.key)} AS _key`,
    `${quote(link.cursor)} AS _cursor`,
    `${quote(link.columns.email)} AS _email`,
    ...(["name", "phone", "message"] as const).flatMap((what) => (link.columns[what] ? [`${quote(link.columns[what]!)} AS _${what}`] : [])),
    ...link.fields.map((f, i) => `${quote(f.column)} AS _f${i}`),
  ];
  const c = quote(link.cursor);
  const k = quote(link.key);
  return `SELECT ${picks.join(", ")} FROM ${quote(link.table)} WHERE ?1 IS NULL OR ${c} > ?1 OR (${c} = ?1 AND ${k} > ?2) ORDER BY ${c}, ${k} LIMIT ${BATCH}`;
}

type Row = Record<string, D1Value>;
const value = (row: Row, key: string): string => (row[key] === null || row[key] === undefined ? "" : String(row[key]).trim());

/** One row into the Space's store, as the agent. `added` for a new person or sign-up, `updated` for a row seen before, `skipped` with no email. */
export function storeLinkedRow(db: ProjectDb, link: FormLink, row: Row): "added" | "updated" | "skipped" {
  const email = value(row, "_email");
  if (!email.includes("@")) return "skipped";
  const ref = `form:${link.id}:${value(row, "_key")}`;
  const seen = db.queryRaw("SELECT person_id FROM interactions WHERE ref = ? AND source = ? LIMIT 1", [ref, WEBSITE_SOURCE]).rows[0];
  let person = typeof seen?.person_id === "number" ? seen.person_id : null;
  const fresh = person === null;
  if (person === null) {
    const found = db.queryRaw("SELECT id FROM people WHERE archived_at IS NULL AND lower(email) = lower(?) ORDER BY id LIMIT 1", [email]).rows[0];
    person = typeof found?.id === "number" ? found.id : null;
  }
  if (person === null) {
    const phone = value(row, "_phone");
    const added = db.write("person_add", { name: value(row, "_name") || email, email, ...(phone ? { phone } : {}), source: link.kind === "waitlist" ? WAITLIST_SOURCE : WEBSITE_SOURCE }, BY_AGENT);
    person = added.changes.find((change) => change.table === "people" && change.op === "insert")?.id ?? null;
    if (person === null) throw new Error("person_add recorded no person");
  }
  if (fresh) {
    const message = value(row, "_message");
    const on = /^\d{4}-\d{2}-\d{2}/.test(value(row, "_cursor")) ? value(row, "_cursor").slice(0, 10) : undefined;
    db.write(
      "interaction_add",
      {
        person_id: person,
        kind: "message",
        summary: link.kind === "waitlist" ? `Joined the waitlist on ${link.label}${message ? `: ${oneLine(message, 120)}` : ""}` : `Message on ${link.label}: ${oneLine(message, 120)}`,
        ...(on ? { on } : {}),
        source: WEBSITE_SOURCE,
        ref,
      },
      BY_AGENT,
    );
  }
  link.fields.forEach((f, i) => {
    const given = value(row, `_f${i}`);
    if (!given) return;
    try {
      db.write("person_field_set", { person_id: person, field: f.field, value: given }, BY_AGENT);
    } catch (caught) {
      // the same value already, or one the field's kind refuses: the person stays as they are
      if (!(caught instanceof RefusedError)) throw caught;
    }
  });
  return fresh ? "added" : "updated";
}

/** The pull over every linked form, with its own memory of what it last said, so a lasting problem is logged once. */
export function formPuller(deps: Pick<FormDeps, "dir" | "grant" | "fetch" | "store" | "stored" | "notify" | "log">): () => Promise<void> {
  const said = new Map<string, string>();
  const once = (what: string, problem: string) => {
    if (said.get(what) === problem) return;
    said.set(what, problem);
    deps.log(`linked forms: ${what}: ${problem}`);
  };

  const pullLink = async (link: FormLink, grant: Grant): Promise<void> => {
    const sql = pullSql(link);
    const fresh: Row[] = [];
    let updated = 0;
    for (let batch = 0; batch < BATCHES; batch += 1) {
      const state = readFormPull(deps.dir, link.id);
      const rows = await d1Query<Row>(deps.fetch, grant, link.database.id, sql, [state.after?.cursor ?? null, state.after?.key ?? null]);
      if (rows.length === 0) break;
      const db = deps.store(link.space);
      if (!db) {
        once(link.id, `${link.spaceName} is not open on this computer; not pulled`);
        return;
      }
      let last = state.after;
      let wrote = false;
      try {
        for (const row of rows) {
          try {
            const outcome = storeLinkedRow(db, link, row);
            if (outcome === "added") fresh.push(row);
            if (outcome === "updated") updated += 1;
            wrote = wrote || outcome !== "skipped";
          } catch (caught) {
            // A row the store refuses (a name or address it cannot keep) is passed over; anything else stops here, and the next pull starts at this row.
            if (!(caught instanceof RefusedError)) throw caught;
            deps.log(`linked forms: ${link.id}: a row was not added to People: ${caught.message}`);
          }
          last = { cursor: row._cursor ?? null, key: row._key ?? null };
        }
      } finally {
        db.close();
        if (last !== state.after) writePrivateFile(join(deps.dir, `${link.id}.pull.json`), `${JSON.stringify({ after: last } satisfies FormPullState)}\n`);
        if (wrote) deps.stored(link.space);
      }
      if (rows.length < BATCH) break;
    }
    if (fresh.length === 0 && updated === 0) return;
    deps.log(`linked forms: ${link.id}: ${fresh.length} new, ${updated} updated in ${link.spaceName}'s People`);
    const told = fresh.map((row) => ({ name: value(row, "_name"), email: value(row, "_email"), phone: value(row, "_phone") || null, message: value(row, "_message"), kind: link.kind }));
    for (const notice of noticesFor(`space-${link.space}`, told, true)) {
      await deps.notify(notice).catch((caught: unknown) => deps.log(`linked forms: ${link.id}: the notice did not go out: ${why(caught)}`));
    }
  };

  return async () => {
    const links = readLinks(deps.dir);
    if (links.length === 0) return;
    let grant: Grant;
    try {
      grant = await deps.grant();
      said.delete("cloudflare");
    } catch (caught) {
      once("cloudflare", why(caught));
      return;
    }
    for (const link of links) {
      if (link.accountId !== grant.accountId) {
        once(link.id, "Cloudflare is connected to another account than the form's; not pulled");
        continue;
      }
      try {
        await pullLink(link, grant);
        said.delete(link.id);
      } catch (caught) {
        once(link.id, why(caught));
      }
    }
  };
}

/** The databases Cobra's own sites use (sites/<key>/record.json), which sitePull.ts reads already. */
export function ownSiteDatabases(stateDir = STATE_DIR): string[] {
  const root = join(stateDir, "sites");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((key) => {
    try {
      const id = (JSON.parse(readFileSync(join(root, key, "record.json"), "utf8")) as { database?: { id?: string } }).database?.id;
      return id ? [id] : [];
    } catch {
      return [];
    }
  });
}

/** The live deps for the Lead's routes: this computer's Cloudflare connection, its Spaces and their stores. */
export function liveFormDeps(io: Pick<FormDeps, "approvals" | "card" | "tell" | "log"> & { notify?: FormDeps["notify"]; stored?: FormDeps["stored"] }): FormDeps {
  return {
    dir: FORM_LINKS_DIR,
    spacesRoot: SPACES_DIR,
    grant: () => cloudflareHere().grant(),
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(60_000) }),
    ownDatabases: () => ownSiteDatabases(),
    store: (space) => (readSpace(space) ? openProjectDb(`space-${space}`, SPACE_SCHEMA) : null),
    stored: io.stored ?? (() => {}),
    notify: io.notify ?? (async () => {}),
    now: Date.now,
    ...io,
  };
}

/** The Lead's routes: form_sources, form_link, form_unlink. */
export async function handleFormOrch(route: string, body: unknown, requestedBy: string, deps: FormDeps): Promise<Reply> {
  try {
    if (route === "/orch/form/sources") return { status: 200, body: { text: await formSources(deps, body) } };
    if (route === "/orch/form/link") return await proposeLink(deps, requestedBy, body);
    if (route === "/orch/form/unlink") return unlinkForm(deps, body);
    return { status: 404, body: { error: "no such route" } };
  } catch (caught) {
    if (caught instanceof FormError) return { status: caught.status, body: { error: caught.message } };
    return { status: 409, body: { error: why(caught) } };
  }
}
