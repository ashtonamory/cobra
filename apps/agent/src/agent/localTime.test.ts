// Fixed before anything reads the zone: the default zone below is Europe/London.
process.env.TZ = "Europe/London";

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatLocal, localizeText, localZone, nowLine, relative } from "./localTime.ts";

// Fri 9 Oct 2026, 21:48 UTC = 22:48 BST.
const NOW = Date.parse("2026-10-09T21:48:00Z");

test("the default zone is the process's own", () => {
  assert.equal(localZone(), "Europe/London");
});

test("a time shows the offset in local time and how far away it is", () => {
  // Midnight UTC is 01:00 BST: in 2h 12m.
  assert.equal(formatLocal("2026-10-10T00:00:00Z", NOW), "Sat 10 Oct 01:00 BST (in 2h 12m)");
  assert.equal(formatLocal("2026-10-09T21:00:00Z", NOW), "Fri 9 Oct 22:00 BST (48m ago)");
});

test("the date follows the zone, not UTC", () => {
  assert.equal(formatLocal("2026-10-09T23:30:00Z", NOW, "America/New_York"), "Fri 9 Oct 19:30 GMT-4 (in 1h 42m)");
  assert.equal(formatLocal("2026-10-09T23:30:00Z", NOW, "Asia/Tokyo"), "Sat 10 Oct 08:30 GMT+9 (in 1h 42m)");
});

test("winter time is GMT, and a time in another year says the year", () => {
  assert.equal(formatLocal("2026-12-25T12:00:00Z", NOW), "Fri 25 Dec 12:00 GMT (in 76d 14h)");
  assert.equal(formatLocal("2027-01-02T12:00:00Z", NOW), "Sat 2 Jan 2027 12:00 GMT (in 84d 14h)");
});

test("the same time as a Date, a number and a string with an offset", () => {
  const text = "Sat 10 Oct 01:00 BST (in 2h 12m)";
  assert.equal(formatLocal(new Date("2026-10-10T00:00:00Z"), NOW), text);
  assert.equal(formatLocal(Date.parse("2026-10-10T00:00:00Z"), NOW), text);
  assert.equal(formatLocal("2026-10-10T00:00:00.512992+00:00", NOW), text);
  assert.equal(formatLocal("2026-10-10T02:00:00+02:00", NOW), text);
});

test("relative: minutes, hours, days, and now", () => {
  const at = (ms: number) => relative(NOW + ms, NOW);
  assert.equal(at(20_000), "just now");
  assert.equal(at(-20_000), "just now");
  assert.equal(at(5 * 60_000), "in 5m");
  assert.equal(at(-12 * 60_000), "12m ago");
  assert.equal(at(3 * 3_600_000), "in 3h");
  assert.equal(at(-(3 * 3_600_000 + 12 * 60_000)), "3h 12m ago");
  assert.equal(at(50 * 3_600_000), "in 2d 2h");
  assert.equal(at(-72 * 3_600_000), "3d ago");
});

test("something that is not a time comes back unchanged", () => {
  assert.equal(formatLocal("later", NOW), "later");
  assert.equal(formatLocal("", NOW), "");
});

test("nowLine anchors the model: local time, offset, zone", () => {
  assert.equal(
    nowLine(NOW),
    "Now: Fri 9 Oct 2026 22:48 BST, time zone Europe/London. Give the person times in local time like this, never in UTC.",
  );
  assert.match(nowLine(NOW, "Asia/Tokyo"), /^Now: Sat 10 Oct 2026 06:48 GMT\+9, time zone Asia\/Tokyo\./);
});

test("localizeText rewrites ISO times inside a sentence and nothing else", () => {
  assert.equal(
    localizeText("budget: Weekly (7-day) at 97%, resets 2026-10-10T00:00:00.512992+00:00", NOW),
    "budget: Weekly (7-day) at 97%, resets Sat 10 Oct 01:00 BST (in 2h 12m)",
  );
  assert.equal(
    localizeText("from 2026-10-09T21:00Z to 2026-10-10T00:00:00Z.", NOW),
    "from Fri 9 Oct 22:00 BST (48m ago) to Sat 10 Oct 01:00 BST (in 2h 12m).",
  );
  // No offset: no zone to convert from. A bare date and plain words stay.
  assert.equal(localizeText("at 2026-10-10T00:00:00 or 2026-10-10 or soon", NOW), "at 2026-10-10T00:00:00 or 2026-10-10 or soon");
  assert.equal(localizeText("resets later", NOW), "resets later");
  assert.equal(localizeText("bad 2026-13-45T99:00:00Z", NOW), "bad 2026-13-45T99:00:00Z");
});
