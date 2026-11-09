// The CRM's own follow-ups: each outreach email the
// agent sends makes a follow-up on its person, due a set number of days later
// (the Space's follow-up rule, 4 when unset, 0 for none), and a reply closes
// it. They are ordinary follow_ups rows marked `auto` with the send they came
// from, so one send never makes two, one done by hand never comes back, and
// a person moved to an end stage gets no more. People's seat writes all of it;
// the agent runs follow_up_after_email and follow_up_replied as itself.
import type { Args, Mutation, MutationContext, Row, TableSpec } from "../dbTypes.ts";

const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";

/** The store's thirteenth migration: what made a follow-up, and the Space's own settings. */
export const CRM_MIGRATION = `
ALTER TABLE follow_ups ADD COLUMN auto TEXT;
CREATE INDEX follow_ups_auto ON follow_ups (auto);
CREATE TABLE space_settings (
  ${STAMPS},
  name TEXT NOT NULL,
  value TEXT NOT NULL
);
CREATE UNIQUE INDEX space_settings_name_unique ON space_settings (name);
`;

export const CRM_TABLES: Record<string, TableSpec> = {
  space_settings: {
    describe: "The Space's own settings, one row each: follow_up_days is how many days after an outreach email with no reply its follow-up falls due (0: none).",
    columns: {
      name: { kind: "text", required: true, describe: "The setting's name" },
      value: { kind: "text", required: true, describe: "Its value, as text" },
    },
  },
};

/** Days from an outreach email to its follow-up when the Space has no rule. */
export const FOLLOW_UP_DAYS = 4;
export const FOLLOW_UP_DAYS_MAX = 60;

const str = (row: Row | undefined, column: string): string => {
  const value = row?.[column];
  return value === null || value === undefined ? "" : String(value);
};

function wholeId(ctx: MutationContext, args: Args, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) ctx.refuse(`${name} must be a whole number`);
  return value;
}

/** The Space's follow-up rule: days after an outreach email, FOLLOW_UP_DAYS when unset. */
export function followUpDays(ctx: Pick<MutationContext, "get">): number {
  const raw = Number(str(ctx.get("SELECT value FROM space_settings WHERE name = 'follow_up_days'"), "value") || NaN);
  return Number.isInteger(raw) && raw >= 0 && raw <= FOLLOW_UP_DAYS_MAX ? raw : FOLLOW_UP_DAYS;
}

/** A day plus some days, both YYYY-MM-DD. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Closes a person's open follow-ups the CRM made itself; one added by hand stays. Returns how many. */
export function closeAutoFollowUps(ctx: MutationContext, person: number): number {
  const open = ctx.all("SELECT id FROM follow_ups WHERE person_id = ? AND done_at IS NULL AND auto IS NOT NULL", [person]);
  for (const row of open) ctx.update("follow_ups", Number(row.id), { done_at: ctx.now });
  return open.length;
}

/** Whether a stage is an end (Paying, Lost): a person there is followed up no more. */
export function endStage(ctx: Pick<MutationContext, "get">, stage: string): boolean {
  return Number(ctx.get("SELECT closed FROM stages WHERE name = ?", [stage])?.closed ?? 0) === 1;
}

export const CRM_MUTATIONS: Record<string, Mutation> = {
  follow_up_rule_set: {
    describe: `Sets how many days after an outreach email with no reply its follow-up falls due, for this Space: 1 to ${FOLLOW_UP_DAYS_MAX}, or 0 for no follow-ups. ${FOLLOW_UP_DAYS} when never set.`,
    args: { days: { kind: "integer", required: true, describe: `0 to ${FOLLOW_UP_DAYS_MAX}` } },
    run(ctx, args) {
      const days = args.days;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > FOLLOW_UP_DAYS_MAX) ctx.refuse(`days must be a whole number from 0 to ${FOLLOW_UP_DAYS_MAX}`);
      const row = ctx.get("SELECT id FROM space_settings WHERE name = 'follow_up_days'");
      if (row) ctx.update("space_settings", Number(row.id), { value: String(days) });
      else ctx.insert("space_settings", { name: "follow_up_days", value: String(days) });
      return days === 0 ? "Outreach emails make no follow-ups now" : `An outreach email with no reply is followed up after ${days} day${days === 1 ? "" : "s"}`;
    },
  },

  follow_up_after_email: {
    describe:
      "The agent's, after it sends an outreach email: a person not yet that far moves to the Space's Contacted stage when it has one, and gets a follow-up due after the Space's follow-up rule, unless the send already made one, they replied since, or they are at an end stage. An open one it made before moves to the new date.",
    args: {
      person_id: { kind: "integer", required: true, describe: "The person's id" },
      on: { kind: "date", required: true, describe: "The day it was sent, YYYY-MM-DD" },
      subject: { kind: "text", required: true, describe: "The email's subject" },
      ref: { kind: "text", required: true, describe: "The send it came from: email:<send id>" },
    },
    run(ctx, args) {
      const id = wholeId(ctx, args, "person_id");
      const who = ctx.get("SELECT * FROM people WHERE id = ?", [id]) ?? ctx.refuse(`no person with id ${id}`);
      const ref = String(args.ref ?? "").trim();
      const on = String(args.on ?? "");
      if (!/^email:\S+$/.test(ref)) ctx.refuse("ref must be email:<send id>");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) ctx.refuse("on must be YYYY-MM-DD");
      const name = str(who, "name");
      if (str(who, "archived_at")) return `${name} is archived: no follow-up`;
      if (str(who, "stage") && endStage(ctx, str(who, "stage"))) return `${name} is ${str(who, "stage")}: no follow-up`;
      const moved = contactedAfterEmail(ctx, who, on);
      return `${moved}${followUp(ctx, who, args, ref, on)}`;
    },
  },

  follow_up_replied: {
    describe: "The agent's, when a person replies to an email: closes the follow-ups the CRM made for them (one added by hand stays).",
    args: { person_id: { kind: "integer", required: true, describe: "The person's id" } },
    run(ctx, args) {
      const id = wholeId(ctx, args, "person_id");
      ctx.get("SELECT id FROM people WHERE id = ?", [id]) ?? ctx.refuse(`no person with id ${id}`);
      const closed = closeAutoFollowUps(ctx, id);
      return closed ? `Closed ${closed} follow-up${closed === 1 ? "" : "s"}` : "Nothing to close";
    },
  },
};

/** The Space's Contacted stage, when it has one: a person moves there after an outreach email unless already that far (or at a stage the Space does not list). A real run on 4 Nov had the CRM Foreman do it by hand, 30 writes for 29 people. */
function contactedAfterEmail(ctx: MutationContext, who: Row, on: string): string {
  const contacted = ctx.get("SELECT name, position FROM stages WHERE lower(name) = 'contacted'");
  if (!contacted) return "";
  const at = str(who, "stage");
  if (at) {
    const current = ctx.get("SELECT position FROM stages WHERE name = ?", [at]);
    if (!current || Number(current.position) >= Number(contacted.position)) return "";
  }
  const id = Number(who.id);
  ctx.update("people", id, { stage: str(contacted, "name") });
  ctx.insert("interactions", { person_id: id, kind: "stage", summary: `Moved to ${str(contacted, "name")}`, happened_on: on, source: "People" });
  return `Moved ${str(who, "name")} to ${str(contacted, "name")}. `;
}

/** follow_up_after_email's follow-up, once the person is known to be current and not at an end stage. */
function followUp(ctx: MutationContext, who: Row, args: Args, ref: string, on: string): string {
  const id = Number(who.id);
  const name = str(who, "name");
  if (ctx.get("SELECT id FROM follow_ups WHERE auto = ?", [ref])) return `That email's follow-up is already there`;
  if (ctx.get("SELECT id FROM interactions WHERE person_id = ? AND ref LIKE 'reply:%' AND happened_on >= ?", [id, on])) return `${name} replied since: no follow-up`;
  const days = followUpDays(ctx);
  if (days === 0) return "This Space makes no follow-ups";
  const due = addDays(on, days);
  const why = `No reply to "${String(args.subject ?? "").trim().slice(0, 120)}"`;
  const open = ctx.get("SELECT id FROM follow_ups WHERE person_id = ? AND done_at IS NULL AND auto IS NOT NULL ORDER BY id DESC LIMIT 1", [id]);
  if (open) {
    ctx.update("follow_ups", Number(open.id), { due_on: due, why, auto: ref });
    return `Follow-up for ${name} moved to ${due}`;
  }
  ctx.insert("follow_ups", { person_id: id, due_on: due, why, auto: ref });
  return `Follow-up for ${name} on ${due}`;
}
