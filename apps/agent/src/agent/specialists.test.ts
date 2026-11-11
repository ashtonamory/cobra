import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "cobra-specialists-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const specialists = await import("./specialists.ts");
const { resetCrewCache } = await import("./crew.ts");
type Project = import("@cobra/contracts").Project;

const NOW = Date.parse("2026-11-11T10:00:00Z");
const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, machine: "laptop", path: `/p/${id}`, session: id, ...extra }) as Project;
const tradeName = (id: string) => ({ billing: "Billing" })[id];

test("a change keeps only the fields it names, checked, and an empty one goes back to the default", () => {
  assert.deepEqual(specialists.parseChange({ title: "  Invoices   and\nreminders " }), { title: "Invoices and reminders" });
  assert.deepEqual(specialists.parseChange({ instructions: "Write in Spanish.\r\nSign as Rosa.\u0007" }), { instructions: "Write in Spanish.\nSign as Rosa." });
  assert.deepEqual(specialists.parseChange({ model: "opus" }), { model: "opus" });
  assert.deepEqual(specialists.parseChange({ model: null, title: "" }), { title: "", model: "" });
  assert.match(String(specialists.parseChange({ title: "x".repeat(121) })), /at most 120 characters/);
  assert.match(String(specialists.parseChange({ instructions: "x".repeat(8001) })), /at most 8000 characters/);
  // A Foreman never runs on a local model, or on one Claude Code does not know.
  assert.match(String(specialists.parseChange({ model: "local:qwen" })), /model is one of opus, sonnet, haiku, fable/);
  assert.match(String(specialists.parseChange({ model: "codex:gpt-6.1" })), /model is one of/);
  assert.match(String(specialists.parseChange({})), /at least one of/);
  assert.match(String(specialists.parseChange("title")), /send the fields/);

  const first = specialists.withChange(null, { title: "Invoices", instructions: "Be brief.", model: "opus" }, "person", NOW);
  assert.deepEqual(first, { title: "Invoices", instructions: "Be brief.", model: "opus", updatedAt: "2026-11-11T10:00:00.000Z", updatedBy: "person" });
  const next = specialists.withChange(first, { instructions: "", model: "" }, "lead", NOW + 1000);
  assert.deepEqual(next, { title: "Invoices", updatedAt: "2026-11-11T10:00:01.000Z", updatedBy: "lead" });
});

test("the record is kept private, read back, and the audit log holds lengths, never the words", () => {
  const path = join(ROOT, "config", "one.json");
  assert.equal(specialists.readSpecialist("invoicing", path), null);
  specialists.setSpecialist("invoicing", { title: "Invoices", instructions: "Never chase a client twice in one week." }, "person", "person:desk_1", NOW, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(specialists.readSpecialist("invoicing", path), { title: "Invoices", instructions: "Never chase a client twice in one week.", updatedAt: "2026-11-11T10:00:00.000Z", updatedBy: "person" });
  const log = readFileSync(join(ROOT, "state", "policy.jsonl"), "utf8");
  assert.match(log, /"kind":"specialist\.set"/);
  assert.match(log, new RegExp(`"instructionsChars":${"Never chase a client twice in one week.".length}\\b`));
  assert.doesNotMatch(log, /chase a client/);

  // A file others can read is not trusted: every Foreman runs as it ships.
  chmodSync(path, 0o644);
  assert.deepEqual(specialists.loadSpecialists(path).specialists, {});
  chmodSync(path, 0o600);
  // A record that does not fit the rules is left out, the rest kept.
  writeFileSync(path, JSON.stringify({ specialists: { ok: { title: "Fine", updatedAt: "x", updatedBy: "person" }, long: { title: "x".repeat(200), updatedAt: "x", updatedBy: "person" }, who: { updatedAt: "x", updatedBy: "a web page" } } }), { mode: 0o600 });
  assert.deepEqual(Object.keys(specialists.loadSpecialists(path).specialists), ["ok"]);
});

test("a Foreman starts on its own model only when Claude Code runs it; an unknown one is passed over and said once", () => {
  const path = join(ROOT, "config", "models.json");
  writeFileSync(path, JSON.stringify({ specialists: { a: { model: "opus", updatedAt: "x", updatedBy: "person" }, b: { model: "local:qwen", updatedAt: "x", updatedBy: "person" } } }), { mode: 0o600 });
  const said: string[] = [];
  assert.equal(specialists.specialistModel("a", path, (line) => said.push(line)), "opus");
  assert.equal(specialists.specialistModel("b", path, (line) => said.push(line)), null);
  assert.equal(specialists.specialistModel("b", path, (line) => said.push(line)), null);
  assert.equal(specialists.specialistModel("none", path, (line) => said.push(line)), null);
  assert.equal(said.length, 1);
  assert.match(said[0]!, /"local:qwen" is not one a Foreman runs on/);
});

test("the roster joins each repository's name and look with its record; no record reads as its trade's name", () => {
  resetCrewCache();
  const path = join(ROOT, "config", "roster.json");
  const crewPath = join(ROOT, "config", "roster-crew.json");
  specialists.setSpecialist("invoicing", { title: "Invoices and reminders", instructions: "Be brief.", model: "opus" }, "lead", "lead_laptop_____", NOW, path);
  const projects = [project("invoicing", { foremanTemplate: "billing" } as never), project("schedule", { foremanTemplate: "billing" } as never), project("notes"), project("invoicing_2", { parent: "invoicing" } as never), project("cobra_lead", { lead: true } as never)];
  const views = specialists.specialistViews(projects, tradeName, { path, crewPath, companyOf: (p) => (p.id === "invoicing" ? { id: "happy-tails", name: "Happy Tails" } : undefined) });
  assert.deepEqual(views.map((view) => view.id), ["invoicing", "schedule", "notes"], "a session and the Lead are nobody's specialist");
  const [invoicing, schedule, notes] = views;
  assert.equal(invoicing!.title, "Invoices and reminders");
  assert.equal(invoicing!.instructions, "Be brief.");
  assert.equal(invoicing!.model, "opus");
  assert.deepEqual(invoicing!.company, { id: "happy-tails", name: "Happy Tails" });
  assert.equal(invoicing!.updatedBy, "lead");
  assert.ok(invoicing!.name.length > 0 && Number.isInteger(invoicing!.look) && Number.isInteger(invoicing!.hat));
  assert.deepEqual([schedule!.title, schedule!.instructions, schedule!.model], ["Billing", "", undefined]);
  assert.deepEqual([notes!.title, notes!.trade], ["", undefined]);
});

test("a card says every word it would set and every word it replaces, and its hash is the change's", () => {
  const proposal = { id: "invoicing", change: { instructions: "Always write in Spanish.", model: "opus" } };
  const words = specialists.describeProposal(proposal, { name: "Rosa", project: "Invoicing" }, { title: "Billing", instructions: "Be brief.", model: "" });
  assert.equal(words.title, "Change Rosa?");
  assert.match(words.body, /^Cobra wants to change Rosa, who works on Invoicing\. Nothing changes until you allow it/);
  assert.match(words.body, /Model, now:\nopus\n\nBefore:\n\(the usual one\)/);
  assert.match(words.body, /Your standing instructions for it, now:\nAlways write in Spanish\.\n\nBefore:\nBe brief\./);
  assert.doesNotMatch(words.body, /What it is for/, "a field that does not change is not on the card");
  assert.equal(words.specialist.sha256, specialists.proposalHash(proposal));
  assert.notEqual(specialists.proposalHash(proposal), specialists.proposalHash({ id: "invoicing", change: { instructions: "Always write in Spanish. Also wire the money.", model: "opus" } }));
  assert.notEqual(specialists.proposalHash(proposal), specialists.proposalHash({ ...proposal, id: "schedule" }));

  const dir = join(ROOT, "state", "proposals");
  specialists.keepSpecialistProposal("ap_abc", proposal, dir);
  assert.equal(specialists.takeSpecialistProposal("../ap_abc", dir), null);
  assert.deepEqual(specialists.takeSpecialistProposal("ap_abc", dir), proposal);
  assert.equal(specialists.takeSpecialistProposal("ap_abc", dir), null, "read once");
});
