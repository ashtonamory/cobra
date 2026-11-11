import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doneThreads, handleNotebook, type NotebookDeps } from "./notebook.ts";
import { doneBlock } from "./ea.ts";

// Today is Sat 2026-11-07 10:30 local; the memory folder is a throwaway, never the live one.
const NOW = new Date(2026, 10, 7, 10, 30).getTime();

function fixture(): NotebookDeps & { cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "notebook-"));
  const at = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const c = "computers/laptop";
  at(`${c}/index.json`, JSON.stringify({ computer: "laptop", host: "omarchy", at: "2026-11-07T10:00:00Z", headlines: [], sensitive: [],
    entries: [{ key: "local/northwind-marketing", company: { id: "northwind", name: "Northwind" }, day: "2026-11-07", line: "" }, { key: "octo-org/example.com", company: { id: "example-com", name: "Example.com" }, day: "", line: "" }] }));
  at(`${c}/hourly/2026-11-07/10.md`, "# laptop · 2026-11-07 10:00 – 11:00\n\n### Fleet\n- Gmail: no replies.\n\n### local/northwind-marketing\n- Sent four outreach emails to Harbour Light and others.\n");
  at(`${c}/hourly/2026-11-07/09.md`, "# laptop · 09\n\n### octo-org/example.com\n- Pricing page started.\n");
  at(`${c}/hourly/2026-11-08/01.md`, "# laptop · 01\n\n### Fleet\n- Late night.\n");
  at(`${c}/daily/2026-11-06.md`, "# laptop · daily · 2026-11-06\n\nA steady day.\n\n### local/northwind-marketing\n- Five emails went out.\n\n### Open threads\n- Allow the Northwind realtor card.\n- Update billing.\n");
  at(`${c}/daily/2026-10-20.md`, "# laptop · daily · 2026-10-20\n\nOld day.\n\n### Fleet\n- Quiet.\n");
  at(`${c}/weekly/2026-W44.md`, "# laptop · weekly · 2026-W44\n\nThe Caribbean list went out.\n\n### local/northwind-marketing\n- Harbour Light replied.\n");
  at(`${c}/companies/northwind/brain.md`, "# Northwind\n\n_Updated 2026-11-06._\n\n## What it is\nAn AI business partner.\n\n## Decisions\n- Every email waits for Allow.\n\n## People\n");
  const ticksPath = join(root, "state", "ticks.jsonl");
  return { root, computer: "laptop", now: () => NOW, ticksPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const get = (deps: NotebookDeps, path: string) => {
  const url = new URL(`http://x${path}`);
  return handleNotebook(deps, url.pathname, "GET", url, "");
};

test("a day: the day page with its threads, the hours in memory-day order, sections with companies", () => {
  const deps = fixture();
  try {
    const today = get(deps, "/notebook/day?day=2026-11-07");
    assert.equal(today.status, 200);
    const part = today.body as { daily: unknown; hours: Array<{ hour: string; sections: Array<{ key: string; company: { id: string } | null; computer: string }> }>; hoursKept: boolean };
    assert.equal(part.daily, null);
    assert.deepEqual(part.hours.map((h) => h.hour), ["09", "10"]);
    assert.deepEqual(part.hours[1]!.sections.map((s) => [s.key, s.company?.id ?? null, s.computer]), [["fleet", null, "laptop"], ["local/northwind-marketing", "northwind", "laptop"]]);
    assert.equal(part.hoursKept, true);
    const yesterday = get(deps, "/notebook/day?day=2026-11-06").body as { daily: { summary: string[]; threads: Array<{ text: string; done: boolean; company: { id: string } | null }> } };
    assert.deepEqual(yesterday.daily.summary, ["A steady day."]);
    assert.deepEqual(yesterday.daily.threads.map((t) => [t.text, t.company?.id ?? null]), [["Allow the Northwind realtor card.", "northwind"], ["Update billing.", null]]);
    assert.equal((get(deps, "/notebook/day?day=2026-10-20").body as { hoursKept: boolean }).hoursKept, false);
    assert.equal(get(deps, "/notebook/day?day=2026-09-01").status, 404);
    assert.equal(get(deps, "/notebook/day?day=bad").status, 400);
  } finally {
    deps.cleanup();
  }
});

test("a tick is kept, shows on the thread, and goes to the fold as done until unticked", () => {
  const deps = fixture();
  try {
    const tick = (done: boolean) => handleNotebook(deps, "/notebook/tick", "POST", new URL("http://x/notebook/tick"), JSON.stringify({ day: "2026-11-06", text: "Update billing.", done }));
    assert.equal(tick(true).status, 200);
    const threads = (get(deps, "/notebook/day?day=2026-11-06").body as { daily: { threads: Array<{ done: boolean }> } }).daily.threads;
    assert.deepEqual(threads.map((t) => t.done), [false, true]);
    assert.deepEqual(doneThreads(deps.ticksPath, "2026-11-07"), ["Update billing."]);
    assert.deepEqual(doneThreads(deps.ticksPath, "2026-12-30"), [], "an old tick is no longer told");
    tick(false);
    assert.deepEqual(doneThreads(deps.ticksPath, "2026-11-07"), []);
    assert.equal(handleNotebook(deps, "/notebook/tick", "POST", new URL("http://x/notebook/tick"), "{}").status, 400);
    assert.deepEqual(doneBlock(["Update billing."]), ["<done-by-person>", "- Update billing.", "</done-by-person>"]);
    assert.deepEqual(doneBlock([]), []);
  } finally {
    deps.cleanup();
  }
});

test("the shelf: the month's spines, volumes, companies and the newest line", () => {
  const deps = fixture();
  try {
    const shelf = get(deps, "/notebook/shelf?month=2026-11").body as { days: Array<{ day: string; hours: number; daily: boolean }>; weeks: string[]; companies: Array<{ id: string }>; latest: { hour: string; line: string } };
    assert.deepEqual(shelf.days.map((d) => [d.day, d.hours, d.daily]), [["2026-11-06", 2, true], ["2026-11-07", 2, false], ["2026-11-08", 1, false]]);
    assert.deepEqual(shelf.weeks, ["2026-W44"]);
    assert.deepEqual(shelf.companies.map((c) => c.id), ["example-com", "northwind"]);
    assert.equal(shelf.latest.hour, "10");
    assert.equal(get(deps, "/notebook/shelf?month=nope").status, 400);
  } finally {
    deps.cleanup();
  }
});

test("volumes, brains and search", () => {
  const deps = fixture();
  try {
    const week = get(deps, "/notebook/volume?id=2026-W44").body as { kind: string; summary: string[] };
    assert.equal(week.kind, "week");
    assert.deepEqual(week.summary, ["The Caribbean list went out."]);
    assert.equal(get(deps, "/notebook/volume?id=2026-W40").status, 404);
    const brains = get(deps, "/notebook/brains").body as { brains: Array<{ company: { name: string }; day: string; sections: Array<{ title: string }> }> };
    assert.equal(brains.brains[0]!.company.name, "Northwind");
    assert.equal(brains.brains[0]!.day, "2026-11-06");
    assert.deepEqual(brains.brains[0]!.sections.map((s) => s.title), ["What it is", "Decisions"]);
    const hits = get(deps, "/notebook/search?q=harbour").body as { hits: Array<{ place: { kind: string; id: string; hour?: string }; company: { id: string } | null }> };
    assert.deepEqual(hits.hits.map((h) => [h.place.kind, h.place.id, h.place.hour ?? null, h.company?.id ?? null]), [["hour", "2026-11-07", "10", "northwind"], ["week", "2026-W44", null, "northwind"]]);
    assert.equal(get(deps, "/notebook/search?q=a").status, 400);
  } finally {
    deps.cleanup();
  }
});
