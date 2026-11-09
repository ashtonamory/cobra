import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { alertText, markSent, newThresholds } from "./apiAlerts.ts";
import { keyCheckProblem, laneChange } from "./apiLaneCli.ts";
import { apiAccount, apiPressureOf, interactiveClaudeCode, LaneRouter, laneState, monthOf, nextMonthStart, readApiLane, type LaneFacts } from "./apiLane.ts";
import { SpendBook } from "./apiSpend.ts";
import { modelAllowed, parsePolicy } from "./permissions.ts";
import { acceptable, describeChange } from "./policyEdit.ts";
import { heldBy, pressures, spends, type Pressure } from "./queue.ts";
import { modelName, parseModel } from "./workers.ts";

const NOW = new Date(2026, 9, 13, 12, 0, 0).getTime();
const facts = (over: Partial<LaneFacts> = {}): LaneFacts => ({
  policy: { enabled: true, monthlyCapUsd: 50 },
  key: true,
  spentUsd: 10,
  month: monthOf(NOW),
  ...over,
});

test("the lane is open only when it is on, a key is here, a cap is set and not used", () => {
  assert.deepEqual(laneState(facts()), { open: true, why: "" });
  assert.match(laneState(facts({ policy: { enabled: false, monthlyCapUsd: 50 } })).why, /off/);
  assert.match(laneState(facts({ key: false })).why, /no API key/);
  assert.match(laneState(facts({ policy: { enabled: true, monthlyCapUsd: 0 } })).why, /no monthly cap/);
  assert.match(laneState(facts({ spentUsd: 50 })).why, /\$50\.00 is used/);
});

test("policy.json's apiLane is read strictly: anything odd is off, the cap kept in range", () => {
  assert.equal(readApiLane(undefined), undefined);
  assert.deepEqual(readApiLane({ enabled: "yes", monthlyCapUsd: 20 }), { enabled: false, monthlyCapUsd: 20 });
  assert.deepEqual(readApiLane({ enabled: true, monthlyCapUsd: -5 }), { enabled: true, monthlyCapUsd: 0 });
  assert.deepEqual(readApiLane({ enabled: true, monthlyCapUsd: 1e9 }), { enabled: true, monthlyCapUsd: 100_000 });
  assert.deepEqual(readApiLane({ enabled: true, monthlyCapUsd: 12.345 }), { enabled: true, monthlyCapUsd: 12.35 });
  const policy = parsePolicy(JSON.stringify({ version: 1, revision: 3, apiLane: { enabled: true, monthlyCapUsd: 50 } })).policy;
  assert.deepEqual(policy.apiLane, { enabled: true, monthlyCapUsd: 50 });
  assert.equal(parsePolicy(JSON.stringify({ version: 1, revision: 3 })).policy.apiLane, undefined);
});

test("the lane's budget line: tight from 80%, held at the cap, absent while off", () => {
  const ok = apiPressureOf(facts(), NOW);
  assert.equal(ok?.state, "ok");
  assert.equal(ok?.label, "$10.00 of $50.00 this month");
  assert.equal(ok?.resetsAt, new Date(nextMonthStart(NOW)).toISOString());
  assert.equal(apiPressureOf(facts({ spentUsd: 41 }), NOW)?.state, "tight");
  assert.equal(apiPressureOf(facts({ spentUsd: 50 }), NOW)?.state, "hold");
  assert.equal(apiPressureOf(facts({ policy: { enabled: false, monthlyCapUsd: 50 } }), NOW), null);
  assert.equal(apiPressureOf(facts({ key: false }), NOW), null);
  assert.equal(nextMonthStart(new Date(2026, 11, 31).getTime()), new Date(2027, 0, 1).getTime());
});

test("the router: the subscription first, the key at HOLD, and a moved session stays until the reset", () => {
  let open = true;
  const router = new LaneRouter(() => open);
  const worker = { who: "w1", role: "worker", explicit: false };
  assert.equal(router.decide(worker, "w1/s", NOW), "subscription", "no windows known yet");
  router.noteLimits({ at: NOW, fiveHour: { utilization: 0.5, reset: NOW + 3_600_000 } });
  assert.equal(router.decide(worker, "w1/s", NOW), "subscription");
  router.noteLimits({ at: NOW, fiveHour: { utilization: 0.96, reset: NOW + 3_600_000 } });
  assert.equal(router.decide(worker, "w1/s", NOW), "api", "at HOLD");
  router.noteLimits({ at: NOW, fiveHour: { utilization: 0.1, reset: NOW + 7_200_000 } });
  assert.equal(router.decide(worker, "w1/s", NOW + 60_000), "api", "a moved session stays on the key until that window's reset");
  assert.equal(router.decide(worker, "w1/s", NOW + 3_600_001), "subscription", "and comes back after it");
  assert.equal(router.decide(worker, "w2/s", NOW), "subscription", "another session never moved");
  router.refused("w2/s", NOW);
  assert.equal(router.decide(worker, "w2/s", NOW + 1), "api", "a refusal moves it too");
  assert.equal(router.decide({ ...worker, explicit: true }, "w3/s", NOW), "api", "started on the key");
  open = false;
  assert.equal(router.decide({ ...worker, explicit: true }, "w3/s", NOW), "subscription", "a closed lane sends everything to the subscription");
  assert.equal(router.decide(worker, "w2/s", NOW + 1), "subscription");
  assert.equal(router.canOverflow(), false);
});

test("the spend book: the month's totals by role and caller, a new month from nothing, the fleet's estimate", () => {
  const dir = mkdtempSync(join(tmpdir(), "api-spend-"));
  try {
    let now = NOW;
    const paths = { ledger: join(dir, "ledger.jsonl"), spend: join(dir, "spend.json"), fleet: join(dir, "fleet.json") };
    const book = new SpendBook(paths, () => now);
    book.record({ at: now, who: "w1", role: "worker", model: "claude-opus-5-5", usage: {}, dollars: 0.5, priced: true });
    book.record({ at: now, who: "cobra_lead", role: "lead", model: "claude-opus-5-5", usage: {}, dollars: 0.25, priced: true });
    book.record({ at: now, who: "w1", role: "worker", model: "claude-opus-5-5", usage: {}, dollars: 0.25, priced: true });
    assert.deepEqual(book.month().byRole, { worker: 0.75, lead: 0.25 });
    assert.equal(book.month().requests, 3);
    assert.equal(readFileSync(paths.ledger, "utf8").trim().split("\n").length, 3);
    assert.equal(new SpendBook(paths, () => now).month().dollars, 1, "the totals survive a restart");
    book.noteFleet({ month: monthOf(now), others: 4, at: now, from: "legion" });
    assert.equal(book.fleetEstimate(), 5);
    now = new Date(2026, 10, 1, 0, 1).getTime();
    assert.equal(book.month().dollars, 0, "a new month starts from nothing");
    assert.equal(book.fleetEstimate(), 0, "last month's fleet total is not this month's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a change to the lane is said in words; turning it on or raising the cap grants more", () => {
  const before = parsePolicy(JSON.stringify({ version: 1, revision: 1, preset: "balanced" })).policy;
  const on = { ...before, revision: 2, apiLane: { enabled: true, monthlyCapUsd: 50 } };
  const lines = describeChange(before, on);
  assert.ok(lines.some((line) => line.widens && /may spend API credits/.test(line.text)));
  assert.ok(lines.some((line) => line.widens && /capped at \$50\.00 a month \(was \$0\.00\)/.test(line.text)));
  const lower = describeChange(on, { ...on, revision: 3, apiLane: { enabled: true, monthlyCapUsd: 20 } });
  assert.deepEqual(lower.map((line) => line.widens), [false]);
  assert.deepEqual(describeChange(on, { ...on, revision: 3, apiLane: { enabled: false, monthlyCapUsd: 50 } }).map((line) => [line.text, line.widens]), [["the fleet: no longer spends API credits", false]]);
  assert.equal(laneChange(on, { enabled: true, monthlyCapUsd: 50 }).lines.length, 0, "nothing to change");
});

test("an app from before the lane cannot turn it off by leaving it out of what it sends", () => {
  const current = parsePolicy(JSON.stringify({ version: 1, revision: 4, apiLane: { enabled: true, monthlyCapUsd: 50 } })).policy;
  const old = acceptable({ version: 1, revision: 5, preset: "auto" }, current);
  assert.ok("policy" in old);
  assert.deepEqual(old.policy.apiLane, { enabled: true, monthlyCapUsd: 50 });
  const off = acceptable({ version: 1, revision: 5, apiLane: { enabled: false, monthlyCapUsd: 50 } }, current);
  assert.ok("policy" in off);
  assert.equal(off.policy.apiLane?.enabled, false);
});

test("API test mode: turning it on grants more; an app from before it keeps a test running; the cap push says the test stopped", () => {
  const lane = { version: 1, revision: 4, apiLane: { enabled: true, monthlyCapUsd: 50 } };
  const current = parsePolicy(JSON.stringify(lane)).policy;
  const on = parsePolicy(JSON.stringify({ ...lane, revision: 5, apiLane: { enabled: true, monthlyCapUsd: 50, testMode: true } })).policy;
  assert.equal(on.apiLane?.testMode, true);
  assert.deepEqual(describeChange(current, on).map((line) => line.widens), [true]);
  assert.match(describeChange(current, on)[0]!.text, /API test mode on/);
  assert.deepEqual(describeChange(on, current).map((line) => line.widens), [false]);
  const older = acceptable({ version: 1, revision: 6, apiLane: { enabled: true, monthlyCapUsd: 80 } }, on);
  assert.ok("policy" in older);
  assert.deepEqual(older.policy.apiLane, { enabled: true, monthlyCapUsd: 80, testMode: true });
  const off = acceptable({ version: 1, revision: 6, apiLane: { enabled: true, monthlyCapUsd: 50, testMode: false } }, on);
  assert.ok("policy" in off);
  assert.equal(off.policy.apiLane?.testMode, undefined);
  const laneOff = acceptable({ version: 1, revision: 6, apiLane: { enabled: false, monthlyCapUsd: 50 } }, on);
  assert.ok("policy" in laneOff);
  assert.equal(laneOff.policy.apiLane?.testMode, undefined, "the lane off ends the test");
  assert.equal(alertText(100, 50, 50, new Date("2026-11-01"), true).title, "API test stopped");
  assert.equal(alertText(100, 50, 50, new Date("2026-11-01")).title, "API credits used up");
});

test("Workers on the key: api models parse, are named, and are allowed by api:*", () => {
  assert.deepEqual(parseModel("api"), { kind: "claude", onKey: true });
  assert.deepEqual(parseModel("api:opus"), { kind: "claude", alias: "opus", onKey: true });
  assert.throws(() => parseModel("api:gpt-5"), /not a model a Worker can use/);
  assert.equal(modelName(parseModel("api:sonnet")), "api:sonnet");
  assert.equal(modelName(parseModel("api")), "api");
  assert.equal(modelName(parseModel("opus")), "opus");
  assert.equal(modelAllowed("api:opus", ["api:*"]), true);
  assert.equal(modelAllowed("api", ["api:*"]), true);
  assert.equal(modelAllowed("api:opus", ["claude", "opus"]), false);
  assert.equal(spends("api:haiku"), "api");
  assert.equal(spends("sonnet"), "claude");
});

test("the queue: at the subscription's HOLD a Claude Worker waits only while the lane cannot take it", () => {
  const reset = new Date(NOW + 3_600_000).toISOString();
  const claudeHold: Pressure = { id: "claude", percent: 0.97, label: "5h", resetsAt: reset, state: "hold" };
  const laneOk = apiPressureOf(facts(), NOW)!;
  const laneFull = apiPressureOf(facts({ spentUsd: 50 }), NOW)!;
  assert.equal(heldBy("opus", [claudeHold], NOW), claudeHold, "no lane: waits as before");
  assert.equal(heldBy("opus", [claudeHold, laneOk], NOW), null, "the lane takes it");
  assert.equal(heldBy("opus", [claudeHold, laneFull], NOW), claudeHold, "the cap is used: waits");
  assert.equal(heldBy("api:opus", [laneFull], NOW), null, "on the key with the cap used: the subscription takes it");
  assert.equal(heldBy("api:opus", [claudeHold, laneFull], NOW), claudeHold, "neither can");
  assert.equal(heldBy("local:qwen", [claudeHold], NOW), null);
  assert.deepEqual(pressures([], laneOk).map((pressure) => pressure.id), ["api"]);
  assert.deepEqual(pressures([]), [], "no running gateway: no lane line");
});

test("the cap's pushes: each threshold once a month, the highest one when several are crossed at once", () => {
  assert.deepEqual(newThresholds(10, 50, null, "2026-10"), []);
  assert.deepEqual(newThresholds(41, 50, null, "2026-10"), [50, 80]);
  const state = markSent(null, "2026-10", [50, 80]);
  assert.deepEqual(newThresholds(45, 50, state, "2026-10"), []);
  assert.deepEqual(newThresholds(50, 50, state, "2026-10"), [100]);
  assert.deepEqual(newThresholds(30, 50, state, "2026-11"), [50], "a new month pushes again");
  assert.deepEqual(newThresholds(30, 0, null, "2026-10"), [], "no cap, no push");
  assert.match(alertText(100, 50, 50, new Date(2026, 10, 1)).body, /Raise the cap in Settings → Claude/);
  assert.equal(alertText(80, 40, 50, new Date(2026, 10, 1)).title, "API credits at 80%");
});

test("the key check says what Anthropic's answer means", () => {
  assert.equal(keyCheckProblem(200, "{}"), null);
  assert.equal(keyCheckProblem(400, '{"error":{"message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header"}}')?.needsWorkspace, true);
  assert.match(keyCheckProblem(401, "")?.problem ?? "", /refused this key/);
  assert.match(keyCheckProblem(500, '{"error":{"message":"overloaded"}}')?.problem ?? "", /500: overloaded/);
});

test("the API lane names its key by its last four characters only, and the workspace when set", () => {
  assert.equal(apiAccount("sk-ant-api03-secretpart-wxyz"), "key …wxyz");
  assert.equal(apiAccount("sk-ant-api03-secretpart-wxyz", "wrkspc_01ABC"), "key …wxyz · wrkspc_01ABC");
  assert.equal(apiAccount(null), undefined);
  assert.equal(apiPressureOf({ ...facts(), account: "key …wxyz" }, NOW)?.account, "key …wxyz");
});

test("interactive Claude Code is told apart from claude -p and the SDKs by its User-Agent", () => {
  assert.equal(interactiveClaudeCode("claude-cli/2.1.296 (external, cli)"), true);
  assert.equal(interactiveClaudeCode("claude-cli/2.1.296 (external, claude-vscode)"), true);
  assert.equal(interactiveClaudeCode(["claude-cli/2.1.296 (external, cli, agent-sdk/1.0)"]), true);
  assert.equal(interactiveClaudeCode("claude-cli/2.1.296 (external, sdk-cli)"), false);
  assert.equal(interactiveClaudeCode("claude-cli/2.1.296 (external, sdk-ts)"), false);
  assert.equal(interactiveClaudeCode("curl/8.9.0"), false);
  assert.equal(interactiveClaudeCode(undefined), false);
});
