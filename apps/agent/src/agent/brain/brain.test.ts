import assert from "node:assert/strict";
import { test } from "node:test";

import { modelAllowed } from "../permissions.ts";
import { BENCHMARKS, scoreOf, windowModel } from "./benchmarks.ts";
import { catalog } from "./catalog.ts";
import { guessKind, guessSize, labelHolds } from "./classify.ts";
import { parseCodexModels } from "./codexModels.ts";
import { isLabels, labelsFor } from "./labels.ts";
import { route, type RouteFacts, type RouteTask } from "./route.ts";
import { globMatches, named, namesProject, parseBrain, ruleApplies, ruleWarnings } from "./rules.ts";

// The account's list as Codex CLI served it on 2026-10-24: GPT-6 and GPT-5.6.
const ACCOUNT = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const facts = (over: Partial<RouteFacts> = {}): RouteFacts => ({
  candidates: catalog({ codexModels: ACCOUNT }),
  allowed: null,
  modelAllowed,
  budget: [],
  rules: [],
  ...over,
});
const task = (over: Partial<RouteTask> = {}): RouteTask => ({ text: "Add a Standoff turn order screen", kind: "feature", size: "M", project: { id: "corner-bakery", key: "octo-org/corner-bakery" }, ...over });

test("the catalog: the Claude models always; each GPT-6 model the Codex account lists; GPT-5.x and local never", () => {
  assert.deepEqual(catalog({ codexModels: null }).map((c) => c.model), ["opus", "sonnet", "haiku", "fable"]);
  assert.deepEqual(
    catalog({ codexModels: ACCOUNT }).map((c) => c.model),
    ["opus", "sonnet", "haiku", "fable", "codex:gpt-6.1-sol", "codex:gpt-6-astra", "codex:gpt-6-sol", "codex:gpt-6-luna"],
  );
  // The mini's older CLI lists no GPT-6.1 Sol, so none is offered there.
  assert.equal(catalog({ codexModels: ["gpt-6-astra"] }).some((c) => c.model === "codex:gpt-6.1-sol"), false);
});

test("the Codex account's list: listed slugs in order, hidden ones left out", () => {
  const text = JSON.stringify({ fetched_at: "x", models: [{ slug: "gpt-6.1-sol", visibility: "list" }, { slug: "gpt-reserve", visibility: "hide" }, { slug: "gpt-6-luna" }] });
  assert.deepEqual(parseCodexModels(text), ["gpt-6.1-sol", "gpt-6-luna"]);
  assert.equal(parseCodexModels("not json"), null);
  assert.equal(parseCodexModels("{}"), null);
});

test("the benchmarks: Terminal-Bench 4.0 for tests and infra, FrontierCode for the rest; a model's own window by name", () => {
  assert.deepEqual(scoreOf("sonnet", "tests"), { score: 70.6, basis: "Terminal-Bench 4.0", estimated: false });
  assert.deepEqual(scoreOf("opus", "bugfix"), { score: 54.4, basis: "FrontierCode", estimated: false });
  assert.equal(scoreOf("codex:gpt-6.1-sol", "feature")?.estimated, true);
  assert.equal(scoreOf("codex:gpt-5.6-terra", "feature"), null);
  assert.equal(windowModel("Fable Weekly"), "fable");
  assert.equal(windowModel("Weekly (7-day)"), null);
  for (const bench of Object.values(BENCHMARKS)) assert.ok(bench.code > 0 && bench.terminal > 0 && bench.price > 0, bench.name);
});

test("the label check: words and files point to a kind, and near kinds still hold", () => {
  assert.equal(guessKind("Fix the crash when the save file is empty"), "bugfix");
  assert.equal(guessKind("Write unit tests for the queue", ["apps/agent/src/agent/queue.test.ts"]), "tests");
  assert.equal(guessKind("Update the CI pipeline to cache pnpm"), "infra");
  assert.equal(guessKind("tidy"), null);
  assert.equal(labelHolds("bugfix", "tests"), true);
  assert.equal(labelHolds("docs", "infra"), false);
  assert.equal(guessSize("x", ["a", "b", "c"]), "M");
  assert.equal(guessSize("x".repeat(3000)), "L");
});

test("a Worker's label: the Foreman's, else the words' guess", () => {
  assert.deepEqual(labelsFor({ task: "anything", kind: "ui", size: "S", review: "force", routed: "opus" }), { kind: "ui", size: "S", review: "force", routed: "opus" });
  assert.deepEqual(labelsFor({ task: "Fix the crash on save" }), { kind: "bugfix", size: "S", guessed: true });
  assert.equal(isLabels({ kind: "ui", size: "S" }), true);
  assert.equal(isLabels({ kind: "art", size: "S" }), false);
});

test("brain.json: rules are checked, a rule that does nothing is refused, and old seed strengths are dropped", () => {
  const ok = parseBrain(JSON.stringify({ revision: 3, rules: [{ when: { kind: "ui" }, prefer: ["opus"], note: "UI wants Opus" }], priors: { codex: { tests: 0.9 } } }));
  assert.deepEqual(ok, { brain: { revision: 3, rules: [{ when: { kind: "ui" }, prefer: ["opus"], note: "UI wants Opus" }] } });
  assert.match((parseBrain(JSON.stringify({ rules: [{ when: { kind: "art" }, prefer: ["opus"] }] })) as { error: string }).error, /kind is one of/);
  assert.match((parseBrain(JSON.stringify({ rules: [{ when: {} }] })) as { error: string }).error, /does nothing/);
  assert.deepEqual(parseBrain(null), { brain: { revision: 0, rules: [] } });
});

test("a rule applies when every condition holds; a path rule needs a file under it", () => {
  assert.equal(globMatches("apps/agent/src/**", "apps/agent/src/agent/x.ts"), true);
  assert.equal(globMatches("*.md", "docs/a.md"), false);
  assert.equal(globMatches("**/*.md", "docs/a.md"), true);
  const rule = { when: { project: "corner-bakery", path: "maps/**" }, prefer: ["codex"] };
  assert.equal(ruleApplies(rule, { kind: "feature", project: { id: "corner-bakery" }, files: ["maps/bayou.json"] }), true);
  assert.equal(ruleApplies(rule, { kind: "feature", project: { id: "corner-bakery" }, files: [] }), false);
  assert.equal(ruleApplies(rule, { kind: "feature", project: { id: "x", key: "corner-bakery" }, files: ["maps/a"] }), true);
  assert.equal(named(["local:*"], "local:qwen"), true);
  assert.equal(named(["codex:*"], "codex:gpt-6-luna"), true);
});

test("with every window OK: each size gets its cost tier, copy gets Haiku, and Codex stands by", () => {
  const small = route(task({ kind: "bugfix", size: "S", text: "Fix the crash on save" }), facts());
  assert.equal(small.pick, "haiku");
  assert.equal(small.reason, "haiku takes small work, its cost tier: it scores 46.4 at bugfix on FrontierCode.");
  assert.equal(small.ranked.find((r) => r.model === "opus")?.excluded, "small work goes to haiku, to save usage");
  assert.match(small.ranked.find((r) => r.model === "codex:gpt-6.1-sol")?.excluded ?? "", /haiku has room; Codex takes work when it is TIGHT or at HOLD/);
  assert.equal(route(task({ kind: "bugfix", size: "M" }), facts()).pick, "sonnet");
  const big = route(task({ size: "L" }), facts());
  assert.equal(big.pick, "opus");
  assert.equal(big.review, true, "a large change gets a second engine");
  // Codex stands by for work but still reviews: Astra scores best, GPT-6.1 Sol is within 4 points and far cheaper on the window.
  assert.equal(big.reviewer, "codex:gpt-6.1-sol");
  assert.equal(route(task({ kind: "docs", size: "L" }), facts()).pick, "haiku", "copy is Haiku's at any size");
  assert.equal(route(task({ kind: "tests", size: "L" }), facts()).pick, "sonnet", "Sonnet leads Opus on Terminal-Bench 4.0 at half the price");
  assert.equal(route(task({ kind: "infra", size: "L" }), facts()).pick, "sonnet");
  assert.equal(route(task({ kind: "infra", size: "S" }), facts()).pick, "haiku");
});

test("TIGHT takes 4 points off and lets Codex compete; HOLD removes; a model's own window holds only it", () => {
  const tight = route(task({ kind: "bugfix", size: "M" }), facts({ budget: [{ id: "claude", state: "tight" }] }));
  assert.equal(tight.pick, "codex:gpt-6.1-sol", "Sonnet's 48.1 falls behind GPT-6.1 Sol's 48.9");
  assert.ok(tight.ranked.find((r) => r.model === "sonnet")?.notes.includes("Claude is TIGHT"));
  assert.equal(tight.ranked.find((r) => r.model === "sonnet")?.score, 48.1);
  assert.equal(route(task({ kind: "bugfix", size: "S" }), facts({ budget: [{ id: "claude", state: "tight" }] })).pick, "codex:gpt-6.1-sol");
  assert.equal(route(task({ size: "L" }), facts({ budget: [{ id: "claude", state: "tight" }] })).pick, "opus", "large work keeps the strongest");
  assert.equal(route(task({ kind: "tests", size: "M" }), facts({ budget: [{ id: "claude", state: "tight" }] })).pick, "sonnet", "66.6 still leads");
  assert.equal(route(task({ kind: "docs", size: "L" }), facts({ budget: [{ id: "claude", state: "tight" }] })).pick, "codex:gpt-6.1-sol", "copy takes S's band: not Astra");
  const held = route(task(), facts({ budget: [{ id: "claude", state: "hold" }] }));
  assert.equal(held.pick, "codex:gpt-6.1-sol", "Astra leads Codex by 0.9, and 6.1 Sol is far cheaper on the window");
  assert.equal(held.ranked.find((r) => r.model === "opus")?.excluded, "Claude is at HOLD");
  assert.equal(route(task({ size: "L" }), facts({ budget: [{ id: "claude", state: "hold" }] })).pick, "codex:gpt-6-astra");
  const fable = route(task(), facts({ budget: [{ id: "fable", state: "hold", label: "Fable Weekly" }] }));
  assert.equal(fable.ranked.find((r) => r.model === "fable")?.excluded, "Fable Weekly is at HOLD");
  assert.equal(fable.pick, "sonnet");
  const codexHeld = route(task({ size: "L" }), facts({ budget: [{ id: "codex", state: "hold" }] }));
  assert.equal(codexHeld.ranked.filter((r) => r.provider === "codex").every((r) => r.excluded === "Codex is at HOLD"), true);
  assert.match(codexHeld.reviewWhy ?? "", /no other engine can review here/);
});

test("the tier gives way: a project that leaves the tier's model out gets the best it allows; a rule's model is never held back", () => {
  assert.equal(route(task({ size: "S" }), facts({ allowed: ["opus", "sonnet"] })).pick, "sonnet", "no Haiku here: the band picks among the rest");
  assert.equal(route(task({ size: "S" }), facts({ rules: [{ when: { kind: "feature" }, prefer: ["opus"] }] })).pick, "opus");
  assert.equal(route(task({ size: "S" }), facts({ rules: [{ when: { kind: "feature" }, never: ["haiku"] }] })).pick, "sonnet");
  const claudeOnly = route(task({ size: "M" }), facts({ candidates: catalog({ codexModels: null }), budget: [{ id: "claude", state: "tight" }] }));
  assert.equal(claudeOnly.pick, "sonnet", "API test mode: Claude only, so a tight key keeps the tier");
});

test("your rules win: prefer puts a model first, never removes it, review forces or skips", () => {
  const rules = [{ when: { project: "Corner Bakery" }, prefer: ["codex"], note: "Codex knows the maps" }, { when: { kind: "feature" as const }, never: ["opus"] }];
  const routed = route(task(), facts({ rules }));
  assert.equal(routed.pick, "codex");
  assert.match(routed.reason, /Your rule \(Codex knows the maps\) puts codex first/);
  assert.equal(routed.ranked[0]!.score, null, "plain codex has no scores of its own; the rule still picks it");
  assert.match(routed.ranked.find((r) => r.model === "opus")?.excluded ?? "", /your rule says never/);
  assert.equal(routed.runnerUp, "sonnet", "after the rule, the band: Sonnet leads once Opus is out");
  const skipped = route(task({ kind: "infra" }), facts({ rules: [{ when: { kind: "infra" }, review: "skip" }] }));
  assert.equal(skipped.review, false);
  const forced = route(task({ kind: "docs", size: "S" }), facts({ rules: [{ when: { kind: "docs" }, review: "force" }] }));
  assert.equal(forced.reviewWhy, "your rule asks for a review");
});

test("the policy removes models with its reason; none left, no pick", () => {
  const policy = route(task(), facts({ allowed: ["sonnet", "local:*"] }));
  assert.equal(policy.pick, "sonnet");
  assert.equal(policy.ranked.find((r) => r.model === "codex:gpt-6.1-sol")?.excluded, "this project's models leave it out");
  assert.equal(route(task(), facts({ allowed: ["codex:*"] })).pick, "codex:gpt-6.1-sol");
  const none = route(task(), facts({ allowed: [] }));
  assert.equal(none.pick, null);
  assert.equal(none.reason, "No model can run this here now.");
});

test("a label the words do not back is kept but said, and security work is reviewed by another engine", () => {
  const routed = route(task({ text: "Update the README and the guide", kind: "infra" }), facts());
  assert.equal(routed.labelHolds, false);
  assert.match(routed.reason, /reads more like docs than infra/);
  const security = route(task({ kind: "security", text: "Check the token handling" }), facts());
  assert.equal(security.pick, "sonnet");
  assert.equal(security.reviewWhy, "security work");
  assert.equal(security.reviewer, "codex:gpt-6.1-sol");
  const claudeOnly = route(task({ kind: "security" }), facts({ candidates: catalog({ codexModels: null }) }));
  assert.equal(claudeOnly.review, false);
  assert.match(claudeOnly.reviewWhy ?? "", /no other engine can review here/);
});

test("a rule names a project by its id, its owner/repo, its repo or its name, whatever the case or spaces", () => {
  const project = { id: "corner-bakery", key: "octo-org/corner-bakery", name: "Corner Bakery" };
  for (const text of ["corner-bakery", "octo-org/corner-bakery", "Corner Bakery", "corner bakery", "CORNER_BAKERY"]) assert.equal(namesProject(text, project), true, text);
  assert.equal(namesProject("corner", project), false);
  const rule = { when: { project: "Corner Bakery" }, prefer: ["codex"] };
  assert.equal(ruleApplies(rule, { kind: "feature", project, files: [] }), true, "the rule that matched nothing for a week (2026-10-24)");
  assert.deepEqual(ruleWarnings([rule, { when: { project: "mail app" }, never: ["opus"] }, { when: { kind: "ui" }, prefer: ["opus"] }], [project]), [
    'Rule 2 names the project "mail app", which matches no project, so it does nothing.',
  ]);
});

test("an HTML email design goes to Sonnet (Opus when large), never Haiku, even labelled copy", () => {
  const design = "Design the HTML email for the spring newsletter in the brand, to Cobra's email design standard";
  assert.equal(route(task({ kind: "docs", size: "S", text: design }), facts()).pick, "sonnet");
  assert.equal(route(task({ kind: "ui", size: "L", text: design }), facts()).pick, "opus");
  assert.equal(route(task({ kind: "docs", size: "S", text: "Fix a typo", files: ["email/realtor-outreach/northwind-agents-email.html"] }), facts()).pick, "sonnet");
  const held = route(task({ kind: "docs", size: "S", text: design }), facts({ budget: [{ id: "sonnet", state: "hold" }] }));
  assert.notEqual(held.pick, "haiku");
  assert.match(held.ranked.find((r) => r.model === "haiku")?.excluded ?? "", /Sonnet or Opus/);
  assert.equal(route(task({ kind: "docs", size: "S", text: "Write the README for the email sender" }), facts()).pick, "haiku", "words about email with no design stay copy");
});
