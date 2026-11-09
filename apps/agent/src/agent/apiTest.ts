import { readFileSync } from "node:fs";
import { join } from "node:path";

import { laneFactsNow, type ApiLanePolicy } from "./apiLane.ts";
import { API_LEDGER, type SpendEntry } from "./apiSpend.ts";
import { STATE_DIR } from "./paths.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";

/**
 * API test mode: one
 * fleet-wide switch, policy.json's `apiLane.testMode`, that runs the whole
 * workforce on the API key for a while, to compare it with the subscription.
 *
 * - The Lead and every Foreman run headless on the key (orchHeadless.ts),
 *   started afresh when the switch turns on and back in tmux when it turns off.
 * - Each keeps its model: the Lead and Foremen your Claude Code's default, a
 *   Worker whatever the Foreman, the brain or a plan picked, on the key
 *   (`withTestLane`). Codex and local models use no Anthropic credit, so a
 *   Worker asked for one runs on the key's default model instead.
 * - The helpers (titles, the judge, the explainer, the EA, memory_ask) and
 *   jobs are asked on the key too. Your own sessions, chats and the morning
 *   brief are yours, not the workforce, and keep your sign-in.
 * - At the cap nothing moves back to the subscription: the gateway refuses
 *   the key's callers (modelGateway.ts), new Workers wait, and you are told.
 */

export const API_TEST_PATH = join(STATE_DIR, "api-test.json");

/** Whether the lane's policy asks for test mode: on, and test mode set. */
export function testModeOf(policy: ApiLanePolicy | undefined): boolean {
  return policy?.enabled === true && policy.testMode === true;
}

/**
 * Whether test mode is on here now: the policy as the model gateway last read
 * it (every 15 s), and an API key on this computer (one without a key works
 * as before; Settings says so). Off with no gateway.
 */
export function testModeOn(): boolean {
  return testModeHere() === true;
}

/** As testModeOn, or null before the gateway's first read (at boot), when nobody knows yet. */
export function testModeHere(facts = laneFactsNow()): boolean | null {
  if (!facts) return null;
  return facts.key && testModeOf(facts.policy);
}

/** When the current test began, and the last one's span: kept so a test reads only its own spend. */
export type TestRecord = { since: string | null; last?: { since: string; until: string } };

export function loadTestRecord(path = API_TEST_PATH): TestRecord {
  try {
    const raw = JSON.parse(readPrivateFile(path).text ?? "null") as Partial<TestRecord> | null;
    return {
      since: typeof raw?.since === "string" ? raw.since : null,
      ...(raw?.last && typeof raw.last.since === "string" && typeof raw.last.until === "string" ? { last: { since: raw.last.since, until: raw.last.until } } : {}),
    };
  } catch {
    return { since: null };
  }
}

/** Notes the switch as it is now: a test begins when it turns on and ends when it turns off. Returns the record. */
export function noteTestMode(on: boolean, now = new Date(), path = API_TEST_PATH): TestRecord {
  const record = loadTestRecord(path);
  if (on && record.since === null) {
    const next = { ...record, since: now.toISOString() };
    writePrivateFile(path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
  if (!on && record.since !== null) {
    const next: TestRecord = { since: null, last: { since: record.since, until: now.toISOString() } };
    writePrivateFile(path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
  return record;
}

const ON_KEY: Record<string, string> = { claude: "api", opus: "api:opus", sonnet: "api:sonnet", haiku: "api:haiku" };

/**
 * A Worker's model in test mode: the same Claude model on the key; a model
 * already on the key as it is; Codex or a local model, which spend no
 * Anthropic credit, the key's default instead, with why. Outside test mode,
 * as given.
 */
export function withTestLane(model: string | undefined, on: boolean): { model: string | undefined; note?: string } {
  if (!on) return { model };
  if (model === undefined) return { model: "api" };
  if (model === "api" || model.startsWith("api:")) return { model };
  const keyed = ON_KEY[model];
  if (keyed) return { model: keyed };
  return { model: "api", note: `API test mode: ${model} spends no API credits, so this Worker runs on Claude on the key instead` };
}

/** What a test has spent so far, from the ledger: in all, and by role. */
export type TestReport = {
  since: string;
  until?: string;
  spentUsd: number;
  requests: number;
  byRole: Array<{ role: string; spentUsd: number; requests: number; inputTokens: number; outputTokens: number }>;
};

/** The ledger's lines in a span, added up by role (dearest first). */
export function testReport(entries: readonly SpendEntry[], since: string, until?: string): TestReport {
  const from = Date.parse(since);
  const to = until ? Date.parse(until) : Number.POSITIVE_INFINITY;
  const roles = new Map<string, { spentUsd: number; requests: number; inputTokens: number; outputTokens: number }>();
  let spent = 0;
  let requests = 0;
  for (const entry of entries) {
    if (!(entry.at >= from && entry.at < to)) continue;
    const row = roles.get(entry.role) ?? { spentUsd: 0, requests: 0, inputTokens: 0, outputTokens: 0 };
    const usage = entry.usage as Record<string, unknown>;
    const count = (key: string) => (typeof usage?.[key] === "number" ? (usage[key] as number) : 0);
    row.spentUsd += entry.dollars;
    row.requests += 1;
    row.inputTokens += count("input_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens");
    row.outputTokens += count("output_tokens");
    roles.set(entry.role, row);
    spent += entry.dollars;
    requests += 1;
  }
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return {
    since,
    ...(until ? { until } : {}),
    spentUsd: round(spent),
    requests,
    byRole: [...roles].map(([role, row]) => ({ role, ...row, spentUsd: round(row.spentUsd) })).sort((a, b) => b.spentUsd - a.spentUsd),
  };
}

/** The ledger's lines (this computer's), skipping any it cannot read. */
export function readLedger(path = API_LEDGER): SpendEntry[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: SpendEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as SpendEntry;
      if (typeof entry.at === "number" && typeof entry.role === "string" && typeof entry.dollars === "number") out.push(entry);
    } catch {
      // A torn line.
    }
  }
  return out;
}

/** The current test's report, or the last one's when none runs; null when there never was one. */
export function currentTestReport(record = loadTestRecord(), entries: () => readonly SpendEntry[] = readLedger): TestReport | null {
  if (record.since) return testReport(entries(), record.since);
  if (record.last) return testReport(entries(), record.last.since, record.last.until);
  return null;
}
