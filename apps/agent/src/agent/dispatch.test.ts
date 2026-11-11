import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project } from "@cobra/contracts";

import {
  type DispatchConfig,
  type DispatchDeps,
  type Screen,
  dispatch,
  MAX_PROMPT,
  notReady,
  resolve,
  sanitisePrompt,
  SUBMIT_ATTEMPTS,
} from "./dispatch.ts";
import { SessionError } from "./sessions.ts";

function project(patch: Partial<Project> = {}): Project {
  return {
    id: "stable",
    name: "Plant Shop",
    machine: "omarchy",
    path: "/home/me/Projects/plant-shop",
    session: "plant-shop",
    ...patch,
  };
}

const config: DispatchConfig = {
  projects: [project(), project({ id: "notes-mac", machine: "macbook", session: "plant-nursery" })],
  templates: [{ id: "tests", name: "Run tests", prompt: "Run the test suite." }],
};

test("a newline cannot ride along in a prompt", () => {
  // Enter is submit: a newline left in the string would send the first line and
  // type the rest into whatever came next.
  assert.equal(sanitisePrompt("first line\nrm -rf /"), "first line rm -rf /");
});

test("control characters are stripped", () => {
  assert.equal(sanitisePrompt("a\u0000b\u001bc\u007fd"), "a b c d");
  assert.equal(sanitisePrompt("tab\there"), "tab here");
});

test("a prompt is capped", () => {
  assert.equal(sanitisePrompt("x".repeat(MAX_PROMPT + 500)).length, MAX_PROMPT);
});

test("an empty or whitespace-only prompt is refused", () => {
  assert.throws(
    () => resolve(config, "omarchy", "stable", undefined, "   \n  "),
    (error: unknown) => error instanceof SessionError && error.status === 400,
  );
});

test("a template resolves to its saved prompt", () => {
  const resolved = resolve(config, "omarchy", "stable", "tests", undefined);
  assert.equal(resolved.prompt, "Run the test suite.");
  assert.equal(resolved.project.session, "plant-shop");
});

test("an unknown template is a 404, not a silent freeform fallback", () => {
  // Falling back to `prompt` here would let a typo run something unintended.
  assert.throws(
    () => resolve(config, "omarchy", "stable", "nope", "something else entirely"),
    (error: unknown) => error instanceof SessionError && error.status === 404,
  );
});

test("a project on another machine is refused rather than started here", () => {
  assert.throws(
    () => resolve(config, "omarchy", "notes-mac", "tests", undefined),
    (error: unknown) => error instanceof SessionError && error.status === 409,
  );
});

test("an unknown project is a 404", () => {
  assert.throws(
    () => resolve(config, "omarchy", "ghost", "tests", undefined),
    (error: unknown) => error instanceof SessionError && error.status === 404,
  );
});

type Recorded = { calls: string[]; deps: DispatchDeps };

function deps(patch: Partial<DispatchDeps> = {}): Recorded {
  const calls: string[] = [];
  const base: DispatchDeps = {
    sessionExists: async () => false,
    newSession: async (session) => void calls.push(`new-session:${session}`),
    newWindow: async (session) => void calls.push(`new-window:${session}`),
    inspect: async () => ({ accepting: true, dialog: null, working: true, box: "empty" }),
    type: async (_session, prompt) => void calls.push(`type:${prompt}`),
    submit: async () => void calls.push("submit"),
    newTask: async () => void calls.push("new-task"),
    wait: async () => void calls.push("wait"),
    ...patch,
  };
  return { calls, deps: base };
}

test("a missing session is created; an existing one gets a new window", async () => {
  const fresh = deps();
  const created = await dispatch(fresh.deps, project(), "go");
  assert.equal(created.created, true);
  assert.ok(fresh.calls.includes("new-session:plant-shop"));

  const existing = deps({ sessionExists: async () => true });
  const reused = await dispatch(existing.deps, project(), "go");
  assert.equal(reused.created, false);
  assert.ok(existing.calls.includes("new-window:plant-shop"));
  assert.ok(
    !existing.calls.some((call) => call.startsWith("new-session")),
    "an existing session is never recreated",
  );
});

test("a selected engine command is kept for a fresh session and a new window", async () => {
  const command = ["codex", "--sandbox", "workspace-write"];
  let freshCommand: readonly string[] | undefined;
  await dispatch(deps({ newSession: async (_session, _cwd, _env, selected) => { freshCommand = selected; } }).deps, project(), "go", { CODEX_HOME: "/tmp/codex" }, command);
  assert.deepEqual(freshCommand, command);

  let windowCommand: readonly string[] | undefined;
  await dispatch(deps({
    sessionExists: async () => true,
    newWindow: async (_session, _cwd, selected) => { windowCommand = selected; },
  }).deps, project(), "go", { CODEX_HOME: "/tmp/codex" }, command);
  assert.deepEqual(windowCommand, command);
});

test("the prompt is typed and submitted as separate steps", async () => {
  const recorded = deps();
  await dispatch(recorded.deps, project(), "run the tests");
  // Order is what matters, not the exact number of polls: the text is typed
  // once, and Enter is a separate key pressed after it.
  const typed = recorded.calls.indexOf("type:run the tests");
  assert.ok(typed >= 0, "the prompt was typed");
  assert.equal(recorded.calls.filter((call) => call.startsWith("type:")).length, 1);
  assert.ok(recorded.calls.indexOf("submit") > typed, "Enter comes after the text");
});

test("nothing is typed until the agent's screen is recognised", async () => {
  let attempts = 0;
  const recorded = deps({
    inspect: async () => {
      attempts += 1;
      return { accepting: attempts >= 3, dialog: null, working: attempts >= 3, box: attempts >= 3 ? "empty" : "none" };
    },
  });
  await dispatch(recorded.deps, project(), "go");

  // The waits must come before the typing: keystrokes sent while the shell is
  // still starting Claude would be run as a command.
  const typed = recorded.calls.indexOf("type:go");
  assert.ok(typed >= 0);
  assert.equal(recorded.calls.slice(0, typed).filter((call) => call === "wait").length, 2);
  assert.equal(recorded.calls[0], "new-session:plant-shop");
});

test("Codex's empty task list opens one composer before typing", async () => {
  let looks = 0;
  const recorded = deps({
    inspect: async () => {
      looks += 1;
      return looks === 1 ? { accepting: false, dialog: null, working: false, box: "none", codexHome: true } : { accepting: true, dialog: null, working: true, box: "empty" };
    },
  });
  await dispatch(recorded.deps, project(), "go");
  assert.equal(recorded.calls.filter((call) => call === "new-task").length, 1);
  assert.ok(recorded.calls.indexOf("new-task") < recorded.calls.indexOf("type:go"));
});

test("an agent that never comes up times out without typing", async () => {
  const recorded = deps({ inspect: async () => ({ accepting: false, dialog: null, working: false, box: "none" }) });
  await assert.rejects(
    () => dispatch(recorded.deps, project(), "go"),
    (error: unknown) =>
      error instanceof SessionError && error.status === 504 && /did not come up in time \(the agent's input box is not on screen \(the screen was not recognised\)/.test(error.message),
  );
  assert.ok(
    !recorded.calls.some((call) => call.startsWith("type:")),
    "the prompt is never typed blind",
  );
});

test("notReady names what is in the way, and tells a missing box from text in it", () => {
  const screen = (patch: Partial<Screen>): Screen => ({ accepting: false, dialog: null, working: false, box: "empty", ...patch });
  assert.equal(notReady(null, "the Foreman"), "the Foreman's screen could not be read");
  assert.equal(notReady(screen({ dialog: "question" }), "the Foreman"), "the Foreman is asking something (question)");
  assert.equal(notReady(screen({ working: true }), "the Foreman"), "the Foreman is working");
  assert.equal(notReady(screen({ box: "text" }), "the Foreman"), "someone is typing to the Foreman");
  assert.equal(notReady(screen({ box: "none" }), "the Foreman"), "the Foreman's input box is not on screen (the screen was not recognised)");
});

test("the trust check is refused rather than answered from a phone", async () => {
  // The regression that motivated `accepting`: this screen reads as recognised
  // Claude Code chrome, so a naive readiness check types the prompt into it and
  // Enter then selects the highlighted row — "No, exit" — killing the session.
  const recorded = deps({ inspect: async () => ({ accepting: false, dialog: "trust", working: false, box: "none" }) });
  await assert.rejects(
    () => dispatch(recorded.deps, project(), "go"),
    (error: unknown) => error instanceof SessionError && error.status === 409,
  );
  assert.ok(!recorded.calls.some((call) => call.startsWith("type:")));
  assert.ok(!recorded.calls.includes("submit"), "Enter is never sent at a trust prompt");
});

test("Codex's Folder access prompt on a new worktree is answered Open restricted, once, then the prompt goes in", async () => {
  const screens = [
    { accepting: false, dialog: "trust", working: false, box: "none" as const },
    { accepting: true, dialog: null, working: false, box: "empty" as const },
    { accepting: true, dialog: null, working: true, box: "empty" as const },
  ];
  let at = 0;
  const recorded = deps({
    inspect: async () => screens[Math.min(at++, screens.length - 1)]!,
    openRestricted: async () => (recorded.calls.push("open-restricted"), true),
  });
  await dispatch(recorded.deps, project(), "go");
  assert.deepEqual(recorded.calls.filter((call) => call === "open-restricted"), ["open-restricted"]);
  assert.ok(recorded.calls.includes("type:go"));

  // Anything else at that prompt (Trust this folder?, Claude's trust check) is still refused, never answered.
  const other = deps({ inspect: async () => ({ accepting: false, dialog: "trust", working: false, box: "none" }), openRestricted: async () => false });
  await assert.rejects(() => dispatch(other.deps, project(), "go"), (error: unknown) => error instanceof SessionError && error.status === 409);
  assert.ok(!other.calls.some((call) => call.startsWith("type:")));
});

test("any dialog waiting before the prompt is reported, not typed over", async () => {
  const recorded = deps({ inspect: async () => ({ accepting: false, dialog: "permission", working: false, box: "none" }) });
  await assert.rejects(
    () => dispatch(recorded.deps, project(), "go"),
    (error: unknown) => error instanceof SessionError && error.status === 409,
  );
  assert.ok(!recorded.calls.some((call) => call.startsWith("type:")));
});

test("a screen mid-turn is not typed into", async () => {
  // `working` means a turn is already running; the prompt would queue up behind
  // it or interrupt it, neither of which is what dispatch promised.
  let looks: Screen = { accepting: false, dialog: null, working: false, box: "none" };
  const recorded = deps({ inspect: async () => looks });
  const run = dispatch(recorded.deps, project(), "go");
  looks = { accepting: true, dialog: null, working: true, box: "empty" };
  await run;
  assert.ok(recorded.calls.includes("type:go"));
});

test("Enter is repeated until the turn actually starts", async () => {
  // Measured against the real binary: the text always lands, but Enter is
  // swallowed for an unpredictable stretch after the input box is drawn.
  let polls = 0;
  const recorded = deps({
    inspect: async () => {
      polls += 1;
      const started = polls > 3;
      return { accepting: true, dialog: null, working: started, box: started ? "empty" : "text" };
    },
  });
  await dispatch(recorded.deps, project(), "go");

  assert.equal(recorded.calls.filter((call) => call.startsWith("type:")).length, 1, "typed once");
  assert.ok(recorded.calls.filter((call) => call === "submit").length > 1, "Enter was repeated");
});

test("a dialog appearing mid-submit stops the retries", async () => {
  // If the turn finished between polls and a permission prompt is now up, a
  // stray Enter would answer it.
  let polls = 0;
  const recorded = deps({
    inspect: async () => {
      polls += 1;
      return polls > 2
        ? { accepting: false, dialog: "permission", working: false, box: "none" }
        : { accepting: true, dialog: null, working: false, box: "text" };
    },
  });
  await assert.rejects(
    () => dispatch(recorded.deps, project(), "go"),
    (error: unknown) => error instanceof SessionError && error.status === 409,
  );
  assert.ok(recorded.calls.filter((call) => call === "submit").length <= 2, "stopped pressing Enter");
});

test("a prompt that never submits is reported rather than assumed sent", async () => {
  const recorded = deps({
    inspect: async () => ({ accepting: true, dialog: null, working: false, box: "text" }),
  });
  await assert.rejects(
    () => dispatch(recorded.deps, project(), "go"),
    (error: unknown) => error instanceof SessionError && error.status === 504,
  );
  assert.equal(recorded.calls.filter((call) => call === "submit").length, SUBMIT_ATTEMPTS);
});
