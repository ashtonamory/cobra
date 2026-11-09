# Report templates

A report is a designed document the agent renders from a template and a query:
a pay stub, a pay run summary, a timesheet, an invoice, a receipt, a statement. The Foreman picks the template and
writes the SELECT; the agent runs the SELECT with real values, fills the
template, and prints it to PDF with the computer's own Chromium
(`apps/agent/src/agent/render.ts`). The template engine is
`apps/agent/src/agent/template.ts`. The Foreman never sees the finished
document's contents, only its file path.

This folder holds the shipped templates, one folder per trade:

```
apps/agent/templates/
  README.md                       this file
  <trade>/                        e.g. payroll-manager, billing
    <template>/                   e.g. pay-stub
      index.html                  the template: HTML and CSS only
      sample.json                 a TemplateData example a designer can render by hand
```

## Where a template comes from

When a Foreman asks for template `pay-stub`, the agent looks first in the
project's own repository at `templates/pay-stub/index.html`. If that file
exists it wins; otherwise the shipped one here is used
(`apps/agent/templates/<trade>/pay-stub/index.html`).

So to restyle a document for one business, a Worker copies the shipped folder
into the project as `templates/<name>/` and edits `index.html` there. The
shipped file is never edited for one business. A new document the trade does
not ship is the same: a new folder `templates/<name>/index.html` in the
project.

The first render of a new or changed template is always previewed by the
person before anything is sent: the agent shows the document and waits for an
answer. Do not expect a changed template to go out unseen.

## What a template gets

The template sees one object, `TemplateData`
(`apps/agent/src/agent/renderTypes.ts`):

| Path | What it is |
| --- | --- |
| `business` | The trade's business row, or null when the trade has none. For the Payroll Manager: `legal_name`, `trading_name` (set only when it differs from the legal name), `address`, `email`, `phone`, `logo_path` (a path in the repository), `accent_colour` (a CSS colour), `footer_text`, `pay_schedule` (weekly, fortnightly or monthly), `currency` (an ISO 4217 code such as GBP). For Billing: the same branding columns (`legal_name`, `trading_name`, `address`, `email`, `phone`, `logo_path`, `accent_colour`, `footer_text`, `currency`) and `tax_number`, `tax_label` (VAT, GST, Sales tax; "Tax" when unset), `payment_instructions` (how customers pay, printed on invoices and statements), `invoice_prefix`, `next_number`, `terms_days`, `tax_rate_bp` (the last four are for the mutations and never printed). |
| `rows` | The rows the Foreman's SELECT returned, with real values. Money columns are whole cents; dates are `YYYY-MM-DD` text; hours are decimal numbers. |
| `row` | The first row: of the split group, or of the whole result. |
| `args` | Free values the Foreman passed, such as `args.period_label` or `args.run_id`. |
| `now` | The ISO time of the render. |
| `project.name` | The project's name (also `project.id`). |
| `split` | When the Foreman asked for one document per distinct value of a column, that document's value; otherwise null. |

A template only reads this data. It cannot query, compute beyond the helpers
below, or run any script.

## Syntax

A template is HTML. Everything between `{{` and `}}` is a tag; everything else
is written out as it is. Every value a tag outputs is HTML-escaped by the
engine: a name containing `<` cannot become markup. There is no raw output.

Output a value, by dotted path:

```
{{business.legal_name}}   {{row.employee_name}}   {{args.period_label}}
```

A missing path renders as nothing, never an error.

Loops:

```
{{#each rows}}
  <tr><td>{{@number}}</td><td>{{this.employee_name}}</td></tr>
{{else}}
  <tr><td>No rows</td></tr>
{{/each}}
```

Inside `{{#each}}`, `this` is the current item; a bare name such as
`{{employee_name}}` is looked up in the current item first, then in the outer
items, then in the data, so `{{business.currency}}` still works inside a loop.
`@index` counts from 0, `@number` from 1, `@first` and `@last` are true on the
first and last item. The `{{else}}` part renders when the list is empty.

Conditions:

```
{{#if row.notes}}<p>{{row.notes}}</p>{{else}}<p>No notes</p>{{/if}}
{{#unless business.logo_path}}<h1>{{business.legal_name}}</h1>{{/unless}}
{{#if (eq row.status "closed")}}Closed{{/if}}
```

Falsy values are null, missing, an empty string, 0, false and an empty list.

Comments:

```
{{! Anything here is dropped from the output. }}
```

Helpers, written as `{{helper argument ...}}`; an argument is a path, a
`"quoted string"`, a number, or another helper call in parentheses:

| Helper | Output |
| --- | --- |
| `{{money row.net_cents}}` | Whole cents as money in the business's currency: `£1,234.56`. A currency without a known symbol is spelled out: `CHF 1,234.56`. An optional third argument overrides the currency: `{{money cents "USD"}}`. |
| `{{moneysum rows "net_cents"}}` | The sum of a money column over a list of rows, formatted like `money`. |
| `{{sum rows "hours"}}` | The plain numeric sum of a column. Wrap it to format: `{{hours (sum rows "hours")}}`. |
| `{{count rows}}` | How many rows. |
| `{{date row.pay_date}}` | A `YYYY-MM-DD` date as `18 Oct 2026`. |
| `{{datetime now}}` | A date and time as `18 Oct 2026, 09:00`, in this computer's time zone. |
| `{{hours row.hours}}` | A number of hours rounded to two decimal places: `38.5`. |
| `{{number value 2}}` | A number with the given decimal places and thousands separators: `1,234.50`. |
| `{{upper x}}` / `{{lower x}}` | The text in upper or lower case. |
| `{{join rows "employee_name" ", "}}` | A column's values joined by a separator, empty values skipped. |
| `{{default value "fallback"}}` | The value, or the fallback when it is null, missing or empty. |
| `{{eq a b}}` | True when the two values are the same; `"1"` and `1` count as the same. Mostly used inside `{{#if (eq ...)}}`. |
| `{{file business.logo_path}}` | A repository-relative path as a `file://` URL for an `<img src>`; empty when the path is unset or refused. |

A helper's name used alone, such as `{{date}}`, is read as a column called
`date`, not a helper call.

There is no JavaScript in templates: only HTML and CSS. The engine escapes
every value it outputs, but it copies the template's own markup through as it
is, so a `<script>` tag written in a template would reach the Chromium that
prints it. Leave scripts out; the test suite checks the shipped templates
carry none.

## Design rules the shipped templates follow

Keep these when restyling, so a business's documents look like one set:

- A4 with `@page { size: A4; margin: 18mm }`; print CSS only, no web layout.
- A system font stack: Inter if present, then -apple-system, Segoe UI, Roboto,
  Helvetica, Arial. 11pt body text, black.
- Numbers in tabular figures (`font-variant-numeric: tabular-nums`); money
  columns right-aligned.
- One accent colour from `business.accent_colour`, with a deep blue default,
  set once as a CSS custom property on `<body>`:
  `style="--accent: {{default business.accent_colour "#1f3a5f"}}"`.
- No gradients, shadows or background images. Generous whitespace, a quiet
  rule under the header.
- The logo top left when `business.logo_path` is set, else the legal name as
  text; the trading name under it when set. Address and contact right-aligned
  in the header.
- A footer with `business.footer_text` and "Generated on {{date now}}". Page
  numbers ("Page 1 of 2") come from an `@page` margin box; Chromium 131 and
  later print it, an older one shows nothing there and the document is still
  complete.
- Sensitive columns (`tax_id`, `bank_account`, `bank_sort`, `home_address`)
  are never referenced by a template, so a `SELECT *` cannot print them. A
  pay stub shows one employee's pay; a pay run summary shows every employee's
  pay for the person reviewing it; a timesheet shows hours only.
- Billing prints two columns the schema tags sensitive because they are meant
  for the customer: the customer's `billing_address` (as `customer_address`)
  and the business's `payment_instructions`. It never reads a payment's
  `reference`, a customer's own `notes` or `cc_email`, or an invoice's
  `void_reason`; leave them out of the SELECT too.

## The shipped Payroll Manager templates

Each folder's `sample.json` shows the exact columns and arguments.

### `pay-stub` (titled "Pay statement")

One employee for one pay period, read from `row`. Render it with
`split: "employee_id"` for one file per employee. Columns, from `pay_items`
joined with `employees`, `pay_runs` and `pay_periods`:
`employee_name`, `employee_role`, `employee_id`, `period_starts`,
`period_ends`, `pay_date`, `pay_type`, `rate_cents`, `hours`, `gross_cents`,
`deductions_cents`, `net_cents`, `notes`. Optional `args.run_id`.

A query that fits:

```sql
SELECT e.name AS employee_name, e.role AS employee_role, e.id AS employee_id,
       p.starts AS period_starts, p.ends AS period_ends, p.pay_date,
       e.pay_type, e.rate_cents, i.hours, i.gross_cents, i.deductions_cents,
       i.net_cents, i.notes
FROM pay_items i
JOIN employees e ON e.id = i.employee_id
JOIN pay_runs r ON r.id = i.run_id
JOIN pay_periods p ON p.id = r.period_id
WHERE i.run_id = ?
ORDER BY e.name
```

### `pay-run-summary` (titled "Pay run summary")

The whole run, one row per employee, for the person to approve. Columns:
`employee_name`, `pay_type`, `hours`, `gross_cents`, `deductions_cents`,
`net_cents`. Arguments: `args.period_label`, `args.pay_date` (`YYYY-MM-DD`),
`args.status` (draft, reviewed or closed).

### `timesheet` (titled "Timesheet")

Hours by employee for a period. Columns: `employee_name`, `regular_hours`,
`overtime_hours`, `sick_hours`, `holiday_hours`, `source` (sheet, file or
typed), `notes`. Argument: `args.period_label`.

## The shipped Billing templates

Billing's templates are in `billing/`. Each folder's `sample.json` shows the
exact columns and arguments. Money is whole cents; dates are `YYYY-MM-DD`.

The engine adds and counts (`moneysum`, `count`) but cannot subtract, divide,
compare or group, so the SELECT does that work: every balance is a
`balance_cents` column, a tax rate in percent is `tax_rate_bp / 100.0`, an age
is `days_overdue` (never negative), and tax by rate comes from window
functions. Each template also reads an optional `currency` column (the
invoice's), falling back to `business.currency` when it is null.

`args` are the same for every document in one render, so a per-document
total never goes in `args`: the statement sums its own rows.

### `invoice` (titled "Invoice <number>")

One invoice, one row per invoice line ordered by `position`. Render with
`split: "invoice_id"` for one file per invoice. The invoice-level columns
repeat on every row and are read from `row`:

- Invoice: `invoice_id`, `invoice_number` (null on a draft), `status`
  (draft, issued, part_paid, paid, void), `issue_date`, `due_date`,
  `customer_name`, `customer_contact`, `customer_email`, `customer_address`,
  `subtotal_cents`, `tax_cents`, `total_cents`, `paid_cents`,
  `balance_cents` (`total_cents - paid_cents`), `notes`, and optional
  `currency`.
- Each line: `line_description`, `quantity`, `unit` (from `items`; null for a
  typed line), `unit_price_cents`, `tax_rate_percent` (`tax_rate_bp / 100.0`),
  `line_cents`, `line_tax_cents`.
- Tax by rate, from window functions over the invoice's lines: `rate_first`
  (1 on the first line of each rate, else 0), `rate_net_cents` and
  `rate_tax_cents` (that rate's sums). The totals show one line per rate,
  "VAT at 20% on £234.00  £46.80". Without `rate_first` they show one line,
  `business.tax_label` and `tax_cents`.

No arguments. It shows the business header, the bill-to, the dates, the lines,
subtotal, tax, total, paid (when above 0) and the balance due, the tax number
with its label, how to pay (the balance, the due date, the number to quote and
`business.payment_instructions`), the notes and the footer. A `void` invoice
carries a large VOID mark and a note, and asks for no payment; a `paid` one
(balance 0) says "Paid in full"; a `draft` is titled "Draft invoice" and says
it is not a request for payment. With `tax_cents` 0 there is no tax column or
tax line.

```sql
SELECT i.id AS invoice_id, i.number AS invoice_number, i.status, i.issue_date, i.due_date, i.currency,
       c.name AS customer_name, c.contact_name AS customer_contact,
       c.email AS customer_email, c.billing_address AS customer_address,
       l.description AS line_description, l.quantity, it.unit, l.unit_price_cents,
       COALESCE(l.tax_rate_bp, 0) / 100.0 AS tax_rate_percent,
       l.line_cents, l.tax_cents AS line_tax_cents,
       ROW_NUMBER() OVER (PARTITION BY i.id, COALESCE(l.tax_rate_bp, 0) ORDER BY l.position) = 1 AS rate_first,
       SUM(l.line_cents) OVER (PARTITION BY i.id, COALESCE(l.tax_rate_bp, 0)) AS rate_net_cents,
       SUM(l.tax_cents) OVER (PARTITION BY i.id, COALESCE(l.tax_rate_bp, 0)) AS rate_tax_cents,
       i.subtotal_cents, i.tax_cents, i.total_cents, COALESCE(i.paid_cents, 0) AS paid_cents,
       i.total_cents - COALESCE(i.paid_cents, 0) AS balance_cents, i.notes
FROM invoice_lines l
JOIN invoices i ON i.id = l.invoice_id
JOIN customers c ON c.id = i.customer_id
LEFT JOIN items it ON it.id = l.item_id
WHERE i.id = ?
ORDER BY i.id, l.position
```

### `receipt` (titled "Receipt")

One payment the person said arrived, read from `row`. Render with
`split: "payment_id"`. Columns: `payment_id` (printed as the receipt
number), `received_on`, `amount_cents`, `method` (bank, card, cash, cheque or
other, printed in words), `invoice_number`, `invoice_total_cents`,
`invoice_paid_cents` (paid to date, this payment included),
`balance_cents` (`invoice_total_cents - invoice_paid_cents`),
`customer_name`, `customer_address`, `customer_email`, and optional
`currency`. No arguments. It shows the amount received, the invoice it pays,
paid to date and what is still owed, or "Paid in full" when `balance_cents` is
0. There is no column for the payment's `reference`: never select it.

Paid to date is counted up to this payment, so a receipt rendered again later
still shows the balance as it was:

```sql
SELECT p.id AS payment_id, p.received_on, p.amount_cents, p.method,
       i.number AS invoice_number, i.currency, i.total_cents AS invoice_total_cents,
       (SELECT SUM(q.amount_cents) FROM payments q
         WHERE q.invoice_id = p.invoice_id AND q.id <= p.id) AS invoice_paid_cents,
       i.total_cents - (SELECT SUM(q.amount_cents) FROM payments q
         WHERE q.invoice_id = p.invoice_id AND q.id <= p.id) AS balance_cents,
       c.name AS customer_name, c.billing_address AS customer_address, c.email AS customer_email
FROM payments p
JOIN invoices i ON i.id = p.invoice_id
JOIN customers c ON c.id = i.customer_id
WHERE p.id = ?
```

### `statement` (titled "Statement")

One customer's open invoices (issued or part paid, with a balance), one row
per invoice ordered by issue date. Render with `split: "customer_id"` for one
file per customer. Columns: `customer_id`, `customer_name`,
`customer_contact`, `customer_address`, `customer_email` (repeated on every
row, read from `row`), and per invoice `invoice_number`, `issue_date`,
`due_date`, `total_cents`, `paid_cents`, `balance_cents`
(`total_cents - paid_cents`), `days_overdue` (whole days past the due date on
`as_of`, 0 when not yet due, never negative), and optional `currency` (one
statement assumes one currency). Argument: `args.as_of` (`YYYY-MM-DD`; the
render date when unset). It shows each invoice with its age ("42 days
overdue" or "Not yet due"), the total due (summed from the rows, at the top
and in the table's foot) and the payment instructions.

```sql
SELECT c.id AS customer_id, c.name AS customer_name, c.contact_name AS customer_contact,
       c.billing_address AS customer_address, c.email AS customer_email,
       i.number AS invoice_number, i.issue_date, i.due_date, i.currency,
       i.total_cents, COALESCE(i.paid_cents, 0) AS paid_cents,
       i.total_cents - COALESCE(i.paid_cents, 0) AS balance_cents,
       MAX(0, CAST(julianday(?) - julianday(i.due_date) AS INTEGER)) AS days_overdue
FROM invoices i
JOIN customers c ON c.id = i.customer_id
WHERE i.status IN ('issued', 'part_paid') AND i.total_cents > COALESCE(i.paid_cents, 0)
ORDER BY c.id, i.issue_date, i.number
```

The first parameter is the same day as `args.as_of`; add `AND c.id = ?` for
one customer.

## Checking a template by hand

`apps/agent/src/agent/templates.test.ts` (Payroll) and
`apps/agent/src/agent/billingTemplates.test.ts` (Billing) render each shipped
template over its `sample.json` and check that no `{{` is left, that the
business name and the totals appear, and that a planted value (a bank account
number, a payment reference, a customer's own notes) does not. Run them with
`node --test apps/agent/src/agent/templates.test.ts apps/agent/src/agent/billingTemplates.test.ts`
from the repository root. To look at a template, render its sample to HTML the same way and open
the file in a browser with the print preview set to A4.
