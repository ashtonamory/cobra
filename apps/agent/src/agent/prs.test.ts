import { test } from "node:test";
import assert from "node:assert/strict";

import { PrList, type GitState, type ProjectState, type RepoPr } from "@cobra/contracts";

import { cachedPrs, resetGitSyncState } from "./gitsync.ts";
import { prList } from "./prs.ts";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const HERE = { ghFound: true, syncOn: true, machine: "legion" };

function project(id: string, remote: string | null, extra: Partial<ProjectState> = {}): ProjectState {
  return {
    id,
    name: id,
    machine: "legion",
    path: `/home/a/Projects/${id}`,
    session: id,
    activity: "none",
    lastActivityAt: null,
    command: null,
    attached: false,
    needsInput: false,
    dialog: null,
    tail: [],
    git: remote === null ? null : ({ remote } as GitState),
    sessionCreatedAt: null,
    windows: 0,
    ...extra,
  } as ProjectState;
}

function pr(number: number, extra: Partial<RepoPr> = {}): RepoPr {
  return {
    number,
    title: `PR ${number}`,
    head: `feat/${number}`,
    base: "main",
    createdAt: "2026-10-09T08:00:00Z",
    ageDays: 0,
    isDraft: false,
    author: "octocat",
    mergeable: "MERGEABLE",
    checks: "green",
    url: `https://github.com/a/b/pull/${number}`,
    ...extra,
  };
}

test("every repository's cached PRs, with when gh last read them, in the contract's shape", () => {
  const cache = new Map([
    ["/home/a/Projects/cobra", { at: "2026-10-09T11:55:00.000Z", prs: [pr(201), pr(202, { checks: "red" })] }],
    ["/home/a/Projects/book", { at: "2026-10-09T11:50:00.000Z", prs: [] }],
  ]);
  const list = prList(
    [project("cobra", "octocat/cobra"), project("book", "octocat/book-club"), project("notes", "octocat/notes"), project("scratch", null)],
    (path) => cache.get(path) ?? null,
    HERE,
    NOW,
  );
  assert.doesNotThrow(() => PrList.parse(list));
  assert.equal(list.machine, "legion");
  assert.equal(list.prError, null);
  assert.equal(list.at, "2026-10-09T12:00:00.000Z");
  assert.deepEqual(
    list.repos.map((r) => [r.project, r.remote, r.readAt, r.prs?.map((p) => p.number) ?? null]),
    [
      ["book", "octocat/book-club", "2026-10-09T11:50:00.000Z", []],
      ["cobra", "octocat/cobra", "2026-10-09T11:55:00.000Z", [201, 202]],
      // Not read yet: listed, so the desk can say so, but with no PRs.
      ["notes", "octocat/notes", null, null],
    ],
  );
  const first = list.repos[1]!.prs![0]!;
  assert.deepEqual(
    [first.title, first.head, first.author, first.isDraft, first.mergeable, first.checks, first.url, first.createdAt],
    ["PR 201", "feat/201", "octocat", false, "MERGEABLE", "green", "https://github.com/a/b/pull/201", "2026-10-09T08:00:00Z"],
  );
});

test("extra sessions, Workers, Foremen and the Lead are not repositories of their own", () => {
  const read = () => ({ at: "2026-10-09T11:55:00.000Z", prs: [pr(1)] });
  const list = prList(
    [
      project("cobra", "octocat/cobra"),
      project("cobra_2", "octocat/cobra", { parent: "cobra", branch: "fix/x" }),
      project("cobra_fm", "octocat/cobra", { parent: "cobra", foreman: true }),
      project("cobra_lead", "octocat/cobra", { lead: true }),
    ],
    read,
    HERE,
    NOW,
  );
  assert.deepEqual(list.repos.map((r) => r.project), ["cobra"]);
});

test("two checkouts of one repository on this computer: the fresher read speaks for it", () => {
  const cache = new Map([
    ["/home/a/Projects/cp", { at: "2026-10-09T11:00:00.000Z", prs: [pr(1), pr(2)] }],
    ["/home/a/Projects/cp-2", { at: "2026-10-09T11:58:00.000Z", prs: [pr(2)] }],
  ]);
  const list = prList([project("cp", "a/control-plane"), project("cp-2", "a/control-plane")], (path) => cache.get(path) ?? null, HERE, NOW);
  assert.equal(list.repos.length, 1);
  assert.equal(list.repos[0]?.project, "cp-2");
  assert.deepEqual(list.repos[0]?.prs?.map((p) => p.number), [2]);
});

test("no gh, or git sync off: the reason, with whatever was read", () => {
  const none = prList([project("cobra", "a/cobra")], () => null, { ...HERE, ghFound: false }, NOW);
  assert.equal(none.prError, "gh is not installed on this machine");
  assert.equal(none.repos[0]?.prs, null);
  const off = prList([project("cobra", "a/cobra")], () => null, { ...HERE, syncOn: false }, NOW);
  assert.match(off.prError ?? "", /git sync is off/);
});

test("the route reads git sync's own cache, which starts empty: no gh call is made for it", () => {
  resetGitSyncState();
  const list = prList([project("cobra", "a/cobra")], cachedPrs, HERE, NOW);
  assert.deepEqual(list.repos, [{ project: "cobra", projectName: "cobra", remote: "a/cobra", readAt: null, prs: null }]);
});
