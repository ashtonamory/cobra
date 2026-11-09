/**
 * The Outreach part of a Space's company store: the Space talking to the world. Marketing for a business, Announcements
 * for a team, Messages for a family: campaigns that group what is being said,
 * and drafts of each message that wait for the person's Allow.
 *
 * A draft is never sent from here. The Foreman proposes it with action_propose
 * (an email, a note, or a file), the person allows it, and only then does the
 * Foreman mark the draft sent, which puts it on the person's timeline. The
 * Outreach seat writes these tables; it reads the people and may add to a
 * person's timeline through interaction_add and draft_sent.
 *
 * Written out by hand and append only, as people.ts: no REFERENCES clauses,
 * the mutations check every id.
 */
import type { Args, Mutation, MutationContext, Row, TableSpec, Value } from "../dbTypes.ts";

export const CAMPAIGN_STATUSES = ["planned", "active", "done", "archived"] as const;
export const DRAFT_CHANNELS = ["email", "note", "file"] as const;
export const DRAFT_STATUSES = ["draft", "ready", "sent", "dropped"] as const;

const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";

export const OUTREACH_MIGRATION = `
CREATE TABLE campaigns (
  ${STAMPS},
  name TEXT NOT NULL,
  goal TEXT,
  audience TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  starts_on TEXT,
  ends_on TEXT
);
CREATE TABLE drafts (
  ${STAMPS},
  campaign_id INTEGER,
  person_id INTEGER,
  channel TEXT NOT NULL DEFAULT 'email',
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  ready_at TEXT,
  sent_at TEXT
);
`;

export const OUTREACH_TABLES: Record<string, TableSpec> = {
  campaigns: {
    describe: "A run of messages with one purpose: a spring promotion, a season's announcements, a birthday invitation. Names are unique among unarchived campaigns.",
    columns: {
      name: { kind: "text", required: true },
      goal: { kind: "text", describe: "What it is for, in a line" },
      audience: { kind: "text", describe: "Who it goes to, in words: past customers, all the families" },
      status: { kind: "text", describe: CAMPAIGN_STATUSES.join(", ") },
      starts_on: { kind: "date" },
      ends_on: { kind: "date" },
    },
  },
  drafts: {
    describe: "One message, written and waiting. draft → ready (the person is asked) → sent, or dropped. person_id null is a message to a list, named in the body or the campaign's audience.",
    columns: {
      campaign_id: { kind: "integer", describe: "The campaign it belongs to, if any" },
      person_id: { kind: "integer", describe: "The one person it is for; null for a message to a list" },
      channel: { kind: "text", describe: DRAFT_CHANNELS.join(", ") },
      subject: { kind: "text" },
      body: { kind: "text", required: true },
      status: { kind: "text", describe: DRAFT_STATUSES.join(", ") },
      ready_at: { kind: "text", describe: "ISO time it was marked ready for the person" },
      sent_at: { kind: "text", describe: "ISO time it went out, after the person's Allow" },
    },
  },
};

// --- helpers ------------------------------------------------------------------

function str(row: Row, column: string): string {
  const value = row[column];
  return value === null || value === undefined ? "" : String(value);
}
function num(row: Row, column: string): number {
  const value = row[column];
  return typeof value === "number" ? value : Number(value ?? 0);
}
const has = (args: Args, name: string): boolean => args[name] !== undefined;

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

function oneOf(ctx: MutationContext, name: string, value: string, allowed: readonly string[]): string {
  const lower = value.toLowerCase();
  if (!allowed.includes(lower)) ctx.refuse(`${name} must be ${allowed.join(", ")}`);
  return lower;
}

function idArg(ctx: MutationContext, args: Args, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return ctx.refuse(`${name} must be an id`);
  return value;
}

function campaign(ctx: MutationContext, id: number): Row {
  return ctx.get("SELECT * FROM campaigns WHERE id = ?", [id]) ?? ctx.refuse(`no campaign with id ${id}`);
}

function draft(ctx: MutationContext, id: number): Row {
  return ctx.get("SELECT * FROM drafts WHERE id = ?", [id]) ?? ctx.refuse(`no draft with id ${id}`);
}

function personFor(ctx: MutationContext, id: number): Row {
  const who = ctx.get("SELECT * FROM people WHERE id = ?", [id]) ?? ctx.refuse(`no person with id ${id}: People keeps the people, ask Cobra to have them added first`);
  if (str(who, "archived_at") !== "") ctx.refuse(`${str(who, "name")} is archived; nothing new is written to them`);
  return who;
}

function uniqueName(ctx: MutationContext, name: string, except?: number): void {
  const clash = ctx.all("SELECT id, name FROM campaigns WHERE status <> 'archived'").find((c) => num(c, "id") !== except && str(c, "name").toLowerCase() === name.toLowerCase());
  if (clash) ctx.refuse(`there is already a campaign called ${str(clash, "name")} (id ${num(clash, "id")})`);
}

function span(ctx: MutationContext, startsOn: string | undefined, endsOn: string | undefined): void {
  if (startsOn && endsOn && endsOn < startsOn) ctx.refuse(`ends_on ${endsOn} is before starts_on ${startsOn}`);
}

/** Whether a message by this channel to this person can be written at all. */
function reachable(ctx: MutationContext, channel: string, personId: number | null): void {
  if (channel !== "email" || personId === null) return;
  const who = personFor(ctx, personId);
  if (str(who, "email") === "") ctx.refuse(`${str(who, "name")} has no email address; ask Cobra to have People add one, or write a note instead`);
}

/** The most drafts one drafts_merge writes: one outreach batch (emailBatch.ts BATCH_MAX). */
export const MERGE_MAX = 50;

/** A merge field in drafts_merge's words: {first_name}, {name}, {organization}, {note}, {field:Name}, each with an optional |fallback. */
const MERGE_FIELD = /\{\s*(first_name|name|organization|note|field:[^}|]+?)\s*(?:\|([^}]*))?\}/g;

/** One person's value for a merge field; empty when they have none. */
function mergeValue(ctx: MutationContext, who: Row, key: string): string {
  const id = num(who, "id");
  if (key === "name") return str(who, "name").trim();
  if (key === "first_name") return str(who, "name").trim().split(/\s+/)[0] ?? "";
  if (key === "organization") return str(who, "organization").trim();
  if (key === "note") return str(ctx.get("SELECT body FROM person_notes WHERE person_id = ? ORDER BY written_on DESC, id DESC LIMIT 1", [id]) ?? {}, "body").trim();
  const field = key.slice("field:".length).trim().toLowerCase();
  const row = ctx.get("SELECT v.value AS value FROM person_values v JOIN person_fields f ON f.id = v.field_id WHERE v.person_id = ? AND lower(f.name) = ?", [id, field]);
  return row ? str(row, "value").trim() : "";
}

/** The words with each merge field filled for this person, or the first field they lack (with no fallback). */
function merged(ctx: MutationContext, who: Row, words: string): { text: string } | { missing: string } {
  let missing: string | null = null;
  const text = words.replace(MERGE_FIELD, (_all, key: string, fallback: string | undefined) => {
    const value = mergeValue(ctx, who, key);
    if (value) return value;
    if (fallback !== undefined) return fallback.trim();
    missing ??= key;
    return "";
  });
  return missing ? { missing } : { text };
}

/** Refuses a {...} that is not a merge field, so a typo never goes out in an email. */
function checkMergeFields(ctx: MutationContext, name: string, words: string): void {
  const stray = words.replace(MERGE_FIELD, "").match(/\{[^}]*\}/);
  if (stray) ctx.refuse(`${name} has ${stray[0]}, which is not a merge field: use {first_name}, {name}, {organization}, {note} or {field:<Name>}, each with an optional |fallback such as {first_name|there}`);
}

// --- mutations ----------------------------------------------------------------

export const OUTREACH_MUTATIONS: Record<string, Mutation> = {
  campaign_create: {
    describe: "Opens a campaign, planned. Names are unique among unarchived campaigns.",
    args: {
      name: { kind: "text", required: true, describe: "A short name" },
      goal: { kind: "text", describe: "What it is for" },
      audience: { kind: "text", describe: "Who it goes to, in words" },
      starts_on: { kind: "date", describe: "YYYY-MM-DD" },
      ends_on: { kind: "date", describe: "YYYY-MM-DD, on or after starts_on" },
    },
    run(ctx, args) {
      const name = text(ctx, args, "name", true) as string;
      uniqueName(ctx, name);
      span(ctx, args.starts_on as string | undefined, args.ends_on as string | undefined);
      const row: Record<string, Value | undefined> = { name, status: "planned" };
      for (const f of ["goal", "audience"]) if (has(args, f)) row[f] = text(ctx, args, f) || null;
      for (const f of ["starts_on", "ends_on"]) if (has(args, f)) row[f] = (args[f] as string | null) ?? null;
      const id = ctx.insert("campaigns", row);
      return `Opened campaign ${name}, id ${id}`;
    },
  },

  campaign_update: {
    describe: "Changes a campaign: its words, its dates or its status (planned, active, done, archived). Only the fields given change.",
    args: {
      id: { kind: "integer", required: true, describe: "The campaign's id" },
      name: { kind: "text", describe: "A new name" },
      goal: { kind: "text", describe: "What it is for" },
      audience: { kind: "text", describe: "Who it goes to, in words" },
      status: { kind: "text", describe: CAMPAIGN_STATUSES.join(", ") },
      starts_on: { kind: "date", describe: "YYYY-MM-DD" },
      ends_on: { kind: "date", describe: "YYYY-MM-DD" },
    },
    run(ctx, args) {
      const id = idArg(ctx, args, "id");
      const before = campaign(ctx, id);
      const patch: Record<string, Value | undefined> = {};
      if (has(args, "name")) {
        patch.name = text(ctx, args, "name", true);
        uniqueName(ctx, patch.name as string, id);
      }
      for (const f of ["goal", "audience"]) if (has(args, f)) patch[f] = text(ctx, args, f) || null;
      if (has(args, "status")) patch.status = oneOf(ctx, "status", text(ctx, args, "status", true) as string, CAMPAIGN_STATUSES);
      for (const f of ["starts_on", "ends_on"]) if (has(args, f)) patch[f] = (args[f] as string | null) ?? null;
      if (Object.keys(patch).length === 0) ctx.refuse("nothing to change: give at least one field");
      span(ctx, (patch.starts_on as string | null | undefined) ?? (str(before, "starts_on") || undefined), (patch.ends_on as string | null | undefined) ?? (str(before, "ends_on") || undefined));
      ctx.update("campaigns", id, patch);
      return `Updated campaign ${str(before, "name")}: ${Object.keys(patch).join(", ")}`;
    },
  },

  draft_add: {
    describe: "Writes a draft message, status draft. It goes to one person (person_id) or to a list (leave it out). An email to a person needs their address in People.",
    args: {
      body: { kind: "text", required: true, describe: "The message, as the person would send it" },
      subject: { kind: "text", describe: "For an email" },
      channel: { kind: "text", describe: `${DRAFT_CHANNELS.join(", ")}; email when left out` },
      campaign_id: { kind: "integer", describe: "The campaign it belongs to" },
      person_id: { kind: "integer", describe: "The one person it is for, from People" },
    },
    run(ctx, args) {
      const body = text(ctx, args, "body", true) as string;
      const channel = has(args, "channel") && args.channel !== null ? oneOf(ctx, "channel", text(ctx, args, "channel", true) as string, DRAFT_CHANNELS) : "email";
      const campaignId = has(args, "campaign_id") && args.campaign_id !== null ? idArg(ctx, args, "campaign_id") : null;
      const personId = has(args, "person_id") && args.person_id !== null ? idArg(ctx, args, "person_id") : null;
      if (campaignId !== null) {
        const c = campaign(ctx, campaignId);
        if (str(c, "status") === "archived") ctx.refuse(`campaign ${str(c, "name")} is archived`);
      }
      reachable(ctx, channel, personId);
      const id = ctx.insert("drafts", { body, channel, status: "draft", subject: text(ctx, args, "subject") || null, campaign_id: campaignId, person_id: personId });
      return `Wrote draft ${id}${personId !== null ? ` for ${str(personFor(ctx, personId), "name")}` : ""}`;
    },
  },

  drafts_merge: {
    describe:
      `Writes one ready email draft for each person from one subject and body with merge fields, filled from People in code: {first_name}, {name}, {organization}, {note} (their latest note, such as why they were picked) and {field:<Name>} (one of the Space's fields), each with an optional fallback, {first_name|there}. One journal entry; someone with no email, or with no value for a field that has no fallback, is left off and named. The drafts are for email_batch: never write the copies one by one with draft_add. 1 to ${MERGE_MAX} people.`,
    args: {
      person_ids: { kind: "json", required: true, describe: `The people's ids, a list of 1 to ${MERGE_MAX}` },
      subject: { kind: "text", required: true, describe: "The subject, with merge fields" },
      body: { kind: "text", required: true, describe: "The message, with merge fields, as the person would send it" },
      campaign_id: { kind: "integer", describe: "The campaign they belong to" },
    },
    run(ctx, args) {
      const ids = args.person_ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "number" || !Number.isInteger(id) || id < 1)) return ctx.refuse("person_ids must be a list of people's ids");
      const unique = [...new Set(ids as number[])];
      if (unique.length > MERGE_MAX) ctx.refuse(`at most ${MERGE_MAX} people in one merge, one outreach batch`);
      const subject = text(ctx, args, "subject", true) as string;
      const body = text(ctx, args, "body", true) as string;
      checkMergeFields(ctx, "subject", subject);
      checkMergeFields(ctx, "body", body);
      const campaignId = has(args, "campaign_id") && args.campaign_id !== null ? idArg(ctx, args, "campaign_id") : null;
      if (campaignId !== null && str(campaign(ctx, campaignId), "status") === "archived") ctx.refuse(`campaign ${campaignId} is archived`);
      const written: number[] = [];
      const left: string[] = [];
      for (const id of unique) {
        const who = ctx.get("SELECT * FROM people WHERE id = ?", [id]);
        if (!who) {
          left.push(`id ${id} (no such person)`);
          continue;
        }
        const name = str(who, "name");
        if (str(who, "archived_at")) {
          left.push(`${name} (archived)`);
          continue;
        }
        if (!str(who, "email")) {
          left.push(`${name} (no email)`);
          continue;
        }
        const s = merged(ctx, who, subject);
        const b = merged(ctx, who, body);
        const gap = "missing" in s ? s.missing : "missing" in b ? b.missing : null;
        if (gap !== null || !("text" in s) || !("text" in b)) {
          left.push(`${name} (no ${gap})`);
          continue;
        }
        written.push(ctx.insert("drafts", { body: b.text, channel: "email", status: "ready", ready_at: ctx.now, subject: s.text, campaign_id: campaignId, person_id: id }));
      }
      if (written.length === 0) ctx.refuse(`no draft written: ${left.join("; ")}`);
      const range = written.length === 1 ? `id ${written[0]}` : `ids ${written[0]}–${written[written.length - 1]}`;
      return `Wrote ${written.length} ready ${written.length === 1 ? "draft" : "drafts"}, ${range}, for email_batch${left.length ? `; left off ${left.length}: ${left.join("; ")}` : ""}`;
    },
  },

  draft_update: {
    describe: "Edits a draft's words or channel. A draft already marked ready goes back to draft: the person never allows words they did not see.",
    args: {
      id: { kind: "integer", required: true, describe: "The draft's id" },
      body: { kind: "text", describe: "The new words" },
      subject: { kind: "text", describe: "For an email" },
      channel: { kind: "text", describe: DRAFT_CHANNELS.join(", ") },
    },
    run(ctx, args) {
      const id = idArg(ctx, args, "id");
      const before = draft(ctx, id);
      const state = str(before, "status");
      if (state === "sent" || state === "dropped") ctx.refuse(`draft ${id} is ${state}; write a new draft instead`);
      const patch: Record<string, Value | undefined> = {};
      if (has(args, "body")) patch.body = text(ctx, args, "body", true);
      if (has(args, "subject")) patch.subject = text(ctx, args, "subject") || null;
      if (has(args, "channel")) patch.channel = oneOf(ctx, "channel", text(ctx, args, "channel", true) as string, DRAFT_CHANNELS);
      if (Object.keys(patch).length === 0) ctx.refuse("nothing to change: give at least one field");
      reachable(ctx, (patch.channel as string | undefined) ?? str(before, "channel"), before.person_id === null ? null : num(before, "person_id"));
      if (state === "ready") {
        patch.status = "draft";
        patch.ready_at = null;
      }
      ctx.update("drafts", id, patch);
      return `Edited draft ${id}${state === "ready" ? " (back to draft)" : ""}`;
    },
  },

  draft_ready: {
    describe: "Marks a draft ready for the person: it is what you are about to propose with action_propose.",
    args: { id: { kind: "integer", required: true, describe: "The draft's id" } },
    run(ctx, args) {
      const id = idArg(ctx, args, "id");
      const row = draft(ctx, id);
      if (str(row, "status") !== "draft") ctx.refuse(`draft ${id} is ${str(row, "status")}; only a draft is marked ready`);
      reachable(ctx, str(row, "channel"), row.person_id === null ? null : num(row, "person_id"));
      ctx.update("drafts", id, { status: "ready", ready_at: ctx.now });
      return `Draft ${id} is ready for the person`;
    },
  },

  draft_drop: {
    describe: "Drops a draft that will not be sent. It stays as history.",
    args: { id: { kind: "integer", required: true, describe: "The draft's id" } },
    run(ctx, args) {
      const id = idArg(ctx, args, "id");
      const row = draft(ctx, id);
      const state = str(row, "status");
      if (state === "sent" || state === "dropped") ctx.refuse(`draft ${id} is already ${state}`);
      ctx.update("drafts", id, { status: "dropped" });
      return `Dropped draft ${id}`;
    },
  },

  draft_mailed: {
    describe: "The agent's: a ready draft went out as a branded email from an outreach batch the person allowed. Its email line on the person's timeline is the sender's own.",
    args: { id: { kind: "integer", required: true, describe: "The draft's id" } },
    agentOnly: true,
    run(ctx, args) {
      const id = idArg(ctx, args, "id");
      const row = draft(ctx, id);
      if (str(row, "status") === "sent") return `Draft ${id} was sent already`;
      ctx.update("drafts", id, { status: "sent", sent_at: ctx.now });
      return `Draft ${id} sent`;
    },
  },

  draft_sent: {
    describe: "Records that a ready draft went out, after the person allowed it, and puts it on the person's timeline. Only a ready draft: propose it with action_propose first.",
    args: { id: { kind: "integer", required: true, describe: "The draft's id" } },
    run(ctx, args) {
      const id = idArg(ctx, args, "id");
      const row = draft(ctx, id);
      if (str(row, "status") !== "ready") ctx.refuse(`draft ${id} is ${str(row, "status")}; mark it ready and propose it with action_propose, and record it sent only after the person allowed it`);
      ctx.update("drafts", id, { status: "sent", sent_at: ctx.now });
      if (row.person_id !== null) {
        const kind = str(row, "channel") === "email" ? "email" : "message";
        const subject = str(row, "subject");
        ctx.insert("interactions", { person_id: num(row, "person_id"), kind, summary: subject ? `Sent: ${subject}` : "Sent a message", happened_on: ctx.now.slice(0, 10), source: "Outreach", ref: `draft ${id}` });
      }
      return `Draft ${id} sent`;
    },
  },
};
