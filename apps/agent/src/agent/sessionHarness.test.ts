import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultProjectLaunch, orchestratorEngine, orchestratorRole, projectLaunch, sessionEngine } from "./sessionHarness.ts";

test("the computer engine defaults to Claude and accepts only Codex explicitly", () => {
  assert.equal(sessionEngine({}), "claude");
  assert.equal(sessionEngine({ COBRA_ENGINE: "codex" }), "codex");
  assert.equal(sessionEngine({ COBRA_ENGINE: "other" }), "claude");
  assert.deepEqual(projectLaunch("/work/project", "project-1", "claude"), { command: ["claude"], env: {}, opensRestricted: false, engine: "claude" });
});

test("orchestrators follow the selected Codex engine, with a dedicated override", () => {
  assert.equal(orchestratorEngine({}), "claude");
  assert.equal(orchestratorEngine({ COBRA_ENGINE: "codex" }), "codex");
  assert.equal(orchestratorEngine({ COBRA_ORCHESTRATOR_ENGINE: "codex" }), "codex");
  assert.equal(orchestratorEngine({ COBRA_ENGINE: "codex", COBRA_ORCHESTRATOR_ENGINE: "claude" }), "claude");
});

test("a Codex launch refuses with no active account", () => {
  assert.throws(
    () => projectLaunch("/work/project", "project-1", "codex", { credential: () => null, prepare: (() => { throw new Error("not reached"); }) as never }),
    /no Codex ChatGPT sign-in/,
  );
});

test("a Codex project launch receives a broker token and opens restricted", () => {
  let prepared: { name: string; mode: string; port: number; roots: readonly string[]; instructions: string } | undefined;
  const launch = projectLaunch("/work/project", "project-1", "codex", {
    credential: () => ({ authorization: "Bearer x" }),
    prepare: ((options: typeof prepared) => {
      prepared = options!;
      return { name: "project-project-1", home: "/private/codex", token: "cobra-session-test", env: { CODEX_HOME: "/private/codex", OPENAI_API_KEY: "cobra-session-test" } };
    }) as never,
  });
  assert.deepEqual(launch.command, ["codex", "--no-daemon", "--sandbox", "workspace-write", "--ask-for-approval", "never"]);
  assert.equal(launch.opensRestricted, true);
  assert.equal(launch.env.OPENAI_API_KEY, "cobra-session-test");
  assert.deepEqual(prepared?.roots, ["/work/project"]);
  assert.equal(prepared?.mode, "chatgpt");
});

test("Codex as the default falls back to Claude without a sign-in, marked so the reply can say so", () => {
  const none = { credential: () => null, prepare: (() => { throw new Error("not reached"); }) as never };
  assert.deepEqual(defaultProjectLaunch("/work/project", "project-1", "codex", none), { command: ["claude"], env: {}, opensRestricted: false, engine: "claude", fellBack: true });
  assert.equal(defaultProjectLaunch("/work/project", "project-1", "claude", none).fellBack, undefined);
});

test("an orchestrator's role comes from its session name", () => {
  assert.equal(orchestratorRole("cobra_lead"), "lead");
  assert.equal(orchestratorRole("cobra_fm"), "foreman");
});
