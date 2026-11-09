import { test } from "node:test";
import assert from "node:assert/strict";

import { Approval, GitState, OrchProject, OrchWorker } from "./index.ts";

/** Local landing added optional fields only: what an older agent sends still parses, and so does the new shape. */

const approval = {
  id: "ap_1",
  machine: "legion",
  kind: "merge",
  title: "Merge PR #7?",
  body: "#7 fix (r)",
  createdAt: "2026-10-09T12:00:00Z",
  expiresAt: "2026-10-09T18:00:00Z",
  state: "pending",
  prs: [{ number: 7, title: "fix", repo: "o/r", head: "h", url: "u" }],
};

const land = { worker: "notes_2", project: "notes", branch: "feat/x", title: "feat: x", head: "a".repeat(40), base: "b".repeat(40), commits: 3, files: 4, insertions: 120, deletions: 8 };

test("Approval parses with and without lands; a land's result line has no number", () => {
  assert.equal(Approval.parse(approval).lands, undefined);
  const parsed = Approval.parse({ ...approval, kind: "land", lands: [land], state: "done", results: [{ ok: true, message: "merged #7" }, { ok: true, message: "landed feat/x as 9f8e7d6" }] });
  assert.deepEqual(parsed.lands, [land]);
  assert.equal(parsed.results?.[1]?.number, undefined);
  assert.throws(() => Approval.parse({ ...approval, lands: [{ ...land, head: undefined }] }));
});

test("OrchWorker carries local, OrchProject and GitState carry landing, all optional", () => {
  const worker = {
    id: "notes_2", machine: "legion", parent: "notes", parentName: "Notes", branch: "feat/x", path: "/p", session: "notes_2",
    owner: "lead", task: "t", model: "claude", createdAt: "x", phase: "finished", activity: null, needsInput: false, dialog: null, tail: [],
  };
  assert.equal(OrchWorker.parse(worker).local, undefined);
  const local = { head: land.head, base: land.base, branch: "feat/x", title: "t", body: "", commits: [{ sha: land.head, subject: "s" }], files: 1, insertions: 1, deletions: 0, paths: ["a"], behind: 0, landed: { sha: "c".repeat(40), at: "x" } };
  assert.deepEqual(OrchWorker.parse({ ...worker, local }).local, local);
  assert.equal(OrchProject.parse({ id: "a", name: "A", path: "/a" }).landing, undefined);
  // A string, not an enum: a value an older app does not know still parses.
  assert.equal(OrchProject.parse({ id: "a", name: "A", path: "/a", landing: "someday" }).landing, "someday");
  assert.equal(GitState.parse({ branch: "main", dirty: false, ahead: null, landing: "local" }).landing, "local");
});
