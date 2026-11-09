// Deals: what a person might buy, as their own records. A person has none or many, each with a value, a stage on the Space's
// pipeline, an expected close and, once closed, won or lost. People keep their
// relationship stage (people.ts); a person is a lead until a deal is opened.
// The pipeline's stages each carry a chance of closing, so the CRM board can
// say how much is likely to close. They start as defaults that rise toward the
// last open stage, and the person changes one by telling Cobra, whose people
// Foreman runs deal_stage_set. People's seat writes all of it.
import type { Args, Mutation, MutationContext, Row, TableSpec } from "../dbTypes.ts";

const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** The store's fifth migration: the pipeline with its default stages, and the deals. */
export const DEALS_MIGRATION = `
CREATE TABLE deal_stages (
  ${STAMPS},
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  chance INTEGER NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  won INTEGER
);
CREATE UNIQUE INDEX deal_stages_name_unique ON deal_stages (name COLLATE NOCASE);
INSERT INTO deal_stages (created_at, updated_at, name, position, chance, closed, won) VALUES
  (${NOW}, ${NOW}, 'Lead', 1, 10, 0, NULL),
  (${NOW}, ${NOW}, 'Qualified', 2, 25, 0, NULL),
  (${NOW}, ${NOW}, 'Proposal', 3, 50, 0, NULL),
  (${NOW}, ${NOW}, 'Negotiation', 4, 75, 0, NULL),
  (${NOW}, ${NOW}, 'Won', 5, 100, 1, 1),
  (${NOW}, ${NOW}, 'Lost', 6, 0, 1, 0);
CREATE TABLE deals (
  ${STAMPS},
  person_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  value_cents INTEGER NOT NULL,
  stage TEXT NOT NULL,
  expected_close TEXT,
  opened_on TEXT NOT NULL,
  closed_on TEXT,
  outcome TEXT,
  lost_stage TEXT,
  lost_reason TEXT,
  notes TEXT,
  archived_at TEXT
);
CREATE INDEX deals_person ON deals (person_id);
`;

export const DEAL_TABLES: Record<string, TableSpec> = {
  deal_stages: {
    describe: "The pipeline a deal moves through, in order, each with its chance of closing. Open stages first; Won (won 1) and Lost (won 0) are the ends.",
    columns: {
      name: { kind: "text", required: true, describe: "Unique, case aside" },
      position: { kind: "integer", required: true, describe: "Left to right, from 1" },
      chance: { kind: "integer", required: true, describe: "Percent chance a deal here closes won, 0 to 100" },
      closed: { kind: "integer", required: true, describe: "1 for an end (won or lost), else 0" },
      won: { kind: "integer", describe: "For an end: 1 won, 0 lost; null while open" },
    },
  },
  deals: {
    describe: "What a person might buy: a value, a stage, an expected close and, once closed, won or lost. A person has none or many.",
    columns: {
      person_id: { kind: "integer", required: true },
      title: { kind: "text", required: true, describe: "What it is, in a few words: Spring landscaping, 10-class pass" },
      value_cents: { kind: "money", required: true, describe: "What it is worth, whole cents" },
      stage: { kind: "text", required: true, describe: "A deal_stages name" },
      expected_close: { kind: "date", describe: "When it should close, YYYY-MM-DD" },
      opened_on: { kind: "date", required: true },
      closed_on: { kind: "date", describe: "When it was won or lost; null while open" },
      outcome: { kind: "text", describe: "won or lost once closed; null while open" },
      lost_stage: { kind: "text", describe: "The stage a lost deal was at when it was lost" },
      lost_reason: { kind: "text", describe: "Why it was lost, in their words" },
      notes: { kind: "text" },
      archived_at: { kind: "text", describe: "ISO time it was set aside as entered by mistake; null otherwise" },
    },
  },
};

const STAGES_MAX = 12;

function str(row: Row, column: string): string {
  const value = row[column];
  return value === null || value === undefined ? "" : String(value);
}

function num(row: Row, column: string): number {
  const value = row[column];
  return typeof value === "number" ? value : Number(value ?? 0);
}

const has = (args: Args, name: string): boolean => args[name] !== undefined;
const today = (ctx: MutationContext): string => ctx.now.slice(0, 10);

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

function idArg(ctx: MutationContext, args: Args, name: string, what: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return ctx.refuse(`${name} must be ${what}'s id`);
  return value;
}

function value(ctx: MutationContext, args: Args): number {
  const cents = args.value_cents;
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 0) return ctx.refuse("value_cents is what the deal is worth: zero or more, whole cents or like \"1200.00\"");
  return cents;
}

function stages(ctx: MutationContext): Row[] {
  return ctx.all("SELECT * FROM deal_stages ORDER BY position, id");
}

function stageOf(ctx: MutationContext, name: string): Row {
  const all = stages(ctx);
  return all.find((s) => str(s, "name").toLowerCase() === name.toLowerCase()) ?? ctx.refuse(`${name} is not one of the pipeline's stages: ${all.map((s) => str(s, "name")).join(", ")}`);
}

function deal(ctx: MutationContext, id: number): Row {
  const row = ctx.get("SELECT * FROM deals WHERE id = ?", [id]) ?? ctx.refuse(`no deal with id ${id}`);
  if (str(row, "archived_at") !== "") ctx.refuse(`deal ${id} was set aside; open a new one`);
  return row;
}

function personName(ctx: MutationContext, id: number): string {
  const row = ctx.get("SELECT name, archived_at FROM people WHERE id = ?", [id]) ?? ctx.refuse(`no person with id ${id}`);
  return str(row, "name");
}

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

function note(ctx: MutationContext, personId: number, summary: string, ref: number): void {
  ctx.insert("interactions", { person_id: personId, kind: "other", summary, happened_on: today(ctx), source: "People", ref: `deal:${ref}` });
}

/** Moves a deal to a stage: into an end closes it as that end says, out of one opens it again. */
function moveTo(ctx: MutationContext, row: Row, target: Row, reason?: string): string {
  const id = num(row, "id");
  const name = str(target, "name");
  if (str(row, "stage").toLowerCase() === name.toLowerCase()) ctx.refuse(`${str(row, "title")} is already at ${name}`);
  const end = num(target, "closed") === 1;
  const won = end && num(target, "won") === 1;
  ctx.update("deals", id, end
    ? { stage: name, outcome: won ? "won" : "lost", closed_on: today(ctx), lost_stage: won ? null : str(row, "stage") || null, lost_reason: won ? null : reason ?? null }
    : { stage: name, outcome: null, closed_on: null, lost_stage: null, lost_reason: null });
  const what = end ? (won ? "Won" : "Lost") : `Moved to ${name}`;
  note(ctx, num(row, "person_id"), `${what}: ${str(row, "title")} (${money(num(row, "value_cents"))})${reason ? `, ${reason}` : ""}`, id);
  return `${what}: ${str(row, "title")} for ${personName(ctx, num(row, "person_id"))}`;
}

export const DEAL_MUTATIONS: Record<string, Mutation> = {
  deal_open: {
    describe: "Opens a deal for a person: what it is, what it is worth, and its stage (the pipeline's first when left out). A person may have several.",
    args: {
      person_id: { kind: "integer", required: true, describe: "The person's id" },
      title: { kind: "text", required: true, describe: "What it is, in a few words" },
      value_cents: { kind: "money", required: true, describe: "What it is worth" },
      stage: { kind: "text", describe: "An open stage of the pipeline" },
      expected_close: { kind: "date", describe: "When it should close, YYYY-MM-DD" },
      notes: { kind: "text", describe: "Anything worth keeping about it" },
    },
    run(ctx, args) {
      const personId = idArg(ctx, args, "person_id", "a person");
      const who = ctx.get("SELECT name, archived_at FROM people WHERE id = ?", [personId]) ?? ctx.refuse(`no person with id ${personId}`);
      if (str(who, "archived_at") !== "") ctx.refuse(`${str(who, "name")} is archived; restore them with person_restore first`);
      const title = text(ctx, args, "title", true) as string;
      if (title.length > 120) ctx.refuse("title is at most 120 characters");
      const stageText = text(ctx, args, "stage");
      const stage = stageText ? stageOf(ctx, stageText) : stages(ctx).find((s) => num(s, "closed") === 0) ?? ctx.refuse("the pipeline has no open stage; add one with deal_stage_set");
      if (num(stage, "closed") === 1) ctx.refuse(`${str(stage, "name")} is an end; open the deal at an open stage, then close it`);
      const cents = value(ctx, args);
      const id = ctx.insert("deals", {
        person_id: personId, title, value_cents: cents, stage: str(stage, "name"),
        expected_close: (args.expected_close as string | undefined) ?? null, opened_on: today(ctx), notes: text(ctx, args, "notes") || null,
      });
      note(ctx, personId, `Deal opened: ${title} (${money(cents)})`, id);
      return `Opened deal ${id}: ${title} for ${str(who, "name")}, ${money(cents)} at ${str(stage, "name")}`;
    },
  },

  deal_update: {
    describe: "Changes a deal's title, value, expected close or notes. Only the fields given change; to move it use deal_stage, to close it deal_close.",
    args: {
      id: { kind: "integer", required: true, describe: "The deal's id" },
      title: { kind: "text", describe: "What it is, in a few words" },
      value_cents: { kind: "money", describe: "What it is worth" },
      expected_close: { kind: "date", describe: "YYYY-MM-DD" },
      notes: { kind: "text", describe: "Anything worth keeping about it" },
    },
    run(ctx, args) {
      const id = idArg(ctx, args, "id", "a deal");
      const row = deal(ctx, id);
      const patch: Record<string, string | number | null> = {};
      if (has(args, "title")) patch.title = text(ctx, args, "title", true) as string;
      if (has(args, "value_cents")) patch.value_cents = value(ctx, args);
      if (has(args, "expected_close")) patch.expected_close = (args.expected_close as string | null) ?? null;
      if (has(args, "notes")) patch.notes = text(ctx, args, "notes") || null;
      if (Object.keys(patch).length === 0) ctx.refuse("nothing to change: give at least one field");
      ctx.update("deals", id, patch);
      return `Updated deal ${id} (${str(row, "title")}): ${Object.keys(patch).join(", ")}`;
    },
  },

  deal_stage: {
    describe: "Moves a deal to another stage of the pipeline. Moving it to an end closes it (Won or Lost); moving a closed one to an open stage opens it again.",
    args: { id: { kind: "integer", required: true, describe: "The deal's id" }, stage: { kind: "text", required: true, describe: "A stage's name" } },
    run(ctx, args) {
      const row = deal(ctx, idArg(ctx, args, "id", "a deal"));
      return moveTo(ctx, row, stageOf(ctx, text(ctx, args, "stage", true) as string));
    },
  },

  deal_close: {
    describe: "Closes a deal as won or lost, moving it to the pipeline's Won or Lost end; a lost one keeps the stage it was lost at and why.",
    args: {
      id: { kind: "integer", required: true, describe: "The deal's id" },
      outcome: { kind: "text", required: true, describe: "won or lost" },
      reason: { kind: "text", describe: "For a lost deal: why, in a few words" },
    },
    run(ctx, args) {
      const row = deal(ctx, idArg(ctx, args, "id", "a deal"));
      const outcome = (text(ctx, args, "outcome", true) as string).toLowerCase();
      if (outcome !== "won" && outcome !== "lost") ctx.refuse("outcome is won or lost");
      if (str(row, "outcome") === outcome) ctx.refuse(`${str(row, "title")} is already ${outcome}`);
      const end = stages(ctx).find((s) => num(s, "closed") === 1 && num(s, "won") === (outcome === "won" ? 1 : 0)) ?? ctx.refuse(`the pipeline has no ${outcome} end; add one with deal_stage_set`);
      return moveTo(ctx, row, end, outcome === "lost" ? text(ctx, args, "reason") || undefined : undefined);
    },
  },

  deal_archive: {
    describe: "Sets aside a deal entered by mistake: it leaves the pipeline and the board's numbers, and its history stays.",
    args: { id: { kind: "integer", required: true, describe: "The deal's id" } },
    run(ctx, args) {
      const row = deal(ctx, idArg(ctx, args, "id", "a deal"));
      ctx.update("deals", num(row, "id"), { archived_at: ctx.now });
      return `Set aside deal ${num(row, "id")} (${str(row, "title")})`;
    },
  },

  deal_stage_set: {
    describe: `Adds a stage to the pipeline or changes the one with this name (case aside): its chance of closing, its place, or whether it is an end (won 1, lost 0). At most ${STAGES_MAX}. When the person says a stage's odds are different, this is how it changes.`,
    args: {
      name: { kind: "text", required: true, describe: "The stage's name" },
      chance: { kind: "integer", describe: "Percent chance a deal here closes won, 0 to 100" },
      position: { kind: "integer", describe: "Left to right, from 1; last open place when left out on a new stage" },
      won: { kind: "integer", describe: "Only for an end: 1 for won, 0 for lost; leave out for an open stage" },
    },
    run(ctx, args) {
      const name = (text(ctx, args, "name", true) as string).replace(/\s+/g, " ");
      if (name.length > 40) ctx.refuse("name is at most 40 characters");
      const all = stages(ctx);
      const existing = all.find((s) => str(s, "name").toLowerCase() === name.toLowerCase());
      if (has(args, "chance") && (typeof args.chance !== "number" || args.chance < 0 || args.chance > 100)) ctx.refuse("chance is a percent, 0 to 100");
      if (has(args, "position") && (args.position as number) < 1) ctx.refuse("position counts from 1");
      if (has(args, "won") && args.won !== null && args.won !== 0 && args.won !== 1) ctx.refuse("won is 1 (won) or 0 (lost), only for an end");
      const end = has(args, "won") && args.won !== null;
      if (existing) {
        const patch: Record<string, number | null> = {};
        if (has(args, "chance")) patch.chance = args.chance as number;
        if (has(args, "position")) patch.position = args.position as number;
        if (has(args, "won")) Object.assign(patch, end ? { closed: 1, won: args.won as number, chance: args.won === 1 ? 100 : 0 } : { closed: 0, won: null });
        if (Object.keys(patch).length === 0) ctx.refuse("nothing to change: give chance, position or won");
        if (has(args, "won") && !end) {
          const held = ctx.get("SELECT COUNT(*) AS n FROM deals WHERE stage = ? AND archived_at IS NULL", [str(existing, "name")]);
          if (held && num(held, "n") > 0) ctx.refuse(`${num(held, "n")} closed deal(s) sit at ${str(existing, "name")}; move them first`);
        }
        ctx.update("deal_stages", num(existing, "id"), patch);
        return `Changed the stage ${str(existing, "name")}: ${Object.entries(patch).map(([k, v]) => `${k} ${v}`).join(", ")}`;
      }
      if (all.length >= STAGES_MAX) ctx.refuse(`the pipeline already has ${STAGES_MAX} stages`);
      const lastOpen = all.filter((s) => num(s, "closed") === 0).reduce((m, s) => Math.max(m, num(s, "position")), 0);
      const position = has(args, "position") ? (args.position as number) : end ? all.length + 1 : lastOpen + 1;
      // A new open stage goes before the ends unless told otherwise: the ends move along one place.
      if (!has(args, "position") && !end) for (const s of all.filter((x) => num(x, "position") >= position)) ctx.update("deal_stages", num(s, "id"), { position: num(s, "position") + 1 });
      const chance = end ? (args.won === 1 ? 100 : 0) : has(args, "chance") ? (args.chance as number) : 50;
      ctx.insert("deal_stages", { name, position, chance, closed: end ? 1 : 0, won: end ? (args.won as number) : null });
      return `Added the stage ${name} (${end ? (args.won === 1 ? "won end" : "lost end") : `${chance}% chance`})`;
    },
  },
};
