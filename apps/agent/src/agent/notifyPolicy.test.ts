import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectState } from "@cobra/contracts";

import {
  leadNotice,
  LONG_RUN_MS,
  NOTIFY_GAP_MS,
  pushesFinished,
  underLead,
  pushesNeedsInput,
  markHandled,
  QUESTION_GRACE_MS,
  RUN_SETTLE_MS,
  type Run,
  stepRun,
} from "./notifyPolicy.ts";

function project(patch: Partial<ProjectState>): ProjectState {
  return {
    id: "stable",
    name: "Plant Shop",
    machine: "omarchy",
    path: "/p/stable",
    session: "stable",
    activity: "agent-idle",
    lastActivityAt: null,
    command: "claude",
    attached: false,
    needsInput: false,
    tail: [],
    ...patch,
  };
}

const lead = project({ id: "cobra_lead", name: "Lead", session: "cobra_lead", lead: true });
const foreman = project({ id: "stable_fm", name: "Plant Shop · Foreman", session: "stable_fm", parent: "stable", foreman: true });
const worker = project({ id: "stable_2", name: "fix login", session: "stable_2", parent: "stable", worker: { owner: "stable", task: "t", model: "sonnet" } });
const briefed = (id: string) => id === "stable";
const nobody = () => false;

test("your own sessions push when they need you, and after a long turn only", () => {
  const mine = project({});
  assert.equal(pushesNeedsInput(mine, briefed), true);
  assert.equal(pushesFinished(mine, briefed, LONG_RUN_MS - 1), false, "a short turn is one you were watching");
  assert.equal(pushesFinished(mine, briefed, LONG_RUN_MS), true);
});

test("under a Lead's brief, a Foreman's and its Workers' finished turns never push: they report up the chain", () => {
  for (const session of [foreman, worker]) {
    assert.equal(pushesFinished(session, briefed, 60 * 60_000), false, session.id);
  }
});

const NOW = Date.parse("2026-11-01T12:00:00Z");
const request = { key: "k1", headline: "Run tests?", exact: "pnpm test", kind: "bash" } as unknown as ProjectState["request"];
const waiting = (session: ProjectState, dialog: "permission" | "question" | "trust" | "model", agoMs = 0) => ({
  ...session,
  needsInput: true,
  activity: "agent-idle" as const,
  dialog,
  waitingSince: new Date(NOW - agoMs).toISOString(),
  ...(dialog === "permission" ? { request } : {}),
});

test("the apps see a question Cobra is answering as work: no wait, no dialog, no Allow", () => {
  const [fm, wk] = markHandled([waiting(foreman, "question"), waiting(worker, "question")], briefed, NOW);
  for (const handled of [fm!, wk!]) {
    assert.equal(handled.needsInput, false, handled.id);
    assert.equal(handled.dialog, null);
    assert.equal(handled.activity, "agent-working");
    assert.equal(handled.handledBy, "cobra");
    assert.equal(pushesNeedsInput(waiting(handled.id === foreman.id ? foreman : worker, "question"), briefed, NOW), false);
  }
  assert.equal(markHandled([waiting(foreman, "question")], nobody, NOW)[0]!.needsInput, true, "with Cobra stopped, the Foreman's question is the person's");
  assert.equal(markHandled([foreman], briefed, NOW)[0], foreman, "a session not waiting is left as it is");
});

test("a permission prompt, a trust check or the model picker under Cobra's brief is the person's from the start", () => {
  for (const dialog of ["permission", "trust", "model"] as const) {
    for (const session of [foreman, worker]) {
      const shown = markHandled([waiting(session, dialog)], briefed, NOW)[0]!;
      assert.equal(shown.needsInput, true, `${session.id} ${dialog}`);
      assert.equal(shown.dialog, dialog);
      assert.equal(shown.handledBy, undefined);
      assert.equal(pushesNeedsInput(waiting(session, dialog), briefed, NOW), true, `${session.id} ${dialog} pushes`);
    }
  }
  assert.deepEqual(markHandled([waiting(foreman, "permission")], briefed, NOW)[0]!.request, request, "its Allow stays");
});

test("a question Cobra leaves past its grace becomes the person's", () => {
  const late = waiting(foreman, "question", QUESTION_GRACE_MS);
  assert.equal(markHandled([late], briefed, NOW)[0]!.needsInput, true);
  assert.equal(pushesNeedsInput(late, briefed, NOW), true);
  assert.equal(markHandled([waiting(foreman, "question", QUESTION_GRACE_MS - 1)], briefed, NOW)[0]!.needsInput, false);
  const { waitingSince: _since, ...unknownStart } = waiting(foreman, "question");
  assert.equal(markHandled([unknownStart], briefed, NOW)[0]!.needsInput, false, "a wait with no start time is new");
});

test("Cobra's own question and your own sessions' waits are never hidden", () => {
  const [ld, mine] = markHandled([waiting(lead, "question"), waiting(project({ id: "site" }), "question")], briefed, NOW);
  assert.equal(ld!.needsInput, true, "Cobra's own question is the person's");
  assert.equal(mine!.needsInput, true);
});

test("the Lead's questions push; its finishes are its run's", () => {
  assert.equal(pushesNeedsInput(lead, briefed), true);
  assert.equal(pushesFinished(lead, briefed, 60 * 60_000), false);
});

test("a Foreman you talk to yourself is your own session, and its Workers' questions reach you", () => {
  assert.equal(pushesNeedsInput(foreman, nobody), true);
  assert.equal(pushesFinished(foreman, nobody, LONG_RUN_MS), true);
  assert.equal(pushesNeedsInput(worker, nobody), true, "nobody above would pass it on");
  assert.equal(pushesFinished(worker, nobody, 60 * 60_000), false, "a Worker's finish is its Foreman's to read");
});

function runTicks(states: Array<{ at: number; projects: ProjectState[]; relaying?: boolean }>) {
  let run: Run | null = null;
  const done: Array<{ at: number; id: string }> = [];
  for (const state of states) {
    const step = stepRun(run, state.projects, briefed, state.relaying ?? false, state.at);
    run = step.run;
    if (step.done) done.push({ at: state.at, id: step.done.id });
  }
  return done;
}

test("one push when the Lead's run settles, after the crew it briefed is done", () => {
  const working = (p: ProjectState) => ({ ...p, activity: "agent-working" as const });
  const done = runTicks([
    { at: 0, projects: [working(lead), foreman, worker] },
    { at: 60_000, projects: [lead, working(foreman), worker] },
    { at: 120_000, projects: [lead, foreman, working(worker)] },
    // The Worker is done, its finish not yet typed into the Foreman: still the run.
    { at: 300_000, projects: [lead, foreman, worker], relaying: true },
    { at: 310_000, projects: [lead, working(foreman), worker] },
    { at: 400_000, projects: [lead, foreman, worker] },
    { at: 400_000 + RUN_SETTLE_MS - 1, projects: [lead, foreman, worker] },
    { at: 400_000 + RUN_SETTLE_MS, projects: [lead, foreman, worker] },
    { at: 400_000 + 2 * RUN_SETTLE_MS, projects: [lead, foreman, worker] },
  ]);
  assert.deepEqual(done, [{ at: 400_000 + RUN_SETTLE_MS, id: "cobra_lead" }], "once, and only after it settled");
});

test("a run waiting on you is not done, and a short exchange with the Lead is not news", () => {
  const working = { ...lead, activity: "agent-working" as const };
  const asking = { ...foreman, needsInput: true };
  assert.deepEqual(runTicks([
    { at: 0, projects: [working, foreman] },
    { at: LONG_RUN_MS, projects: [lead, asking] },
    { at: LONG_RUN_MS + 10 * RUN_SETTLE_MS, projects: [lead, asking] },
  ]), [], "a Foreman waiting on the person keeps the run open");
  assert.deepEqual(runTicks([
    { at: 0, projects: [working] },
    { at: 30_000, projects: [lead] },
    { at: 30_000 + RUN_SETTLE_MS, projects: [lead] },
  ]), []);
});

test("no Lead, no run: a Foreman you drive yourself pushes as your own session", () => {
  assert.deepEqual(runTicks([
    { at: 0, projects: [{ ...foreman, activity: "agent-working" }] },
    { at: LONG_RUN_MS, projects: [foreman] },
    { at: LONG_RUN_MS + RUN_SETTLE_MS, projects: [foreman] },
  ]), []);
});

test("the Lead's own notification: plain words of a sane length, one a minute at most", () => {
  assert.deepEqual(leadNotice({ title: "  Plant Shop\nneeds you ", text: "Which plan?" }, null, 0), { title: "Plant Shop needs you", body: "Which plan?" });
  assert.equal((leadNotice({ title: "x", text: "Which plan?" }, null, 0) as { status: number }).status, 400);
  assert.equal((leadNotice({ title: "Title", text: "y".repeat(301) }, null, 0) as { status: number }).status, 400);
  const early = leadNotice({ title: "Title", text: "Body" }, 0, NOTIFY_GAP_MS - 1);
  assert.equal((early as { status: number }).status, 429);
  assert.match((early as { error: string }).error, /same notification/);
  assert.ok("title" in leadNotice({ title: "Title", text: "Body" }, 0, NOTIFY_GAP_MS));
});

test("your own Pi session is yours: its questions and long turns reach you, whoever is briefed in its project", () => {
  const briefed = () => true;
  const mine = project({ id: "cobra_7", parent: "cobra", worker: { owner: "you", task: "", model: "local:qwen3:4b" } });
  assert.equal(underLead(mine, briefed), false);
  assert.equal(pushesNeedsInput(mine, briefed), true);
  assert.equal(pushesFinished(mine, briefed, LONG_RUN_MS), true);
  assert.equal(pushesFinished(mine, briefed, LONG_RUN_MS - 1), false, "a short turn is one you were watching");
  // A Foreman's Pi Worker still reports up the chain.
  const theirs = project({ id: "cobra_8", parent: "cobra", worker: { owner: "cobra", task: "fix", model: "local:qwen3:4b" } });
  assert.equal(pushesFinished(theirs, briefed, LONG_RUN_MS), false);
});
