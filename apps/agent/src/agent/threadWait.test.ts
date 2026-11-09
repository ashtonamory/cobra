import { test } from "node:test";
import assert from "node:assert/strict";

import type { ThreadEntry } from "@cobra/contracts";

import { WAIT_MAX_MS, waitForThread, waitMs, type WaitDeps } from "./threadWait.ts";

const entry = (id: number, kind = "cobra", text = "Done."): ThreadEntry => ({ id, at: "2026-11-02T20:00:00Z", kind, conversation: "c1", text });

/** A thread that gains `arrivals[n]` on the nth look, and is working while `busy(n)`. */
function fake(arrivals: Record<number, ThreadEntry[]>, busy: (look: number) => boolean) {
  let clock = 0;
  let look = 0;
  const log: ThreadEntry[] = [];
  const deps: WaitDeps = {
    ingest: async () => {
      log.push(...(arrivals[look] ?? []));
      look += 1;
    },
    after: (after) => log.filter((item) => item.id > after),
    working: async () => busy(look),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, looks: () => look, clock: () => clock };
}

test("returns at once when her reply is already there and she is done", async () => {
  const thread = fake({ 0: [entry(4, "you"), entry(5)] }, () => false);
  const result = await waitForThread(3, 25_000, thread.deps);
  assert.deepEqual(result.entries.map((item) => item.id), [4, 5]);
  assert.equal(result.working, false);
  assert.equal(thread.looks(), 1);
});

test("waits while she is still in the turn, then returns the whole reply", async () => {
  const thread = fake({ 1: [entry(6, "cobra", "Let me look.")], 3: [entry(7, "cobra", "Two things wait on you.")] }, (look) => look < 4);
  const result = await waitForThread(5, 25_000, thread.deps);
  assert.deepEqual(result.entries.map((item) => item.text), ["Let me look.", "Two things wait on you."]);
  assert.equal(result.working, false);
});

test("at the deadline gives what came, saying she still works", async () => {
  const thread = fake({ 1: [entry(8)] }, () => true);
  const result = await waitForThread(7, 4_000, thread.deps);
  assert.deepEqual(result.entries.map((item) => item.id), [8]);
  assert.equal(result.working, true);
  assert.equal(thread.clock(), 4_000);
});

test("nothing new: empty after the wait", async () => {
  const thread = fake({}, () => false);
  const result = await waitForThread(9, 3_000, thread.deps);
  assert.deepEqual(result, { entries: [], working: false });
});

test("the wait is 1 to 25 seconds", () => {
  assert.equal(waitMs(null), WAIT_MAX_MS);
  assert.equal(waitMs("5"), 5_000);
  assert.equal(waitMs("90"), WAIT_MAX_MS);
  assert.equal(waitMs("0"), WAIT_MAX_MS);
  assert.equal(waitMs("x"), WAIT_MAX_MS);
});
