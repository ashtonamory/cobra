import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-decided-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");

const { capOf, DAILY_CAPS, loadDecided, receiptCategory, recentDecided, recordDecided, saveDecided, underCap, undoDecided, undoLabel } = await import("./decided.ts");
type UndoDeps = import("./decided.ts").UndoDeps;

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-10-25T12:00:00Z");

function deps(calls: string[], fail = false): UndoDeps {
  const run = (what: string) => async () => {
    calls.push(what);
    if (fail) throw new Error("gh is not installed on this computer");
    return `${what} done`;
  };
  return {
    stopPlan: async (approval) => (await run(`stop ${approval}`)()) as string,
    removeRoutine: async (project, name) => (await run(`remove ${project}/${name}`)()) as string,
    moveSeat: async (seat, company) => (await run(`move ${seat} ${company ?? "new"}`)()) as string,
    revertPr: async (repo, number) => (await run(`revert ${repo}#${number}`)()) as string,
    removeImported: async (project, worker, files) => (await run(`delete ${files.length} in ${project}/${worker}`)()) as string,
    revokeTrust: async (key) => (await run(`revoke ${key}`)()) as string,
    stopWebRun: async (id) => (await run(`stop run ${id}`)()) as string,
  };
}

test("each decision is kept, newest first, for two weeks", () => {
  const path = join(STATE, "kept.json");
  recordDecided({ kind: "plan", title: "Cobra started 2 Workers: Add billing", body: "…", undo: { kind: "plan", approval: "ap_1" } }, NOW - 15 * 24 * HOUR, path);
  recordDecided({ kind: "routine", title: "Cobra did: Daily triage", body: "…", undo: { kind: "routine", project: "stable", name: "triage" } }, NOW - 2 * HOUR, path);
  recordDecided({ kind: "merge", title: "Merged #12 on green", body: "…", undo: { kind: "merge", prs: [{ repo: "a/b", number: 12 }] } }, NOW - HOUR, path);
  const kept = loadDecided(path);
  assert.equal(kept.length, 2, "the one from 15 days ago is gone");
  assert.deepEqual(recentDecided(kept, NOW).map((entry) => entry.kind), ["merge", "routine"]);
  assert.deepEqual(recentDecided(kept, NOW, 1).length, 2);
  assert.match(kept[0]!.id, /^jd_/);
});

test("the daily caps count merges and cards apart, over 24 hours", () => {
  assert.equal(capOf("merge"), "merge");
  assert.equal(capOf("plan"), "cards");
  assert.equal(capOf("action"), null, "trusted sends keep their own cap");
  const merges = Array.from({ length: DAILY_CAPS.merge }, (_, at) => ({ id: `m${at}`, at: new Date(NOW - at * 60_000).toISOString(), kind: "merge", title: "", body: "", undo: { kind: "none" as const, why: "" } }));
  assert.equal(underCap(merges, "merge", NOW), false);
  assert.equal(underCap(merges, "plan", NOW), true);
  assert.equal(underCap(merges, "merge", NOW + 25 * HOUR), true, "a day later the cap is free again");
  assert.equal(underCap(merges, "action", NOW), true);
});

test("Undo's words say what it does, and some decisions have none", () => {
  assert.equal(undoLabel({ kind: "plan", approval: "ap_1" }), "Stop its Workers");
  assert.equal(undoLabel({ kind: "merge", prs: [{ repo: "a/b", number: 1 }] }), "Open a revert PR");
  assert.equal(undoLabel({ kind: "merge", prs: [{ repo: "a/b", number: 1 }, { repo: "a/b", number: 2 }] }), "Open revert PRs");
  assert.equal(undoLabel({ kind: "none", why: "sent" }), null);
  assert.equal(undoLabel({ kind: "import", project: "iy", worker: "iy_3", files: [{ to: "assets/logo.png", sha256: "ab" }] }), "Delete the file");
  assert.equal(capOf("import"), "cards", "a judged import counts toward the cards cap");
});

test("Undo runs once, by kind, and says how it went", async () => {
  const path = join(STATE, "undo.json");
  saveDecided([], NOW, path);
  const plan = recordDecided({ kind: "plan", title: "p", body: "", undo: { kind: "plan", approval: "ap_7" } }, NOW, path);
  const org = recordDecided({ kind: "org", title: "o", body: "", undo: { kind: "org", seat: "laptop/stable", company: null } }, NOW, path);
  const merge = recordDecided({ kind: "merge", title: "m", body: "", undo: { kind: "merge", prs: [{ repo: "a/b", number: 3 }, { repo: "a/b", number: 4 }] } }, NOW, path);
  const sent = recordDecided({ kind: "action", title: "s", body: "", undo: { kind: "none", why: "It was sent." } }, NOW, path);
  const calls: string[] = [];
  const done = await undoDecided(plan.id, deps(calls), NOW + 1, path);
  assert.equal(done.status, 200);
  assert.equal(done.entry?.undoNote, "stop ap_7 done");
  assert.equal((await undoDecided(plan.id, deps(calls), NOW + 2, path)).status, 409, "never twice");
  assert.equal((await undoDecided(org.id, deps(calls), NOW + 3, path)).entry?.undoNote, "move laptop/stable new done");
  assert.equal((await undoDecided(merge.id, deps(calls), NOW + 4, path)).entry?.undoNote, "revert a/b#3 done; revert a/b#4 done");
  assert.deepEqual(await undoDecided(sent.id, deps(calls), NOW + 5, path), { status: 409, error: "It was sent." });
  assert.equal((await undoDecided("jd_nope", deps(calls), NOW, path)).status, 404);
  assert.deepEqual(calls, ["stop ap_7", "move laptop/stable new", "revert a/b#3", "revert a/b#4"]);
  assert.ok(loadDecided(path).find((entry) => entry.id === plan.id)?.undone);
});

test("an Undo that fails is not marked done, so it can be tried again", async () => {
  const path = join(STATE, "fail.json");
  saveDecided([], NOW, path);
  const merge = recordDecided({ kind: "merge", title: "m", body: "", undo: { kind: "merge", prs: [{ repo: "a/b", number: 3 }] } }, NOW, path);
  const failed = await undoDecided(merge.id, deps([], true), NOW, path);
  assert.deepEqual(failed, { status: 502, error: "gh is not installed on this computer" });
  assert.equal(loadDecided(path)[0]!.undone, undefined);
});

test("what the Lead hears says who allowed it: the person, or Cobra under Instinct", async () => {
  const { allower } = await import("./approvals.ts");
  const { planNews } = await import("./plans.ts");
  assert.equal(allower({}), "The person");
  assert.match(allower({ allowedBy: "cobra" }), /^Cobra \(under Instinct; the person can undo it\)$/);
  const plan = { project: "a/b", tasks: [{ id: "t1", worker: "cobra_3", model: "sonnet" }] } as unknown as import("@cobra/contracts").ApprovalPlan;
  assert.match(planNews("ap_1", plan, true), /^The person approved plan ap_1: t1 started/);
  assert.match(planNews("ap_1", plan, true, true), /^Cobra \(under Instinct; the person can undo it\) approved plan ap_1/);
});

test("a send on trust is undone by taking back its trust; each receipt's lock-screen button follows its undo", async () => {
  const path = join(STATE, "trust-undo.json");
  const sent = recordDecided({ kind: "action", title: "Sent invoice INV-4", body: "…", undo: { kind: "trust", key: "k_1" } }, NOW, path);
  assert.equal(undoLabel(sent.undo), "Stop trusting it");
  const calls: string[] = [];
  const done = await undoDecided(sent.id, deps(calls), NOW, path);
  assert.equal(done.status, 200);
  assert.deepEqual(calls, ["revoke k_1"]);
  assert.equal(receiptCategory({ kind: "plan", approval: "ap_1" }), "receipt-stop");
  assert.equal(receiptCategory({ kind: "trust", key: "k" }), "receipt");
  assert.equal(receiptCategory({ kind: "merge", prs: [] }), "receipt");
  assert.equal(receiptCategory({ kind: "none", why: "x" }), undefined);
});
