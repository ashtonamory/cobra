/**
 * The People part of a Space's company store:
 * everyone the Space deals with, what was said to them, what is due next, and
 * the stages they move through. It is the CRM of a business, the Roster of a
 * team, the Contacts of a family: one set of tables, named by the Space's kind
 * only in the words the Foreman and the apps use.
 *
 * The People seat is the one writer of these tables. Outreach and Money read
 * them and point at a person by id; the one write they share is
 * `interaction_add`, so an invoice or a message can land on a person's
 * timeline, and Outreach alone may also `people_import` new people it is
 * about to write to (trades/space.ts SEAT_EXTRA_MUTATIONS). Nothing here
 * contacts anyone: that is action_propose.
 *
 * The migration is written out by hand, not generated from `tables`: a shipped
 * migration must never change under a database that already ran it. No
 * REFERENCES clauses, as in billing.ts: the mutations check every id, and undo
 * re-inserts deleted rows in journal order, which a foreign key would refuse.
 */
import type { Args, Mutation, MutationContext, Row, TableSpec, Value } from "../dbTypes.ts";
import { closeAutoFollowUps, endStage } from "./crm.ts";

export const INTERACTION_KINDS = ["email", "call", "meeting", "message", "invoice", "note", "stage", "other"] as const;

const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";

export const PEOPLE_MIGRATION = `
CREATE TABLE people (
  ${STAMPS},
  name TEXT NOT NULL,
  organization TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  stage TEXT,
  source TEXT,
  archived_at TEXT
);
CREATE TABLE stages (
  ${STAMPS},
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  closed INTEGER
);
CREATE UNIQUE INDEX stages_name_unique ON stages (name);
CREATE TABLE person_notes (
  ${STAMPS},
  person_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  written_on TEXT NOT NULL
);
CREATE TABLE interactions (
  ${STAMPS},
  person_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  happened_on TEXT NOT NULL,
  source TEXT,
  ref TEXT
);
CREATE TABLE follow_ups (
  ${STAMPS},
  person_id INTEGER NOT NULL,
  due_on TEXT NOT NULL,
  why TEXT NOT NULL,
  done_at TEXT
);
`;

export const PEOPLE_TABLES: Record<string, TableSpec> = {
  people: {
    describe: "Everyone the Space deals with, current or archived (archived_at set): a customer or lead, a player's family, a contact. Names need not be unique; the id tells two apart.",
    columns: {
      name: { kind: "text", required: true, describe: "The person, or the family or organization when that is who you write to" },
      organization: { kind: "text", describe: "Their business, club or school" },
      email: { kind: "text", describe: "Where messages and invoices go" },
      phone: { kind: "text", sensitive: true },
      address: { kind: "text", sensitive: true },
      stage: { kind: "text", describe: "Where they are in the Space's stages (the stages table), when it has any" },
      source: { kind: "text", describe: "How they came to the Space: a referral, the website form, a sign-up sheet" },
      archived_at: { kind: "text", describe: "ISO time the person was archived; null while current" },
    },
  },
  stages: {
    describe: "The steps a person moves through, in order: lead, talking, won, lost for a business; invited, confirmed for a team. A closed stage is an end (won, lost, declined).",
    columns: {
      name: { kind: "text", required: true, describe: "Unique, case aside" },
      position: { kind: "integer", required: true, describe: "Left to right on the board, from 1" },
      closed: { kind: "integer", describe: "1 for an end stage, else 0" },
    },
  },
  person_notes: {
    describe: "What the person wrote down about someone, newest last.",
    columns: {
      person_id: { kind: "integer", required: true },
      body: { kind: "text", required: true },
      written_on: { kind: "date", required: true },
    },
  },
  interactions: {
    describe: "Everything that touched a person, in time order: emails, calls, invoices, notes, stage moves. The timeline on their card is this table.",
    columns: {
      person_id: { kind: "integer", required: true },
      kind: { kind: "text", required: true, describe: INTERACTION_KINDS.join(", ") },
      summary: { kind: "text", required: true, describe: "One line: what happened" },
      happened_on: { kind: "date", required: true },
      source: { kind: "text", describe: "Which seat or the person recorded it: Marketing, Finance, you" },
      ref: { kind: "text", describe: "What it points at, like an invoice number" },
    },
  },
  follow_ups: {
    describe: "Who to contact next and why. Done ones (done_at set) stay as history.",
    columns: {
      person_id: { kind: "integer", required: true },
      due_on: { kind: "date", required: true },
      why: { kind: "text", required: true },
      done_at: { kind: "text", describe: "ISO time it was done; null while due" },
      // Added by the store's thirteenth migration (crm.ts).
      auto: { kind: "text", describe: "What made it: email:<send id> for one the CRM made after an outreach email; null for one added by hand" },
    },
  },
};

// --- helpers ------------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(row: Row, column: string): string {
  const value = row[column];
  return value === null || value === undefined ? "" : String(value);
}

function num(row: Row, column: string): number {
  const value = row[column];
  return typeof value === "number" ? value : Number(value ?? 0);
}

const has = (args: Args, name: string): boolean => args[name] !== undefined;

/** A text argument trimmed; undefined when left out; empty is refused when required and else cleared to null by the caller. */
function text(ctx: MutationContext, args: Args, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) ctx.refuse(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "string") return ctx.refuse(`${name} must be text`);
  const trimmed = value.trim();
  if (!trimmed && required) ctx.refuse(`${name} cannot be empty`);
  return trimmed;
}

function email(ctx: MutationContext, args: Args, name: string): string | undefined {
  const value = text(ctx, args, name);
  if (value && !EMAIL.test(value)) ctx.refuse(`${name} must be one address like name@example.com`);
  return value;
}

function personId(ctx: MutationContext, args: Args, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return ctx.refuse(`${name} must be a person's id`);
  return value;
}

function person(ctx: MutationContext, id: number): Row {
  return ctx.get("SELECT * FROM people WHERE id = ?", [id]) ?? ctx.refuse(`no person with id ${id}`);
}

/** A current person: the writes that add to someone refuse an archived one, so history is never stacked on a person who left. */
function current(ctx: MutationContext, id: number): Row {
  const who = person(ctx, id);
  if (str(who, "archived_at") !== "") ctx.refuse(`${str(who, "name")} is archived; restore them with person_restore first`);
  return who;
}

const today = (ctx: MutationContext): string => ctx.now.slice(0, 10);

/** The stage's own spelling when the Space has stages and this is one of them; any text when it has none yet. */
function stageName(ctx: MutationContext, value: string): string {
  const stages = ctx.all("SELECT name FROM stages ORDER BY position, id");
  if (stages.length === 0) return value;
  const found = stages.find((s) => str(s, "name").toLowerCase() === value.toLowerCase());
  if (!found) ctx.refuse(`stage ${value} is not one of this Space's stages: ${stages.map((s) => str(s, "name")).join(", ")}; add it with stage_set`);
  return str(found!, "name");
}

const FIELD_ARGS: Mutation["args"] = {
  organization: { kind: "text", describe: "Their business, club or school" },
  email: { kind: "text", describe: "One address" },
  phone: { kind: "text", describe: "Sensitive: masked from you when you read it" },
  address: { kind: "text", describe: "Sensitive: masked from you when you read it" },
  source: { kind: "text", describe: "How they came to the Space" },
};

function personPatch(ctx: MutationContext, args: Args): Record<string, Value | undefined> {
  const patch: Record<string, Value | undefined> = {};
  if (has(args, "name")) patch.name = text(ctx, args, "name", true);
  if (has(args, "email")) patch.email = email(ctx, args, "email") || null;
  for (const field of ["organization", "phone", "address", "source"]) {
    if (has(args, field)) patch[field] = text(ctx, args, field) || null;
  }
  return patch;
}

/** The most people one people_import adds. */
const IMPORT_MAX = 500;

/** A Space field that holds a website, which people_import (and Cobra's contact_lookup, contactLookup.ts) also matches people by. */
export const WEBSITE = /^(website|web site|site|url)$/i;

type PersonKey = { email: string | null; website: string | null; name: string; organization: string | null };

/** A website as its host: no scheme, no www., no path; how two spellings of one site are found to be the same. */
export const siteKey = (url: string): string =>
  url.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
const plain = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Who is already here, for people_import: by email, by website field, and by
 * name with business. A website or name match counts only when the two emails
 * do not differ, so two agents of one brokerage are both kept.
 */
class Keys {
  private readonly emails = new Map<string, string>();
  private readonly sites = new Map<string, { where: string; email: string | null }>();
  private readonly names = new Map<string, { where: string; email: string | null }>();

  constructor(ctx: MutationContext) {
    const emails = new Map<number, string | null>();
    for (const p of ctx.all("SELECT id, name, organization, email, archived_at FROM people")) {
      const where = `id ${num(p, "id")}${str(p, "archived_at") ? ", archived" : ""}`;
      emails.set(num(p, "id"), str(p, "email") || null);
      this.add({ email: str(p, "email") || null, website: null, name: str(p, "name"), organization: str(p, "organization") || null }, where);
    }
    for (const field of ctx.all("SELECT id, name FROM person_fields").filter((f) => WEBSITE.test(str(f, "name")))) {
      for (const v of ctx.all("SELECT person_id, value FROM person_values WHERE field_id = ?", [num(field, "id")])) {
        const key = siteKey(str(v, "value"));
        if (key) this.sites.set(key, { where: `id ${num(v, "person_id")}`, email: emails.get(num(v, "person_id")) ?? null });
      }
    }
  }

  add(key: PersonKey, where: string): void {
    if (key.email) this.emails.set(key.email.toLowerCase(), where);
    const site = key.website ? siteKey(key.website) : "";
    if (site) this.sites.set(site, { where, email: key.email });
    this.names.set(`${plain(key.name)}|${plain(key.organization ?? "")}`, { where, email: key.email });
  }

  /** Why this row is someone already here, or null. */
  match(key: PersonKey): string | null {
    const email = key.email?.toLowerCase() ?? null;
    if (email && this.emails.has(email)) return `same email as ${this.emails.get(email)}`;
    const agrees = (other: string | null): boolean => !email || !other || other.toLowerCase() === email;
    const site = key.website ? siteKey(key.website) : "";
    const bySite = site ? this.sites.get(site) : undefined;
    if (bySite && agrees(bySite.email)) return `same website as ${bySite.where}`;
    const byName = this.names.get(`${plain(key.name)}|${plain(key.organization ?? "")}`);
    if (byName && agrees(byName.email)) return `same name and business as ${byName.where}`;
    return null;
  }
}

/** A row's fields object read to the Space's fields: each [field row, value]; empty values left out; an unknown field refused. */
function importFields(ctx: MutationContext, raw: unknown): Array<[Row, string]> {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) return ctx.refuse("fields must be an object of field name → value");
  const out: Array<[Row, string]> = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    const typed = String(value).trim();
    if (!typed) continue;
    const field = fieldByName(ctx, name);
    if (!field || str(field, "archived_at") !== "") return ctx.refuse(`no field called ${name} in use; add it with field_set first`);
    out.push([field, fieldValue(ctx, field, typed)]);
  }
  return out;
}

// --- mutations ----------------------------------------------------------------

export const PEOPLE_MUTATIONS: Record<string, Mutation> = {
  person_add: {
    describe: "Adds a person. Names need not be unique. A stage must be one of the Space's stages once it has any.",
    args: { name: { kind: "text", required: true, describe: "The person, or the family or organization" }, ...FIELD_ARGS, stage: { kind: "text", describe: "A stage's name" } },
    run(ctx, args) {
      const patch = personPatch(ctx, args);
      const stage = text(ctx, args, "stage");
      if (stage) patch.stage = stageName(ctx, stage);
      const id = ctx.insert("people", patch);
      ctx.insert("interactions", { person_id: id, kind: "other", summary: "Added", happened_on: today(ctx), source: "People" });
      return `Added ${String(patch.name)}, id ${id}`;
    },
  },

  people_import: {
    describe:
      "Adds many people at once, each with the Space's fields and a note, as one journal entry that db_undo takes back whole. Someone already here (the same email, the same website field, or the same name and business, archived or not) is skipped and named, never entered twice. sheet_import with table people runs it from a file or a tab, so you never type the rows.",
    args: {
      rows: {
        kind: "rows",
        required: true,
        describe: `1 to ${IMPORT_MAX} people`,
        of: {
          name: { kind: "text", required: true, describe: "The person, or the family or organization" },
          ...FIELD_ARGS,
          stage: { kind: "text", describe: "A stage's name" },
          note: { kind: "text", describe: "A note about them, dated today" },
          fields: { kind: "json", describe: "The Space's fields by name (person_fields), each value as typed; empty ones are left out" },
        },
      },
    },
    run(ctx, args) {
      const rows = args.rows as Args[];
      if (rows.length === 0) ctx.refuse("rows is empty");
      if (rows.length > IMPORT_MAX) ctx.refuse(`at most ${IMPORT_MAX} people in one import; split the list`);
      const known = new Keys(ctx);
      const added: number[] = [];
      const skipped: string[] = [];
      rows.forEach((row, index) => {
        const name = typeof row.name === "string" ? row.name.trim() : "";
        // A refusal names the row, so the Foreman can fix the file; nothing of the batch is kept.
        const rowCtx: MutationContext = Object.assign(Object.create(ctx) as MutationContext, { refuse: (message: string): never => ctx.refuse(`row ${index + 1} (${name || "no name"}): ${message}`) });
        const patch = personPatch(rowCtx, row);
        const stage = text(rowCtx, row, "stage");
        if (stage) patch.stage = stageName(rowCtx, stage);
        const values = importFields(rowCtx, row.fields);
        const website = values.find(([field]) => WEBSITE.test(str(field, "name")))?.[1];
        const key: PersonKey = { email: typeof patch.email === "string" ? patch.email : null, website: website ?? null, name: String(patch.name), organization: typeof patch.organization === "string" ? patch.organization : null };
        const seen = known.match(key);
        if (seen) {
          skipped.push(`${String(patch.name)} (${seen})`);
          return;
        }
        const id = ctx.insert("people", patch);
        ctx.insert("interactions", { person_id: id, kind: "other", summary: "Added", happened_on: today(ctx), source: "People" });
        for (const [field, value] of values) ctx.insert("person_values", { person_id: id, field_id: num(field, "id"), value });
        const note = text(rowCtx, row, "note");
        if (note) {
          ctx.insert("person_notes", { person_id: id, body: note, written_on: today(ctx) });
          ctx.insert("interactions", { person_id: id, kind: "note", summary: note.length > 80 ? `${note.slice(0, 77)}...` : note, happened_on: today(ctx), source: "People" });
        }
        known.add(key, `row ${index + 1}`);
        added.push(id);
      });
      if (added.length === 0) ctx.refuse(`nobody new: all ${rows.length} are already here: ${skipped.slice(0, 10).join("; ")}${skipped.length > 10 ? "; ..." : ""}`);
      const ids = added.length === 1 ? `id ${added[0]}` : `ids ${added[0]}–${added[added.length - 1]}`;
      const skip = skipped.length ? `; skipped ${skipped.length} already here: ${skipped.slice(0, 10).join("; ")}${skipped.length > 10 ? "; ..." : ""}` : "";
      return `Added ${added.length} ${added.length === 1 ? "person" : "people"}, ${ids}${skip}`;
    },
  },

  person_update: {
    describe: "Changes a person's details, archived or not. Only the fields given change; to move them between stages use person_stage.",
    args: { id: { kind: "integer", required: true, describe: "The person's id" }, name: { kind: "text", describe: "A new name" }, ...FIELD_ARGS },
    run(ctx, args) {
      const id = personId(ctx, args, "id");
      const before = person(ctx, id);
      const patch = personPatch(ctx, args);
      if (Object.keys(patch).length === 0) ctx.refuse("nothing to change: give at least one field");
      ctx.update("people", id, patch);
      return `Updated ${str(before, "name")}: ${Object.keys(patch).join(", ")}`;
    },
  },

  person_stage: {
    describe: "Moves a person to a stage and notes the move on their timeline.",
    args: { id: { kind: "integer", required: true, describe: "The person's id" }, stage: { kind: "text", required: true, describe: "A stage's name" } },
    run(ctx, args) {
      const id = personId(ctx, args, "id");
      const who = current(ctx, id);
      const stage = stageName(ctx, text(ctx, args, "stage", true) as string);
      if (str(who, "stage") === stage) ctx.refuse(`${str(who, "name")} is already ${stage}`);
      ctx.update("people", id, { stage });
      ctx.insert("interactions", { person_id: id, kind: "stage", summary: `Moved to ${stage}`, happened_on: today(ctx), source: "People" });
      // At an end stage (Paying, Lost) the CRM's own follow-ups close; one added by hand stays.
      if (endStage(ctx, stage)) closeAutoFollowUps(ctx, id);
      return `Moved ${str(who, "name")} to ${stage}`;
    },
  },

  person_archive: {
    describe: "Archives a person: their history stays, and nothing new is added to them.",
    args: { id: { kind: "integer", required: true, describe: "The person's id" } },
    run(ctx, args) {
      const id = personId(ctx, args, "id");
      const who = person(ctx, id);
      if (str(who, "archived_at") !== "") ctx.refuse(`${str(who, "name")} was already archived on ${str(who, "archived_at").slice(0, 10)}`);
      ctx.update("people", id, { archived_at: ctx.now });
      return `Archived ${str(who, "name")}`;
    },
  },

  person_restore: {
    describe: "Brings an archived person back.",
    args: { id: { kind: "integer", required: true, describe: "The person's id" } },
    run(ctx, args) {
      const id = personId(ctx, args, "id");
      const who = person(ctx, id);
      if (str(who, "archived_at") === "") ctx.refuse(`${str(who, "name")} is not archived`);
      ctx.update("people", id, { archived_at: null });
      return `Restored ${str(who, "name")}`;
    },
  },

  note_add: {
    describe: "Writes a note about a person, dated today unless given, and notes it on their timeline.",
    args: {
      person_id: { kind: "integer", required: true, describe: "The person's id" },
      body: { kind: "text", required: true, describe: "What to remember" },
      on: { kind: "date", describe: "YYYY-MM-DD; today when left out" },
    },
    run(ctx, args) {
      const id = personId(ctx, args, "person_id");
      const who = current(ctx, id);
      const body = text(ctx, args, "body", true) as string;
      const on = (args.on as string | undefined) ?? today(ctx);
      ctx.insert("person_notes", { person_id: id, body, written_on: on });
      ctx.insert("interactions", { person_id: id, kind: "note", summary: body.length > 80 ? `${body.slice(0, 77)}...` : body, happened_on: on, source: "People" });
      return `Noted on ${str(who, "name")}`;
    },
  },

  interaction_add: {
    describe: `Records something that touched a person on their timeline: ${INTERACTION_KINDS.join(", ")}. Any seat may add one, with its own name as source.`,
    args: {
      person_id: { kind: "integer", required: true, describe: "The person's id" },
      kind: { kind: "text", required: true, describe: INTERACTION_KINDS.join(", ") },
      summary: { kind: "text", required: true, describe: "One line: what happened" },
      on: { kind: "date", describe: "YYYY-MM-DD; today when left out" },
      source: { kind: "text", describe: "Which seat recorded it: Marketing, Finance, People" },
      ref: { kind: "text", describe: "What it points at, like an invoice number" },
    },
    run(ctx, args) {
      const id = personId(ctx, args, "person_id");
      const who = person(ctx, id);
      const kind = (text(ctx, args, "kind", true) as string).toLowerCase();
      if (!(INTERACTION_KINDS as readonly string[]).includes(kind)) ctx.refuse(`kind must be ${INTERACTION_KINDS.join(", ")}`);
      const summary = text(ctx, args, "summary", true) as string;
      ctx.insert("interactions", { person_id: id, kind, summary, happened_on: (args.on as string | undefined) ?? today(ctx), source: text(ctx, args, "source") || null, ref: text(ctx, args, "ref") || null });
      return `Recorded ${kind} for ${str(who, "name")}`;
    },
  },

  follow_up_add: {
    describe: "Adds a follow-up: who to contact next and why, due on a date.",
    args: {
      person_id: { kind: "integer", required: true, describe: "The person's id" },
      due_on: { kind: "date", required: true, describe: "YYYY-MM-DD" },
      why: { kind: "text", required: true, describe: "What to follow up on" },
    },
    run(ctx, args) {
      const id = personId(ctx, args, "person_id");
      const who = current(ctx, id);
      const dueOn = args.due_on as string;
      if (dueOn < today(ctx)) ctx.refuse(`due_on ${dueOn} is in the past; today is ${today(ctx)}`);
      const followUp = ctx.insert("follow_ups", { person_id: id, due_on: dueOn, why: text(ctx, args, "why", true) as string });
      return `Follow-up ${followUp} for ${str(who, "name")} on ${dueOn}`;
    },
  },

  follow_up_done: {
    describe: "Marks a follow-up done.",
    args: { id: { kind: "integer", required: true, describe: "The follow-up's id" } },
    run(ctx, args) {
      const id = personId(ctx, args, "id");
      const row = ctx.get("SELECT * FROM follow_ups WHERE id = ?", [id]) ?? ctx.refuse(`no follow-up with id ${id}`);
      if (str(row, "done_at") !== "") ctx.refuse(`follow-up ${id} was already done on ${str(row, "done_at").slice(0, 10)}`);
      ctx.update("follow_ups", id, { done_at: ctx.now });
      return `Follow-up ${id} done`;
    },
  },

  stage_set: {
    describe: "Adds a stage, or changes the one with this name (case aside): its place on the board and whether it is an end.",
    args: {
      name: { kind: "text", required: true, describe: "The stage's name" },
      position: { kind: "integer", required: true, describe: "Left to right, from 1" },
      closed: { kind: "integer", describe: "1 for an end stage (won, lost), else 0" },
    },
    run(ctx, args) {
      const name = text(ctx, args, "name", true) as string;
      const position = args.position as number;
      if (position < 1) ctx.refuse("position counts from 1");
      const closed = has(args, "closed") && args.closed !== null ? (args.closed as number) : undefined;
      if (closed !== undefined && closed !== 0 && closed !== 1) ctx.refuse("closed is 1 or 0");
      const existing = ctx.all("SELECT * FROM stages").find((s) => str(s, "name").toLowerCase() === name.toLowerCase());
      if (existing) {
        ctx.update("stages", num(existing, "id"), { position, ...(closed === undefined ? {} : { closed }) });
        return `Moved stage ${str(existing, "name")} to position ${position}`;
      }
      ctx.insert("stages", { name, position, closed: closed ?? 0 });
      return `Added stage ${name} at position ${position}`;
    },
  },

  stage_remove: {
    describe: "Removes a stage nobody is in.",
    args: { name: { kind: "text", required: true, describe: "The stage's name" } },
    run(ctx, args) {
      const name = text(ctx, args, "name", true) as string;
      const row = ctx.all("SELECT * FROM stages").find((s) => str(s, "name").toLowerCase() === name.toLowerCase()) ?? ctx.refuse(`no stage called ${name}`);
      const inIt = ctx.get("SELECT COUNT(*) AS n FROM people WHERE stage = ?", [str(row, "name")]);
      if (inIt && num(inIt, "n") > 0) ctx.refuse(`${num(inIt, "n")} ${num(inIt, "n") === 1 ? "person is" : "people are"} in ${str(row, "name")}; move them first with person_stage`);
      ctx.remove("stages", num(row, "id"));
      return `Removed stage ${str(row, "name")}`;
    },
  },
};

// --- fields the Space tracks -------------------------------------------------------
// What else a Space keeps on each person beyond the fixed columns (a yoga
// studio's membership, a landscaper's lot size), set up by the People seat when
// the Space starts and added to when the person or Cobra asks. Its own
// migration, after Money's: a store only ever moves forward.

export const FIELD_KINDS = ["text", "number", "date", "yes/no", "choice"] as const;
type FieldKind = (typeof FIELD_KINDS)[number];

/** At most this many fields in use, so a card stays a card. */
export const FIELDS_MAX = 20;
const CHOICES_MAX = 20;
const VALUE_MAX = 500;
export const FIELD_NAME = /^[A-Za-z][A-Za-z0-9 '&/().,-]{0,39}$/;
/** The people table's own columns: a field may not take one of their names. */
export const BUILT_IN = new Set(["name", "organization", "email", "phone", "address", "stage", "source", "notes", "note"]);

export const PEOPLE_FIELDS_MIGRATION = `
CREATE TABLE person_fields (
  ${STAMPS},
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  choices TEXT,
  describe TEXT,
  position INTEGER NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX person_fields_name_unique ON person_fields (name COLLATE NOCASE);
CREATE TABLE person_values (
  ${STAMPS},
  person_id INTEGER NOT NULL,
  field_id INTEGER NOT NULL,
  value TEXT NOT NULL
);
CREATE UNIQUE INDEX person_values_unique ON person_values (person_id, field_id);
`;

export const PEOPLE_FIELD_TABLES: Record<string, TableSpec> = {
  person_fields: {
    describe: "What else this Space tracks on each person, beyond the people table's own columns: a yoga studio's membership, a landscaper's lot size. Removed ones (archived_at set) keep their values.",
    columns: {
      name: { kind: "text", required: true, describe: "As the person reads it; unique, case aside" },
      kind: { kind: "text", required: true, describe: FIELD_KINDS.join(", ") },
      choices: { kind: "text", describe: "For a choice field: the values it may hold, as a JSON list" },
      describe: { kind: "text", describe: "What goes in it" },
      position: { kind: "integer", required: true, describe: "Its place on a person's card, from 1" },
      archived_at: { kind: "text", describe: "ISO time it was removed; null while in use" },
    },
  },
  person_values: {
    describe: "Each person's value for a field: one row per person and field, none when it is empty.",
    columns: {
      person_id: { kind: "integer", required: true },
      field_id: { kind: "integer", required: true, describe: "The person_fields row" },
      value: { kind: "text", required: true, describe: "As typed: a number, a YYYY-MM-DD date, yes or no, or one of the field's choices" },
    },
  },
};

function fieldByName(ctx: MutationContext, name: string): Row | undefined {
  return ctx.all("SELECT * FROM person_fields").find((f) => str(f, "name").toLowerCase() === name.toLowerCase());
}

function choicesOf(row: Row): string[] {
  try {
    const parsed: unknown = JSON.parse(str(row, "choices") || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** A value read to its field's kind, in the spelling the Space uses. */
function fieldValue(ctx: MutationContext, field: Row, raw: string): string {
  const name = str(field, "name");
  if (raw.length > VALUE_MAX) ctx.refuse(`${name} is at most ${VALUE_MAX} characters`);
  switch (str(field, "kind") as FieldKind) {
    case "number": {
      const plain = raw.replace(/,/g, "");
      if (!/^-?\d+(\.\d+)?$/.test(plain)) ctx.refuse(`${name} is a number`);
      return plain;
    }
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) ctx.refuse(`${name} is a date like 2026-10-30`);
      return raw;
    case "yes/no":
      if (/^(yes|y|true|1)$/i.test(raw)) return "yes";
      if (/^(no|n|false|0)$/i.test(raw)) return "no";
      return ctx.refuse(`${name} is yes or no`);
    case "choice": {
      const choices = choicesOf(field);
      const found = choices.find((c) => c.toLowerCase() === raw.toLowerCase());
      if (!found) ctx.refuse(`${name} is one of: ${choices.join(", ")}; add a choice with field_set`);
      return found!;
    }
    default:
      return raw;
  }
}

export const PEOPLE_FIELD_MUTATIONS: Record<string, Mutation> = {
  field_set: {
    describe: `Adds a field this Space tracks on each person, or changes the one with this name (case aside): its kind, choices, note or place. A removed field comes back with its values. At most ${FIELDS_MAX} in use.`,
    args: {
      name: { kind: "text", required: true, describe: "What it is called on a person's card, like Membership or Lot size" },
      kind: { kind: "text", describe: `${FIELD_KINDS.join(", ")}; text when left out on a new field` },
      choices: { kind: "text", describe: "For a choice field: its values, separated by commas" },
      describe: { kind: "text", describe: "What goes in it, in a few words" },
      position: { kind: "integer", describe: "Its place on the card, from 1; last when left out on a new field" },
    },
    run(ctx, args) {
      const name = (text(ctx, args, "name", true) as string).replace(/\s+/g, " ");
      if (!FIELD_NAME.test(name)) ctx.refuse("name starts with a letter and is at most 40 characters of letters, numbers, spaces and simple punctuation");
      if (BUILT_IN.has(name.toLowerCase())) ctx.refuse(`${name} is already on every person's card`);
      const existing = fieldByName(ctx, name);
      const kindText = text(ctx, args, "kind")?.toLowerCase();
      if (kindText && !(FIELD_KINDS as readonly string[]).includes(kindText)) ctx.refuse(`kind is ${FIELD_KINDS.join(", ")}`);
      const kind = (kindText || (existing ? str(existing, "kind") : "text")) as FieldKind;
      const listed = has(args, "choices") ? [...new Set((text(ctx, args, "choices") ?? "").split(",").map((c) => c.trim()).filter(Boolean))] : null;
      const choices = listed ?? (existing ? choicesOf(existing) : []);
      if (kind === "choice" && choices.length === 0) ctx.refuse("a choice field needs its choices, separated by commas");
      if (choices.length > CHOICES_MAX || choices.some((c) => c.length > 40)) ctx.refuse(`at most ${CHOICES_MAX} choices of 40 characters each`);
      if (has(args, "position") && (args.position as number) < 1) ctx.refuse("position counts from 1");
      const describe = has(args, "describe") ? text(ctx, args, "describe") || null : undefined;
      if (typeof describe === "string" && describe.length > 200) ctx.refuse("describe is at most 200 characters");
      if (existing) {
        if (str(existing, "kind") !== kind) {
          const held = ctx.get("SELECT COUNT(*) AS n FROM person_values WHERE field_id = ?", [num(existing, "id")]);
          if (held && num(held, "n") > 0) ctx.refuse(`${str(existing, "name")} already holds ${num(held, "n")} value(s) as ${str(existing, "kind")}; add a new field instead`);
        }
        const back = str(existing, "archived_at") !== "";
        if (back) checkRoom(ctx);
        ctx.update("person_fields", num(existing, "id"), {
          kind,
          choices: kind === "choice" ? JSON.stringify(choices) : null,
          ...(describe === undefined ? {} : { describe }),
          ...(has(args, "position") ? { position: args.position as number } : {}),
          ...(back ? { archived_at: null } : {}),
        });
        return `${back ? "Brought back" : "Changed"} the field ${str(existing, "name")}`;
      }
      checkRoom(ctx);
      const last = ctx.get("SELECT COALESCE(MAX(position), 0) AS n FROM person_fields");
      const position = has(args, "position") ? (args.position as number) : num(last ?? {}, "n") + 1;
      ctx.insert("person_fields", { name, kind, choices: kind === "choice" ? JSON.stringify(choices) : null, describe: describe ?? null, position });
      return `Added the field ${name} (${kind}${kind === "choice" ? `: ${choices.join(", ")}` : ""})`;
    },
  },

  field_remove: {
    describe: "Takes a field off every person's card. Its values are kept, and field_set with its name brings it back.",
    args: { name: { kind: "text", required: true, describe: "The field's name" } },
    run(ctx, args) {
      const name = text(ctx, args, "name", true) as string;
      const field = fieldByName(ctx, name);
      if (!field || str(field, "archived_at") !== "") return ctx.refuse(`no field called ${name} in use`);
      ctx.update("person_fields", num(field, "id"), { archived_at: ctx.now });
      return `Removed the field ${str(field, "name")}`;
    },
  },

  person_field_set: {
    describe: "Sets one of the Space's fields for a person (see person_fields), or clears it when value is left out or empty.",
    args: {
      person_id: { kind: "integer", required: true, describe: "The person's id" },
      field: { kind: "text", required: true, describe: "The field's name" },
      value: { kind: "text", describe: "The value, read to the field's kind; empty or left out clears it" },
    },
    run(ctx, args) {
      const id = personId(ctx, args, "person_id");
      const who = person(ctx, id);
      const name = text(ctx, args, "field", true) as string;
      const field = fieldByName(ctx, name);
      if (!field || str(field, "archived_at") !== "") return ctx.refuse(`no field called ${name} in use; add it with field_set`);
      const before = ctx.get("SELECT * FROM person_values WHERE person_id = ? AND field_id = ?", [id, num(field, "id")]);
      const raw = text(ctx, args, "value") ?? "";
      if (!raw) {
        if (!before) ctx.refuse(`${str(field, "name")} is already empty for ${str(who, "name")}`);
        ctx.remove("person_values", num(before!, "id"));
        return `Cleared ${str(field, "name")} for ${str(who, "name")}`;
      }
      const value = fieldValue(ctx, field, raw);
      if (before) {
        if (str(before, "value") === value) ctx.refuse(`${str(field, "name")} is already ${value} for ${str(who, "name")}`);
        ctx.update("person_values", num(before, "id"), { value });
      } else {
        ctx.insert("person_values", { person_id: id, field_id: num(field, "id"), value });
      }
      return `Set ${str(field, "name")} to ${value} for ${str(who, "name")}`;
    },
  },
};

function checkRoom(ctx: MutationContext): void {
  const used = ctx.get("SELECT COUNT(*) AS n FROM person_fields WHERE archived_at IS NULL");
  if (used && num(used, "n") >= FIELDS_MAX) ctx.refuse(`this Space already tracks ${FIELDS_MAX} fields; remove one with field_remove first`);
}

/** The people writes any seat may run, with its own name as the source: the timeline is everyone's. (Outreach may also people_import: trades/space.ts SEAT_EXTRA_MUTATIONS.) */
export const PEOPLE_SHARED_MUTATIONS: readonly string[] = ["interaction_add"];
