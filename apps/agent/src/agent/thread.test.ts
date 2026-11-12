import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ThreadEntry } from "@cobra/contracts";

import { conversationOf, createThreadStore, entriesFrom, forCobra, NEW_CONVERSATION, pageOf, type ThreadSource } from "./thread.ts";
import { readTranscript } from "./transcript.ts";

const dir = () => mkdtempSync(join(tmpdir(), "cobra-thread-"));

const user = (uuid: string, text: string) => JSON.stringify({ type: "user", uuid, timestamp: `2026-10-26T10:00:0${uuid.length}Z`, message: { content: text } });
const said = (uuid: string, text: string) =>
  JSON.stringify({ type: "assistant", uuid, timestamp: "2026-10-26T10:01:00Z", message: { model: "claude-opus-5-5", content: [{ type: "text", text }] } });
const tool = (uuid: string, name: string, input: unknown) =>
  JSON.stringify({ type: "assistant", uuid, timestamp: "2026-10-26T10:02:00Z", message: { content: [{ type: "tool_use", id: `t-${uuid}`, name, input }] } });
const answered = (uuid: string, toolId: string, answers: Record<string, string>) =>
  JSON.stringify({ type: "user", uuid, timestamp: "2026-10-26T10:03:00Z", message: { content: [{ type: "tool_result", tool_use_id: toolId, content: "answered" }] }, toolUseResult: { answers } });

const ASK = { questions: [{ question: "Which one first?", header: "Order", multiSelect: false, options: [{ label: "Billing", description: "" }, { label: "Payroll", description: "" }] }] };

function transcript(folder: string, name: string, lines: string[]): string {
  const file = join(folder, `${name}.jsonl`);
  writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
  return file;
}

const claude = (file: string): ThreadSource => ({ file, read: readTranscript });

test("status lines typed into her session for her are hers, not the person's", () => {
  assert.equal(forCobra("[cobra] Worker w3 finished: worker_read w3 after=12"), true);
  assert.equal(forCobra("  [cobra] Foreman for payroll is idle"), true);
  assert.equal(forCobra("What did [cobra] do today?"), false);
});

test("the thread keeps what was said, her questions and the answers, and leaves out tools and status lines", async () => {
  const folder = dir();
  const file = transcript(folder, "abc-123", [
    user("u1", "Plan the payroll run"),
    said("a1", "On it. Two things first."),
    tool("a2", "Read", { file_path: "/x" }),
    tool("a3", "AskUserQuestion", ASK),
    answered("u22", "t-a3", { "Which one first?": "Payroll" }),
    user("u333", "[cobra] Foreman for payroll finished: foreman_read payroll after=40"),
    said("a4", "Payroll's Foreman has it."),
  ]);
  const read = await readTranscript(file, 0);
  const entries = entriesFrom(read.messages, conversationOf(file));
  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.text]),
    [
      ["you", "Plan the payroll run"],
      ["cobra", "On it. Two things first."],
      ["question", "Which one first?"],
      ["answer", "Payroll"],
      ["cobra", "Payroll's Foreman has it."],
    ],
  );
  assert.equal(entries[0]!.conversation, "abc-123");
  assert.equal(entries[2]!.questions?.[0]?.options.length, 2);
  assert.deepEqual(entries[3]!.answers, { "Which one first?": "Payroll" });
});

test("ingest copies only what is new, and marks each new conversation with why it began", async () => {
  const folder = dir();
  const store = createThreadStore(join(folder, "thread"), () => new Date("2026-10-26T12:00:00Z"));
  assert.equal(store.exists(), false);
  assert.equal(await store.ingest(null), 0, "not running: nothing");

  const first = transcript(folder, "s1", [user("u1", "Hello"), said("a1", "Hi")]);
  assert.equal(await store.ingest(claude(first)), 3);
  assert.equal(await store.ingest(claude(first)), 0, "nothing new");
  appendFileSync(first, `${said("a2", "Anything else?")}\n`);
  assert.equal(await store.ingest(claude(first)), 1);
  assert.equal(store.current(), "s1");

  store.markNext("new-conversation");
  const second = transcript(folder, "s2", [user("u1", "Fresh start")]);
  assert.equal(await store.ingest(claude(second)), 2);
  // A conversation that began on its own (a restart) says start.
  const third = transcript(folder, "s3", [said("a1", "Back")]);
  await store.ingest(claude(third));

  const page = store.page({});
  assert.deepEqual(
    page.entries.map((entry) => [entry.id, entry.kind, entry.conversation, entry.reason ?? entry.text]),
    [
      [1, "session", "s1", "start"],
      [2, "you", "s1", "Hello"],
      [3, "cobra", "s1", "Hi"],
      [4, "cobra", "s1", "Anything else?"],
      [5, "session", "s2", "new-conversation"],
      [6, "you", "s2", "Fresh start"],
      [7, "session", "s3", "start"],
      [8, "cobra", "s3", "Back"],
    ],
  );
  assert.equal(page.more, false);
  assert.equal(store.exists(), true);
});

test("a new conversation with no transcript yet is current, so the one before reads as earlier", async () => {
  const folder = dir();
  const store = createThreadStore(join(folder, "thread"));
  const first = transcript(folder, "s1", [user("u1", "Hello")]);
  await store.ingest(claude(first));
  assert.equal(store.current(), "s1");
  store.markNext("new-conversation");
  // New conversation: she runs again (headless, say) but has written nothing yet.
  assert.equal(await store.ingest(null), 0);
  assert.equal(store.current(), NEW_CONVERSATION);
  assert.equal(store.page({}).entries.every((entry) => entry.conversation !== store.current()), true);
  // Her first message: the new file is read after a marker that says why it began.
  const second = transcript(folder, "s2", [user("u1", "Again")]);
  assert.equal(await store.ingest(claude(second)), 2);
  assert.equal(store.current(), "s2");
  assert.deepEqual(store.page({ limit: 2 }).entries.map((entry) => entry.reason ?? entry.text), ["new-conversation", "Again"]);
  // A store opened afresh (an agent restart) knows the last one read until it reads again.
  assert.equal(createThreadStore(join(folder, "thread")).current(), "s2");
});

test("a half-written last line waits for the next read", async () => {
  const folder = dir();
  const store = createThreadStore(join(folder, "thread"));
  const file = transcript(folder, "s1", [user("u1", "One")]);
  appendFileSync(file, said("a1", "Two").slice(0, 30));
  assert.equal(await store.ingest(claude(file)), 2);
  appendFileSync(file, `${said("a1", "Two").slice(30)}\n`);
  assert.equal(await store.ingest(claude(file)), 1);
  assert.deepEqual(store.page({}).entries.map((entry) => entry.text), ["", "One", "Two"]);
});

test("entries are filed by the month they were written and numbered across months", () => {
  const folder = join(dir(), "thread");
  let now = new Date(2026, 9, 31, 23, 0);
  const store = createThreadStore(folder, () => now);
  store.append([{ at: now.toISOString(), kind: "you", conversation: "s1", text: "October" }]);
  now = new Date(2026, 10, 1, 9, 0);
  store.append([{ at: now.toISOString(), kind: "morning", conversation: "s1", text: "November" }]);
  assert.deepEqual(readdirSync(folder).filter((name) => name.endsWith(".jsonl")).sort(), ["2026-10.jsonl", "2026-11.jsonl"]);
  assert.deepEqual(store.page({}).entries.map((entry) => [entry.id, entry.text]), [[1, "October"], [2, "November"]]);
});

test("pages: the newest, older before an id, newer after one", () => {
  const all: ThreadEntry[] = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, at: "", kind: "you", conversation: "s", text: String(index + 1) }));
  const ids = (page: { entries: ThreadEntry[] }) => page.entries.map((entry) => entry.id);
  assert.deepEqual(ids(pageOf(all, { limit: 3 })), [8, 9, 10]);
  assert.equal(pageOf(all, { limit: 3 }).more, true);
  assert.deepEqual(ids(pageOf(all, { before: 8, limit: 3 })), [5, 6, 7]);
  assert.deepEqual(ids(pageOf(all, { before: 3, limit: 5 })), [1, 2]);
  assert.equal(pageOf(all, { before: 3, limit: 5 }).more, false);
  assert.deepEqual(ids(pageOf(all, { after: 8 })), [9, 10]);
  assert.deepEqual(ids(pageOf(all, { after: 2, limit: 2 })), [3, 4]);
  assert.deepEqual(ids(pageOf(all, { after: 10 })), []);
  assert.deepEqual(ids(pageOf(all, { limit: 1000 })).length, 10, "at most MAX_LIMIT, and the log is smaller");
  assert.deepEqual(pageOf([], {}), { entries: [], more: false });
});

test("a conversation's entries are read by its id, oldest first", () => {
  const store = createThreadStore(dir());
  store.append([
    { at: "2026-10-26T10:00:00.000Z", kind: "you", conversation: "a", text: "one" },
    { at: "2026-10-26T10:01:00.000Z", kind: "cobra", conversation: "b", text: "two" },
    { at: "2026-10-26T10:02:00.000Z", kind: "cobra", conversation: "a", text: "three" },
  ]);
  assert.deepEqual(store.conversation("a").map((entry) => entry.text), ["one", "three"]);
  assert.deepEqual(store.conversation("none"), []);
});
