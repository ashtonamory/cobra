/**
 * Who may get marketing email: topics a person joins, each join with its date
 * and source; an email status per address; saved segments.
 *
 * Consent is the person's, never a Foreman's:
 *   - a website form's consent tick box joins a topic as the agent (`topic_join_agent`, source Website);
 *   - the owner joins someone from the dashboard (`topic_join`, person only, source Owner);
 *   - a Foreman's import is a proposal (`topic_propose`, source Import) that the
 *     owner allows on the dashboard (`topic_allow`, person only).
 * Leaving a topic is always open to everyone. Unsubscribed and bounced are
 * the agent's facts (`email_status_set`); only the owner clears one
 * (`email_status_clear`), so a model cannot put an unsubscribed person back.
 *
 * Written by hand and append only, as people.ts: no REFERENCES clauses, the
 * mutations check every id.
 */
import type { Args, Mutation, MutationContext, Row, TableSpec } from "../dbTypes.ts";

export const TOPICS_MAX = 20;
/** At most this many people in one import proposal: a dashboard's Allow stays one look. */
export const PROPOSE_MAX = 500;
export const SEGMENTS_MAX = 30;
export const EMAIL_STATUSES = ["unsubscribed", "bounced"] as const;
export const TOPIC_SOURCES = { website: "Website", owner: "Owner", import: "Import" } as const;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 '&/().,-]{0,39}$/;

const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";

export const AUDIENCE_MIGRATION = `
CREATE TABLE email_topics (
  ${STAMPS},
  name TEXT NOT NULL,
  describe TEXT,
  archived_at TEXT
);
CREATE UNIQUE INDEX email_topics_name_unique ON email_topics (name COLLATE NOCASE);
CREATE TABLE person_topics (
  ${STAMPS},
  person_id INTEGER NOT NULL,
  topic_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  joined_at TEXT,
  left_at TEXT
);
CREATE UNIQUE INDEX person_topics_unique ON person_topics (person_id, topic_id);
CREATE TABLE email_status (
  ${STAMPS},
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  since TEXT NOT NULL
);
CREATE UNIQUE INDEX email_status_email ON email_status (email COLLATE NOCASE);
CREATE TABLE segments (
  ${STAMPS},
  name TEXT NOT NULL,
  filter TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX segments_name_unique ON segments (name COLLATE NOCASE);
`;

export const AUDIENCE_TABLES: Record<string, TableSpec> = {
  email_topics: {
    describe: "What a person may choose to get by email: News, Class updates, Offers. A campaign goes only to people who joined its topic.",
    columns: {
      name: { kind: "text", required: true, describe: "As the person reads it on the unsubscribe page; unique, case aside" },
      describe: { kind: "text", describe: "What they get, in a line" },
      archived_at: { kind: "text", describe: "ISO time it was retired; null while in use" },
    },
  },
  person_topics: {
    describe: "A person and a topic: proposed (an import waiting for the owner's Allow), joined, or left. Only joined counts.",
    columns: {
      person_id: { kind: "integer", required: true },
      topic_id: { kind: "integer", required: true },
      state: { kind: "text", required: true, describe: "proposed, joined, left" },
      source: { kind: "text", required: true, describe: "Website (their own tick box), Owner (the owner added them) or Import (the owner allowed a list)" },
      note: { kind: "text", describe: "Where an import came from, in the Foreman's words" },
      joined_at: { kind: "text", describe: "ISO time they joined" },
      left_at: { kind: "text", describe: "ISO time they left" },
    },
  },
  email_status: {
    describe: "An address that gets no marketing email: unsubscribed (they said so) or bounced (it does not exist). Only the agent writes it; only the owner clears it.",
    columns: {
      email: { kind: "text", required: true },
      status: { kind: "text", required: true, describe: EMAIL_STATUSES.join(", ") },
      reason: { kind: "text" },
      since: { kind: "text", required: true, describe: "ISO time" },
    },
  },
  segments: {
    describe: "A saved group of people for a campaign: a filter on stage, source, topics and the Space's fields. Members are worked out at each send.",
    columns: {
      name: { kind: "text", required: true },
      filter: { kind: "text", required: true, describe: "JSON: {stages?, sources?, topics?, fields?: [{field, is}]}" },
      archived_at: { kind: "text" },
    },
  },
};

export type SegmentFilter = { stages?: string[]; sources?: string[]; topics?: string[]; fields?: { field: string; is: string }[] };

// --- helpers ------------------------------------------------------------------

function str(row: Row, column: string): string {
  const value = row[column];
  return value === null || value === undefined ? "" : String(value);
}
function num(row: Row, column: string): number {
  const value = row[column];
  return typeof value === "number" ? value : Number(value ?? 0);
}
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
function idArg(ctx: MutationContext, args: Args, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return ctx.refuse(`${name} must be an id`);
  return value;
}
function currentPerson(ctx: MutationContext, id: number): Row {
  const who = ctx.get("SELECT * FROM people WHERE id = ?", [id]) ?? ctx.refuse(`no person with id ${id}`);
  if (str(who, "archived_at") !== "") ctx.refuse(`${str(who, "name")} is archived`);
  return who;
}
function topicNamed(ctx: MutationContext, name: string, inUse = true): Row {
  const topic = ctx.get("SELECT * FROM email_topics WHERE name = ? COLLATE NOCASE", [name]);
  if (!topic || (inUse && str(topic, "archived_at") !== "")) {
    const names = ctx.all("SELECT name FROM email_topics WHERE archived_at IS NULL ORDER BY name").map((r) => str(r, "name"));
    return ctx.refuse(`no topic called ${name}${names.length ? `; the topics are ${names.join(", ")}` : "; add one with topic_set"}`);
  }
  return topic;
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function address(ctx: MutationContext, args: Args): string {
  const value = (text(ctx, args, "email", true) as string).toLowerCase();
  if (!EMAIL.test(value)) ctx.refuse("email is one address like name@example.com");
  return value;
}

/** Joins a person to a topic (or rejoins one who left), from one source. */
function join(ctx: MutationContext, personId: number, topic: Row, source: string, note?: string): string {
  const who = currentPerson(ctx, personId);
  const before = ctx.get("SELECT * FROM person_topics WHERE person_id = ? AND topic_id = ?", [personId, num(topic, "id")]);
  if (before && str(before, "state") === "joined") ctx.refuse(`${str(who, "name")} already gets ${str(topic, "name")}`);
  const row = { state: "joined", source, joined_at: ctx.now, left_at: null, ...(note ? { note } : {}) };
  if (before) ctx.update("person_topics", num(before, "id"), row);
  else ctx.insert("person_topics", { person_id: personId, topic_id: num(topic, "id"), ...row });
  return `${str(who, "name")} joined ${str(topic, "name")} (${source})`;
}

/** A segment's filter, checked: only known stages, topics and fields, at most 20 of each. */
export function checkFilter(ctx: MutationContext, raw: unknown): SegmentFilter {
  const parsed = typeof raw === "string" ? (() => { try { return JSON.parse(raw) as unknown; } catch { return ctx.refuse("filter is JSON"); } })() : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ctx.refuse("filter is an object: {stages?, sources?, topics?, fields?: [{field, is}]}");
  const f = parsed as Record<string, unknown>;
  const unknownKey = Object.keys(f).find((k) => !["stages", "sources", "topics", "fields"].includes(k));
  if (unknownKey) ctx.refuse(`filter has no ${unknownKey}; it takes stages, sources, topics and fields`);
  const list = (key: string): string[] | undefined => {
    if (f[key] === undefined) return undefined;
    if (!Array.isArray(f[key]) || (f[key] as unknown[]).some((v) => typeof v !== "string" || !v.trim()) || (f[key] as unknown[]).length > 20) ctx.refuse(`${key} is a list of at most 20 names`);
    return (f[key] as string[]).map((v) => v.trim());
  };
  const out: SegmentFilter = {};
  const stages = list("stages");
  if (stages) {
    const known = ctx.all("SELECT name FROM stages").map((r) => str(r, "name").toLowerCase());
    const missing = stages.filter((s) => !known.includes(s.toLowerCase()));
    if (missing.length) ctx.refuse(`no stage called ${missing.join(", ")}`);
    out.stages = stages;
  }
  const sources = list("sources");
  if (sources) out.sources = sources;
  const topics = list("topics");
  if (topics) out.topics = topics.map((t) => str(topicNamed(ctx, t), "name"));
  if (f.fields !== undefined) {
    if (!Array.isArray(f.fields) || f.fields.length > 20) ctx.refuse("fields is a list of at most 20 {field, is}");
    out.fields = (f.fields as unknown[]).map((item) => {
      const it = (item ?? {}) as Record<string, unknown>;
      if (typeof it.field !== "string" || typeof it.is !== "string") return ctx.refuse("each of fields is {field, is}");
      const field = ctx.get("SELECT name FROM person_fields WHERE name = ? COLLATE NOCASE AND archived_at IS NULL", [it.field]);
      if (!field) return ctx.refuse(`no field called ${it.field} in use`);
      return { field: str(field, "name"), is: it.is.trim() };
    });
  }
  return out;
}

// --- mutations ----------------------------------------------------------------

export const AUDIENCE_MUTATIONS: Record<string, Mutation> = {
  topic_set: {
    describe: `Adds an email topic a person may join (News, Class updates), or changes the line that says what it is. A retired one comes back. At most ${TOPICS_MAX} in use.`,
    args: { name: { kind: "text", required: true, describe: "As people read it on the unsubscribe page" }, describe: { kind: "text", describe: "What they get, in a line" } },
    run(ctx, args) {
      const name = (text(ctx, args, "name", true) as string).replace(/\s+/g, " ");
      if (!NAME.test(name)) ctx.refuse("name is at most 40 characters of letters, numbers, spaces and simple punctuation");
      const describe = text(ctx, args, "describe");
      if (describe && describe.length > 200) ctx.refuse("describe is at most 200 characters");
      const existing = ctx.get("SELECT * FROM email_topics WHERE name = ? COLLATE NOCASE", [name]);
      const used = num(ctx.get("SELECT COUNT(*) AS n FROM email_topics WHERE archived_at IS NULL") ?? {}, "n");
      if ((!existing || str(existing, "archived_at") !== "") && used >= TOPICS_MAX) ctx.refuse(`this Space already has ${TOPICS_MAX} topics; retire one with topic_archive first`);
      if (existing) {
        ctx.update("email_topics", num(existing, "id"), { archived_at: null, ...(describe !== undefined ? { describe: describe || null } : {}) });
        return `${str(existing, "archived_at") ? "Brought back" : "Changed"} the topic ${str(existing, "name")}`;
      }
      ctx.insert("email_topics", { name, describe: describe || null });
      return `Added the email topic ${name}`;
    },
  },
  topic_archive: {
    describe: "Retires a topic: no campaign can name it, and it leaves the unsubscribe page. Who joined it is kept.",
    args: { name: { kind: "text", required: true, describe: "The topic's name" } },
    run(ctx, args) {
      const topic = topicNamed(ctx, text(ctx, args, "name", true) as string);
      ctx.update("email_topics", num(topic, "id"), { archived_at: ctx.now });
      return `Retired the topic ${str(topic, "name")}`;
    },
  },
  topic_propose: {
    describe: `Proposes people for a topic from a list the owner gave you (a sign-up sheet, an old mailing list), where they said yes to it. Nobody joins until the owner allows it on the dashboard (topic_allow is theirs). At most ${PROPOSE_MAX} at once; people already in it are passed over.`,
    args: {
      topic: { kind: "text", required: true, describe: "The topic's name" },
      people: { kind: "rows", required: true, describe: "Who, by id", of: { person_id: { kind: "integer", required: true, describe: "A person's id" } } },
      note: { kind: "text", required: true, describe: "Where the list came from and how they agreed, in a line the owner reads" },
    },
    run(ctx, args) {
      const topic = topicNamed(ctx, text(ctx, args, "topic", true) as string);
      const note = text(ctx, args, "note", true) as string;
      if (note.length > 200) ctx.refuse("note is at most 200 characters");
      const rows = Array.isArray(args.people) ? (args.people as Record<string, unknown>[]) : [];
      if (rows.length === 0 || rows.length > PROPOSE_MAX) ctx.refuse(`people is 1 to ${PROPOSE_MAX} rows`);
      let proposed = 0;
      let passed = 0;
      for (const row of rows) {
        const id = typeof row.person_id === "number" ? row.person_id : NaN;
        if (!Number.isInteger(id) || id < 1) ctx.refuse("each person_id is a person's id");
        currentPerson(ctx, id);
        const before = ctx.get("SELECT * FROM person_topics WHERE person_id = ? AND topic_id = ?", [id, num(topic, "id")]);
        // In it, waiting, or left: someone who left stays left, so an import never takes them back.
        if (before) {
          passed += 1;
          continue;
        }
        ctx.insert("person_topics", { person_id: id, topic_id: num(topic, "id"), state: "proposed", source: TOPIC_SOURCES.import, note });
        proposed += 1;
      }
      return `Proposed ${proposed} ${proposed === 1 ? "person" : "people"} for ${str(topic, "name")}; the owner allows them on the dashboard${passed ? ` (${passed} passed over: in it, waiting or left)` : ""}`;
    },
  },
  topic_allow: {
    describe: "The owner allows a proposed join (their own, from the dashboard).",
    args: { id: { kind: "integer", required: true, describe: "The person_topics row" } },
    personOnly: true,
    run(ctx, args) {
      const row = ctx.get("SELECT * FROM person_topics WHERE id = ?", [idArg(ctx, args, "id")]) ?? ctx.refuse("no such proposal");
      if (str(row, "state") !== "proposed") ctx.refuse("that is not waiting");
      const who = currentPerson(ctx, num(row, "person_id"));
      const topic = ctx.get("SELECT * FROM email_topics WHERE id = ?", [num(row, "topic_id")])!;
      ctx.update("person_topics", num(row, "id"), { state: "joined", joined_at: ctx.now });
      return `${str(who, "name")} joined ${str(topic, "name")} (Import)`;
    },
  },
  topic_decline: {
    describe: "Drops a proposed join: the person is not added.",
    args: { id: { kind: "integer", required: true, describe: "The person_topics row" } },
    run(ctx, args) {
      const row = ctx.get("SELECT * FROM person_topics WHERE id = ?", [idArg(ctx, args, "id")]) ?? ctx.refuse("no such proposal");
      if (str(row, "state") !== "proposed") ctx.refuse("that is not waiting");
      ctx.remove("person_topics", num(row, "id"));
      return "Dropped the proposed join";
    },
  },
  topic_join: {
    describe: "The owner adds a person to a topic (their own, from the dashboard).",
    args: { person_id: { kind: "integer", required: true, describe: "The person's id" }, topic: { kind: "text", required: true, describe: "The topic's name" } },
    personOnly: true,
    run(ctx, args) {
      return join(ctx, idArg(ctx, args, "person_id"), topicNamed(ctx, text(ctx, args, "topic", true) as string), TOPIC_SOURCES.owner);
    },
  },
  topic_join_agent: {
    describe: "The agent's: a person ticked a topic's box on a website form.",
    args: { person_id: { kind: "integer", required: true, describe: "The person's id" }, topic: { kind: "text", required: true, describe: "The topic's name" } },
    agentOnly: true,
    run(ctx, args) {
      return join(ctx, idArg(ctx, args, "person_id"), topicNamed(ctx, text(ctx, args, "topic", true) as string), TOPIC_SOURCES.website);
    },
  },
  topic_leave: {
    describe: "Takes a person off a topic. Anyone may: they get nothing more of it.",
    args: { person_id: { kind: "integer", required: true, describe: "The person's id" }, topic: { kind: "text", required: true, describe: "The topic's name" } },
    run(ctx, args) {
      const id = idArg(ctx, args, "person_id");
      const topic = topicNamed(ctx, text(ctx, args, "topic", true) as string, false);
      const row = ctx.get("SELECT * FROM person_topics WHERE person_id = ? AND topic_id = ?", [id, num(topic, "id")]);
      if (!row || str(row, "state") === "left") ctx.refuse("they are not in that topic");
      ctx.update("person_topics", num(row!, "id"), { state: "left", left_at: ctx.now });
      return `Took person ${id} off ${str(topic, "name")}`;
    },
  },
  email_status_set: {
    describe: "The agent's: an address unsubscribed from all marketing email, or bounced.",
    args: { email: { kind: "text", required: true, describe: "The address" }, status: { kind: "text", required: true, describe: EMAIL_STATUSES.join(", ") }, reason: { kind: "text", describe: "Why, in a line" } },
    agentOnly: true,
    run(ctx, args) {
      const email = address(ctx, args);
      const status = text(ctx, args, "status", true) as string;
      if (!(EMAIL_STATUSES as readonly string[]).includes(status)) ctx.refuse(`status is ${EMAIL_STATUSES.join(" or ")}`);
      const reason = text(ctx, args, "reason")?.slice(0, 200) || null;
      const before = ctx.get("SELECT * FROM email_status WHERE email = ? COLLATE NOCASE", [email]);
      if (before) ctx.update("email_status", num(before, "id"), { status, reason, since: ctx.now });
      else ctx.insert("email_status", { email, status, reason, since: ctx.now });
      return `${email} is ${status}`;
    },
  },
  email_status_clear: {
    describe: "The owner's: an address may get marketing email again (they asked to come back, or a bounce was a mistake).",
    args: { id: { kind: "integer", required: true, describe: "The email_status row" } },
    personOnly: true,
    run(ctx, args) {
      const before = ctx.get("SELECT * FROM email_status WHERE id = ?", [idArg(ctx, args, "id")]) ?? ctx.refuse("that address is not unsubscribed or bounced");
      ctx.remove("email_status", num(before, "id"));
      return `${str(before, "email")} may get marketing email again`;
    },
  },
  segment_set: {
    describe: `Saves a group of people for campaigns, or changes one: a filter on stages, sources, topics (all of them joined) and the Space's fields. At most ${SEGMENTS_MAX}.`,
    args: {
      name: { kind: "text", required: true, describe: "Like Regulars or New this month" },
      filter: { kind: "json", required: true, describe: '{"stages": ["Member"], "sources": ["Website"], "topics": ["News"], "fields": [{"field": "Membership", "is": "Gold"}]}; every part optional' },
    },
    run(ctx, args) {
      const name = (text(ctx, args, "name", true) as string).replace(/\s+/g, " ");
      if (!NAME.test(name)) ctx.refuse("name is at most 40 characters of letters, numbers, spaces and simple punctuation");
      const filter = JSON.stringify(checkFilter(ctx, args.filter));
      const existing = ctx.get("SELECT * FROM segments WHERE name = ? COLLATE NOCASE", [name]);
      if (existing) {
        ctx.update("segments", num(existing, "id"), { filter, archived_at: null });
        return `Changed the segment ${str(existing, "name")}`;
      }
      if (num(ctx.get("SELECT COUNT(*) AS n FROM segments WHERE archived_at IS NULL") ?? {}, "n") >= SEGMENTS_MAX) ctx.refuse(`this Space already has ${SEGMENTS_MAX} segments`);
      ctx.insert("segments", { name, filter });
      return `Saved the segment ${name}`;
    },
  },
  segment_archive: {
    describe: "Retires a segment.",
    args: { name: { kind: "text", required: true, describe: "The segment's name" } },
    run(ctx, args) {
      const name = text(ctx, args, "name", true) as string;
      const seg = ctx.get("SELECT * FROM segments WHERE name = ? COLLATE NOCASE AND archived_at IS NULL", [name]) ?? ctx.refuse(`no segment called ${name}`);
      ctx.update("segments", num(seg, "id"), { archived_at: ctx.now });
      return `Retired the segment ${str(seg, "name")}`;
    },
  },
};
