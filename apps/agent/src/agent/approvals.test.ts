import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  answer,
  loadApprovals,
  makeApproval,
  mergeCandidates,
  mergeText,
  plainWhat,
  publishedText,
  publicView,
  runMerge,
  saveApprovals,
  settle,
  type StoredApproval,
} from "./approvals.ts";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const random = (size: number) => new Uint8Array(size).fill(1);
const pr = { number: 24, title: "docs: tests", repo: "octocat/book-club", head: "abc123", url: "u", worker: "book-club_2" };

test("an approval is pending until answered once; a second answer is refused", () => {
  const made = makeApproval({ kind: "merge", title: "Merge PR #24?", body: "#24", requestedBy: "lead_legion", prs: [pr] }, NOW, "omarchy", random);
  assert.equal(made.state, "pending");
  assert.equal(made.expiresAt, "2026-10-09T18:00:00.000Z");
  const { list, approval } = answer([made], made.id, true, NOW + 1000);
  assert.equal(approval.state, "allowed");
  assert.throws(() => answer(list, made.id, false, NOW + 2000), /already allowed/);
  assert.throws(() => answer(list, "ap_nope", true, NOW), /no such approval/);
  // Who asked stays in the agent.
  assert.equal("requestedBy" in publicView(approval), false);
});

test("a question nobody answered lapses and cannot be allowed after", () => {
  const made = makeApproval({ kind: "mcp-verify", title: "t", body: "b", requestedBy: "lead_x" }, NOW, "mini", random);
  const later = NOW + 31 * 60_000;
  assert.equal(settle([made], later)[0]?.state, "expired");
  assert.throws(() => answer([made], made.id, true, later), /already expired/);
});

test("approvals are kept in a private file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "approvals-")), "approvals.json");
  const made = makeApproval({ kind: "merge", title: "t", body: "b", requestedBy: "l" }, NOW, "m", random);
  saveApprovals([made], path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(loadApprovals(path), [made]);
});

test("merge candidates must be open now; their head is the one you are shown", async () => {
  const heads: Record<number, { state: string; head: string }> = { 24: { state: "OPEN", head: "abc123" }, 25: { state: "MERGED", head: "def" } };
  const readPr = async (_repo: string, number: number) => ({ ...heads[number]!, title: `PR ${number}`, url: `u${number}` });
  const prs = await mergeCandidates({ readPr }, [{ repo: "o/r", number: 24, worker: "w" }]);
  assert.deepEqual(prs, [{ number: 24, title: "PR 24", repo: "o/r", head: "abc123", url: "u24", worker: "w" }]);
  await assert.rejects(mergeCandidates({ readPr }, [{ repo: "o/r", number: 25 }]), /merged, not open/);
  // The card is in the person's words (docs/voice.md): what goes live, never a PR number.
  assert.deepEqual(mergeText([pr, { ...pr, number: 25 }]).title, "Publish 2 updates?");
  assert.equal(mergeText([pr]).title, 'Publish "tests"?', "a PR title loses its conventional prefix");
  assert.equal(mergeText([pr], "the new booking page").title, "Publish the new booking page?");
  assert.equal(mergeText([pr]).body, "tests (book-club)");
  assert.equal(plainWhat("  the new booking page?  "), "the new booking page");
  assert.equal(plainWhat(""), undefined);
  assert.equal(publishedText([pr, { ...pr, number: 25 }], 1).title, "Published 1 of 2 updates");
  assert.equal(publishedText([pr], 1, "the booking page").title, "Published the booking page");
});

test("an allowed merge merges each PR at the head you saw; one failing does not stop the rest", async () => {
  const approval: StoredApproval = {
    ...makeApproval({ kind: "merge", title: "t", body: "b", requestedBy: "l", prs: [pr, { ...pr, number: 25, head: "moved" }] }, NOW, "m", random),
    state: "allowed",
  };
  const merged: string[] = [];
  const done = await runMerge(
    {
      merge: async (_repo, number, head) => {
        if (head === "moved") throw new Error(`#${number} has new commits since you allowed it; ask again`);
        merged.push(`${number}@${head}`);
      },
    },
    approval,
  );
  assert.deepEqual(merged, ["24@abc123"]);
  assert.equal(done.state, "failed");
  assert.deepEqual(done.results?.map((r) => r.ok), [true, false]);
  assert.match(done.results?.[1]?.message ?? "", /new commits/);
});

test("an action approval keeps the Foreman's exact content and waits a day", () => {
  const action = { channel: "email", project: "payroll", projectName: "Payroll", summary: "2 pay stubs", email: { to: ["ana@example.com"], subject: "Your pay stub", text: "Attached." } };
  const made = makeApproval({ kind: "action", title: "Send: 2 pay stubs", body: "To: ana@example.com", requestedBy: "foreman_payroll", action }, NOW, "legion", random);
  assert.equal(made.expiresAt, "2026-10-10T12:00:00.000Z");
  assert.deepEqual(made.action, action);
  assert.deepEqual(publicView(made).action, action);
  // An action's card holds its whole email (8000); every other kind keeps its 2000.
  assert.equal(makeApproval({ kind: "action", title: "t", body: "x".repeat(9000), requestedBy: "f", action }, NOW, "legion", random).body.length, 8000);
  assert.equal(makeApproval({ kind: "merge", title: "t", body: "x".repeat(9000), requestedBy: "f" }, NOW, "legion", random).body.length, 2000);
  const { approval } = answer([made], made.id, false, NOW + 1000);
  assert.equal(approval.state, "denied");
  // A file action keeps the folder it named, key, label and path, and each file's hash, for Allow to check against.
  const copy = {
    channel: "file",
    project: "payroll",
    projectName: "Payroll",
    summary: "2 pay stubs to Drive",
    files: { to: "drive", label: "Drive", path: "/home/me/Drive/Payroll", items: [{ path: "out/stub-ana.pdf", name: "stub-ana.pdf", bytes: 9, sha256: "ab".repeat(32) }], text: "October's stubs." },
  };
  const copied = makeApproval({ kind: "action", title: "Copy: 2 pay stubs to Drive", body: "To: Drive (/home/me/Drive/Payroll)", requestedBy: "foreman_payroll", action: copy }, NOW, "legion", random);
  assert.deepEqual(publicView(copied).action, copy);
  assert.equal(copied.expiresAt, "2026-10-10T12:00:00.000Z");
});
