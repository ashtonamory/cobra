import { test } from "node:test";
import assert from "node:assert/strict";

import type { Extra } from "./extras.ts";
import { generateTitle, titleArgs, titleExtra, titleInput, TITLE_MODEL, TITLE_TIMEOUT_MS, type TitleDeps, type TitleRun } from "./titles.ts";

const extra = (id: string): Extra => ({
  parent: "cobra",
  id,
  session: id,
  path: `/p/${id}`,
  branch: "docs/lab-ste-guide-setup",
  createdAt: "2026-10-09T00:00:00Z",
});

function fixture(run: TitleRun, initial: Extra[] = [extra("cobra_2")]) {
  let stored = initial;
  const logs: string[] = [];
  const deps: TitleDeps = {
    run,
    loadExtras: async () => stored,
    saveExtras: async (next) => {
      stored = next;
    },
    log: (line) => logs.push(line),
  };
  return { deps, logs, stored: () => stored };
}

test("the run is Haiku, with no tools, no saved session and the task on stdin", () => {
  const args = titleArgs();
  assert.equal(args[args.indexOf("--model") + 1], TITLE_MODEL);
  assert.equal(TITLE_MODEL, "haiku");
  assert.ok(args.includes("--restricted"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  // The task is data: fenced, and cut when it is a long brief.
  assert.equal(titleInput("  write a guide  "), "<task>\nwrite a guide\n</task>");
  assert.ok(titleInput("x".repeat(5000)).length < 1600);
});

test("a task is named by the model, cleaned, with the stubbed call", async () => {
  const seen: Array<{ args: string[]; input: string; timeoutMs: number }> = [];
  const run: TitleRun = async (args, input, timeoutMs) => {
    seen.push({ args, input, timeoutMs });
    return '"Lab STE Setup Guide."\n';
  };
  assert.equal(await generateTitle({ run }, "write the lab STE setup guide"), "Lab STE Setup Guide");
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.input, /write the lab STE setup guide/);
  assert.equal(seen[0]!.timeoutMs, TITLE_TIMEOUT_MS);
});

test("the titles chain: a local model the owner listed names it first, and Claude when it fails", async () => {
  const claude: string[] = [];
  const run: TitleRun = async (args) => (claude.push(args[args.indexOf("--model") + 1]!), "From Claude");
  const local: string[] = [];
  const models = async () => ["local:qwen-tuned:fast96k", "haiku"];
  assert.equal(await generateTitle({ run, models, local: async (model) => (local.push(model), "Lab Guide") }, "write it"), "Lab Guide");
  assert.deepEqual([local, claude], [["qwen-tuned:fast96k"], []]);
  // The local model is down, or answers with no title: the next model in the chain.
  assert.equal(await generateTitle({ run, models, local: async () => { throw new Error("Ollama answered 500"); } }, "write it"), "From Claude");
  assert.equal(await generateTitle({ run, models, local: async () => "" }, "write it"), "From Claude");
  // No local runner: a local entry is passed over.
  assert.equal(await generateTitle({ run, models }, "write it"), "From Claude");
  assert.deepEqual(claude, ["haiku", "haiku", "haiku"]);
});

test("no task, a failed run, a timeout and a rambling answer all give no title", async () => {
  const never = async () => {
    throw new Error("must not run");
  };
  assert.equal(await generateTitle({ run: never }, "   "), null);
  assert.equal(
    await generateTitle({ run: async () => { throw new Error("claude exited 1"); } }, "do it"),
    null,
  );
  assert.equal(
    await generateTitle({ run: async () => { throw new Error("the title run timed out"); }, timeoutMs: 5 }, "do it"),
    null,
  );
  assert.equal(await generateTitle({ run: async () => "I am not sure what you want me to do with this task, sorry" }, "do it"), null);
  assert.equal(await generateTitle({ run: async () => "" }, "do it"), null);
});

test("the title is kept on the right session and nothing else changes", async () => {
  const { deps, logs, stored } = fixture(async () => "Lab STE Setup Guide", [extra("cobra_2"), extra("cobra_3")]);
  assert.equal(await titleExtra(deps, "cobra_3", "write the guide"), "Lab STE Setup Guide");
  assert.equal(stored()[0]?.title, undefined);
  assert.equal(stored()[1]?.title, "Lab STE Setup Guide");
  assert.equal(stored()[1]?.branch, "docs/lab-ste-guide-setup");
  assert.equal(logs.length, 1);
});

test("a session removed while the model ran is not brought back, and a failure is only logged", async () => {
  let gone = false;
  const first = fixture(async () => {
    gone = true;
    return "Lab STE Setup Guide";
  });
  first.deps.loadExtras = async () => (gone ? [] : first.stored());
  assert.equal(await titleExtra(first.deps, "cobra_2", "task"), null);
  assert.deepEqual(first.stored().map((e) => e.title), [undefined]);

  const second = fixture(async () => "Lab STE Setup Guide");
  second.deps.saveExtras = async () => {
    throw new Error("disk full");
  };
  assert.equal(await titleExtra(second.deps, "cobra_2", "task"), null);
  assert.match(second.logs[0] ?? "", /disk full/);

  const third = fixture(async () => {
    throw new Error("claude exited 1");
  });
  assert.equal(await titleExtra(third.deps, "cobra_2", "task"), null);
  assert.equal(third.stored()[0]?.title, undefined);
});
