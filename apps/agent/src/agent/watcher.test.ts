import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectState, PushData } from "@cobra/contracts";

import {
  compose,
  DEBOUNCE_MS,
  detectTransitions,
  remember,
  routed,
  shouldSend,
  startWatcher,
} from "./watcher.ts";
import type { Recipient } from "./push.ts";

// A computer with --name set would name every push after itself, not the machine given.
delete process.env.COBRA_MACHINE_NAME;

function project(patch: Partial<ProjectState>): ProjectState {
  return {
    id: "stable",
    name: "Plant Shop",
    machine: "omarchy",
    path: "/home/me/Projects/plant-shop",
    session: "plant-shop",
    activity: "agent-working",
    lastActivityAt: null,
    command: "claude",
    attached: false,
    needsInput: false,
    tail: [],
    ...patch,
  };
}

test("an agent stopping to ask is a needs-input edge", () => {
  const before = remember([project({ activity: "agent-working" })]);
  const after = [project({ activity: "agent-idle", needsInput: true })];
  assert.deepEqual(
    detectTransitions(before, after).map((t) => t.kind),
    ["needs-input"],
  );
});

test("a dialog that stays up is not re-reported", () => {
  const before = remember([project({ activity: "agent-idle", needsInput: true })]);
  const after = [project({ activity: "agent-idle", needsInput: true })];
  assert.deepEqual(detectTransitions(before, after), []);
});

test("working to idle without a dialog is a finish", () => {
  const before = remember([project({ activity: "agent-working" })]);
  const after = [project({ activity: "agent-idle" })];
  assert.deepEqual(detectTransitions(before, after).map((t) => t.kind), ["finished"]);
});

test("idle to idle, shells, and sessions that vanish are nothing", () => {
  const before = remember([
    project({ id: "a", activity: "agent-idle" }),
    project({ id: "b", activity: "agent-working" }),
    project({ id: "c", activity: "busy" }),
  ]);
  const after = [project({ id: "a", activity: "agent-idle" }), project({ id: "c", activity: "idle" })];
  assert.deepEqual(detectTransitions(before, after), []);
});

test("a project never seen before is a baseline, not an alert", () => {
  const after = [project({ needsInput: true })];
  assert.deepEqual(detectTransitions(new Map(), after), []);
});

test("the same alert is held for a minute, per project and kind", () => {
  const lastSent = new Map<string, number>();
  const needs = { kind: "needs-input" as const, project: project({}) };
  const done = { kind: "finished" as const, project: project({}) };
  const other = { kind: "needs-input" as const, project: project({ id: "book" }) };
  assert.equal(shouldSend(lastSent, needs, 1000), true);
  assert.equal(shouldSend(lastSent, needs, 1000 + DEBOUNCE_MS - 1), false);
  assert.equal(shouldSend(lastSent, done, 1000), true, "a different kind is not held");
  assert.equal(shouldSend(lastSent, other, 1000), true, "a different project is not held");
  assert.equal(shouldSend(lastSent, needs, 1000 + DEBOUNCE_MS), true);
});

test("the message names the project, previews the screen, and carries the route", () => {
  const message = compose("omarchy", {
    kind: "needs-input",
    project: project({ tail: ["Bash command", "touch hello.txt"], dialog: "permission" }),
  });
  assert.equal(message.title, "Plant Shop needs you");
  assert.equal(message.body, "Bash command touch hello.txt");
  assert.equal(message.category, "permission", "a permission prompt gets Allow/Deny");
  assert.deepEqual(message.data, {
    machine: "omarchy",
    projectId: "stable",
    session: "plant-shop",
    path: "/home/me/Projects/plant-shop",
    dialog: "permission",
  });

  const question = compose("omarchy", {
    kind: "needs-input",
    project: project({ dialog: "question" }),
  });
  assert.equal(question.category, "dialog", "a question only gets Open/Dismiss");

  const quiet = compose("omarchy", { kind: "finished", project: project({ tail: [] }) });
  assert.equal(quiet.title, "Plant Shop finished");
  assert.equal(quiet.body, "Cobra is idle");
  assert.equal(quiet.category, undefined);
  assert.equal("dialog" in quiet.data, false);
});

test("the running watcher: baseline first, then one push per edge, none without a phone", async () => {
  const sent: string[] = [];
  let projects: ProjectState[] = [project({ activity: "agent-working" })];
  let tokens: Recipient[] = [];
  const stop = startWatcher({
    collect: async () => ({ machine: "omarchy", projects }),
    tokens: async () => tokens,
    send: async (_to, message) => {
      sent.push(message.title);
      return { dead: [], errors: [] };
    },
    forget: async () => {},
    intervalMs: 2,
    log: () => {},
  });
  const ticks = (n: number) => new Promise((resolve) => setTimeout(resolve, n * 2 + 5));

  // No phone registered: nothing is even remembered.
  projects = [project({ activity: "agent-idle" })];
  await ticks(3);
  assert.deepEqual(sent, []);

  // A phone appears while the agent is idle: that is the baseline, not news.
  tokens = [{ token: "ExponentPushToken[abc]" }];
  await ticks(3);
  assert.deepEqual(sent, []);

  projects = [project({ activity: "agent-working" })];
  await ticks(3);
  projects = [project({ activity: "agent-idle", needsInput: true, tail: ["Bash command"] })];
  await ticks(3);
  assert.deepEqual(sent, ["Plant Shop needs you"]);

  // The dialog stays up: still one alert.
  await ticks(3);
  assert.deepEqual(sent, ["Plant Shop needs you"]);
  stop();
});

const REQUEST = {
  headline: "Install packages",
  plain: "Cobra wants to run: pnpm add zod. This would use the internet.",
  why: "Installing software always waits for your OK.",
  exact: "pnpm add zod",
  by: "template",
};

test("a permission prompt's push says what it asks in plain words, not the screen's last lines", () => {
  const message = compose("omarchy", {
    kind: "needs-input",
    project: project({ dialog: "permission", needsInput: true, tail: ["Bash command", "pnpm add z…"], request: REQUEST }),
  });
  assert.equal(message.body, "Install packages\nCobra wants to run: pnpm add zod. This would use the internet.");
  assert.equal(message.category, "permission");
  // A Worker's prompt that may be allowed for its task gets For this task on the lock screen too.
  const scoped = compose("omarchy", {
    kind: "needs-input",
    project: project({ dialog: "permission", needsInput: true, request: { ...REQUEST, allow: { scopes: ["once", "task", "project", "always"], hosts: ["registry.npmjs.org"], project: "a/b" } } }),
  });
  assert.equal(scoped.category, "permission-task");
  // A finish is not about the prompt, even if one was last seen.
  assert.equal(compose("omarchy", { kind: "finished", project: project({ tail: ["done"], request: REQUEST }) }).body, "done");
});

test("a permission push carries its dialog's key, so the lock-screen Allow answers only that prompt", () => {
  const keyed = compose("omarchy", {
    kind: "needs-input",
    project: project({ dialog: "permission", needsInput: true, request: { ...REQUEST, key: "0123abcd".repeat(4) } }),
  });
  assert.equal((keyed.data as PushData).dialogKey, "0123abcd".repeat(4));
  const unkeyed = compose("omarchy", { kind: "needs-input", project: project({ dialog: "permission", needsInput: true, request: REQUEST }) });
  assert.equal((unkeyed.data as PushData).dialogKey, undefined);
  const question = compose("omarchy", { kind: "needs-input", project: project({ dialog: "question", needsInput: true, request: { ...REQUEST, key: "k" } }) });
  assert.equal((question.data as PushData).dialogKey, undefined);
});

test("the push waits for the plain-words rewrite, and goes with the template when it fails", async () => {
  for (const [explain, body] of [
    [async () => ({ ...REQUEST, plain: "Cobra wants to add zod, downloaded from the internet.", by: "ai" }), "Install packages\nCobra wants to add zod, downloaded from the internet."],
    [async () => Promise.reject(new Error("timed out")), `Install packages\n${REQUEST.plain}`],
  ] as const) {
    const bodies: string[] = [];
    let projects: ProjectState[] = [project({ activity: "agent-working" })];
    const stop = startWatcher({
      collect: async () => ({ machine: "omarchy", projects }),
      tokens: async () => [{ token: "ExponentPushToken[abc]" }],
      send: async (_to, message) => {
        bodies.push(message.body);
        return { dead: [], errors: [] };
      },
      forget: async () => {},
      explain,
      intervalMs: 2,
      log: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    projects = [project({ activity: "agent-idle", needsInput: true, dialog: "permission", request: REQUEST })];
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();
    assert.deepEqual(bodies, [body]);
  }
});

import { compose as composeGitPush, DEBOUNCE_BY_KIND, detectGradeTransitions, rememberGrades } from "./watcher.ts";

function graded(id: string, grade: string, extra: Record<string, unknown> = {}): ProjectState {
  return {
    id,
    name: id,
    machine: "omarchy",
    path: `/home/me/${id}`,
    session: id,
    activity: "none",
    lastActivityAt: null,
    command: null,
    attached: false,
    git: { branch: "main", dirty: true, ahead: 0, grade, ...extra },
  } as ProjectState;
}

test("grade edges: only into Unpushed or Diverged, only for projects graded before", () => {
  const before = rememberGrades([graded("a", "Working"), graded("b", "Clean"), graded("c", "Unpushed")]);
  const now = [graded("a", "Unpushed"), graded("b", "Diverged"), graded("c", "Unpushed"), graded("d", "Unpushed"), graded("e", "Clean")];
  assert.deepEqual(
    detectGradeTransitions(before, now).map((t) => [t.kind, t.project.id]),
    [["unpushed", "a"], ["diverged", "b"]],
  );
});

test("an unpushed push carries the Park category and lands on the repo screen; a diverged one has no buttons", () => {
  const unpushed = composeGitPush("omarchy", { kind: "unpushed", project: graded("book-club", "Unpushed", { dirtySince: new Date(Date.now() - 3 * 3_600_000).toISOString() }) });
  assert.equal(unpushed.category, "unpushed");
  assert.match(unpushed.title, /book-club has uncommitted work/);
  assert.match(unpushed.body, /On omarchy for 3h/);
  assert.equal((unpushed.data as { git?: string }).git, "unpushed");
  const diverged = composeGitPush("macbook", { kind: "diverged", project: graded("x", "Diverged", { mainAhead: 2 }) });
  assert.equal(diverged.category, undefined);
  assert.match(diverged.body, /2 local commits not on origin/);
  assert.ok(DEBOUNCE_BY_KIND.unpushed >= 24 * 3_600_000);
});

test("a linked phone with no push token still gets the event log; nobody linked, nothing", async () => {
  const recorded: string[] = [];
  let projects: ProjectState[] = [project({ activity: "agent-working" })];
  let linked = false;
  const stop = startWatcher({
    collect: async () => ({ machine: "omarchy", projects }),
    tokens: async () => [],
    send: async () => {
      throw new Error("no push without a token");
    },
    forget: async () => {},
    record: (transitions) => recorded.push(...transitions.map((t) => `${t.kind}:${t.project.id}`)),
    active: () => linked,
    intervalMs: 2,
    log: () => {},
  });
  const ticks = (n: number) => new Promise((resolve) => setTimeout(resolve, n * 2 + 5));
  projects = [project({ activity: "agent-idle" })];
  await ticks(3);
  assert.equal(recorded.length, 0, "nobody linked: nothing recorded");
  linked = true;
  projects = [project({ activity: "agent-working" })];
  await ticks(3);
  projects = [project({ activity: "agent-idle" })];
  await ticks(3);
  stop();
  assert.ok(recorded.includes(`finished:${projects[0]!.id}`), recorded.join(","));
});

test("routing: a short turn of yours is quiet, a long one pushes, a briefed Foreman's Worker's question goes to Cobra", () => {
  const mine = project({ activity: "agent-working" });
  const worker = project({ id: "stable_2", parent: "stable", worker: { owner: "stable", task: "t", model: "sonnet" }, activity: "agent-working" });
  const before = remember([mine, worker], null, 0);
  const idle = [{ ...mine, activity: "agent-idle" as const }, { ...worker, activity: "agent-idle" as const, needsInput: true, dialog: "question" as const }];
  const transitions = detectTransitions(before, idle);
  assert.deepEqual(transitions.map((t) => [t.kind, t.project.id]), [["finished", "stable"], ["needs-input", "stable_2"]]);
  const briefed = (id: string) => id === "stable";
  assert.deepEqual(routed(transitions, before, briefed, 60_000), [], "a minute's turn, and a Worker the Lead hears of");
  assert.deepEqual(routed(transitions, before, briefed, 3 * 60_000).map((t) => t.project.id), ["stable"]);
  assert.deepEqual(routed(transitions, before, () => false, 60_000).map((t) => t.project.id), ["stable_2"], "with no Lead above, its question is yours");
  const asking = detectTransitions(before, [{ ...worker, activity: "agent-idle" as const, needsInput: true, dialog: "permission" as const }]);
  assert.deepEqual(routed(asking, before, briefed, 60_000).map((t) => t.project.id), ["stable_2"], "its permission prompt is yours under Cobra too");
});

test("remember keeps when the watcher first saw a turn, across ticks", () => {
  const first = remember([project({ activity: "agent-working" })], null, 1000);
  const second = remember([project({ activity: "agent-working" })], first, 9000);
  assert.equal(second.get("stable")?.workingAt, 1000);
  assert.equal(remember([project({ activity: "agent-working", workingSince: "2026-10-12T10:00:00.000Z" })], null, 1).get("stable")?.workingAt, Date.parse("2026-10-12T10:00:00.000Z"));
  assert.equal(remember([project({ activity: "agent-idle" })], second, 10_000).get("stable")?.workingAt, undefined);
});

test("the running watcher tells a linked desk what it would push, phone or not, and the Lead's run once", async () => {
  const sent: string[] = [];
  const told: string[] = [];
  const lead = project({ id: "cobra_lead", name: "Lead", session: "cobra_lead", lead: true, activity: "agent-working", tail: ["Done: #12 merged."] });
  let projects: ProjectState[] = [project({ activity: "agent-idle" }), lead];
  let clock = 0;
  const stop = startWatcher({
    collect: async () => ({ machine: "omarchy", projects }),
    tokens: async () => [],
    active: () => true,
    send: async (_to, message) => {
      sent.push(message.title);
      return { dead: [], errors: [] };
    },
    forget: async () => {},
    notice: (notice) => told.push(`${notice.kind}: ${notice.title}`),
    now: () => clock,
    intervalMs: 2,
    log: () => {},
  });
  const ticks = (n: number) => new Promise((resolve) => setTimeout(resolve, n * 2 + 5));
  await ticks(3);
  projects = [project({ activity: "agent-idle", needsInput: true }), lead];
  await ticks(3);
  clock = 10 * 60_000;
  projects = [project({ activity: "agent-idle" }), { ...lead, activity: "agent-idle" }];
  await ticks(3);
  clock += 2 * 60_000;
  await ticks(3);
  stop();
  assert.deepEqual(sent, [], "no phone, no push");
  assert.deepEqual(told, ["needs-input: Plant Shop needs you", "run-done: Cobra finished"]);
});

import { speaker } from "./watcher.ts";

test("a push says who in the app's words: Cobra, a Foreman by name, a Worker by its title", () => {
  assert.equal(speaker({ name: "Lead", lead: true }), "Cobra");
  assert.equal(speaker({ name: "cobra · Foreman", foreman: true, parent: "cobra", crew: { name: "Juno", look: 0, hat: 1 } }), "Cobra (cobra)");
  assert.equal(speaker({ name: "The Book · Foreman", foreman: true, parent: "book" }), "Cobra (The Book)");
  assert.equal(speaker({ name: "cobra · fix/push-badge", parent: "cobra", worker: { owner: "cobra", task: "t", model: "sonnet" }, title: "Push Badge Count Fix" }), "Cobra (cobra)");
  assert.equal(speaker({ name: "cobra · pi", parent: "cobra", worker: { owner: "you", task: "", model: "local:qwen" }, title: "Your Pi Session" }), "Your Pi Session");
  assert.equal(speaker({ name: "web-app" }), "web-app");
});
