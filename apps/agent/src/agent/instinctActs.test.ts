import { test } from "node:test";
import assert from "node:assert/strict";
import type { StoredApproval } from "./approvals.ts";
import { actsAlone, deploysOnMerge, runsOnPushToMain, mergeDeploys, mergeOnGreenAt, productionDeployments, projectOf, receiptWords, type DeployReader } from "./instinctActs.ts";

function card(kind: string, extra: Record<string, unknown> = {}): StoredApproval {
  return {
    id: "ap_1",
    machine: "legion",
    kind,
    title: `A ${kind}`,
    body: "What it does",
    createdAt: "2026-10-25T10:00:00.000Z",
    expiresAt: "2026-10-25T16:00:00.000Z",
    state: "pending",
    requestedBy: "Foreman for cobra",
    ...extra,
  } as unknown as StoredApproval;
}

const plan = (models: string[]) => card("plan", { plan: { project: "cobra", projectName: "cobra", tasks: models.map((model, index) => ({ id: `t${index}`, model })) } });
const EMPTY = { version: 1, revision: 1 } as const;
const everywhere = () => true;
const nowhere = () => false;

test("Instinct allows the orchestrators' low-stakes cards and nothing else", () => {
  for (const kind of ["routine", "trade", "org"]) assert.equal(actsAlone(card(kind), everywhere), "allowed on your Instinct policy", kind);
  for (const kind of ["merge", "land", "action", "import", "trust", "mcp-verify"]) assert.equal(actsAlone(card(kind), everywhere), null, kind);
});

test("only under Instinct, read where the card belongs", () => {
  assert.equal(actsAlone(plan(["sonnet"]), nowhere), null);
  const asked: Array<string | null> = [];
  actsAlone(plan(["sonnet"]), (project) => (asked.push(project), true));
  actsAlone(card("routine", { routine: { project: "stable" } }), (project) => (asked.push(project), true));
  actsAlone(card("org"), (project) => (asked.push(project), true));
  assert.deepEqual(asked, ["cobra", "stable", null]);
  assert.equal(projectOf(card("trade")), null);
});

test("a plan starts by itself unless a task spends API money", () => {
  assert.equal(actsAlone(plan(["sonnet"]), everywhere), "started 1 task on your Instinct policy");
  assert.equal(actsAlone(plan(["haiku", "local:qwen3:4b", "codex"]), everywhere), "started 3 tasks on your Instinct policy");
  assert.equal(actsAlone(plan(["sonnet", "api:opus"]), everywhere), null);
  assert.equal(actsAlone(plan(["api"]), everywhere), null);
  assert.equal(actsAlone(plan([]), everywhere), null);
});

test("an answered card is never answered again", () => {
  assert.equal(actsAlone(card("routine", { state: "denied" }), everywhere), null);
  assert.equal(actsAlone(card("trade", { state: "expired" }), everywhere), null);
});

test("the receipt says what Cobra did and how to take it back", () => {
  const started = receiptWords(plan(["sonnet", "haiku"]), "started 2 tasks on your Instinct policy");
  assert.equal(started.title, "Cobra started 2 tasks: A plan");
  assert.match(started.body, /Stop any of them/);
  const routine = receiptWords(card("routine"), "allowed on your Instinct policy");
  assert.equal(routine.title, "Cobra did: A routine");
  assert.match(routine.body, /^What it does\n\nPause or remove it/);
});

test("merge on green: a written setting wins, else Instinct unless the repo deploys", () => {
  const deploys = () => true;
  const quiet = () => false;
  assert.equal(mergeOnGreenAt(EMPTY, {}, false, quiet), false);
  assert.equal(mergeOnGreenAt(EMPTY, {}, true, quiet), true);
  assert.equal(mergeOnGreenAt(EMPTY, {}, true, deploys), false);
  // A local model's work asks under Instinct; only a written setting merges it.
  assert.equal(mergeOnGreenAt(EMPTY, {}, true, quiet, true), false);
  assert.equal(mergeOnGreenAt({ ...EMPTY, foreman: { mergeOnGreen: true } } as never, {}, true, quiet, true), true);
  const off = { foreman: { mergeOnGreen: false } } as never;
  assert.equal(mergeOnGreenAt(off, {}, true, quiet), false);
  const on = { projects: { "a/b": { foreman: { mergeOnGreen: true } } }, computers: { legion: { foreman: { mergeOnGreen: false } } } } as never;
  assert.equal(mergeOnGreenAt(on, { computer: "legion", project: "a/b" }, false, deploys), true);
  assert.equal(mergeOnGreenAt(on, { computer: "legion", project: "c/d" }, true, quiet), false);
});

test("deploy on merge: hosts that build main and workflows that deploy on a push", () => {
  assert.equal(deploysOnMerge(new Map()), null);
  assert.match(deploysOnMerge(new Map([["vercel.json", ""]]))!, /Vercel/);
  assert.match(deploysOnMerge(new Map([["wrangler.jsonc", ""]]))!, /Cloudflare/);
  const ci = "on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm check\n";
  assert.equal(deploysOnMerge(new Map([[".github/workflows/ci.yml", ci]])), null);
  const deploy = "on:\n  push:\n    branches: [main]\njobs:\n  ship:\n    steps:\n      - run: npx vercel deploy --prod\n";
  assert.match(deploysOnMerge(new Map([[".github/workflows/ship.yml", deploy]]))!, /ship\.yml runs on a push to main/);
  const tagged = "on:\n  push:\n    tags: ['v*']\njobs:\n  release:\n    steps:\n      - run: gh release create\n";
  assert.equal(deploysOnMerge(new Map([[".github/workflows/release.yml", tagged]])), null);
  const eas = "on:\n  push:\n    branches: ['main']\njobs:\n  update:\n    type: update\n    steps:\n      - run: eas update --auto\n";
  assert.match(deploysOnMerge(new Map([[".eas/workflows/ota.yml", eas]]))!, /ota\.yml/);
});

test("a push to main is read from the workflow's own trigger", () => {
  assert.equal(runsOnPushToMain("on: push\n"), true);
  assert.equal(runsOnPushToMain("on: [push, pull_request]\n"), true);
  assert.equal(runsOnPushToMain("on: pull_request\n"), false);
  assert.equal(runsOnPushToMain("on:\n  push:\n  pull_request:\n"), true);
  assert.equal(runsOnPushToMain("on:\n  push:\n    branches: [main]\n"), true);
  assert.equal(runsOnPushToMain("on:\n  push:\n    branches:\n      - 'master'\n    paths: [src/**]\n"), true);
  assert.equal(runsOnPushToMain("on:\n  push:\n    branches: ['**']\n"), true);
  assert.equal(runsOnPushToMain("on:\n  push:\n    branches-ignore: [wip/**]\n"), true);
  // FilmCraft's release.yml: every push to `release`, never a merge to main.
  assert.equal(runsOnPushToMain("# main is never released from\nname: Release\non:\n  push:\n    branches: [release]\n  workflow_dispatch:\njobs:\n  build:\n    runs-on: main-runner\n"), false);
  assert.equal(runsOnPushToMain("on:\n  push:\n    tags: ['v*']\n"), false);
  assert.equal(runsOnPushToMain("on:\n  workflow_dispatch:\njobs: {}\n"), false);
});

test("names, comments and branch lists are not what a workflow does", () => {
  const lint = "# Quick static checks for the release pipeline\nname: Packaging lint\non:\n  push:\n    branches: [main, release]\njobs:\n  lint:\n    steps:\n      - run: shellcheck packaging/*.sh\n";
  assert.equal(deploysOnMerge(new Map([[".github/workflows/lint.yml", lint]])), null);
  const commented = "on:\n  push:\n    branches: [main]\njobs:\n  ci:\n    steps:\n      # they still compile as the Vercel functions that deploy from server/.\n      - name: Relay typecheck\n        run: npx tsc -p server\n";
  assert.equal(deploysOnMerge(new Map([[".github/workflows/ci.yml", commented]])), null);
});

test("GitHub's production deployments count, previews do not", () => {
  assert.equal(productionDeployments(["Preview", "preview – site"]), null);
  assert.match(productionDeployments(["Preview", "Production – cobra-api"])!, /Production – cobra-api/);
});

/** A repository as git and GitHub would show it: trees by commit, deployments by repo. */
function reader(trees: Record<string, Record<string, string>>, deployments: string[] | null = []): DeployReader & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    git: async (args) => {
      asked.push(args);
      if (args[0] === "rev-parse") return args[3] === "refs/remotes/origin/HEAD" && trees.aaaaaaa ? "aaaaaaa\n" : null;
      if (args[0] === "ls-tree") return trees[args[3]!] ? Object.keys(trees[args[3]!]!).join("\n") : null;
      if (args[0] === "show") {
        const [ref, name] = args[1]!.split(":");
        return trees[ref!]?.[name!] ?? null;
      }
      return null;
    },
    deployments: async () => deployments,
  };
}
const SHIP = "on:\n  push:\n    branches: [main]\njobs:\n  ship:\n    steps:\n      - run: npx vercel deploy --prod\n";

test("a merge's deploy is read from main and the head in git, never the worktree", async () => {
  assert.equal(await mergeDeploys(reader({ aaaaaaa: { "README.md": "" }, bbbbbbb: { "README.md": "" } }), { repo: "a/b", head: "bbbbbbb" }), null);
  assert.match((await mergeDeploys(reader({ aaaaaaa: { "vercel.json": "" }, bbbbbbb: {} }), { head: "bbbbbbb" }))!, /Vercel/);
  // A Worker that deletes the deploy on its branch still asks: main deploys.
  assert.match((await mergeDeploys(reader({ aaaaaaa: { ".github/workflows/ship.yml": SHIP }, bbbbbbb: {} }), { head: "bbbbbbb" }))!, /ship\.yml/);
  // One that adds a deploy asks too.
  assert.match((await mergeDeploys(reader({ aaaaaaa: {}, bbbbbbb: { ".github/workflows/ship.yml": SHIP } }), { head: "bbbbbbb" }))!, /^this PR makes it deploy/);
});

test("GitHub's deployments decide what git cannot, and anything unread asks", async () => {
  assert.match((await mergeDeploys(reader({ aaaaaaa: {} }, ["Production"]), { repo: "a/b" }))!, /production deployments/);
  assert.equal(await mergeDeploys(reader({ aaaaaaa: {} }, ["Production"]), {}), null);
  assert.match((await mergeDeploys(reader({ aaaaaaa: {} }, null), { repo: "a/b" }))!, /could not be read/);
  assert.match((await mergeDeploys(reader({}), { repo: "a/b" }))!, /origin's main could not be read/);
  assert.match((await mergeDeploys(reader({ aaaaaaa: {} }), { head: "cccccccc" }))!, /could not be read/);
  assert.match((await mergeDeploys(reader({ aaaaaaa: {} }), { head: "--output=x" }))!, /is not a commit/);
});
