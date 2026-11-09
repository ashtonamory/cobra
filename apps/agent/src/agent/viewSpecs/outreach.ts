// The Outreach trade's views: the Marketing seat's
// board, named by the Space's kind (Marketing, Announcements, Messages). How
// outreach email is doing (sent, replies, the reply rate over the range), then
// the email lists from People's tables, each left off while it is empty: who
// waits to be allowed onto a list, the sequences, and who stopped getting mail.
// Every seat reads the one Space store, so these read People's tables.
import type { ViewSpec } from "../../../../../packages/contracts/src/views.ts";

/** An email the agent sent from the Space (emailLive.ts EMAIL_SOURCE), not a reply logged on the timeline. */
const SENT = "kind = 'email' AND source = 'Cobra email' AND ref LIKE 'email:%'";
const REPLY = "kind = 'email' AND ref LIKE 'reply:%'";

export const OUTREACH_VIEWS: readonly ViewSpec[] = [
  {
    id: "outreach-kpis",
    title: "Email",
    kind: "chart",
    hideEmpty: true,
    sql: `
      SELECT 'now' AS now,
        (SELECT COUNT(*) FROM interactions WHERE ${SENT} AND happened_on >= ? AND happened_on <= ?) AS sent,
        (SELECT COUNT(*) FROM interactions WHERE ${REPLY} AND happened_on >= ? AND happened_on <= ?) AS replies,
        (SELECT CASE WHEN s.n = 0 THEN 0 ELSE ROUND(100.0 * r.n / s.n) END
           FROM (SELECT COUNT(*) AS n FROM interactions WHERE ${SENT} AND happened_on >= ? AND happened_on <= ?) s,
                (SELECT COUNT(*) AS n FROM interactions WHERE ${REPLY} AND happened_on >= ? AND happened_on <= ?) r) AS reply_rate`,
    params: ["rangeStart", "rangeEnd", "rangeStart", "rangeEnd", "rangeStart", "rangeEnd", "rangeStart", "rangeEnd"],
    chart: {
      type: "kpi", x: "now", xKind: "text", ranged: true, total: "last",
      series: [
        { column: "sent", label: "Emails sent" },
        { column: "replies", label: "Replies" },
        { column: "reply_rate", label: "Reply rate", format: "percent" },
      ],
    },
  },
  {
    id: "replies",
    title: "Replies",
    kind: "list",
    onBoard: true,
    hideEmpty: true,
    peek: 5,
    sql: `
      SELECT i.id AS id, p.name AS name, i.summary AS summary, i.happened_on AS happened_on
        FROM interactions i JOIN people p ON p.id = i.person_id
       WHERE i.kind = 'email' AND i.ref LIKE 'reply:%'
       ORDER BY i.happened_on DESC, i.id DESC LIMIT 201`,
    row: { id: "id", title: "name", subtitle: "summary", trailing: "happened_on" },
    formats: { happened_on: "date" },
  },
  {
    id: "email-to-allow",
    title: "Email list: to allow",
    kind: "list",
    onBoard: true,
    hideEmpty: true,
    today: true,
    sql: `
      SELECT pt.id AS id, p.name AS title, 'Add to ' || t.name || ': ' || COALESCE(pt.note, '') AS subtitle, 'To allow' AS badge
        FROM person_topics pt JOIN people p ON p.id = pt.person_id JOIN email_topics t ON t.id = pt.topic_id
       WHERE pt.state = 'proposed'
       ORDER BY t.name, p.name LIMIT 201`,
    row: { id: "id", title: "title", subtitle: "subtitle", badge: "badge" },
    actions: [
      { mutation: "topic_allow", label: "Allow", on: "row", fixed: { id: "id" } },
      { mutation: "topic_decline", label: "Drop", on: "row", fixed: { id: "id" } },
    ],
  },
  {
    id: "email-stopped",
    title: "Email list: stopped",
    kind: "list",
    onBoard: true,
    hideEmpty: true,
    sql: `
      SELECT s.id AS id, s.email AS title,
             COALESCE(s.reason, CASE s.status WHEN 'bounced' THEN 'The address does not exist' ELSE 'Asked for no marketing email' END) AS subtitle,
             CASE s.status WHEN 'bounced' THEN 'Bounced' ELSE 'Unsubscribed' END AS badge, s.since AS since
        FROM email_status s
       ORDER BY s.since DESC LIMIT 201`,
    row: { id: "id", title: "title", subtitle: "subtitle", badge: "badge", trailing: "since" },
    actions: [{ mutation: "email_status_clear", label: "Let them back", on: "row", fixed: { id: "id" }, confirm: true }],
  },
  {
    id: "email-sequences",
    title: "Email sequences",
    kind: "list",
    onBoard: true,
    hideEmpty: true,
    sql: `
      SELECT q.id AS id, q.name || ' v' || q.version AS title, q.trigger || ' · ' || q.steps || CASE q.steps WHEN 1 THEN ' email' ELSE ' emails' END AS subtitle,
             CASE q.state WHEN 'paused' THEN 'Paused' ELSE 'Running' END AS badge, q.state AS state, q.updated_at AS since
        FROM email_sequences q
       ORDER BY q.name LIMIT 201`,
    row: { id: "id", title: "title", subtitle: "subtitle", badge: "badge", trailing: "since" },
    actions: [
      { mutation: "sequence_pause", label: "Pause", on: "row", fixed: { id: "id" }, showWhen: { column: "state", equals: "active" } },
      { mutation: "sequence_resume", label: "Resume", on: "row", fixed: { id: "id" }, showWhen: { column: "state", equals: "paused" } },
    ],
  },];
