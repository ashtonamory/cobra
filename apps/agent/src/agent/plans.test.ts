import assert from "node:assert/strict";
import { test } from "node:test";

import { modelAllowed } from "./permissions.ts";
import { catalog } from "./brain/catalog.ts";
import { route } from "./brain/route.ts";
import { chooseModels, parsePlan, planNews, planText, reviewerFor, routedPlan } from "./plans.ts";

const facts = { candidates: catalog({ codexModels: ["gpt-6.1-sol"] }), allowed: null, modelAllowed, budget: [], rules: [] };
const body = {
  summary: "Bayou Hollow, with tests after it lands.",
  tasks: [
    { title: "Bayou Hollow map", task: "Build the Bayou Hollow map and its NPCs.", kind: "feature", size: "L" },
    { title: "Turn order tests", task: "Add tests for the Standoff turn order.", kind: "tests", size: "S", after: ["t1"] },
  ],
};

function planned() {
  const input = parsePlan(body);
  assert.ok(!("error" in input));
  const routes = input.tasks.map((task) => route({ text: task.task, kind: task.kind, ...(task.size ? { size: task.size } : {}), files: task.files, project: { id: "corner-bakery" } }, facts));
  const plan = routedPlan({ id: "corner-bakery", name: "Corner Bakery" }, input, routes);
  assert.ok(!("error" in plan));
  return plan;
}

test("a plan: 1 to 8 tasks with a title, a task and a kind; after names only earlier tasks", () => {
  assert.match((parsePlan({ tasks: [] }) as { error: string }).error, /1 to 8/);
  assert.match((parsePlan({ tasks: [{ title: "x", task: "y", kind: "art" }] }) as { error: string }).error, /kind is one of/);
  assert.match((parsePlan({ tasks: [{ title: "x", task: "y", kind: "docs", after: ["t2"] }, { title: "z", task: "w", kind: "docs" }] }) as { error: string }).error, /not an earlier task/);
  const ok = parsePlan(body);
  assert.ok(!("error" in ok) && ok.tasks[1]!.id === "t2" && ok.tasks[1]!.after[0] === "t1");
});

test("each task is routed: the pick, every model that can run it, and the review by another engine", () => {
  const plan = planned();
  assert.equal(plan.tasks[0]!.model, "opus");
  assert.equal(plan.tasks[0]!.review, true);
  assert.equal(plan.tasks[0]!.reviewer, "codex:gpt-6.1-sol");
  assert.ok(plan.tasks[0]!.options.includes("codex:gpt-6.1-sol"));
  assert.equal(plan.tasks[0]!.options.some((option) => option.startsWith("local:")), false, "the router never offers a local model");
  assert.deepEqual(plan.tasks[1]!.after, ["t1"]);
  const text = planText(plan);
  assert.equal(text.title, "Plan for Corner Bakery: 2 tasks");
  assert.match(text.body, /1\. Bayou Hollow map: opus, reviewed by codex:gpt-6\.1-sol/);
  assert.match(text.body, /2\. Turn order tests: \w+ \(after t1\)/);
});

test("the Foreman may overrule the router only with a model that can run here", () => {
  const input = parsePlan({ tasks: [{ title: "x", task: "Add docs", kind: "docs", model: "gpt-9" }] });
  assert.ok(!("error" in input));
  const refused = routedPlan({ id: "p", name: "P" }, input, [route({ text: "Add docs", kind: "docs", project: { id: "p" } }, facts)]);
  assert.match((refused as { error: string }).error, /gpt-9 cannot run it here/);
});

test("your models on the card: only this plan's tasks and offered models; a reviewed task keeps a reviewer on another engine", () => {
  const plan = planned();
  const changed = chooseModels(plan, { t1: "codex:gpt-6.1-sol" });
  assert.ok(!("error" in changed));
  assert.equal(changed.tasks[0]!.model, "codex:gpt-6.1-sol");
  assert.equal(changed.tasks[0]!.reviewer, "opus");
  assert.match(changed.tasks[0]!.reason, /^You chose codex:gpt-6\.1-sol\./);
  assert.match((chooseModels(plan, { t9: "opus" }) as { error: string }).error, /no task t9/);
  assert.match((chooseModels(plan, { t1: "gpt-9" }) as { error: string }).error, /cannot run on gpt-9/);
  assert.equal(chooseModels(plan, undefined), plan);
  assert.equal(reviewerFor("local:qwen", ["local:qwen", "opus"]), "opus");
  assert.equal(reviewerFor("opus", ["opus", "sonnet", "local:qwen"]), null);
});

test("the Foreman hears what started, what waits and what could not", () => {
  const plan = planned();
  const done = { ...plan, tasks: [{ ...plan.tasks[0]!, worker: "w_1" }, { ...plan.tasks[1]!, queued: "q_2" }] };
  assert.match(planNews("ap_1", done, true), /t1 started as Worker w_1 on opus; t2 waits as q_2/);
  assert.match(planNews("ap_1", plan, false), /declined plan ap_1/);
});

test("a planner task: the router's pick plans and the runner-up builds, unless the Foreman names a doer that can run it", () => {
  const input = parsePlan({ tasks: [{ title: "Turf system", task: "Add the turf system.", kind: "feature", size: "L", role: "planner" }] });
  assert.ok(!("error" in input));
  const routes = input.tasks.map((task) => route({ text: task.task, kind: task.kind, size: "L", project: { id: "p" } }, facts));
  const plan = routedPlan({ id: "p", name: "P" }, input, routes);
  assert.ok(!("error" in plan));
  assert.equal(plan.tasks[0]!.model, "opus");
  assert.equal(plan.tasks[0]!.doer, plan.tasks[0]!.runnerUp);
  assert.match(planText(plan).body, /opus plans, \S+ builds/);
  const local = parsePlan({ tasks: [{ title: "x", task: "y", kind: "feature", role: "planner", doer: "local:qwen" }] });
  assert.ok(!("error" in local));
  assert.match((routedPlan({ id: "p", name: "P" }, local, [route({ text: "y", kind: "feature", project: { id: "p" } }, facts)]) as { error: string }).error, /cannot implement it here/);
  assert.match((parsePlan({ tasks: [{ title: "x", task: "y", kind: "feature", role: "doer" }] }) as { error: string }).error, /role is planner/);
});

test("a plan task's research goal is checked, kept on the routed task and shown on the card", () => {
  const goal = "yoga studios in Grand Cayman: public contact email";
  assert.match((parsePlan({ tasks: [{ title: "Leads", task: "Find leads", kind: "docs", research: "web" }] }) as { error: string }).error, /research is 8 to 400/);
  const input = parsePlan({ tasks: [{ title: "Leads", task: "Find 20 studio leads and write leads.csv", kind: "docs", size: "S", research: goal }, { title: "Tidy", task: "Tidy the README", kind: "docs", size: "S" }] });
  assert.ok(!("error" in input));
  assert.equal(input.tasks[0]?.research, goal);
  assert.equal(input.tasks[1]?.research, undefined);
  const routes = input.tasks.map((task) => route({ text: task.task, kind: task.kind, ...(task.size ? { size: task.size } : {}), files: task.files, project: { id: "p" } }, facts));
  const plan = routedPlan({ id: "p", name: "P" }, input, routes);
  assert.ok(!("error" in plan));
  assert.equal(plan.tasks[0]?.research, goal);
  assert.match(planText(plan).body, /researches the web: yoga studios/);
});

test("a task with research never goes to Codex, which has no web tools: named, it is refused; picked, the next model takes it", () => {
  const goal = "yoga studios on the US west coast: public contact email";
  const named = parsePlan({ tasks: [{ title: "Leads", task: "Find 20 studio leads", kind: "docs", size: "S", research: goal, model: "codex:gpt-6.1-sol" }] });
  assert.ok(!("error" in named));
  const routes = named.tasks.map((task) => route({ text: task.task, kind: task.kind, size: "S", project: { id: "p" } }, facts));
  assert.match((routedPlan({ id: "p", name: "P" }, named, routes) as { error: string }).error, /cannot read the web/);

  // A router that would pick Codex here: the research task takes the next model that can run it.
  const input = parsePlan({ tasks: [{ title: "Leads", task: "Find 20 studio leads", kind: "docs", size: "S", research: goal }] });
  assert.ok(!("error" in input));
  const codexFirst = { ...routes[0]!, pick: "codex:gpt-6.1-sol" };
  const plan = routedPlan({ id: "p", name: "P" }, input, [codexFirst]);
  assert.ok(!("error" in plan));
  assert.ok(!plan.tasks[0]!.model.startsWith("codex"), plan.tasks[0]!.model);
});
