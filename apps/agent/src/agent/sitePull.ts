// The website form's rows into the Space.
// A site's contact form keeps each inquiry in the owner's own D1 database
// (siteDeploy.ts WORKER_SOURCE); this pulls them to this computer every 5
// minutes and once when the agent starts, straight from the owner's account
// with the token cloudflare.ts keeps. No other server is in the path.
//
// For each site the agent made (record.json under <state>/sites/<key>/) that
// has a database and a live version:
//   1. the rows after the cursor that are not pulled yet, 100 at a time;
//   2. for a site of a Space, each one lands in the Space's store, written by
//      the agent (journaled as `agent`): the person found by email or added,
//      then a `message` on their timeline, source Website, ref
//      `inquiry:<row id>`, which is checked first, so a row is never added
//      twice;
//   3. the rows are marked pulled in D1, and only then the cursor moves
//      (pull.json beside the record, apart from record.json, which a preview
//      rewrites);
//   4. a notice and a push: "New website inquiry from <name>". A site outside
//      a Space has only this, with the message in the notice.
// Once a day the rows pulled more than 30 days ago are deleted from D1.
// A waitlist sign-up (kind waitlist, website-design.md Phase 5) needs only an
// email: the person is added under it with source "Website waitlist", the
// timeline says they joined, and the notice says "New waitlist sign-up". A
// table made before form kinds gets its kind column on the first pull. A
// designed site's own form (website-design.md, free forms) names itself
// (`form`, its title, on the timeline and in the notice), and each of its
// other answers (`data`, by label) is kept in the Space's field of that name,
// added as a text field the first time; a field the Space cannot add (20 in
// use, a name it refuses) is left out of the card and said on the timeline.
//
// Cloudflare not connected, refused, or not answering: said once in the log,
// tried again next tick, the cursor untouched.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { RefusedError } from "./db.ts";
import { BY_AGENT, type ProjectDb } from "./dbTypes.ts";
import { writePrivateFile } from "./private.ts";
import type { SiteRecord } from "./site.ts";
import { d1Query, migrateInquiries, type Fetch, type Grant } from "./siteDeploy.ts";

export const PULL_EVERY_MS = 5 * 60_000;
const BATCH = 100;
const KEEP_PULLED_MS = 30 * 24 * 60 * 60_000;
/** More new rows than this in one pull are told as one notice, not one each. */
const NOTICES_EACH = 3;
export const WEBSITE_SOURCE = "Website";
/** A person who first came by the waitlist: their source in People. */
export const WAITLIST_SOURCE = "Website waitlist";

export const PULL_SQL = `SELECT id, created_at, name, email, phone, message, kind, form, data, topics FROM inquiries WHERE id > ? AND pulled_at IS NULL ORDER BY id LIMIT ${BATCH}`;
/** Branded email's events (siteDeploy.ts EMAIL_EVENTS_MIGRATION): unsubscribes and first clicks. */
export const EVENTS_SQL = `SELECT id, created_at, kind, ref, email, topics, link FROM email_events WHERE pulled_at IS NULL ORDER BY id LIMIT ${BATCH}`;
export type EmailEvent = { id: number; created_at: string; kind: string; ref: string; email: string | null; topics: string | null; link: number | null };

/** A row of the form; kind is missing from a row read before form kinds, and then it is an inquiry. */
export type Inquiry = { id: number; created_at: string; name: string; email: string; phone: string | null; message: string; kind?: string | null; form?: string | null; data?: string | null; topics?: string | null };

/** A designed site's own form's other answers (site Worker `data`), by the field's label; none when absent or unreadable. */
export function answersOf(row: Pick<Inquiry, "data">): [string, string][] {
  if (!row.data) return [];
  try {
    const parsed = JSON.parse(row.data) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "").slice(0, 20);
  } catch {
    return [];
  }
}

const isWaitlist = (row: Pick<Inquiry, "kind">): boolean => row.kind === "waitlist";
/** Who a row is from: the name they gave, else (a waitlist sign-up may give none) their email. */
const sender = (row: Pick<Inquiry, "name" | "email">): string => row.name.trim() || row.email.trim();

/** pull.json: the last row id pulled, and the day the old rows were last deleted. */
export type PullState = { cursor: number; swept?: string };

export type PullNotice = { key: string; title: string; body: string };

export type PullDeps = {
  stateDir: string;
  grant: () => Promise<Grant>;
  fetch: Fetch;
  /** The Space's store, for the agent's own writes; null when the Space is not open on this computer. The caller closes it. */
  store: (space: string) => ProjectDb | null;
  /** After writes to a Space's store: the place for a follow-up (index.ts gives none now). */
  stored: (space: string) => void;
  notify: (notice: PullNotice) => Promise<void>;
  log: (line: string) => void;
  now: () => number;
  /** A Space's email clicks into its send ledger (emailQueue.ts `click`), by the email job's id; absent, clicks are dropped. */
  clicks?: (space: string, clicks: { job: number; link: number; at: string }[]) => void;
};

type Site = { key: string; dir: string; record: SiteRecord & { worker: NonNullable<SiteRecord["worker"]>; database: NonNullable<SiteRecord["database"]> } };

/** The sites worth a pull: a database and something live. */
export function pullableSites(stateDir: string): Site[] {
  const root = join(stateDir, "sites");
  if (!existsSync(root)) return [];
  const sites: Site[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as SiteRecord;
      if (record?.version === 1 && record.worker && record.database && record.live) sites.push({ key: entry.name, dir, record: record as Site["record"] });
    } catch {
      // no record yet, or not one this agent wrote
    }
  }
  return sites.sort((a, b) => a.key.localeCompare(b.key));
}

export function readPullState(dir: string): PullState {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "pull.json"), "utf8")) as PullState;
    if (Number.isInteger(parsed?.cursor) && parsed.cursor >= 0) return parsed;
  } catch {
    // none yet
  }
  return { cursor: 0 };
}

function writePullState(dir: string, state: PullState): void {
  writePrivateFile(join(dir, "pull.json"), `${JSON.stringify(state)}\n`);
}

export const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

/**
 * One inquiry into the Space's store, as the agent: the person by email (or
 * added, source Website), then the message on their timeline. False when it
 * was there already (its ref).
 */
export function storeInquiry(db: ProjectDb, row: Inquiry): boolean {
  const ref = `inquiry:${row.id}`;
  if (db.queryRaw("SELECT 1 FROM interactions WHERE ref = ? AND source = ? LIMIT 1", [ref, WEBSITE_SOURCE]).rows.length) return false;
  const found = db.queryRaw("SELECT id FROM people WHERE archived_at IS NULL AND lower(email) = lower(?) ORDER BY id LIMIT 1", [row.email.trim()]).rows[0];
  let person = typeof found?.id === "number" ? found.id : null;
  if (person === null) {
    const added = db.write("person_add", { name: sender(row), email: row.email.trim(), ...(row.phone ? { phone: row.phone } : {}), source: isWaitlist(row) ? WAITLIST_SOURCE : WEBSITE_SOURCE }, BY_AGENT);
    person = added.changes.find((change) => change.table === "people" && change.op === "insert")?.id ?? null;
    if (person === null) throw new Error("person_add recorded no person");
  }
  const answers = answersOf(row);
  const kept = answers.filter(([label, value]) => keepAnswer(db, person!, label, value, row.form ?? "the website form"));
  const left = answers.filter((answer) => !kept.includes(answer));
  const said = [row.message.trim() ? oneLine(row.message, 120) : "", ...left.map(([label, value]) => `${label}: ${oneLine(value, 60)}`)].filter(Boolean).join("; ");
  const summary = row.form
    ? `Sent ${oneLine(row.form, 60)}${said ? `: ${oneLine(said, 200)}` : ""}`
    : isWaitlist(row)
      ? `Joined the website waitlist${said ? `: ${oneLine(said, 120)}` : ""}`
      : `Website inquiry: ${oneLine(said, 120)}`;
  db.write("interaction_add", { person_id: person, kind: "message", summary, on: row.created_at.slice(0, 10), source: WEBSITE_SOURCE, ref }, BY_AGENT);
  for (const topic of topicsOf(row.topics)) {
    try {
      db.write("topic_join_agent", { person_id: person, topic }, BY_AGENT);
    } catch (caught) {
      // Already in it, or a topic the Space does not have (any more): the tick changes nothing.
      if (!(caught instanceof RefusedError)) throw caught;
    }
  }
  return true;
}

/** A row's consent ticks or an unsubscribe's topics: names only, at most 20; null or unreadable is none. */
export function topicsOf(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string" && /^[A-Za-z0-9][A-Za-z0-9 '&/().,-]{0,39}$/.test(t)).slice(0, 20) : [];
  } catch {
    return [];
  }
}

/**
 * One unsubscribe into the Space's store, as the agent: every topic (topics
 * null) marks the address unsubscribed; named topics take each person with
 * that address off them. True when it changed something.
 */
export function storeUnsubscribe(db: ProjectDb, event: Pick<EmailEvent, "email" | "topics">): boolean {
  const email = (event.email ?? "").trim();
  if (!email) return false;
  if (event.topics === null) {
    db.write("email_status_set", { email, status: "unsubscribed", reason: "Unsubscribed from an email" }, BY_AGENT);
    return true;
  }
  let changed = false;
  const people = db.queryRaw("SELECT id FROM people WHERE lower(trim(email)) = lower(?)", [email]).rows;
  for (const topic of topicsOf(event.topics)) {
    for (const p of people) {
      try {
        db.write("topic_leave", { person_id: Number(p.id), topic }, BY_AGENT);
        changed = true;
      } catch (caught) {
        if (!(caught instanceof RefusedError)) throw caught;
      }
    }
  }
  return changed;
}

/** One answer into the Space's field of its label, added as text the first time; false when the Space will not take it. */
function keepAnswer(db: ProjectDb, person: number, label: string, value: string, form: string): boolean {
  try {
    const field = db.queryRaw("SELECT archived_at FROM person_fields WHERE lower(name) = lower(?) LIMIT 1", [label]).rows[0];
    if (!field || field.archived_at !== null) db.write("field_set", { name: label, ...(field ? {} : { kind: "text", describe: `From ${oneLine(form, 60)} on the website` }) }, BY_AGENT);
  } catch (caught) {
    if (caught instanceof RefusedError) return false;
    throw caught;
  }
  try {
    db.write("person_field_set", { person_id: person, field: label, value }, BY_AGENT);
  } catch (caught) {
    // The same value already is kept; a value the field's kind refuses is said on the timeline instead.
    if (!(caught instanceof RefusedError)) throw caught;
    return /already/.test(caught.message);
  }
  return true;
}

/** The notices for one pull's new rows (formLinks.ts says the same for a linked form). */
export function noticesFor(key: string, rows: readonly Omit<Inquiry, "id" | "created_at">[], inSpace: boolean): PullNotice[] {
  if (rows.length > NOTICES_EACH) {
    const names = rows.map((row) => oneLine(sender(row), 60));
    const signUps = rows.filter(isWaitlist).length;
    const what = signUps === rows.length ? "waitlist sign-ups" : signUps === 0 ? "website inquiries" : "website inquiries and sign-ups";
    return [{ key, title: `${rows.length} new ${what}`, body: `From ${names.slice(0, 10).join(", ")}${names.length > 10 ? " and others" : ""}.${inSpace ? " Each is on their page in People." : ""}` }];
  }
  return rows.map((row) =>
    row.form
      ? { key, title: `${oneLine(row.form, 60)}: ${oneLine(sender(row), 80)}`, body: `${row.email}${row.phone ? `, ${row.phone}` : ""}.${inSpace ? " They are in People." : `\n\n${[...answersOf(row).map(([l, v]) => `${l}: ${v}`), row.message].filter(Boolean).join("\n").slice(0, 2000)}`}` }
      : isWaitlist(row)
      ? { key, title: `New waitlist sign-up: ${oneLine(sender(row), 80)}`, body: `${row.email}${row.phone ? `, ${row.phone}` : ""}.${inSpace ? " They are in People." : ""}` }
      : {
          key,
          title: `New website inquiry from ${oneLine(sender(row), 80)}`,
          body: inSpace
            ? `${row.email}${row.phone ? `, ${row.phone}` : ""}. It is on their page in People: ${oneLine(row.message, 200)}`
            : `${row.email}${row.phone ? `, ${row.phone}` : ""}\n\n${row.message.slice(0, 2000)}`,
        },
  );
}

/** The pull, with its own memory of what it last said, so a lasting problem is logged once. */
export function sitePuller(deps: PullDeps): () => Promise<void> {
  const said = new Map<string, string>();
  // Databases brought up to date this run (migrateInquiries), so the check runs once per site, not every 5 minutes.
  const migrated = new Set<string>();
  const once = (what: string, problem: string) => {
    if (said.get(what) === problem) return;
    said.set(what, problem);
    deps.log(`website inquiries: ${what}: ${problem}`);
  };
  const why = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

  /** A Space site's unsubscribes into its People and clicks into its ledger, then marked pulled; a site outside a Space sends no email. */
  const pullEvents = async (site: Site, grant: Grant, database: string): Promise<void> => {
    const space = site.key.startsWith("space-") ? site.key.slice("space-".length) : null;
    if (!space) return;
    const events = await d1Query<EmailEvent>(deps.fetch, grant, database, EVENTS_SQL);
    if (events.length === 0) return;
    const db = deps.store(space);
    // Not open here: left in D1 for the computer that holds the Space.
    if (!db) return;
    let wrote = false;
    try {
      for (const event of events.filter((e) => e.kind === "unsubscribe")) {
        try {
          wrote = storeUnsubscribe(db, event) || wrote;
        } catch (caught) {
          if (!(caught instanceof RefusedError)) throw caught;
          deps.log(`email events: ${site.key}: unsubscribe ${event.id} not kept: ${caught.message}`);
        }
      }
    } finally {
      db.close();
      if (wrote) deps.stored(space);
    }
    const clicks = events.filter((e) => e.kind === "click" && /^j\d+$/.test(e.ref) && Number.isInteger(e.link)).map((e) => ({ job: Number(e.ref.slice(1)), link: e.link!, at: e.created_at }));
    if (clicks.length) deps.clicks?.(space, clicks);
    const ids = events.map((e) => e.id);
    await d1Query(deps.fetch, grant, database, `UPDATE email_events SET pulled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id IN (${ids.map(() => "?").join(", ")})`, ids);
    const left = events.length - clicks.length;
    deps.log(`email events: ${site.key}: ${left} unsubscribe(s), ${clicks.length} click(s) pulled`);
  };

  const pullSite = async (site: Site, grant: Grant): Promise<void> => {
    const database = site.record.database.id;
    if (!migrated.has(database)) {
      await migrateInquiries(deps.fetch, grant, database);
      migrated.add(database);
    }
    const state = readPullState(site.dir);
    const rows = await d1Query<Inquiry>(deps.fetch, grant, database, PULL_SQL, [state.cursor]);
    if (rows.length) {
      const space = site.key.startsWith("space-") ? site.key.slice("space-".length) : null;
      const db = space ? deps.store(space) : null;
      if (db && space) {
        let wrote = false;
        try {
          for (const row of rows) {
            try {
              wrote = storeInquiry(db, row) || wrote;
            } catch (caught) {
              // A row the store refuses (a name or address it cannot keep) is still told and marked; anything else stops the pull before the mark.
              if (!(caught instanceof RefusedError)) throw caught;
              deps.log(`website inquiries: ${site.key}: row ${row.id} not added to People: ${caught.message}`);
            }
          }
        } finally {
          db.close();
          if (wrote) deps.stored(space);
        }
      }
      const ids = rows.map((row) => row.id);
      await d1Query(deps.fetch, grant, database, `UPDATE inquiries SET pulled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id IN (${ids.map(() => "?").join(", ")})`, ids);
      writePullState(site.dir, { ...state, cursor: Math.max(state.cursor, ...ids) });
      deps.log(`website inquiries: ${site.key}: ${rows.length} pulled${db ? " into the Space's People" : ""}`);
      for (const notice of noticesFor(site.key, rows, db !== null)) {
        await deps.notify(notice).catch((caught: unknown) => deps.log(`website inquiries: ${site.key}: the notice did not go out: ${why(caught)}`));
      }
    }
    await pullEvents(site, grant, database);
    const today = new Date(deps.now()).toISOString().slice(0, 10);
    const current = readPullState(site.dir);
    if (current.swept !== today) {
      const before = new Date(deps.now() - KEEP_PULLED_MS).toISOString();
      await d1Query(deps.fetch, grant, database, "DELETE FROM inquiries WHERE pulled_at IS NOT NULL AND pulled_at < ?", [before]);
      await d1Query(deps.fetch, grant, database, "DELETE FROM email_events WHERE pulled_at IS NOT NULL AND pulled_at < ?", [before]);
      writePullState(site.dir, { ...current, swept: today });
    }
  };

  return async () => {
    const sites = pullableSites(deps.stateDir);
    if (sites.length === 0) return;
    let grant: Grant;
    try {
      grant = await deps.grant();
      said.delete("cloudflare");
    } catch (caught) {
      once("cloudflare", why(caught));
      return;
    }
    for (const site of sites) {
      if (site.record.worker.accountId !== grant.accountId) {
        once(site.key, "Cloudflare is connected to another account than the site's; not pulled");
        continue;
      }
      try {
        await pullSite(site, grant);
        said.delete(site.key);
      } catch (caught) {
        once(site.key, why(caught));
      }
    }
  };
}
