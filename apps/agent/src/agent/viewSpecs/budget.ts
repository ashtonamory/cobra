// The Personal Budget board: a family
// Space's Money seat draws this instead of the business board (views.ts
// `viewsFor`). The same tables, a person's words: what is left to spend this
// month, where the money is (accounts in groups, each in its own currency),
// each category against its limit (trades/budget.ts), the bills still to come
// this month (trades/bills.ts: committed money, off Left to spend until paid),
// money in and out over six months, savings goals and loans (trades/goals.ts),
// the latest spending, and Cobra's note over it all, written from those
// numbers with no model.
// The board follows its month switch (`monthly`: the app sends `month`, and
// monthStart / monthEnd bind to it). Every total counts in the home currency at
// the rate of the day the money moved. To allow, all spending, money in and the
// bank lines stay as Money's lists, since receipts and bank files land there.
import type { ViewSpec } from "../../../../../packages/contracts/src/views.ts";
import { BILL_CURRENCY_SQL, BILL_HOME_SQL, COMMITTED_SQL, DUE_IN_SQL, DUE_ON_SQL, PAID_IN_SQL } from "../trades/bills.ts";
import { LIMIT_SQL } from "../trades/budget.ts";
import { ACCOUNT_WORD, CURRENCY_OF, EXPENSE_HOME, HOME, HOME_NOTE, INCOME_HOME, IN_HOME, MONEY_VIEWS, MONTH_IN, MONTH_OUT, MONTH_WORD, PAID_NOTE, SIX_MONTHS, SPENDING_SQL, WAITING_COUNT } from "./money.ts";

/** Home cents written out in the home currency. */
const HOME_TEXT = (cents: string): string => `money_text(${cents}, ${HOME}, ${HOME})`;

/** The month's bounds and today, as a row `p` the rest reads (month, ms, me, td). Binds MONTH_PARAMS. */
const MONTH_ROW = "(SELECT ? AS month, ? AS ms, ? AS me, ? AS td) p";
const MONTH_PARAMS = ["month", "monthStart", "monthEnd", "today"] as const;

/** This month's limits, spending and bills still to pay, all in home cents, over a row `p` (MONTH_ROW, or the CTE `p`). */
const TOTALS = (from: string): string => `
  SELECT COALESCE((SELECT SUM(${LIMIT_SQL("c.id", "p.month")}) FROM categories c WHERE c.kind = 'expense'), 0) AS limit_cents,
         COALESCE((SELECT SUM(${EXPENSE_HOME("e")}) FROM expenses e WHERE e.status = 'recorded' AND e.spent_on >= p.ms AND e.spent_on <= p.me), 0) AS spent_cents,
         ${COMMITTED_SQL("p.ms", "p.me", "p.td")} AS committed_cents,
         CASE WHEN p.td >= p.ms AND p.td <= p.me THEN CAST(julianday(p.me) - julianday(p.td) AS INTEGER) + 1 ELSE 0 END AS days_left
    FROM ${from}`;
/** TOTALS over the month the board shows. Binds MONTH_PARAMS. */
const MONTH_TOTALS = TOTALS(MONTH_ROW);
/** The month's bounds and today as a CTE `p`, for a query with several parts. Binds MONTH_PARAMS. */
const MONTH_CTE = "p AS (SELECT ? AS month, ? AS ms, ? AS me, ? AS td)";

/** A day's number with its ending: 1st, 2nd, 3rd, 11th, 22nd. */
const ORDINAL = (day: string): string => `(CAST(strftime('%d', ${day}) AS INTEGER) || CASE
  WHEN CAST(strftime('%d', ${day}) AS INTEGER) BETWEEN 11 AND 13 THEN 'th'
  WHEN CAST(strftime('%d', ${day}) AS INTEGER) % 10 = 1 THEN 'st'
  WHEN CAST(strftime('%d', ${day}) AS INTEGER) % 10 = 2 THEN 'nd'
  WHEN CAST(strftime('%d', ${day}) AS INTEGER) % 10 = 3 THEN 'rd' ELSE 'th' END)`;
/** A day's month and year: "Jun 2027". */
const MONTH_YEAR = (day: string): string =>
  `(substr('JanFebMarAprMayJunJulAugSepOctNovDec', 3 * CAST(strftime('%m', ${day}) AS INTEGER) - 2, 3) || ' ' || strftime('%Y', ${day}))`;
/** A day's month in full: "October". */
const MONTH_NAME = (day: string): string =>
  `(CASE CAST(strftime('%m', ${day}) AS INTEGER) WHEN 1 THEN 'January' WHEN 2 THEN 'February' WHEN 3 THEN 'March' WHEN 4 THEN 'April' WHEN 5 THEN 'May' WHEN 6 THEN 'June'
     WHEN 7 THEN 'July' WHEN 8 THEN 'August' WHEN 9 THEN 'September' WHEN 10 THEN 'October' WHEN 11 THEN 'November' ELSE 'December' END)`;
/** Months from `from` to `to` (YYYY-MM-DD), counting whole calendar months. */
const MONTHS_BETWEEN = (from: string, to: string): string =>
  `((CAST(strftime('%Y', ${to}) AS INTEGER) - CAST(strftime('%Y', ${from}) AS INTEGER)) * 12 + CAST(strftime('%m', ${to}) AS INTEGER) - CAST(strftime('%m', ${from}) AS INTEGER))`;
/** Whole cents divided, rounded up. */
const CEIL_DIV = (cents: string, by: string): string => `((${cents} + ${by} - 1) / ${by})`;

/** What a category (alias c) spent in the month `p`, home cents. */
const CATEGORY_SPENT = (c: string): string =>
  `COALESCE((SELECT SUM(${EXPENSE_HOME("e")}) FROM expenses e WHERE e.category_id = ${c}.id AND e.status = 'recorded' AND e.spent_on >= p.ms AND e.spent_on <= p.me), 0)`;
/** How far a category (alias c) is over its limit in the month `p`, home cents; NULL with no limit. */
const CATEGORY_OVER = (c: string): string =>
  `(${CATEGORY_SPENT(c)} + ${COMMITTED_SQL("p.ms", "p.me", "p.td", `${c}.id`)} - ${LIMIT_SQL(`${c}.id`, "p.month")})`;
/** Money in between two days (income and payments), home cents. */
const IN_SQL = (start: string, end: string): string =>
  `(COALESCE((SELECT SUM(${INCOME_HOME("i")}) FROM money_moves i WHERE i.kind = 'income' AND i.status = 'recorded' AND i.moved_on >= ${start} AND i.moved_on <= ${end}), 0)
    + COALESCE((SELECT SUM(pm.amount_cents) FROM payments pm WHERE pm.received_on >= ${start} AND pm.received_on <= ${end}), 0))`;
/** True when the month `p` has no limits at all. */
const LIMITS_NONE = `NOT EXISTS (SELECT 1 FROM categories lc WHERE lc.kind = 'expense' AND ${LIMIT_SQL("lc.id", "p.month")} IS NOT NULL)`;

/**
 * Cobra's note: one or two sentences from the month's own numbers, written
 * here with no model, so a Sensitive Space's numbers never leave the computer. First what most needs saying
 * (a category over, the month over or ahead of itself, or on track; a past month's result), then the bills:
 * one late, else the next to pay, else all paid. Read fresh with the board, so it never goes stale.
 */
const NOTE_SQL = `
  WITH ${MONTH_CTE},
  t AS (${TOTALS("p")}),
  cats AS (SELECT c.name AS name, ${CATEGORY_OVER("c")} AS over, ${CATEGORY_SPENT("c")} AS spent FROM categories c, p WHERE c.kind = 'expense'),
  overs AS (SELECT name, over FROM cats WHERE over > 0),
  due AS (
    SELECT b.name AS name, ${DUE_ON_SQL("b", "p.ms", "p.me")} AS due_on, b.amount_cents AS amount_cents, ${BILL_CURRENCY_SQL("b")} AS currency,
           ${PAID_IN_SQL("b", "p.ms", "p.me")} AS paid
      FROM bills b, p WHERE ${DUE_IN_SQL("b", "p.ms", "p.me")}),
  late AS (SELECT d.* FROM due d, p WHERE NOT d.paid AND d.due_on < p.td ORDER BY d.due_on, d.name LIMIT 1),
  next AS (SELECT d.* FROM due d, p WHERE NOT d.paid AND d.due_on >= p.td ORDER BY d.due_on, d.name LIMIT 1),
  facts AS (
    SELECT p.*, t.limit_cents AS lim, t.spent_cents AS spent, t.committed_cents AS committed, t.days_left AS days_left,
           (SELECT name FROM overs ORDER BY over DESC, name LIMIT 1) AS over_name,
           (SELECT MAX(over) FROM overs) AS over_cents,
           (SELECT COUNT(*) FROM overs) AS over_n,
           (SELECT name FROM cats WHERE spent > 0 ORDER BY spent DESC, name LIMIT 1) AS top_name,
           (SELECT MAX(spent) FROM cats) AS top_cents,
           (SELECT COUNT(*) FROM due) AS bills,
           (julianday(p.td) - julianday(p.ms) + 1) / (julianday(p.me) - julianday(p.ms) + 1) AS gone
      FROM p, t),
  said AS (
    SELECT
      CASE
        WHEN f.ms > f.td THEN 'Nothing has happened in ' || ${MONTH_NAME("f.ms")} || ' yet.'
        WHEN f.over_name IS NOT NULL THEN f.over_name || ' is ' || ${HOME_TEXT("f.over_cents")} || ' over'
          || CASE WHEN f.over_n = 2 THEN ', and one more category is over too.' WHEN f.over_n > 2 THEN ', and ' || (f.over_n - 1) || ' more categories are over too.' ELSE '.' END
        WHEN f.lim = 0 THEN CASE WHEN f.spent > 0 THEN 'No limits yet. Most went on ' || f.top_name || ' this month (' || ${HOME_TEXT("f.top_cents")} || ').' ELSE '' END
        WHEN f.td > f.me THEN CASE WHEN f.spent <= f.lim THEN 'You kept ' || ${HOME_TEXT("f.lim - f.spent")} || ' of your budget in ' || ${MONTH_NAME("f.ms")} || '.'
                                   ELSE ${MONTH_NAME("f.ms")} || ' went ' || ${HOME_TEXT("f.spent - f.lim")} || ' over.' END
        WHEN f.spent + f.committed > f.lim THEN 'With the bills to come, the month is ' || ${HOME_TEXT("f.spent + f.committed - f.lim")} || ' over.'
        WHEN CAST(f.spent AS REAL) / f.lim > f.gone + 0.1 THEN 'Spending is ahead of the month: ' || CAST(ROUND(100.0 * f.spent / f.lim) AS INTEGER) || '% of the budget is gone with '
          || f.days_left || CASE WHEN f.days_left = 1 THEN ' day' ELSE ' days' END || ' to go.'
        ELSE 'You are on track this month.' END AS first,
      CASE
        WHEN f.td < f.ms OR f.td > f.me THEN ''
        WHEN (SELECT COUNT(*) FROM late) > 0 THEN (SELECT name || ' was due on the ' || ${ORDINAL("due_on")} || ' and is not paid yet.' FROM late)
        WHEN (SELECT COUNT(*) FROM next) > 0 THEN (SELECT name || ' (' || money_text(amount_cents, currency, ${HOME}) || ') is due '
          || CASE WHEN due_on = f.td THEN 'today' WHEN due_on = date(f.td, '+1 day') THEN 'tomorrow' ELSE 'on the ' || ${ORDINAL("due_on")} END || '.' FROM next)
        WHEN f.bills > 0 THEN CASE WHEN f.bills = 1 THEN 'This month''s bill is paid.' ELSE 'Every bill this month is paid.' END
        ELSE '' END AS second
      FROM facts f)
  SELECT trim(first || CASE WHEN first <> '' AND second <> '' THEN ' ' ELSE '' END || second) AS note
    FROM said WHERE first <> '' OR second <> ''`;

/**
 * Savings with a goal and the loans, as meters that fill: saved of the goal, and paid of what was owed (the
 * opening balance, or more when it grew). Each in the home currency; the caption in the account's own.
 */
const GOALS_SQL = `
  WITH p AS (SELECT ? AS td)
  SELECT name, done_cents, whole_cents, tone, caption FROM (
    SELECT 0 AS g, a.name AS name, ${IN_HOME("MAX(a.balance_cents, 0)", "a.currency", "NULL")} AS done_cents, ${IN_HOME("a.goal_cents", "a.currency", "NULL")} AS whole_cents,
           CASE WHEN a.balance_cents < a.goal_cents AND a.goal_on < p.td THEN 'warn' ELSE 'good' END AS tone,
           CASE WHEN a.balance_cents >= a.goal_cents THEN 'Reached · ' || money_text(a.balance_cents, a.currency, ${HOME}) || ' saved'
                ELSE money_text(a.goal_cents - a.balance_cents, a.currency, ${HOME}) || ' to go'
                  || CASE WHEN a.goal_on IS NULL THEN ''
                          WHEN a.goal_on < p.td THEN ' · was due ' || ${MONTH_YEAR("a.goal_on")}
                          ELSE ' · about ' || money_text(${CEIL_DIV("(a.goal_cents - MAX(a.balance_cents, 0))", `MAX(${MONTHS_BETWEEN("p.td", "a.goal_on")}, 1)`)}, a.currency, ${HOME})
                            || ' a month to reach it by ' || ${MONTH_YEAR("a.goal_on")} END END AS caption
      FROM account_balances a, p WHERE a.archived_at IS NULL AND a.kind = 'savings' AND a.goal_cents > 0
    UNION ALL
    SELECT 1, a.name, ${IN_HOME("MAX(-a.opening_cents, -a.balance_cents, 0) - MAX(-a.balance_cents, 0)", "a.currency", "NULL")},
           ${IN_HOME("MAX(-a.opening_cents, -a.balance_cents, 0)", "a.currency", "NULL")}, 'good',
           CASE WHEN a.balance_cents >= 0 THEN 'Paid off'
                ELSE money_text(-a.balance_cents, a.currency, ${HOME}) || ' left'
                  || CASE WHEN COALESCE(a.payment_cents, 0) <= 0 THEN ''
                          ELSE ' · ' || ${CEIL_DIV("-a.balance_cents", "a.payment_cents")} || CASE WHEN ${CEIL_DIV("-a.balance_cents", "a.payment_cents")} = 1 THEN ' payment' ELSE ' payments' END
                            || ' · paid off ' || ${MONTH_YEAR(`date(p.td, 'start of month', '+' || (${CEIL_DIV("-a.balance_cents", "a.payment_cents")}
                                 - CASE WHEN EXISTS (SELECT 1 FROM expenses le WHERE le.status = 'recorded' AND le.loan_id = a.id AND substr(le.spent_on, 1, 7) = substr(p.td, 1, 7)) THEN 0 ELSE 1 END) || ' months')`)} END END
      FROM account_balances a, p WHERE a.archived_at IS NULL AND a.kind = 'loan' AND (a.balance_cents < 0 OR a.opening_cents < 0))
   ORDER BY g, name LIMIT 201`;

/** Which group an account is in, by its kind: everyday money, savings, investments, debts. */
const GROUP_ORDER = "CASE a.kind WHEN 'savings' THEN 1 WHEN 'investment' THEN 2 WHEN 'loan' THEN 3 ELSE 0 END";

/** One of Money's own views, as the budget shows it (a title in a person's words). */
function money(id: string, title?: string): ViewSpec {
  const spec = MONEY_VIEWS.find((v) => v.id === id);
  if (!spec) throw new Error(`Money has no view ${id}`);
  return title ? { ...spec, title } : spec;
}

export const BUDGET_VIEWS: readonly ViewSpec[] = [
  {
    id: "summary",
    title: "Budget",
    kind: "tiles",
    summary: true,
    // The first tile is what a Space's Overview shows on its Money card, without its label, so it is
    // never a negative "left": with no limits it is what was spent, and over the limits it says by how much.
    sql: `
      SELECT label, value, caption, tone, format FROM (
        SELECT 0 AS n, CASE WHEN t.limit_cents = 0 THEN 'Spent this month' WHEN t.spent_cents + t.committed_cents > t.limit_cents THEN 'Over budget' ELSE 'Left to spend' END AS label,
               CASE WHEN t.limit_cents = 0 THEN t.spent_cents ELSE ABS(t.limit_cents - t.spent_cents - t.committed_cents) END AS value,
               CASE WHEN t.limit_cents = 0 THEN 'no limits yet: ask Cobra to set them' ELSE 'of ' || ${HOME_TEXT("t.limit_cents")} END
                 || CASE WHEN t.committed_cents > 0 THEN ' · ' || ${HOME_TEXT("t.committed_cents")} || ' for bills' ELSE '' END AS caption,
               CASE WHEN t.limit_cents > 0 AND t.spent_cents + t.committed_cents > t.limit_cents THEN 'bad' END AS tone, 'money' AS format
          FROM (${MONTH_TOTALS}) t
        UNION ALL
        SELECT 1, 'Spent this month', t.spent_cents, 'every account, in the home currency',
               CASE WHEN t.limit_cents > 0 AND t.spent_cents + t.committed_cents > t.limit_cents THEN 'bad' END, 'money'
          FROM (${MONTH_TOTALS}) t WHERE t.limit_cents > 0
        UNION ALL
        SELECT 1, 'Money in this month', ${IN_SQL("p.ms", "p.me")}, 'income, in the home currency', NULL, 'money' FROM ${MONTH_ROW}
         WHERE ${LIMITS_NONE}
        UNION ALL
        SELECT 2, 'Waiting for you', ${WAITING_COUNT}, 'to allow', CASE WHEN ${WAITING_COUNT} > 0 THEN 'warn' END, 'text')
       ORDER BY n`,
    params: [...MONTH_PARAMS, ...MONTH_PARAMS, ...MONTH_PARAMS],
  },
  money("money-in"),
  money("money-out"),
  money("to-check"),
  // The month: what was spent, what came in and what was left over, over six months.
  {
    id: "month",
    title: "This month",
    kind: "chart",
    monthly: true,
    sql: `
      WITH ${SIX_MONTHS},
      t AS (SELECT m.month AS month, ${MONTH_IN} AS in_cents, ${MONTH_OUT} AS out_cents FROM months m)
      SELECT t.month AS month, t.out_cents AS out_cents, t.in_cents AS in_cents, t.in_cents - t.out_cents AS left_cents,
             'in ' || ${MONTH_WORD("t.month || '-01'")} || CASE WHEN t.month = substr(?, 1, 7) THEN ' so far' ELSE '' END AS caption
        FROM t ORDER BY t.month`,
    params: ["monthStart", "today"],
    chart: {
      type: "hero", x: "month", xKind: "month", format: "money", hero: { column: "out_cents", label: "Spent" }, caption: "caption",
      series: [{ column: "in_cents", label: "Came in" }, { column: "left_cents", label: "Left over" }],
      bars: ["in_cents", "out_cents"],
      empty: "Nothing spent or come in this month yet.",
    },
  },
  {
    id: "note",
    title: "Cobra's note",
    kind: "timeline",
    onBoard: true,
    monthly: true,
    sql: NOTE_SQL,
    params: [...MONTH_PARAMS],
    row: { title: "note" },
  },
  {
    id: "left",
    title: "Left to spend",
    kind: "chart",
    hideEmpty: true,
    monthly: true,
    // Only once limits are set: the month's limits less what was spent and the bills still to pay (committed, only while the month runs); going over comes off the total.
    sql: `
      SELECT 'Left to spend' AS label, t.spent_cents AS spent_cents, t.committed_cents AS committed_cents, t.limit_cents AS limit_cents,
             CASE WHEN t.limit_cents = 0 THEN 'No limits yet: ask Cobra to set them'
                  WHEN t.days_left > 0 AND t.limit_cents > t.spent_cents + t.committed_cents THEN t.days_left || CASE WHEN t.days_left = 1 THEN ' day' ELSE ' days' END || ' to go · about ' || ${HOME_TEXT("(t.limit_cents - t.spent_cents - t.committed_cents) / t.days_left")} || ' a day'
                  WHEN t.days_left > 0 THEN t.days_left || CASE WHEN t.days_left = 1 THEN ' day' ELSE ' days' END || ' to go · ' || ${HOME_TEXT("t.spent_cents + t.committed_cents - t.limit_cents")} || ' over'
                  WHEN t.limit_cents >= t.spent_cents THEN 'Kept ' || ${HOME_TEXT("t.limit_cents - t.spent_cents")}
                  ELSE ${HOME_TEXT("t.spent_cents - t.limit_cents")} || ' over' END AS caption
        FROM (${MONTH_TOTALS}) t WHERE t.limit_cents > 0`,
    params: [...MONTH_PARAMS],
    chart: {
      type: "meter", x: "label", format: "money", reads: "left", limit: "limit_cents", caption: "caption",
      series: [{ column: "spent_cents", label: "Spent" }, { column: "committed_cents", label: "Bills still to come" }],
    },
  },
  {
    id: "categories",
    title: "Categories",
    kind: "chart",
    hideEmpty: true,
    monthly: true,
    // With limits set (else Spending's plain bars): each category with a limit, spending or a bill this month, the fullest first (an over one on top); its bills still to pay count against it.
    sql: `
      SELECT name, spent_cents, committed_cents, COALESCE(limit_cents, 0) AS limit_cents,
             CASE WHEN limit_cents IS NULL THEN 'No limit'
                  WHEN spent_cents + committed_cents > limit_cents THEN ${HOME_TEXT("spent_cents + committed_cents - limit_cents")} || ' over'
                  ELSE ${HOME_TEXT("limit_cents - spent_cents - committed_cents")} || ' left' END
               || CASE WHEN committed_cents > 0 THEN ' · ' || ${HOME_TEXT("committed_cents")} || ' in bills to come' ELSE '' END AS caption
        FROM (
          SELECT c.name AS name, ${LIMIT_SQL("c.id", "p.month")} AS limit_cents,
                 COALESCE((SELECT SUM(${EXPENSE_HOME("e")}) FROM expenses e WHERE e.category_id = c.id AND e.status = 'recorded' AND e.spent_on >= p.ms AND e.spent_on <= p.me), 0) AS spent_cents,
                 ${COMMITTED_SQL("p.ms", "p.me", "p.td", "c.id")} AS committed_cents
            FROM categories c, ${MONTH_ROW} WHERE c.kind = 'expense' AND EXISTS (SELECT 1 FROM categories lc WHERE lc.kind = 'expense' AND ${LIMIT_SQL("lc.id", "p.month")} IS NOT NULL))
       WHERE limit_cents IS NOT NULL OR spent_cents > 0 OR committed_cents > 0
       ORDER BY limit_cents IS NULL, CAST(spent_cents + committed_cents AS REAL) / COALESCE(limit_cents, 1) DESC, name LIMIT 201`,
    params: [...MONTH_PARAMS],
    chart: {
      type: "meter", x: "name", xKind: "text", format: "money", limit: "limit_cents", caption: "caption", drill: "category-spending",
      series: [{ column: "spent_cents", label: "Spent" }, { column: "committed_cents", label: "Bills still to come" }], empty: "Nothing spent this month yet.",
    },
  },
  {
    ...money("spending"),
    // With no limits set: plain bars, biggest first. Once limits are set, Categories' meters take its place.
    sql: SPENDING_SQL(` AND NOT EXISTS (SELECT 1 FROM categories lc WHERE lc.kind = 'expense' AND ${LIMIT_SQL("lc.id", "substr(?, 1, 7)")} IS NOT NULL)`),
    params: ["monthStart", "monthEnd", "monthStart"],
  },
  {
    id: "bills",
    title: "Bills this month",
    kind: "list",
    hideEmpty: true,
    onBoard: true,
    monthly: true,
    // The month's bills by the day they are due: to pay first (late ones marked), then the paid ones.
    sql: `
      SELECT id, name, due_on, amount_cents, currency,
             ltrim(CASE WHEN paid THEN 'Paid' WHEN due_on < td THEN 'Not paid yet' ELSE '' END || CASE WHEN extra <> '' THEN ' · ' || extra ELSE '' END, ' ·') AS detail,
             CASE WHEN paid THEN 'good' WHEN due_on < td THEN 'warn' END AS tone
        FROM (
          SELECT b.id AS id, b.name AS name, ${DUE_ON_SQL("b", "p.ms", "p.me")} AS due_on, b.amount_cents AS amount_cents, ${BILL_CURRENCY_SQL("b")} AS currency,
                 ${PAID_IN_SQL("b", "p.ms", "p.me")} AS paid, p.td AS td,
                 ltrim(COALESCE(c.name, '') || COALESCE(' · from ' || a.name, '')
                   || CASE WHEN ${BILL_CURRENCY_SQL("b")} <> ${HOME} THEN ' · ≈ ' || ${HOME_TEXT(BILL_HOME_SQL("b", "p.td"))} ELSE '' END, ' ·') AS extra
            FROM bills b LEFT JOIN categories c ON c.id = b.category_id LEFT JOIN accounts a ON a.id = b.account_id, ${MONTH_ROW}
           WHERE ${DUE_IN_SQL("b", "p.ms", "p.me")})
       ORDER BY paid, due_on, name LIMIT 201`,
    params: [...MONTH_PARAMS],
    row: { id: "id", title: "name", subtitle: "detail", badge: "due_on", trailing: "amount_cents", tone: "tone" },
    formats: { due_on: "date", amount_cents: "money" },
    currencies: { amount_cents: "currency" },
  },
  {
    id: "accounts",
    title: "Accounts",
    kind: "list",
    hideEmpty: true,
    onBoard: true,
    // Where the money is now, each in its own currency, in four groups with their totals in the home one.
    sql: `
      SELECT id, name, caption, balance_cents, currency, tone,
             CASE g WHEN 0 THEN 'Everyday' WHEN 1 THEN 'Savings' WHEN 2 THEN 'Investments' ELSE 'Debts' END AS grp,
             CASE g WHEN 0 THEN 'spendable ' WHEN 3 THEN 'left ' ELSE '' END
               || ${HOME_TEXT("CASE g WHEN 3 THEN -1 ELSE 1 END * SUM(home) OVER (PARTITION BY g)")} AS grp_total
        FROM (
          SELECT a.id AS id, a.name AS name, ${ACCOUNT_WORD} || ${HOME_NOTE("a.balance_cents", "a.currency", "NULL")} AS caption,
                 a.balance_cents AS balance_cents, a.currency AS currency, ${IN_HOME("a.balance_cents", "a.currency", "NULL")} AS home,
                 CASE WHEN a.balance_cents < 0 AND a.kind NOT IN ('card', 'loan') THEN 'bad' END AS tone, ${GROUP_ORDER} AS g
            FROM account_balances a WHERE a.archived_at IS NULL)
       ORDER BY g, id LIMIT 201`,
    row: { id: "id", title: "name", subtitle: "caption", trailing: "balance_cents", tone: "tone", group: "grp", groupTrailing: "grp_total" },
    formats: { balance_cents: "money" },
    currencies: { balance_cents: "currency" },
  },
  {
    id: "goals",
    title: "Goals and debts",
    kind: "chart",
    hideEmpty: true,
    sql: GOALS_SQL,
    params: ["today"],
    chart: {
      type: "meter", x: "name", xKind: "text", format: "money", limit: "whole_cents", caption: "caption", tone: "tone",
      series: [{ column: "done_cents", label: "Saved or paid" }],
      empty: "No savings goals or loans yet: tell Cobra what you are saving for.",
    },
  },
  money("activity"),
  money("expense"),
  money("move"),
  money("waiting"),
  money("expenses", "All spending"),
  money("moves", "Money in and transfers"),
  money("bank", "Bank lines"),
  {
    id: "all-bills",
    title: "All bills",
    kind: "list",
    // Every bill the person keeps, each in its own currency; Stop for one they no longer pay.
    sql: `
      SELECT b.id AS id, b.name AS name, b.status AS status, b.amount_cents AS amount_cents, ${BILL_CURRENCY_SQL("b")} AS currency,
             ltrim(CASE b.every WHEN 'year' THEN 'Every year on ' || CAST(strftime('%d', b.next_on) AS INTEGER) || ' ' || substr('JanFebMarAprMayJunJulAugSepOctNovDec', 3 * CAST(strftime('%m', b.next_on) AS INTEGER) - 2, 3)
                        ELSE 'Monthly on day ' || CAST(strftime('%d', b.next_on) AS INTEGER) END
                   || COALESCE(' · ' || c.name, '') || COALESCE(' · from ' || a.name, '')
                   || CASE WHEN b.status = 'stopped' THEN ' · stopped' ELSE '' END, ' ·') AS detail
        FROM bills b LEFT JOIN categories c ON c.id = b.category_id LEFT JOIN accounts a ON a.id = b.account_id
       WHERE b.status IN ('active', 'stopped')
       ORDER BY b.status = 'stopped', b.name LIMIT 201`,
    row: { id: "id", title: "name", subtitle: "detail", trailing: "amount_cents" },
    formats: { amount_cents: "money" },
    currencies: { amount_cents: "currency" },
    actions: [{ mutation: "bill_stop", label: "Stop", on: "row", fixed: { id: "id" }, confirm: true, showWhen: { column: "status", equals: "active" } }],
  },
  {
    id: "category-spending",
    title: "Spending",
    kind: "list",
    fromChart: true,
    monthly: true,
    sql: `
      SELECT e.id AS id, COALESCE(NULLIF(e.description, ''), v.name, 'Spending') AS description,
             ltrim(COALESCE(a.name, '') || ${PAID_NOTE("e")} || ${HOME_NOTE("e.amount_cents", CURRENCY_OF("e.account_id"), "e.spent_on")}, ' ·') AS detail,
             e.spent_on AS spent_on, e.amount_cents AS amount_cents, ${CURRENCY_OF("e.account_id")} AS currency
        FROM expenses e LEFT JOIN categories c ON c.id = e.category_id LEFT JOIN vendors v ON v.id = e.vendor_id LEFT JOIN accounts a ON a.id = e.account_id
       WHERE e.status = 'recorded' AND e.spent_on >= ? AND e.spent_on <= ? AND (? = '' OR c.name = ?)
       ORDER BY e.spent_on DESC, e.id DESC LIMIT 201`,
    params: ["monthStart", "monthEnd", "key", "key"],
    row: { id: "id", title: "description", subtitle: "detail", badge: "spent_on", trailing: "amount_cents" },
    formats: { spent_on: "date", amount_cents: "money" },
    currencies: { amount_cents: "currency" },
  },
];
