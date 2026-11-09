import assert from "node:assert/strict";
import { test } from "node:test";

import { modelAllowed } from "../permissions.ts";
import { catalog } from "./catalog.ts";
import { acceptBrain, brainView, type BrainWindowInput } from "./view.ts";

const view = (over: { budget?: BrainWindowInput[]; rules?: Parameters<typeof brainView>[0]["brain"]["rules"]; codex?: string[] | null } = {}) =>
  brainView({
    machine: "legion",
    brain: { revision: 2, rules: over.rules ?? [] },
    refused: null,
    candidates: catalog({ codexModels: over.codex === undefined ? ["gpt-6.1-sol", "gpt-5.6-terra"] : over.codex }),
    allowed: null,
    modelAllowed,
    budget: over.budget ?? [],
    projects: [{ id: "corner-bakery", key: "octo-org/corner-bakery", name: "Corner Bakery" }],
  });

test("the view: every benchmarked model, marked offered when this computer's accounts list it, and the windows", () => {
  const seen = view({ budget: [{ id: "claude", state: "ok", label: "Weekly (7-day)", percent: 0.21, resetsAt: "2026-10-28T00:00:00Z" }] });
  assert.deepEqual(seen.kinds.length * seen.sizes.length, seen.picks.length);
  const offered = seen.benchmarks.filter((b) => b.offered).map((b) => b.model);
  assert.deepEqual(offered, ["opus", "sonnet", "fable", "haiku", "codex:gpt-6.1-sol"]);
  assert.equal(seen.benchmarks.find((b) => b.model === "codex:gpt-6-astra")?.offered, false);
  assert.equal(seen.benchmarks.some((b) => b.model.includes("5.6")), false, "GPT-5.x has no row");
  assert.deepEqual(seen.windows, [{ id: "claude", label: "Weekly (7-day)", percent: 0.21, state: "ok", resetsAt: "2026-10-28T00:00:00Z" }]);
  assert.equal(seen.asOf, "2026-10-24");
});

test("the picks follow the windows and your kind-only rules; a project rule is left out of them", () => {
  const pick = (v: ReturnType<typeof view>, kind: string, size: string) => v.picks.find((p) => p.kind === kind && p.size === size)?.pick;
  assert.equal(pick(view(), "bugfix", "S"), "haiku");
  assert.equal(pick(view(), "bugfix", "M"), "sonnet");
  assert.equal(pick(view(), "bugfix", "L"), "opus");
  assert.equal(pick(view({ budget: [{ id: "claude", state: "tight", label: "Weekly (7-day)", percent: 0.86, resetsAt: "" }] }), "bugfix", "M"), "codex:gpt-6.1-sol");
  assert.equal(pick(view({ rules: [{ when: { kind: "ui" }, prefer: ["haiku"] }] }), "ui", "L"), "haiku");
  assert.equal(pick(view({ rules: [{ when: { kind: "ui", project: "corner-bakery" }, prefer: ["haiku"] }] }), "ui", "L"), "opus", "a project rule is not a kind-only rule");
});

test("a new brain.json must be well formed and newer than this computer's", () => {
  const current = { revision: 3, rules: [] };
  assert.deepEqual(acceptBrain({ brain: { revision: 4, rules: [{ when: { kind: "ui" }, prefer: ["opus"] }], priors: {} } }, current), {
    brain: { revision: 4, rules: [{ when: { kind: "ui" }, prefer: ["opus"] }] },
  });
  assert.equal((acceptBrain({ brain: { revision: 3, rules: [] } }, current) as { status: number }).status, 409);
  assert.equal((acceptBrain({ brain: { revision: 9, rules: [{ when: {} }] } }, current) as { status: number }).status, 400);
  assert.equal((acceptBrain({}, current) as { status: number }).status, 400);
});

test("the view says when a rule names no project here", () => {
  assert.deepEqual(view({ rules: [{ when: { project: "Banana Dan" }, prefer: ["opus"] }] }).warnings, ['Rule 1 names the project "Banana Dan", which matches no project, so it does nothing.']);
  assert.deepEqual(view().warnings, []);
});
