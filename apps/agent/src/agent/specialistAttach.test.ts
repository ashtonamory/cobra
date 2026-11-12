import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "cobra-specialist-attach-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const attach = await import("./specialistAttach.ts");
const specialists = await import("./specialists.ts");
const { actsAlone, ACTS_ALONE } = await import("./instinctActs.ts");
const { dueForJudge } = await import("./unanswered.ts");
type StoredApproval = import("./approvals.ts").StoredApproval;
type AttachDeps = import("./specialistAttach.ts").AttachDeps;
type AttachedWorker = import("./specialistAttach.ts").AttachedWorker;
type Project = import("@cobra/contracts").Project;

const project = (id: string, name: string, extra: Record<string, unknown> = {}): Project => ({ id, name, machine: "laptop", path: `/p/${id}`, session: id, ...extra }) as Project;
const NAMES: Record<string, string> = { invoicing: "Rosa", website: "Stan" };

function harness() {
  let list: StoredApproval[] = [];
  let projects = [project("invoicing", "Invoicing", { foremanTemplate: "billing" }), project("website", "Website"), project("shop", "Shop"), project("invoicing_2", "a session", { parent: "invoicing" })];
  let workers: AttachedWorker[] = [];
  const told: Array<[string, string]> = [];
  const notified: StoredApproval[] = [];
  const path = join(ROOT, "config", `specialists-${Math.random().toString(36).slice(2)}.json`);
  const dir = join(ROOT, "state", `attach-${Math.random().toString(36).slice(2)}`);
  let now = Date.parse("2026-11-12T12:00:00Z");
  const deps: AttachDeps = {
    approvals: { load: () => list, save: (next) => (list = next) },
    notify: async (approval) => void notified.push(approval),
    tell: (owner, text) => void told.push([owner, text]),
    log: () => undefined,
    projects: async () => projects,
    read: (id) => specialists.readSpecialist(id, path),
    apply: (id, repo, on, known, by, actor) => specialists.setAttached(id, repo, on, known, by, actor, now, path),
    keep: (id, proposal) => attach.keepAttachProposal(id, proposal, dir),
    take: (id) => attach.takeAttachProposal(id, dir),
    crew: (target) => (NAMES[target.id] ? { name: NAMES[target.id]! } : undefined),
    workers: async () => workers,
    now: () => (now += 1000),
  };
  const answer = (id: string, state: "allowed" | "denied", extra: Partial<StoredApproval> = {}) => attach.settleAttachApproval(deps, { ...list.find((a) => a.id === id)!, state, ...extra }, "person:desk_1");
  return {
    deps, told, notified, answer, dir, path,
    approvals: () => list,
    repos: (id: string) => specialists.readSpecialist(id, path)?.repos ?? [],
    setProjects: (next: Project[]) => (projects = next),
    projects: () => projects,
    setWorkers: (next: AttachedWorker[]) => (workers = next),
  };
}

test("the person attaches and detaches a project themselves, with no card", async () => {
  const h = harness();
  const done = await attach.attachByPerson(h.deps, { id: "invoicing", project: "shop" }, "person:desk_1");
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.repos, ["shop"]);
  assert.match(String(done.body.note), /next conversation/);
  assert.deepEqual(h.repos("invoicing"), ["shop"]);
  assert.equal(h.notified.length, 0, "their own act asks nothing");

  // Again changes nothing; a project by its name; never its own, a session or one that is not here.
  assert.equal((await attach.attachByPerson(h.deps, { id: "invoicing", project: "shop" }, "person:desk_1")).body.unchanged, true);
  assert.equal((await attach.attachByPerson(h.deps, { id: "invoicing", project: "website" }, "person:desk_1")).status, 200);
  assert.deepEqual(h.repos("invoicing"), ["shop", "website"]);
  const own = await attach.attachByPerson(h.deps, { id: "invoicing", project: "invoicing" }, "person:desk_1");
  assert.equal(own.status, 400);
  assert.match(String(own.body.error), /Rosa already works on Invoicing/);
  assert.equal((await attach.attachByPerson(h.deps, { id: "invoicing", project: "invoicing_2" }, "person:desk_1")).status, 404);
  assert.equal((await attach.attachByPerson(h.deps, { id: "nobody", project: "shop" }, "person:desk_1")).status, 404);
  assert.equal((await attach.attachByPerson(h.deps, { id: "invoicing" }, "person:desk_1")).status, 400);

  const off = await attach.detach(h.deps, { id: "invoicing", project: "shop" }, "person", "person:desk_1");
  assert.equal(off.status, 200);
  assert.deepEqual(h.repos("invoicing"), ["website"]);
  assert.equal((await attach.detach(h.deps, { id: "invoicing", project: "shop" }, "person", "person:desk_1")).body.unchanged, true);
});

test("a specialist is attached to at most 8 projects", async () => {
  const h = harness();
  h.setProjects([...h.projects(), ...Array.from({ length: 9 }, (_, n) => project(`extra-${n}`, `Extra ${n}`))]);
  for (let n = 0; n < 8; n += 1) assert.equal((await attach.attachByPerson(h.deps, { id: "invoicing", project: `extra-${n}` }, "person:desk_1")).status, 200, String(n));
  const over = await attach.attachByPerson(h.deps, { id: "invoicing", project: "extra-8" }, "person:desk_1");
  assert.equal(over.status, 409);
  assert.match(String(over.body.error), /8 projects already.*detach one first/);
  assert.equal((await attach.proposeAttach(h.deps, "lead_laptop_____", { specialist: "Rosa", project: "extra-8" })).status, 409);
  assert.equal(h.repos("invoicing").length, 8);
});

test("the Lead's attach is one card naming the specialist, the project and its folder; only the person's Allow attaches", async () => {
  const h = harness();
  const asked = await attach.proposeAttach(h.deps, "lead_laptop_____", { specialist: "@rosa", project: "Shop" });
  assert.equal(asked.status, 202);
  assert.deepEqual(h.repos("invoicing"), [], "nothing changes before the person answers");
  const card = h.notified[0]!;
  assert.equal(card.kind, "specialist-attach");
  assert.equal(card.title, "Attach Rosa to Shop?");
  assert.match(card.body, /\/p\/shop/);
  assert.match(card.body, /Rosa can read this project's files and start Workers that change them\. Every change still comes to you before it is published\./);
  assert.deepEqual(card.attach?.repo, { id: "shop", name: "Shop", path: "/p/shop" });

  // Never Cobra's to allow: not on Instinct, not by the judge, not by an Allow recorded as hers.
  assert.ok(!ACTS_ALONE.has("specialist-attach"));
  assert.equal(actsAlone(card, () => true), null, "Instinct leaves it to the person");
  assert.equal(dueForJudge([card], Date.parse(card.createdAt) + 30 * 24 * 60 * 60_000).length, 0, "the judge never answers one left waiting");

  const allowed = await h.answer(card.id, "allowed");
  assert.equal(allowed.results?.[0]?.ok, true);
  assert.deepEqual(h.repos("invoicing"), ["shop"]);
  assert.match(h.told.at(-1)![1], /Rosa \(invoicing\) is attached to Shop \(shop\)/);
  assert.equal(h.told.at(-1)![0], "lead");
});

test("an Allow that was Cobra's own, a denied card and a changed proposal attach nothing", async () => {
  const h = harness();
  const first = (await attach.proposeAttach(h.deps, "lead_laptop_____", { specialist: "invoicing", project: "shop" })).body.approval as string;
  const hers = await h.answer(first, "allowed", { allowedBy: "cobra" });
  assert.equal(hers.results?.[0]?.ok, false);
  assert.match(hers.results![0]!.message, /Only you can attach/);
  assert.deepEqual(h.repos("invoicing"), []);

  const second = (await attach.proposeAttach(h.deps, "lead_laptop_____", { specialist: "invoicing", project: "shop" })).body.approval as string;
  await h.answer(second, "denied");
  assert.deepEqual(h.repos("invoicing"), []);
  assert.match(h.told.at(-1)![1], /declined attaching Rosa to Shop/);

  // The kept proposal swapped for another project after the card was made: the hash no longer matches.
  const third = (await attach.proposeAttach(h.deps, "lead_laptop_____", { specialist: "invoicing", project: "shop" })).body.approval as string;
  attach.keepAttachProposal(third, { id: "invoicing", repo: "website" }, h.dir);
  const swapped = await h.answer(third, "allowed");
  assert.equal(swapped.results?.[0]?.ok, false);
  assert.deepEqual(h.repos("invoicing"), []);
  assert.match(h.told.at(-1)![1], /not the one on the card/);

  // The project re-made in another folder under the same id: not what the person read.
  const fourth = (await attach.proposeAttach(h.deps, "lead_laptop_____", { specialist: "invoicing", project: "shop" })).body.approval as string;
  h.setProjects(h.projects().map((p) => (p.id === "shop" ? { ...p, path: "/elsewhere/shop" } : p)));
  const moved = await h.answer(fourth, "allowed");
  assert.equal(moved.results?.[0]?.ok, false);
  assert.deepEqual(h.repos("invoicing"), []);
});

test("asking again for the same pair replaces the card not yet answered; one already attached asks nothing", async () => {
  const h = harness();
  const first = (await attach.proposeAttach(h.deps, "lead_laptop_____", { specialist: "invoicing", project: "shop" })).body.approval as string;
  const second = (await attach.proposeAttach(h.deps, "lead_laptop_____", { specialist: "invoicing", project: "shop" })).body.approval as string;
  assert.equal(h.approvals().find((a) => a.id === first)?.state, "expired");
  assert.equal(attach.takeAttachProposal(first, h.dir), null, "the replaced card's proposal is gone");
  await h.answer(second, "allowed");
  const again = await attach.proposeAttach(h.deps, "lead_laptop_____", { specialist: "invoicing", project: "shop" });
  assert.equal(again.status, 200);
  assert.equal(again.body.unchanged, true);
});

test("detach is refused while a Worker the specialist started there still runs, and names it", async () => {
  const h = harness();
  await attach.attachByPerson(h.deps, { id: "invoicing", project: "shop" }, "person:desk_1");
  h.setWorkers([
    { id: "shop_3", name: "shop_3", parent: "shop", owner: "invoicing", running: true },
    // Someone else's Worker there, and its own that has stopped, do not hold it.
    { id: "shop_4", name: "shop_4", parent: "shop", owner: "shop", running: true },
    { id: "shop_5", name: "shop_5", parent: "shop", owner: "invoicing", running: false },
  ]);
  const held = await attach.detach(h.deps, { specialist: "Rosa", project: "shop" }, "lead", "lead_laptop_____", { specialist: "specialist", repo: "project" });
  assert.equal(held.status, 409);
  assert.match(String(held.body.error), /Rosa still has work running in Shop \(shop_3\)\. Stop it or let it finish, then detach\./);
  assert.deepEqual(held.body.workers, ["shop_3"]);
  assert.deepEqual(h.repos("invoicing"), ["shop"]);

  h.setWorkers([{ id: "shop_4", name: "shop_4", parent: "shop", owner: "shop", running: true }]);
  assert.equal((await attach.detach(h.deps, { specialist: "Rosa", project: "shop" }, "lead", "lead_laptop_____", { specialist: "specialist", repo: "project" })).status, 200);
  assert.deepEqual(h.repos("invoicing"), []);
});

test("the record: a change to the title keeps the attached projects, a gone project is ignored and dropped on the next write", () => {
  const path = join(ROOT, "config", "record.json");
  const known = new Set(["invoicing", "shop", "website"]);
  const now = Date.parse("2026-11-12T12:00:00Z");
  specialists.setAttached("invoicing", "shop", true, known, "person", "person:desk_1", now, path);
  specialists.setAttached("invoicing", "website", true, known, "person", "person:desk_1", now, path);
  specialists.setAttached("invoicing", "shop", true, known, "person", "person:desk_1", now, path);
  assert.deepEqual(specialists.readSpecialist("invoicing", path)?.repos, ["website", "shop"], "no duplicates");
  assert.throws(() => specialists.setAttached("invoicing", "invoicing", true, known, "person", "person:desk_1", now, path), /its own project/);

  specialists.setSpecialist("invoicing", { title: "Invoices" }, "person", "person:desk_1", now, path);
  const kept = specialists.readSpecialist("invoicing", path)!;
  assert.equal(kept.title, "Invoices");
  assert.deepEqual(kept.repos, ["website", "shop"]);

  // The website project is gone: it gives nothing now, and the next write drops it.
  const here = [project("invoicing", "Invoicing"), project("shop", "Shop"), project("shop_2", "a session", { parent: "shop" })];
  assert.deepEqual(specialists.attachedRepos("invoicing", here, path).map((p) => p.id), ["shop"]);
  assert.deepEqual(specialists.attachedRepos("nobody", here, path), []);
  specialists.setAttached("invoicing", "shop", false, new Set(["invoicing", "shop"]), "person", "person:desk_1", now, path);
  const after = specialists.readSpecialist("invoicing", path)!;
  assert.equal(after.repos, undefined);
  assert.equal(after.title, "Invoices", "detaching keeps the rest of the record");

  // The roster names each attached project that is still here.
  specialists.setAttached("invoicing", "shop", true, new Set(["invoicing", "shop"]), "person", "person:desk_1", now, path);
  const views = specialists.specialistViews(here, () => undefined, { path, crewPath: join(ROOT, "config", "crew-record.json") });
  assert.deepEqual(views.find((view) => view.id === "invoicing")?.repos, [{ id: "shop", name: "Shop", path: "/p/shop" }]);
  assert.deepEqual(views.find((view) => view.id === "shop")?.repos, []);
});

test("a record with a list that is not one is not read", async () => {
  const { mkdirSync } = await import("node:fs");
  const { writePrivateFile } = await import("./private.ts");
  const path = join(ROOT, "config", "bad.json");
  mkdirSync(join(ROOT, "config"), { recursive: true });
  const base = { updatedAt: "2026-11-12T12:00:00.000Z", updatedBy: "person" };
  writePrivateFile(path, JSON.stringify({ specialists: { a: { ...base, repos: "shop" }, b: { ...base, repos: Array.from({ length: 9 }, (_, n) => `r${n}`) }, c: { ...base, repos: ["shop"] } } }));
  assert.deepEqual(Object.keys(specialists.loadSpecialists(path).specialists), ["c"]);
});
