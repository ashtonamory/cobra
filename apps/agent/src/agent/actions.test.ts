import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActionDeps } from "./actions.ts";
import type { StoredApproval } from "./approvals.ts";

const ROOT = mkdtempSync(join(tmpdir(), "cobra-actions-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { actionFingerprint, actionNews, actionText, MAX_ATTACHMENT_BYTES, MAX_BODY, NO_MAILBOX, parseAction, resolveAttachment, runAction } = await import("./actions.ts");
const { makeApproval } = await import("./approvals.ts");

const NOW = Date.parse("2026-10-22T12:00:00Z");
const random = (size: number) => new Uint8Array(size).fill(1);

/** A repository with a pay stub, a credential file, a big file, and a symlink out of it. */
function repo(): string {
  const dir = mkdtempSync(join(ROOT, "payroll-"));
  mkdirSync(join(dir, "out"), { recursive: true });
  writeFileSync(join(dir, "out", "stub-ana.pdf"), "pdf bytes");
  writeFileSync(join(dir, "out", "stub-ben.pdf"), "more pdf bytes");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  writeFileSync(join(dir, "out", "bank-credentials.csv"), "x");
  mkdirSync(join(ROOT, "elsewhere"), { recursive: true });
  writeFileSync(join(ROOT, "elsewhere", "secret.txt"), "outside");
  symlinkSync(join(ROOT, "elsewhere", "secret.txt"), join(dir, "out", "link.txt"));
  return dir;
}

const project = (path: string) => ({ id: "payroll", name: "Payroll", path });
/** The local folders the person set up in files.json. */
const EXPORTS = { stubs: { label: "Pay stubs", path: "/home/me/Stubs" }, books: { label: "Bookkeeper", path: "/home/me/Drive/Books" } };
/** The mailbox a Space's email is frozen with (orch.ts does this at propose). */
const BOX = { box: "box_1", address: "owner@example.com", mailbox: "Zoho Mail" };

test("parseAction: an email with the recipients, subject, text and repository attachments, as the approval keeps it", () => {
  const path = repo();
  const action = parseAction(
    { channel: "email", summary: "  2 pay stubs for Oct 16 to 31 ", to: ["ana@example.com", "Ana@Example.com", "ben@example.com"], cc: [], subject: "Your pay stub", text: "Hi,\r\n\r\nAttached.\n", attachments: ["out/stub-ana.pdf", "./out/stub-ben.pdf", "out/stub-ana.pdf"] },
    project(path),
  );
  assert.equal(action.channel, "email");
  assert.equal(action.project, "payroll");
  assert.equal(action.projectName, "Payroll");
  assert.equal(action.summary, "2 pay stubs for Oct 16 to 31");
  // Addresses are kept once each, as given; cc is left out when empty; text keeps its lines.
  assert.deepEqual(action.email?.to, ["ana@example.com", "ben@example.com"]);
  assert.equal("cc" in (action.email ?? {}), false);
  assert.equal(action.email?.text, "Hi,\n\nAttached.");
  assert.deepEqual(action.email?.attachments, [
    { path: "out/stub-ana.pdf", name: "stub-ana.pdf", bytes: 9, sha256: "d1cb546b102fab8362de413fdacc187b05be10df72b72db3b3e50b4953f6a555" },
    { path: "out/stub-ben.pdf", name: "stub-ben.pdf", bytes: 14, sha256: "a7ad9fec7d863e5aefd4929a9115dd874b5c857cbc27b8f4b055a5c16f29a36c" },
  ]);
  assert.equal("note" in action, false);
});

test("parseAction: a note is the summary and its text, and nothing to send", () => {
  const action = parseAction({ channel: "note", summary: "Payroll is ready", text: "6 people, 212 hours, $14,280. Nothing waits on anyone else." }, project("/nowhere"));
  assert.deepEqual(action, { channel: "note", project: "payroll", projectName: "Payroll", summary: "Payroll is ready", note: { text: "6 people, 212 hours, $14,280. Nothing waits on anyone else." } });
});

test("parseAction refuses what the card could not show honestly, and says what is wrong", () => {
  const path = repo();
  const base = { channel: "email", summary: "stubs", to: ["ana@example.com"], subject: "s", text: "t" };
  const refused = (body: Record<string, unknown>, why: RegExp) => assert.throws(() => parseAction(body, project(path)), (error: unknown) => error instanceof Error && why.test(error.message) && (error as { status?: number }).status === 400, String(why));
  refused({ ...base, channel: "sms" }, /channel is one of email, note, file/);
  refused({ ...base, summary: "ok" }, /summary needs at least 3/);
  refused({ ...base, summary: "x".repeat(121) }, /summary is at most 120/);
  refused({ ...base, to: [] }, /to needs at least 1 address/);
  refused({ ...base, to: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`) }, /to is at most 20/);
  refused({ ...base, to: ["Ana <ana@example.com>"] }, /not an email address/);
  refused({ ...base, to: ["ana@example.com"], cc: ["not-an-address"] }, /cc: "not-an-address" is not an email address/);
  refused({ ...base, subject: "" }, /subject needs at least 1/);
  refused({ ...base, text: "   " }, /text is empty/);
  refused({ ...base, text: "x".repeat(4001) }, /text is at most 4000/);
  // The card holds the whole message: one that would not fit is refused, never cut.
  const wide = Array.from({ length: 20 }, (_, i) => `p${i}@${["a", "b", "c"].map((c) => c.repeat(60)).join(".")}.example.com`);
  refused({ ...base, to: wide, cc: wide.map((a) => `c${a}`), text: "x".repeat(4000) }, /the card shows at most 8000 characters and this needs \d+: shorten the message/);
  // A note sends nothing, so one that carries addresses is an email mislabelled.
  refused({ channel: "note", summary: "note", text: "x", to: ["ana@example.com"] }, /a note has no to/);
  // A note may carry files: the card names them, nothing is sent, and the attachment is hashed like an email's.
  const preview = parseAction({ channel: "note", summary: "First pay stub to look over", text: "Open it before it goes to anyone.", attachments: ["out/stub-ana.pdf"] }, project(path));
  assert.equal(preview.note?.attachments?.[0]?.name, "stub-ana.pdf");
  assert.match(actionText(preview).body, /Attachments: stub-ana\.pdf \(9 B\)$/);
  refused({ ...base, attachments: ["../outside.txt"] }, /not an absolute one or one with \.\./);
  refused({ ...base, attachments: [join(ROOT, "elsewhere", "secret.txt")] }, /not an absolute one/);
  refused({ ...base, attachments: ["out/link.txt"] }, /outside the repository/);
  refused({ ...base, attachments: ["out/missing.pdf"] }, /is not in the repository/);
  refused({ ...base, attachments: ["out"] }, /is not a file/);
  refused({ ...base, attachments: [".env"] }, /looks like a credential file/);
  refused({ ...base, attachments: ["out/bank-credentials.csv"] }, /looks like a credential file/);
  refused({ ...base, attachments: Array.from({ length: 11 }, () => "out/stub-ana.pdf") }, /at most 10 attachments/);
  assert.throws(() => parseAction({ channel: "note", summary: "note", text: "x".repeat(4001) }, project(path)), /text is at most 4000/);
});

test("parseAction: a file action names a local folder, and its card shows the label and the path", () => {
  const path = repo();
  const action = parseAction({ channel: "file", summary: "2 pay stubs to the folder", folder: " stubs ", attachments: ["out/stub-ana.pdf", "out/stub-ben.pdf", "out/stub-ana.pdf"], text: "October's stubs, as approved." }, project(path), EXPORTS);
  assert.equal(action.channel, "file");
  assert.deepEqual([action.files?.to, action.files?.label, action.files?.path], ["stubs", "Pay stubs", "/home/me/Stubs"]);
  assert.deepEqual(action.files?.items.map((file) => [file.path, file.bytes]), [["out/stub-ana.pdf", 9], ["out/stub-ben.pdf", 14]]);
  assert.equal(action.files?.items[0]?.sha256, "d1cb546b102fab8362de413fdacc187b05be10df72b72db3b3e50b4953f6a555");
  assert.equal("email" in action, false);
  const { title, body } = actionText(action);
  assert.equal(title, "Copy: 2 pay stubs to the folder");
  assert.equal(body, "To: Pay stubs (/home/me/Stubs)\n\nFiles: stub-ana.pdf (9 B), stub-ben.pdf (14 B)\n\nOctober's stubs, as approved.");
  // The note is optional; without it the card ends with the files.
  const bare = parseAction({ channel: "file", summary: "2 pay stubs to the folder", folder: "stubs", attachments: ["out/stub-ana.pdf"] }, project(path), EXPORTS);
  assert.equal("text" in (bare.files ?? {}), false);
  assert.equal(actionText(bare).body, "To: Pay stubs (/home/me/Stubs)\n\nFiles: stub-ana.pdf (9 B)");
  // A different folder or a different file is a different card.
  assert.notEqual(actionFingerprint(bare), actionFingerprint(action));
  assert.equal(actionFingerprint(bare), actionFingerprint(parseAction({ channel: "file", summary: "2 pay stubs to the folder", folder: "stubs", attachments: ["./out/stub-ana.pdf"] }, project(path), EXPORTS)));
});

test("parseAction: each local folder from files.json is named by its key", () => {
  const path = repo();
  const action = parseAction({ channel: "file", summary: "a stub to the books", folder: "books", attachments: ["out/stub-ana.pdf"] }, project(path), EXPORTS);
  assert.deepEqual([action.files?.to, action.files?.label, action.files?.path], ["books", "Bookkeeper", "/home/me/Drive/Books"]);
  assert.equal(actionText(action).body, "To: Bookkeeper (/home/me/Drive/Books)\n\nFiles: stub-ana.pdf (9 B)");
});

test("parseAction refuses a file action that names no known folder, carries addresses, or copies nothing", () => {
  const path = repo();
  const base: Record<string, unknown> = { channel: "file", summary: "stubs", attachments: ["out/stub-ana.pdf"] };
  const refused = (body: Record<string, unknown>, exports: Record<string, { label: string; path: string }>, why: RegExp) =>
    assert.throws(() => parseAction(body, project(path), exports), (error: unknown) => error instanceof Error && why.test(error.message) && (error as { status?: number }).status === 400, String(why));
  // The Foreman only knows what the person told it, so the refusal lists the folders there are.
  refused({ ...base, folder: "dropbox" }, EXPORTS, /no folder "dropbox": the folders there are stubs \(Pay stubs\), books \(Bookkeeper\); give the key/);
  refused({ ...base, folder: 3 }, EXPORTS, /folder is the key of a folder: one of stubs \(Pay stubs\), books \(Bookkeeper\)/);
  // No folder named: there is no Google Drive to fall back to, so the folders are listed.
  refused(base, EXPORTS, /folder is the key of a folder: one of stubs \(Pay stubs\), books \(Bookkeeper\)/);
  // No files.json folders at all: nowhere to copy to, said with the step.
  refused({ ...base, folder: "books" }, {}, /no folder on this computer is set up to copy files into yet/);
  refused(base, {}, /no folder on this computer is set up to copy files into yet/);
  // A copy reaches nobody: addresses mean the Foreman meant an email.
  refused({ ...base, folder: "books", to: ["ana@example.com"] }, EXPORTS, /a file action has no to: it copies files into a folder on this computer and sends them to nobody. To send them, use channel email/);
  refused({ ...base, folder: "books", cc: ["ana@example.com"] }, EXPORTS, /a file action has no cc/);
  refused({ ...base, folder: "books", subject: "Stubs" }, EXPORTS, /a file action has no subject/);
  refused({ ...base, folder: "books", attachments: undefined }, EXPORTS, /attachments names the files to copy: 1 to 10 paths/);
  refused({ ...base, folder: "books", attachments: [] }, EXPORTS, /attachments names the files to copy/);
  refused({ ...base, folder: "books", attachments: [".env"] }, EXPORTS, /looks like a credential file/);
  refused({ ...base, folder: "books", attachments: ["out/link.txt"] }, EXPORTS, /outside the repository/);
  refused({ ...base, folder: "books", text: "x".repeat(4001) }, EXPORTS, /text is at most 4000/);
  refused({ channel: "note", summary: "note", text: "x", folder: "books" }, EXPORTS, /a note has no folder/);
  assert.equal(parseAction({ channel: "email", summary: "stubs", to: ["ana@example.com"], subject: "s", text: "t" }, project(path)).channel, "email");
});

test("attachments together are capped", () => {
  const path = repo();
  writeFileSync(join(path, "out", "big.bin"), Buffer.alloc(MAX_ATTACHMENT_BYTES - 4));
  assert.throws(() => parseAction({ channel: "email", summary: "big files", to: ["a@b.co"], subject: "s", text: "t", attachments: ["out/big.bin", "out/stub-ana.pdf"] }, project(path)), /at most 20 MB together/);
  assert.equal(resolveAttachment(path, "out/big.bin").bytes, MAX_ATTACHMENT_BYTES - 4);
});

test("actionText: the card shows every address, the subject, the whole text and each attachment by name and size", () => {
  const email = actionText({
    channel: "email",
    project: "payroll",
    projectName: "Payroll",
    summary: "2 pay stubs",
    email: { to: ["ana@example.com"], cc: ["books@example.com"], subject: "Your pay stub", text: "Hi Ana,\nAttached.", attachments: [{ path: "out/stub-ana.pdf", name: "stub-ana.pdf", bytes: 2048, sha256: "ab".repeat(32) }] },
  });
  assert.equal(email.title, "Send: 2 pay stubs");
  assert.equal(email.body, "To: ana@example.com\nCc: books@example.com\nSubject: Your pay stub\n\nHi Ana,\nAttached.\n\nAttachments: stub-ana.pdf (2 KB)");
  const note = actionText({ channel: "note", project: "p", projectName: "P", summary: "Ready", note: { text: "All set." } });
  assert.deepEqual(note, { title: "Note: Ready", body: "All set." });
  // Never cut: what the person allows is what goes.
  const long = actionText({ channel: "note", project: "p", projectName: "P", summary: "Long", note: { text: "x".repeat(3000) } });
  assert.equal(long.body, "x".repeat(3000));
});

test("the approval's body is the whole email, so a 3500-character message is shown as it will be sent", () => {
  const path = repo();
  const text = Array.from({ length: 75 }, (_, i) => `line ${i} ${"word ".repeat(8)}`).join("\n");
  assert.ok(text.length > 3500 && text.length < 4000);
  const approval = approvalFor(path, { channel: "email", summary: "the October letter", to: ["ana@example.com"], subject: "October", text, attachments: ["out/stub-ana.pdf"] });
  assert.equal(approval.body, actionText(approval.action!).body);
  assert.equal(approval.body, `From: owner@example.com (Zoho Mail)\nTo: ana@example.com\nSubject: October\n\n${text.trim()}\n\nAttachments: stub-ana.pdf (9 B)`);
  assert.ok(approval.body.length <= MAX_BODY);
  assert.equal(approval.action?.email?.attachments?.[0]?.sha256?.length, 64);
  // Two cards with one summary to different people are two questions; the same card is one.
  const again = parseAction({ channel: "email", summary: "the October letter", to: ["ben@example.com"], subject: "October", text }, project(path));
  assert.notEqual(actionFingerprint(again), actionFingerprint(approval.action!));
  assert.equal(actionFingerprint(approvalFor(path, { channel: "email", summary: "the October letter", to: ["ana@example.com"], subject: "October", text, attachments: ["out/stub-ana.pdf"] }).action!), actionFingerprint(approval.action!));
});

type Fake = ActionDeps & {
  sent: Array<{ to: string[]; subject: string; attachments: number; types: string[] }>;
  /** The export folder's contents, name to bytes, as the fake disk holds them. */
  folder: Map<string, string>;
  made: string[];
};

function deps(overrides: Partial<ActionDeps> = {}, inFolder: Record<string, string> = {}): Fake {
  const sent: Fake["sent"] = [];
  const folder = new Map(Object.entries(inFolder));
  const made: string[] = [];
  return {
    sent,
    folder,
    made,
    sendBox: async (_box, address, message) => {
      sent.push({ to: message.to, subject: message.subject, attachments: message.attachments?.length ?? 0, types: (message.attachments ?? []).map((file) => file.type ?? "") });
      return { id: "abc@example.com", from: address };
    },
    organizeMail: async (batch) => ({ changed: batch.ids.length, failed: 0 }),
    readFile: (path) => readFile(path),
    projectPath: async () => null,
    readFilesConfig: async () => ({ hub: "", inbox: "inbox", maxBytes: 1, retainDays: 1, devices: {}, exports: EXPORTS }),
    mkdir: async (path) => {
      made.push(path);
    },
    listDir: async () => [...folder.keys()],
    copyFile: async (from, to) => {
      // As COPYFILE_EXCL does on disk: a name that appeared since listDir is not written over.
      const name = to.slice(to.lastIndexOf("/") + 1);
      if (folder.has(name)) throw new Error(`EEXIST: file already exists, copyfile '${from}' -> '${to}'`);
      folder.set(name, readFileSync(from, "utf8"));
    },
    ...overrides,
  };
}

function approvalFor(path: string, body: Record<string, unknown>): StoredApproval {
  const parsed = parseAction(body, project(path), EXPORTS);
  // An email is frozen with its Space's mailbox when it is proposed (orch.ts).
  const action = parsed.email ? { ...parsed, email: { ...parsed.email, from: BOX } } : parsed;
  return makeApproval({ kind: "action", ...actionText(action), requestedBy: "foreman_payroll", action }, NOW, "laptop", random);
}

test("an action approval waits a day, and Allow sends exactly what it holds, attachments read now", async () => {
  const path = repo();
  const approval = approvalFor(path, { channel: "email", summary: "2 pay stubs", to: ["ana@example.com"], cc: ["books@example.com"], subject: "Your pay stub", text: "Attached.", attachments: ["out/stub-ana.pdf"] });
  assert.equal(approval.expiresAt, "2026-10-23T12:00:00.000Z");
  assert.equal(approval.action?.email?.to[0], "ana@example.com");
  const d = deps({ projectPath: async (id) => (id === "payroll" ? path : null) });
  const done = await runAction(d, { ...approval, state: "allowed" });
  assert.equal(done.state, "done");
  assert.deepEqual(done.results, [{ ok: true, message: "sent to 2 addresses from owner@example.com (Zoho Mail message abc@example.com)" }]);
  assert.deepEqual(d.sent, [{ to: ["ana@example.com"], subject: "Your pay stub", attachments: 1, types: ["application/pdf"] }]);
  assert.match(actionNews(done), /^The person allowed "Send: 2 pay stubs": sent to 2 addresses from owner@example\.com \(Zoho Mail message abc@example\.com\)\. approval_status ap_/);
});

test("an email shows From on the card and goes from that box; with the box gone or none named, nothing is sent", async () => {
  const path = repo();
  const approval = approvalFor(path, { channel: "email", summary: "demo", to: ["ana@example.com"], subject: "Hello", text: "Hi Ana." });
  assert.match(approval.body, /^From: owner@example\.com \(Zoho Mail\)\nTo: ana@example\.com\n/);
  const boxSends: Array<{ box: string; address: string; to: string[] }> = [];
  const d = deps({
    projectPath: async () => path,
    sendBox: async (box, address, message) => {
      boxSends.push({ box, address, to: message.to });
      return { id: "abc@example.com", from: address };
    },
  });
  const done = await runAction(d, { ...approval, state: "allowed" });
  assert.equal(done.state, "done");
  assert.deepEqual(done.results, [{ ok: true, message: "sent to 1 address from owner@example.com (Zoho Mail message abc@example.com)" }]);
  assert.deepEqual(boxSends, [{ box: "box_1", address: "owner@example.com", to: ["ana@example.com"] }]);

  // The box is gone since the card: it fails, and nothing goes another way.
  const gone = await runAction(
    deps({
      projectPath: async () => path,
      sendBox: async () => {
        throw new Error("the mailbox owner@example.com is no longer on this computer (Settings → Mailboxes); propose the email again");
      },
    }),
    { ...approval, state: "allowed" },
  );
  assert.equal(gone.state, "failed");
  assert.match(gone.results?.[0]?.message ?? "", /^not sent: the mailbox owner@example\.com is no longer on this computer/);

  // A card that names no mailbox (one made before Cobra's own Google connection went) is never sent: there is nothing to send it from.
  const parsed = parseAction({ channel: "email", summary: "demo", to: ["ana@example.com"], subject: "Hello", text: "Hi Ana." }, project(path), EXPORTS);
  const bare = makeApproval({ kind: "action", ...actionText(parsed), requestedBy: "foreman_payroll", action: parsed }, NOW, "laptop", random);
  const none = deps({ projectPath: async () => path });
  const unsent = await runAction(none, { ...bare, state: "allowed" });
  assert.equal(unsent.state, "failed");
  assert.deepEqual(unsent.results, [{ ok: false, message: `not sent: ${NO_MAILBOX}` }]);
  assert.deepEqual(none.sent, []);
});

test("a note is done on Allow and sends nothing", async () => {
  const approval = approvalFor("/nowhere", { channel: "note", summary: "Payroll is ready", text: "All set." });
  const d = deps();
  const done = await runAction(d, { ...approval, state: "allowed" });
  assert.equal(done.state, "done");
  assert.deepEqual(d.sent, []);
  assert.match(actionNews(done), /^The person read "Note: Payroll is ready"\. approval_status/);
});

test("Allow fails, and says why, when the project left, the attachment changed, or the mailbox refused", async () => {
  const path = repo();
  const email = approvalFor(path, { channel: "email", summary: "stubs", to: ["ana@example.com"], subject: "s", text: "t", attachments: ["out/stub-ana.pdf"] });

  const gone = await runAction(deps({ projectPath: async () => null }), { ...email, state: "allowed" });
  assert.match(gone.results?.[0]?.message ?? "", /no longer on this computer/);

  // The file was rewritten since the card, to the same size: it is not the file the person saw.
  writeFileSync(join(path, "out", "stub-ana.pdf"), "pdf bytez");
  const changedDeps = deps({ projectPath: async () => path });
  const changed = await runAction(changedDeps, { ...email, state: "allowed" });
  assert.equal(changed.state, "failed");
  assert.deepEqual(changed.results, [{ ok: false, message: "attachment stub-ana.pdf changed since you were shown it; propose it again with the file as it is now" }]);
  assert.deepEqual(changedDeps.sent, [], "nothing went");
  writeFileSync(join(path, "out", "stub-ana.pdf"), "pdf bytes");

  const refused = await runAction(
    deps({
      projectPath: async () => path,
      sendBox: async () => {
        throw new Error("the mail server refused the recipient (550 no such user)");
      },
    }),
    { ...email, state: "allowed" },
  );
  assert.equal(refused.state, "failed");
  assert.deepEqual(refused.results, [{ ok: false, message: "not sent: the mail server refused the recipient (550 no such user)" }]);
  assert.match(actionNews(refused), /was not carried out: not sent: the mail server refused the recipient .*\. Propose it again/);
});

test("Allow copies the files into a local folder, under free names, and says how many landed", async () => {
  const path = repo();
  const approval = approvalFor(path, { channel: "file", summary: "2 pay stubs to the books", folder: "books", attachments: ["out/stub-ana.pdf", "out/stub-ben.pdf"] });
  assert.equal(approval.title, "Copy: 2 pay stubs to the books");
  assert.equal(approval.expiresAt, "2026-10-23T12:00:00.000Z");
  const d = deps({ projectPath: async (id) => (id === "payroll" ? path : null) });
  const done = await runAction(d, { ...approval, state: "allowed" });
  assert.equal(done.state, "done");
  assert.deepEqual(done.results, [{ ok: true, message: "copied 2 files to Bookkeeper" }]);
  assert.deepEqual(d.made, ["/home/me/Drive/Books"]);
  assert.deepEqual([...d.folder.entries()], [["stub-ana.pdf", "pdf bytes"], ["stub-ben.pdf", "more pdf bytes"]]);
  assert.deepEqual(d.sent, []);
  assert.match(actionNews(done), /^The person allowed "Copy: 2 pay stubs to the books": copied 2 files to Bookkeeper\. approval_status ap_/);
  assert.match(actionNews({ ...approval, state: "denied" }), /^The person denied "Copy: 2 pay stubs to the books"\. Do not copy it again as it was/);

  // Last month's stub is already in the folder: the new one lands beside it, never over it.
  const again = deps({ projectPath: async () => path }, { "stub-ana.pdf": "september" });
  const beside = await runAction(again, { ...approval, state: "allowed" });
  assert.equal(beside.state, "done");
  assert.deepEqual(beside.results, [{ ok: true, message: "copied 2 files to Bookkeeper (stub-ana.pdf landed as stub-ana (2).pdf)" }]);
  assert.equal(again.folder.get("stub-ana.pdf"), "september");
  assert.equal(again.folder.get("stub-ana (2).pdf"), "pdf bytes");
  assert.equal(again.folder.get("stub-ben.pdf"), "more pdf bytes");
});

test("Allow refuses a copy when a file changed, the folder moved or is gone, or the project left", async () => {
  const path = repo();
  const approval = approvalFor(path, { channel: "file", summary: "a pay stub to the books", folder: "books", attachments: ["out/stub-ana.pdf"] });
  const here = { projectPath: async () => path };

  // Rewritten since the card, to the same size: not the file the person saw, and nothing lands.
  writeFileSync(join(path, "out", "stub-ana.pdf"), "pdf bytez");
  const changed = deps(here);
  const refused = await runAction(changed, { ...approval, state: "allowed" });
  assert.equal(refused.state, "failed");
  assert.deepEqual(refused.results, [{ ok: false, message: "stub-ana.pdf changed since you were shown it; propose it again with the file as it is now" }]);
  assert.equal(changed.folder.size, 0);
  writeFileSync(join(path, "out", "stub-ana.pdf"), "pdf bytes");

  // files.json changed since the card: the person allowed a copy to one path, not another.
  const moved = await runAction(deps({ ...here, readFilesConfig: async () => ({ hub: "", inbox: "inbox", maxBytes: 1, retainDays: 1, devices: {}, exports: { books: { label: "Bookkeeper", path: "/mnt/usb" } } }) }), { ...approval, state: "allowed" });
  assert.equal(moved.state, "failed");
  assert.deepEqual(moved.results, [{ ok: false, message: "export folder Bookkeeper now points at /mnt/usb, not /home/me/Drive/Books as you were shown; propose it again" }]);
  const gone = await runAction(deps({ ...here, readFilesConfig: async () => ({ hub: "", inbox: "inbox", maxBytes: 1, retainDays: 1, devices: {}, exports: {} }) }), { ...approval, state: "allowed" });
  assert.match(gone.results?.[0]?.message ?? "", /^export folder Bookkeeper \(books\) is no longer in files.json/);
  assert.match(actionNews(gone), /was not carried out: export folder Bookkeeper \(books\) is no longer in files.json/);

  const left = await runAction(deps(), { ...approval, state: "allowed" });
  assert.match(left.results?.[0]?.message ?? "", /project payroll is no longer on this computer/);

  // The folder cannot be made (a read-only disk): said as such, with the path.
  const unwritable = await runAction(
    deps({
      ...here,
      mkdir: async () => {
        throw new Error("EROFS: read-only file system");
      },
    }),
    { ...approval, state: "allowed" },
  );
  assert.deepEqual(unwritable.results, [{ ok: false, message: "Bookkeeper (/home/me/Drive/Books) could not be opened: EROFS: read-only file system" }]);

  // A name that appeared between listDir and the copy is not written over; the result says how far it got.
  const raced = deps(here);
  raced.listDir = async () => [];
  raced.folder.set("stub-ana.pdf", "someone else's");
  const partial = await runAction(raced, { ...approval, state: "allowed" });
  assert.equal(partial.state, "failed");
  assert.match(partial.results?.[0]?.message ?? "", /^copied 0 of 1 file to Bookkeeper; stub-ana.pdf failed: EEXIST/);
  assert.equal(raced.folder.get("stub-ana.pdf"), "someone else's");
});

test("actionNews at rest: denied, pending", () => {
  const approval = approvalFor("/nowhere", { channel: "note", summary: "Ready", text: "x" });
  assert.match(actionNews({ ...approval, state: "denied" }), /^The person denied "Note: Ready"\. Do not send it again as it was/);
  assert.match(actionNews(approval), /waits for the person/);
});
