// The desk's Finance rail: Money's views, the
// phone's and the desk's own, set on the pages of a left rail. A business Space's rail is Overview,
// Transactions, Invoices and Tax & costs; a family Space's is Overview, Transactions, Budget, Recurring and
// Investments. The phone keeps its own boards (views.ts lists these only for `surface=desk`), and every view
// here also answers `/view` from any app, so nothing the phone opens goes missing.
//
// The new views read what came in (trusted senders, statements), what investment accounts hold
// (holdings.ts), the tax set-aside (tax.ts), and Cobra's notes: rules over the books, written in SQL with no
// model, read fresh with the board. Totals count in the home currency at the rate of their day, as Money's do.
import type { ViewSpec } from "../../../../../packages/contracts/src/views.ts";
import { BILL_HOME_SQL, COMMITTED_SQL, DUE_IN_SQL, DUE_ON_SQL } from "../trades/bills.ts";
import { LIMIT_SQL } from "../trades/budget.ts";
import { TRUSTED_PREFIX } from "../trades/intake.ts";
import { BUDGET_VIEWS } from "./budget.ts";
import { DAY, EXPENSE_HOME, HOME, INCOME_HOME, IN_HOME, MONEY_VIEWS, MONTH_IN, MONTH_OUT, MONTH_WORD, SIX_MONTHS, WAITING_COUNT } from "./money.ts";

export type RailKind = "business" | "family";

export const BUSINESS_PAGES = ["Overview", "Transactions", "Invoices", "Tax & costs"] as const;
export const FAMILY_PAGES = ["Overview", "Transactions", "Budget", "Recurring", "Investments"] as const;

const HOME_TEXT = (cents: string): string => `money_text(${cents}, ${HOME}, ${HOME})`;
/** Everyday money (cash, bank, card, other) now, home cents. */
const CASH_SQL = `(SELECT COALESCE(SUM(${IN_HOME("a.balance_cents", "a.currency", "NULL")}), 0) FROM account_balances a WHERE a.archived_at IS NULL AND a.kind IN ('cash', 'bank', 'card', 'other'))`;
/** Every open account now, home cents: what is owned less what is owed. */
const NET_WORTH_SQL = `(SELECT COALESCE(SUM(${IN_HOME("a.balance_cents", "a.currency", "NULL")}), 0) FROM account_balances a WHERE a.archived_at IS NULL)`;
/** The tax rate the owner set, as a percent; NULL with none. */
const TAX_RATE = "(SELECT rate FROM tax_plan ORDER BY id LIMIT 1)";
/** What month `m.month` puts aside at the owner's rate: a share of what it kept, never of a loss. */
const ASIDE = (kept: string): string => `CAST(ROUND(MAX(${kept}, 0) * COALESCE(${TAX_RATE}, 0) / 100.0) AS INTEGER)`;
const MOVED = (month: string): string => `COALESCE((SELECT SUM(amount_cents) FROM tax_moves WHERE month = ${month}), 0)`;
/** The month before YYYY-MM `month`. */
const MONTH_BEFORE = (month: string): string => `strftime('%Y-%m', date(${month} || '-01', '-1 month'))`;
/** Spending per expense category in month `m` (with ms, me), home cents. */
const CATEGORY_SPENT = (c: string): string =>
  `COALESCE((SELECT SUM(${EXPENSE_HOME("e")}) FROM expenses e WHERE e.category_id = ${c}.id AND e.status = 'recorded' AND e.spent_on >= m.ms AND e.spent_on <= m.me), 0)`;
/** The board's month as a row `m`: month, ms, me, td. Binds MONTH_PARAMS. */
const MONTH_CTE = "m AS (SELECT ? AS month, ? AS ms, ? AS me, ? AS td)";
const MONTH_PARAMS = ["month", "monthStart", "monthEnd", "today"] as const;
/** A holding's (alias h) value in home cents at its latest price. */
const HOLDING_HOME = (h: string): string => IN_HOME(`${h}.value_cents`, `COALESCE(${h}.currency, ${HOME})`, `${h}.priced_on`);

// --- Overview ----------------------------------------------------------------------------------

const BUSINESS_TILES: ViewSpec = {
  id: "fin-tiles",
  title: "This month",
  kind: "tiles",
  monthly: true,
  sql: `
    WITH ${MONTH_CTE}, t AS (SELECT ${MONTH_IN} AS in_cents, ${MONTH_OUT} AS out_cents FROM m)
    SELECT 'Kept' AS label, in_cents - out_cents AS value,
           CASE WHEN in_cents > 0 THEN CAST(ROUND((in_cents - out_cents) * 100.0 / in_cents) AS INTEGER) || '% of what came in' ELSE 'Nothing came in yet' END AS caption,
           CASE WHEN in_cents < out_cents THEN 'bad' END AS tone, 'money' AS format, NULL AS currency FROM t
    UNION ALL SELECT 'In', in_cents, 'payments and income', NULL, 'money', NULL FROM t
    UNION ALL SELECT 'Out', out_cents, 'recorded spending', NULL, 'money', NULL FROM t
    UNION ALL SELECT 'Cash', ${CASH_SQL}, 'in the bank and on hand now', CASE WHEN ${CASH_SQL} < 0 THEN 'bad' END, 'money', NULL`,
  params: [...MONTH_PARAMS],
};

const FAMILY_TILES: ViewSpec = {
  id: "fin-tiles",
  title: "This month",
  kind: "tiles",
  monthly: true,
  sql: `
    WITH ${MONTH_CTE},
    t AS (SELECT ${MONTH_IN} AS in_cents, ${MONTH_OUT} AS out_cents,
                 (SELECT SUM(${LIMIT_SQL("c.id", "m.month")}) FROM categories c WHERE c.kind = 'expense') AS limit_cents,
                 ${COMMITTED_SQL("m.ms", "m.me", "m.td")} AS committed FROM m)
    SELECT 'Net worth' AS label, ${NET_WORTH_SQL} AS value, 'every account, less what is owed' AS caption, NULL AS tone, 'money' AS format, NULL AS currency
    UNION ALL SELECT 'In', in_cents, 'pay and other money in', NULL, 'money', NULL FROM t
    UNION ALL SELECT 'Spent', out_cents, 'recorded spending', NULL, 'money', NULL FROM t
    UNION ALL SELECT 'Left to spend', CASE WHEN limit_cents IS NULL THEN NULL ELSE limit_cents - out_cents - committed END,
           CASE WHEN limit_cents IS NULL THEN 'No limits yet' ELSE 'of ' || ${HOME_TEXT("limit_cents")} || ', after the bills to come' END,
           CASE WHEN limit_cents IS NOT NULL AND limit_cents - out_cents - committed < 0 THEN 'bad' END, 'money', NULL FROM t`,
  params: [...MONTH_PARAMS],
};

/** The business's health: its margin as the ring, then runway, tax and what waits. */
const HEALTH: ViewSpec = {
  id: "fin-health",
  title: "Health",
  kind: "chart",
  monthly: true,
  sql: `
    WITH ${MONTH_CTE},
    t AS (SELECT ${MONTH_IN} AS in_cents, ${MONTH_OUT} AS out_cents FROM m),
    burn AS (SELECT COALESCE(SUM(${EXPENSE_HOME("e")}), 0) / 3.0 AS avg_out FROM expenses e, m
              WHERE e.status = 'recorded' AND e.spent_on >= date(m.ms, '-3 months') AND e.spent_on < m.ms),
    prev AS (SELECT ${MONTH_BEFORE("m.month")} AS month FROM m),
    tax AS (SELECT p.month AS month, ${ASIDE(`(${MONTH_IN.replaceAll("m.month", "p.month")} - ${MONTH_OUT.replaceAll("m.month", "p.month")})`)} AS aside, ${MOVED("p.month")} AS moved FROM prev p),
    score AS (SELECT CASE WHEN in_cents > 0 THEN MAX(0, MIN(100, CAST(ROUND((in_cents - out_cents) * 100.0 / in_cents) AS INTEGER))) ELSE 0 END AS margin FROM t)
    SELECT (SELECT margin FROM score) AS margin, label, caption, tone FROM (
      SELECT 1 AS n, 'Runway' AS label,
             CASE WHEN burn.avg_out <= 0 THEN 'No costs in the last 3 months'
                  ELSE printf('%.1f', ${CASH_SQL} / burn.avg_out) || ' months of costs in cash' END AS caption,
             CASE WHEN burn.avg_out > 0 AND ${CASH_SQL} / burn.avg_out < 3 THEN 'warn' ELSE 'good' END AS tone FROM burn
      UNION ALL
      SELECT 2, 'Tax set aside',
             CASE WHEN ${TAX_RATE} IS NULL THEN 'No rate yet: tell Cobra the share your accountant gave you'
                  WHEN tax.aside <= tax.moved THEN ${MONTH_WORD("tax.month || '-01'")} || '''s set-aside is moved'
                  ELSE ${HOME_TEXT("tax.aside - tax.moved")} || ' still to move for ' || ${MONTH_WORD("tax.month || '-01'")} END,
             CASE WHEN ${TAX_RATE} IS NULL THEN 'warn' WHEN tax.aside <= tax.moved THEN 'good' ELSE 'warn' END FROM tax
      UNION ALL
      SELECT 3, 'Waiting on you', CASE WHEN ${WAITING_COUNT} = 0 THEN 'Nothing to allow' ELSE ${WAITING_COUNT} || ' to allow' END,
             CASE WHEN ${WAITING_COUNT} = 0 THEN 'good' ELSE 'warn' END)
     ORDER BY n`,
  params: [...MONTH_PARAMS],
  chart: { type: "ring", x: "label", series: [{ column: "margin", label: "Margin" }], format: "percent", ring: { value: "margin", label: "Margin" }, caption: "caption", tone: "tone" },
};

/** A household's savings rate as the ring, then its three checks. */
const SAVINGS: ViewSpec = {
  id: "fin-savings",
  title: "Savings",
  kind: "chart",
  monthly: true,
  sql: `
    WITH ${MONTH_CTE},
    t AS (SELECT ${MONTH_IN} AS in_cents, ${MONTH_OUT} AS out_cents, ${COMMITTED_SQL("m.ms", "m.me", "m.td")} AS committed FROM m),
    cats AS (SELECT c.name AS name, ${CATEGORY_SPENT("c")} AS spent, ${LIMIT_SQL("c.id", "m.month")} AS lim FROM categories c, m WHERE c.kind = 'expense'),
    goals AS (SELECT a.name AS name, a.balance_cents AS bal, a.goal_cents AS goal, a.goal_on AS goal_on FROM account_balances a WHERE a.archived_at IS NULL AND a.kind = 'savings' AND a.goal_cents > 0),
    score AS (SELECT CASE WHEN in_cents > 0 THEN MAX(0, MIN(100, CAST(ROUND((in_cents - out_cents) * 100.0 / in_cents) AS INTEGER))) ELSE 0 END AS rate FROM t)
    SELECT (SELECT rate FROM score) AS rate, label, caption, tone FROM (
      SELECT 1 AS n, 'Under your limits' AS label,
             CASE WHEN NOT EXISTS (SELECT 1 FROM cats WHERE lim IS NOT NULL) THEN 'No limits yet'
                  WHEN EXISTS (SELECT 1 FROM cats WHERE lim IS NOT NULL AND spent > lim) THEN (SELECT COUNT(*) FROM cats WHERE lim IS NOT NULL AND spent > lim) || ' over: ' || (SELECT group_concat(name, ', ') FROM (SELECT name FROM cats WHERE lim IS NOT NULL AND spent > lim ORDER BY spent - lim DESC LIMIT 2))
                  ELSE 'Every category is under' END AS caption,
             CASE WHEN EXISTS (SELECT 1 FROM cats WHERE lim IS NOT NULL AND spent > lim) THEN 'bad' WHEN NOT EXISTS (SELECT 1 FROM cats WHERE lim IS NOT NULL) THEN 'warn' ELSE 'good' END AS tone
      UNION ALL
      SELECT 2, 'Bills covered',
             CASE WHEN t.committed = 0 THEN 'No bills left to pay this month'
                  ELSE ${HOME_TEXT("t.committed")} || ' still to pay, ' || ${HOME_TEXT(CASH_SQL)} || ' in cash' END,
             CASE WHEN t.committed > ${CASH_SQL} THEN 'bad' ELSE 'good' END FROM t
      UNION ALL
      SELECT 3, 'Goal on pace',
             CASE WHEN NOT EXISTS (SELECT 1 FROM goals) THEN 'No savings goal yet'
                  WHEN EXISTS (SELECT 1 FROM goals, m WHERE bal < goal AND goal_on IS NOT NULL AND goal_on < m.td) THEN (SELECT name FROM goals, m WHERE bal < goal AND goal_on < m.td LIMIT 1) || ' is past its day'
                  ELSE (SELECT COUNT(*) FROM goals) || CASE WHEN (SELECT COUNT(*) FROM goals) = 1 THEN ' goal' ELSE ' goals' END || ' on its way' END,
             CASE WHEN NOT EXISTS (SELECT 1 FROM goals) THEN 'warn' WHEN EXISTS (SELECT 1 FROM goals, m WHERE bal < goal AND goal_on IS NOT NULL AND goal_on < m.td) THEN 'bad' ELSE 'good' END)
     ORDER BY n`,
  params: [...MONTH_PARAMS],
  chart: { type: "ring", x: "label", series: [{ column: "rate", label: "Savings rate" }], format: "percent", ring: { value: "rate", label: "Saved" }, caption: "caption", tone: "tone" },
};

/**
 * Where the month's money went, as a river: each source of money in (an income category, invoices) into
 * "Money in", then out to the five biggest spending categories and Other, tax at the owner's rate, and what
 * was kept (saved). When more went out than came in, the gap comes in from savings.
 */
function river(kind: RailKind): ViewSpec {
  const kept = kind === "business" ? "Kept" : "Saved";
  const tax = kind === "business" ? `UNION ALL SELECT 'Money in', 'Tax', ${ASIDE("t.in_cents - t.out_cents")}, 3 FROM t` : "";
  const keptCents = kind === "business" ? `t.in_cents - t.out_cents - ${ASIDE("t.in_cents - t.out_cents")}` : "t.in_cents - t.out_cents";
  return {
    id: "fin-river",
    title: "Where it went",
    kind: "chart",
    monthly: true,
    sql: `
      WITH ${MONTH_CTE},
      t AS (SELECT ${MONTH_IN} AS in_cents, ${MONTH_OUT} AS out_cents FROM m),
      ins AS (
        SELECT COALESCE(c.name, 'Other income') AS name, SUM(${INCOME_HOME("i")}) AS cents FROM money_moves i LEFT JOIN categories c ON c.id = i.category_id, m
         WHERE i.kind = 'income' AND i.status = 'recorded' AND substr(i.moved_on, 1, 7) = m.month GROUP BY 1
        UNION ALL
        SELECT 'Invoices', SUM(pm.amount_cents) FROM payments pm, m WHERE substr(pm.received_on, 1, 7) = m.month HAVING SUM(pm.amount_cents) > 0),
      outs AS (
        SELECT COALESCE(c.name, 'Uncategorized') AS name, SUM(${EXPENSE_HOME("e")}) AS cents FROM expenses e LEFT JOIN categories c ON c.id = e.category_id, m
         WHERE e.status = 'recorded' AND substr(e.spent_on, 1, 7) = m.month GROUP BY 1),
      ranked AS (SELECT name, cents, ROW_NUMBER() OVER (ORDER BY cents DESC, name) AS r FROM outs)
      SELECT source, target, cents FROM (
        SELECT name AS source, 'Money in' AS target, cents, 1 AS n FROM ins WHERE cents > 0
        UNION ALL SELECT 'From savings', 'Money in', t.out_cents - t.in_cents, 1 FROM t WHERE t.out_cents > t.in_cents
        UNION ALL SELECT 'Money in', name, cents, 2 FROM ranked WHERE r <= 5 AND cents > 0
        UNION ALL SELECT 'Money in', 'Other', SUM(cents), 2 FROM ranked WHERE r > 5 HAVING SUM(cents) > 0
        ${tax}
        UNION ALL SELECT 'Money in', '${kept}', ${keptCents}, 4 FROM t WHERE ${keptCents} > 0)
       WHERE cents > 0 ORDER BY n, cents DESC`,
    params: [...MONTH_PARAMS],
    chart: { type: "river", x: "source", series: [{ column: "cents", label: "Money" }], format: "money", river: { from: "source", to: "target" }, empty: "Money in and out this month shows here once you allow it." },
  };
}

// --- Cobra's notes: rules over the books, no model ----------------------------------------------

/**
 * One line each, with its numbers: a category well above its 3-month average, one near or over its limit,
 * weekends taking most of the spending, a charge that looks like a new repeat, a repeat that went up, one
 * holding over a quarter of the investments, and for a business a short runway or tax not yet moved.
 */
function insights(kind: RailKind): ViewSpec {
  const business = kind === "business";
  return {
    id: "fin-insights",
    title: "Cobra noticed",
    kind: "list",
    monthly: true,
    hideEmpty: true,
    sql: `
      WITH ${MONTH_CTE},
      cats AS (
        SELECT c.id AS id, c.name AS name, ${CATEGORY_SPENT("c")} AS spent, ${LIMIT_SQL("c.id", "m.month")} AS lim,
               COALESCE((SELECT SUM(${EXPENSE_HOME("e")}) FROM expenses e WHERE e.category_id = c.id AND e.status = 'recorded' AND e.spent_on >= date(m.ms, '-3 months') AND e.spent_on < m.ms), 0) / 3 AS avg3
          FROM categories c, m WHERE c.kind = 'expense'),
      days AS (
        SELECT SUM(CASE WHEN strftime('%w', e.spent_on) IN ('0', '6') THEN ${EXPENSE_HOME("e")} ELSE 0 END) AS weekend, SUM(${EXPENSE_HOME("e")}) AS total, COUNT(*) AS n
          FROM expenses e, m WHERE e.status = 'recorded' AND e.spent_on >= m.ms AND e.spent_on <= m.me),
      repeats AS (
        SELECT e.sender AS sender, COUNT(*) AS n, MIN(e.spent_on) AS first_on, MAX(e.spent_on) AS last_on,
               (SELECT x.amount_cents FROM expenses x WHERE x.sender = e.sender COLLATE NOCASE AND x.status = 'recorded' ORDER BY x.spent_on DESC, x.id DESC LIMIT 1) AS last_cents,
               (SELECT x.amount_cents FROM expenses x WHERE x.sender = e.sender COLLATE NOCASE AND x.status = 'recorded' ORDER BY x.spent_on DESC, x.id DESC LIMIT 1 OFFSET 1) AS prev_cents
          FROM expenses e, m WHERE e.status = 'recorded' AND e.sender IS NOT NULL AND e.spent_on >= date(m.td, '-75 days') AND e.spent_on <= m.td
         GROUP BY e.sender COLLATE NOCASE),
      held AS (SELECT symbol, ${HOLDING_HOME("h")} AS cents FROM holding_values h WHERE h.value_cents IS NOT NULL),
      burn AS (SELECT COALESCE(SUM(${EXPENSE_HOME("e")}), 0) / 3.0 AS avg_out FROM expenses e, m WHERE e.status = 'recorded' AND e.spent_on >= date(m.ms, '-3 months') AND e.spent_on < m.ms),
      prev AS (SELECT ${MONTH_BEFORE("m.month")} AS month FROM m),
      tax AS (SELECT p.month AS month, ${ASIDE(`(${MONTH_IN.replaceAll("m.month", "p.month")} - ${MONTH_OUT.replaceAll("m.month", "p.month")})`)} AS aside, ${MOVED("p.month")} AS moved FROM prev p)
      SELECT ROW_NUMBER() OVER (ORDER BY n, title) AS id, title, detail, tone FROM (
        SELECT 1 AS n, name || ' is ' || CAST(ROUND((spent - avg3) * 100.0 / avg3) AS INTEGER) || '% above its 3-month average' AS title,
               ${HOME_TEXT("spent")} || ' this month · ' || ${HOME_TEXT("avg3")} || ' on average' AS detail, 'warn' AS tone
          FROM cats WHERE avg3 > 0 AND spent > avg3 * 1.3 AND spent - avg3 >= 2000
        UNION ALL
        SELECT 2, CASE WHEN spent > lim THEN name || ' is ' || ${HOME_TEXT("spent - lim")} || ' over its limit' ELSE name || ' is at ' || CAST(ROUND(spent * 100.0 / lim) AS INTEGER) || '% of its limit' END,
               ${HOME_TEXT("spent")} || ' of ' || ${HOME_TEXT("lim")}, CASE WHEN spent > lim THEN 'bad' ELSE 'warn' END
          FROM cats WHERE lim IS NOT NULL AND spent >= lim * 0.8
        UNION ALL
        SELECT 3, 'Weekends took ' || CAST(ROUND(weekend * 100.0 / total) AS INTEGER) || '% of the spending',
               ${HOME_TEXT("weekend")} || ' on Saturdays and Sundays, of ' || ${HOME_TEXT("total")}, NULL
          FROM days WHERE n >= 5 AND total > 0 AND weekend * 1.0 / total > 0.5
        UNION ALL
        SELECT 4, sender || ' looks like a repeat', ${HOME_TEXT("last_cents")} || ' on ' || ${DAY("first_on")} || ' and ' || ${DAY("last_on")} || ' · add it as a bill?', NULL
          FROM repeats r WHERE n >= 2 AND julianday(last_on) - julianday(first_on) >= 25 AND ABS(last_cents - prev_cents) <= prev_cents * 0.1
           AND NOT EXISTS (SELECT 1 FROM bills b LEFT JOIN vendors v ON v.id = b.vendor_id WHERE b.status IN ('proposed', 'active') AND (b.name = r.sender COLLATE NOCASE OR v.name = r.sender COLLATE NOCASE))
        UNION ALL
        SELECT 5, sender || ' went up ' || ${HOME_TEXT("last_cents - prev_cents")}, ${HOME_TEXT("prev_cents")} || ' → ' || ${HOME_TEXT("last_cents")}, 'warn'
          FROM repeats WHERE n >= 2 AND prev_cents > 0 AND last_cents > prev_cents AND last_cents <= prev_cents * 1.5 AND (last_cents - prev_cents) * 100 >= prev_cents * 3
        UNION ALL
        SELECT 6, symbol || ' is ' || CAST(ROUND(cents * 100.0 / (SELECT SUM(cents) FROM held)) AS INTEGER) || '% of your investments', 'One holding carries much of the risk', 'warn'
          FROM held WHERE (SELECT COUNT(*) FROM held) > 1 AND cents * 4 > (SELECT SUM(cents) FROM held)
        ${business ? `UNION ALL
        SELECT 7, 'Under 3 months of runway', printf('%.1f', ${CASH_SQL} / avg_out) || ' months of costs in cash', 'bad' FROM burn WHERE avg_out > 0 AND ${CASH_SQL} / avg_out < 3
        UNION ALL
        SELECT 8, ${HOME_TEXT("aside - moved")} || ' of tax to move for ' || ${MONTH_WORD("month || '-01'")}, 'At your ' || ${TAX_RATE} || '% rate · say I moved it once it is', 'warn' FROM tax WHERE ${TAX_RATE} IS NOT NULL AND aside > moved` : ""})
       ORDER BY n, title LIMIT 12`,
    params: [...MONTH_PARAMS],
    row: { id: "id", title: "title", subtitle: "detail", tone: "tone" },
  };
}

// --- Transactions: what came in by itself ---------------------------------------------------------

const TRUST: ViewSpec = {
  id: "fin-trust",
  title: "Trusted senders",
  kind: "list",
  hideEmpty: true,
  sql: `
    SELECT t.id AS id, t.sender AS sender, t.status AS status,
           ltrim(CASE t.kind WHEN 'in' THEN 'Money in' ELSE 'Money out' END || COALESCE(' · ' || c.name, '') || COALESCE(' · ' || a.name, ''), ' ·') AS detail,
           CASE t.status WHEN 'offered' THEN 'Allowed ' || t.allows || ' times: record it on its own?' WHEN 'on' THEN 'Recorded on its own' WHEN 'off' THEN 'Off: waits for you' ELSE 'Not trusted' END AS said,
           CASE t.status WHEN 'offered' THEN 'Offered' WHEN 'on' THEN 'Trusted' WHEN 'off' THEN 'Off' ELSE 'Declined' END AS badge,
           CASE t.status WHEN 'offered' THEN 'warn' WHEN 'on' THEN 'good' END AS tone,
           (SELECT COUNT(*) FROM expenses x WHERE x.proposed_by = '${TRUSTED_PREFIX}' || t.sender) + (SELECT COUNT(*) FROM money_moves x WHERE x.proposed_by = '${TRUSTED_PREFIX}' || t.sender) AS recorded
      FROM trusted_senders t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN accounts a ON a.id = t.account_id
     ORDER BY t.status = 'offered' DESC, t.status = 'on' DESC, t.sender LIMIT 201`,
  row: { id: "id", title: "sender", subtitle: "detail", detail: "said", badge: "badge", tone: "tone" },
  actions: [
    { mutation: "trust_answer", label: "Trust", on: "row", fixed: { id: "id" }, values: { answer: "yes" }, showWhen: { column: "status", equals: "offered" } },
    { mutation: "trust_answer", label: "Not now", on: "row", fixed: { id: "id" }, values: { answer: "no" }, showWhen: { column: "status", equals: "offered" } },
    { mutation: "trust_set", label: "Turn off", on: "row", fixed: { id: "id" }, values: { on: false }, showWhen: { column: "status", equals: "on" } },
    { mutation: "trust_set", label: "Turn on", on: "row", fixed: { id: "id" }, values: { on: true }, showWhen: { column: "status", equals: "off" } },
  ],
};

const STATEMENTS: ViewSpec = {
  id: "fin-statements",
  title: "Statements",
  kind: "list",
  hideEmpty: true,
  sql: `
    SELECT b.id AS id, b.file_name AS file_name,
           ltrim(COALESCE(a.name, '') || ' · ' || b.row_count || ' lines · ' || COALESCE(b.matched_count, 0) || ' already in the books · ' || COALESCE(b.new_count, 0) || ' new', ' ·') AS detail,
           COALESCE(${DAY("b.first_on")} || ' – ' || ${DAY("b.last_on")}, '') AS span, upper(b.source) AS badge, substr(b.created_at, 1, 10) AS read_on
      FROM import_batches b LEFT JOIN accounts a ON a.id = b.account_id
     WHERE b.source IN ('csv', 'pdf') AND b.status = 'read'
     ORDER BY b.id DESC LIMIT 50`,
  row: { id: "id", title: "file_name", subtitle: "detail", detail: "span", badge: "badge", trailing: "read_on" },
  formats: { read_on: "date" },
};

// --- Tax & costs ---------------------------------------------------------------------------------

const TAX: ViewSpec = {
  id: "fin-tax",
  title: "Tax set-aside",
  kind: "chart",
  monthly: true,
  sql: `
    WITH ${SIX_MONTHS},
    t AS (SELECT m.month AS month, ${MONTH_IN} - ${MONTH_OUT} AS kept FROM months m)
    SELECT t.month AS month, t.kept AS kept_cents, ${ASIDE("t.kept")} AS aside_cents, ${MOVED("t.month")} AS moved_cents,
           MAX(${ASIDE("t.kept")} - ${MOVED("t.month")}, 0) AS still_cents,
           CASE WHEN ${TAX_RATE} IS NULL THEN 'No rate yet: the share your accountant gives you goes here'
                ELSE ${TAX_RATE} || '% of ' || ${MONTH_WORD("t.month || '-01'")} || '''s kept · your rate, not Cobra''s' END AS caption,
           CASE WHEN ${ASIDE("t.kept")} > ${MOVED("t.month")} THEN 'warn' END AS tone
      FROM t ORDER BY t.month`,
  params: ["monthStart"],
  chart: {
    type: "hero", x: "month", xKind: "month", format: "money", hero: { column: "still_cents", label: "Still to move" }, caption: "caption", tone: "tone",
    series: [{ column: "kept_cents", label: "Kept" }, { column: "aside_cents", label: "To put aside" }, { column: "moved_cents", label: "Moved" }],
    bars: ["aside_cents", "moved_cents"],
    empty: "Tell Cobra the share of each month your accountant says to put aside; Cobra never works tax out.",
  },
  actions: [
    { mutation: "tax_moved", label: "I moved it", on: "view" },
    { mutation: "tax_rate_set", label: "Set the rate", on: "view" },
  ],
};

// --- Recurring -----------------------------------------------------------------------------------

const CALENDAR: ViewSpec = {
  id: "fin-calendar",
  title: "Due this month",
  kind: "chart",
  monthly: true,
  sql: `
    WITH ${MONTH_CTE}
    SELECT ${DUE_ON_SQL("b", "m.ms", "m.me")} AS day, ${BILL_HOME_SQL("b", "m.ms")} AS amount_cents, b.name AS name
      FROM bills b, m WHERE ${DUE_IN_SQL("b", "m.ms", "m.me")}
     ORDER BY day, b.name`,
  params: [...MONTH_PARAMS],
  chart: { type: "calendar", x: "day", series: [{ column: "amount_cents", label: "Due" }], format: "money", caption: "name", empty: "No bills due this month." },
};

// --- Investments ---------------------------------------------------------------------------------

const INVEST_TILES: ViewSpec = {
  id: "fin-invest-tiles",
  title: "Investments",
  kind: "tiles",
  hideEmpty: true,
  sql: `
    WITH h AS (SELECT *, ${HOLDING_HOME("hv")} AS home, ${IN_HOME("hv.cost_cents", `COALESCE(hv.currency, ${HOME})`, "hv.priced_on")} AS cost_home,
                      ${IN_HOME("CAST(ROUND(hv.shares * (hv.price - hv.prev_price) * 100) AS INTEGER)", `COALESCE(hv.currency, ${HOME})`, "hv.priced_on")} AS day_home
                 FROM holding_values hv WHERE hv.value_cents IS NOT NULL)
    SELECT 'Value' AS label, SUM(home) AS value, COUNT(*) || ' holdings' || CASE WHEN SUM(stale) > 0 THEN ' · ' || SUM(stale) || ' with an old price' ELSE '' END AS caption,
           CASE WHEN SUM(stale) > 0 THEN 'warn' END AS tone, 'money' AS format, NULL AS currency FROM h HAVING COUNT(*) > 0
    UNION ALL
    SELECT 'Gain', SUM(home) - SUM(cost_home), CASE WHEN SUM(cost_home) > 0 THEN CAST(ROUND((SUM(home) - SUM(cost_home)) * 100.0 / SUM(cost_home)) AS INTEGER) || '% on what they cost' ELSE 'set what they cost to see it' END,
           CASE WHEN SUM(home) < SUM(cost_home) THEN 'bad' ELSE 'good' END, 'money', NULL FROM h WHERE cost_home IS NOT NULL HAVING COUNT(*) > 0
    UNION ALL
    SELECT 'Last day', COALESCE(SUM(day_home), 0), 'the change at the last close', CASE WHEN SUM(day_home) < 0 THEN 'bad' END, 'money', NULL FROM h HAVING COUNT(*) > 0`,
};

const PERFORMANCE: ViewSpec = {
  id: "fin-performance",
  title: "Performance",
  kind: "chart",
  hideEmpty: true,
  // The holdings as they are now, at each day's prices over six months, from the first day every one has a price.
  sql: `
    WITH days AS (SELECT DISTINCT day FROM prices WHERE day >= date(?, '-6 months')),
    starts AS (SELECT MAX(first) AS day FROM (SELECT (SELECT MIN(p.day) FROM prices p WHERE p.symbol = h.symbol COLLATE NOCASE AND p.kind = h.kind) AS first FROM holdings h WHERE h.archived_at IS NULL))
    SELECT d.day AS day,
           SUM(${IN_HOME("CAST(ROUND(h.shares * (SELECT p.price FROM prices p WHERE p.symbol = h.symbol COLLATE NOCASE AND p.kind = h.kind AND p.day <= d.day ORDER BY p.day DESC LIMIT 1) * 100) AS INTEGER)", `COALESCE(h.currency, ${HOME})`, "d.day")}) AS value_cents
      FROM days d, holdings h, starts s WHERE h.archived_at IS NULL AND d.day >= s.day
     GROUP BY d.day ORDER BY d.day`,
  params: ["today"],
  chart: { type: "line", x: "day", xKind: "text", series: [{ column: "value_cents", label: "Value" }], format: "money", empty: "Holdings show here after their first close." },
};

const MIX: ViewSpec = {
  id: "fin-mix",
  title: "Mix",
  kind: "chart",
  hideEmpty: true,
  sql: `SELECT h.symbol AS symbol, ${HOLDING_HOME("h")} AS value_cents FROM holding_values h WHERE h.value_cents IS NOT NULL ORDER BY value_cents DESC`,
  chart: { type: "donut", x: "symbol", xKind: "text", series: [{ column: "value_cents", label: "Value" }], format: "money" },
};

const HOLDINGS: ViewSpec = {
  id: "fin-holdings",
  title: "Holdings",
  kind: "table",
  hideEmpty: true,
  // Prices, values and gains in the holding's own currency (US$ for a coin), written out; the day's change as a percent.
  sql: `
    SELECT h.id AS id, h.symbol || COALESCE(' · ' || h.name, '') AS holding, CAST(h.shares AS TEXT) AS shares,
           CASE WHEN h.price IS NULL THEN 'not priced yet' ELSE money_text(CAST(ROUND(h.price * 100) AS INTEGER), COALESCE(h.currency, ${HOME}), ${HOME}) END AS price,
           CASE WHEN h.value_cents IS NULL THEN '' ELSE money_text(h.value_cents, COALESCE(h.currency, ${HOME}), ${HOME}) END AS value,
           CASE WHEN h.cost_cents IS NULL OR h.value_cents IS NULL THEN '' ELSE money_text(h.value_cents - h.cost_cents, COALESCE(h.currency, ${HOME}), ${HOME}) END AS gain,
           CASE WHEN h.cost_cents IS NULL OR h.value_cents IS NULL THEN NULL WHEN h.value_cents < h.cost_cents THEN 'bad' ELSE 'good' END AS gain_tone,
           CASE WHEN h.prev_price > 0 THEN ROUND((h.price - h.prev_price) * 100.0 / h.prev_price, 2) END AS day_pct,
           CASE WHEN h.prev_price > 0 AND h.price < h.prev_price THEN 'bad' WHEN h.prev_price > 0 THEN 'good' END AS day_tone,
           CASE WHEN h.stale = 1 THEN 'warn' END AS tone
      FROM holding_values h ORDER BY ${HOLDING_HOME("h")} DESC NULLS LAST, h.symbol LIMIT 201`,
  row: { id: "id", title: "holding", tone: "tone" },
  columns: [
    { column: "holding", label: "Holding" },
    { column: "shares", label: "Shares" },
    { column: "price", label: "Price" },
    { column: "value", label: "Value" },
    { column: "gain", label: "Gain", tone: "gain_tone" },
    { column: "day_pct", label: "Day", format: "percent", tone: "day_tone" },
  ],
};

// --- the rails -----------------------------------------------------------------------------------

const PHONE: Record<RailKind, readonly ViewSpec[]> = { business: MONEY_VIEWS, family: BUDGET_VIEWS };

function phone(kind: RailKind, id: string, page: string, title?: string): ViewSpec {
  const spec = PHONE[kind].find((v) => v.id === id) ?? MONEY_VIEWS.find((v) => v.id === id);
  if (!spec) throw new Error(`no view ${id} for a ${kind} Space`);
  return { ...spec, page, ...(title ? { title } : {}) };
}

const at = (page: string, spec: ViewSpec, title?: string): ViewSpec => ({ ...spec, page, ...(title ? { title } : {}) });

function railed(kind: RailKind): ViewSpec[] {
  if (kind === "business") {
    return [
      at("Overview", BUSINESS_TILES), at("Overview", HEALTH),
      phone(kind, "money-in", "Overview"), phone(kind, "money-out", "Overview"), phone(kind, "to-check", "Overview"),
      at("Overview", river(kind)), phone(kind, "month", "Overview", "Kept by month"), at("Overview", insights(kind)),
      phone(kind, "activity", "Transactions"), at("Transactions", TRUST), at("Transactions", STATEMENTS),
      phone(kind, "overdue", "Invoices"), phone(kind, "aging", "Invoices"), phone(kind, "invoices", "Invoices"),
      at("Tax & costs", TAX), { ...phone("family", "all-bills", "Tax & costs", "Recurring costs"), hideEmpty: true }, phone(kind, "spending", "Tax & costs"),
    ];
  }
  return [
    at("Overview", FAMILY_TILES), at("Overview", SAVINGS),
    phone(kind, "money-in", "Overview"), phone(kind, "money-out", "Overview"), phone(kind, "to-check", "Overview"),
    at("Overview", river(kind)), phone(kind, "bills", "Overview"), phone(kind, "accounts", "Overview", "Net worth by account"),
    phone(kind, "activity", "Transactions"), at("Transactions", TRUST), at("Transactions", STATEMENTS),
    phone(kind, "month", "Budget"), phone(kind, "left", "Budget"), phone(kind, "categories", "Budget"), phone(kind, "note", "Budget"), phone(kind, "goals", "Budget"), at("Budget", insights(kind)),
    at("Recurring", CALENDAR), phone(kind, "all-bills", "Recurring", "Bills and subscriptions"),
    at("Investments", INVEST_TILES), at("Investments", PERFORMANCE), at("Investments", MIX), at("Investments", HOLDINGS),
  ];
}

/**
 * The desk's Money views for a kind of Space: the rail's pages in order, then every other view the phone has
 * (pages a row opens, lists a chart drills into, the Space page's tiles), so `/view` answers each of them.
 */
export function financeDeskViews(kind: RailKind): readonly ViewSpec[] {
  const rail = railed(kind);
  const ids = new Set(rail.map((v) => v.id));
  const rest = [...PHONE[kind], ...MONEY_VIEWS].filter((v) => {
    if (ids.has(v.id)) return false;
    ids.add(v.id);
    return true;
  });
  return [...rail, ...rest];
}

/** The month a business's Overview opens on: this one, or the last full month until the 10th (frame 05). */
export function openingMonth(today: string, kind: RailKind): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  if (kind !== "business" || d >= 10) return today.slice(0, 7);
  const back = new Date(Date.UTC(y, m - 2, 1));
  return back.toISOString().slice(0, 7);
}
