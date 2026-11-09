import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectState } from "@cobra/contracts";

import { createRecorder, labelOf, localDay, pruneTimeline, readHistory, stateOfProject } from "./timeline.ts";

const at = (h: number, m = 0) => new Date(2026, 9, 9, h, m).getTime();
const project = (id: string, activity: string, extra: Partial<ProjectState> = {}) =>
  ({ id, name: id, machine: "legion", path: `/p/${id}`, session: id, activity, lastActivityAt: null, ...extra }) as unknown as ProjectState;

test("a session's chart state: work, wait, idle; a shell is not an agent; an ended Worker is stopped", () => {
  assert.equal(stateOfProject(project("a", "agent-working")), "work");
  assert.equal(stateOfProject(project("a", "agent-working", { needsInput: true })), "wait");
  assert.equal(stateOfProject(project("a", "agent-idle")), "idle");
  assert.equal(stateOfProject(project("a", "idle")), null);
  assert.equal(stateOfProject(project("a", "busy")), null);
  assert.equal(stateOfProject(project("a", "none")), null);
  assert.equal(stateOfProject(project("a", "none", { worker: { owner: "lead", task: "t", model: "haiku" } })), "stopped");
});

test("a session's lane is called by its title, else its branch made readable; the Lead and Foreman keep their words", () => {
  const worker = { parent: "cobra", branch: "docs/lab-ste-guide-setup" };
  assert.equal(labelOf(project("a", "agent-working", { ...worker, title: "Lab STE Setup Guide" })), "Lab STE Setup Guide");
  assert.equal(labelOf(project("a", "agent-working", worker)), "Lab ste guide setup");
  assert.equal(labelOf(project("a", "agent-working", { lead: true })), "Lead");
  // The Foreman's lane names the project it serves (foremanProject), never a branch or title.
  assert.equal(labelOf(project("a", "agent-working", { ...worker, foreman: true, name: "Cobra · Foreman" })), "Cobra · Foreman");
  assert.equal(labelOf(project("Cobra", "agent-working")), "Cobra");
});

test("lines only on a change; lanes from them; a dropped agent stops; the queue has lanes", () => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-"));
  const rec = createRecorder(dir);
  const lead = project("cobra_lead", "agent-working", { lead: true });
  const worker = project("cobra_2", "agent-working", { parent: "cobra", branch: "fix/badge", worker: { owner: "lead", task: "t", model: "haiku" } });
  assert.equal(rec.recordStates([lead, worker], [], at(9)), 2);
  assert.equal(rec.recordStates([lead, worker], [], at(9, 1)), 0);
  rec.recordStates([lead, { ...worker, needsInput: true } as ProjectState], [{ id: "q_1", project: "stable", task: "update deps" }], at(10));
  rec.recordStates([lead], [], at(11));
  const file = join(dir, `${localDay(at(9))}.jsonl`);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const history = readHistory({ now: at(12), dir, days: 2 });
  const byId = Object.fromEntries(history.lanes.map((lane) => [lane.id, lane]));
  assert.equal(byId.cobra_lead?.kind, "lead");
  assert.equal(byId.cobra_lead?.label, "Lead");
  assert.deepEqual(byId.cobra_lead?.segments.map((s) => [s.state, s.to === null]), [["work", true]]);
  // Called by its branch made readable: no title had arrived.
  assert.equal(byId.cobra_2?.label, "Badge");
  assert.equal(byId.cobra_2?.project, "cobra");
  assert.deepEqual(byId.cobra_2?.segments.map((s) => s.state), ["work", "wait"]);
  assert.equal(byId.cobra_2?.segments.at(-1)?.to, new Date(at(11)).toISOString());
  assert.equal(byId.q_1?.kind, "queued");
  assert.deepEqual(byId.q_1?.segments.map((s) => s.state), ["queue"]);
});

test("a Foreman's lane is named for its project", () => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-"));
  const rec = createRecorder(dir);
  rec.recordStates([project("cobra_fm", "agent-idle", { parent: "cobra", foreman: true, name: "Cobra Integrated · Foreman" })], [], at(9));
  const [lane] = readHistory({ now: at(10), dir, days: 1 }).lanes;
  assert.equal(lane?.label, "Cobra Integrated · Foreman");
  assert.equal(lane?.project, "cobra");
});

test("daily counts, a merge seen twice counted once, a Foreman sees only its project", () => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-"));
  const rec = createRecorder(dir);
  rec.recordCount("worker-started", "cobra_2", "cobra", at(9));
  rec.recordCount("worker-started", "stable_2", "stable", at(9, 5));
  rec.recordCount("pr-opened", "u", "cobra", at(10));
  rec.recordCount("pr-merged", "o/cobra#24", "cobra", at(11));
  rec.recordCount("pr-merged", "o/cobra#24", "cobra", at(11, 10));
  rec.recordCount("answered", "cobra_2", undefined, at(11, 20));
  rec.recordCount("worker-started", "old", "cobra", at(9) - 24 * 60 * 60_000);
  const all = readHistory({ now: at(12), dir, days: 3 });
  assert.deepEqual(all.days.map((d) => d.date), [localDay(at(9) - 2 * 86_400_000), localDay(at(9) - 86_400_000), localDay(at(9))]);
  assert.deepEqual(all.days.at(-1), { date: localDay(at(9)), started: 2, opened: 1, merged: 1, answered: 1 });
  assert.equal(all.days.at(-2)?.started, 1);
  const foreman = readHistory({ now: at(12), dir, days: 1, only: "cobra" });
  assert.deepEqual(foreman.days.at(-1), { date: localDay(at(9)), started: 1, opened: 1, merged: 1, answered: 0 });
});

test("today's counts one by one, with their titles, a merge seen twice once", () => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-"));
  const rec = createRecorder(dir);
  rec.recordCount("worker-started", "old", "cobra", at(9) - 24 * 60 * 60_000);
  rec.recordCount("pr-opened", "https://github.com/o/cobra/pull/24", "cobra", at(10), "Fix the login");
  rec.recordCount("pr-merged", "o/cobra#24", undefined, at(11), "Fix the login");
  rec.recordCount("pr-merged", "o/cobra#24", "cobra", at(11, 10));
  rec.recordCount("answered", "cobra_2", undefined, at(11, 20));
  const { done } = readHistory({ now: at(12), dir, days: 1 });
  assert.deepEqual(done, [
    { at: new Date(at(10)).toISOString(), kind: "pr-opened", detail: "https://github.com/o/cobra/pull/24", project: "cobra", title: "Fix the login" },
    { at: new Date(at(11)).toISOString(), kind: "pr-merged", detail: "o/cobra#24", title: "Fix the login" },
    { at: new Date(at(11, 20)).toISOString(), kind: "answered", detail: "cobra_2" },
  ]);
  // A Foreman sees its project's lines: the merge as its Worker recorded it.
  assert.deepEqual(readHistory({ now: at(12), dir, days: 1, only: "cobra" }).done?.map((d) => d.kind), ["pr-opened", "pr-merged"]);
});

test("files older than 14 days are removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-"));
  const now = at(12);
  const old = join(dir, `${localDay(now - 15 * 86_400_000)}.jsonl`);
  const kept = join(dir, `${localDay(now - 13 * 86_400_000)}.jsonl`);
  writeFileSync(old, "{}\n");
  writeFileSync(kept, "{}\n");
  writeFileSync(join(dir, "notes.txt"), "x");
  pruneTimeline(now, dir);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(kept), true);
  assert.equal(existsSync(join(dir, "notes.txt")), true);
  void readFileSync;
});
