import { test } from "node:test";
import assert from "node:assert/strict";

import { minuteOf, openStore, SAMPLE_RETENTION_DAYS, ACTIVITY_RETENTION_DAYS } from "./history.ts";

/** Indexed access with a real assertion, so noUncheckedIndexedAccess stays on. */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `expected an item at index ${index}`);
  return item;
}


const MINUTE = 60_000;
const DAY = 86_400_000;

test("samples land in minute buckets and read back in order", () => {
  const store = openStore(":memory:");
  const base = 1_700_000_000_000;
  store.record([{ metric: "cpu", scope: "", value: 0.5 }], base);
  store.record([{ metric: "cpu", scope: "", value: 0.6 }], base + MINUTE);

  const points = store.series("cpu", "", 0);
  assert.deepEqual(
    points.map((point) => point.value),
    [0.5, 0.6],
  );
  assert.equal(at(points, 0).ts, minuteOf(base));
  store.close();
});

test("two writes inside one minute rewrite the bucket rather than appending", () => {
  const store = openStore(":memory:");
  const base = 1_700_000_000_000;
  store.record([{ metric: "cpu", scope: "", value: 0.1 }], base);
  store.record([{ metric: "cpu", scope: "", value: 0.9 }], base + 30_000);

  const points = store.series("cpu", "", 0);
  assert.equal(points.length, 1, "one minute is one row");
  assert.equal(at(points, 0).value, 0.9, "the later sample wins");
  store.close();
});

test("scopes keep separate series", () => {
  const store = openStore(":memory:");
  const base = 1_700_000_000_000;
  store.record(
    [
      { metric: "disk", scope: "/", value: 0.4 },
      { metric: "disk", scope: "/home", value: 0.8 },
    ],
    base,
  );
  assert.equal(at(store.series("disk", "/", 0), 0).value, 0.4);
  assert.equal(at(store.series("disk", "/home", 0), 0).value, 0.8);
  store.close();
});

test("a non-finite reading is skipped instead of poisoning the series", () => {
  const store = openStore(":memory:");
  const base = 1_700_000_000_000;
  store.record([{ metric: "temp", scope: "cpu", value: Number.NaN }], base);
  assert.equal(store.series("temp", "cpu", 0).length, 0);
  store.close();
});

test("maintain rolls old minutes into hours and stops double-counting", () => {
  const store = openStore(":memory:");
  const now = 1_700_000_000_000;
  const old = now - (SAMPLE_RETENTION_DAYS + 1) * DAY;

  // Two samples inside the same old hour, plus one recent sample that must survive.
  store.record([{ metric: "cpu", scope: "", value: 0.2 }], old);
  store.record([{ metric: "cpu", scope: "", value: 0.4 }], old + MINUTE);
  store.record([{ metric: "cpu", scope: "", value: 0.7 }], now);

  assert.equal(store.series("cpu", "", 0).length, 3, "three minute rows before maintenance");

  store.maintain(now);

  const points = store.series("cpu", "", 0);
  assert.equal(points.length, 2, "the old pair collapsed into one hourly row");
  // AVG(0.2, 0.4) — if the delete had not happened, the union would report the
  // minute rows as well and this would be four points.
  assert.ok(Math.abs(at(points, 0).value - 0.3) < 1e-9, `expected the hourly average, got ${at(points, 0).value}`);
  assert.equal(at(points, 1).value, 0.7, "the recent minute row is untouched");
  store.close();
});

test("maintain is safe to run twice", () => {
  const store = openStore(":memory:");
  const now = 1_700_000_000_000;
  const old = now - (SAMPLE_RETENTION_DAYS + 1) * DAY;
  store.record([{ metric: "cpu", scope: "", value: 0.2 }], old);
  store.maintain(now);
  const first = store.series("cpu", "", 0);
  store.maintain(now);
  assert.deepEqual(store.series("cpu", "", 0), first);
  store.close();
});

test("activity totals count one minute per project per minute", () => {
  const store = openStore(":memory:");
  const base = 1_700_000_000_000;
  for (let i = 0; i < 5; i += 1) {
    store.recordActivity([{ project: "stable", activity: "agent-working" }], base + i * MINUTE);
  }
  // Same minute, recorded repeatedly the way a five-second tick would.
  store.recordActivity([{ project: "stable", activity: "agent-working" }], base + 10_000);

  const totals = store.activityTotals(0);
  assert.deepEqual(totals, [{ project: "stable", activity: "agent-working", minutes: 5 }]);
  store.close();
});

test("activity totals sum across the daily rollup boundary", () => {
  const store = openStore(":memory:");
  const now = 1_700_000_000_000;
  const old = now - (ACTIVITY_RETENTION_DAYS + 1) * DAY;

  store.recordActivity([{ project: "stable", activity: "agent-working" }], old);
  store.recordActivity([{ project: "stable", activity: "agent-working" }], old + MINUTE);
  store.recordActivity([{ project: "stable", activity: "agent-working" }], now);

  store.maintain(now);

  const totals = store.activityTotals(0);
  assert.deepEqual(totals, [{ project: "stable", activity: "agent-working", minutes: 3 }]);
  store.close();
});

test("the since bound excludes older points", () => {
  const store = openStore(":memory:");
  const base = 1_700_000_000_000;
  store.record([{ metric: "cpu", scope: "", value: 0.1 }], base);
  store.record([{ metric: "cpu", scope: "", value: 0.2 }], base + 10 * MINUTE);

  const since = minuteOf(base + 5 * MINUTE);
  assert.deepEqual(
    store.series("cpu", "", since).map((point) => point.value),
    [0.2],
  );
  store.close();
});
