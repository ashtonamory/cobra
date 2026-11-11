import { test } from "node:test";
import assert from "node:assert/strict";
import type { SystemStats } from "@cobra/contracts";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AlertState,
  type Condition,
  HOLD_MISSING_MS,
  compose,
  evaluate,
  loadAlertState,
  saveAlertState,
  serializeAlertState,
  step,
} from "./alerts.ts";

/** Indexed access with a real assertion, so noUncheckedIndexedAccess stays on. */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `expected an item at index ${index}`);
  return item;
}


function condition(patch: Partial<Condition>): Condition {
  return {
    id: "disk:/",
    level: "critical",
    title: "full",
    body: "full",
    value: 0,
    fireAt: 0.9,
    clearAt: 0.85,
    sustainMs: 0,
    ...patch,
  };
}

function stats(patch: Partial<SystemStats>): SystemStats {
  return {
    host: "office",
    kernel: "7.2.5",
    uptimeSeconds: 1000,
    capturedAt: new Date().toISOString(),
    cpu: { model: "M1", threads: 4, usage: 0.1, loadavg: [0.5, 0.5, 0.5] },
    memory: {
      totalBytes: 8e9,
      availableBytes: 4e9,
      usedBytes: 4e9,
      usage: 0.5,
      swapTotalBytes: 4e9,
      swapUsedBytes: 0,
      zram: true,
    },
    disks: [],
    network: [],
    thermal: [],
    ...patch,
  };
}

test("a condition over the line fires once, not on every tick", () => {
  const state = new Map<string, AlertState>();
  const hot = [condition({ value: 0.95 })];

  assert.equal(step(state, hot, 0).length, 1, "fires on the first crossing");
  assert.equal(step(state, hot, 1000).length, 0, "silent while it stays over");
  assert.equal(step(state, hot, 2000).length, 0);
});

test("the hysteresis band holds state instead of flapping", () => {
  const state = new Map<string, AlertState>();
  step(state, [condition({ value: 0.95 })], 0);

  // 0.87 is under the firing level but over the clearing level.
  assert.equal(step(state, [condition({ value: 0.87 })], 1000).length, 0, "no clear inside the band");
  assert.equal(state.get("disk:/")?.firing, true, "still considered firing");

  const cleared = step(state, [condition({ value: 0.80 })], 2000);
  assert.equal(cleared.length, 1);
  assert.equal(at(cleared, 0).kind, "cleared");
});

test("a value that never clears properly cannot re-fire", () => {
  const state = new Map<string, AlertState>();
  step(state, [condition({ value: 0.95 })], 0);
  step(state, [condition({ value: 0.87 })], 1000);
  // Back over the line without ever having cleared: already firing, so silent.
  assert.equal(step(state, [condition({ value: 0.95 })], 2000).length, 0);
});

test("a sustain window suppresses a momentary spike", () => {
  const state = new Map<string, AlertState>();
  const spike = [condition({ id: "load", value: 9, fireAt: 4, clearAt: 2, sustainMs: 600_000 })];

  assert.equal(step(state, spike, 0).length, 0, "not yet sustained");
  assert.equal(step(state, spike, 60_000).length, 0, "still not");
  assert.equal(step(state, spike, 600_000).length, 1, "fires once the window elapses");
});

test("dropping back into the band restarts the sustain clock", () => {
  const state = new Map<string, AlertState>();
  const over = condition({ id: "load", value: 9, fireAt: 4, clearAt: 2, sustainMs: 600_000 });
  const inBand = condition({ id: "load", value: 3, fireAt: 4, clearAt: 2, sustainMs: 600_000 });

  step(state, [over], 0);
  step(state, [inBand], 300_000);
  // Without the reset this would fire at 600_000 having spent half that time
  // below the line.
  assert.equal(step(state, [over], 600_000).length, 0, "clock restarted");
  assert.equal(step(state, [over], 1_200_001).length, 1);
});

test("a condition that stops being reported is held, then forgotten, not left firing", () => {
  const state = new Map<string, AlertState>();
  step(state, [condition({ value: 0.95 })], 0);
  assert.equal(state.size, 1);

  // The disk was unmounted: no condition, and so nothing to clear.
  assert.equal(step(state, [], 1000).length, 0);
  assert.equal(state.get("disk:/")?.firing, true, "held while it may come back");
  assert.equal(step(state, [], 1000 + HOLD_MISSING_MS).length, 0);
  assert.equal(state.size, 0, "forgotten once the hold runs out");
});

test("a condition that was not firing is forgotten at once", () => {
  const state = new Map<string, AlertState>();
  step(state, [condition({ id: "load", value: 9, fireAt: 4, clearAt: 2, sustainMs: 600_000 })], 0);
  step(state, [], 1000);
  assert.equal(state.size, 0);
});

test("a socket that closes and opens again pushes once, not each time it comes back", () => {
  const state = new Map<string, AlertState>();
  const open = condition({ id: "expose:udp:546", value: 1, fireAt: 1, clearAt: 1, sustainMs: 120_000 });

  step(state, [open], 0);
  assert.equal(step(state, [open], 120_000).length, 1, "fires once sustained");
  step(state, [], 180_000);
  step(state, [open], 3_600_000);
  assert.equal(step(state, [open], 3_720_000).length, 0, "back within the hold: still the same alert");
});

test("a held socket that comes back declared is resolved", () => {
  const state = new Map<string, AlertState>();
  step(state, [condition({ id: "expose:tcp:8087", value: 1, fireAt: 1, clearAt: 1 })], 0);
  step(state, [], 60_000);
  const changes = step(state, [condition({ id: "expose:tcp:8087", value: 0, fireAt: 1, clearAt: 1 })], 120_000);
  assert.equal(changes.length, 1);
  assert.equal(at(changes, 0).kind, "cleared");
});

test("a one-off event is forgotten on the next tick, so the next one pushes again", () => {
  const state = new Map<string, AlertState>();
  const login = condition({ id: "ssh:someone@else", value: 1, fireAt: 1, clearAt: 1, event: true });

  assert.equal(step(state, [login], 0).length, 1);
  step(state, [], 60_000);
  assert.equal(state.size, 0);
  assert.equal(step(state, [login], 120_000).length, 1);
});

test("the firing state survives a restart, so standing alerts do not push again", () => {
  const dir = mkdtempSync(join(tmpdir(), "alerts-"));
  const path = join(dir, "alerts.json");
  const open = condition({ id: "expose:tcp:8087", value: 1, fireAt: 1, clearAt: 1 });
  const sustaining = condition({ id: "load", value: 9, fireAt: 4, clearAt: 2, sustainMs: 600_000 });

  const before = new Map<string, AlertState>();
  step(before, [open, sustaining], 0);
  step(before, [sustaining], 60_000);
  saveAlertState(path, serializeAlertState(before));

  const after = loadAlertState(path, () => {});
  assert.deepEqual([...after.keys()], ["expose:tcp:8087"], "only firing conditions are kept");
  assert.equal(after.get("expose:tcp:8087")?.missingSince, 60_000, "the hold clock is kept");
  assert.equal(step(after, [open], 120_000).length, 0, "no second push after the restart");
});

test("a missing or unreadable state file starts with none firing", () => {
  const dir = mkdtempSync(join(tmpdir(), "alerts-"));
  const lines: string[] = [];
  assert.equal(loadAlertState(join(dir, "absent.json"), (line) => lines.push(line)).size, 0);
  assert.equal(lines.length, 0, "a first start is not worth a log line");

  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{not json");
  assert.equal(loadAlertState(broken, (line) => lines.push(line)).size, 0);
  assert.equal(lines.length, 1);
});

test("evaluate skips units this machine does not install", () => {
  const conditions = evaluate({
    stats: stats({}),
    units: [
      { unit: "cobra-agent", enabled: true, active: true },
      { unit: "cobra-home", enabled: false, active: false },
    ],
  });
  const ids = conditions.map((entry) => entry.id);
  assert.ok(ids.includes("unit:cobra-agent"), "an installed unit is watched");
  assert.ok(!ids.includes("unit:cobra-home"), "an absent unit is not");
});

test("a down unit fires and a running one does not", () => {
  const down = evaluate({
    stats: stats({}),
    units: [{ unit: "cobra-term", enabled: true, active: false }],
  }).find((entry) => entry.id === "unit:cobra-term");
  assert.ok(down);
  assert.equal(step(new Map(), [down], 0).length, 1);

  const up = evaluate({
    stats: stats({}),
    units: [{ unit: "cobra-term", enabled: true, active: true }],
  }).find((entry) => entry.id === "unit:cobra-term");
  assert.ok(up);
  assert.equal(step(new Map(), [up], 0).length, 0);
});

test("swap is not evaluated on a machine without any", () => {
  const withSwap = evaluate({ stats: stats({}), units: [] }).map((entry) => entry.id);
  assert.ok(withSwap.includes("swap"));

  const without = evaluate({
    stats: stats({
      memory: { ...stats({}).memory, swapTotalBytes: 0, swapUsedBytes: 0 },
    }),
    units: [],
  }).map((entry) => entry.id);
  assert.ok(!without.includes("swap"), "no division by zero, no permanent NaN alert");
});

test("load is normalised by thread count", () => {
  const busy = evaluate({
    stats: stats({ cpu: { model: "M1", threads: 4, usage: 1, loadavg: [20, 20, 20] } }),
    units: [],
  }).find((entry) => entry.id === "load");
  assert.ok(busy);
  assert.equal(busy.value, 5, "20 across 4 threads");
});

test("an alert push carries no category, so old builds show it plainly", () => {
  const message = compose("office", {
    kind: "fired",
    condition: condition({ value: 0.95 }),
  });
  assert.equal(message.category, undefined);
  assert.equal(message.data.machine, "office");
});

test("a cleared alert is worded as a resolution", () => {
  const message = compose("office", {
    kind: "cleared",
    condition: condition({ title: "office: / is filling up" }),
  });
  assert.match(message.title, /^Resolved: /);
});

test("Workers outside Cobra's sandbox are a standing warning that says why; contained, it stays quiet", () => {
  const out = evaluate({ stats: stats({}), units: [], containment: { contained: false, reason: "macOS has no Cobra sandbox yet, so Workers run in Claude Code's own sandbox only" } });
  const warning = out.find((condition) => condition.id === "uncontained")!;
  assert.equal(warning.level, "warn");
  assert.ok(warning.value >= warning.fireAt, "it fires");
  assert.match(warning.body, /^macOS has no Cobra sandbox yet.*A Worker can read files outside its project\.$/);
  const quiet = evaluate({ stats: stats({}), units: [], containment: { contained: true, reason: null } }).find((condition) => condition.id === "uncontained")!;
  assert.ok(quiet.value < quiet.fireAt);
  assert.equal(evaluate({ stats: stats({}), units: [] }).some((condition) => condition.id === "uncontained"), false, "nothing said without the fact");
});
