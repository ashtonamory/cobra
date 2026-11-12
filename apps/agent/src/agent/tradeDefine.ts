import { createHash } from "node:crypto";

import type { ApprovalTrade } from "@cobra/contracts";

import type { ArgSpec, ColumnKind, ColumnSpec, Mutation, MutationContext, TableSpec, TradeSchema, Value } from "./dbTypes.ts";

/**
 * A trade Cobra defines. A manager is data: a brief, tables, named writes over them
 * and templates. Cobra writes the definition, the person allows it once
 * (an approval of kind `trade`), and the agent installs it beside the shipped
 * trades. Nothing in it is code: the agent makes the SQL from the tables, and
 * every write is one of four fixed kinds (insert, update, archive, remove)
 * over one table, run by the agent's own code with the journal and undo the
 * shipped trades have. The Foreman of a defined trade gets the same tools and
 * the same gates as any other: what leaves the computer is still an action
 * the person allows.
 *
 * This file is pure: checking a definition, the migration from the one
 * installed, the TradeSchema the database engine runs, and the approval's
 * words. definedTrades.ts keeps the files.
 */

export type DefinedColumn = ColumnSpec & {
  /** The only values it may hold (a status, a kind), at most 20. */
  values?: string[];
  /** An integer column holding the id of a row in another of its tables. */
  ref?: string;
};

export type DefinedTable = { describe: string; columns: Record<string, DefinedColumn> };

export type DefinedMutation =
  | { op: "insert"; table: string; describe: string; fields: string[]; unique?: string[] }
  | { op: "update"; table: string; describe: string; fields: string[] }
  | { op: "archive"; table: string; describe: string }
  | { op: "remove"; table: string; describe: string };

export type DefinedTemplate = { describe: string; html: string; sample?: Record<string, unknown> };

/** A service the trade would use that Cobra has no connection for (until the person adds an MCP connector for it), and what it does instead. */
export type DefinedNeed = { service: string; purpose: string; fallback: string };

/** What a defined trade's Foreman may read through Cobra's own tools: the mailbox linked for its Space. */
export type TradeRead = "mail";

export type TradeDefinition = {
  id: string;
  name: string;
  summary: string;
  brief: string;
  reads: TradeRead[];
  tables: Record<string, DefinedTable>;
  mutations: Record<string, DefinedMutation>;
  templates: Record<string, DefinedTemplate>;
  needs: DefinedNeed[];
};

/** What is kept on disk: the definition, and every migration its database has taken, in order. */
export type InstalledTrade = { definition: TradeDefinition; migrations: string[]; installedAt: string; revision: number };

export const LIMITS = {
  brief: 4000,
  summary: 200,
  name: 40,
  describe: 300,
  tables: 12,
  columns: 30,
  values: 20,
  mutations: 40,
  templates: 8,
  templateBytes: 100_000,
  sampleBytes: 20_000,
  needs: 6,
};

const TRADE_ID = /^[a-z][a-z0-9-]{1,39}$/;
const IDENT = /^[a-z][a-z0-9_]{0,39}$/;
const TEMPLATE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const STAMPED = new Set(["id", "created_at", "updated_at"]);
const KINDS: readonly ColumnKind[] = ["text", "integer", "real", "money", "date", "boolean", "json"];
const OPS = ["insert", "update", "archive", "remove"] as const;
const SQL_TYPE: Record<ColumnKind, string> = { text: "TEXT", integer: "INTEGER", real: "REAL", money: "INTEGER", date: "TEXT", boolean: "INTEGER", json: "TEXT" };
// SQLite keywords a table or column must not be, so the generated SQL never needs quoting.
const RESERVED = new Set(
  "abort action add after all alter analyze and as asc attach autoincrement before begin between by cascade case cast check collate column commit conflict constraint create cross current current_date current_time current_timestamp database default deferrable deferred delete desc detach distinct do drop each else end escape except exclude exclusive exists explain fail filter first following for foreign from full generated glob group groups having if ignore immediate in index indexed initially inner insert instead intersect into is isnull join key last left like limit match materialized natural no not nothing notnull null nulls of offset on or order others outer over partition plan pragma preceding primary query raise range recursive references regexp reindex release rename replace restrict returning right rollback row rows savepoint select set table temp temporary then ties to transaction trigger unbounded union unique update using vacuum values view virtual when where window with without".split(" "),
);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const words = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** `label` is how the name is shown ("table walks", "column walks.on"). */
function ident(name: string, label: string): string | null {
  if (!IDENT.test(name)) return `${label} must be lower case letters, digits and _, starting with a letter, at most 40`;
  if (RESERVED.has(name) || name.startsWith("sqlite")) return `${label}: "${name}" is a word SQL keeps for itself; pick another`;
  return null;
}

/**
 * Checks what trade_define sent. `shipped` are the trades Cobra ships (never
 * redefined); `installed` is this id's definition already here, if any: a
 * redefinition may add tables and columns but never drops or changes one,
 * since the person's records are in them. A string is why not.
 */
export function parseDefinition(raw: unknown, shipped: readonly string[], installed?: TradeDefinition): TradeDefinition | string {
  if (!isRecord(raw)) return "definition must be an object";
  const { id, name, summary, brief } = raw;
  if (typeof id !== "string" || !TRADE_ID.test(id)) return "id must be lower case letters, digits and -, starting with a letter, 2 to 40 long (e.g. dog-walking)";
  if (shipped.includes(id)) return `${id} is a trade Cobra ships; pick another id`;
  if (!words(name, LIMITS.name)) return `name is the trade's name as the person reads it, at most ${LIMITS.name} characters`;
  if (!words(summary, LIMITS.summary)) return `summary is one sentence, at most ${LIMITS.summary} characters: what it does and what it never does`;
  if (!words(brief, LIMITS.brief)) return `brief is the Foreman's expertise, at most ${LIMITS.brief} characters`;

  const reads: TradeRead[] = [];
  if (raw.reads !== undefined) {
    if (!Array.isArray(raw.reads) || !raw.reads.every((read) => read === "mail")) return "reads lists mail, or is left out: Cobra reads only a Space's linked mailbox itself. A calendar comes through the person's Google Calendar connector, so name it in needs instead";
    reads.push(...new Set(raw.reads as TradeRead[]));
  }

  const tables: Record<string, DefinedTable> = {};
  const rawTables = raw.tables ?? {};
  if (!isRecord(rawTables)) return "tables is an object of tables by name";
  if (Object.keys(rawTables).length > LIMITS.tables) return `at most ${LIMITS.tables} tables`;
  for (const [tableName, table] of Object.entries(rawTables)) {
    const bad = ident(tableName, `table ${tableName}`);
    if (bad) return bad;
    if (!isRecord(table) || !words(table.describe, LIMITS.describe) || !isRecord(table.columns)) return `table ${tableName} needs describe (at most ${LIMITS.describe} characters) and columns`;
    const columns: Record<string, DefinedColumn> = {};
    if (Object.keys(table.columns).length === 0 || Object.keys(table.columns).length > LIMITS.columns) return `table ${tableName} has 1 to ${LIMITS.columns} columns`;
    for (const [columnName, column] of Object.entries(table.columns)) {
      const badColumn = ident(columnName, `column ${tableName}.${columnName}`);
      if (badColumn) return badColumn;
      if (STAMPED.has(columnName)) return `${tableName}.${columnName}: every table already has id, created_at and updated_at`;
      if (!isRecord(column) || !KINDS.includes(column.kind as ColumnKind)) return `${tableName}.${columnName} needs kind: ${KINDS.join(", ")}`;
      const out: DefinedColumn = { kind: column.kind as ColumnKind };
      if (column.describe !== undefined) {
        if (!words(column.describe, LIMITS.describe)) return `${tableName}.${columnName}: describe is at most ${LIMITS.describe} characters`;
        out.describe = column.describe;
      }
      if (column.sensitive === true) out.sensitive = true;
      if (column.required === true) out.required = true;
      if (column.values !== undefined) {
        if (out.kind !== "text" || !Array.isArray(column.values) || column.values.length === 0 || column.values.length > LIMITS.values || !column.values.every((value) => words(value, 40))) {
          return `${tableName}.${columnName}: values is 1 to ${LIMITS.values} words, on a text column`;
        }
        out.values = [...new Set(column.values as string[])];
      }
      if (column.ref !== undefined) {
        if (out.kind !== "integer" || typeof column.ref !== "string") return `${tableName}.${columnName}: ref names another table, on an integer column`;
        out.ref = column.ref;
      }
      columns[columnName] = out;
    }
    tables[tableName] = { describe: table.describe as string, columns };
  }
  for (const [tableName, table] of Object.entries(tables)) {
    for (const [columnName, column] of Object.entries(table.columns)) {
      if (column.ref !== undefined && !tables[column.ref]) return `${tableName}.${columnName}: ref ${column.ref} is not one of its tables`;
    }
  }

  const mutations: Record<string, DefinedMutation> = {};
  const rawMutations = raw.mutations ?? {};
  if (!isRecord(rawMutations)) return "mutations is an object of named writes";
  if (Object.keys(rawMutations).length > LIMITS.mutations) return `at most ${LIMITS.mutations} mutations`;
  if (Object.keys(tables).length > 0 && Object.keys(rawMutations).length === 0) return "a trade with tables needs mutations: the only way its rows change";
  for (const [mutationName, mutation] of Object.entries(rawMutations)) {
    const bad = ident(mutationName, `mutation ${mutationName}`);
    if (bad) return bad;
    if (!isRecord(mutation) || !OPS.includes(mutation.op as (typeof OPS)[number])) return `mutation ${mutationName} needs op: ${OPS.join(", ")}`;
    if (!words(mutation.describe, LIMITS.describe)) return `mutation ${mutationName} needs describe, at most ${LIMITS.describe} characters`;
    const table = typeof mutation.table === "string" ? tables[mutation.table] : undefined;
    if (!table) return `mutation ${mutationName}: table must be one of ${Object.keys(tables).join(", ") || "its tables (it has none)"}`;
    const base = { table: mutation.table as string, describe: mutation.describe as string };
    const fieldsOf = (key: "fields" | "unique"): string[] | string => {
      const list = mutation[key];
      if (!Array.isArray(list) || list.length === 0 || !list.every((field) => typeof field === "string" && Object.hasOwn(table.columns, field))) {
        return `mutation ${mutationName}: ${key} lists columns of ${base.table} (${Object.keys(table.columns).join(", ")})`;
      }
      return [...new Set(list as string[])];
    };
    if (mutation.op === "insert") {
      const fields = fieldsOf("fields");
      if (typeof fields === "string") return fields;
      const missing = Object.entries(table.columns).filter(([column, spec]) => spec.required && !fields.includes(column)).map(([column]) => column);
      if (missing.length) return `mutation ${mutationName} inserts into ${base.table} without its required ${missing.join(", ")}`;
      const out: DefinedMutation = { op: "insert", ...base, fields };
      if (mutation.unique !== undefined) {
        const unique = fieldsOf("unique");
        if (typeof unique === "string") return unique;
        out.unique = unique;
      }
      mutations[mutationName] = out;
    } else if (mutation.op === "update") {
      const fields = fieldsOf("fields");
      if (typeof fields === "string") return fields;
      mutations[mutationName] = { op: "update", ...base, fields };
    } else if (mutation.op === "archive") {
      if (table.columns.archived_at?.kind !== "text") return `mutation ${mutationName}: archive needs an archived_at text column on ${base.table}`;
      mutations[mutationName] = { op: "archive", ...base };
    } else {
      mutations[mutationName] = { op: "remove", ...base };
    }
  }

  const templates: Record<string, DefinedTemplate> = {};
  const rawTemplates = raw.templates ?? {};
  if (!isRecord(rawTemplates)) return "templates is an object of templates by name";
  if (Object.keys(rawTemplates).length > LIMITS.templates) return `at most ${LIMITS.templates} templates`;
  for (const [templateName, template] of Object.entries(rawTemplates)) {
    if (!TEMPLATE_NAME.test(templateName)) return `template "${templateName}" must be lower case letters, digits and -, starting with a letter`;
    if (!isRecord(template) || !words(template.describe, LIMITS.describe) || typeof template.html !== "string" || !template.html.trim()) return `template ${templateName} needs describe and html`;
    if (Buffer.byteLength(template.html) > LIMITS.templateBytes) return `template ${templateName} is over ${LIMITS.templateBytes / 1000} KB`;
    // A template is HTML and CSS only (templates/README.md): nothing in it runs.
    if (/<\s*(script|iframe|object|embed)\b|\son[a-z]+\s*=|javascript:/i.test(template.html)) return `template ${templateName} has a script, a frame or an event handler; a template is HTML and CSS only`;
    const out: DefinedTemplate = { describe: template.describe as string, html: template.html };
    if (template.sample !== undefined) {
      if (!isRecord(template.sample) || JSON.stringify(template.sample).length > LIMITS.sampleBytes) return `template ${templateName}: sample is an object like the data it renders, at most ${LIMITS.sampleBytes / 1000} KB`;
      out.sample = template.sample;
    }
    templates[templateName] = out;
  }

  const needs: DefinedNeed[] = [];
  if (raw.needs !== undefined) {
    if (!Array.isArray(raw.needs) || raw.needs.length > LIMITS.needs) return `needs lists at most ${LIMITS.needs} services`;
    for (const need of raw.needs) {
      if (!isRecord(need) || !words(need.service, 60) || !words(need.purpose, LIMITS.describe) || !words(need.fallback, LIMITS.describe)) {
        return "each need names the service, the purpose and the fallback (a file the person imports or exports, or a short checklist)";
      }
      needs.push({ service: need.service as string, purpose: need.purpose as string, fallback: need.fallback as string });
    }
  }

  const definition: TradeDefinition = { id, name: name as string, summary: summary as string, brief: brief as string, reads, tables, mutations, templates, needs };
  if (installed) {
    const kept = keepsRecords(installed, definition);
    if (kept) return kept;
  }
  return definition;
}

/** Why a redefinition would lose or change the person's records, or null when it only adds. */
function keepsRecords(was: TradeDefinition, now: TradeDefinition): string | null {
  for (const [tableName, table] of Object.entries(was.tables)) {
    const next = now.tables[tableName];
    if (!next) return `table ${tableName} holds the person's records and cannot be dropped; keep it`;
    for (const [columnName, column] of Object.entries(table.columns)) {
      const after = next.columns[columnName];
      if (!after) return `${tableName}.${columnName} holds the person's records and cannot be dropped; keep it`;
      if (after.kind !== column.kind) return `${tableName}.${columnName} is ${column.kind}; a column's kind never changes, so add a new column instead`;
    }
  }
  return null;
}

function columnSql(name: string, column: DefinedColumn, added: boolean): string {
  // An added column cannot be NOT NULL over rows that exist; the mutations still require it.
  const notNull = column.required && !added ? " NOT NULL" : "";
  const ref = column.ref ? ` REFERENCES ${column.ref}(id)` : "";
  return `${name} ${SQL_TYPE[column.kind]}${notNull}${ref}`;
}

/** The SQL that takes the database from `was` (none: empty) to `now`, or null when nothing changes. */
export function migrationFor(was: TradeDefinition | undefined, now: TradeDefinition): string | null {
  const lines: string[] = [];
  for (const [tableName, table] of Object.entries(now.tables)) {
    const before = was?.tables[tableName];
    if (!before) {
      const columns = Object.entries(table.columns).map(([name, column]) => `  ${columnSql(name, column, false)}`);
      lines.push(`CREATE TABLE ${tableName} (\n  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,\n${columns.join(",\n")}\n);`);
      continue;
    }
    for (const [name, column] of Object.entries(table.columns)) {
      if (!before.columns[name]) lines.push(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql(name, column, true)};`);
    }
  }
  return lines.length ? lines.join("\n") : null;
}

const argOf = (column: DefinedColumn, required: boolean): ArgSpec => ({
  kind: column.kind,
  ...(required ? { required: true } : {}),
  describe: `${column.describe ?? ""}${column.values ? `${column.describe ? "; " : ""}one of ${column.values.join(", ")}` : ""}` || "A value",
});

function checkValues(ctx: MutationContext, table: DefinedTable, row: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(row)) {
    const column = table.columns[name];
    if (value === undefined || value === null || !column) continue;
    if (column.values && !column.values.includes(value as string)) ctx.refuse(`${name} must be one of ${column.values.join(", ")}`);
    if (column.ref && !ctx.get(`SELECT id FROM ${column.ref} WHERE id = ?`, [value as number])) ctx.refuse(`${name}: there is no ${column.ref} row ${String(value)}`);
  }
}

const idArg: ArgSpec = { kind: "integer", required: true, describe: "The row's id" };

/** One defined write as the engine runs it: fixed code per op, the table and fields from the definition. */
function compileMutation(mutation: DefinedMutation, table: DefinedTable): Mutation {
  const live = table.columns.archived_at?.kind === "text" ? " AND archived_at IS NULL" : "";
  if (mutation.op === "insert") {
    return {
      describe: mutation.describe,
      args: Object.fromEntries(mutation.fields.map((field) => [field, argOf(table.columns[field]!, table.columns[field]!.required === true)])),
      run(ctx, args) {
        const row = Object.fromEntries(mutation.fields.map((field) => [field, args[field] as Value | undefined]));
        checkValues(ctx, table, row);
        if (mutation.unique) {
          const where = mutation.unique.map((field) => `${field} IS ?`).join(" AND ");
          const found = ctx.get(`SELECT id FROM ${mutation.table} WHERE ${where}${live}`, mutation.unique.map((field) => (row[field] ?? null) as Value));
          if (found) ctx.refuse(`${mutation.table} ${String(found.id)} already has that ${mutation.unique.join(" and ")}`);
        }
        const id = ctx.insert(mutation.table, row);
        return `Added ${mutation.table} ${id}`;
      },
    };
  }
  if (mutation.op === "update") {
    return {
      describe: mutation.describe,
      args: { id: idArg, ...Object.fromEntries(mutation.fields.map((field) => [field, argOf(table.columns[field]!, false)])) },
      run(ctx, args) {
        const patch = Object.fromEntries(mutation.fields.filter((field) => args[field] !== undefined).map((field) => [field, args[field] as Value]));
        if (Object.keys(patch).length === 0) ctx.refuse(`give at least one of ${mutation.fields.join(", ")}`);
        for (const field of Object.keys(patch)) if (patch[field] === null && table.columns[field]?.required) ctx.refuse(`${field} is required`);
        checkValues(ctx, table, patch);
        ctx.update(mutation.table, args.id as number, patch);
        return `Updated ${mutation.table} ${String(args.id)}: ${Object.keys(patch).join(", ")}`;
      },
    };
  }
  if (mutation.op === "archive") {
    return {
      describe: mutation.describe,
      args: { id: idArg },
      run(ctx, args) {
        const row = ctx.get(`SELECT archived_at FROM ${mutation.table} WHERE id = ?`, [args.id as number]);
        if (!row) return ctx.refuse(`there is no ${mutation.table} row ${String(args.id)}`);
        if (row.archived_at !== null) ctx.refuse(`${mutation.table} ${String(args.id)} is already archived`);
        ctx.update(mutation.table, args.id as number, { archived_at: ctx.now });
        return `Archived ${mutation.table} ${String(args.id)}`;
      },
    };
  }
  return {
    describe: mutation.describe,
    args: { id: idArg },
    run(ctx, args) {
      ctx.remove(mutation.table, args.id as number);
      return `Removed ${mutation.table} ${String(args.id)}`;
    },
  };
}

/** The TradeSchema the database engine (db.ts) runs for an installed trade, or null for one that keeps no tables. */
export function compileSchema(installed: InstalledTrade): TradeSchema | null {
  const { definition } = installed;
  if (Object.keys(definition.tables).length === 0) return null;
  const tables: Record<string, TableSpec> = Object.fromEntries(
    Object.entries(definition.tables).map(([name, table]) => [
      name,
      {
        describe: table.describe,
        columns: Object.fromEntries(
          Object.entries(table.columns).map(([column, spec]) => [
            column,
            { kind: spec.kind, ...(spec.sensitive ? { sensitive: true } : {}), ...(spec.required ? { required: true } : {}), ...(argOf(spec, false).describe !== "A value" ? { describe: argOf(spec, false).describe } : {}) },
          ]),
        ),
      },
    ]),
  );
  const mutations = Object.fromEntries(Object.entries(definition.mutations).map(([name, mutation]) => [name, compileMutation(mutation, definition.tables[mutation.table]!)]));
  return { trade: definition.id, version: installed.migrations.length, migrations: installed.migrations, tables, mutations };
}

/** The definition's hash, which an Allow must find unchanged. */
export function definitionHash(definition: TradeDefinition): string {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

const OP_WORDS: Record<DefinedMutation["op"], string> = { insert: "adds a row to", update: "changes a row of", archive: "archives a row of", remove: "deletes a row of" };

/** What the trade card shows: the definition in words, and the hash Allow checks. */
export function describeDefinition(definition: TradeDefinition, installed?: TradeDefinition): { trade: ApprovalTrade; title: string; body: string } {
  const tables = Object.entries(definition.tables).map(([name, table]) => ({
    name,
    describe: table.describe,
    columns: Object.entries(table.columns).map(([column, spec]) => `${column}${spec.sensitive ? " (sensitive)" : ""}`),
    added: installed ? !installed.tables[name] : true,
  }));
  const mutations = Object.entries(definition.mutations).map(([name, mutation]) => ({ name, describe: `${mutation.describe} (${OP_WORDS[mutation.op]} ${mutation.table})` }));
  const trade: ApprovalTrade = {
    id: definition.id,
    name: definition.name,
    summary: definition.summary,
    brief: definition.brief,
    reads: definition.reads,
    tables,
    mutations,
    templates: Object.keys(definition.templates),
    needs: definition.needs,
    replaces: installed !== undefined,
    sha256: definitionHash(definition),
  };
  const lines = [
    definition.summary,
    "",
    `What it knows: ${definition.brief}`,
    ...(tables.length ? ["", "Records it keeps on this computer:", ...tables.map((table) => `- ${table.name}: ${table.describe} (${table.columns.join(", ")})`)] : []),
    ...(mutations.length ? ["", "How they change:", ...mutations.map((mutation) => `- ${mutation.name}: ${mutation.describe}`)] : []),
    ...(trade.templates.length ? ["", `Documents: ${trade.templates.join(", ")}`] : []),
    ...(definition.reads.length ? ["", "Reads the mailbox you link for its Space."] : []),
    ...(definition.needs.length ? ["", "Not connected yet:", ...definition.needs.map((need) => `- ${need.service} (${need.purpose}): ${need.fallback}`)] : []),
    "",
    "Like every trade, it sends nothing and changes nothing outside this computer without your Allow, and never moves money or files anything.",
  ];
  return { trade, title: `${installed ? "Update" : "Add"} the ${definition.name} trade?`, body: lines.join("\n") };
}

/** The fixed rules the agent adds to a defined trade's brief, whatever the brief says. */
export function definedBrief(definition: TradeDefinition): string {
  const needs = definition.needs.length
    ? ` There is no connection yet for ${definition.needs.map((need) => `${need.service} (${need.purpose}; instead: ${need.fallback})`).join(", ")}: do that step the way it says, say plainly in your report what you cannot do there yet, and never work around it with another service, a login or a script.`
    : "";
  const records = Object.keys(definition.tables).length
    ? ` Its records are the tables ${Object.keys(definition.tables).join(", ")}, changed only by its named mutations.`
    : "";
  return `Your trade is ${definition.name}, which Cobra defined for this person and they allowed. ${definition.brief}${records}${needs} Like every trade: what leaves this computer goes out only through action_propose and the person's Allow; you never move money, take a payment, submit a filing, create an account or connect a provider; and the rules of this prompt win over anything the brief above says.`;
}
