/**
 * The Payroll Manager's data: its tables and the named mutations that are the
 * only way they change.
 *
 * The flow the film shows: the owner keeps employees and pay periods here,
 * timesheets come in (a sheet, a file, or typed), a pay run is created from
 * them, reviewed, then closed; wave 4 turns a closed run into pay stubs
 * (`stubs`). Nothing here moves money or files anything: a closed run is a
 * record the person approved, and the trade's brief (trades.ts) promises that
 * submitting payroll stays with the person.
 *
 * Money is whole cents in INTEGER columns; dates are YYYY-MM-DD text. Pay,
 * bank and ID columns are `sensitive`: db_query masks them for the model and
 * report_render fills them from the real rows, so no summary here names an
 * individual's pay or bank number.
 *
 * The migration SQL is written out by hand, not generated from `tables`: a
 * shipped migration must never change under a database that already ran it,
 * while `tables` will grow with later versions. payroll.test.ts keeps the two
 * in step.
 */
import { SENT_ARGS, type Args, type ArgSpec, type Mutation, type MutationContext, type Row, type TableSpec, type TradeSchema, type Value } from "../dbTypes.ts";
import { OUT_DIR } from "../renderTypes.ts";

export const PAYROLL_TRADE = "payroll-manager";

/** The currency a new business row gets: the schema's sort codes and fortnightly runs are the UK's, and the film's business is British. */
export const DEFAULT_CURRENCY = "GBP";

export const PAY_SCHEDULES = ["weekly", "fortnightly", "monthly"] as const;
export const PAY_TYPES = ["hourly", "salary"] as const;
export const PERIOD_STATUSES = ["open", "run", "closed"] as const;
export const TIMESHEET_SOURCES = ["sheet", "file", "typed"] as const;
export const RUN_STATUSES = ["draft", "reviewed", "closed"] as const;

/** Overtime pays this many times the hourly rate. */
export const OVERTIME_MULTIPLIER = 1.5;

// --- tables ---------------------------------------------------------------

const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";

const MIGRATION_1 = `
CREATE TABLE business (
  ${STAMPS},
  legal_name TEXT NOT NULL,
  trading_name TEXT,
  address TEXT,
  email TEXT,
  phone TEXT,
  logo_path TEXT,
  accent_colour TEXT,
  footer_text TEXT,
  pay_schedule TEXT,
  currency TEXT NOT NULL DEFAULT '${DEFAULT_CURRENCY}'
);
CREATE TABLE employees (
  ${STAMPS},
  name TEXT NOT NULL,
  role TEXT,
  email TEXT,
  start_date TEXT,
  end_date TEXT,
  pay_type TEXT NOT NULL,
  rate_cents INTEGER NOT NULL,
  tax_id TEXT,
  bank_account TEXT,
  bank_sort TEXT,
  home_address TEXT,
  notes TEXT
);
CREATE TABLE pay_periods (
  ${STAMPS},
  starts TEXT NOT NULL,
  ends TEXT NOT NULL,
  pay_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);
CREATE TABLE timesheets (
  ${STAMPS},
  employee_id INTEGER NOT NULL,
  period_id INTEGER NOT NULL,
  regular_hours REAL,
  overtime_hours REAL,
  sick_hours REAL,
  holiday_hours REAL,
  source TEXT,
  notes TEXT
);
CREATE UNIQUE INDEX timesheets_one_per_employee_period ON timesheets (employee_id, period_id);
CREATE TABLE pay_runs (
  ${STAMPS},
  period_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  gross_cents INTEGER,
  deductions_cents INTEGER,
  net_cents INTEGER,
  employee_count INTEGER,
  closed_at TEXT,
  notes TEXT
);
CREATE TABLE pay_items (
  ${STAMPS},
  run_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  hours REAL,
  gross_cents INTEGER,
  deductions_cents INTEGER,
  net_cents INTEGER,
  notes TEXT
);
CREATE TABLE stubs (
  ${STAMPS},
  run_id INTEGER,
  employee_id INTEGER,
  path TEXT,
  sha256 TEXT,
  sent_at TEXT,
  card_id TEXT
);
`;

// No REFERENCES clauses: the mutations check every id themselves, and undo
// re-inserts deleted rows in journal order, which a foreign key would refuse.

const TABLES: Record<string, TableSpec> = {
  business: {
    describe: "The business the pay runs are for: identity and branding for the templates. One row; business_set keeps it.",
    columns: {
      legal_name: { kind: "text", required: true, describe: "The registered name" },
      trading_name: { kind: "text", describe: "The name on stubs when it differs from the legal name" },
      address: { kind: "text" },
      email: { kind: "text" },
      phone: { kind: "text" },
      logo_path: { kind: "text", describe: "A path in the repository" },
      accent_colour: { kind: "text", describe: "A CSS colour for the templates" },
      footer_text: { kind: "text" },
      pay_schedule: { kind: "text", describe: "weekly, fortnightly or monthly" },
      currency: { kind: "text", describe: `ISO 4217 code, ${DEFAULT_CURRENCY} unless set` },
    },
  },
  employees: {
    describe: "Everyone paid here, current or ended (end_date set).",
    columns: {
      name: { kind: "text", required: true },
      role: { kind: "text" },
      email: { kind: "text" },
      start_date: { kind: "date" },
      end_date: { kind: "date", describe: "Set when the employee left; null while current" },
      pay_type: { kind: "text", required: true, describe: "hourly or salary" },
      rate_cents: { kind: "money", required: true, describe: "The hourly rate, or the salary per pay period" },
      tax_id: { kind: "text", sensitive: true },
      bank_account: { kind: "text", sensitive: true },
      bank_sort: { kind: "text", sensitive: true, describe: "Sort code or routing number" },
      home_address: { kind: "text", sensitive: true },
      notes: { kind: "text" },
    },
  },
  pay_periods: {
    describe: "The spans of time each pay run covers, never overlapping.",
    columns: {
      starts: { kind: "date", required: true },
      ends: { kind: "date", required: true, describe: "Inclusive" },
      pay_date: { kind: "date", required: true },
      status: { kind: "text", describe: "open, run (a pay run exists) or closed" },
    },
  },
  timesheets: {
    describe: "One per employee per period: the hours a pay run pays.",
    columns: {
      employee_id: { kind: "integer", required: true },
      period_id: { kind: "integer", required: true },
      regular_hours: { kind: "real" },
      overtime_hours: { kind: "real" },
      sick_hours: { kind: "real" },
      holiday_hours: { kind: "real" },
      source: { kind: "text", describe: "sheet, file or typed" },
      notes: { kind: "text" },
    },
  },
  pay_runs: {
    describe: "A period's pay, computed from its timesheets: draft, then reviewed, then closed.",
    columns: {
      period_id: { kind: "integer", required: true },
      status: { kind: "text", describe: "draft, reviewed or closed" },
      gross_cents: { kind: "money", describe: "The run's total gross" },
      deductions_cents: { kind: "money" },
      net_cents: { kind: "money" },
      employee_count: { kind: "integer" },
      closed_at: { kind: "text", describe: "ISO time the run was closed" },
      notes: { kind: "text" },
    },
  },
  pay_items: {
    describe: "One employee's line of a pay run.",
    columns: {
      run_id: { kind: "integer", required: true },
      employee_id: { kind: "integer", required: true },
      hours: { kind: "real", describe: "Every hour paid, all kinds" },
      gross_cents: { kind: "money", sensitive: true },
      deductions_cents: { kind: "money", sensitive: true },
      net_cents: { kind: "money", sensitive: true },
      notes: { kind: "text" },
    },
  },
  stubs: {
    describe: "A rendered pay stub, recorded by stub_record after report_render: the PDF's repository path, its hash, when it was sent and by which card.",
    columns: {
      run_id: { kind: "integer" },
      employee_id: { kind: "integer" },
      path: { kind: "text", describe: "The PDF's path in the repository" },
      sha256: { kind: "text" },
      sent_at: { kind: "text", describe: "ISO time the stub left, null until then" },
      card_id: { kind: "text", describe: "The action card that sent it" },
    },
  },
};

/** Every sensitive column as table.column, for the engine's and the mirror's tests. */
export const PAYROLL_SENSITIVE: string[] = Object.entries(TABLES).flatMap(([table, spec]) =>
  Object.entries(spec.columns)
    .filter(([, column]) => column.sensitive)
    .map(([name]) => `${table}.${name}`),
);

// --- the gross formula ----------------------------------------------------

export type Hours = { regular: number; overtime: number; sick: number; holiday: number };

/**
 * Gross pay in whole cents. Hourly: the rate for every regular, sick and
 * holiday hour, and the rate times OVERTIME_MULTIPLIER for overtime, rounded
 * once at the end to the nearest cent (Math.round, so a half cent rounds up).
 * Salary: the rate is the pay for the period, whatever the hours.
 */
export function payrollGross(payType: string, rateCents: number, hours: Hours): number {
  if (payType === "salary") return Math.round(rateCents);
  const straight = hours.regular + hours.sick + hours.holiday;
  return Math.round(rateCents * straight + rateCents * OVERTIME_MULTIPLIER * hours.overtime);
}

// --- reading arguments ----------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Days from one date to another, both included: a fortnight is 14. */
function daysInclusive(starts: string, ends: string): number {
  const a = Date.parse(`${starts}T00:00:00Z`);
  const b = Date.parse(`${ends}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Whether the caller said anything about this field: null counts, since it clears the column. */
function has(args: Args, name: string): boolean {
  return args[name] !== undefined;
}

function text(ctx: MutationContext, args: Args, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    if (required) ctx.refuse(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "string") ctx.refuse(`${name} must be text`);
  const trimmed = value.trim();
  if (trimmed === "" && required) ctx.refuse(`${name} is required`);
  return trimmed;
}

function id(ctx: MutationContext, args: Args, name: string): number {
  const value = args[name];
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) ctx.refuse(`${name} must be a positive whole number`);
  return n;
}

function cents(ctx: MutationContext, args: Args, name: string, required = false): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) ctx.refuse(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) ctx.refuse(`${name} must be whole cents, zero or more`);
  return value;
}

function hours(ctx: MutationContext, args: Args, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) ctx.refuse(`${name} must be a number of hours`);
  if (value < 0) ctx.refuse(`${name} cannot be negative`);
  return value;
}

function date(ctx: MutationContext, args: Args, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    if (required) ctx.refuse(`${name} is required`);
    return undefined;
  }
  if (!isDate(value)) ctx.refuse(`${name} must be a date written YYYY-MM-DD`);
  return value;
}

function oneOf(ctx: MutationContext, name: string, value: string | undefined, allowed: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (!allowed.includes(lower)) ctx.refuse(`${name} must be ${allowed.join(", ")}`);
  return lower;
}

function num(row: Row, column: string): number {
  const value = row[column];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function str(row: Row, column: string): string {
  const value = row[column];
  return value === null || value === undefined ? "" : String(value);
}

/** 123456 → "1,234.56", for a run's totals in a summary (never an individual's pay). */
export function formatMoney(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const whole = Math.floor(Math.abs(cents) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (Math.abs(cents) % 100).toString().padStart(2, "0");
  return `${currency} ${sign}${whole}.${frac}`;
}

function currencyOf(ctx: MutationContext): string {
  const business = ctx.get("SELECT currency FROM business ORDER BY id LIMIT 1");
  return business ? str(business, "currency") || DEFAULT_CURRENCY : DEFAULT_CURRENCY;
}

function periodLabel(period: Row): string {
  return `${str(period, "starts")} to ${str(period, "ends")}`;
}

// --- lookups --------------------------------------------------------------

function employee(ctx: MutationContext, employeeId: number): Row {
  return ctx.get("SELECT * FROM employees WHERE id = ?", [employeeId]) ?? ctx.refuse(`no employee with id ${employeeId}`);
}

function period(ctx: MutationContext, periodId: number): Row {
  return ctx.get("SELECT * FROM pay_periods WHERE id = ?", [periodId]) ?? ctx.refuse(`no pay period with id ${periodId}`);
}

function run(ctx: MutationContext, runId: number): Row {
  return ctx.get("SELECT * FROM pay_runs WHERE id = ?", [runId]) ?? ctx.refuse(`no pay run with id ${runId}`);
}

/** A current employee with this name (case and spacing aside), other than `except`. */
function currentByName(ctx: MutationContext, name: string, except?: number): Row | undefined {
  const wanted = name.trim().toLowerCase();
  return ctx
    .all("SELECT * FROM employees WHERE end_date IS NULL")
    .find((row) => str(row, "name").trim().toLowerCase() === wanted && num(row, "id") !== except);
}

/** Employees on the books for any day of the period: started by its end (or never dated) and not ended before it starts. */
function employedIn(ctx: MutationContext, periodRow: Row): Row[] {
  const starts = str(periodRow, "starts");
  const ends = str(periodRow, "ends");
  return ctx.all("SELECT * FROM employees ORDER BY id").filter((row) => {
    const started = str(row, "start_date");
    const ended = str(row, "end_date");
    return (started === "" || started <= ends) && (ended === "" || ended >= starts);
  });
}

// --- argument specs shared by several mutations ---------------------------

const EMPLOYEE_FIELDS: Record<string, ArgSpec> = {
  name: { kind: "text", describe: "Full name, unique among current employees" },
  pay_type: { kind: "text", describe: "hourly or salary" },
  rate_cents: { kind: "money", describe: "Hourly rate, or salary per pay period, in whole cents" },
  role: { kind: "text", describe: "Job title" },
  email: { kind: "text", describe: "Where their stub goes" },
  start_date: { kind: "date", describe: "First day, YYYY-MM-DD" },
  tax_id: { kind: "text", describe: "Tax reference (sensitive: masked for you)" },
  bank_account: { kind: "text", describe: "Account number (sensitive)" },
  bank_sort: { kind: "text", describe: "Sort code or routing number (sensitive)" },
  home_address: { kind: "text", describe: "Home address (sensitive)" },
  notes: { kind: "text", describe: "Anything else" },
};

const HOUR_FIELDS: Record<string, ArgSpec> = {
  regular_hours: { kind: "real", describe: "Hours at the plain rate" },
  overtime_hours: { kind: "real", describe: `Hours at ${OVERTIME_MULTIPLIER}x` },
  sick_hours: { kind: "real", describe: "Paid sick hours, at the plain rate" },
  holiday_hours: { kind: "real", describe: "Paid holiday hours, at the plain rate" },
};

/** Reads the employee fields present in args, validated, as a patch; `required` makes name, pay_type and rate_cents mandatory. */
function employeePatch(ctx: MutationContext, args: Args, required: boolean): Record<string, Value | undefined> {
  const patch: Record<string, Value | undefined> = {};
  const name = text(ctx, args, "name", required);
  if (name !== undefined) patch.name = name;
  const payType = oneOf(ctx, "pay_type", text(ctx, args, "pay_type", required), PAY_TYPES);
  if (payType !== undefined) patch.pay_type = payType;
  const rate = cents(ctx, args, "rate_cents", required);
  if (rate !== undefined) {
    if (rate === 0) ctx.refuse("rate_cents must be more than zero");
    patch.rate_cents = rate;
  }
  for (const field of ["role", "email", "tax_id", "bank_account", "bank_sort", "home_address", "notes"]) {
    if (has(args, field)) patch[field] = text(ctx, args, field) ?? null;
  }
  if (has(args, "start_date")) patch.start_date = date(ctx, args, "start_date") ?? null;
  return patch;
}

// --- timesheets -----------------------------------------------------------

type TimesheetInput = {
  employeeId: number;
  periodRow: Row;
  hours: Partial<Hours>;
  source?: string;
  /** null clears the note; undefined leaves it. */
  notes?: string | null;
};

/**
 * Inserts or updates the one timesheet for an employee and period. Hours not
 * given stay as they were (0 on a new row). Refuses a closed period, an
 * employee who left before the period, negative hours and more hours than
 * the period has.
 */
function setTimesheet(ctx: MutationContext, input: TimesheetInput): { id: number; inserted: boolean } {
  const { periodRow } = input;
  const periodId = num(periodRow, "id");
  if (str(periodRow, "status") === "closed") ctx.refuse(`pay period ${periodLabel(periodRow)} is closed`);
  const who = employee(ctx, input.employeeId);
  const ended = str(who, "end_date");
  if (ended !== "" && ended < str(periodRow, "starts")) {
    ctx.refuse(`${str(who, "name")} left on ${ended}, before the period ${periodLabel(periodRow)}`);
  }
  const existing = ctx.get("SELECT * FROM timesheets WHERE employee_id = ? AND period_id = ?", [input.employeeId, periodId]);
  const merged: Hours = {
    regular: input.hours.regular ?? (existing ? num(existing, "regular_hours") : 0),
    overtime: input.hours.overtime ?? (existing ? num(existing, "overtime_hours") : 0),
    sick: input.hours.sick ?? (existing ? num(existing, "sick_hours") : 0),
    holiday: input.hours.holiday ?? (existing ? num(existing, "holiday_hours") : 0),
  };
  const total = merged.regular + merged.overtime + merged.sick + merged.holiday;
  const most = daysInclusive(str(periodRow, "starts"), str(periodRow, "ends")) * 24;
  if (total > most) ctx.refuse(`${total} hours is more than the ${most} hours in ${periodLabel(periodRow)}`);
  const row: Record<string, Value | undefined> = {
    regular_hours: merged.regular,
    overtime_hours: merged.overtime,
    sick_hours: merged.sick,
    holiday_hours: merged.holiday,
  };
  if (input.source !== undefined) row.source = input.source;
  if (input.notes !== undefined) row.notes = input.notes;
  if (existing) {
    const existingId = num(existing, "id");
    ctx.update("timesheets", existingId, row);
    return { id: existingId, inserted: false };
  }
  return {
    id: ctx.insert("timesheets", { employee_id: input.employeeId, period_id: periodId, source: input.source ?? "typed", ...row }),
    inserted: true,
  };
}

function hoursFrom(ctx: MutationContext, args: Args): Partial<Hours> {
  return {
    regular: hours(ctx, args, "regular_hours"),
    overtime: hours(ctx, args, "overtime_hours"),
    sick: hours(ctx, args, "sick_hours"),
    holiday: hours(ctx, args, "holiday_hours"),
  };
}

/** Totals a run's items back onto the run. */
function retotal(ctx: MutationContext, runId: number): Row {
  const items = ctx.all("SELECT * FROM pay_items WHERE run_id = ?", [runId]);
  const sum = (column: string) => items.reduce((total, item) => total + num(item, column), 0);
  return ctx.update("pay_runs", runId, {
    gross_cents: sum("gross_cents"),
    deductions_cents: sum("deductions_cents"),
    net_cents: sum("net_cents"),
    employee_count: items.length,
  });
}

// --- mutations ------------------------------------------------------------

// Each run names its parameters' types: TypeScript only narrows after a
// never-returning call like ctx.refuse when ctx has an explicit annotation.

const MUTATIONS: Record<string, Mutation> = {
  business_set: {
    describe: "Sets the business's details and branding: the one row the templates read. Fields left out keep their value.",
    args: {
      legal_name: { kind: "text", describe: "The registered name; required the first time" },
      trading_name: { kind: "text", describe: "The name on stubs, when it differs" },
      address: { kind: "text", describe: "Postal address" },
      email: { kind: "text", describe: "The business's email" },
      phone: { kind: "text", describe: "The business's phone" },
      logo_path: { kind: "text", describe: "The logo's path in the repository" },
      accent_colour: { kind: "text", describe: "A CSS colour for the templates" },
      footer_text: { kind: "text", describe: "Small print under every report" },
      pay_schedule: { kind: "text", describe: "weekly, fortnightly or monthly" },
      currency: { kind: "text", describe: `ISO 4217 code such as GBP or USD (${DEFAULT_CURRENCY} unless set)` },
    },
    run(ctx: MutationContext, args: Args) {
      const existing = ctx.get("SELECT * FROM business ORDER BY id LIMIT 1");
      const patch: Record<string, Value | undefined> = {};
      for (const field of ["legal_name", "trading_name", "address", "email", "phone", "logo_path", "accent_colour", "footer_text"]) {
        if (has(args, field)) patch[field] = text(ctx, args, field) ?? null;
      }
      if (patch.legal_name === null || (patch.legal_name === undefined && !existing)) ctx.refuse("legal_name is required");
      if (has(args, "pay_schedule")) patch.pay_schedule = oneOf(ctx, "pay_schedule", text(ctx, args, "pay_schedule"), PAY_SCHEDULES) ?? null;
      if (has(args, "currency")) {
        const currency = (text(ctx, args, "currency") ?? "").toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) ctx.refuse("currency must be a three-letter code such as GBP or USD");
        patch.currency = currency;
      }
      if (existing) {
        const after = ctx.update("business", num(existing, "id"), patch);
        return `Updated the business: ${str(after, "legal_name")}`;
      }
      ctx.insert("business", { currency: DEFAULT_CURRENCY, ...patch });
      return `Set the business: ${String(patch.legal_name)}`;
    },
  },

  employee_add: {
    describe: "Adds an employee. The name must not belong to a current employee.",
    args: {
      ...EMPLOYEE_FIELDS,
      name: { ...EMPLOYEE_FIELDS.name!, required: true },
      pay_type: { ...EMPLOYEE_FIELDS.pay_type!, required: true },
      rate_cents: { ...EMPLOYEE_FIELDS.rate_cents!, required: true },
    },
    run(ctx: MutationContext, args: Args) {
      const patch = employeePatch(ctx, args, true);
      const name = String(patch.name);
      if (currentByName(ctx, name)) ctx.refuse(`there is already a current employee named ${name}`);
      const newId = ctx.insert("employees", patch);
      return `Added employee ${name} (${String(patch.pay_type)}), id ${newId}`;
    },
  },

  employee_update: {
    describe: "Changes an employee's details. Only the fields given change.",
    args: { id: { kind: "integer", required: true, describe: "The employee's id" }, ...EMPLOYEE_FIELDS },
    run(ctx: MutationContext, args: Args) {
      const employeeId = id(ctx, args, "id");
      const before = employee(ctx, employeeId);
      const patch = employeePatch(ctx, args, false);
      if (Object.keys(patch).length === 0) ctx.refuse("nothing to change: give at least one field");
      if (patch.name !== undefined && currentByName(ctx, String(patch.name), employeeId)) {
        ctx.refuse(`there is already a current employee named ${String(patch.name)}`);
      }
      const after = ctx.update("employees", employeeId, patch);
      const changed = Object.keys(patch).join(", ");
      return `Updated ${str(before, "name")}: ${changed}${patch.name !== undefined ? ` (now ${str(after, "name")})` : ""}`;
    },
  },

  employee_end: {
    describe: "Marks an employee's last day. They keep their timesheets and stubs and leave the current list.",
    args: {
      id: { kind: "integer", required: true, describe: "The employee's id" },
      end_date: { kind: "date", required: true, describe: "Their last day, YYYY-MM-DD" },
    },
    run(ctx: MutationContext, args: Args) {
      const employeeId = id(ctx, args, "id");
      const who = employee(ctx, employeeId);
      const endDate = date(ctx, args, "end_date", true)!;
      const already = str(who, "end_date");
      if (already !== "") ctx.refuse(`${str(who, "name")} already ended on ${already}`);
      const started = str(who, "start_date");
      if (started !== "" && endDate < started) ctx.refuse(`end_date ${endDate} is before ${str(who, "name")}'s start date ${started}`);
      ctx.update("employees", employeeId, { end_date: endDate });
      return `Ended ${str(who, "name")} on ${endDate}`;
    },
  },

  period_add: {
    describe: "Adds a pay period. It may not overlap another, and it ends on or after it starts.",
    args: {
      starts: { kind: "date", required: true, describe: "First day, YYYY-MM-DD" },
      ends: { kind: "date", required: true, describe: "Last day, included" },
      pay_date: { kind: "date", required: true, describe: "The day employees are paid" },
    },
    run(ctx: MutationContext, args: Args) {
      const starts = date(ctx, args, "starts", true)!;
      const ends = date(ctx, args, "ends", true)!;
      const payDate = date(ctx, args, "pay_date", true)!;
      if (ends < starts) ctx.refuse(`the period ends (${ends}) before it starts (${starts})`);
      const clash = ctx.all("SELECT * FROM pay_periods ORDER BY starts").find((row) => str(row, "starts") <= ends && str(row, "ends") >= starts);
      if (clash) ctx.refuse(`overlaps the pay period ${periodLabel(clash)} (id ${num(clash, "id")})`);
      const newId = ctx.insert("pay_periods", { starts, ends, pay_date: payDate, status: "open" });
      return `Added pay period ${starts} to ${ends}, paid ${payDate}, id ${newId}`;
    },
  },

  timesheet_set: {
    describe: "Sets one employee's hours for a period, adding the timesheet or changing it. Hours left out keep their value.",
    args: {
      employee_id: { kind: "integer", required: true, describe: "The employee's id" },
      period_id: { kind: "integer", required: true, describe: "The pay period's id" },
      ...HOUR_FIELDS,
      source: { kind: "text", describe: "Where the hours came from: sheet, file or typed" },
      notes: { kind: "text", describe: "Anything the run should know" },
    },
    run(ctx: MutationContext, args: Args) {
      const employeeId = id(ctx, args, "employee_id");
      const periodRow = period(ctx, id(ctx, args, "period_id"));
      const source = oneOf(ctx, "source", text(ctx, args, "source"), TIMESHEET_SOURCES);
      const notes = has(args, "notes") ? (text(ctx, args, "notes") ?? null) : undefined;
      const result = setTimesheet(ctx, { employeeId, periodRow, hours: hoursFrom(ctx, args), source, notes });
      const who = employee(ctx, employeeId);
      return `${result.inserted ? "Added" : "Updated"} the timesheet of ${str(who, "name")} for ${periodLabel(periodRow)}`;
    },
  },

  timefile_import: {
    describe: "Sets many timesheets for one period at once, naming each employee by name or id. One bad row refuses the whole import.",
    args: {
      period_id: { kind: "integer", required: true, describe: "The pay period's id" },
      source: { kind: "text", required: true, describe: "Where the rows came from: sheet, file or typed" },
      rows: {
        kind: "rows",
        required: true,
        describe: "One row per employee",
        of: {
          employee: { kind: "text", required: true, describe: "The employee's name or id" },
          regular_hours: { ...HOUR_FIELDS.regular_hours!, required: true },
          overtime_hours: HOUR_FIELDS.overtime_hours!,
          sick_hours: HOUR_FIELDS.sick_hours!,
          holiday_hours: HOUR_FIELDS.holiday_hours!,
        },
      },
    },
    run(ctx: MutationContext, args: Args) {
      const periodRow = period(ctx, id(ctx, args, "period_id"));
      const source = oneOf(ctx, "source", text(ctx, args, "source", true), TIMESHEET_SOURCES)!;
      const rows = args.rows;
      if (!Array.isArray(rows) || rows.length === 0) ctx.refuse("rows must be a list with at least one row");
      const onBooks = employedIn(ctx, periodRow);
      let count = 0;
      for (const [index, raw] of rows.entries()) {
        if (typeof raw !== "object" || raw === null) ctx.refuse(`row ${index + 1} is not an object`);
        const row = raw as Args;
        const label = row.employee;
        let who: Row | undefined;
        if (typeof label === "number" || (typeof label === "string" && /^\d+$/.test(label.trim()))) {
          who = onBooks.find((candidate) => num(candidate, "id") === Number(label));
        } else if (typeof label === "string" && label.trim() !== "") {
          const wanted = label.trim().toLowerCase();
          const matches = onBooks.filter((candidate) => str(candidate, "name").trim().toLowerCase() === wanted);
          if (matches.length > 1) ctx.refuse(`row ${index + 1}: ${matches.length} employees are named ${label.trim()}; use the id`);
          who = matches[0];
        } else {
          ctx.refuse(`row ${index + 1} names no employee`);
        }
        if (!who) ctx.refuse(`row ${index + 1}: no current employee named ${String(label).trim()}`);
        if (row.regular_hours === undefined || row.regular_hours === null) ctx.refuse(`row ${index + 1} (${str(who, "name")}) has no regular_hours`);
        setTimesheet(ctx, { employeeId: num(who, "id"), periodRow, hours: hoursFrom(ctx, row), source });
        count += 1;
      }
      return `${count} timesheet${count === 1 ? "" : "s"} for ${periodLabel(periodRow)}`;
    },
  },

  pay_run_create: {
    describe:
      "Creates a draft pay run for a period from its timesheets: hourly pay is the rate for each regular, sick and holiday hour and 1.5x for overtime; salary is the rate per period. Every employee on the books for the period needs a timesheet first.",
    args: {
      period_id: { kind: "integer", required: true, describe: "The pay period's id" },
      deduction_rate_percent: { kind: "real", describe: "A flat percentage taken off every gross; none when left out" },
    },
    run(ctx: MutationContext, args: Args) {
      const periodRow = period(ctx, id(ctx, args, "period_id"));
      const periodId = num(periodRow, "id");
      if (str(periodRow, "status") === "closed") ctx.refuse(`pay period ${periodLabel(periodRow)} is closed`);
      const open = ctx.all("SELECT * FROM pay_runs WHERE period_id = ?", [periodId]).find((row) => str(row, "status") !== "closed");
      if (open) ctx.refuse(`pay period ${periodLabel(periodRow)} already has pay run ${num(open, "id")} (${str(open, "status")})`);
      const rate = args.deduction_rate_percent;
      let deductionRate = 0;
      if (rate !== undefined && rate !== null) {
        if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100) ctx.refuse("deduction_rate_percent must be between 0 and 100");
        deductionRate = rate;
      }
      const sheets = ctx.all("SELECT * FROM timesheets WHERE period_id = ? ORDER BY employee_id", [periodId]);
      const withSheet = new Set(sheets.map((sheet) => num(sheet, "employee_id")));
      const missing = employedIn(ctx, periodRow).filter((who) => !withSheet.has(num(who, "id")));
      if (missing.length > 0) {
        ctx.refuse(`no timesheet for ${periodLabel(periodRow)} from ${missing.map((who) => str(who, "name")).join(", ")}`);
      }
      if (sheets.length === 0) ctx.refuse(`nobody has a timesheet for ${periodLabel(periodRow)}`);
      const runId = ctx.insert("pay_runs", { period_id: periodId, status: "draft", gross_cents: 0, deductions_cents: 0, net_cents: 0, employee_count: 0 });
      for (const sheet of sheets) {
        const who = employee(ctx, num(sheet, "employee_id"));
        const worked: Hours = {
          regular: num(sheet, "regular_hours"),
          overtime: num(sheet, "overtime_hours"),
          sick: num(sheet, "sick_hours"),
          holiday: num(sheet, "holiday_hours"),
        };
        const gross = payrollGross(str(who, "pay_type"), num(who, "rate_cents"), worked);
        const deductions = Math.round((gross * deductionRate) / 100);
        ctx.insert("pay_items", {
          run_id: runId,
          employee_id: num(who, "id"),
          hours: worked.regular + worked.overtime + worked.sick + worked.holiday,
          gross_cents: gross,
          deductions_cents: deductions,
          net_cents: gross - deductions,
        });
      }
      const totals = retotal(ctx, runId);
      ctx.update("pay_periods", periodId, { status: "run" });
      const count = num(totals, "employee_count");
      return `Draft pay run ${runId} for ${periodLabel(periodRow)}: ${count} employee${count === 1 ? "" : "s"}, gross ${formatMoney(num(totals, "gross_cents"), currencyOf(ctx))}`;
    },
  },

  pay_item_adjust: {
    describe: "Changes one line of a draft pay run: its deductions, its note, or both. The line's net and the run's totals follow.",
    args: {
      item_id: { kind: "integer", required: true, describe: "The pay item's id" },
      deductions_cents: { kind: "money", describe: "The new deductions, whole cents" },
      notes: { kind: "text", describe: "Why, for the stub and the review" },
    },
    run(ctx: MutationContext, args: Args) {
      const itemId = id(ctx, args, "item_id");
      const item = ctx.get("SELECT * FROM pay_items WHERE id = ?", [itemId]) ?? ctx.refuse(`no pay item with id ${itemId}`);
      const runRow = run(ctx, num(item, "run_id"));
      if (str(runRow, "status") !== "draft") ctx.refuse(`pay run ${num(runRow, "id")} is ${str(runRow, "status")}; only a draft run can be adjusted`);
      const patch: Record<string, Value | undefined> = {};
      const deductions = cents(ctx, args, "deductions_cents");
      if (deductions !== undefined) {
        const gross = num(item, "gross_cents");
        if (deductions > gross) ctx.refuse("deductions cannot be more than the gross pay");
        patch.deductions_cents = deductions;
        patch.net_cents = gross - deductions;
      }
      if (has(args, "notes")) patch.notes = text(ctx, args, "notes") ?? null;
      if (Object.keys(patch).length === 0) ctx.refuse("nothing to change: give deductions_cents or notes");
      ctx.update("pay_items", itemId, patch);
      retotal(ctx, num(runRow, "id"));
      const who = ctx.get("SELECT name FROM employees WHERE id = ?", [num(item, "employee_id")]);
      const what = [deductions !== undefined ? "deductions" : "", has(args, "notes") ? "notes" : ""].filter(Boolean).join(" and ");
      return `Adjusted ${what} on pay item ${itemId} (${who ? str(who, "name") : "unknown employee"}) of pay run ${num(runRow, "id")}`;
    },
  },

  pay_run_review: {
    describe: "Marks a draft pay run reviewed: its lines are checked and ready for the person to close.",
    args: { run_id: { kind: "integer", required: true, describe: "The pay run's id" } },
    run(ctx: MutationContext, args: Args) {
      const runRow = run(ctx, id(ctx, args, "run_id"));
      const runId = num(runRow, "id");
      if (str(runRow, "status") !== "draft") ctx.refuse(`pay run ${runId} is ${str(runRow, "status")}, not a draft`);
      ctx.update("pay_runs", runId, { status: "reviewed" });
      return `Pay run ${runId} reviewed`;
    },
  },

  pay_run_close: {
    describe: "Closes a reviewed pay run and its period. The closed run is what the pay stubs are rendered from; it moves no money.",
    args: { run_id: { kind: "integer", required: true, describe: "The pay run's id" } },
    run(ctx: MutationContext, args: Args) {
      const runRow = run(ctx, id(ctx, args, "run_id"));
      const runId = num(runRow, "id");
      const status = str(runRow, "status");
      if (status !== "reviewed") ctx.refuse(status === "draft" ? `pay run ${runId} has not been reviewed yet` : `pay run ${runId} is already closed`);
      ctx.update("pay_runs", runId, { status: "closed", closed_at: ctx.now });
      ctx.update("pay_periods", num(runRow, "period_id"), { status: "closed" });
      return `Pay run ${runId} closed: ${num(runRow, "employee_count")} employees, gross ${formatMoney(num(runRow, "gross_cents"), currencyOf(ctx))}`;
    },
  },

  pay_run_reopen: {
    describe: "Takes a reviewed or closed pay run back to draft, unless a stub from it has been sent.",
    args: { run_id: { kind: "integer", required: true, describe: "The pay run's id" } },
    run(ctx: MutationContext, args: Args) {
      const runRow = run(ctx, id(ctx, args, "run_id"));
      const runId = num(runRow, "id");
      const status = str(runRow, "status");
      if (status === "draft") ctx.refuse(`pay run ${runId} is already a draft`);
      const sent = ctx.all("SELECT * FROM stubs WHERE run_id = ? AND sent_at IS NOT NULL", [runId]);
      if (sent.length > 0) ctx.refuse(`${sent.length} pay stub${sent.length === 1 ? " has" : "s have"} been sent from pay run ${runId}; it cannot be reopened`);
      ctx.update("pay_runs", runId, { status: "draft", closed_at: null });
      if (status === "closed") ctx.update("pay_periods", num(runRow, "period_id"), { status: "run" });
      return `Pay run ${runId} reopened as a draft (was ${status})`;
    },
  },

  // The stubs (section 8): report_render writes the files under out/ and the
  // Foreman records each by path and hash; the agent marks them sent when the
  // email carrying them goes out (stubs_sent, sentFiles.ts). The path is the
  // only thing the Foreman knows about a stub, and it never opens it.
  stub_record: {
    describe: "Records a rendered pay stub for one employee on a pay run: its path under out/ and its sha256, from report_render. Recording again replaces the path and hash and keeps when it was sent.",
    args: {
      run_id: { kind: "integer", required: true, describe: "The pay run's id" },
      employee_id: { kind: "integer", required: true, describe: "The employee's id; they must have a pay item on the run" },
      path: { kind: "text", required: true, describe: "The file's repository-relative path, under out/, as report_render gave it" },
      sha256: { kind: "text", required: true, describe: "The file's sha256, as report_render gave it" },
    },
    run(ctx: MutationContext, args: Args) {
      const runRow = run(ctx, id(ctx, args, "run_id"));
      const runId = num(runRow, "id");
      const who = employee(ctx, id(ctx, args, "employee_id"));
      const employeeId = num(who, "id");
      if (!ctx.get("SELECT id FROM pay_items WHERE run_id = ? AND employee_id = ?", [runId, employeeId])) {
        ctx.refuse(`${str(who, "name")} has no pay item on pay run ${runId}`);
      }
      const path = text(ctx, args, "path", true) as string;
      if (!path.startsWith(`${OUT_DIR}/`) || path.includes("..")) ctx.refuse(`path must be a rendered file under ${OUT_DIR}/, as report_render gave it`);
      const sha256 = text(ctx, args, "sha256", true) as string;
      if (!/^[0-9a-f]{64}$/i.test(sha256)) ctx.refuse("sha256 must be the file's 64-character hash, as report_render gave it");
      const existing = ctx.get("SELECT * FROM stubs WHERE run_id = ? AND employee_id = ?", [runId, employeeId]);
      // sent_at and card_id stay: a re-render after sending is still the record of what left.
      if (existing) ctx.update("stubs", num(existing, "id"), { path, sha256: sha256.toLowerCase() });
      else ctx.insert("stubs", { run_id: runId, employee_id: employeeId, path, sha256: sha256.toLowerCase(), sent_at: null, card_id: null });
      return `stub recorded for ${str(who, "name")} on run ${runId}`;
    },
  },

  stub_sent: {
    describe: "Marks a recorded pay stub sent: when, and by which action card. The agent runs it when the card lands; a sent stub keeps its pay run closed.",
    agentOnly: true,
    args: {
      run_id: { kind: "integer", required: true, describe: "The pay run's id" },
      employee_id: { kind: "integer", required: true, describe: "The employee's id" },
      sent_at: { kind: "text", required: true, describe: "ISO time the stub left" },
      card_id: { kind: "text", required: true, describe: "The action card that sent it" },
    },
    run(ctx: MutationContext, args: Args) {
      const runId = id(ctx, args, "run_id");
      const employeeId = id(ctx, args, "employee_id");
      const stub = ctx.get("SELECT * FROM stubs WHERE run_id = ? AND employee_id = ?", [runId, employeeId]) ?? ctx.refuse(`no stub recorded for employee ${employeeId} on pay run ${runId}`);
      const sentAt = text(ctx, args, "sent_at", true) as string;
      if (Number.isNaN(Date.parse(sentAt))) ctx.refuse("sent_at must be an ISO time");
      const cardId = text(ctx, args, "card_id", true) as string;
      ctx.update("stubs", num(stub, "id"), { sent_at: sentAt, card_id: cardId });
      const who = ctx.get("SELECT name FROM employees WHERE id = ?", [employeeId]);
      return `stub for ${who ? str(who, "name") : `employee ${employeeId}`} on run ${runId} sent (card ${cardId})`;
    },
  },

  stubs_sent: {
    describe: "Marks the recorded pay stubs among the files an allowed email carried as sent. The agent runs it when the email goes out (the schema's `sent`); a stub already sent keeps its first time.",
    args: SENT_ARGS,
    run(ctx: MutationContext, args: Args) {
      const sentAt = text(ctx, args, "sent_at", true) as string;
      if (Number.isNaN(Date.parse(sentAt))) ctx.refuse("sent_at must be an ISO time");
      const cardId = text(ctx, args, "card_id", true) as string;
      const files = Array.isArray(args.files) ? (args.files as Array<Record<string, unknown>>) : [];
      const marked: string[] = [];
      for (const file of files) {
        if (typeof file.path !== "string" || typeof file.sha256 !== "string") continue;
        const stub = ctx.get("SELECT * FROM stubs WHERE path = ? AND sha256 = ? AND sent_at IS NULL", [file.path, file.sha256.toLowerCase()]);
        if (!stub) continue;
        ctx.update("stubs", num(stub, "id"), { sent_at: sentAt, card_id: cardId });
        const who = ctx.get("SELECT name FROM employees WHERE id = ?", [num(stub, "employee_id")]);
        marked.push(who ? str(who, "name") : `employee ${num(stub, "employee_id")}`);
      }
      if (marked.length === 0) ctx.refuse("no recorded stub matches those files");
      return `${marked.length} stub(s) sent (card ${cardId}): ${marked.join(", ")}`;
    },
  },
};

export const PAYROLL_SCHEMA: TradeSchema = {
  trade: PAYROLL_TRADE,
  version: 1,
  migrations: [MIGRATION_1],
  tables: TABLES,
  mutations: MUTATIONS,
  sent: "stubs_sent",
};
