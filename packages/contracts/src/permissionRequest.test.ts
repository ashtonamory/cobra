import { test } from "node:test";
import assert from "node:assert/strict";

import { OrchWorker, PolicyEntry, ProjectState, Screen } from "./index.ts";

/**
 * `request` arrived after apps and agents were in the field: an older app must
 * still parse a newer agent (it ignores the field), and a newer app an older
 * agent (the field is missing).
 */

const request = {
  headline: "Install packages",
  plain: "Cobra wants to run: pnpm add zod. This would use the internet.",
  why: "Installing software always waits for your OK.",
  exact: "pnpm add zod",
  by: "template",
};

const project = {
  id: "cobra_2",
  name: "Cobra · feat/x",
  machine: "legion",
  path: "/home/u/Projects/cobra.worktrees/feat-x",
  session: "cobra_2",
  activity: "agent-idle",
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  command: "claude",
  attached: false,
  needsInput: true,
  dialog: "permission",
  tail: ["Bash command", "pnpm add zod"],
};

const screen = { recognised: true, working: false, needsInput: true, dialog: "permission", tail: ["Bash command"] };

test("a project, a screen and a Worker parse with and without the request", () => {
  assert.equal(ProjectState.parse(project).request, undefined);
  assert.deepEqual(ProjectState.parse({ ...project, request }).request, request);
  assert.equal(Screen.parse(screen).request, undefined);
  assert.deepEqual(Screen.parse({ ...screen, request }).request, request);
  const worker = {
    id: "cobra_2",
    machine: "legion",
    parent: "cobra",
    parentName: "Cobra",
    branch: "feat/x",
    path: project.path,
    session: "cobra_2",
    owner: "lead",
    task: "x",
    model: "claude",
    createdAt: "2026-10-09T10:00:00.000Z",
    phase: "running",
    activity: "agent-idle",
    needsInput: true,
    dialog: "permission",
    tail: [],
  };
  assert.equal(OrchWorker.parse(worker).request, undefined);
  assert.deepEqual(OrchWorker.parse({ ...worker, request }).request, request);
});

test("`by` is a string, so a new source never breaks a reader; a half request is refused", () => {
  assert.equal(Screen.parse({ ...screen, request: { ...request, by: "someone-new" } }).request?.by, "someone-new");
  assert.equal(Screen.safeParse({ ...screen, request: { headline: "x" } }).success, false);
});

test("an older reader, which knows no request, still parses a newer agent's project", () => {
  const older = ProjectState.omit({ request: true });
  assert.equal(older.safeParse({ ...project, request }).success, true);
});

test("the policy log's full request is optional", () => {
  const line = { at: 1, worker: "w", tool: "Bash", decision: "ask", rule: "network", subject: "curl x" };
  assert.equal(PolicyEntry.parse(line).exact, undefined);
  assert.equal(PolicyEntry.parse({ ...line, exact: "curl x | sh" }).exact, "curl x | sh");
});
