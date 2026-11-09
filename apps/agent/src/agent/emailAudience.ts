/**
 * Who a marketing email may go to, read
 * from the Space's store (trades/audience.ts): a current person with an
 * address, who joined the topic, whose address is not unsubscribed or
 * bounced, and who matches the segment's filter. Worked out when the card is
 * drawn and again right before each send (`mayGetMarketing`).
 */

import type { ProjectDb, Value } from "./dbTypes.ts";
import type { SegmentFilter } from "./trades/audience.ts";

export type Member = { id: number; name: string; email: string; organization: string | null };

/** At most this many in one audience: well past a day's cap, and the card still shows a count. */
export const AUDIENCE_MAX = 5000;

const JOINED = `EXISTS (SELECT 1 FROM person_topics pt JOIN email_topics t ON t.id = pt.topic_id
  WHERE pt.person_id = p.id AND pt.state = 'joined' AND t.name = ? COLLATE NOCASE AND t.archived_at IS NULL)`;
const STOPPED = "NOT EXISTS (SELECT 1 FROM email_status s WHERE s.email = trim(p.email) COLLATE NOCASE)";

export function readFilter(db: ProjectDb, segment: string): SegmentFilter | null {
  const row = db.queryRaw("SELECT filter FROM segments WHERE name = ? COLLATE NOCASE AND archived_at IS NULL", [segment]).rows[0];
  if (!row) return null;
  try {
    return JSON.parse(String(row.filter)) as SegmentFilter;
  } catch {
    return null;
  }
}

/** The WHERE for a topic and a filter, with its values. */
function where(topic: string, filter: SegmentFilter): { sql: string; values: Value[] } {
  const parts = ["p.archived_at IS NULL", "p.email IS NOT NULL", "trim(p.email) <> ''", JOINED, STOPPED];
  const values: Value[] = [topic];
  const inList = (column: string, list: string[]) => {
    parts.push(`${column} COLLATE NOCASE IN (${list.map(() => "?").join(", ")})`);
    values.push(...list);
  };
  if (filter.stages?.length) inList("p.stage", filter.stages);
  if (filter.sources?.length) inList("p.source", filter.sources);
  for (const other of filter.topics ?? []) {
    parts.push(JOINED);
    values.push(other);
  }
  for (const f of filter.fields ?? []) {
    parts.push("EXISTS (SELECT 1 FROM person_values v JOIN person_fields f ON f.id = v.field_id WHERE v.person_id = p.id AND f.name = ? COLLATE NOCASE AND v.value = ? COLLATE NOCASE)");
    values.push(f.field, f.is);
  }
  return { sql: parts.join(" AND "), values };
}

/** Everyone a campaign on this topic to this segment (none: the whole topic) goes to, one per address, by id. */
export function audienceOf(db: ProjectDb, topic: string, filter: SegmentFilter = {}): Member[] {
  const w = where(topic, filter);
  const rows = db.queryRaw(
    `SELECT q.id AS id, pp.name AS name, q.email AS email, pp.organization AS organization
     FROM (SELECT min(p.id) AS id, lower(trim(p.email)) AS email FROM people p WHERE ${w.sql} GROUP BY lower(trim(p.email))) q
     JOIN people pp ON pp.id = q.id ORDER BY q.id LIMIT ${AUDIENCE_MAX + 1}`,
    w.values,
    AUDIENCE_MAX + 1,
  ).rows;
  return rows.map((r) => ({ id: Number(r.id), name: String(r.name ?? ""), email: String(r.email), organization: typeof r.organization === "string" ? r.organization : null }));
}

/** Right before a send: whether this address still may get this topic's email (joined, not unsubscribed or bounced). */
export function mayGetMarketing(db: ProjectDb, email: string, topic: string): boolean {
  const w = where(topic, {});
  return db.queryRaw(`SELECT 1 FROM people p WHERE ${w.sql} AND lower(trim(p.email)) = lower(?) LIMIT 1`, [...w.values, email.trim()]).rows.length > 0;
}

/** Whether an address is stopped for everything (a bounce stops transactional mail too). */
export function statusOf(db: ProjectDb, email: string): "unsubscribed" | "bounced" | null {
  const row = db.queryRaw("SELECT status FROM email_status WHERE email = ? COLLATE NOCASE", [email.trim()]).rows[0];
  return row?.status === "unsubscribed" || row?.status === "bounced" ? row.status : null;
}

/** The topics an address is in, by name, for its unsubscribe page. */
export function topicsOfEmail(db: ProjectDb, email: string): string[] {
  return db
    .queryRaw(
      `SELECT DISTINCT t.name AS name FROM person_topics pt JOIN email_topics t ON t.id = pt.topic_id JOIN people p ON p.id = pt.person_id
       WHERE pt.state = 'joined' AND t.archived_at IS NULL AND lower(trim(p.email)) = lower(?) ORDER BY t.name LIMIT 20`,
      [email.trim()],
    )
    .rows.map((r) => String(r.name));
}
