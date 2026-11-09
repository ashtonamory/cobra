import { test } from "node:test";
import assert from "node:assert/strict";

import { EMPTY_ORG, OrgError, applyOrg, companyIdFor, describeOrgChange, orgText, parseOrg, parseOrgChange, companyNote, seatKey, seatParts, seatPlace } from "./org.ts";

const opened = () => {
  let org = applyOrg(EMPTY_ORG, { op: "company", name: "Happy Tails" }).org;
  org = applyOrg(org, { op: "assign", seat: "omarchy/invoicing", company: "happy-tails" }).org;
  org = applyOrg(org, { op: "assign", seat: "omarchy/schedule", company: "happy-tails" }).org;
  return org;
};

test("a company gets an id from its name and the next free colour", () => {
  const { org, created } = applyOrg(EMPTY_ORG, { op: "company", name: "Happy Tails" });
  assert.equal(created, "happy-tails");
  assert.equal(org.revision, 1);
  const second = applyOrg(org, { op: "company", name: "Paws & Paths" });
  assert.equal(second.created, "paws-paths");
  assert.notEqual(second.org.companies[1]!.color, org.companies[0]!.color);
  assert.equal(companyIdFor("Happy Tails", ["happy-tails"]), "happy-tails-2");
  assert.equal(companyIdFor("!!!", []), "company");
});

test("names are unique, ignoring case", () => {
  assert.throws(() => applyOrg(opened(), { op: "company", name: "happy tails" }), (e: unknown) => e instanceof OrgError && e.status === 409);
});

test("assign, retire and bring back move one seat", () => {
  let org = opened();
  assert.equal(org.seats["omarchy/invoicing"]!.company, "happy-tails");
  org = applyOrg(org, { op: "retire", seat: "omarchy/invoicing" }).org;
  assert.deepEqual(org.seats["omarchy/invoicing"], { company: "happy-tails", retired: true });
  org = applyOrg(org, { op: "bring-back", seat: "omarchy/invoicing" }).org;
  assert.deepEqual(org.seats["omarchy/invoicing"], { company: "happy-tails" });
  org = applyOrg(org, { op: "assign", seat: "omarchy/invoicing", company: null }).org;
  assert.equal(org.seats["omarchy/invoicing"], undefined, "New arrivals keeps no seat");
  org = applyOrg(org, { op: "retire", seat: "omarchy/schedule" }).org;
  org = applyOrg(org, { op: "assign", seat: "omarchy/schedule", company: "happy-tails" }).org;
  assert.deepEqual(org.seats["omarchy/schedule"], { company: "happy-tails" }, "a move brings a retired Foreman back");
  assert.throws(() => applyOrg(org, { op: "assign", seat: "omarchy/schedule", company: "nope" }), (e: unknown) => e instanceof OrgError && e.status === 404);
});

test("closing a company sends its Foremen to New arrivals", () => {
  let org = applyOrg(opened(), { op: "retire", seat: "omarchy/schedule" }).org;
  org = applyOrg(org, { op: "remove", company: "happy-tails" }).org;
  assert.deepEqual(org.companies, []);
  assert.equal(org.seats["omarchy/invoicing"], undefined);
  assert.deepEqual(org.seats["omarchy/schedule"], { retired: true });
});

test("parseOrg drops what is malformed and never throws", () => {
  assert.deepEqual(parseOrg(null), EMPTY_ORG);
  const org = parseOrg({
    revision: 4,
    companies: [{ id: "a", name: " A  co ", color: "red" }, { id: "Bad Id", name: "x" }, { id: "a", name: "dup" }],
    seats: { "m/p": { company: "a" }, "m/q": { company: "ghost" }, "no-slash": { retired: true }, "m/r": { retired: true } },
  });
  assert.equal(org.revision, 4);
  assert.deepEqual(org.companies.map((c) => [c.id, c.name]), [["a", "A co"]]);
  assert.match(org.companies[0]!.color, /^#/);
  assert.deepEqual(org.seats, { "m/p": { company: "a" }, "m/r": { retired: true } });
});

test("parseOrgChange checks each op", () => {
  assert.deepEqual(parseOrgChange({ op: "assign", seat: "omarchy/x", company: null }), { op: "assign", seat: "omarchy/x", company: null });
  assert.throws(() => parseOrgChange({ op: "assign", seat: "x", company: "a" }), /seat/);
  assert.throws(() => parseOrgChange({ op: "company", name: "   " }), /name/);
  assert.throws(() => parseOrgChange({ op: "drop" }), /op must be/);
});

test("seat keys, words and the Lead's text", () => {
  assert.equal(seatKey("omarchy", "cobra"), "omarchy/cobra");
  assert.deepEqual(seatParts("omarchy/cobra"), { machine: "omarchy", project: "cobra" });
  assert.equal(seatParts("nope"), null);
  const org = opened();
  assert.equal(describeOrgChange(org, { op: "assign", seat: "omarchy/x", company: "happy-tails" }, () => "Mae"), "Mae now works for Happy Tails");
  assert.match(orgText(org), /happy-tails: Happy Tails · omarchy\/invoicing, omarchy\/schedule/);
});

test("a seat's place and a brief's company line", () => {
  const org = applyOrg(opened(), { op: "assign", seat: "mini/site", company: "happy-tails" }).org;
  const retired = applyOrg(org, { op: "retire", seat: "omarchy/old" }).org;
  assert.equal(seatPlace(retired, "omarchy", "invoicing"), "Happy Tails");
  assert.equal(seatPlace(retired, "omarchy", "old"), "retired (Outskirts)");
  assert.equal(seatPlace(retired, "omarchy", "elsewhere"), null);
  assert.equal(
    companyNote(retired, "omarchy", "invoicing"),
    "[Company: your project works for Happy Tails, alongside the Foremen of schedule, site on mini. Their work reaches you only through Cobra: say in your report what of theirs this touches.]",
  );
  assert.equal(companyNote(retired, "omarchy", "old"), null);
  assert.equal(companyNote(retired, "omarchy", "elsewhere"), null);
});

test("a company marked sensitive keeps the mark through a parse, says so to Cobra, and loses it when switched off", () => {
  const { org, created } = applyOrg(EMPTY_ORG, { op: "company", name: "Happy Tails" });
  const marked = applyOrg(org, parseOrgChange({ op: "sensitive", company: created, on: true })).org;
  assert.equal(parseOrg(JSON.parse(JSON.stringify(marked))).companies[0]?.sensitive, true);
  assert.match(orgText(marked), /Happy Tails \(sensitive: its memory stays on this computer\)/);
  assert.match(describeOrgChange(org, { op: "sensitive", company: created!, on: true }), /Happy Tails/);
  const off = applyOrg(marked, { op: "sensitive", company: created!, on: false }).org;
  assert.equal("sensitive" in off.companies[0]!, false);
  assert.throws(() => parseOrgChange({ op: "sensitive", company: created, on: "yes" }), OrgError);
});

test("a company opened with a kind and a home is a Space, and a plain company is not", () => {
  const { org, created } = applyOrg(EMPTY_ORG, { op: "company", name: "Maya's Soccer", kind: "team", home: "omarchy" });
  assert.equal(created, "maya-s-soccer");
  assert.equal(org.companies[0]!.kind, "team");
  assert.equal(org.companies[0]!.home, "omarchy");
  const plain = applyOrg(org, { op: "company", name: "Happy Tails" }).org;
  assert.equal(plain.companies[1]!.kind, undefined);
  assert.equal(plain.companies[1]!.home, undefined);
});

test("space makes an existing company a Space; its home stays once set", () => {
  let org = applyOrg(EMPTY_ORG, { op: "company", name: "Happy Tails" }).org;
  org = applyOrg(org, { op: "space", company: "happy-tails", kind: "client", home: "omarchy" }).org;
  assert.deepEqual([org.companies[0]!.kind, org.companies[0]!.home], ["client", "omarchy"]);
  org = applyOrg(org, { op: "space", company: "happy-tails", kind: "own", home: "omarchy" }).org;
  assert.equal(org.companies[0]!.kind, "own", "the kind may change");
  assert.throws(() => applyOrg(org, { op: "space", company: "happy-tails", kind: "own", home: "mini" }), (e: unknown) => e instanceof OrgError && e.status === 409);
  assert.throws(() => applyOrg(org, { op: "space", company: "nope", kind: "own", home: "mini" }), (e: unknown) => e instanceof OrgError && e.status === 404);
});

test("a Space's kind and home are read from a request together or not at all", () => {
  assert.deepEqual(parseOrgChange({ op: "space", company: "happy-tails", kind: "team", home: "omarchy" }), { op: "space", company: "happy-tails", kind: "team", home: "omarchy" });
  assert.deepEqual(parseOrgChange({ op: "company", name: "Soccer", kind: "team", home: "omarchy" }), { op: "company", name: "Soccer", kind: "team", home: "omarchy" });
  assert.throws(() => parseOrgChange({ op: "company", name: "Soccer", kind: "team" }), (e: unknown) => e instanceof OrgError && e.status === 400);
  assert.throws(() => parseOrgChange({ op: "company", name: "Soccer", home: "omarchy" }), (e: unknown) => e instanceof OrgError && e.status === 400);
  assert.throws(() => parseOrgChange({ op: "space", company: "x", kind: "nope", home: "omarchy" }), (e: unknown) => e instanceof OrgError && e.status === 400);
  assert.throws(() => parseOrgChange({ op: "space", company: "x", kind: "team", home: "../etc" }), (e: unknown) => e instanceof OrgError && e.status === 400);
});

test("an org file keeps a Space's kind and home and drops half of a pair", () => {
  const org = parseOrg({
    revision: 3,
    companies: [
      { id: "a", name: "A", color: "#c0763a", kind: "team", home: "omarchy" },
      { id: "b", name: "B", color: "#4f9d69", kind: "team" },
      { id: "c", name: "C", color: "#3f86c4", kind: "nope", home: "omarchy" },
    ],
    seats: {},
  });
  assert.deepEqual(org.companies.map((c) => [c.kind, c.home]), [["team", "omarchy"], [undefined, undefined], [undefined, undefined]]);
});

test("a Space reads as one in the words the Lead and the log use", () => {
  const { org } = applyOrg(EMPTY_ORG, { op: "company", name: "Maya's Soccer", kind: "team", home: "omarchy" });
  assert.match(orgText(org), /\[Team or group Space, runs on omarchy\]/);
  assert.match(describeOrgChange(EMPTY_ORG, { op: "company", name: "Maya's Soccer", kind: "team", home: "omarchy" }), /team or group Space on omarchy/);
  assert.match(describeOrgChange(org, { op: "space", company: "maya-s-soccer", kind: "family", home: "omarchy" }), /Maya's Soccer is now a family or personal Space on omarchy/);
  assert.equal(describeOrgChange(EMPTY_ORG, { op: "company", name: "Happy Tails" }), "Opened Happy Tails");
});
