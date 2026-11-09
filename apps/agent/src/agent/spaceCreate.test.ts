import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EMPTY_ORG, applyOrg, type Org } from "../../../../packages/contracts/src/org.ts";

import type { StoredApproval } from "./approvals.ts";
import { checkHire, hireBrief, proposeSpace, seatBrief, seedBrainText, settleSpaceApproval, type SpaceDeps } from "./spaceCreate.ts";
import { openSpace, readProfile, readSpace, seatOf } from "./spaces.ts";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const PROFILE = { purpose: "Schedule and messages for an under-10 soccer team", people: "12 families", voice: "Warm and brief", tools: "Google calendar", money: "Season dues of $40" };

function world(startOrg: Org = EMPTY_ORG, over: Partial<SpaceDeps> = {}) {
  const spacesRoot = mkdtempSync(join(tmpdir(), "spaces-create-"));
  let org = startOrg;
  let approvals: StoredApproval[] = [];
  const told: [string, string][] = [];
  const calls: string[] = [];
  const brains: { company: { id: string; name: string; sensitive: boolean }; text: string }[] = [];
  const notified: StoredApproval[] = [];
  const deps: SpaceDeps = {
    machine: "omarchy",
    spacesRoot,
    org: { load: () => org, save: (next) => (org = next) },
    approvals: { load: () => approvals, save: (list) => (approvals = list) },
    notify: async (a) => void notified.push(a),
    tell: (owner, text) => void told.push([owner, text]),
    log: () => {},
    now: () => NOW,
    addRoot: () => void calls.push("addRoot"),
    seedBrain: (company, text) => void brains.push({ company, text }),
    ...over,
  };
  return { deps, spacesRoot, get org() { return org; }, get approvals() { return approvals; }, told, calls, brains, notified };
}

const soccer = { name: "Maya's Soccer", kind: "team", profile: PROFILE };
const proposed = async (w: ReturnType<typeof world>, body: unknown = soccer) => {
  const reply = await proposeSpace(w.deps, "lead", body);
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  return w.approvals.at(-1)!;
};
const allowed = (a: StoredApproval): StoredApproval => ({ ...a, state: "allowed" });

test("a proposal is one card: the kind, where it runs, and what it is for; it starts no Foremen", async () => {
  const w = world();
  const card = await proposed(w);
  assert.equal(card.kind, "space");
  assert.equal(card.title, "Open Maya's Soccer?");
  assert.match(card.body, /Team or group, on omarchy\. Sensitive: its details stay on this computer\./);
  assert.match(card.body, /Cobra brings in each skill it needs the first time you ask for something there\./);
  assert.equal(/Foreman|Announcements|Roster|Dues/.test(card.body), false, "the card names no crew");
  assert.match(card.body, /For: Schedule and messages for an under-10 soccer team/);
  assert.match(card.body, /Serves: 12 families/);
  assert.deepEqual(card.space?.seats, [], "no baseline seats: Cobra hires on first need");
  assert.equal(card.space?.sensitive, true, "a team defaults to Sensitive on");
  assert.equal(w.notified.length, 1);
  assert.deepEqual(w.org, EMPTY_ORG, "proposing opens nothing");
});

test("Sensitive defaults by kind and the person's answer wins", async () => {
  const w = world();
  assert.equal((await proposed(w, { name: "Happy Tails", kind: "client", profile: PROFILE })).space?.sensitive, false);
  assert.equal((await proposed(w, { name: "Home", kind: "family", profile: PROFILE })).space?.sensitive, true);
  assert.equal((await proposed(w, { name: "Club", kind: "team", sensitive: false, profile: PROFILE })).space?.sensitive, false);
});

test("a proposal is checked: kind, profile, name, a name already taken, and a Space already open", async () => {
  const w = world();
  const code = async (body: unknown) => (await proposeSpace(w.deps, "lead", body)).status;
  assert.equal(await code(null), 400);
  assert.equal(await code({ ...soccer, kind: "nope" }), 400);
  assert.equal(await code({ ...soccer, profile: { purpose: "x" } }), 400);
  assert.equal(await code({ ...soccer, name: "  " }), 400);
  assert.equal(await code({ ...soccer, adopt: "missing" }), 404);
  const open = applyOrg(EMPTY_ORG, { op: "company", name: "Happy Tails" }).org;
  const w2 = world(open);
  assert.equal((await proposeSpace(w2.deps, "lead", { name: "happy tails", kind: "client", profile: PROFILE })).status, 409, "a name already a company points to adopt");
  const space = applyOrg(open, { op: "space", company: "happy-tails", kind: "client", home: "omarchy" }).org;
  const w3 = world(space);
  openSpace({ id: "happy-tails", name: "Happy Tails", kind: "client", home: "omarchy", sensitive: false }, "omarchy", w3.spacesRoot);
  assert.equal((await proposeSpace(w3.deps, "lead", { kind: "client", adopt: "happy-tails", profile: PROFILE })).status, 409, "a Space with its folder here is open");
  const elsewhere = applyOrg(open, { op: "space", company: "happy-tails", kind: "client", home: "mini" }).org;
  assert.equal((await proposeSpace(world(elsewhere).deps, "lead", { kind: "client", adopt: "happy-tails", profile: PROFILE })).status, 409, "a Space on another computer is not finished from here");
  assert.equal(w.approvals.length, 0, "a refused proposal leaves no card");
});

test("a newer card for the same Space replaces one not answered yet", async () => {
  const w = world();
  const first = await proposed(w);
  const second = await proposed(w, { ...soccer, profile: { ...PROFILE, people: "14 families" } });
  assert.notEqual(first.id, second.id);
  assert.deepEqual(w.approvals.map((a) => a.state), ["expired", "pending"]);
});

test("Deny changes nothing and the Lead is told", async () => {
  const w = world();
  const card = await proposed(w);
  const result = await settleSpaceApproval(w.deps, { ...card, state: "denied" });
  assert.equal(result.state, "denied");
  assert.deepEqual(w.org, EMPTY_ORG);
  assert.deepEqual(w.calls, []);
  assert.equal(existsSync(join(w.spacesRoot, "maya-s-soccer")), false);
  assert.match(w.told[0]![1], /said not now to opening Maya's Soccer/);
});

test("Allow opens the Space: the company, its folder and profile, and its brain, with no Foremen yet", async () => {
  const w = world();
  const card = await proposed(w);
  const result = await settleSpaceApproval(w.deps, allowed(card));
  assert.equal(result.state, "done");

  const company = w.org.companies[0]!;
  assert.deepEqual([company.id, company.kind, company.home, company.sensitive], ["maya-s-soccer", "team", "omarchy", true]);
  assert.equal(readSpace("maya-s-soccer", w.spacesRoot)?.sensitive, true);
  assert.equal(readProfile("maya-s-soccer", w.spacesRoot)?.people, "12 families");
  assert.equal(readFileSync(join(w.spacesRoot, "maya-s-soccer", "profile.md"), "utf8").includes("Warm and brief"), true);
  assert.deepEqual(w.calls, ["addRoot"]);
  assert.deepEqual(w.org.seats, {}, "nobody seated yet");
  assert.match(w.told.at(-1)![1], /^The person allowed it\. Maya's Soccer is open on omarchy as a team or group Space\. It has no Foremen yet: hire each skill with foreman_create and space "maya-s-soccer"/);
  assert.match(w.told.at(-1)![1], /Tell the person it is open and what you will do first\.$/);
});

test("the brain is seeded from the intake with its fixed headings, and the seat briefs name the Space and the first job", async () => {
  const w = world();
  await settleSpaceApproval(w.deps, allowed(await proposed(w)));
  const { company, text } = w.brains[0]!;
  assert.deepEqual(company, { id: "maya-s-soccer", name: "Maya's Soccer", sensitive: true });
  assert.match(text, /^# Maya's Soccer\n\n_Updated 2026-10-27\._\n\n## What it is\nTeam or group\. Schedule and messages for an under-10 soccer team\n\n## People\n12 families\n/);
  assert.match(text, /## Rules for the work\n- Voice: Warm and brief\n- Already uses: Google calendar\n- Money: Season dues of \$40\n/);
  for (const heading of ["Decisions", "Open threads"]) assert.ok(text.includes(`## ${heading}`));
  const brief = seatBrief("Maya's Soccer", "team", { role: "people", name: "Roster", directory: "roster" });
  assert.match(brief, /^\[Space: Maya's Soccer, a team or group\] You are the Roster Foreman of this Space\./);
  assert.match(brief, /stage_set/);
  assert.equal(brief.includes("\n"), false, "a brief is one line");
  assert.ok(brief.length < 4000);
  assert.match(seatBrief("Happy Tails", "client", { role: "money", name: "Finance", directory: "finance" }), /business_set/);
  assert.match(seatBrief("Home", "family", { role: "money", name: "Budget", directory: "budget" }), /ask before you record anything/);
  assert.match(seatBrief("Maya", "team", { role: "outreach", name: "Announcements", directory: "announcements" }), /action_propose/);
});

test("adopting a company makes it a Space and keeps its colour and name", async () => {
  const open = applyOrg(EMPTY_ORG, { op: "company", name: "Happy Tails", color: "#4f9d69" }).org;
  const w = world(open);
  const card = await proposed(w, { kind: "client", adopt: "happy-tails", profile: PROFILE });
  assert.equal(card.title, "Open Happy Tails?");
  assert.match(card.body, /Happy Tails is already in your organization: Allow makes it a Space\./);
  await settleSpaceApproval(w.deps, allowed(card));
  assert.equal(w.org.companies.length, 1);
  assert.deepEqual([w.org.companies[0]!.color, w.org.companies[0]!.kind, w.org.companies[0]!.home], ["#4f9d69", "client", "omarchy"]);
  assert.equal(w.org.companies[0]!.sensitive, undefined, "a client is not Sensitive");
  assert.equal(readSpace("happy-tails", w.spacesRoot)?.name, "Happy Tails");
});

test("seedBrainText leaves out what was not said", () => {
  const text = seedBrainText("Home", "family", { version: 1, purpose: "The household's money", people: "Two adults and two kids", updated: "2026-10-27T00:00:00.000Z" }, "2026-10-27");
  assert.match(text, /## Rules for the work\n\n## Open threads/);
});

test("hiring into a Space: it must be a Space, on this computer, and the Lead hires alone only up to six", () => {
  let org = applyOrg(EMPTY_ORG, { op: "company", name: "Maya's Soccer", kind: "team", home: "omarchy" }).org;
  org = applyOrg(org, { op: "company", name: "Happy Tails" }).org;
  org = applyOrg(org, { op: "company", name: "Elsewhere", kind: "client", home: "mini" }).org;
  const seat = (n: number) => `omarchy/p${n}`;
  const fail = (result: ReturnType<typeof checkHire>) => ("error" in result ? result : assert.fail("expected a refusal"));
  assert.equal(fail(checkHire(org, "nope", "omarchy", false)).status, 404);
  assert.match(fail(checkHire(org, "happy-tails", "omarchy", false)).error, /not a Space yet/);
  assert.match(fail(checkHire(org, "elsewhere", "omarchy", false)).error, /runs on mini, not on omarchy/);
  for (let n = 1; n <= 5; n++) org = applyOrg(org, { op: "assign", seat: seat(n), company: "maya-s-soccer" }).org;
  assert.ok("company" in checkHire(org, "maya-s-soccer", "omarchy", false), "five Foremen: room for a sixth");
  org = applyOrg(org, { op: "assign", seat: seat(6), company: "maya-s-soccer" }).org;
  const full = fail(checkHire(org, "maya-s-soccer", "omarchy", false));
  assert.equal(full.status, 409);
  assert.match(full.error, /already has 6 Foremen, the most Cobra hires on her own\. Ask the person/);
  assert.ok("company" in checkHire(org, "maya-s-soccer", "omarchy", true), "the person agreed");
  org = applyOrg(org, { op: "retire", seat: seat(6) }).org;
  assert.ok("company" in checkHire(org, "maya-s-soccer", "omarchy", false), "a retired Foreman does not count");
  const unopened = fail(checkHire(org, "maya-s-soccer", "omarchy", false, false));
  assert.equal(unopened.status, 409);
  assert.match(unopened.error, /never finished opening/);
  assert.match(unopened.error, /space_create with adopt "maya-s-soccer"/, "it tells her how to finish it");
});

test("a step that fails before the folder is made leaves no company marked as a Space", async () => {
  const w = world(EMPTY_ORG, { addRoot: () => { throw new Error("~/Spaces is not a folder on this computer"); } });
  const result = await settleSpaceApproval(w.deps, allowed(await proposed(w)));
  assert.equal(result.state, "failed");
  assert.deepEqual(w.org, EMPTY_ORG, "nothing was saved to the org");
  assert.equal(readSpace("maya-s-soccer", w.spacesRoot), null, "no folder either");
  assert.match(w.told.at(-1)![1], /could not be opened \(~\/Spaces is not a folder/);
  assert.equal(w.calls.length, 0, "nothing was made");
  // The Lead asks again once the cause is gone: the same name is free, and Allow opens it.
  const again = world(w.org);
  const card = await proposed(again);
  assert.equal((await settleSpaceApproval(again.deps, allowed(card))).state, "done");
});

test("a company a failed opening left marked as a Space, with no folder, is finished by asking again", async () => {
  const open = applyOrg(EMPTY_ORG, { op: "company", name: "Example.com", color: "#d6a12c" }).org;
  const half = applyOrg(open, { op: "space", company: "example-com", kind: "own", home: "omarchy" }).org;
  const w = world(half);
  const card = await proposed(w, { kind: "own", adopt: "example-com", profile: PROFILE });
  assert.equal(card.title, "Open Example.com?");
  const result = await settleSpaceApproval(w.deps, allowed(card));
  assert.equal(result.state, "done", JSON.stringify(result.results));
  assert.equal(w.org.companies.length, 1);
  assert.deepEqual([w.org.companies[0]!.color, w.org.companies[0]!.kind, w.org.companies[0]!.home], ["#d6a12c", "own", "omarchy"]);
  assert.equal(readSpace("example-com", w.spacesRoot)?.name, "Example.com");
  assert.deepEqual(w.org.seats, {}, "opened with no Foremen");
});

test("a Foreman hired on first need: a seat of the Space's kind gets its first job, then the request; another trade the request alone", () => {
  const team = { name: "Maya's Soccer", kind: "team" as const };
  const roster = hireBrief(team, "people", "add the Lopez family");
  assert.match(roster ?? "", /^\[Space: Maya's Soccer, a team or group\] You are the Roster Foreman of this Space\./);
  assert.match(roster ?? "", / Then, for the request that brought you in: add the Lopez family$/);
  assert.match(hireBrief(team, "money", undefined) ?? "", /You are the Dues Foreman/);
  assert.equal(hireBrief(team, null, " make a flyer "), "make a flyer");
  assert.equal(hireBrief(undefined, null, undefined), null);
  assert.equal(hireBrief({ name: "Old", kind: undefined }, "people", "list them"), "list them", "a company that is not a Space");
  assert.ok((hireBrief(team, "people", "x".repeat(5000)) ?? "").length <= 3800);
});
