import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-taint-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");

const taint = await import("./taint.ts");
const { judgeSystem, JUDGE_SYSTEM_ESCALATE } = await import("./judge.ts");
const { readsWeb } = await import("./gate.ts");
const { receiptNotice, DRIVE_CONSENT } = await import("./actionTrust.ts");

const NOW = Date.parse("2026-10-29T15:00:00Z");

test("a session is tainted from its first read, keeps its hosts, and a fresh conversation ends it", () => {
  const path = join(STATE, "one.json");
  assert.equal(taint.isTainted("foreman:northwind", path), null);
  taint.noteRead("foreman:northwind", "WebFetch https://caymanyogaclub.com/", ["caymanyogaclub.com"], NOW, path);
  taint.noteRead("foreman:northwind", "WebSearch yoga", [], NOW + 1000, path);
  const kept = taint.isTainted("foreman:northwind", path);
  assert.equal(kept?.since, new Date(NOW).toISOString());
  assert.equal(kept?.reads, 2);
  assert.deepEqual(kept?.hosts, ["caymanyogaclub.com"]);
  assert.equal(taint.isTainted("lead", path), null, "one session's reads are its own");
  taint.clearTaint("foreman:northwind", NOW, path);
  assert.equal(taint.isTainted("foreman:northwind", path), null);
  assert.ok(taint.loadTaint(path).sessions["foreman:northwind"]?.ended, "kept for the record");
  // A taint in force is never dropped by age; an ended one goes after 14 days.
  taint.noteRead("lead", "x", [], NOW, path);
  taint.saveTaint(taint.loadTaint(path), NOW + 15 * 24 * 60 * 60_000, path);
  assert.ok(taint.isTainted("lead", path));
  assert.equal(taint.loadTaint(path).sessions["foreman:northwind"], undefined);
});

test("a Lead's or Foreman's taint lasts its conversation: no Stop ends it, a fresh conversation does", () => {
  const path = join(STATE, "conversation.json");
  const stopped: import("./taint.ts").TurnProbe = () => ({ stopAt: NOW + 60_000, turns: null });
  taint.noteRead("foreman:northwind", "mail_read", [], NOW, path, "email", stopped);
  // The email is still in front of the model after its turn, so the next turn asks too.
  assert.ok(taint.isTainted("foreman:northwind", path));
  assert.deepEqual(taint.endGone(() => true, NOW + 24 * 60 * 60_000, path), [], "the sweep never ends an orchestrator's");
  taint.noteRead("foreman:northwind", "calendar_read", [], NOW + 120_000, path, "calendar", stopped);
  const kept = taint.isTainted("foreman:northwind", path);
  assert.deepEqual(kept?.sources, ["email", "calendar"]);
  assert.equal(kept?.since, new Date(NOW).toISOString());
  taint.clearTaint("foreman:northwind", NOW + 180_000, path);
  assert.equal(taint.isTainted("foreman:northwind", path), null);
  // What the new conversation reads is a fresh taint, with only its own reads.
  taint.noteRead("foreman:northwind", "WebSearch yoga", [], NOW + 240_000, path, "web", stopped);
  assert.deepEqual(taint.isTainted("foreman:northwind", path)?.sources, ["web"]);
});

test("a Worker's taint lasts its run: its end ends it", () => {
  const path = join(STATE, "worker-run.json");
  taint.noteRead("worker:acme_2", "WebFetch x", ["x.example"], NOW, path);
  assert.ok(taint.isTainted("worker:acme_2", path));
  assert.deepEqual(taint.endGone(() => true, NOW + 61_000, path), []);
  assert.deepEqual(taint.endGone((id) => id !== "acme_2", NOW + 62_000, path), ["worker:acme_2"]);
  assert.equal(taint.isTainted("worker:acme_2", path), null);
});

test("the card's note says plainly what was read and why it asks", () => {
  assert.equal(taint.taintNote("foreman:acme", { sources: ["email"], hosts: [] }), "Cobra read an email from outside in this conversation, so it asks you before this goes out.");
  assert.equal(
    taint.taintNote("lead", { sources: ["web", "calendar"], hosts: ["a.example", "b.example", "c.example", "d.example"] }),
    "Cobra read web pages (a.example, b.example, c.example, and 1 more) and calendar events (invites carry other people's words) in this conversation, so it asks you before this goes out.",
  );
  assert.match(taint.taintNote("worker:acme_2", { sources: ["records"], hosts: [] }), /^This Worker read messages people sent in .* in its task/);
  // A file from before sources were kept read the web.
  assert.deepEqual(taint.taintRead({ hosts: [] }), ["web pages"]);
});

test("a Worker of a tainted orchestrator starts tainted with its hosts; one of a clean orchestrator does not", () => {
  const path = join(STATE, "two.json");
  taint.noteRead("foreman:northwind", "WebFetch x", ["caymanyogaclub.com"], NOW, path);
  assert.equal(taint.taintedOwner("northwind", path), "foreman:northwind");
  assert.equal(taint.taintedOwner("lead", path), undefined);
  taint.taintWorker("northwind_3", "foreman:northwind", NOW, path);
  const worker = taint.isTainted("worker:northwind_3", path);
  assert.match(worker?.why ?? "", /started by foreman:northwind/);
  assert.deepEqual(worker?.hosts, ["caymanyogaclub.com"]);
  assert.equal(worker?.reads, 0);
  // Its orchestrator's fresh start does not clean a Worker whose task it already wrote.
  taint.clearTaint("foreman:northwind", NOW, path);
  assert.ok(taint.isTainted("worker:northwind_3", path));
});

test("the judge of a tainted session is told so; an untainted one's prompt is unchanged", () => {
  assert.equal(judgeSystem({ escalate: true, rules: [] }), JUDGE_SYSTEM_ESCALATE);
  const tainted = judgeSystem({ escalate: true, rules: ["No spending."], tainted: true });
  assert.ok(tainted.startsWith(`${JUDGE_SYSTEM_ESCALATE} ${taint.TAINTED}`));
  assert.match(tainted, /- No spending\.$/);
});

test("what taints a Worker: a web read that may run, or an internet call the judge or a run allowed; not a listed host or a refusal", () => {
  const allow = (rule: string) => ({ decision: "allow" as const, rule, reason: "" });
  assert.equal(readsWeb("WebFetch", allow("judge:network")), true);
  assert.equal(readsWeb("WebSearch", { decision: "ask", rule: "judge:network", reason: "" }), true, "the person may allow it");
  assert.equal(readsWeb("WebFetch", { decision: "deny", rule: "web-run:wr_1", reason: "" }), false);
  assert.equal(readsWeb("Bash", allow("judge:network")), true);
  assert.equal(readsWeb("Bash", allow("web-run:wr_1")), true);
  assert.equal(readsWeb("Bash", allow("network-listed")), false);
  assert.equal(readsWeb("Bash", allow("loopback")), false);
  assert.equal(readsWeb("Bash", allow("judge:install")), false);
});

test("a Drive save the audit read first says so on its receipt", () => {
  const base = { state: "done" as const, title: "Save leads.csv", results: [{ ok: true, message: "saved" }], action: { projectName: "Northwind prospecting" } as never };
  assert.match(receiptNotice({ ...base, trusted: { key: DRIVE_CONSENT, grantedAt: "x" } }).body, /connected Google: saved/);
  assert.match(receiptNotice({ ...base, trusted: { key: DRIVE_CONSENT, grantedAt: "x", audited: "clean" } }).body, /connected Google, checked for planted content first: saved/);
});

test("a Foreman's last report carries its taint past a fresh conversation, until the new one ends a turn", () => {
  const path = join(STATE, "report.json");
  const who = "foreman:northwind";
  const none = () => ({ stopAt: null, turns: null });
  assert.equal(taint.reportTaint(who, path, none), null, "a clean Foreman's report is clean");
  taint.noteRead(who, "mail_read", [], NOW, path, "email", none);
  assert.deepEqual(taint.reportTaint(who, path, none)?.sources, ["email"], "while its conversation runs");

  // It slept and woke as a fresh conversation: clean for its own actions, but the report it left is not.
  taint.clearTaint(who, NOW + 6000, path);
  assert.equal(taint.isTainted(who, path), null);
  assert.deepEqual(taint.reportTaint(who, path, () => ({ stopAt: NOW + 5000, turns: null }))?.sources, ["email"]);
  assert.ok(taint.reportTaint(who, path, none), "mid-turn, the agent knows nothing newer: it holds");
  assert.equal(taint.reportTaint(who, path, () => ({ stopAt: NOW + 60_000, turns: null })), null, "the new conversation has reported");
});

test("a headless Foreman's last report carries the taint for the turn that read, and no further", () => {
  const path = join(STATE, "report-headless.json");
  const who = "foreman:northwind";
  taint.noteRead(who, "mail_read", [], NOW, path, "email", () => ({ stopAt: null, turns: 4 }));
  taint.clearTaint(who, NOW + 1000, path);
  assert.ok(taint.reportTaint(who, path, () => ({ stopAt: null, turns: 5 })));
  assert.equal(taint.reportTaint(who, path, () => ({ stopAt: null, turns: 6 })), null);
});

test("the card names a connected app's answer and a report in plain words", () => {
  assert.equal(taint.taintNote("lead", { sources: ["connector"], hosts: [] }), "Cobra read what a connected app sent back in this conversation, so it asks you before this goes out.");
  assert.equal(taint.taintNote("lead", { sources: ["report"], hosts: [] }), "Cobra read a report written after reading text from outside in this conversation, so it asks you before this goes out.");
});
