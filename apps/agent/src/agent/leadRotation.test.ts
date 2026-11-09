import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ThreadEntry } from "@cobra/contracts";

import { dropHandoff, KEPT, takeHandoff, writeHandoff } from "./handoff.ts";
import {
  cleanNote,
  conversationLines,
  factsText,
  type HandoffDeps,
  CONTEXT_ROTATE_TOKENS,
  FULL_GAP_MS,
  IDLE_GAP_MS,
  makeHandoff,
  NOTE_CHARS,
  noteInput,
  type OpenFacts,
  PLAIN_LINES,
  plainNote,
  type RotationFacts,
  shouldRotate,
  THREAD_CHARS,
} from "./leadRotation.ts";
import { lastContextTokens } from "./leadRotationLive.ts";

const quiet: RotationFacts = {
  enabled: true,
  running: true,
  idleMs: IDLE_GAP_MS + 1,
  contextTokens: 40_000,
  said: true,
  working: false,
  dialog: false,
  openAsk: false,
  approvals: 0,
  foremenBusy: [],
};

let id = 0;
const entry = (kind: string, text: string, conversation = "c1"): ThreadEntry => ({ id: ++id, at: "2026-10-26T10:00:00.000Z", kind, conversation, text });

const none: OpenFacts = { foremen: [], workers: [], waiting: [], today: [] };

test("two quiet hours with nothing open start her afresh", () => {
  assert.deepEqual(shouldRotate(quiet), { rotate: true, reason: "idle" });
  assert.deepEqual(shouldRotate({ ...quiet, contextTokens: null }), { rotate: true, reason: "idle" });
});

test("a conversation past 100k tokens starts afresh after ten quiet minutes, with every hold still holding", () => {
  const full = { ...quiet, contextTokens: CONTEXT_ROTATE_TOKENS, idleMs: FULL_GAP_MS };
  assert.deepEqual(shouldRotate(full), { rotate: true, reason: "context" });
  assert.deepEqual(shouldRotate({ ...full, idleMs: IDLE_GAP_MS + 1 }), { rotate: true, reason: "idle" });
  assert.deepEqual(shouldRotate({ ...full, idleMs: FULL_GAP_MS - 1 }), { rotate: false, why: "not quiet long enough" });
  assert.deepEqual(shouldRotate({ ...full, contextTokens: CONTEXT_ROTATE_TOKENS - 1 }), { rotate: false, why: "not quiet long enough" });
  assert.deepEqual(shouldRotate({ ...full, foremenBusy: ["northwind"] }), { rotate: false, why: "northwind still at work for her" });
  assert.deepEqual(shouldRotate({ ...full, working: true }), { rotate: false, why: "working" });
});

test("her last call's context is read from the end of her transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-ctx-"));
  const file = join(dir, "lead.jsonl");
  const call = (input: number, read: number, write: number) => JSON.stringify({ type: "assistant", message: { usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 50 } } });
  writeFileSync(file, [call(1, 90_000, 2_000), call(3, 150_000, 1_200), JSON.stringify({ type: "user", message: { content: "next" } }), ""].join("\n"));
  assert.equal(lastContextTokens(file), 151_203);
  writeFileSync(file, JSON.stringify({ type: "user", message: { content: "hi" } }));
  assert.equal(lastContextTokens(file), null);
  assert.equal(lastContextTokens(join(dir, "missing.jsonl")), null);
});

test("each hold keeps her conversation", () => {
  const held: Array<[Partial<RotationFacts>, string]> = [
    [{ enabled: false }, "off"],
    [{ running: false }, "not running"],
    [{ idleMs: null }, "a new conversation"],
    [{ said: false }, "a new conversation"],
    [{ working: true }, "working"],
    [{ idleMs: IDLE_GAP_MS - 1 }, "not quiet long enough"],
    [{ dialog: true }, "her question is on screen"],
    [{ openAsk: true }, "her question waits for an answer"],
    [{ approvals: 2 }, "2 of her requests wait for an answer"],
    [{ foremenBusy: ["cobra", "plant-shop"] }, "cobra, plant-shop still at work for her"],
  ];
  for (const [change, why] of held) assert.deepEqual(shouldRotate({ ...quiet, ...change }), { rotate: false, why }, why);
});

test("the conversation reads as who said what, markers and unknown kinds left out", () => {
  const lines = conversationLines([
    entry("session", ""),
    entry("you", "Ship the  invoice\nfix"),
    entry("cobra", "On it."),
    entry("question", "Which client?"),
    entry("answer", "Pete"),
    entry("someday", "a kind from a newer agent"),
    entry("cobra", "   "),
  ]);
  assert.deepEqual(lines, ["Person: Ship the invoice fix", "Cobra: On it.", "Cobra asked: Which client?", "Person answered: Pete"]);
});

test("the model reads the end of a long conversation, fenced, secrets scrubbed", () => {
  const long = Array.from({ length: 400 }, (_, n) => entry("you", `line ${n} ${"x".repeat(100)}`));
  const input = noteInput([...long, entry("cobra", "the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789")]);
  assert.ok(input.startsWith("<conversation>\n…"));
  assert.ok(input.endsWith("</conversation>"));
  assert.ok(input.length <= THREAD_CHARS + 40);
  assert.ok(!input.includes("line 0 "));
  assert.ok(!input.includes("abcdefghijklmnopqrstuvwxyz0123456789"));
});

test("a note comes back trimmed to its length without headings; an empty one is none", () => {
  assert.equal(cleanNote("# Handoff\n\nShe was fixing the invoice."), "She was fixing the invoice.");
  assert.equal(cleanNote("  \n"), null);
  const long = cleanNote("y".repeat(NOTE_CHARS + 50));
  assert.equal(long?.length, NOTE_CHARS);
  assert.ok(long?.endsWith("…"));
});

test("with no model the note is the last lines as said", () => {
  const entries = Array.from({ length: PLAIN_LINES + 4 }, (_, n) => entry(n % 2 ? "cobra" : "you", `message ${n}`));
  const note = plainNote(entries).split("\n");
  assert.equal(note.length, PLAIN_LINES);
  assert.equal(note[0], "Person: message 4");
  assert.equal(note.at(-1), `Cobra: message ${PLAIN_LINES + 3}`);
});

test("what is open is listed in code, or said to be nothing", () => {
  assert.equal(factsText(none), "- Nothing running and nothing waiting.");
  const text = factsText({
    foremen: [{ project: "cobra", state: "working" }],
    workers: [
      { project: "cobra", count: 2 },
      { project: "northwind", count: 1 },
    ],
    waiting: ["Merge 2 PRs?"],
    today: [{ project: "billing", name: "Invoices", at: new Date(2026, 9, 26, 17, 5).toISOString() }],
  });
  assert.equal(
    text,
    [
      "- Foreman for cobra: working",
      "- 2 Workers at work in cobra",
      "- 1 Worker at work in northwind",
      "- Waits for the person: Merge 2 PRs?",
      "- Routine due today at 17:05: Invoices (billing)",
    ].join("\n"),
  );
});

const deps = (over: Partial<HandoffDeps> = {}): HandoffDeps & { lines: string[] } => {
  const lines: string[] = [];
  return {
    models: async () => ["haiku"],
    run: async () => "She was fixing the invoice for Pete.",
    facts: async () => none,
    log: (line) => lines.push(line),
    now: () => new Date("2026-10-26T12:00:00.000Z"),
    lines,
    ...over,
  };
};

test("the handoff carries the model's note and the open facts, fenced as data", async () => {
  const text = await makeHandoff(deps(), [entry("you", "Fix Pete's invoice")], "idle", 1000);
  assert.ok(text.startsWith('<cobra-handoff written="2026-10-26T12:00:00.000Z" reason="idle">'));
  assert.ok(text.includes("two quiet hours"));
  assert.ok(text.includes("Where you left off:\nShe was fixing the invoice for Pete."));
  assert.ok(text.includes("Still open now:\n- Nothing running and nothing waiting."));
  assert.ok(text.endsWith("</cobra-handoff>"));
});

test("a failed model falls to the next, then to the last lines; it never fails", async () => {
  const tried: string[] = [];
  const failing = deps({
    models: async () => ["haiku", "sonnet"],
    run: async (model) => {
      tried.push(model);
      throw new Error("timed out");
    },
    facts: async () => {
      throw new Error("no projects");
    },
  });
  const text = await makeHandoff(failing, [entry("you", "Fix Pete's invoice")], "new-conversation", 1000);
  assert.deepEqual(tried, ["haiku", "sonnet"]);
  assert.equal(failing.lines.length, 2);
  assert.ok(text.includes("the person asked for a new conversation"));
  assert.ok(text.includes("Where you left off (its last lines, as said):\nPerson: Fix Pete's invoice"));
  assert.ok(text.includes("- Nothing running and nothing waiting."));
});

test("at HOLD, or with nothing said, no model runs", async () => {
  let runs = 0;
  const counted = { run: async () => (runs++, "note") };
  await makeHandoff(deps({ ...counted, models: async () => [] }), [entry("you", "hi")], "idle", 1000);
  const empty = await makeHandoff(deps(counted), [entry("session", "")], "new-conversation", 1000);
  assert.equal(runs, 0);
  assert.ok(empty.includes("(Nothing was said.)"));
});

const handoffDir = () => mkdtempSync(join(tmpdir(), "cobra-handoff-"));

test("a handoff is read once, then kept aside", () => {
  const dir = handoffDir();
  assert.equal(takeHandoff(dir), "");
  writeHandoff("<cobra-handoff>note</cobra-handoff>", dir);
  assert.equal(takeHandoff(dir), "<cobra-handoff>note</cobra-handoff>");
  assert.equal(takeHandoff(dir), "");
  assert.equal(readdirSync(dir).filter((name) => name.startsWith("handoff-")).length, 1);
});

test("a stale handoff is never read into a later start", () => {
  const dir = handoffDir();
  writeHandoff("old note", dir);
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(join(dir, "handoff.md"), old, old);
  assert.equal(takeHandoff(dir), "");
  assert.ok(!existsSync(join(dir, "handoff.md")));
});

test("a dropped handoff is gone, and only the newest are kept", () => {
  const dir = handoffDir();
  writeHandoff("note", dir);
  dropHandoff(dir);
  assert.equal(takeHandoff(dir), "");
  for (let n = 0; n < KEPT + 3; n++) writeFileSync(join(dir, `handoff-2026-10-0${n % 9}T00-00-${String(n).padStart(2, "0")}-000Z.md`), "x");
  writeHandoff("newest", dir);
  assert.equal(takeHandoff(dir, new Date("2026-10-26T12:00:00.000Z")), "newest");
  assert.equal(readdirSync(dir).filter((name) => name.startsWith("handoff-")).length, KEPT);
});
