// The Money trade's views: the books
// of a business, the dues of a team, the budget of a family, over Billing's
// invoicing tables, the expenses, the bank lines and the people. Cash basis: an
// invoice is money owed until a payment is recorded against it, an expense
// counts once the person allows it, a bank line counts once its import is
// allowed. The Foreman proposes and stages; the buttons here are the person's
// Allow (expense_allow and transactions_allow are personOnly).
import type { ViewSpec } from "../../../../../packages/contracts/src/views.ts";
import { KEEPS_BUDGET_SQL } from "../trades/budget.ts";
import { HOME_SQL } from "../trades/currency.ts";

// Currencies: an account may keep another currency than the
// Space's home one. Totals count in the home currency at the rate of the day the money moved
// (fx.ts, `fx` in SQL), or the amount as kept when this computer has no rate; a list shows each
// line in its own currency (`currencies`) with the home amount on its second line.
export const HOME = HOME_SQL;
/** An account's currency, by the column holding its id; the home one for none. */
export const CURRENCY_OF = (accountId: string): string => `COALESCE((SELECT currency FROM accounts WHERE id = ${accountId}), ${HOME})`;
/** Whole cents in the home currency on that day; as kept with no rate. */
export const IN_HOME = (cents: string, currency: string, day: string): string => `COALESCE(fx(${cents}, ${currency}, ${HOME}, ${day}), ${cents})`;
export const EXPENSE_HOME = (e: string): string => IN_HOME(`${e}.amount_cents`, CURRENCY_OF(`${e}.account_id`), `${e}.spent_on`);
export const INCOME_HOME = (m: string): string => IN_HOME(`${m}.amount_cents`, CURRENCY_OF(`${m}.account_id`), `${m}.moved_on`);
/** " · ≈ EC$324.00" after a line kept in another currency; nothing for the home one or with no rate. */
export const HOME_NOTE = (cents: string, currency: string, day: string): string =>
  `COALESCE(CASE WHEN ${currency} != ${HOME} THEN ' · ≈ ' || money_text(fx(${cents}, ${currency}, ${HOME}, ${day}), ${HOME}, ${HOME}) END, '')`;
/** " · paid €45.00" after an expense paid in a third currency (a receipt in euros on a US$ card). */
export const PAID_NOTE = (e: string): string => `COALESCE(' · paid ' || money_text(${e}.paid_cents, ${e}.paid_currency, ${HOME}), '')`;

/** An invoice somebody still owes on: issued or part paid. */
const OPEN = "i.status IN ('issued', 'part_paid')";

/** What waits on the person's Allow: proposed expenses and income or transfers, and staged bank files. */
export const WAITING_COUNT = "(SELECT COUNT(*) FROM expenses WHERE status = 'proposed') + (SELECT COUNT(*) FROM money_moves WHERE status = 'proposed') + (SELECT COUNT(*) FROM import_batches WHERE status = 'pending')";

/** An account's kind in words, for a tile's caption and a list's line. */
export const ACCOUNT_WORD = "CASE a.kind WHEN 'cash' THEN 'Cash' WHEN 'bank' THEN 'Bank account' WHEN 'card' THEN 'Card' WHEN 'savings' THEN 'Savings' WHEN 'investment' THEN 'Investment' WHEN 'loan' THEN 'Loan' ELSE 'Account' END";

/** How late an open invoice is, as the aging chart's bucket words. Binds `today` four times. */
const AGE_BUCKET = `
  CASE WHEN i.due_date IS NULL OR i.due_date >= ? THEN 'Not due yet'
       WHEN julianday(?) - julianday(i.due_date) <= 30 THEN '1–30 days late'
       WHEN julianday(?) - julianday(i.due_date) <= 60 THEN '31–60 days late'
       WHEN julianday(?) - julianday(i.due_date) <= 90 THEN '61–90 days late'
       ELSE 'Over 90 days late' END`;

// The finance refit: one screen per Space. What waits on the person first, in two
// groups (money in, money out) each with Review and Allow all, then the month, where the money went, the accounts,
// one list of everything that moved, and the invoices. A section with nothing in it is left off (`hideEmpty`).

/** "31 Oct" from a YYYY-MM-DD (SQLite's strftime has no month names). */
export const DAY = (column: string): string =>
  `(CAST(strftime('%d', ${column}) AS INTEGER) || ' ' || substr('JanFebMarAprMayJunJulAugSepOctNovDec', CAST(strftime('%m', ${column}) AS INTEGER) * 3 - 2, 3))`;
/** "Fri 31 Oct": a day heading in a list. */
export const WEEKDAY = (column: string): string => `(substr('SunMonTueWedThuFriSat', CAST(strftime('%w', ${column}) AS INTEGER) * 3 + 1, 3) || ' ' || ${DAY(column)})`;
/** A day's month in full: "October". */
export const MONTH_WORD = (day: string): string =>
  `(CASE CAST(strftime('%m', ${day}) AS INTEGER) WHEN 1 THEN 'January' WHEN 2 THEN 'February' WHEN 3 THEN 'March' WHEN 4 THEN 'April' WHEN 5 THEN 'May' WHEN 6 THEN 'June'
     WHEN 7 THEN 'July' WHEN 8 THEN 'August' WHEN 9 THEN 'September' WHEN 10 THEN 'October' WHEN 11 THEN 'November' ELSE 'December' END)`;

/** The six months up to the board's, oldest first, as a CTE `months` (month YYYY-MM). Binds monthStart. */
export const SIX_MONTHS = `back(n) AS (VALUES (5), (4), (3), (2), (1), (0)), months AS (SELECT strftime('%Y-%m', date(?, '-' || n || ' months')) AS month FROM back)`;
/** What came in during month `m.month` (recorded income and invoice payments), home cents. */
export const MONTH_IN = `(COALESCE((SELECT SUM(${INCOME_HOME("i")}) FROM money_moves i WHERE i.kind = 'income' AND i.status = 'recorded' AND substr(i.moved_on, 1, 7) = m.month), 0)
    + COALESCE((SELECT SUM(pm.amount_cents) FROM payments pm WHERE substr(pm.received_on, 1, 7) = m.month), 0))`;
/** What went out during month `m.month` (recorded expenses), home cents. */
export const MONTH_OUT = `COALESCE((SELECT SUM(${EXPENSE_HOME("e")}) FROM expenses e WHERE e.status = 'recorded' AND substr(e.spent_on, 1, 7) = m.month), 0)`;

/**
 * Everything that moved in the board's month, one row each: recorded expenses (out), income and transfers, and
 * invoice payments (in). `page` is what a tap opens, `dir` in, out or move, `acct` and `to_acct` the accounts it
 * touched, for the chips. Binds monthStart and monthEnd three times.
 */
const ACTIVITY_ROWS = `
  SELECT e.id AS id, 'expense' AS page, 'out' AS dir, e.account_id AS acct, NULL AS to_acct,
         COALESCE(v.name, NULLIF(e.description, ''), c.name, 'Expense') AS title,
         ltrim(COALESCE(c.name, '') || COALESCE(' · ' || a.name, '') || ${PAID_NOTE("e")} || ${HOME_NOTE("e.amount_cents", CURRENCY_OF("e.account_id"), "e.spent_on")}, ' ·') AS subtitle,
         e.spent_on AS day, -e.amount_cents AS amount_cents, ${CURRENCY_OF("e.account_id")} AS currency, NULL AS tone
    FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id LEFT JOIN categories c ON c.id = e.category_id LEFT JOIN accounts a ON a.id = e.account_id
   WHERE e.status = 'recorded' AND e.spent_on >= ? AND e.spent_on <= ?
  UNION ALL
  SELECT m.id, 'move', CASE m.kind WHEN 'income' THEN 'in' ELSE 'move' END, m.account_id, m.to_account_id,
         COALESCE(NULLIF(m.description, ''), CASE m.kind WHEN 'income' THEN 'Income' WHEN 'revalue' THEN 'New balance' ELSE 'Transfer' END),
         CASE m.kind WHEN 'income' THEN 'Into ' || COALESCE(a.name, '?') || COALESCE(' · ' || c.name, '')
                     WHEN 'revalue' THEN COALESCE(a.name, '?') || ' · a new balance'
                     ELSE COALESCE(a.name, '?') || ' → ' || COALESCE(t.name, '?') || ' · a transfer' END,
         m.moved_on, m.amount_cents, ${CURRENCY_OF("m.account_id")}, CASE m.kind WHEN 'income' THEN 'good' END
    FROM money_moves m LEFT JOIN accounts a ON a.id = m.account_id LEFT JOIN accounts t ON t.id = m.to_account_id LEFT JOIN categories c ON c.id = m.category_id
   WHERE m.status = 'recorded' AND m.moved_on >= ? AND m.moved_on <= ?
  UNION ALL
  SELECT pm.invoice_id, 'invoice', 'in', pm.account_id, NULL, COALESCE(cu.name, 'Payment'),
         'Paid ' || COALESCE(i.number, 'an invoice') || COALESCE(' · ' || pm.method, ''),
         pm.received_on, pm.amount_cents, ${HOME}, 'good'
    FROM payments pm LEFT JOIN invoices i ON i.id = pm.invoice_id LEFT JOIN customers cu ON cu.id = i.customer_id
   WHERE pm.received_on >= ? AND pm.received_on <= ?`;
const ACTIVITY_PARAMS = ["monthStart", "monthEnd", "monthStart", "monthEnd", "monthStart", "monthEnd"] as const;

/** The month's spending by category, biggest first, with each one's share of the biggest for its bar. `extra` narrows the expenses. Binds monthStart and monthEnd. */
export const SPENDING_SQL = (extra = ""): string => `
  WITH s AS (
    SELECT COALESCE(c.name, 'Uncategorized') AS name, COUNT(*) AS n, SUM(${EXPENSE_HOME("e")}) AS total_cents
      FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
     WHERE e.status = 'recorded' AND e.spent_on >= ? AND e.spent_on <= ?${extra}
     GROUP BY 1
  )
  SELECT name AS id, name, n || ' expense' || CASE WHEN n = 1 THEN '' ELSE 's' END AS caption, total_cents,
         total_cents * 1.0 / (SELECT MAX(total_cents) FROM s) AS share
    FROM s ORDER BY total_cents DESC, name LIMIT 201`;

export const MONEY_VIEWS: readonly ViewSpec[] = [
  {
    id: "summary",
    title: "Money",
    kind: "tiles",
    summary: true,
    // `format` says how a tile's value reads: whole cents in the Space's currency, or a plain count.
    // Each open account's balance first (accounts.ts), in its own currency (`currency`), then what is owed, in and spent.
    sql: `
      SELECT * FROM (
        SELECT a.name AS label, a.balance_cents AS value, ${ACCOUNT_WORD} || ${HOME_NOTE("a.balance_cents", "a.currency", "NULL")} AS caption,
               CASE WHEN a.balance_cents < 0 AND a.kind NOT IN ('card', 'loan') THEN 'bad' END AS tone, 'money' AS format, a.currency AS currency
          FROM account_balances a WHERE a.archived_at IS NULL ORDER BY a.id)
      UNION ALL
      SELECT 'Owed to you', COALESCE(SUM(i.total_cents - COALESCE(i.paid_cents, 0)), 0),
             COUNT(*) || ' open', NULL, 'money', NULL
        FROM invoices i WHERE ${OPEN}
      UNION ALL
      SELECT 'Overdue', COALESCE(SUM(i.total_cents - COALESCE(i.paid_cents, 0)), 0), COUNT(*) || ' past due',
             CASE WHEN COUNT(*) > 0 THEN 'bad' END, 'money', NULL
        FROM invoices i WHERE ${OPEN} AND i.due_date < ?
      UNION ALL
      SELECT 'In this month',
             COALESCE((SELECT SUM(amount_cents) FROM payments WHERE received_on >= ? AND received_on <= ?), 0)
               + COALESCE((SELECT SUM(${INCOME_HOME("m")}) FROM money_moves m WHERE m.kind = 'income' AND m.status = 'recorded' AND m.moved_on >= ? AND m.moved_on <= ?), 0),
             'payments and income', NULL, 'money', NULL
      UNION ALL
      SELECT 'Spent this month', COALESCE(SUM(${EXPENSE_HOME("e")}), 0), 'recorded expenses', NULL, 'money', NULL
        FROM expenses e WHERE e.status = 'recorded' AND e.spent_on >= ? AND e.spent_on <= ?
      UNION ALL
      SELECT 'Waiting for you', ${WAITING_COUNT}, 'to allow', CASE WHEN ${WAITING_COUNT} > 0 THEN 'warn' END, 'text', NULL`,
    params: ["today", "monthStart", "monthEnd", "monthStart", "monthEnd", "monthStart", "monthEnd"],
  },
  // What waits on the person: money in and money out, each a group card with
  // its count and total, a peek, Review and Allow all (one Face ID for the rows shown, never more).
  {
    id: "money-in",
    title: "Money in to allow",
    kind: "list",
    onBoard: true,
    hideEmpty: true,
    peek: 3,
    opens: "move",
    sql: `
      SELECT m.id AS id, COALESCE(NULLIF(m.description, ''), 'Income') AS title,
             'Into ' || COALESCE(a.name, '?') || COALESCE(' · ' || c.name, '') || ' · ' || ${DAY("m.moved_on")} AS subtitle,
             m.amount_cents AS amount_cents, ${CURRENCY_OF("m.account_id")} AS currency, ${INCOME_HOME("m")} AS home_cents
        FROM money_moves m LEFT JOIN accounts a ON a.id = m.account_id LEFT JOIN categories c ON c.id = m.category_id
       WHERE m.kind = 'income' AND m.status = 'proposed'
       ORDER BY m.moved_on DESC, m.id DESC LIMIT 201`,
    row: { id: "id", title: "title", subtitle: "subtitle", trailing: "amount_cents" },
    formats: { amount_cents: "money" },
    currencies: { amount_cents: "currency" },
    batch: { mutation: "moves_allow", label: "Allow all", amount: "home_cents" },
  },
  {
    id: "money-out",
    title: "Money out to allow",
    kind: "list",
    onBoard: true,
    hideEmpty: true,
    peek: 3,
    opens: "expense",
    // In a Space that keeps a budget, one with no category waits for one: Allow all leaves it, and its line says so.
    sql: `
      SELECT e.id AS id, COALESCE(NULLIF(e.description, ''), v.name, 'Expense') AS title,
             ltrim(COALESCE(v.name, '') || COALESCE(' · ' || c.name, CASE WHEN ${KEEPS_BUDGET_SQL} THEN ' · needs a category' ELSE '' END) || ' · ' || ${DAY("e.spent_on")}, ' ·') AS subtitle,
             e.amount_cents AS amount_cents, ${CURRENCY_OF("e.account_id")} AS currency, ${EXPENSE_HOME("e")} AS home_cents,
             CASE WHEN e.category_id IS NULL AND ${KEEPS_BUDGET_SQL} THEN 'warn' END AS tone
        FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.status = 'proposed'
       ORDER BY e.spent_on DESC, e.id DESC LIMIT 201`,
    row: { id: "id", title: "title", subtitle: "subtitle", trailing: "amount_cents", tone: "tone" },
    formats: { amount_cents: "money" },
    currencies: { amount_cents: "currency" },
    batch: { mutation: "expenses_allow", label: "Allow all", amount: "home_cents" },
  },
  {
    id: "to-check",
    title: "Also waiting",
    kind: "list",
    onBoard: true,
    hideEmpty: true,
    peek: 3,
    // Transfers, new balances and bank files: each its own Allow.
    sql: `
      SELECT m.id AS id, 'move' AS kind, 'move' AS page,
             COALESCE(NULLIF(m.description, ''), CASE m.kind WHEN 'revalue' THEN 'New balance' ELSE 'Transfer' END) AS title,
             CASE m.kind WHEN 'revalue' THEN COALESCE(a.name, '?') || ' held this at the end of the day' ELSE COALESCE(a.name, '?') || ' → ' || COALESCE(t.name, '?') END
               || COALESCE(' · ' || money_text(m.to_amount_cents, ${CURRENCY_OF("m.to_account_id")}, ${HOME}) || ' arrived', '') || ' · ' || ${DAY("m.moved_on")} AS subtitle,
             m.moved_on AS on_date, m.amount_cents AS amount_cents, ${CURRENCY_OF("m.account_id")} AS currency
        FROM money_moves m LEFT JOIN accounts a ON a.id = m.account_id LEFT JOIN accounts t ON t.id = m.to_account_id
       WHERE m.status = 'proposed' AND m.kind != 'income'
      UNION ALL
      SELECT b.id, 'import', '', 'Bank file · ' || b.file_name, b.row_count || ' bank lines, ' || COALESCE(b.first_on, '') || ' to ' || COALESCE(b.last_on, ''),
             b.last_on, NULL, NULL
        FROM import_batches b WHERE b.status = 'pending'
       ORDER BY on_date DESC, id DESC LIMIT 201`,
    row: { id: "id", title: "title", subtitle: "subtitle", trailing: "amount_cents", opens: "page" },
    formats: { amount_cents: "money" },
    currencies: { amount_cents: "currency" },
    actions: [
      { mutation: "move_allow", label: "Allow", on: "row", fixed: { id: "id" }, showWhen: { column: "kind", equals: "move" } },
      { mutation: "transactions_allow", label: "Allow", on: "row", fixed: { batch_id: "id" }, showWhen: { column: "kind", equals: "import" } },
      { mutation: "transactions_drop", label: "Drop", on: "row", fixed: { batch_id: "id" }, showWhen: { column: "kind", equals: "import" } },
    ],
  },
  {
    id: "overdue",
    title: "Overdue invoices",
    kind: "list",
    onBoard: true,
    hideEmpty: true,
    peek: 3,
    opens: "invoice",
    sql: `
      SELECT i.id AS id, COALESCE(i.number, 'Draft ' || i.id) || COALESCE(' · ' || c.name, '') AS title,
             CAST(julianday(?) - julianday(i.due_date) AS INTEGER) || CASE WHEN CAST(julianday(?) - julianday(i.due_date) AS INTEGER) = 1 THEN ' day late' ELSE ' days late' END AS late,
             i.total_cents - COALESCE(i.paid_cents, 0) AS owed_cents, 'bad' AS tone, 'Remind' AS cta
        FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
       WHERE ${OPEN} AND i.due_date < ?
       ORDER BY i.due_date, i.id LIMIT 201`,
    params: ["today", "today", "today"],
    row: { id: "id", title: "title", subtitle: "late", trailing: "owed_cents", tone: "tone", cta: "cta" },
    formats: { owed_cents: "money" },
  },
  // The month (frame 02): what the business kept, what came in and went out, what is owed, and six months of bars.
  {
    id: "month",
    title: "This month",
    kind: "chart",
    monthly: true,
    sql: `
      WITH ${SIX_MONTHS},
      t AS (SELECT m.month AS month, ${MONTH_IN} AS in_cents, ${MONTH_OUT} AS out_cents FROM months m)
      SELECT t.month AS month, t.in_cents AS in_cents, t.out_cents AS out_cents, t.in_cents - t.out_cents AS kept_cents,
             CASE WHEN EXISTS (SELECT 1 FROM invoices) THEN (SELECT COALESCE(SUM(i.total_cents - COALESCE(i.paid_cents, 0)), 0) FROM invoices i WHERE ${OPEN}) END AS owed_cents,
             'in ' || ${MONTH_WORD("t.month || '-01'")} || CASE WHEN t.month = substr(?, 1, 7) THEN ' so far' ELSE '' END
               || CASE WHEN t.in_cents > 0 THEN ' · ' || CAST(ROUND((t.in_cents - t.out_cents) * 100.0 / t.in_cents) AS INTEGER) || '% of what came in' ELSE '' END AS caption,
             CASE WHEN t.in_cents < t.out_cents THEN 'bad' END AS tone
        FROM t ORDER BY t.month`,
    params: ["monthStart", "today"],
    chart: {
      type: "hero", x: "month", xKind: "month", format: "money", hero: { column: "kept_cents", label: "Kept" }, caption: "caption", tone: "tone",
      series: [{ column: "in_cents", label: "In" }, { column: "out_cents", label: "Out" }, { column: "owed_cents", label: "Owed to you" }],
      bars: ["in_cents", "out_cents"],
      empty: "What waits above counts here once you allow it.",
    },
  },
  {
    id: "spending",
    title: "Spending",
    kind: "list",
    onBoard: true,
    monthly: true,
    hideEmpty: true,
    peek: 4,
    sql: SPENDING_SQL(),
    params: ["monthStart", "monthEnd"],
    row: { id: "id", title: "name", subtitle: "caption", trailing: "total_cents", bar: "share" },
    formats: { total_cents: "money" },
  },
  {
    id: "accounts",
    title: "Accounts",
    kind: "list",
    onBoard: true,
    hideEmpty: true,
    // Where the money is (accounts.ts): each account's balance now, open ones first.
    sql: `
      SELECT a.id AS id, a.name AS name, ${ACCOUNT_WORD} || CASE WHEN a.archived_at IS NOT NULL THEN ' · closed' ELSE '' END
               || ${HOME_NOTE("a.balance_cents", "a.currency", "NULL")} AS caption,
             'From ' || a.opening_on AS since, a.balance_cents AS balance_cents, a.currency AS currency,
             CASE WHEN a.balance_cents < 0 AND a.kind NOT IN ('card', 'loan') THEN 'bad' END AS tone
        FROM account_balances a ORDER BY a.archived_at IS NOT NULL, a.id LIMIT 201`,
    row: { id: "id", title: "name", subtitle: "caption", badge: "since", trailing: "balance_cents", tone: "tone" },
    formats: { balance_cents: "money" },
    currencies: { balance_cents: "currency" },
  },
  {
    id: "activity",
    title: "Activity",
    kind: "list",
    onBoard: true,
    monthly: true,
    hideEmpty: true,
    searchable: true,
    peek: 6,
    opens: "expense",
    // One list of everything that moved this month, by day: money in green and +, money out −, a transfer plain.
    sql: `
      SELECT id, page, title, subtitle, day, ${WEEKDAY("day")} AS day_text, amount_cents, currency, tone FROM (${ACTIVITY_ROWS})
       WHERE (? = '' OR (? = 'in' AND dir = 'in') OR (? = 'out' AND dir = 'out') OR ? = 'acct:' || acct OR ? = 'acct:' || to_acct)
         AND (? = '' OR title LIKE ? ESCAPE '\\' OR subtitle LIKE ? ESCAPE '\\')
       ORDER BY day DESC, page, id DESC LIMIT 201`,
    params: [...ACTIVITY_PARAMS, "key", "key", "key", "key", "key", "q", "like", "like"],
    chipsSql: `
      WITH r AS (${ACTIVITY_ROWS})
      SELECT key, label, count FROM (
        SELECT 0 AS n, '' AS key, 'All' AS label, COUNT(*) AS count FROM r
        UNION ALL SELECT 1, 'in', 'In', COUNT(*) FROM r WHERE dir = 'in'
        UNION ALL SELECT 2, 'out', 'Out', COUNT(*) FROM r WHERE dir = 'out'
        UNION ALL SELECT 3, 'acct:' || a.id, a.name, (SELECT COUNT(*) FROM r WHERE r.acct = a.id OR r.to_acct = a.id) FROM accounts a WHERE a.archived_at IS NULL)
       WHERE count > 0 ORDER BY n, label`,
    chipsParams: [...ACTIVITY_PARAMS],
    row: { id: "id", title: "title", subtitle: "subtitle", trailing: "amount_cents", tone: "tone", group: "day_text", opens: "page" },
    formats: { amount_cents: "money" },
    currencies: { amount_cents: "currency" },
  },
  {
    id: "invoices",
    title: "Invoices",
    kind: "list",
    onBoard: true,
    hideEmpty: true,
    searchable: true,
    peek: 3,
    opens: "invoice",
    sql: `
      SELECT i.id AS id, COALESCE(i.number, 'Draft ' || i.id) || COALESCE(' · ' || c.name, '') AS label,
             CASE i.status WHEN 'draft' THEN 'Draft' WHEN 'issued' THEN 'Open' WHEN 'part_paid' THEN 'Part paid' WHEN 'paid' THEN 'Paid' WHEN 'void' THEN 'Void' ELSE i.status END
               || COALESCE(' · ' || CASE WHEN ${OPEN} AND i.due_date < ? THEN 'due ' || ${DAY("i.due_date")} || ', late' WHEN ${OPEN} THEN 'due ' || ${DAY("i.due_date")} END, '') AS state,
             i.total_cents AS total_cents,
             CASE WHEN ${OPEN} AND i.due_date < ? THEN 'bad' WHEN i.status = 'paid' THEN 'good' END AS tone
        FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
       WHERE (? = '' OR (? = 'open' AND ${OPEN}) OR i.status = ?)
         AND (? = '' OR i.number LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')
       ORDER BY ${OPEN} DESC, COALESCE(i.issue_date, substr(i.created_at, 1, 10)) DESC, i.id DESC LIMIT 201`,
    params: ["today", "today", "key", "key", "key", "q", "like", "like"],
    chipsSql: `
      SELECT key, label, count FROM (
        SELECT 0 AS n, 'open' AS key, 'Open' AS label, COUNT(*) AS count FROM invoices i WHERE ${OPEN}
        UNION ALL SELECT 1, 'draft', 'Draft', COUNT(*) FROM invoices WHERE status = 'draft'
        UNION ALL SELECT 2, 'paid', 'Paid', COUNT(*) FROM invoices WHERE status = 'paid'
        UNION ALL SELECT 3, 'void', 'Void', COUNT(*) FROM invoices WHERE status = 'void')
       WHERE count > 0 ORDER BY n`,
    row: { id: "id", title: "label", subtitle: "state", trailing: "total_cents", tone: "tone" },
    formats: { total_cents: "money" },
  },
  // The record pages (frame 05): what it is, whether it counts yet, its details, and its buttons: Allow while it waits,
  // Ask Cobra, and the rest under •••. A block with nothing in it is left off.
  {
    id: "expense",
    title: "Expense",
    kind: "page",
    params: ["id"],
    blocks: [
      {
        kind: "fields",
        look: "header",
        sql: `
          SELECT money_text(e.amount_cents, ${CURRENCY_OF("e.account_id")}, ${HOME}) AS amount, COALESCE(NULLIF(e.description, ''), v.name, 'Expense') AS what,
                 ${DAY("e.spent_on")} || COALESCE(' · ' || c.name, '') AS line, e.status AS _status, CASE WHEN e.status != 'voided' THEN 1 ELSE 0 END AS _open
            FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id LEFT JOIN categories c ON c.id = e.category_id WHERE e.id = ?`,
        params: ["id"],
      },
      {
        kind: "fields",
        look: "status",
        hideEmpty: true,
        sql: `
          SELECT CASE WHEN e.status = 'proposed' THEN 'Your Allow' || COALESCE(' · from ' || e.proposed_by, '') END AS waiting,
                 CASE WHEN e.status = 'proposed' THEN 'Not in ' || ${MONTH_WORD("e.spent_on")} || '''s numbers yet' END AS counts,
                 CASE WHEN e.status = 'voided' THEN 'Counts for nothing' || COALESCE(' · ' || e.void_reason, '') END AS voided,
                 CASE e.status WHEN 'proposed' THEN 'warn' WHEN 'voided' THEN 'bad' END AS _tone
            FROM expenses e WHERE e.id = ? AND e.status IN ('proposed', 'voided')`,
        params: ["id"],
      },
      {
        kind: "fields",
        title: "Details",
        hideEmpty: true,
        sql: `
          SELECT c.name AS category, a.name AS account, v.name AS vendor, e.spent_on AS spent_on, e.paid_with AS paid_with,
                 money_text(e.paid_cents, e.paid_currency, ${HOME}) AS paid, substr(e.allowed_at, 1, 10) AS allowed_on
            FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id LEFT JOIN categories c ON c.id = e.category_id LEFT JOIN accounts a ON a.id = e.account_id
           WHERE e.id = ?`,
        params: ["id"],
        formats: { spent_on: "date", allowed_on: "date" },
      },
      {
        kind: "list",
        title: "Receipt",
        sql: "SELECT id, replace(path, rtrim(path, replace(path, '/', '')), '') AS file FROM receipts WHERE expense_id = ? ORDER BY id",
        params: ["id"],
        row: { id: "id", title: "file" },
        empty: "No receipt yet. Send Cobra a photo of it.",
      },
    ],
    actions: [
      { mutation: "expense_allow", label: "Allow", on: "view", fixed: { id: "id" }, showWhen: { column: "_status", equals: "proposed" } },
      { mutation: "expense_update", label: "Change it", on: "view", fixed: { id: "id" }, group: "more", showWhen: { column: "_open", equals: 1 } },
      { mutation: "expense_void", label: "Not mine", on: "view", fixed: { id: "id" }, group: "more", showWhen: { column: "_open", equals: 1 }, after: "back" },
    ],
  },
  {
    id: "move",
    title: "Money in",
    kind: "page",
    params: ["id"],
    blocks: [
      {
        kind: "fields",
        look: "header",
        sql: `
          SELECT money_text(m.amount_cents, ${CURRENCY_OF("m.account_id")}, ${HOME}) AS amount,
                 COALESCE(NULLIF(m.description, ''), CASE m.kind WHEN 'income' THEN 'Income' WHEN 'revalue' THEN 'New balance' ELSE 'Transfer' END) AS what,
                 ${DAY("m.moved_on")} || ' · ' || CASE m.kind WHEN 'income' THEN 'Into ' || COALESCE(a.name, '?') WHEN 'revalue' THEN COALESCE(a.name, '?') ELSE COALESCE(a.name, '?') || ' → ' || COALESCE(t.name, '?') END AS line,
                 m.status AS _status, CASE WHEN m.status != 'voided' THEN 1 ELSE 0 END AS _open
            FROM money_moves m LEFT JOIN accounts a ON a.id = m.account_id LEFT JOIN accounts t ON t.id = m.to_account_id WHERE m.id = ?`,
        params: ["id"],
      },
      {
        kind: "fields",
        look: "status",
        hideEmpty: true,
        sql: `
          SELECT CASE WHEN m.status = 'proposed' THEN 'Your Allow' || COALESCE(' · from ' || m.proposed_by, '') END AS waiting,
                 CASE WHEN m.status = 'proposed' THEN 'Not in ' || ${MONTH_WORD("m.moved_on")} || '''s numbers yet' END AS counts,
                 CASE WHEN m.status = 'voided' THEN 'Counts for nothing' || COALESCE(' · ' || m.void_reason, '') END AS voided,
                 CASE m.status WHEN 'proposed' THEN 'warn' WHEN 'voided' THEN 'bad' END AS _tone
            FROM money_moves m WHERE m.id = ? AND m.status IN ('proposed', 'voided')`,
        params: ["id"],
      },
      {
        kind: "fields",
        title: "Details",
        hideEmpty: true,
        sql: `
          SELECT CASE m.kind WHEN 'income' THEN 'Money in' WHEN 'revalue' THEN 'A new balance' ELSE 'A transfer' END AS kind, c.name AS category, a.name AS account, t.name AS to_account,
                 money_text(m.to_amount_cents, ${CURRENCY_OF("m.to_account_id")}, ${HOME}) AS arrived, m.moved_on AS moved_on, substr(m.allowed_at, 1, 10) AS allowed_on
            FROM money_moves m LEFT JOIN accounts a ON a.id = m.account_id LEFT JOIN accounts t ON t.id = m.to_account_id LEFT JOIN categories c ON c.id = m.category_id
           WHERE m.id = ?`,
        params: ["id"],
        formats: { moved_on: "date", allowed_on: "date" },
      },
    ],
    actions: [
      { mutation: "move_allow", label: "Allow", on: "view", fixed: { id: "id" }, showWhen: { column: "_status", equals: "proposed" } },
      { mutation: "move_void", label: "Not mine", on: "view", fixed: { id: "id" }, group: "more", showWhen: { column: "_open", equals: 1 }, after: "back" },
    ],
  },
  {
    id: "invoice",
    title: "Invoice",
    kind: "page",
    params: ["id"],
    draft: "Draft a payment reminder for {title}",
    blocks: [
      {
        kind: "fields",
        look: "header",
        sql: `
          SELECT COALESCE(i.number, 'Draft ' || i.id) AS name, c.name AS customer, money_text(i.total_cents, ${HOME}, ${HOME}) AS total,
                 CASE i.status WHEN 'draft' THEN 'Draft' WHEN 'issued' THEN 'Open' WHEN 'part_paid' THEN 'Part paid' WHEN 'paid' THEN 'Paid' WHEN 'void' THEN 'Void' ELSE i.status END AS stage,
                 i.status AS _status, CASE WHEN ${OPEN} THEN 1 ELSE 0 END AS _open
            FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`,
        params: ["id"],
      },
      {
        kind: "fields",
        look: "status",
        hideEmpty: true,
        sql: `
          SELECT money_text(i.total_cents - COALESCE(i.paid_cents, 0), ${HOME}, ${HOME}) || CASE WHEN COALESCE(i.paid_cents, 0) > 0 THEN ' of ' || money_text(i.total_cents, ${HOME}, ${HOME}) ELSE '' END AS owed,
                 CASE WHEN i.due_date IS NULL THEN NULL
                      WHEN i.due_date < ? THEN ${DAY("i.due_date")} || ' · ' || CAST(julianday(?) - julianday(i.due_date) AS INTEGER) || ' days late'
                      ELSE ${DAY("i.due_date")} END AS due,
                 CASE WHEN i.due_date < ? THEN 'bad' ELSE 'warn' END AS _tone
            FROM invoices i WHERE i.id = ? AND ${OPEN}`,
        params: ["today", "today", "today", "id"],
      },
      {
        kind: "fields",
        title: "Details",
        hideEmpty: true,
        sql: `
          SELECT i.issue_date AS issue_date, i.due_date AS due_date, i.subtotal_cents AS subtotal_cents, i.tax_cents AS tax_cents,
                 NULLIF(COALESCE(i.paid_cents, 0), 0) AS paid_cents, i.notes AS notes
            FROM invoices i WHERE i.id = ?`,
        params: ["id"],
        formats: { issue_date: "date", due_date: "date", subtotal_cents: "money", tax_cents: "money", paid_cents: "money" },
      },
      {
        kind: "list",
        title: "Lines",
        hideEmpty: true,
        sql: `
          SELECT id, description, trim(printf('%g', quantity)) || ' × ' || printf('%.2f', unit_price_cents / 100.0) AS price, line_cents
            FROM invoice_lines WHERE invoice_id = ? ORDER BY position, id`,
        params: ["id"],
        row: { id: "id", title: "description", subtitle: "price", trailing: "line_cents" },
        formats: { line_cents: "money" },
      },
      {
        kind: "timeline",
        title: "Payments",
        hideEmpty: true,
        sql: "SELECT id, COALESCE(method, 'Payment') AS method, received_on, amount_cents FROM payments WHERE invoice_id = ? ORDER BY received_on DESC, id DESC",
        params: ["id"],
        row: { id: "id", title: "method", when: "received_on", trailing: "amount_cents" },
        formats: { received_on: "date", amount_cents: "money" },
      },
    ],
    actions: [
      { mutation: "invoice_issue", label: "Issue", on: "view", fixed: { id: "id" }, confirm: true, showWhen: { column: "_status", equals: "draft" } },
      { mutation: "payment_record", label: "Record a payment", on: "view", fixed: { invoice_id: "id", received_on: "today" }, showWhen: { column: "_open", equals: 1 } },
      { mutation: "invoice_void", label: "Void", on: "view", fixed: { id: "id" }, group: "more" },
    ],
  },
  {
    id: "aging",
    title: "Owed to you, by age",
    kind: "chart",
    hideEmpty: true,
    // Every bucket, empty ones too, in order: what an open invoice still owes, by how late it is today.
    sql: `
      WITH open AS (
        SELECT i.total_cents - COALESCE(i.paid_cents, 0) AS owed, ${AGE_BUCKET} AS bucket FROM invoices i WHERE ${OPEN}
      ), buckets(bucket, position, level) AS (
        VALUES ('Not due yet', 0, 0), ('1–30 days late', 1, 1), ('31–60 days late', 2, 2), ('61–90 days late', 3, 3), ('Over 90 days late', 4, 3)
      )
      SELECT b.bucket AS bucket, COALESCE(SUM(o.owed), 0) AS owed, COUNT(o.owed) AS invoices, b.level AS level
        FROM buckets b LEFT JOIN open o ON o.bucket = b.bucket GROUP BY b.bucket ORDER BY b.position`,
    params: ["today", "today", "today", "today"],
    chart: { type: "buckets", x: "bucket", xKind: "text", format: "money", level: "level", drill: "aging-invoices", series: [{ column: "owed", label: "Owed" }], empty: "Nobody owes you anything." },
  },
  {
    id: "waiting",
    title: "To allow",
    kind: "list",
    // What a Foreman proposed or staged: nothing counts until the person allows it here.
    sql: `
      SELECT e.id AS id, CASE WHEN e.category_id IS NULL AND ${KEEPS_BUDGET_SQL} THEN 'expense-uncategorized' ELSE 'expense' END AS kind,
             COALESCE(NULLIF(e.description, ''), v.name, 'Expense') AS title,
             ltrim(trim(COALESCE(v.name, '') || ' ' || COALESCE(c.name, CASE WHEN ${KEEPS_BUDGET_SQL} THEN '· needs a category' ELSE '' END) || COALESCE(' · from ' || a.name, '')) || ${PAID_NOTE("e")}
               || ${HOME_NOTE("e.amount_cents", CURRENCY_OF("e.account_id"), "e.spent_on")}, ' ·') AS subtitle,
             e.spent_on AS on_date, e.amount_cents AS amount_cents, 'Expense' AS badge, ${CURRENCY_OF("e.account_id")} AS currency
        FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id LEFT JOIN categories c ON c.id = e.category_id LEFT JOIN accounts a ON a.id = e.account_id
       WHERE e.status = 'proposed'
      UNION ALL
      SELECT m.id, 'move', COALESCE(NULLIF(m.description, ''), CASE m.kind WHEN 'income' THEN 'Income' WHEN 'revalue' THEN 'New balance' ELSE 'Transfer' END),
             CASE m.kind WHEN 'income' THEN 'Into ' || COALESCE(a.name, '?') || COALESCE(' · ' || c.name, '') WHEN 'revalue' THEN COALESCE(a.name, '?') || ' held this at the end of the day' ELSE COALESCE(a.name, '?') || ' to ' || COALESCE(t.name, '?') END
               || COALESCE(' · ' || money_text(m.to_amount_cents, ${CURRENCY_OF("m.to_account_id")}, ${HOME}) || ' arrived', ''),
             m.moved_on, m.amount_cents, CASE m.kind WHEN 'income' THEN 'Income' WHEN 'revalue' THEN 'New balance' ELSE 'Transfer' END, ${CURRENCY_OF("m.account_id")}
        FROM money_moves m LEFT JOIN accounts a ON a.id = m.account_id LEFT JOIN accounts t ON t.id = m.to_account_id LEFT JOIN categories c ON c.id = m.category_id
       WHERE m.status = 'proposed'
      UNION ALL
      SELECT b.id, 'import', b.file_name, b.row_count || ' bank lines, ' || COALESCE(b.first_on, '') || ' to ' || COALESCE(b.last_on, ''),
             b.last_on, NULL, 'Bank file', NULL
        FROM import_batches b WHERE b.status = 'pending'
       ORDER BY on_date DESC, id DESC LIMIT 201`,
    row: { id: "id", title: "title", subtitle: "subtitle", badge: "badge", trailing: "amount_cents" },
    formats: { amount_cents: "money" },
    currencies: { amount_cents: "currency" },
    today: true,
    actions: [
      { mutation: "expense_allow", label: "Allow", on: "row", fixed: { id: "id" }, showWhen: { column: "kind", equals: "expense" } },
      { mutation: "expense_void", label: "Not mine", on: "row", fixed: { id: "id" }, showWhen: { column: "kind", equals: "expense" } },
      // With no category in a Space that keeps a budget there is no Allow: Cobra asks for one first.
      { mutation: "expense_void", label: "Not mine", on: "row", fixed: { id: "id" }, showWhen: { column: "kind", equals: "expense-uncategorized" } },
      { mutation: "move_allow", label: "Allow", on: "row", fixed: { id: "id" }, showWhen: { column: "kind", equals: "move" } },
      { mutation: "move_void", label: "Not mine", on: "row", fixed: { id: "id" }, showWhen: { column: "kind", equals: "move" } },
      { mutation: "transactions_allow", label: "Allow", on: "row", fixed: { batch_id: "id" }, showWhen: { column: "kind", equals: "import" } },
      { mutation: "transactions_drop", label: "Drop", on: "row", fixed: { batch_id: "id" }, showWhen: { column: "kind", equals: "import" } },
    ],
  },
  {
    id: "expenses",
    title: "Expenses",
    kind: "list",
    searchable: true,
    sql: `
      SELECT e.id AS id, COALESCE(NULLIF(e.description, ''), v.name, 'Expense') AS title,
             ltrim(trim(COALESCE(v.name, '') || ' ' || COALESCE(c.name, '') || COALESCE(' · from ' || a.name, '')) || ${PAID_NOTE("e")}
               || ${HOME_NOTE("e.amount_cents", CURRENCY_OF("e.account_id"), "e.spent_on")}, ' ·') AS subtitle,
             e.spent_on AS spent_on, e.amount_cents AS amount_cents, ${CURRENCY_OF("e.account_id")} AS currency
        FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id LEFT JOIN categories c ON c.id = e.category_id LEFT JOIN accounts a ON a.id = e.account_id
       WHERE e.status = 'recorded'
         AND (? = '' OR e.description LIKE ? ESCAPE '\\' OR v.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')
       ORDER BY e.spent_on DESC, e.id DESC LIMIT 201`,
    params: ["q", "like", "like", "like"],
    row: { id: "id", title: "title", subtitle: "subtitle", badge: "spent_on", trailing: "amount_cents" },
    formats: { spent_on: "date", amount_cents: "money" },
    currencies: { amount_cents: "currency" },
    actions: [{ mutation: "expense_void", label: "Void", on: "row", fixed: { id: "id" } }],
  },
  {
    id: "moves",
    title: "Income and transfers",
    kind: "list",
    sql: `
      SELECT m.id AS id, COALESCE(NULLIF(m.description, ''), CASE m.kind WHEN 'income' THEN 'Income' WHEN 'revalue' THEN 'New balance' ELSE 'Transfer' END) AS title,
             CASE m.kind WHEN 'income' THEN 'Into ' || COALESCE(a.name, '?') || COALESCE(' · ' || c.name, '') WHEN 'revalue' THEN COALESCE(a.name, '?') || ' held this at the end of the day' ELSE COALESCE(a.name, '?') || ' to ' || COALESCE(t.name, '?') END
               || COALESCE(' · ' || money_text(m.to_amount_cents, ${CURRENCY_OF("m.to_account_id")}, ${HOME}) || ' arrived', '') AS subtitle,
             m.moved_on AS moved_on, m.amount_cents AS amount_cents, ${CURRENCY_OF("m.account_id")} AS currency
        FROM money_moves m LEFT JOIN accounts a ON a.id = m.account_id LEFT JOIN accounts t ON t.id = m.to_account_id LEFT JOIN categories c ON c.id = m.category_id
       WHERE m.status = 'recorded'
       ORDER BY m.moved_on DESC, m.id DESC LIMIT 201`,
    row: { id: "id", title: "title", subtitle: "subtitle", badge: "moved_on", trailing: "amount_cents" },
    formats: { moved_on: "date", amount_cents: "money" },
    currencies: { amount_cents: "currency" },
    actions: [{ mutation: "move_void", label: "Void", on: "row", fixed: { id: "id" } }],
  },
  {
    id: "bank",
    title: "Bank",
    kind: "list",
    searchable: true,
    // Allowed lines to sort: money in is positive, out negative. Matching one to an invoice or an expense is the Foreman's.
    sql: `
      SELECT t.id AS id, t.description AS description, COALESCE(c.name, '') AS category, t.status AS status, t.posted_on AS posted_on, t.amount_cents AS amount_cents
        FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.status IN ('new', 'matched')
         AND (? = '' OR t.description LIKE ? ESCAPE '\\')
       ORDER BY t.posted_on DESC, t.id DESC LIMIT 201`,
    params: ["q", "like"],
    row: { id: "id", title: "description", subtitle: "category", badge: "status", trailing: "amount_cents", when: "posted_on" },
    formats: { posted_on: "date", amount_cents: "money" },
    actions: [
      { mutation: "transaction_categorize", label: "Category", on: "row", fixed: { id: "id" } },
      { mutation: "transaction_ignore", label: "Ignore", on: "row", fixed: { id: "id" }, showWhen: { column: "status", equals: "new" } },
    ],
  },
  {
    id: "categories",
    title: "By category",
    kind: "list",
    // This month's recorded spending, biggest first.
    sql: `
      SELECT COALESCE(c.name, 'Uncategorized') AS name, COUNT(*) || ' expense' || CASE WHEN COUNT(*) = 1 THEN '' ELSE 's' END AS caption, SUM(${EXPENSE_HOME("e")}) AS total_cents
        FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.status = 'recorded' AND e.spent_on >= ? AND e.spent_on <= ?
       GROUP BY COALESCE(c.name, 'Uncategorized') ORDER BY total_cents DESC LIMIT 201`,
    params: ["monthStart", "monthEnd"],
    row: { title: "name", subtitle: "caption", trailing: "total_cents" },
    formats: { total_cents: "money" },
  },
  // What a chart opens: an empty key (an app from before charts shows these as tabs) is everything the chart counts.
  {
    id: "aging-invoices",
    title: "Open invoices",
    kind: "list",
    fromChart: true,
    opens: "invoice",
    sql: `
      SELECT * FROM (
        SELECT i.id AS id, COALESCE(i.number, 'Draft ' || i.id) AS label, c.name AS customer, i.due_date AS due_date,
               i.total_cents - COALESCE(i.paid_cents, 0) AS owed_cents, ${AGE_BUCKET} AS bucket,
               CASE WHEN i.due_date < ? THEN 'bad' END AS tone
          FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE ${OPEN}
      ) WHERE ? = '' OR bucket = ?
      ORDER BY due_date, id LIMIT 201`,
    params: ["today", "today", "today", "today", "today", "key", "key"],
    row: { id: "id", title: "label", subtitle: "customer", badge: "bucket", trailing: "owed_cents", tone: "tone" },
    formats: { owed_cents: "money", due_date: "date" },
  },
  {
    id: "category-expenses",
    title: "Expenses",
    kind: "list",
    fromChart: true,
    sql: `
      SELECT e.id AS id, COALESCE(NULLIF(e.description, ''), v.name, 'Expense') AS description,
             ltrim(COALESCE(v.name, '') || ${PAID_NOTE("e")} || ${HOME_NOTE("e.amount_cents", CURRENCY_OF("e.account_id"), "e.spent_on")}, ' ·') AS vendor,
             e.spent_on AS spent_on, e.amount_cents AS amount_cents, ${CURRENCY_OF("e.account_id")} AS currency
        FROM expenses e LEFT JOIN categories c ON c.id = e.category_id LEFT JOIN vendors v ON v.id = e.vendor_id
       WHERE e.status = 'recorded' AND e.spent_on >= ? AND e.spent_on <= ? AND (? = '' OR COALESCE(c.name, 'Uncategorized') = ?)
       ORDER BY e.spent_on DESC, e.id DESC LIMIT 201`,
    params: ["rangeStart", "rangeEnd", "key", "key"],
    row: { id: "id", title: "description", subtitle: "vendor", badge: "spent_on", trailing: "amount_cents" },
    formats: { spent_on: "date", amount_cents: "money" },
    currencies: { amount_cents: "currency" },
  },
];
