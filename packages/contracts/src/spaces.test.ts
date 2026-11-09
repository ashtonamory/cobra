import { test } from "node:test";
import assert from "node:assert/strict";

import { BASELINE_SEATS, MAX_SPACE_FOREMEN, PROFILE_FIELD_MAX, SENSITIVE_BY_DEFAULT, SPACE_KINDS, baselineSeatOf, baselineSeats, isSpaceKind, parseProfile, profileText } from "./spaces.ts";

test("every kind has three seats, one of each role, named with one word and a folder", () => {
  for (const kind of SPACE_KINDS) {
    const seats = baselineSeats(kind);
    assert.deepEqual(seats.map((s) => s.role), ["outreach", "people", "money"], kind);
    for (const seat of seats) {
      assert.match(seat.name, /^[A-Za-z]+$/, `${kind}: ${seat.name} is one word`);
      assert.match(seat.directory, /^[a-z]+$/);
    }
    assert.equal(new Set(seats.map((s) => s.directory)).size, 3, `${kind}: folders differ`);
  }
});

test("the seat names are the ones the owner confirmed", () => {
  const names = (k: (typeof SPACE_KINDS)[number]) => BASELINE_SEATS[k].map((s) => s.name);
  assert.deepEqual(names("client"), ["Marketing", "CRM", "Finance"]);
  assert.deepEqual(names("own"), ["Marketing", "CRM", "Finance"]);
  assert.deepEqual(names("team"), ["Announcements", "Roster", "Dues"]);
  assert.deepEqual(names("family"), ["Messages", "Contacts", "Budget"]);
});

test("a baseline seat is found by its folder or its name, and a stranger is not one", () => {
  assert.equal(baselineSeatOf("team", "roster")?.role, "people");
  assert.equal(baselineSeatOf("team", " Dues ")?.role, "money");
  assert.equal(baselineSeatOf("client", "roster"), null, "Roster is a team's seat, not a client's");
  assert.equal(baselineSeatOf("family", "website"), null);
});

test("Sensitive starts on for a team and a family only, and the cap is six", () => {
  assert.deepEqual(SENSITIVE_BY_DEFAULT, { client: false, own: false, team: true, family: true });
  assert.equal(MAX_SPACE_FOREMEN, 6);
});

test("kinds are recognised exactly", () => {
  assert.equal(isSpaceKind("team"), true);
  assert.equal(isSpaceKind("Team"), false);
  assert.equal(isSpaceKind(undefined), false);
});

test("a profile needs a purpose and people; the rest is optional and unknown fields are dropped", () => {
  assert.equal(parseProfile(null), null);
  assert.equal(parseProfile({ purpose: "Schedule" }), null);
  const p = parseProfile({ purpose: " Under-10 soccer ", people: "12 families", voice: "", tools: "Google", extra: "x", updated: "2026-10-27T10:00:00.000Z" });
  assert.deepEqual(p, { version: 1, purpose: "Under-10 soccer", people: "12 families", tools: "Google", updated: "2026-10-27T10:00:00.000Z" });
});

test("a profile field is cut at its limit and a bad date falls back to the epoch", () => {
  const p = parseProfile({ purpose: "p".repeat(PROFILE_FIELD_MAX + 50), people: "q", updated: "nope" })!;
  assert.equal(p.purpose.length, PROFILE_FIELD_MAX);
  assert.equal(p.updated, new Date(0).toISOString());
});

test("profile.md names the Space and its kind, and lists only what was answered", () => {
  const text = profileText("Maya's Soccer", "team", { version: 1, purpose: "Schedule and messages", people: "12 families", money: "Season dues", updated: "2026-10-27T10:00:00.000Z" });
  assert.match(text, /^# Maya's Soccer\n/);
  assert.match(text, /Team or group\. Written 2026-10-27/);
  assert.match(text, /## What it is for\n\nSchedule and messages/);
  assert.match(text, /## Money\n\nSeason dues/);
  assert.doesNotMatch(text, /## How it talks/);
});
