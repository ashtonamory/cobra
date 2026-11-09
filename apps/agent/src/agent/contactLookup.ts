// contact_lookup: Cobra's one read of a Space's People (JK-PLAN-WF-001,
// "split + checkpoint", 6 Nov). Before she shows the person a list of
// prospects she found herself, she checks which of them the Space already
// holds, without waking the CRM Foreman for it (that check alone cost more
// than the research it guarded). It loosens "Cobra gets no Space tools" for
// this read only: she still never writes a record, and every other read of a
// store stays the Foremen's (orch.ts FOREMAN_ONLY).
//
//   POST /orch/contacts/lookup {space, query: [up to 50 strings]}
//
// Each query string is an email (matched whole, case aside), a website or
// domain (matched by host, www. left off, against the Space's website field
// and the domain of each email), or a name (found in a person's name or
// business, case aside). Each answer is at most CONTACT_MATCHES_MAX people
// with their name, email, website, business and when they were added: never
// a note, a timeline, a phone, an address or any other column.
//
// The store is opened read-only at the SQLite level, so nothing here can
// change it, and never created: a Space that has no store yet is a 404.
import { existsSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { spaceStorePath } from "./db.ts";
import { siteKey, WEBSITE } from "./trades/people.ts";
import { readSpace, SPACES_DIR } from "./spaces.ts";

export const CONTACT_LOOKUP_ROUTE = "/orch/contacts/lookup";

/** The most strings one lookup checks, and the longest each may be. */
export const CONTACT_QUERIES_MAX = 50;
export const CONTACT_QUERY_CHARS = 200;
/** The most people one query string answers with; `more` says there were others. */
export const CONTACT_MATCHES_MAX = 10;

export type ContactMatch = { name: string; email: string | null; website: string | null; company: string | null; added: string };
export type QueryKind = "email" | "website" | "name";
export type ContactAnswer = { query: string; kind: QueryKind; matches: ContactMatch[]; more?: true };

export type ContactDeps = {
  spacesRoot: string;
  /** Where a Space's store lies (db.ts spaceStorePath); tests name their own. */
  storePath: (space: string) => string;
};

export const liveContactDeps = (): ContactDeps => ({ spacesRoot: SPACES_DIR, storePath: (space) => spaceStorePath(space) });

type Reply = { status: number; body: unknown };

/** What a query string is: an address has an @, a site has a scheme or a dotted host and no spaces, anything else is a name. */
export function queryKind(query: string): QueryKind {
  if (/^[^\s@]+@[^\s@]+$/.test(query)) return "email";
  if (/^https?:\/\//i.test(query) || /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]\S*)?$/i.test(query)) return "website";
  return "name";
}

/** The store's file opened read-only, or null when the Space has none yet. */
export function openStoreReadOnly(path: string): DatabaseSync | null {
  if (!existsSync(path)) return null;
  return new DatabaseSync(path, { readOnly: true });
}

const text = (value: unknown): string | null => (value === null || value === undefined || value === "" ? null : String(value));
const likeEscaped = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Every query string's matches in an open People store (one with a people table). */
export function lookupContacts(db: DatabaseSync, queries: readonly string[]): ContactAnswer[] {
  const has = (table: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
  // The Space's website field(s): a field named Website, Site or URL, as people_import matches by.
  const siteFields = has("person_fields") ? db.prepare("SELECT id, name FROM person_fields").all().filter((row) => WEBSITE.test(String(row.name))).map((row) => Number(row.id)) : [];
  const websites = new Map<number, string>();
  if (siteFields.length > 0) {
    const rows = db.prepare(`SELECT person_id, value FROM person_values WHERE field_id IN (${siteFields.map(() => "?").join(", ")}) ORDER BY id`).all(...siteFields);
    for (const row of rows) if (!websites.has(Number(row.person_id))) websites.set(Number(row.person_id), String(row.value));
  }
  const PICK = "SELECT id, name, email, organization, created_at FROM people";
  const people = (where: string, params: SQLInputValue[]) => db.prepare(`${PICK} WHERE ${where} ORDER BY id LIMIT ${CONTACT_MATCHES_MAX + 1}`).all(...params);

  return queries.map((query): ContactAnswer => {
    const kind = queryKind(query);
    let rows: Array<Record<string, unknown>>;
    if (kind === "email") {
      rows = people("lower(email) = ?", [query.toLowerCase()]);
    } else if (kind === "website") {
      const host = siteKey(query);
      const bySite = [...websites].filter(([, value]) => siteKey(value) === host).map(([id]) => id);
      // An email at the domain is the same business: agent@kw.com for kw.com.
      const params: SQLInputValue[] = [host, host.startsWith("www.") ? host.slice(4) : host, ...bySite];
      rows = people(`(lower(substr(email, instr(email, '@') + 1)) IN (?, ?) AND instr(email, '@') > 0)${bySite.length ? ` OR id IN (${bySite.map(() => "?").join(", ")})` : ""}`, params);
    } else {
      const like = `%${likeEscaped(query.toLowerCase())}%`;
      rows = people("lower(name) LIKE ? ESCAPE '\\' OR lower(organization) LIKE ? ESCAPE '\\'", [like, like]);
    }
    const matches = rows.slice(0, CONTACT_MATCHES_MAX).map((row) => ({
      name: String(row.name),
      email: text(row.email),
      website: websites.get(Number(row.id)) ?? null,
      company: text(row.organization),
      added: String(row.created_at),
    }));
    return { query, kind, matches, ...(rows.length > CONTACT_MATCHES_MAX ? { more: true as const } : {}) };
  });
}

/** The route's work, once orch.ts has found the caller is the Lead on this computer. */
export function handleContactLookup(body: Record<string, unknown>, deps: ContactDeps): Reply {
  const id = typeof body.space === "string" ? body.space.trim() : "";
  const raw = body.query;
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((entry) => typeof entry !== "string")) {
    return { status: 400, body: { error: `query is a list of 1 to ${CONTACT_QUERIES_MAX} names, emails or websites` } };
  }
  if (raw.length > CONTACT_QUERIES_MAX) return { status: 400, body: { error: `at most ${CONTACT_QUERIES_MAX} names, emails or websites in one lookup; split the list` } };
  const queries = [...new Set((raw as string[]).map((entry) => entry.trim().slice(0, CONTACT_QUERY_CHARS)).filter((entry) => entry.length >= 2))];
  if (queries.length === 0) return { status: 400, body: { error: "every query string was empty or one character" } };
  let space;
  try {
    space = id ? readSpace(id, deps.spacesRoot) : null;
  } catch {
    space = null;
  }
  if (!space) return { status: 404, body: { error: `no Space ${id || "(none given)"} is open on this computer: space is a company id from org_read` } };
  const db = openStoreReadOnly(deps.storePath(space.id));
  if (!db) return { status: 404, body: { error: `${space.name} keeps no contacts yet: it has no store, so none of these is a duplicate` } };
  try {
    const hasPeople = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'people'").get() !== undefined;
    if (!hasPeople) return { status: 404, body: { error: `${space.name} keeps no contacts yet: its store has no People, so none of these is a duplicate` } };
    return { status: 200, body: { space: space.id, answers: lookupContacts(db, queries) } };
  } finally {
    db.close();
  }
}
