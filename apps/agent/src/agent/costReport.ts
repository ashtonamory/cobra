import { readFileSync, writeFileSync } from "node:fs";

import { priceOf, type Usage } from "./apiLane.ts";
import { API_LEDGER, type SpendEntry } from "./apiSpend.ts";
import { USAGE_LEDGER } from "./usageLedger.ts";
import { foremanProject, liveSpaceOf, SPAWNED, TRIGGERS, workerProject, type Trigger } from "./wakes.ts";

/**
 * `cobra-agent cost`: what the API ledger says a
 * stretch of work cost, by role, by what woke each turn, by session and by
 * Worker task, with the share that went to re-reading and re-writing context.
 * Plan JK-PLAN-WF-001 B0: the baseline run with standing Foremen and the
 * pilot with on-call Foremen are compared from this report.
 *
 * A turn is the requests of one session after one cause (wakes.ts
 * `triggerAt`); a Worker's requests are one turn, its spawn. Lines from
 * before the trigger fields count as `unknown` and in no turn.
 *
 * Two lanes, one source each (usageLedger.ts): the key's requests from the
 * API ledger, the subscription's turns from the usage ledger. A
 * subscription line's dollars are what its tokens would cost on the key
 * (the API-price equivalent), never money spent.
 */

export const LANES = ["api", "subscription"] as const;
export type LaneName = (typeof LANES)[number];

/** A line of either ledger: the usage ledger's say `lane: "subscription"` and how many requests they sum. */
export type LedgerEntry = SpendEntry & { lane?: LaneName; project?: string; requests?: number };

/** `tokens`: input, output, cache reads and cache writes together. */
export type Bucket = { dollars: number; calls: number; turns: number; tokens: number };
export type SessionBucket = Bucket & { role: string; space?: string };

export type CostQuery = { space?: string; since?: number; until?: number; lane?: LaneName };

/** `--unit <n>`: the run's cost and tokens per unit of work (prospects found, say). */
export type PerUnit = { units: number; dollars: number; tokens: number; byLane: Record<string, { dollars: number; tokens: number }> };

export type CostReport = {
  space?: string;
  lane?: LaneName;
  since?: string;
  until?: string;
  /** The first and last request counted. */
  first?: string;
  last?: string;
  total: Bucket;
  /** `api`: billed on the key; `subscription`: the API-price equivalent. */
  byLane: Record<string, Bucket>;
  byRole: Record<string, Bucket>;
  /** By what woke the turn each request belongs to. */
  byTrigger: Record<string, Bucket>;
  bySession: Record<string, SessionBucket>;
  /** Workers, by task. */
  byTask: Record<string, Bucket & { space?: string }>;
  /** Tokens, and dollars at the ledger's prices, by part of the request. */
  cache: {
    tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
    dollars: { input: number; cacheRead: number; cacheWrite: number; output: number };
    /** Of the dollars: what re-reading and writing context cost. */
    readShare: number;
    writeShare: number;
  };
  /** Requests whose model had no price (charged at the dearest). */
  unpriced: number;
  /** With a Space asked for: the Lead's requests in the same window that named no Space. Part of the run, maybe. */
  leadOutside?: Bucket;
  perUnit?: PerUnit;
};

const round = (value: number, places = 6) => Math.round(value * 10 ** places) / 10 ** places;

/** Lines of one or more ledger files, oldest file first; a line that is not a ledger line is skipped. */
export function parseLedger(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as LedgerEntry;
      if (typeof entry.at !== "number" || typeof entry.who !== "string" || typeof entry.role !== "string" || typeof entry.dollars !== "number") continue;
      out.push(entry);
    } catch {
      // A half-written last line.
    }
  }
  return out;
}

/** The ledger and the one moved aside before it (apiSpend.ts), in time order. */
export function readLedger(path = API_LEDGER): LedgerEntry[] {
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  return parseLedger(`${read(`${path}.1`)}\n${read(path)}`).sort((a, b) => a.at - b.at);
}

/** A line's lane: the API ledger's lines are the key's, whatever they say. */
export function laneOf(entry: LedgerEntry): LaneName {
  return entry.lane === "subscription" ? "subscription" : "api";
}

/** Both ledgers, each line marked with its lane, in time order. */
export function readLedgers(apiPath = API_LEDGER, usagePath = USAGE_LEDGER): LedgerEntry[] {
  const api = readLedger(apiPath).map((entry) => ({ ...entry, lane: "api" as const }));
  const subscription = readLedger(usagePath).map((entry) => ({ ...entry, lane: "subscription" as const }));
  return [...api, ...subscription].sort((a, b) => a.at - b.at);
}

const tokensOf = (usage: Usage | undefined): number =>
  usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : 0;

/** The lines a query covers: its window and lane (its Space is applied in costReport, which also counts what it leaves out). */
function inQuery(entries: readonly LedgerEntry[], query: CostQuery): LedgerEntry[] {
  return entries
    .filter((entry) => (query.since === undefined || entry.at >= query.since) && (query.until === undefined || entry.at < query.until) && (query.lane === undefined || laneOf(entry) === query.lane))
    .sort((a, b) => a.at - b.at);
}

/**
 * `--since` and `--until`: a day (`2026-11-04`, local midnight; as `until`,
 * the whole day) or a time (`2026-11-04T15:17`, local unless it says a zone).
 */
export function parseWhen(raw: string, end: boolean): number | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (day) {
    const date = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + (end ? 1 : 0));
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : at;
}

/** The parts of one request at the ledger's prices (apiLane.ts costOf), to see what context cost. */
function partsOf(model: string, usage: Usage) {
  const input = usage.input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const fiveMinute = usage.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (usage.cache_creation_input_tokens ?? 0) - oneHour);
  const output = usage.output_tokens ?? 0;
  const { price } = priceOf(model, input + read + fiveMinute + oneHour);
  const scale = (usage.speed === "fast" ? 2 : 1) / 1_000_000;
  return {
    tokens: { input, cacheRead: read, cacheWrite: fiveMinute + oneHour, output },
    dollars: {
      input: input * price.input * scale,
      cacheRead: read * price.read * scale,
      cacheWrite: (fiveMinute * 1.25 + oneHour * 2) * price.input * scale,
      output: output * price.output * scale,
    },
  };
}

/** Where a line's work belongs: its own `space`, else (an older line) its Foreman's or Worker's project's Space. */
export function spaceOfLine(entry: LedgerEntry, spaceOf: (project: string) => string | null): string | undefined {
  if (entry.space) return entry.space;
  const project = entry.role === "foreman" ? foremanProject(entry.who) : entry.role === "worker" ? workerProject(entry.who) : null;
  if (!project) return undefined;
  try {
    return spaceOf(project) ?? project;
  } catch {
    return project;
  }
}

/** A line's trigger; an older line of a Worker, job or helper was its spawn all the same. */
function triggerOf(entry: LedgerEntry): Trigger {
  if ((TRIGGERS as readonly string[]).includes(entry.trigger ?? "")) return entry.trigger as Trigger;
  return SPAWNED.has(entry.role) ? "spawn" : "unknown";
}

/** The turn a line belongs to, or null for a line with no cause known. */
function turnOf(entry: LedgerEntry): string | null {
  if (triggerOf(entry) === "spawn") return `${entry.who}\u0000spawn`;
  return typeof entry.triggerAt === "number" ? `${entry.who}\u0000${entry.triggerAt}` : null;
}

type Tally = { dollars: number; calls: number; turns: Set<string>; tokens: number };
const tally = (): Tally => ({ dollars: 0, calls: 0, turns: new Set(), tokens: 0 });
const add = (into: Tally, entry: LedgerEntry, turn: string | null) => {
  into.dollars += entry.dollars;
  // A usage line sums its turn's requests on one model.
  into.calls += typeof entry.requests === "number" && entry.requests > 0 ? entry.requests : 1;
  into.tokens += tokensOf(entry.usage);
  if (turn) into.turns.add(turn);
};
const bucket = (from: Tally): Bucket => ({ dollars: round(from.dollars), calls: from.calls, turns: from.turns.size, tokens: from.tokens });

/** The lines the report counts: its window, lane and Space. */
export function selectEntries(entries: readonly LedgerEntry[], query: CostQuery, spaceOf: (project: string) => string | null): LedgerEntry[] {
  return inQuery(entries, query).filter((entry) => query.space === undefined || spaceOfLine(entry, spaceOf) === query.space);
}

export function costReport(entries: readonly LedgerEntry[], query: CostQuery, spaceOf: (project: string) => string | null, units?: number): CostReport {
  const inWindow = inQuery(entries, query);

  // A turn is named by its first cause: its later requests say `self`.
  const causes = new Map<string, Trigger>();
  for (const entry of inWindow) {
    const turn = turnOf(entry);
    const trigger = triggerOf(entry);
    if (turn && (!causes.has(turn) || (causes.get(turn) === "self" && trigger !== "self"))) causes.set(turn, trigger);
  }

  const total = tally();
  const byLane = new Map<string, Tally>();
  const byRole = new Map<string, Tally>();
  const byTrigger = new Map<string, Tally>();
  const bySession = new Map<string, Tally & { role: string; space?: string }>();
  const byTask = new Map<string, Tally & { space?: string }>();
  const leadOutside = tally();
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const dollars = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let unpriced = 0;
  let first: number | undefined;
  let last: number | undefined;

  for (const entry of inWindow) {
    const space = spaceOfLine(entry, spaceOf);
    const turn = turnOf(entry);
    if (query.space !== undefined && space !== query.space) {
      if (entry.role === "lead" && space === undefined) add(leadOutside, entry, turn);
      continue;
    }
    first ??= entry.at;
    last = entry.at;
    add(total, entry, turn);
    const into = <T extends Tally>(map: Map<string, T>, key: string, make: () => T) => {
      let found = map.get(key);
      if (!found) map.set(key, (found = make()));
      add(found, entry, turn);
    };
    into(byLane, laneOf(entry), tally);
    into(byRole, entry.role, tally);
    into(byTrigger, turn ? (causes.get(turn) ?? triggerOf(entry)) : triggerOf(entry), tally);
    into(bySession, entry.who, () => ({ ...tally(), role: entry.role, ...(space ? { space } : {}) }));
    if (entry.role === "worker") into(byTask, entry.task ?? entry.who, () => ({ ...tally(), ...(space ? { space } : {}) }));
    if (entry.priced === false) unpriced += 1;
    if (entry.model && entry.usage) {
      const parts = partsOf(entry.model, entry.usage);
      for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) {
        tokens[key] += parts.tokens[key];
        dollars[key] += parts.dollars[key];
      }
    }
  }

  const sum = dollars.input + dollars.cacheRead + dollars.cacheWrite + dollars.output;
  const record = <T extends Tally, U>(map: Map<string, T>, extra: (from: T) => U) =>
    Object.fromEntries([...map.entries()].sort((a, b) => b[1].dollars - a[1].dollars).map(([key, from]) => [key, { ...bucket(from), ...extra(from) }]));
  const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

  const lanes = record(byLane, () => ({}));
  const perUnit: PerUnit | undefined =
    units !== undefined && units > 0
      ? {
          units,
          dollars: round(total.dollars / units),
          tokens: Math.round(total.tokens / units),
          byLane: Object.fromEntries(Object.entries(lanes).map(([lane, row]) => [lane, { dollars: round(row.dollars / units), tokens: Math.round(row.tokens / units) }])),
        }
      : undefined;

  return {
    ...(query.space !== undefined ? { space: query.space } : {}),
    ...(query.lane !== undefined ? { lane: query.lane } : {}),
    ...(query.since !== undefined ? { since: iso(query.since) } : {}),
    ...(query.until !== undefined ? { until: iso(query.until) } : {}),
    ...(first !== undefined ? { first: iso(first), last: iso(last) } : {}),
    total: bucket(total),
    byLane: lanes,
    byRole: record(byRole, () => ({})),
    byTrigger: record(byTrigger, () => ({})),
    bySession: record(bySession, (from) => ({ role: from.role, ...(from.space ? { space: from.space } : {}) })),
    byTask: record(byTask, (from) => (from.space ? { space: from.space } : {})),
    cache: {
      tokens,
      dollars: { input: round(dollars.input), cacheRead: round(dollars.cacheRead), cacheWrite: round(dollars.cacheWrite), output: round(dollars.output) },
      readShare: sum > 0 ? round(dollars.cacheRead / sum, 4) : 0,
      writeShare: sum > 0 ? round(dollars.cacheWrite / sum, 4) : 0,
    },
    unpriced,
    ...(query.space !== undefined && leadOutside.calls > 0 ? { leadOutside: bucket(leadOutside) } : {}),
    ...(perUnit ? { perUnit } : {}),
  };
}

// --- the words -------------------------------------------------------------------

const money = (value: number) => `$${value.toFixed(value < 10 ? 3 : 2)}`;
const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "-");
const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString("sv-SE").slice(0, 16) : "");
/** 1234567 as 1.23M: a turn's tokens run to millions. */
const count = (value: number) => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 10_000 ? `${(value / 1_000).toFixed(1)}k` : String(value));

/** What a lane's dollars are. */
export const LANE_WORDS: Record<LaneName, string> = { api: "api (billed on the key)", subscription: "subscription (API-price equivalent)" };

function table(title: string, rows: Record<string, Bucket & { role?: string; space?: string }>, whole: number, label = (key: string) => key): string[] {
  const keys = Object.keys(rows);
  if (keys.length === 0) return [];
  const width = Math.max(title.length, ...keys.map((key) => label(key).length));
  const head = `${title.padEnd(width)}  ${"dollars".padStart(9)}  ${"share".padStart(5)}  ${"calls".padStart(6)}  ${"turns".padStart(5)}  ${"$/turn".padStart(7)}  ${"tokens".padStart(8)}`;
  return [
    head,
    ...keys.map((key) => {
      const row = rows[key]!;
      const perTurn = row.turns > 0 ? money(row.dollars / row.turns) : "-";
      return `${label(key).padEnd(width)}  ${money(row.dollars).padStart(9)}  ${percent(row.dollars, whole).padStart(5)}  ${String(row.calls).padStart(6)}  ${String(row.turns).padStart(5)}  ${perTurn.padStart(7)}  ${count(row.tokens).padStart(8)}`;
    }),
    "",
  ];
}

export function formatCost(report: CostReport, limit = 15): string {
  const whole = report.total.dollars;
  const window = [report.since ? `from ${when(report.since)}` : "", report.until ? `to ${when(report.until)}` : ""].filter(Boolean).join(" ");
  const source = report.lane === "api" ? "API ledger" : report.lane === "subscription" ? "Subscription usage" : "Model use, both lanes";
  const lines = [`${source}${report.space ? `, Space ${report.space}` : ""}${window ? `, ${window}` : ""}`];
  if (report.total.calls === 0) return `${lines[0]}\nNo requests in it.\n`;
  const kind = report.lane === "subscription" ? " (API-price equivalent)" : report.lane === "api" ? "" : " at API prices";
  lines.push(`${money(whole)}${kind} in ${report.total.calls} requests and ${report.total.turns} turns, ${count(report.total.tokens)} tokens, ${when(report.first)} to ${when(report.last)}`);
  if (!report.lane && report.byLane.subscription) lines.push("Subscription dollars are what the same tokens would cost on the API key, not money spent.");
  lines.push("");
  lines.push(...table("By lane", report.byLane, whole, (key) => LANE_WORDS[key as LaneName] ?? key));
  lines.push(...table("By role", report.byRole, whole));
  lines.push(...table("What woke the turn", report.byTrigger, whole));
  const sessions = Object.fromEntries(Object.entries(report.bySession).slice(0, limit));
  lines.push(...table(`By session (top ${Object.keys(sessions).length} of ${Object.keys(report.bySession).length})`, sessions, whole, (key) => `${key} (${report.bySession[key]!.role})`));
  const tasks = Object.fromEntries(Object.entries(report.byTask).slice(0, limit));
  lines.push(...table(`Worker tasks (top ${Object.keys(tasks).length} of ${Object.keys(report.byTask).length})`, tasks, whole));
  const cache = report.cache;
  const inputTokens = cache.tokens.input + cache.tokens.cacheRead + cache.tokens.cacheWrite;
  lines.push(
    `Context: cache reads ${percent(cache.readShare, 1)} of the dollars (${percent(cache.tokens.cacheRead, inputTokens)} of input tokens), cache writes ${percent(cache.writeShare, 1)} (${percent(cache.tokens.cacheWrite, inputTokens)}), output ${percent(cache.dollars.output, cache.dollars.input + cache.dollars.cacheRead + cache.dollars.cacheWrite + cache.dollars.output)}.`,
  );
  if (report.perUnit) {
    const unit = report.perUnit;
    lines.push(`Per unit (${unit.units} units): ${money(unit.dollars)}${kind} and ${count(unit.tokens)} tokens.`);
    for (const [lane, row] of Object.entries(unit.byLane)) lines.push(`  ${LANE_WORDS[lane as LaneName] ?? lane}: ${money(row.dollars)} and ${count(row.tokens)} tokens per unit.`);
  }
  const unknown = report.byTrigger.unknown;
  if (unknown) lines.push(`${unknown.calls} request(s) have no known cause (written before the trigger field, or woken by nothing the agent typed): they count in no turn.`);
  if (report.unpriced > 0) lines.push(`${report.unpriced} line(s) were on a model with no price here, charged as the dearest.`);
  if (report.leadOutside) lines.push(`Not counted: the Lead's requests in this window that named no Space, ${money(report.leadOutside.dollars)} in ${report.leadOutside.calls} requests and ${report.leadOutside.turns} turns.`);
  return `${lines.join("\n")}\n`;
}

// --- the export ------------------------------------------------------------------

export const CSV_COLUMNS = [
  "at",
  "lane",
  "dollars_kind",
  "role",
  "who",
  "project",
  "space",
  "task",
  "trigger",
  "trigger_at",
  "routine_light",
  "model",
  "requests",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "dollars",
] as const;

const cell = (value: unknown): string => {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The lines a report counts, one CSV row each, for a spreadsheet of the run. */
export function costCsv(entries: readonly LedgerEntry[], query: CostQuery, spaceOf: (project: string) => string | null): string {
  const rows = selectEntries(entries, query, spaceOf).map((entry) => {
    const lane = laneOf(entry);
    const usage = entry.usage ?? {};
    const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      at: new Date(entry.at).toISOString(),
      lane,
      dollars_kind: lane === "api" ? "billed" : "api_price_equivalent",
      role: entry.role,
      who: entry.who,
      project: entry.project ?? (entry.role === "foreman" ? foremanProject(entry.who) : entry.role === "worker" ? workerProject(entry.who) : ""),
      space: spaceOfLine(entry, spaceOf),
      task: entry.task,
      trigger: triggerOf(entry),
      trigger_at: typeof entry.triggerAt === "number" ? new Date(entry.triggerAt).toISOString() : "",
      routine_light: entry.routineLight ? "true" : "",
      model: entry.model,
      requests: typeof entry.requests === "number" ? entry.requests : 1,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      dollars: entry.dollars,
    };
    return CSV_COLUMNS.map((column) => cell(values[column])).join(",");
  });
  return `${[CSV_COLUMNS.join(","), ...rows].join("\n")}\n`;
}

// --- the command -----------------------------------------------------------------

export const COST_USAGE = "Use: cobra-agent cost [--space <id>] [--since <YYYY-MM-DD or time>] [--until <…>] [--lane subscription|api|all] [--unit <n>] [--csv <file>] [--json]";

export type CostDeps = {
  entries: () => LedgerEntry[];
  spaceOf: (project: string) => string | null;
  out: (text: string) => void;
  /** Writes `--csv`'s file. */
  write?: (path: string, text: string) => void;
};

/** `cobra-agent cost …`: the report, or the reason it cannot be made. */
export function costCommand(args: readonly string[], deps: CostDeps): string | null {
  const query: CostQuery = {};
  let json = false;
  let csv: string | undefined;
  let units: number | undefined;
  for (let at = 0; at < args.length; at += 1) {
    const flag = args[at];
    if (flag === "--json") {
      json = true;
      continue;
    }
    const value = args[at + 1];
    if (!["--space", "--since", "--until", "--lane", "--unit", "--csv"].includes(flag ?? "") || value === undefined || value.startsWith("--")) return COST_USAGE;
    at += 1;
    if (flag === "--space") query.space = value;
    else if (flag === "--lane") {
      if (value === "all") delete query.lane;
      else if ((LANES as readonly string[]).includes(value)) query.lane = value as LaneName;
      else return `--lane ${value} is not subscription, api or all`;
    } else if (flag === "--unit") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return `--unit ${value} is not a number of units above 0`;
      units = n;
    } else if (flag === "--csv") csv = value;
    else {
      const ms = parseWhen(value, flag === "--until");
      if (ms === null) return `${flag} ${value} is not a day (2026-11-04) or a time (2026-11-04T15:17)`;
      if (flag === "--since") query.since = ms;
      else query.until = ms;
    }
  }
  const entries = deps.entries();
  if (csv !== undefined) {
    try {
      (deps.write ?? ((path: string, text: string) => writeFileSync(path, text, { mode: 0o600 })))(csv, costCsv(entries, query, deps.spaceOf));
    } catch (caught) {
      return `--csv ${csv}: ${caught instanceof Error ? caught.message : String(caught)}`;
    }
  }
  const report = costReport(entries, query, deps.spaceOf, units);
  deps.out(json ? `${JSON.stringify(report, null, 2)}\n` : formatCost(report));
  return null;
}

/** The live command: this computer's ledgers and org. */
export function runCostCommand(args: readonly string[], fail: (message: string) => never): void {
  const problem = costCommand(args, { entries: () => readLedgers(), spaceOf: liveSpaceOf(), out: (text) => process.stdout.write(text) });
  if (problem) fail(problem);
}
