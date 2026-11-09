import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { SpendEntry } from "./apiSpend.ts";
import { costCommand, costReport, CSV_COLUMNS, formatCost, parseWhen, readLedger, readLedgers, type CostReport, type LedgerEntry } from "./costReport.ts";

const spaces: Record<string, string> = { "northwind-crm": "northwind", "northwind-northwind-prospecting": "northwind" };
const spaceOf = (project: string) => spaces[project] ?? null;

/** Sonnet 5.5: $2 in, $0.20 a cache read, $4 a one-hour cache write, $10 out, per million. */
const usage = { input_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 1_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000 }, output_tokens: 500 };

const line = (at: number, who: string, role: string, dollars: number, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ at, who, role, model: "claude-sonnet-5-5", usage, dollars, priced: true, ...extra });

const LEDGER: SpendEntry[] = [
  // Written before the trigger fields: unknown, in no turn; a Foreman's Space still from its name.
  line(1_000, "northwind-crm_fm", "foreman", 0.5),
  line(1_500, "northwind-northwind-prospecting_3", "worker", 0.05),
  // The person asks Cobra; her turn names no Space.
  line(10_000, "cobra_lead", "lead", 0.3, { trigger: "person", triggerAt: 9_000 }),
  line(11_000, "cobra_lead", "lead", 0.2, { trigger: "self", triggerAt: 9_000 }),
  // A brief wakes the CRM Foreman: two requests, one turn.
  line(12_000, "northwind-crm_fm", "foreman", 0.1, { trigger: "brief", triggerAt: 11_500, space: "northwind" }),
  line(13_000, "northwind-crm_fm", "foreman", 0.1, { trigger: "self", triggerAt: 11_500, space: "northwind" }),
  // A Worker of its own.
  line(14_000, "northwind-northwind-prospecting_9", "worker", 0.02, { trigger: "spawn", task: "northwind-northwind-prospecting_9", space: "northwind" }),
  line(15_000, "northwind-northwind-prospecting_9", "worker", 0.02, { trigger: "spawn", task: "northwind-northwind-prospecting_9", space: "northwind" }),
  // Its finish wakes the Foreman, and the Foreman's wakes the Lead about Northwind.
  line(16_000, "northwind-crm_fm", "foreman", 0.04, { trigger: "event", triggerAt: 15_500, space: "northwind" }),
  line(17_000, "cobra_lead", "lead", 0.06, { trigger: "event", triggerAt: 16_500, space: "northwind" }),
  // Another Space altogether.
  line(18_000, "example-com-crm_fm", "foreman", 1, { trigger: "routine", triggerAt: 17_500, space: "example-com" }),
];

test("the report: by role, by what woke the turn, by session and task; a turn is one cause's requests", () => {
  const report = costReport(LEDGER, {}, spaceOf);
  assert.equal(report.total.calls, 11);
  assert.equal(report.total.dollars, 2.39);
  // Turns: Lead person, Lead event, Foreman brief, Foreman event, Worker 3 (spawn), Worker 9 (spawn), Rivera routine.
  assert.equal(report.total.turns, 7);
  assert.deepEqual(report.byRole.lead, { dollars: 0.56, calls: 3, turns: 2, tokens: 304530 });
  assert.deepEqual(report.byRole.foreman, { dollars: 1.74, calls: 5, turns: 3, tokens: 507550 }, "the old line counts in no turn");
  assert.deepEqual(report.byRole.worker, { dollars: 0.09, calls: 3, turns: 2, tokens: 304530 }, "an old Worker line is still its spawn");
  // A self request counts with what woke its turn.
  assert.deepEqual(report.byTrigger.person, { dollars: 0.5, calls: 2, turns: 1, tokens: 203020 });
  assert.deepEqual(report.byTrigger.brief, { dollars: 0.2, calls: 2, turns: 1, tokens: 203020 });
  assert.deepEqual(report.byTrigger.event, { dollars: 0.1, calls: 2, turns: 2, tokens: 203020 });
  assert.deepEqual(report.byTrigger.unknown, { dollars: 0.5, calls: 1, turns: 0, tokens: 101510 });
  assert.equal(report.byTrigger.self, undefined);
  assert.deepEqual(report.bySession["northwind-crm_fm"], { dollars: 0.74, calls: 4, turns: 2, tokens: 406040, role: "foreman", space: "northwind" });
  assert.deepEqual(report.byTask["northwind-northwind-prospecting_9"], { dollars: 0.04, calls: 2, turns: 1, tokens: 203020, space: "northwind" });
  assert.deepEqual(Object.keys(report.bySession)[0], "example-com-crm_fm", "dearest first");
});

test("context's share: cache reads and writes at the ledger's prices", () => {
  const report = costReport([line(1, "a_fm", "foreman", 0.03)], {}, spaceOf);
  assert.deepEqual(report.cache.tokens, { input: 10, cacheRead: 100_000, cacheWrite: 1_000, output: 500 });
  // 100k reads at $0.20 = $0.02; 1k one-hour writes at 2 x $2 = $0.004; 500 out at $10 = $0.005; 10 in = $0.00002.
  assert.deepEqual(report.cache.dollars, { input: 0.00002, cacheRead: 0.02, cacheWrite: 0.004, output: 0.005 });
  assert.equal(report.cache.readShare, 0.6892);
  assert.equal(report.cache.writeShare, 0.1378);
});

test("--space keeps that Space's work, and says what the Lead spent naming no Space", () => {
  const report = costReport(LEDGER, { space: "northwind" }, spaceOf);
  // Its older lines too: a Foreman's and a Worker's Space from their names.
  assert.equal(report.total.calls, 8);
  assert.equal(report.total.dollars, 0.89);
  assert.deepEqual(report.byRole.lead, { dollars: 0.06, calls: 1, turns: 1, tokens: 101510 });
  assert.deepEqual(report.leadOutside, { dollars: 0.5, calls: 2, turns: 1, tokens: 203020 });
  assert.equal(report.bySession["example-com-crm_fm"], undefined);
});

test("--since and --until: a day is local midnight, an until-day the whole day, a time as given", () => {
  assert.equal(parseWhen("2026-11-04", false), new Date(2026, 10, 4).getTime());
  assert.equal(parseWhen("2026-11-04", true), new Date(2026, 10, 5).getTime());
  assert.equal(parseWhen("2026-11-04T15:17", false), new Date(2026, 10, 4, 15, 17).getTime());
  assert.equal(parseWhen("2026-11-04T19:17:00Z", false), Date.UTC(2026, 10, 4, 19, 17));
  assert.equal(parseWhen("last tuesday", false), null);
  const window = costReport(LEDGER, { since: 12_000, until: 16_000 }, spaceOf);
  assert.equal(window.total.calls, 4);
  // The window starts mid-turn of nothing; the Foreman's turn from 11 500 is whole inside it.
  assert.deepEqual(window.byTrigger.brief, { dollars: 0.2, calls: 2, turns: 1, tokens: 203020 });
});

test("a turn cut by the window still names its cause from the line it has", () => {
  const report = costReport(LEDGER, { since: 11_000, until: 11_001 }, spaceOf);
  assert.deepEqual(report.byTrigger, { self: { dollars: 0.2, calls: 1, turns: 1, tokens: 101510 } });
});

test("the ledger file and the one moved aside are read together, in time order; a bad line is skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "cost-report-"));
  try {
    const path = join(dir, "api-ledger.jsonl");
    writeFileSync(`${path}.1`, `${JSON.stringify(LEDGER[0])}\n`);
    writeFileSync(path, `${JSON.stringify(LEDGER[2])}\nnot json\n{"at":"x"}\n${JSON.stringify(LEDGER[1])}\n{"at":5,"who":"half`);
    const read = readLedger(path);
    assert.deepEqual(
      read.map((entry) => entry.at),
      [1_000, 1_500, 10_000],
    );
    assert.deepEqual(readLedger(join(dir, "none.jsonl")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cobra-agent cost: flags, the words and --json", () => {
  const out: string[] = [];
  const deps = { entries: () => LEDGER, spaceOf, out: (text: string) => void out.push(text) };
  assert.equal(costCommand(["--space", "northwind", "--json"], deps), null);
  const parsed = JSON.parse(out.pop()!) as { total: { calls: number }; space: string };
  assert.deepEqual([parsed.space, parsed.total.calls], ["northwind", 8]);

  assert.equal(costCommand(["--space", "northwind"], deps), null);
  const words = out.pop()!;
  assert.match(words, /^Model use, both lanes, Space northwind/);
  assert.match(words, /What woke the turn/);
  assert.match(words, /northwind-crm_fm \(foreman\)/);
  assert.match(words, /Not counted: the Lead's requests in this window that named no Space, \$0\.500 in 2 requests and 1 turns/);

  assert.match(costCommand(["--space"], deps) ?? "", /^Use: cobra-agent cost/);
  assert.match(costCommand(["--when", "x"], deps) ?? "", /^Use:/);
  assert.match(costCommand(["--since", "soon"], deps) ?? "", /is not a day/);
  assert.equal(out.length, 0, "a refused command prints no report");
});

test("an empty window says so", () => {
  assert.match(formatCost(costReport([], { space: "none" }, spaceOf)), /No requests in it/);
});

// --- B0b: the subscription lane ------------------------------------------------------

/** A usage-ledger line (usageLedger.ts): one turn's requests on the subscription, at API prices. */
const sub = (at: number, who: string, role: string, dollars: number, requests: number, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  ...line(at, who, role, dollars, extra),
  lane: "subscription",
  requests,
});

const BOTH: LedgerEntry[] = [
  line(10_000, "cobra_lead", "lead", 0.3, { trigger: "person", triggerAt: 9_000, lane: "api" }),
  sub(20_000, "cobra_lead", "lead", 0.5, 4, { trigger: "event", triggerAt: 19_000, space: "northwind" }),
  sub(21_000, "northwind-crm_fm", "foreman", 0.2, 3, { trigger: "brief", triggerAt: 20_500, space: "northwind", project: "northwind-crm" }),
  sub(22_000, "northwind-northwind-prospecting_9", "worker", 0.1, 2, { trigger: "spawn", task: "northwind-northwind-prospecting_9", space: "northwind", routineLight: true }),
];

test("both lanes: the report sums per lane and per role, a usage line counting its requests and tokens", () => {
  const report = costReport(BOTH, {}, spaceOf);
  assert.deepEqual(report.byLane.api, { dollars: 0.3, calls: 1, turns: 1, tokens: 101_510 });
  assert.deepEqual(report.byLane.subscription, { dollars: 0.8, calls: 9, turns: 3, tokens: 3 * 101_510 });
  assert.deepEqual(report.byRole.lead, { dollars: 0.8, calls: 5, turns: 2, tokens: 2 * 101_510 });
  assert.deepEqual(report.byRole.worker, { dollars: 0.1, calls: 2, turns: 1, tokens: 101_510 });
  const words = formatCost(report);
  assert.match(words, /^Model use, both lanes/);
  assert.match(words, /\$1\.100 at API prices in 10 requests and 4 turns/);
  assert.match(words, /subscription \(API-price equivalent\)\s+\$0\.800/);
  assert.match(words, /api \(billed on the key\)\s+\$0\.300/);
  assert.match(words, /not money spent/);
});

test("--lane keeps one lane; --unit adds cost and tokens per unit", () => {
  const out: string[] = [];
  const deps = { entries: () => BOTH, spaceOf, out: (text: string) => void out.push(text) };
  assert.equal(costCommand(["--lane", "subscription", "--unit", "4", "--json"], deps), null);
  const report = JSON.parse(out.pop()!) as CostReport;
  assert.equal(report.lane, "subscription");
  assert.deepEqual(Object.keys(report.byLane), ["subscription"]);
  assert.equal(report.total.dollars, 0.8);
  assert.deepEqual(report.perUnit, { units: 4, dollars: 0.2, tokens: Math.round((3 * 101_510) / 4), byLane: { subscription: { dollars: 0.2, tokens: Math.round((3 * 101_510) / 4) } } });

  assert.equal(costCommand(["--lane", "subscription", "--unit", "4"], deps), null);
  const words = out.pop()!;
  assert.match(words, /^Subscription usage/);
  assert.match(words, /\$0\.800 \(API-price equivalent\)/);
  assert.match(words, /Per unit \(4 units\): \$0\.200 \(API-price equivalent\) and 76\.1k tokens/);

  assert.equal(costCommand(["--lane", "api", "--json"], deps), null);
  assert.equal((JSON.parse(out.pop()!) as CostReport).total.dollars, 0.3);
  assert.equal(costCommand(["--lane", "all", "--json"], deps), null);
  assert.equal((JSON.parse(out.pop()!) as CostReport).total.calls, 10);

  assert.match(costCommand(["--lane", "key"], deps) ?? "", /is not subscription, api or all/);
  assert.match(costCommand(["--unit", "0"], deps) ?? "", /not a number of units above 0/);
  assert.match(costCommand(["--csv"], deps) ?? "", /^Use:/);
  assert.equal(out.length, 0);
});

test("--csv: one row a ledger line in the query, with its lane and what its dollars are", () => {
  const files: Record<string, string> = {};
  const out: string[] = [];
  const deps = { entries: () => BOTH, spaceOf, out: (text: string) => void out.push(text), write: (path: string, text: string) => void (files[path] = text) };
  assert.equal(costCommand(["--space", "northwind", "--csv", "/tmp/run.csv"], deps), null);
  const rows = files["/tmp/run.csv"]!.trim().split("\n");
  assert.equal(rows[0], CSV_COLUMNS.join(","));
  assert.equal(rows.length, 4, "the header and the Space's three lines; the Lead's own turn named no Space");
  const lead = rows[1]!.split(",");
  const column = (name: (typeof CSV_COLUMNS)[number]) => CSV_COLUMNS.indexOf(name);
  assert.deepEqual([lead[column("lane")], lead[column("dollars_kind")], lead[column("role")], lead[column("trigger")], lead[column("requests")], lead[column("dollars")]], ["subscription", "api_price_equivalent", "lead", "event", "4", "0.5"]);
  const worker = rows[3]!.split(",");
  assert.deepEqual([worker[column("project")], worker[column("task")], worker[column("routine_light")], worker[column("cache_read_input_tokens")]], ["northwind-northwind-prospecting", "northwind-northwind-prospecting_9", "true", "100000"]);
  assert.equal(out.length, 1, "the report is printed too");
  const refused = costCommand(["--csv", "/x"], { ...deps, write: () => { throw new Error("EACCES"); } });
  assert.match(refused ?? "", /--csv \/x: EACCES/);
});

test("both ledgers read together, each line with its lane", () => {
  const dir = mkdtempSync(join(tmpdir(), "cost-lanes-"));
  try {
    writeFileSync(join(dir, "api.jsonl"), `${JSON.stringify(LEDGER[2])}\n`);
    writeFileSync(join(dir, "usage.jsonl"), `${JSON.stringify(BOTH[1])}\n`);
    assert.deepEqual(
      readLedgers(join(dir, "api.jsonl"), join(dir, "usage.jsonl")).map((entry) => [entry.at, entry.lane]),
      [
        [10_000, "api"],
        [20_000, "subscription"],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
