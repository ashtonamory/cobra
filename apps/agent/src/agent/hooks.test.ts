import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { askedFor, hookStateFor, mergeState, readAsked, readHookRecords, stateOf, WORKING_STALE_MS, WORKING_TTL_MS, type HookRecord } from "./hooks.ts";

const HOOK = fileURLToPath(new URL("../../hooks/claude-hook.mjs", import.meta.url));
const NOW = 1_800_000_000_000;

function record(event: HookRecord["event"], patch: Partial<HookRecord> = {}): HookRecord {
  return { agent: "claude", session: "s1", cwd: "/home/me/web-app", event, at: NOW, ...patch };
}

/** What Claude Code does: run the hook with one event on stdin. */
function fire(dir: string, event: Record<string, unknown>): void {
  execFileSync(process.execPath, [HOOK], { input: JSON.stringify(event), env: { ...process.env, COBRA_AGENT_STATE_DIR: dir } });
}

test("each event says what the session is doing", () => {
  assert.deepEqual(
    [
      stateOf(record("UserPromptSubmit")),
      stateOf(record("PostToolUse")),
      stateOf(record("Notification", { message: "Claude needs your permission to use Bash" })),
      stateOf(record("Notification", { message: "Claude is waiting for your input" })),
      stateOf(record("Stop")),
    ].map((state) => [state.activity, state.needsInput]),
    [
      ["agent-working", false],
      ["agent-working", false],
      ["agent-idle", true],
      ["agent-idle", false],
      ["agent-idle", false],
    ],
  );
});

test("the newest hook inside a project speaks for it; a sibling folder does not", () => {
  const records = [
    record("Stop", { at: NOW - 1000 }),
    record("UserPromptSubmit", { at: NOW, cwd: "/home/me/web-app/packages/ui" }),
    record("Notification", { at: NOW + 5, cwd: "/home/me/web-app-2", message: "needs your permission" }),
  ].sort((a, b) => b.at - a.at);
  assert.equal(hookStateFor(records, "/home/me/web-app", NOW)?.activity, "agent-working");
  assert.equal(hookStateFor(records, "/home/me/other", NOW), null);
});

test("working with no word for ten minutes is a session that died: the screen decides", () => {
  const records = [record("PostToolUse", { at: NOW - WORKING_TTL_MS - 1 })];
  assert.equal(hookStateFor(records, "/home/me/web-app", NOW), null);
  const waiting = [record("Notification", { at: NOW - WORKING_TTL_MS * 3, message: "needs your permission" })];
  assert.equal(hookStateFor(waiting, "/home/me/web-app", NOW)?.needsInput, true, "a question does not expire");
});

test("hooks first; the screen corrects only an answered prompt", () => {
  const asking = stateOf(record("Notification", { message: "needs your permission" }));
  const working = stateOf(record("UserPromptSubmit"));
  // A readable screen that shows the tool running: the prompt was answered.
  assert.deepEqual(mergeState(asking, { recognised: true, working: true, needsInput: false }, "agent-working"), {
    activity: "agent-working",
    needsInput: false,
    source: "hook",
  });
  // A screen that cannot be read: the hook stands.
  assert.equal(mergeState(asking, { recognised: false, working: false, needsInput: false }, "agent-idle").needsInput, true);
  // The hook wins over a screen guess.
  assert.equal(mergeState(working, { recognised: true, working: false, needsInput: false }, "agent-idle").activity, "agent-working");
  // No hook: the screen, as before.
  assert.deepEqual(mergeState(null, { recognised: true, working: false, needsInput: true }, "agent-idle"), {
    activity: "agent-idle",
    needsInput: true,
    source: "screen",
  });
});

test("a dialog on a readable screen waits on you whatever the hooks last said", () => {
  // A second WebFetch prompt queued behind one you answered: the last hook was the first fetch's.
  const ran = stateOf(record("PostToolUse", { at: NOW - 1000 }));
  const dialog = { recognised: true, working: false, needsInput: true };
  assert.deepEqual(mergeState(ran, dialog, "agent-working", NOW), { activity: "agent-idle", needsInput: true, source: "screen" });
  assert.equal(mergeState(stateOf(record("UserPromptSubmit")), dialog, "agent-working", NOW).needsInput, true);
  // A screen that cannot be read: the hook stands.
  assert.equal(mergeState(ran, { ...dialog, recognised: false }, "agent-working", NOW).needsInput, false);
});

test("a stale working hook under a screen at rest with an empty box is idle", () => {
  const stale = stateOf(record("PostToolUse", { at: NOW - WORKING_STALE_MS - 1 }));
  const fresh = stateOf(record("PostToolUse", { at: NOW - 1000 }));
  const rest = { recognised: true, working: false, needsInput: false, inputEmpty: true };
  assert.deepEqual(mergeState(stale, rest, "agent-idle", NOW), { activity: "agent-idle", needsInput: false, source: "screen" });
  // Fresh: the screen may not have caught up with the turn yet.
  assert.equal(mergeState(fresh, rest, "agent-idle", NOW).activity, "agent-working");
  // Text typed in the box, a turn on the status line, or an unread screen: the hook stands.
  assert.equal(mergeState(stale, { ...rest, inputEmpty: false }, "agent-idle", NOW).activity, "agent-working");
  assert.equal(mergeState(stale, { ...rest, working: true }, "agent-working", NOW).activity, "agent-working");
  assert.equal(mergeState(stale, { ...rest, recognised: false }, "agent-idle", NOW).activity, "agent-working");
});

test("the real hook script records events, ends sessions, and never fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-hooks-"));
  try {
    fire(dir, { session_id: "abc-1", cwd: "/home/me/web-app", hook_event_name: "UserPromptSubmit" });
    fire(dir, { session_id: "abc-1", cwd: "/home/me/web-app", hook_event_name: "Notification", message: "Claude needs your permission to use Bash" });
    fire(dir, { session_id: "abc-1", cwd: "/home/me/web-app", hook_event_name: "PreToolUse", tool_name: "Bash" });
    const records = readHookRecords(join(dir, "hooks"));
    assert.equal(records.length, 1);
    assert.equal(records[0]!.event, "Notification", "PreToolUse is not recorded");
    assert.equal(hookStateFor(records, "/home/me/web-app", records[0]!.at)?.needsInput, true);
    fire(dir, { session_id: "abc-1", cwd: "/home/me/web-app", hook_event_name: "SessionEnd" });
    assert.equal(readHookRecords(join(dir, "hooks")).length, 0);
    // Garbage, an unknown event, a hostile session id: exit 0, nothing written outside.
    execFileSync(process.execPath, [HOOK], { input: "not json", env: { ...process.env, COBRA_AGENT_STATE_DIR: dir } });
    fire(dir, { session_id: "../../etc/x", cwd: "/tmp", hook_event_name: "Stop" });
    assert.equal(existsSync(join(dir, "hooks", "claude-etcx.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("files a day old are pruned on read", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-hooks-"));
  try {
    fire(dir, { session_id: "old", cwd: "/home/me/web-app", hook_event_name: "Stop" });
    const path = join(dir, "hooks", "claude-old.json");
    const dayAgo = (Date.now() - 25 * 60 * 60_000) / 1000;
    utimesSync(path, dayAgo, dayAgo);
    assert.deepEqual(readHookRecords(join(dir, "hooks")), []);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings.json: our hooks go in and come out; everything else stays", async () => {
  // @ts-expect-error -- plain .mjs with no type declarations
  const { addHooks, removeHooks } = await import("../../hooks/claude-settings.mjs");
  const mine = { model: "opus", permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
  const added = addHooks(mine, "/x/node /x/claude-hook.mjs");
  assert.equal(added.model, "opus");
  assert.deepEqual(added.permissions, mine.permissions);
  assert.deepEqual(Object.keys(added.hooks).sort(), ["Notification", "PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
  assert.equal(added.hooks.Stop.length, 2, "the user's own Stop hook stays beside ours");
  assert.equal(added.hooks.PostToolUse[0].matcher, "*");
  // PreToolUse for the one tool whose input the phone draws, and no other.
  assert.equal(added.hooks.PreToolUse[0].matcher, "AskUserQuestion");
  // Adding again does not duplicate; a new path replaces the old one.
  const again = addHooks(added, "/y/node /y/claude-hook.mjs");
  assert.equal(again.hooks.Stop.length, 2);
  assert.equal(again.hooks.Stop[1].hooks[0].command, "/y/node /y/claude-hook.mjs");
  // Removing leaves exactly what was there.
  assert.deepEqual(removeHooks(again), mine);
  assert.deepEqual(removeHooks(addHooks({}, "/x/claude-hook.mjs")), {});
});

test("the settings helper works as a command, run through a symlink as the installer does", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-settings-"));
  try {
    const helper = fileURLToPath(new URL("../../hooks/claude-settings.mjs", import.meta.url));
    symlinkSync(join(helper, ".."), join(dir, "current"));
    const viaLink = join(dir, "current", "claude-settings.mjs");
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ model: "opus" }), { mode: 0o644 });
    chmodSync(settings, 0o644);
    execFileSync(process.execPath, [viaLink, "add", settings, "/x/node /x/claude-hook.mjs"]);
    assert.equal(statSync(settings).mode & 0o777, 0o644, "the file keeps its mode");
    const written = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(written.model, "opus");
    assert.equal(Object.keys(written.hooks).length, 7);
    assert.deepEqual(JSON.parse(readFileSync(`${settings}.before-cobra`, "utf8")), { model: "opus" });
    execFileSync(process.execPath, [viaLink, "remove", settings]);
    assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { model: "opus" });
    // Not JSON: refused, untouched.
    writeFileSync(settings, "{ broken");
    assert.throws(() => execFileSync(process.execPath, [viaLink, "add", settings, "/x/claude-hook.mjs"], { stdio: "ignore" }));
    assert.equal(readFileSync(settings, "utf8"), "{ broken");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex's notify says finished until the screen moves on, and each agent reads its own records", () => {
  const codex = [record("Stop", { agent: "codex", session: "th-1", at: NOW - 60_000 })];
  // The screen last changed when the turn ended: finished, from the hook.
  assert.equal(hookStateFor(codex, "/home/me/web-app", NOW, { agent: "codex", screenChangedAt: NOW - 61_000 })?.activity, "agent-idle");
  // The screen changed well after it: a new turn, and the screen decides.
  assert.equal(hookStateFor(codex, "/home/me/web-app", NOW, { agent: "codex", screenChangedAt: NOW - 1_000 }), null);
  // A Claude pane does not read a Codex record, nor the other way round.
  assert.equal(hookStateFor(codex, "/home/me/web-app", NOW, { agent: "claude" }), null);
  assert.equal(hookStateFor([record("Notification", { message: "needs your permission" })], "/home/me/web-app", NOW, { agent: "codex" }), null);
});

const ASKED = {
  questions: [
    {
      question: "What shape should the launchpad take?",
      header: "Shape",
      multiSelect: false,
      options: [
        { label: "Doors with status", description: "One door per page", preview: "┌──────┐\n│ WTCH │\n└──────┘" },
        { label: "Ticker pad", preview: "NVDA 1.2% ↑" },
      ],
    },
  ],
};

test("the hook records the tmux pane and the transcript the session will write", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-hooks-"));
  try {
    const event = { session_id: "s1", cwd: "/home/me/web-app", hook_event_name: "SessionStart", transcript_path: "/home/me/.claude/projects/-home-me-web-app/s1.jsonl" };
    const env = { ...process.env, COBRA_AGENT_STATE_DIR: dir, TMUX_PANE: "%7", TMUX: "/tmp/tmux-1000/cobra,4242,0" };
    execFileSync(process.execPath, [HOOK], { input: JSON.stringify(event), env });
    const [record] = readHookRecords(join(dir, "hooks"));
    assert.equal(record?.transcript, event.transcript_path);
    assert.equal(record?.pane, "%7");
    assert.equal(record?.socket, "/tmp/tmux-1000/cobra");
    assert.equal(record?.server, "4242");

    // Outside tmux: no pane, and nothing made up.
    const { TMUX_PANE: _pane, TMUX: _tmux, ...rest } = process.env;
    const outside = { ...rest, COBRA_AGENT_STATE_DIR: dir };
    execFileSync(process.execPath, [HOOK], { input: JSON.stringify({ ...event, hook_event_name: "Stop" }), env: outside });
    const [after] = readHookRecords(join(dir, "hooks"));
    assert.equal(after?.pane, undefined);
    assert.equal(after?.socket, undefined);
    assert.equal(after?.server, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the hook copies a question when it is asked, leaves the state alone, and drops the copy once answered", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-hooks-"));
  try {
    fire(dir, { session_id: "s1", cwd: "/home/me/web-app", hook_event_name: "UserPromptSubmit" });
    fire(dir, { session_id: "s1", cwd: "/home/me/web-app", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: ASKED });
    // Another tool's PreToolUse writes nothing (the matcher keeps them away, and so does the hook).
    fire(dir, { session_id: "s1", cwd: "/home/me/web-app", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });

    const asked = readAsked(join(dir, "hooks", "questions"));
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.questions[0]?.options[0]?.preview, "┌──────┐\n│ WTCH │\n└──────┘");
    assert.equal(asked[0]?.questions[0]?.options[0]?.description, "One door per page");
    // The session's state is still the prompt it was given, and the copy is not read as a state.
    const records = readHookRecords(join(dir, "hooks"));
    assert.deepEqual(records.map((r) => r.event), ["UserPromptSubmit"]);

    fire(dir, { session_id: "s1", cwd: "/home/me/web-app", hook_event_name: "PostToolUse", tool_name: "AskUserQuestion" });
    assert.deepEqual(readAsked(join(dir, "hooks", "questions")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a copied question is served only while the screen shows it", () => {
  const records = [{ agent: "claude" as const, session: "s1", cwd: "/home/me/web-app", at: NOW, questions: ASKED.questions }];
  assert.equal(askedFor(records, "/home/me/web-app", "What shape should the launchpad take?")?.[0]?.options.length, 2);
  // Wrapped on a narrow pane: still the same question.
  assert.ok(askedFor(records, "/home/me/web-app", "What shape   should the launchpad take?"));
  // A stale copy (Claude was interrupted, so no PostToolUse) under a new question: nothing.
  assert.equal(askedFor(records, "/home/me/web-app", "Which extras?"), null);
  // Another project, or no question on screen: nothing.
  assert.equal(askedFor(records, "/home/me/api", "What shape should the launchpad take?"), null);
  assert.equal(askedFor(records, "/home/me/web-app", null), null);
});

test("exact: the Lead's folder holds every project, and their sessions do not speak for it", () => {
  const record = (cwd: string, event: HookRecord["event"], at: number): HookRecord => ({ agent: "claude", session: `s${at}`, cwd, event, at });
  // Newest first, as readHookRecords returns them.
  const records = [record("/home/me/Projects/web-app", "UserPromptSubmit", NOW - 1000), record("/home/me/Projects", "Stop", NOW - 5000)];
  assert.equal(hookStateFor(records, "/home/me/Projects", NOW)?.activity, "agent-working", "inside: the project's session wins");
  assert.equal(hookStateFor(records, "/home/me/Projects", NOW, { exact: true })?.activity, "agent-idle");
  assert.equal(hookStateFor(records, "/home/me/Projects/web-app", NOW, { exact: true })?.activity, "agent-working");
});
