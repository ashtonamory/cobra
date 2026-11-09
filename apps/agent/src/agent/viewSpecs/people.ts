// The People trade's views: the CRM
// of a business, the roster of a team, the contacts of a family, one set of
// screens. The apps name them by the Space's kind (CRM, Roster, Contacts);
// the specs say only "people".
//
// The board is the whole CRM on the phone: the
// summary strip, Next up (who to contact next: a reply waiting, a follow-up
// due, someone new from the website), People with its stage chips and a
// List | Board switch, then Coming up and the deals' numbers, each left off
// while it has nothing in it. The rest stay tabs for the dashboard screen.
import type { ViewSpec } from "../../../../../packages/contracts/src/views.ts";

/** A deal still in play: not set aside, at an open stage. */
const OPEN_DEAL = "d.archived_at IS NULL AND s.closed = 0";

/** Each deal with its stage's place, whether that stage is an end, and where a lost one was lost: the funnel's counting. */
const DEALS_WITH_STAGES = `
  SELECT d.*, s.position AS pos, s.closed AS ended, s.won AS won, ls.position AS lost_pos
    FROM deals d JOIN deal_stages s ON s.name = d.stage LEFT JOIN deal_stages ls ON ls.name = d.lost_stage
   WHERE d.archived_at IS NULL`;

/** A touch: something said to or by the person (not a note, a stage move or "Added"). */
const TOUCH = "kind IN ('email', 'call', 'meeting', 'message')";
/** A touch from the Space's side: not their reply, not what they sent from the website. */
const OUTBOUND = `${TOUCH} AND COALESCE(ref, '') NOT LIKE 'reply:%' AND COALESCE(source, '') <> 'Website'`;

/** Each person's newest touch, one row each (person_id, kind, ref, source, happened_on, created_at). */
const LAST_TOUCH = `
  SELECT i.person_id, i.kind, i.ref, i.source, i.happened_on, i.created_at FROM interactions i
   WHERE i.id = (SELECT j.id FROM interactions j WHERE j.person_id = i.person_id AND j.${TOUCH} ORDER BY j.created_at DESC, j.id DESC LIMIT 1)`;

/** The place-named fields PLACE reads, which the header shows rather than Details. */
const PLACE_FIELDS = "('location', 'city', 'town', 'area', 'place')";

/** Where the person is, from one of the Space's own fields with a place's name (such as a CRM's Location). */
const PLACE = `(SELECT v.value FROM person_values v JOIN person_fields f ON f.id = v.field_id
   WHERE v.person_id = p.id AND f.archived_at IS NULL AND lower(f.name) IN ${PLACE_FIELDS}
   ORDER BY f.position, f.id LIMIT 1)`;

/** A follow-up of this person due today or earlier (binds today). */
const DUE = "EXISTS (SELECT 1 FROM follow_ups f WHERE f.person_id = p.id AND f.done_at IS NULL AND f.due_on <= ?)";

/** "3 Nov" from a YYYY-MM-DD (SQLite's strftime has no month names). */
const day = (column: string): string =>
  `(CAST(strftime('%d', ${column}) AS INTEGER) || ' ' || substr('JanFebMarAprMayJunJulAugSepOctNovDec', CAST(strftime('%m', ${column}) AS INTEGER) * 3 - 2, 3))`;

/** People whose newest reply came after the Space last wrote to them: waiting on you. */
const UNANSWERED = `
  SELECT r.person_id AS person_id FROM interactions r JOIN people p ON p.id = r.person_id AND p.archived_at IS NULL
   WHERE r.ref LIKE 'reply:%'
   GROUP BY r.person_id
  HAVING MAX(r.created_at) > COALESCE((SELECT MAX(o.created_at) FROM interactions o
                                        WHERE o.person_id = r.person_id AND o.kind IN ('email', 'call', 'meeting', 'message')
                                          AND COALESCE(o.ref, '') NOT LIKE 'reply:%' AND COALESCE(o.source, '') <> 'Website'), '')`;

/** An email logged twice: a seat's own line when the agent logged the same email as Cobra email that day (the timeline shows it once). */
const DOUBLE_EMAIL = `i.kind = 'email' AND COALESCE(i.source, '') <> 'Cobra email' AND COALESCE(i.ref, '') NOT LIKE 'reply:%'
  AND EXISTS (SELECT 1 FROM interactions j WHERE j.person_id = i.person_id AND j.source = 'Cobra email'
               AND j.happened_on = i.happened_on AND COALESCE(j.ref, '') NOT LIKE 'reply:%')`;

/** A person's notes and everything else in one line of time, newest first (binds the person's id twice). */
function timeline(limit: number): string {
  return `
          SELECT 'n' || n.id AS id, n.body AS summary, 'note' AS kind, n.written_on AS happened_on, NULL AS source, n.created_at AS at
            FROM person_notes n WHERE n.person_id = ?
          UNION ALL
          SELECT 'i' || i.id, i.summary, i.kind, i.happened_on, i.source, i.created_at FROM interactions i
           WHERE i.person_id = ? AND i.kind <> 'note' AND NOT (${DOUBLE_EMAIL})
           ORDER BY happened_on DESC, at DESC LIMIT ${limit}`;
}

// --- the desk's CRM board ---------------------------

/** A card's lane: its stage when that is one of the Space's stages, else '(none)'. */
const LANE = "CASE WHEN p.stage IN (SELECT name FROM stages) THEN p.stage ELSE '(none)' END";

/** "today", "3d": how long ago a day was, against `t.today`. */
const ago = (column: string): string =>
  `CASE WHEN CAST(julianday(t.today) - julianday(${column}) AS INTEGER) <= 0 THEN 'today' ELSE CAST(julianday(t.today) - julianday(${column}) AS INTEGER) || 'd' END`;

/** The Space wrote to them: a touch of its own (not their reply, not the website). */
const WRITTEN_TO = `EXISTS (SELECT 1 FROM interactions o WHERE o.person_id = p.id AND o.kind IN ('email', 'call', 'meeting', 'message')
  AND COALESCE(o.ref, '') NOT LIKE 'reply:%' AND COALESCE(o.source, '') <> 'Website')`;

/** They came from the website: its form, or a source that says so (a waitlist sign-up). */
const FROM_WEBSITE = `(lower(COALESCE(p.source, '')) LIKE '%website%' OR EXISTS (SELECT 1 FROM interactions w WHERE w.person_id = p.id AND w.source = 'Website'))`;

/** A source cut where a year starts (" 2026-11-03 (batch 2)"), with no comma in it. */
const SOURCE_CUT = "replace(CASE WHEN instr(COALESCE(p.source, ''), ' 20') > 1 THEN substr(p.source, 1, instr(p.source, ' 20') - 1) ELSE COALESCE(p.source, '') END, ',', ' ')";
/** Where they came from, without a prospect search's date ("Daily prospect search 2026-11-03 (batch 2)" is "Daily prospect search"); a page's address is "Web page". */
const SOURCE_KEY = `CASE WHEN p.source LIKE 'http%' THEN 'Web page' ELSE COALESCE(NULLIF(trim(rtrim(${SOURCE_CUT}, '0123456789- ')), ''), '(none)') END`;
/** Where they are, as a filter key. */
const PLACE_KEY = `replace(${PLACE}, ',', ' ')`;

/** The Show group's picks, each a test of the person (binds facet:show five times). */
const SHOW_FILTER = `(? = ''
  OR (instr(?, ',due,') > 0 AND EXISTS (SELECT 1 FROM follow_ups f WHERE f.person_id = p.id AND f.done_at IS NULL AND f.due_on <= t.today))
  OR (instr(?, ',waiting,') > 0 AND p.id IN (${UNANSWERED}))
  OR (instr(?, ',website,') > 0 AND ${FROM_WEBSITE})
  OR (instr(?, ',new,') > 0 AND NOT ${WRITTEN_TO}))`;

export const PEOPLE_VIEWS: readonly ViewSpec[] = [
  {
    id: "summary",
    title: "People",
    kind: "tiles",
    summary: true,
    onBoard: true,
    sql: `
      SELECT 'People' AS label, COUNT(*) AS value, 'current' AS caption, NULL AS tone FROM people WHERE archived_at IS NULL
      UNION ALL
      SELECT 'Due', COUNT(DISTINCT f.person_id), 'to follow up', CASE WHEN COUNT(*) > 0 THEN 'warn' END
        FROM follow_ups f JOIN people p ON p.id = f.person_id AND p.archived_at IS NULL WHERE f.done_at IS NULL AND f.due_on <= ?
      UNION ALL
      SELECT 'Replies', COUNT(*), 'waiting on you', CASE WHEN COUNT(*) > 0 THEN 'good' END FROM (${UNANSWERED})`,
    params: ["today"],
  },
  {
    id: "next-up",
    title: "Next up",
    kind: "list",
    onBoard: true,
    hideEmpty: true,
    today: true,
    opens: "person",
    // One row a person, the most pressing first: a reply waiting on you, then a follow-up due (overdue in red), then someone new from the website the Space has not written to.
    sql: `
      WITH outbound AS (SELECT person_id, MAX(created_at) AS at FROM interactions WHERE ${OUTBOUND} GROUP BY person_id),
      replied AS (
        SELECT i.person_id, i.summary, i.happened_on, i.created_at AS at FROM interactions i
         WHERE i.ref LIKE 'reply:%' AND i.id = (SELECT j.id FROM interactions j WHERE j.person_id = i.person_id AND j.ref LIKE 'reply:%' ORDER BY j.created_at DESC, j.id DESC LIMIT 1)),
      web AS (
        SELECT i.person_id, i.summary, i.happened_on, i.created_at AS at FROM interactions i
         WHERE i.source = 'Website' AND i.id = (SELECT j.id FROM interactions j WHERE j.person_id = i.person_id AND j.source = 'Website' ORDER BY j.created_at DESC, j.id DESC LIMIT 1)),
      due AS (
        SELECT f.person_id, f.why, f.due_on FROM follow_ups f
         WHERE f.done_at IS NULL AND f.due_on <= ?
           AND f.id = (SELECT g.id FROM follow_ups g WHERE g.person_id = f.person_id AND g.done_at IS NULL ORDER BY g.due_on, g.id LIMIT 1)),
      items AS (
        SELECT r.person_id, 0 AS rank, r.summary AS line, 'good' AS tone, 'Reply' AS cta, r.happened_on AS on_day
          FROM replied r LEFT JOIN outbound o ON o.person_id = r.person_id WHERE o.at IS NULL OR r.at > o.at
        UNION ALL
        SELECT d.person_id, 1, d.why || ' · due ' || ${day("d.due_on")}, CASE WHEN d.due_on < ? THEN 'bad' ELSE 'warn' END, 'Follow up', d.due_on FROM due d
        UNION ALL
        SELECT w.person_id, 2, 'From the website: ' || w.summary, NULL, 'Say hello', w.happened_on
          FROM web w LEFT JOIN outbound o ON o.person_id = w.person_id WHERE o.at IS NULL OR w.at > o.at)
      SELECT p.id AS id, p.name AS name, COALESCE(NULLIF(p.organization, ''), p.email) AS organization, it.line AS line, it.tone AS tone, it.cta AS cta
        FROM items it JOIN people p ON p.id = it.person_id
       WHERE p.archived_at IS NULL AND it.rank = (SELECT MIN(x.rank) FROM items x WHERE x.person_id = it.person_id)
       ORDER BY it.rank, it.on_day, p.id LIMIT 201`,
    params: ["today", "today"],
    row: { id: "id", title: "name", subtitle: "organization", detail: "line", tone: "tone", cta: "cta" },
    actions: [{ mutation: "follow_up_rule_set", label: "Follow-up timing", on: "view" }],
  },
  {
    id: "people",
    title: "People",
    kind: "list",
    onBoard: true,
    searchable: true,
    opens: "person",
    alt: "board",
    peek: 6,
    // Their company and place, then what last happened (a reply in green, a follow-up due in orange) and when; those waiting on you first, then the freshest.
    // A stage chip is sent as `key` ('(none)' for no stage); empty is everyone.
    sql: `
      WITH lt AS (${LAST_TOUCH})
      SELECT p.id AS id, p.name AS name,
             COALESCE(NULLIF(trim(COALESCE(NULLIF(NULLIF(p.organization, ''), p.name), '') || COALESCE(' · ' || ${PLACE}, ''), ' ·'), ''), p.email, '') AS place,
             CASE
               WHEN lt.ref LIKE 'reply:%' THEN 'Replied'
               WHEN lt.source = 'Website' THEN 'Wrote in from the website'
               WHEN lt.kind = 'email' AND ${DUE} THEN 'Emailed · no reply · follow-up due'
               WHEN lt.kind = 'email' THEN 'Emailed · no reply'
               WHEN lt.kind = 'call' THEN 'Called'
               WHEN lt.kind = 'meeting' THEN 'Met'
               WHEN lt.kind = 'message' THEN 'Messaged'
               WHEN COALESCE(p.source, '') <> '' THEN 'Added from ' || p.source
               ELSE 'Added' END AS touch,
             CASE WHEN lt.ref LIKE 'reply:%' THEN 'good' WHEN ${DUE} THEN 'warn' END AS tone,
             COALESCE(lt.happened_on, substr(p.created_at, 1, 10)) AS last_on
        FROM people p LEFT JOIN lt ON lt.person_id = p.id
       WHERE p.archived_at IS NULL
         AND (? = '' OR COALESCE(NULLIF(p.stage, ''), '(none)') = ?)
         AND (? = '' OR p.name LIKE ? ESCAPE '\\' OR p.organization LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\'
              OR EXISTS (SELECT 1 FROM person_values v JOIN person_fields f ON f.id = v.field_id
                          WHERE v.person_id = p.id AND f.archived_at IS NULL AND v.value LIKE ? ESCAPE '\\'))
       ORDER BY CASE WHEN lt.ref LIKE 'reply:%' THEN 0 WHEN ${DUE} THEN 1 ELSE 2 END, lt.created_at IS NULL, lt.created_at DESC, p.name COLLATE NOCASE
       LIMIT 201`,
    params: ["today", "today", "key", "key", "q", "like", "like", "like", "like", "today"],
    chipsSql: `
      SELECT COALESCE(NULLIF(p.stage, ''), '(none)') AS key, COALESCE(NULLIF(p.stage, ''), 'No stage') AS label, COUNT(*) AS count
        FROM people p LEFT JOIN stages s ON s.name = p.stage
       WHERE p.archived_at IS NULL
       GROUP BY 1, 2 ORDER BY MIN(COALESCE(s.position, 0)), 1`,
    row: { id: "id", title: "name", subtitle: "place", detail: "touch", tone: "tone", trailing: "last_on" },
    formats: { last_on: "date" },
    actions: [
      { mutation: "person_add", label: "Add a person", on: "view" },
      { mutation: "field_set", label: "Track something new", on: "view" },
    ],
  },
  {
    id: "board",
    title: "Board",
    kind: "board",
    opens: "person",
    lanesSql: "SELECT name, COALESCE(closed, 0) AS closed FROM stages ORDER BY position, id",
    sql: `
      SELECT id, name, organization, COALESCE(stage, '') AS stage FROM people
       WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE LIMIT 201`,
    row: { id: "id", title: "name", subtitle: "organization", lane: "stage" },
    actions: [{ mutation: "stage_set", label: "Add a stage", on: "view" }],
  },
  {
    id: "coming-up",
    title: "Coming up",
    kind: "list",
    onBoard: true,
    hideEmpty: true,
    peek: 3,
    opens: "person",
    // Follow-ups after today; the ones due are in Next up.
    sql: `
      SELECT f.id AS id, f.person_id AS person_id, p.name AS name, f.why AS why, f.due_on AS due_on
        FROM follow_ups f JOIN people p ON p.id = f.person_id
       WHERE f.done_at IS NULL AND p.archived_at IS NULL AND f.due_on > ?
       ORDER BY f.due_on, f.id LIMIT 201`,
    params: ["today"],
    row: { id: "person_id", title: "name", subtitle: "why", trailing: "due_on" },
    formats: { due_on: "date" },
  },
  {
    id: "followups",
    title: "Follow-ups",
    kind: "list",
    opens: "person",
    sql: `
      SELECT f.id AS id, f.person_id AS person_id, p.name AS name, f.why AS why, f.due_on AS due_on,
             CASE WHEN f.due_on < ? THEN 'bad' WHEN f.due_on = ? THEN 'warn' END AS tone
        FROM follow_ups f JOIN people p ON p.id = f.person_id
       WHERE f.done_at IS NULL AND p.archived_at IS NULL
       ORDER BY f.due_on, f.id LIMIT 201`,
    params: ["today", "today"],
    row: { id: "person_id", title: "name", subtitle: "why", trailing: "due_on", tone: "tone" },
    formats: { due_on: "date" },
    actions: [{ mutation: "follow_up_add", label: "Add a follow-up", on: "view" }],
  },
  {
    id: "inquiries",
    title: "Website inquiries",
    kind: "list",
    opens: "person",
    // What the website's contact form brought in (the agent's sitePull.ts writes them with source Website), newest first. Next up has the new ones.
    sql: `
      SELECT i.id AS id, i.person_id AS person_id, p.name AS name, i.summary AS summary, i.happened_on AS happened_on
        FROM interactions i JOIN people p ON p.id = i.person_id
       WHERE i.source = 'Website'
       ORDER BY i.happened_on DESC, i.id DESC LIMIT 201`,
    row: { id: "person_id", title: "name", subtitle: "summary", trailing: "happened_on" },
    formats: { happened_on: "date" },
  },
  // Email: the Marketing seat's board draws these (viewSpecs/outreach.ts); People keeps them as tabs for a Space with no Marketing seat.
  {
    id: "email-to-allow",
    title: "Email list: to allow",
    kind: "list",
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
  },  // The deals' board: deals' worth, what is likely to close, and the pipeline's funnel. Deals are an add-on: none, and the board leaves them off.
  {
    id: "crm-kpis",
    title: "Pipeline",
    kind: "chart",
    hideEmpty: true,
    // Pipeline and likely-to-close are now; win rate and the average won deal follow the range.
    sql: `
      SELECT 'now' AS now,
        (SELECT COALESCE(SUM(d.value_cents), 0) FROM deals d JOIN deal_stages s ON s.name = d.stage WHERE ${OPEN_DEAL}) AS pipeline_cents,
        (SELECT COALESCE(SUM(d.value_cents * s.chance / 100), 0) FROM deals d JOIN deal_stages s ON s.name = d.stage WHERE ${OPEN_DEAL}) AS likely_cents,
        (SELECT COALESCE(ROUND(100.0 * SUM(outcome = 'won') / COUNT(*)), 0) FROM deals
          WHERE archived_at IS NULL AND outcome IS NOT NULL AND closed_on >= ? AND closed_on <= ?) AS win_rate,
        (SELECT COALESCE(ROUND(AVG(value_cents)), 0) FROM deals
          WHERE archived_at IS NULL AND outcome = 'won' AND closed_on >= ? AND closed_on <= ?) AS average_cents`,
    params: ["rangeStart", "rangeEnd", "rangeStart", "rangeEnd"],
    chart: {
      type: "kpi", x: "now", xKind: "text", format: "money", ranged: true, total: "last",
      series: [
        { column: "pipeline_cents", label: "Pipeline" }, { column: "likely_cents", label: "Likely to close" },
        { column: "win_rate", label: "Win rate", format: "percent" }, { column: "average_cents", label: "Average deal won" },
      ],
    },
  },
  {
    id: "pipeline",
    title: "Pipeline by stage",
    kind: "chart",
    hideEmpty: true,
    // Every open stage and the won end, in order: the worth and count of deals there now, and how many ever got this far
    // (an open deal at or past it, every won deal, a lost one lost at or past it).
    sql: `
      WITH d AS (${DEALS_WITH_STAGES})
      SELECT st.name AS stage,
             COALESCE((SELECT SUM(value_cents) FROM d WHERE d.stage = st.name), 0) AS value_cents,
             (SELECT COUNT(*) FROM d WHERE d.stage = st.name) AS deals,
             CASE WHEN st.closed = 1 THEN (SELECT COUNT(*) FROM d WHERE d.won = 1)
                  ELSE (SELECT COUNT(*) FROM d WHERE (d.ended = 0 AND d.pos >= st.position) OR d.won = 1 OR (d.won = 0 AND d.lost_pos >= st.position)) END AS reached
        FROM deal_stages st WHERE st.closed = 0 OR st.won = 1 ORDER BY st.position, st.id`,
    chart: {
      type: "funnel", x: "stage", xKind: "text", format: "money", count: "deals", reached: "reached", drill: "stage-deals",
      series: [{ column: "value_cents", label: "Worth" }], empty: "No deals yet. Open one from a person's page.",
    },
  },
  {
    id: "deals",
    title: "Deals",
    kind: "board",
    opens: "deal",
    lanesSql: "SELECT name, closed FROM deal_stages ORDER BY position, id",
    sql: `
      SELECT d.id AS id, d.title AS title, p.name || ' · ' || printf('%.2f', d.value_cents / 100.0) AS subtitle, d.stage AS stage
        FROM deals d JOIN people p ON p.id = d.person_id
       WHERE d.archived_at IS NULL AND (d.closed_on IS NULL OR d.closed_on >= ?)
       ORDER BY d.value_cents DESC, d.id LIMIT 201`,
    params: ["daysAgo30"],
    row: { id: "id", title: "title", subtitle: "subtitle", lane: "stage" },
    actions: [{ mutation: "deal_stage_set", label: "Change a stage", on: "view" }],
  },
  {
    id: "closing",
    title: "Closing soon",
    kind: "list",
    onBoard: true,
    hideEmpty: true,
    peek: 3,
    opens: "deal",
    // Open deals due to close in the next 30 days, and any whose date has passed.
    sql: `
      SELECT d.id AS id, d.title AS title, p.name AS name, d.stage AS stage, d.value_cents AS value_cents, d.expected_close AS expected_close,
             CASE WHEN d.expected_close < ? THEN 'bad' END AS tone
        FROM deals d JOIN deal_stages s ON s.name = d.stage JOIN people p ON p.id = d.person_id
       WHERE ${OPEN_DEAL} AND d.expected_close IS NOT NULL AND d.expected_close <= ?
       ORDER BY d.expected_close, d.id LIMIT 201`,
    params: ["today", "daysAhead30"],
    row: { id: "id", title: "title", subtitle: "name", badge: "expected_close", trailing: "value_cents", tone: "tone" },
    formats: { value_cents: "money", expected_close: "date" },
  },
  {
    id: "deal",
    title: "Deal",
    kind: "page",
    params: ["id"],
    blocks: [
      {
        kind: "fields",
        sql: `
          SELECT d.title AS title, p.name AS person, d.value_cents AS value_cents, d.stage AS stage, s.chance || '%' AS chance,
                 d.expected_close AS expected_close, d.opened_on AS opened_on, d.closed_on AS closed_on, d.outcome AS outcome,
                 d.lost_stage AS lost_at, d.lost_reason AS lost_reason, d.notes AS notes
            FROM deals d JOIN people p ON p.id = d.person_id LEFT JOIN deal_stages s ON s.name = d.stage WHERE d.id = ?`,
        params: ["id"],
        formats: { value_cents: "money", expected_close: "date", opened_on: "date", closed_on: "date" },
      },
      {
        kind: "timeline",
        title: "History",
        sql: "SELECT id, summary, happened_on FROM interactions WHERE ref = 'deal:' || ? ORDER BY happened_on DESC, id DESC LIMIT 201",
        params: ["id"],
        row: { id: "id", title: "summary", when: "happened_on" },
        formats: { happened_on: "date" },
        empty: "Nothing yet.",
      },
    ],
    actions: [
      { mutation: "deal_stage", label: "Move to a stage", on: "view", fixed: { id: "id" } },
      { mutation: "deal_close", label: "Won or lost", on: "view", fixed: { id: "id" } },
      { mutation: "deal_update", label: "Edit", on: "view", fixed: { id: "id" } },
      { mutation: "deal_archive", label: "Set aside", on: "view", fixed: { id: "id" }, confirm: true, after: "back" },
    ],
  },
  {
    id: "person",
    title: "Person",
    kind: "page",
    params: ["id"],
    // The prospect's card: who and where, what last happened and what is next, what they are about,
    // then only the details that are filled in, and one timeline. A block with nothing in it is left off.
    blocks: [
      {
        kind: "fields",
        look: "header",
        sql: `SELECT p.name AS name, NULLIF(p.organization, p.name) AS organization, ${PLACE} AS place, p.stage AS stage FROM people p WHERE p.id = ?`,
        params: ["id"],
      },
      {
        kind: "fields",
        look: "status",
        hideEmpty: true,
        // The newest touch in words, and the next step: the first open follow-up, or their reply to answer.
        sql: `
          WITH lt AS (${LAST_TOUCH}), nf AS (SELECT why, due_on FROM follow_ups WHERE person_id = ? AND done_at IS NULL ORDER BY due_on, id LIMIT 1)
          SELECT
            CASE
              WHEN lt.ref LIKE 'reply:%' THEN 'They replied ' || ${day("lt.happened_on")}
              WHEN lt.source = 'Website' THEN 'Wrote in from the website ' || ${day("lt.happened_on")}
              WHEN lt.kind = 'email' THEN 'Emailed ' || ${day("lt.happened_on")} || ' · no reply'
              WHEN lt.kind = 'call' THEN 'Called ' || ${day("lt.happened_on")}
              WHEN lt.kind = 'meeting' THEN 'Met ' || ${day("lt.happened_on")}
              WHEN lt.kind = 'message' THEN 'Messaged ' || ${day("lt.happened_on")}
            END AS last_touch,
            CASE
              WHEN lt.ref LIKE 'reply:%' THEN 'Answer their reply'
              WHEN nf.due_on IS NOT NULL AND nf.due_on < ? THEN nf.why || ' · overdue since ' || ${day("nf.due_on")}
              WHEN nf.due_on IS NOT NULL AND nf.due_on = ? THEN nf.why || ' · due today'
              WHEN nf.due_on IS NOT NULL THEN nf.why || ' · ' || ${day("nf.due_on")}
            END AS next,
            CASE
              WHEN lt.ref LIKE 'reply:%' THEN 'good'
              WHEN nf.due_on IS NOT NULL AND nf.due_on < ? THEN 'bad'
              WHEN nf.due_on IS NOT NULL AND nf.due_on = ? THEN 'warn'
            END AS _tone
            FROM people p LEFT JOIN lt ON lt.person_id = p.id LEFT JOIN nf ON 1 = 1
           WHERE p.id = ?`,
        params: ["id", "today", "today", "today", "today", "id"],
      },
      {
        kind: "fields",
        title: "About",
        look: "text",
        hideEmpty: true,
        // The first note: why they are here (a prospect search's reasons, how the person met them).
        sql: "SELECT body AS about FROM person_notes WHERE person_id = ? ORDER BY written_on, id LIMIT 1",
        params: ["id"],
      },
      {
        kind: "fields",
        title: "Contact",
        hideEmpty: true,
        sql: "SELECT email, phone, address, source, archived_at FROM people WHERE id = ?",
        params: ["id"],
      },
      {
        kind: "list",
        title: "Details",
        hideEmpty: true,
        // The Space's own fields this person has a value for, less the place the header shows; the row's id is the field's name, which Set sends.
        // Set a detail (•••) sets one not shown.
        sql: `
          SELECT f.name AS id, f.name AS name, v.value AS value
            FROM person_fields f JOIN person_values v ON v.field_id = f.id AND v.person_id = ?
           WHERE f.archived_at IS NULL AND COALESCE(v.value, '') <> '' AND lower(f.name) NOT IN ${PLACE_FIELDS} ORDER BY f.position, f.id`,
        params: ["id"],
        row: { id: "id", title: "name", subtitle: "value" },
        actions: [{ mutation: "person_field_set", label: "Set", on: "row", fixed: { person_id: "page", field: "id" } }],
      },
      {
        kind: "list",
        title: "To follow up",
        hideEmpty: true,
        sql: "SELECT id, why, due_on FROM follow_ups WHERE person_id = ? AND done_at IS NULL ORDER BY due_on, id",
        params: ["id"],
        row: { id: "id", title: "why", trailing: "due_on" },
        formats: { due_on: "date" },
        actions: [{ mutation: "follow_up_done", label: "Done", on: "row", fixed: { id: "id" } }],
      },
      {
        kind: "list",
        title: "Deals",
        hideEmpty: true,
        sql: `
          SELECT id, title, stage, value_cents FROM deals WHERE person_id = ? AND archived_at IS NULL
           ORDER BY closed_on IS NOT NULL, opened_on DESC, id DESC`,
        params: ["id"],
        row: { id: "id", title: "title", badge: "stage", trailing: "value_cents" },
        formats: { value_cents: "money" },
      },
      {
        kind: "timeline",
        title: "Timeline",
        // Notes and everything else in one line of time. An email the agent logged as Cobra email and a seat logged again the same day
        // ("Outreach email sent") shows once.
        sql: timeline(201),
        params: ["id", "id"],
        row: { id: "id", title: "summary", badge: "kind", when: "happened_on", subtitle: "source" },
        formats: { happened_on: "date" },
        empty: "Nothing yet.",
      },
    ],
    actions: [
      { mutation: "person_stage", label: "Move to a stage", on: "view", fixed: { id: "id" }, group: "next" },
      { mutation: "follow_up_add", label: "Follow up later", on: "view", fixed: { person_id: "id" }, group: "next" },
      { mutation: "interaction_add", label: "Log a reply, call or meeting", on: "view", fixed: { person_id: "id", on: "today" }, group: "next" },
      { mutation: "note_add", label: "Add a note", on: "view", fixed: { person_id: "id", on: "today" }, group: "next" },
      { mutation: "deal_open", label: "Open a deal", on: "view", fixed: { person_id: "id" }, group: "more" },
      { mutation: "person_field_set", label: "Set a detail", on: "view", fixed: { person_id: "id" }, group: "more" },
      { mutation: "person_update", label: "Edit", on: "view", fixed: { id: "id" }, group: "more" },
      { mutation: "person_archive", label: "Archive", on: "view", fixed: { id: "id" }, confirm: true, after: "back", group: "more" },
    ],
  },
  {
    id: "crm-board",
    title: "CRM",
    kind: "kanban",
    searchable: true,
    opens: "person",
    // Every stage a column, in order, with everyone in it; people at no stage (or one the Space no longer has) in a first column only while there are any.
    lanesSql: `
      SELECT key, label, count, closed, locked FROM (
        SELECT '(none)' AS key, 'No stage' AS label, -1 AS pos, 0 AS closed, 1 AS locked,
               (SELECT COUNT(*) FROM people p WHERE p.archived_at IS NULL AND ${LANE} = '(none)') AS count
        UNION ALL
        SELECT s.name, s.name, s.position, COALESCE(s.closed, 0), 0, (SELECT COUNT(*) FROM people p WHERE p.archived_at IS NULL AND p.stage = s.name) FROM stages s)
       WHERE key <> '(none)' OR count > 0
       ORDER BY pos, key`,
    // One card a person: the company (else the name), who, the first note (why they are here), the next follow-up and the last touch.
    // In each lane the most pressing first: a reply waiting on you, a follow-up due (the oldest first), then the freshest; 100 a lane.
    // A prospect search starts its note "Why good prospect:", which the card leaves off.
    sql: `
      WITH t AS (SELECT ? AS today), lt AS (${LAST_TOUCH}), waiting AS (${UNANSWERED}),
      nf AS (SELECT person_id, MIN(due_on) AS due_on FROM follow_ups WHERE done_at IS NULL GROUP BY person_id),
      why AS (SELECT n.person_id, CASE WHEN n.body LIKE 'Why good prospect:%' THEN trim(substr(n.body, 19)) ELSE n.body END AS body FROM person_notes n
               WHERE n.id = (SELECT m.id FROM person_notes m WHERE m.person_id = n.person_id ORDER BY m.written_on, m.id LIMIT 1)),
      cards AS (
        SELECT p.id AS id, ${LANE} AS lane,
               COALESCE(NULLIF(p.organization, ''), p.name) AS title,
               CASE WHEN NULLIF(p.organization, '') IS NOT NULL AND p.organization <> p.name THEN p.name ELSE p.email END AS who,
               why.body AS why,
               CASE WHEN nf.due_on IS NULL THEN 'No follow-up' WHEN nf.due_on = t.today THEN 'Due today' ELSE 'Due ' || ${day("nf.due_on")} END AS due,
               CASE WHEN nf.due_on < t.today THEN 'bad' WHEN nf.due_on = t.today THEN 'warn' END AS due_tone,
               CASE
                 WHEN lt.ref LIKE 'reply:%' THEN 'Replied ' || ${ago("lt.happened_on")}
                 WHEN lt.source = 'Website' THEN 'Wrote in ' || ${ago("lt.happened_on")}
                 WHEN lt.kind = 'email' THEN 'Emailed ' || ${ago("lt.happened_on")}
                 WHEN lt.kind = 'call' THEN 'Called ' || ${ago("lt.happened_on")}
                 WHEN lt.kind = 'meeting' THEN 'Met ' || ${ago("lt.happened_on")}
                 WHEN lt.kind = 'message' THEN 'Messaged ' || ${ago("lt.happened_on")}
                 ELSE 'Added ' || ${ago("substr(p.created_at, 1, 10)")} END AS touch,
               CASE WHEN lt.ref LIKE 'reply:%' THEN 'good' WHEN lt.kind = 'email' AND nf.due_on <= t.today THEN 'warn' END AS touch_tone,
               CASE WHEN p.id IN (SELECT person_id FROM waiting) THEN 0 WHEN nf.due_on <= t.today THEN 1 ELSE 2 END AS pressing,
               nf.due_on AS due_on, COALESCE(lt.created_at, p.created_at) AS last_at
          FROM people p CROSS JOIN t LEFT JOIN lt ON lt.person_id = p.id LEFT JOIN nf ON nf.person_id = p.id LEFT JOIN why ON why.person_id = p.id
         WHERE p.archived_at IS NULL
           AND (? = '' OR p.name LIKE ? ESCAPE '\\' OR p.organization LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\'
                OR EXISTS (SELECT 1 FROM person_values v JOIN person_fields f ON f.id = v.field_id
                            WHERE v.person_id = p.id AND f.archived_at IS NULL AND v.value LIKE ? ESCAPE '\\'))
           AND ${SHOW_FILTER}
           AND (? = '' OR instr(?, ',' || ${SOURCE_KEY} || ',') > 0)
           AND (? = '' OR instr(?, ',' || COALESCE(${PLACE_KEY}, '(none)') || ',') > 0))
      SELECT id, lane, title, who, why, due, due_tone, touch, touch_tone FROM (
        SELECT c.*, ROW_NUMBER() OVER (PARTITION BY lane ORDER BY pressing, CASE WHEN pressing = 1 THEN due_on END, last_at DESC, title COLLATE NOCASE) AS n FROM cards c)
       WHERE n <= 100 ORDER BY lane, n`,
    params: ["today", "q", "like", "like", "like", "like", "facet:show", "facet:show", "facet:show", "facet:show", "facet:show",
      "facet:source", "facet:source", "facet:place", "facet:place"],
    row: { id: "id", title: "title", subtitle: "who", detail: "why", lane: "lane" },
    kanban: {
      chips: [{ text: "due", tone: "due_tone", icon: "date" }, { text: "touch", tone: "touch_tone" }],
      move: { mutation: "person_stage", id: "id", lane: "stage" },
      peek: "person-card",
      add: { mutation: "person_add", label: "Add person", on: "view" },
      next: "next",
      band: "outreach-band",
      more: ["deals", "coming-up", "followups", "inquiries", "people", "email-to-allow", "email-stopped", "email-sequences"],
      facets: [
        {
          id: "show",
          label: "Show",
          sql: `
            WITH t AS (SELECT ? AS today)
            SELECT 'due' AS key, 'Follow-up due' AS label,
                   (SELECT COUNT(DISTINCT f.person_id) FROM follow_ups f JOIN people p ON p.id = f.person_id AND p.archived_at IS NULL
                     WHERE f.done_at IS NULL AND f.due_on <= t.today) AS count FROM t
            UNION ALL SELECT 'waiting', 'Reply waiting', (SELECT COUNT(*) FROM (${UNANSWERED}))
            UNION ALL SELECT 'website', 'From the website', (SELECT COUNT(*) FROM people p WHERE p.archived_at IS NULL AND ${FROM_WEBSITE})
            UNION ALL SELECT 'new', 'Not contacted yet', (SELECT COUNT(*) FROM people p WHERE p.archived_at IS NULL AND NOT ${WRITTEN_TO})`,
          params: ["today"],
        },
        {
          id: "source",
          label: "Source",
          sql: `
            SELECT ${SOURCE_KEY} AS key, CASE ${SOURCE_KEY} WHEN '(none)' THEN 'Not recorded' ELSE ${SOURCE_KEY} END AS label, COUNT(*) AS count
              FROM people p WHERE p.archived_at IS NULL GROUP BY 1 ORDER BY count DESC, key LIMIT 12`,
        },
        {
          id: "place",
          label: "Location",
          sql: `
            SELECT ${PLACE_KEY} AS key, ${PLACE} AS label, COUNT(*) AS count
              FROM people p WHERE p.archived_at IS NULL AND ${PLACE} IS NOT NULL GROUP BY 1 ORDER BY count DESC, key LIMIT 12`,
        },
      ],
    },
    actions: [
      { mutation: "follow_up_rule_set", label: "Follow-up timing", on: "view" },
      { mutation: "stage_set", label: "Add a stage", on: "view" },
    ],
  },
  {
    id: "outreach-band",
    title: "Outreach",
    kind: "band",
    // Each day's emails the Space sent (an email logged twice counted once) and the replies that came back.
    sql: `
      SELECT i.happened_on AS day,
             SUM(CASE WHEN i.kind = 'email' AND COALESCE(i.ref, '') NOT LIKE 'reply:%' AND COALESCE(i.source, '') <> 'Website' AND NOT (${DOUBLE_EMAIL}) THEN 1 ELSE 0 END) AS emails,
             SUM(CASE WHEN i.ref LIKE 'reply:%' THEN 1 ELSE 0 END) AS replies
        FROM interactions i
       WHERE i.happened_on >= ? AND i.happened_on <= ?
       GROUP BY i.happened_on ORDER BY i.happened_on`,
    params: ["bandStart", "bandEnd"],
    band: {
      x: "day",
      solid: { column: "emails", label: "Emails sent" },
      hatched: { column: "replies", label: "Replies" },
      gauge: { label: "Reply rate", caption: "{hatched} replies to {solid} emails" },
      // The two numbers that filter the board: follow-ups due (how many overdue) and replies waiting on you (when the newest came).
      tilesSql: `
        WITH t AS (SELECT ? AS today),
        due AS (SELECT f.person_id, MIN(f.due_on) AS due_on FROM follow_ups f JOIN people p ON p.id = f.person_id AND p.archived_at IS NULL, t
                 WHERE f.done_at IS NULL AND f.due_on <= t.today GROUP BY f.person_id),
        waiting AS (${UNANSWERED}),
        newest AS (SELECT MAX(r.happened_on) AS on_day FROM interactions r WHERE r.ref LIKE 'reply:%' AND r.person_id IN (SELECT person_id FROM waiting))
        SELECT 'Follow-ups due' AS label, (SELECT COUNT(*) FROM due) AS value,
               CASE (SELECT COUNT(*) FROM due, t WHERE due.due_on < t.today) WHEN 0 THEN 'None overdue' ELSE (SELECT COUNT(*) FROM due, t WHERE due.due_on < t.today) || ' overdue' END AS caption,
               CASE WHEN (SELECT COUNT(*) FROM due, t WHERE due.due_on < t.today) > 0 THEN 'bad' END AS tone, 'show' AS facet, 'due' AS key
        UNION ALL
        SELECT 'Replies waiting', (SELECT COUNT(*) FROM waiting),
               CASE WHEN (SELECT on_day FROM newest) IS NULL THEN 'None waiting' WHEN (SELECT on_day FROM newest) = (SELECT today FROM t) THEN 'Newest today'
                    ELSE 'Newest ' || (SELECT ${day("on_day")} FROM newest) END,
               CASE WHEN (SELECT COUNT(*) FROM waiting) > 0 THEN 'good' END, 'show', 'waiting'`,
      tilesParams: ["today"],
    },
  },
  {
    id: "person-card",
    title: "Person",
    kind: "page",
    params: ["id"],
    // A card opened in place on the board: where they are, how to reach them, and the last two lines of their timeline.
    blocks: [
      {
        kind: "fields",
        hideEmpty: true,
        sql: `SELECT ${PLACE} AS place, p.email AS email, p.phone AS phone FROM people p WHERE p.id = ?`,
        params: ["id"],
      },
      {
        kind: "timeline",
        title: "Timeline",
        sql: timeline(2),
        params: ["id", "id"],
        row: { id: "id", title: "summary", badge: "kind", when: "happened_on" },
        formats: { happened_on: "date" },
        empty: "Nothing yet.",
      },
    ],
  },
  // What the funnel opens: the deals at a stage. An empty key (an app from before charts) is every deal in play.
  {
    id: "stage-deals",
    title: "Deals",
    kind: "list",
    fromChart: true,
    opens: "deal",
    sql: `
      SELECT d.id AS id, d.title AS title, p.name AS name, d.stage AS stage, d.value_cents AS value_cents
        FROM deals d JOIN people p ON p.id = d.person_id JOIN deal_stages s ON s.name = d.stage
       WHERE d.archived_at IS NULL AND (d.stage = ? OR (? = '' AND s.closed = 0))
       ORDER BY d.value_cents DESC, d.id LIMIT 201`,
    params: ["key", "key"],
    row: { id: "id", title: "title", subtitle: "name", badge: "stage", trailing: "value_cents" },
    formats: { value_cents: "money" },
  },
];
