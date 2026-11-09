import { test } from "node:test";
import assert from "node:assert/strict";

import { askChange, briefCount, briefTemplates, campaignStatus, gallery, median, parseMarketing, replyRate, templateStatus, TEST_SLUG, topTemplates, type MarketingTemplate } from "./marketing.ts";

const NOW = Date.parse("2026-11-07T15:00:00Z");

test("a template's status: test and draft go on the shelf, a recent send or a due routine is Sending", () => {
  const base = { slug: "realtor", version: 2, sends: 0, tests: 0, lastUsed: null, dueSoon: false };
  assert.deepEqual(templateStatus({ ...base, slug: "cold-outreach-test" }, NOW), { status: "test", shelf: "A test copy" });
  assert.deepEqual(templateStatus({ ...base, version: null }, NOW), { status: "draft", shelf: "Never allowed" });
  assert.deepEqual(templateStatus({ ...base, tests: 3 }, NOW), { status: "test", shelf: "Only ever sent to you" });
  assert.deepEqual(templateStatus({ ...base, sends: 4, lastUsed: "2026-11-06T10:00:00Z" }, NOW), { status: "sending" });
  assert.deepEqual(templateStatus({ ...base, sends: 4, lastUsed: "2026-10-01T10:00:00Z" }, NOW), { status: "idle" });
  assert.deepEqual(templateStatus({ ...base, dueSoon: true }, NOW), { status: "sending" });
  assert.deepEqual(templateStatus(base, NOW), { status: "ready" });
});

test("test slugs: -test, scratch and probes, not a word that only contains them", () => {
  for (const slug of ["cold-outreach-test", "realtor-rebuild-scratch", "size-probe", "size-probe2", "test-run"]) assert.ok(TEST_SLUG.test(slug), slug);
  for (const slug of ["northwind-outreach", "contest-invite", "latest-news"]) assert.ok(!TEST_SLUG.test(slug), slug);
});

test("a campaign's status comes from its sends and routines", () => {
  const base = { stored: "planned", sends: 0, lastSend: null, routineOn: false, endsOn: null };
  assert.equal(campaignStatus(base, "2026-11-07", NOW), "planned");
  assert.equal(campaignStatus({ ...base, routineOn: true }, "2026-11-07", NOW), "running");
  assert.equal(campaignStatus({ ...base, sends: 5, lastSend: "2026-11-05T09:00:00Z" }, "2026-11-07", NOW), "running");
  assert.equal(campaignStatus({ ...base, sends: 5, lastSend: "2026-10-05T09:00:00Z" }, "2026-11-07", NOW), "done");
  assert.equal(campaignStatus({ ...base, sends: 5, lastSend: "2026-11-05T09:00:00Z", endsOn: "2026-11-06" }, "2026-11-07", NOW), "done");
  assert.equal(campaignStatus({ ...base, stored: "archived", routineOn: true }, "2026-11-07", NOW), "archived");
});

test("about how many: the median of the last runs, or the number a brief names", () => {
  assert.equal(median([10, 12, 9]), 10);
  assert.equal(median([10, 12]), 11);
  assert.equal(median([]), null);
  assert.equal(briefCount("Find 10 new prospects and email them"), 10);
  assert.equal(briefCount("Email 25 Florida realtors"), null);
  assert.equal(briefCount("Email 25 realtors in Florida"), 25);
  assert.equal(briefCount("Write the weekly report"), null);
});

test("a brief names a template by its whole slug", () => {
  const slugs = ["outreach", "outreach-realestate", "northwind-outreach"];
  assert.deepEqual(briefTemplates("Send them outreach-realestate from email_batch", slugs), ["outreach-realestate"]);
  assert.deepEqual(briefTemplates("Nothing to send", slugs), []);
});

test("reply rate waits for 20 sends", () => {
  assert.equal(replyRate(19, 3), null);
  assert.equal(replyRate(40, 3), 8);
});

const tpl = (slug: string, extra: Partial<MarketingTemplate> = {}): MarketingTemplate => ({
  slug, name: slug, kind: "marketing", version: 1, sha: "x", versions: [], status: "idle", sends: 0, sendsInRange: 0, replies: 0, clicks: 0,
  lastUsed: null, routines: [], senders: [], mismatch: [], campaign: null, tests: 0, ...extra,
});

test("the gallery: newest use first, the shelf apart; Overview's top by sends in the range", () => {
  const list = [tpl("a", { lastUsed: "2026-11-01" }), tpl("b", { lastUsed: "2026-11-06", sends: 3, sendsInRange: 3 }), tpl("t", { shelf: "A test copy" }), tpl("c", { sends: 9, sendsInRange: 9, lastUsed: "2026-11-02" })];
  const g = gallery(list);
  assert.deepEqual(g.shown.map((t) => t.slug), ["b", "c", "a"]);
  assert.deepEqual(g.shelf.map((t) => t.slug), ["t"]);
  assert.deepEqual(topTemplates(list).map((t) => t.slug), ["c", "b"]);
});

test("Ask Cobra to change it names the template", () => {
  assert.equal(askChange({ name: "Realtor outreach", slug: "northwind-realtor-outreach" }), "[Template: Realtor outreach (northwind-realtor-outreach)] Change this email: ");
});

test("the board reads leniently and refuses one with no Space", () => {
  assert.equal(parseMarketing({}), null);
  const board = parseMarketing({ space: { id: "northwind", name: "Northwind" }, range: "9d", templates: [{ slug: "a", status: "weird", sends: "3" }, { name: "no slug" }], comingUp: [{ at: "" }, { at: "2026-11-08T14:00:00Z", routine: { id: "rt", name: "Florida" }, about: 10 }] });
  assert.ok(board);
  assert.equal(board.range, "30d");
  assert.equal(board.templates.length, 1);
  assert.equal(board.templates[0]!.status, "idle");
  assert.equal(board.templates[0]!.sends, 0);
  assert.equal(board.comingUp.length, 1);
  assert.equal(board.sender.cap, 200);
});
