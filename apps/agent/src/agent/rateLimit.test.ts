import assert from "node:assert/strict";
import { test } from "node:test";

import { createRateLimiter, isLongPoll, limitsFor, ORCH_LIMITS, PERSON_LIMITS, type Admission } from "./rateLimit.ts";

const desk = { id: "desk_aaaaaaaaaaaaaaaaa", kind: "desk" as const };
const other = { id: "desk_bbbbbbbbbbbbbbbbb", kind: "desk" as const };
const lead = { id: "lead_legion_________", kind: "lead" as const };

function limiter() {
  let clock = 1_800_000_000_000;
  return { l: createRateLimiter({ now: () => clock }), advance: (ms: number) => (clock += ms) };
}

const refused = (a: Admission) => (a.ok ? null : a);

test("rate limit: a key spends its burst, then gets 429 with a Retry-After, and refills over time", () => {
  const { l, advance } = limiter();
  for (let i = 0; i < PERSON_LIMITS.burst; i++) assert.equal(l.admit(desk, "/projects").ok, true, `request ${i}`);
  const no = refused(l.admit(desk, "/projects"));
  assert.ok(no);
  assert.equal(no.retryAfter, 1);
  assert.match(no.error, /180 a minute/);
  // Three tokens a second at 180 a minute.
  advance(1000);
  for (let i = 0; i < 3; i++) assert.equal(l.admit(desk, "/projects").ok, true);
  assert.equal(l.admit(desk, "/projects").ok, false);
  // Another key is untouched.
  assert.equal(l.admit(other, "/projects").ok, true);
});

test("rate limit: the desk's own polls fit, a conversation being answered included", () => {
  const { l, advance } = limiter();
  // Ten minutes of the busiest screen: a poll every 0.8 s plus some 40 other polls a minute.
  let refusedCount = 0;
  for (let ms = 0; ms < 10 * 60_000; ms += 400) {
    if (ms % 800 === 0 && !l.admit(desk, "/transcript").ok) refusedCount++;
    if (ms % 1600 === 0 && !l.admit(desk, "/projects").ok) refusedCount++;
    advance(400);
  }
  assert.equal(refusedCount, 0);
});

test("rate limit: long polls are counted while open, and freed when their reply is done", () => {
  const { l } = limiter();
  const waits = Array.from({ length: PERSON_LIMITS.waits }, () => l.admit(desk, "/thread/wait"));
  assert.ok(waits.every((w) => w.ok));
  const fifth = refused(l.admit(desk, "/thread/wait"));
  assert.ok(fifth);
  assert.equal(fifth.retryAfter, 5);
  // Other routes still go.
  assert.equal(l.admit(desk, "/projects").ok, true);
  const first = waits[0]!;
  assert.ok(first.ok);
  first.release();
  first.release();
  assert.equal(l.admit(desk, "/thread/wait").ok, true);
  assert.equal(l.admit(desk, "/thread/wait").ok, false, "a second release of the same wait frees nothing more");
});

test("rate limit: the Lead and Foremen get a bucket of their own, far larger, so a run of tool calls never waits", () => {
  assert.equal(limitsFor({ kind: "lead" }), ORCH_LIMITS);
  assert.equal(limitsFor({ kind: "desk" }), PERSON_LIMITS);
  const { l } = limiter();
  for (let i = 0; i < ORCH_LIMITS.burst; i++) assert.equal(l.admit(lead, "/orch/status").ok, true);
  const waits = Array.from({ length: ORCH_LIMITS.waits }, () => l.admit({ id: "foreman_site________", kind: "lead" }, "/orch/worker/wait"));
  assert.ok(waits.every((w) => w.ok));
  assert.ok(isLongPoll("/orch/foreman/wait") && isLongPoll("/orch/ask/wait") && !isLongPoll("/orch/worker"));
});
