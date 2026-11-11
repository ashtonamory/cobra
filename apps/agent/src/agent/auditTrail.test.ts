import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApprovalAction } from "@cobra/contracts";

// Before the agent's modules load: paths.ts reads these once, so the log is this file's own.
const STATE = mkdtempSync(join(tmpdir(), "cobra-audit-state-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const { AUDIT_LOG, audit, auditRecord, onAuditFailure, readAudit, recipients, resetAuditFailure } = await import("./auditTrail.ts");
const { lineHash, verifyChain } = await import("./auditLog.ts");
const { auditApprovals, makeApproval, saveApprovals, loadApprovals, writeLapsed } = await import("./approvals.ts");
const { auditAction, runAction } = await import("./actions.ts");
const { auditCommand } = await import("./auditCli.ts");
const { auditRoute } = await import("./auditRoutes.ts");
const { createKeyStore, hashKey, mintDesk } = await import("./keys.ts");
const { Vault } = await import("./vault.ts");
const { openProjectDb } = await import("./db.ts");
const { deploy } = await import("./siteDeploy.ts");
const { logDecision, POLICY_LOG, readPolicyLog } = await import("./policy.ts");
const { KnownSecrets, useKnownSecrets } = await import("./secretValues.ts");
type StoredApproval = import("./approvals.ts").StoredApproval;
type TradeSchema = import("./dbTypes.ts").TradeSchema;

const NOW = Date.parse("2026-11-08T12:00:00Z");

function lines(path = AUDIT_LOG): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** The records a step appended to the shared log, parsed, and the raw lines to search for words that must not be there. */
function appended<T>(step: () => T): { result: T; records: Array<Record<string, any>>; raw: string } {
  const before = lines().length;
  const result = step();
  const added = lines().slice(before);
  return { result, records: added.map((line) => JSON.parse(line)), raw: added.join("\n") };
}
async function appendedAsync<T>(step: () => Promise<T>): Promise<{ result: T; records: Array<Record<string, any>>; raw: string }> {
  const before = lines().length;
  const result = await step();
  const added = lines().slice(before);
  return { result, records: added.map((line) => JSON.parse(line)), raw: added.join("\n") };
}

const fresh = () => join(mkdtempSync(join(tmpdir(), "cobra-audit-")), "policy.jsonl");

// --- the record ---------------------------------------------------------------------

test("a record has time, kind, actor, subject and outcome; content fields are dropped and long strings cut", () => {
  const record = auditRecord("email.sent", {
    actor: "agent",
    subject: { project: "paws", card: "ap_1", target: "" },
    detail: { recipients: 2, body: "Dear Ana, the whole letter", text: "words", password: "hunter22", title: "x".repeat(400), skipped: undefined },
  }, NOW);
  assert.deepEqual(Object.keys(record), ["at", "kind", "actor", "subject", "outcome", "detail"]);
  assert.deepEqual(record.subject, { project: "paws", card: "ap_1" });
  assert.equal(record.outcome, "ok");
  assert.deepEqual(Object.keys(record.detail!), ["recipients", "title"]);
  assert.ok((record.detail!.title as string).length <= 160);
  assert.deepEqual(recipients(["Ana <ana@Example.com>", "bo@example.com", "c@other.org"]), { recipients: 3, domains: ["example.com", "other.org"] });
});

test("a record is chained, verifies, and a secret in it stays redacted on disk", () => {
  const path = fresh();
  const planted = "zq7-planted-value-9f2c1e8a77";
  useKnownSecrets(new KnownSecrets(() => [], () => ({ text: null, refused: null })));
  try {
    // A token by its shape, and a value the agent holds.
    const held = new KnownSecrets(() => [join(STATE, "config", "anthropic-api-key")], () => ({ text: planted, refused: null }));
    mkdirSync(join(STATE, "config"), { recursive: true });
    writeFileSync(join(STATE, "config", "anthropic-api-key"), planted);
    useKnownSecrets(held);
    audit("merge", { actor: "agent", subject: { target: "me/r#7" }, detail: { head: "a".repeat(40), why: `token ghp_${"A1b2".repeat(9)} and ${planted}` } }, { path, now: 1 });
    audit("land", { actor: "agent", subject: { project: "p" } }, { path, now: 2 });
  } finally {
    useKnownSecrets(null);
  }
  const text = readFileSync(path, "utf8");
  assert.doesNotMatch(text, /ghp_A1b2/);
  assert.doesNotMatch(text, new RegExp(planted));
  assert.match(text, /\[redacted\]/);
  assert.match(text, /"head":"a{40}"/, "a commit hash is kept: it is not a secret");
  const report = verifyChain(path);
  assert.equal(report.ok, true);
  assert.equal(report.chained, 2);
  const [first, second] = lines(path);
  assert.equal(JSON.parse(second!).prev, lineHash(first!), "the hash covers the line as kept, redacted");
});

test("a changed line is found and named; rotation keeps the chain running across files", () => {
  const path = fresh();
  for (let at = 1; at <= 30; at += 1) audit("approval.proposed", { actor: "lead_x", subject: { card: `ap_${at}` }, detail: { title: "Send the invoice" } }, { path, now: at, maxBytes: 600 });
  const files = verifyChain(path).files;
  assert.ok(files.length > 2, "it rotated");
  assert.equal(verifyChain(path).ok, true);
  assert.equal(verifyChain(path).chained, lines(files[0]!).length + files.slice(1).reduce((sum, file) => sum + lines(file).length, 0));
  // Someone edits one line in the newest file: the next line no longer follows it.
  const text = readFileSync(path, "utf8").split("\n");
  text[0] = text[0]!.replace("Send the invoice", "Nothing happened");
  writeFileSync(path, text.join("\n"));
  const broken = verifyChain(path);
  assert.equal(broken.ok, false);
  assert.equal(broken.broken?.file, path);
  assert.equal(broken.broken?.line, 2);
});

test("a write that fails never throws: it is told once on the console and as a notice, and the action goes on", () => {
  const blocker = join(mkdtempSync(join(tmpdir(), "cobra-audit-")), "a-file");
  writeFileSync(blocker, "");
  const told: string[] = [];
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  onAuditFailure((problem) => told.push(problem));
  resetAuditFailure();
  try {
    // The log's folder is a file: every write fails.
    for (let i = 0; i < 3; i += 1) assert.doesNotThrow(() => audit("email.sent", { actor: "agent" }, { path: join(blocker, "policy.jsonl") }));
    assert.equal(told.length, 1);
    assert.equal(errors.length, 1);
    assert.match(told[0]!, /audit log could not be written/);
    // A write that works ends it; the next failure is told again.
    audit("email.sent", { actor: "agent" }, { path: fresh() });
    audit("email.sent", { actor: "agent" }, { path: join(blocker, "policy.jsonl") });
    assert.equal(told.length, 2);
  } finally {
    console.error = error;
    onAuditFailure(null);
    resetAuditFailure();
  }
});

// --- approvals --------------------------------------------------------------------------

function action(): ApprovalAction {
  return {
    channel: "email",
    project: "paws",
    projectName: "Paws",
    summary: "Invoice for Ana",
    email: { to: ["ana@example.com"], cc: ["bo@acme.org"], subject: "Your invoice INV-12", text: "Dear Ana, here is the secret body", attachments: [{ path: "inv.pdf", name: "inv.pdf", bytes: 3, sha256: "b".repeat(64) }] },
  };
}

const card = (over: Partial<StoredApproval> = {}): StoredApproval => ({ ...makeApproval({ kind: "action", title: "Send the invoice to Ana?", body: "Dear Ana, here is the secret body", requestedBy: "foreman_paws", action: action() }, NOW), ...over });

test("each change of a card appends exactly one record, saying who decided it, never the body", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cobra-approvals-")), "approvals.json");
  const asked = card();
  const proposed = appended(() => saveApprovals([asked], path));
  assert.equal(proposed.records.length, 1);
  assert.equal(proposed.records[0]!.kind, "approval.proposed");
  assert.equal(proposed.records[0]!.actor, "foreman_paws");
  assert.deepEqual(proposed.records[0]!.subject, { card: asked.id, project: "paws" });
  assert.equal(proposed.records[0]!.detail.recipients, 2);
  assert.deepEqual(proposed.records[0]!.detail.domains, ["acme.org", "example.com"]);
  assert.doesNotMatch(proposed.raw, /secret body|Your invoice INV-12|ana@example\.com/);

  const allowed = appended(() => saveApprovals([{ ...asked, state: "allowed", answeredBy: "desk_abc" }], path));
  assert.deepEqual(allowed.records.map((r) => [r.kind, r.actor]), [["approval.allowed", "person:desk_abc"]]);
  const done = appended(() => saveApprovals([{ ...asked, state: "done", answeredBy: "desk_abc", results: [{ ok: true, message: "sent" }] }], path));
  assert.deepEqual(done.records.map((r) => [r.kind, r.actor, r.outcome]), [["approval.done", "agent", "ok"]]);
  // Saved again unchanged: nothing.
  assert.equal(appended(() => saveApprovals(loadApprovals(path), path)).records.length, 0);
});

test("refused, lapsed, judged, Instinct, trust and a merge on green each name their decider", () => {
  const record = (before: StoredApproval[], after: StoredApproval[]) => {
    const out: Array<[string, string, string]> = [];
    auditApprovals(before, after, (kind, fields) => void out.push([kind, fields.actor, fields.outcome ?? "ok"]));
    return out;
  };
  const asked = card();
  assert.deepEqual(record([asked], [{ ...asked, state: "denied" }]), [["approval.refused", "person", "refused"]]);
  assert.deepEqual(record([asked], [{ ...asked, state: "allowed", allowedBy: "cobra" }]), [["approval.allowed", "instinct", "ok"]]);
  const judged = { ...asked, judged: { at: "", verdict: "allow" as const, reason: "safe" } };
  assert.deepEqual(record([asked], [judged]), [["approval.judged", "judge", "ok"]]);
  assert.deepEqual(record([judged], [{ ...judged, state: "allowed", allowedBy: "cobra" }]), [["approval.allowed", "judge", "ok"]]);
  const refusedByJudge = { ...asked, judged: { at: "", verdict: "refuse" as const, reason: "no" } };
  assert.deepEqual(record([refusedByJudge], [{ ...refusedByJudge, state: "denied" }]), [["approval.refused", "judge", "refused"]]);
  const trusted = makeApproval({ kind: "action", title: "t", body: "b", requestedBy: "foreman_paws", action: action(), trusted: { key: "email:x", grantedAt: "" } as never }, NOW);
  assert.deepEqual(record([], [trusted]), [["approval.allowed", "trust", "ok"]]);
  const merged = { ...makeApproval({ kind: "merge", title: "Publish?", body: "", requestedBy: "foreman_paws", prs: [{ repo: "me/r", number: 7, title: "x", head: "a".repeat(40), url: "" }] }, NOW), state: "done" as const };
  assert.deepEqual(record([], [merged]), [["approval.allowed", "merge-on-green", "ok"], ["approval.done", "agent", "ok"]]);
  const old = card({ expiresAt: "2026-01-02T00:00:00Z" });
  assert.deepEqual(record([old], [{ ...old, state: "expired" }]), [["approval.expired", "time", "expired"]]);
  // Before its time: a newer card replaced it.
  const replaced = card({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.deepEqual(record([replaced], [{ ...replaced, state: "expired" }]), [["approval.expired", "agent", "expired"]]);
});

test("a card that lapsed is written down, and logged once", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cobra-approvals-")), "approvals.json");
  const old = card({ createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-02T00:00:00Z" });
  saveApprovals([old], path);
  const lapsed = appended(() => writeLapsed(Date.now(), path));
  assert.equal(lapsed.result, 1);
  assert.deepEqual(lapsed.records.map((r) => r.kind), ["approval.expired"]);
  assert.equal(appended(() => writeLapsed(Date.now(), path)).records.length, 0);
});

// --- actions carried out ------------------------------------------------------------------

test("each action carried out appends exactly one record of its kind, with counts and hashes and no content", () => {
  const cases: Array<[ApprovalAction, string]> = [
    [action(), "email.sent"],
    [{ channel: "file", project: "paws", projectName: "Paws", summary: "s", files: { to: "drive", label: "your Google Drive", path: "Cobra/Paws", items: [{ path: "a.pdf", name: "a.pdf", bytes: 1, sha256: "c".repeat(64) }] } }, "drive.saved"],
    [{ channel: "file", project: "paws", projectName: "Paws", summary: "s", files: { to: "payroll", label: "Payroll", path: "/home/x/Payroll", items: [{ path: "a.pdf", name: "a.pdf", bytes: 1, sha256: "c".repeat(64) }] } }, "file.saved"],
    [{ channel: "mailbox", project: "paws", projectName: "Paws", summary: "s", mailbox: { op: "archive", ids: ["1", "2"], matched: 2, skipped: { alreadyDone: 0, starred: 0, missing: 0 }, more: false, senders: [{ from: "x@y.z", count: 2 }], samples: [{ from: "x@y.z", subject: "Secret subject line" }] } }, "mailbox.changed"],
    [{ channel: "note", project: "paws", projectName: "Paws", summary: "s", note: { text: "the note's own words" } }, "note.read"],
    [{ channel: "campaign", project: "paws", projectName: "Paws", summary: "s" }, "email.queued"],
  ];
  for (const [act, kind] of cases) {
    const done = { ...card({ action: act }), state: "done" as const };
    const { records, raw } = appended(() => auditAction(done));
    assert.equal(records.length, 1, kind);
    assert.equal(records[0]!.kind, kind);
    assert.equal(records[0]!.subject.card, done.id);
    assert.equal(records[0]!.subject.project, "paws");
    assert.doesNotMatch(raw, /secret body|Your invoice|Secret subject|note's own words|ana@example\.com/);
  }
  const email = appended(() => auditAction({ ...card(), state: "done" })).records[0]!;
  assert.deepEqual([email.detail.recipients, email.detail.domains, email.detail.attachments, email.detail.hashes], [2, ["acme.org", "example.com"], 1, [`inv.pdf:${"b".repeat(16)}`]]);
  assert.equal(appended(() => auditAction({ ...card(), state: "failed" })).records[0]!.outcome, "failed");
});

test("runAction logs the email it sent once", async () => {
  const root = mkdtempSync(join(tmpdir(), "cobra-act-"));
  writeFileSync(join(root, "inv.pdf"), "pdf");
  const { createHash } = await import("node:crypto");
  const act = action();
  act.email!.attachments = [{ path: "inv.pdf", name: "inv.pdf", bytes: 3, sha256: createHash("sha256").update("pdf").digest("hex") }];
  const { result, records } = await appendedAsync(() =>
    runAction(
      {
        sendGmail: async () => ({ id: "m1", from: "me@gmail.com" }),
        sendBox: async () => ({ id: "m1", from: "me@box.com" }),
        organizeMail: async () => ({ changed: 0, failed: 0 }),
        uploadToDrive: async () => [],
        readFile: async (path: string) => readFileSync(path),
        projectPath: async () => root,
        readFilesConfig: async () => ({ exports: {} }),
        mkdir: async () => undefined,
        listDir: async () => [],
        copyFile: async () => undefined,
      } as never,
      { ...card({ action: act }), state: "allowed" },
    ),
  );
  assert.equal(result.state, "done");
  assert.deepEqual(records.map((r) => [r.kind, r.outcome]), [["email.sent", "ok"]]);
});

test("a site put live is logged once with its version", async () => {
  const { records } = await appendedAsync(() =>
    deploy((async () => new Response(JSON.stringify({ success: true, result: { id: "dep_1" } }), { status: 200, headers: { "content-type": "application/json" } })) as never, { token: "cf-token-not-logged-123456", accountId: "acc" } as never, "paws-site", "ver_123456789", "Book now"),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0]!.kind, "site.published");
  assert.equal(records[0]!.subject.target, "paws-site");
  assert.equal(records[0]!.detail.version, "ver_123456789");
  assert.doesNotMatch(JSON.stringify(records), /cf-token/);
});

test("money recorded in a Space's store is logged once with who, the mutation and the amounts", () => {
  const schema: TradeSchema = {
    trade: "test",
    version: 1,
    migrations: ["CREATE TABLE payments (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, memo TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"],
    tables: { payments: { describe: "paid", columns: { amount: { kind: "money", required: true }, memo: { kind: "text" } } } },
    mutations: {
      payment_add: {
        describe: "a payment",
        args: { amount: { kind: "money", required: true, describe: "cents" }, memo: { kind: "text", describe: "memo" } },
        run: (ctx, args) => {
          ctx.insert("payments", { amount: args.amount as number, memo: (args.memo as string | undefined) ?? null });
          return "paid";
        },
      },
      note_add: { describe: "no money", args: { memo: { kind: "text", describe: "memo" } }, run: () => "noted" },
    },
  } as TradeSchema;
  const db = openProjectDb("paws-money", schema, mkdtempSync(join(tmpdir(), "cobra-db-")));
  try {
    const paid = appended(() => db.write("payment_add", { amount: 12_345, memo: "private memo words" }, "foreman_paws"));
    assert.equal(paid.records.length, 1);
    assert.deepEqual([paid.records[0]!.kind, paid.records[0]!.actor, paid.records[0]!.subject.project, paid.records[0]!.detail.mutation, paid.records[0]!.detail.amounts], ["money.recorded", "foreman_paws", "paws-money", "payment_add", [12_345]]);
    assert.doesNotMatch(paid.raw, /private memo/);
    assert.equal(appended(() => db.write("note_add", { memo: "x" }, "foreman_paws")).records.length, 0, "a write with no money is not an action of this log");
  } finally {
    db.close();
  }
});

// --- keys and the vault ----------------------------------------------------------------------

test("a key made, rotated and removed is one record each, never the key or its hash", () => {
  const store = createKeyStore(join(mkdtempSync(join(tmpdir(), "cobra-keys-")), "keys.json"));
  const { caller, key } = mintDesk("The desk", NOW);
  const minted = appended(() => store.upsert(caller, "cli"));
  assert.deepEqual(minted.records.map((r) => [r.kind, r.actor, r.subject.target, r.detail.keyKind]), [["key.minted", "cli", caller.id, "desk"]]);
  const next = "a-new-key-for-the-desk-0123456789";
  const rotated = appended(() => store.rotate(caller.id, key, hashKey(next), NOW));
  assert.deepEqual(rotated.records.map((r) => [r.kind, r.actor]), [["key.rotated", caller.id]]);
  const removed = appended(() => store.remove(caller.id, "cli"));
  assert.deepEqual(removed.records.map((r) => [r.kind, r.actor]), [["key.revoked", "cli"]]);
  const all = minted.raw + rotated.raw + removed.raw;
  for (const secret of [key, next, caller.keyHash, hashKey(next)]) assert.ok(!all.includes(secret), "no key and no hash");
});

test("the vault made, unlocked (and refused), locked: one record each, never the passphrase or the key", () => {
  const root = mkdtempSync(join(tmpdir(), "cobra-vault-"));
  mkdirSync(join(root, "config"), { mode: 0o700 });
  const v = new Vault({ configDir: join(root, "config"), runtimeDir: join(root, "run"), keychain: null });
  const passphrase = "correct horse battery staple";
  const made = appended(() => v.init(passphrase));
  const locked = appended(() => v.lock());
  const wrong = appended(() => assert.throws(() => v.unlock("not the right passphrase")));
  const opened = appended(() => v.unlock(passphrase));
  assert.deepEqual(
    [...made.records, ...locked.records, ...wrong.records, ...opened.records].map((r) => [r.kind, r.outcome]),
    [["vault.init", "ok"], ["vault.lock", "ok"], ["vault.unlock", "refused"], ["vault.unlock", "ok"]],
  );
  const raw = made.raw + locked.raw + wrong.raw + opened.raw;
  assert.ok(!raw.includes(passphrase) && !raw.includes("not the right"));
  assert.ok(!raw.includes(v.key()!.toString("base64")));
});

// --- reading -------------------------------------------------------------------------------

test("the log reads newest first, a page at a time; policy decisions are in it, and the policy's own reader skips the actions", () => {
  const path = fresh();
  logDecision({ at: 1, worker: "paws_1", tool: "Edit", decision: "allow", rule: "edit-worktree", subject: "src/a.ts" }, path);
  for (let at = 2; at <= 6; at += 1) audit("approval.proposed", { actor: "lead_x", subject: { card: `ap_${at}` }, detail: { title: `Card ${at}` } }, { path, now: at });
  logDecision({ at: 7, worker: "paws_1", tool: "Bash", decision: "deny", rule: "never:rm", subject: "rm -rf /" }, path);
  const first = readAudit({ limit: 2, actions: true }, path);
  assert.deepEqual(first.entries.map((entry) => entry.subject?.card), ["ap_6", "ap_5"]);
  assert.equal(first.more, true);
  assert.equal(first.entries[0]!.text, 'The Lead asked you: "Card 6"');
  const second = readAudit({ limit: 10, actions: true, before: first.entries[1]!.id }, path);
  assert.deepEqual(second.entries.map((entry) => entry.subject?.card), ["ap_4", "ap_3", "ap_2"]);
  assert.equal(second.more, false);
  const all = readAudit({ limit: 50 }, path).entries;
  assert.equal(all.length, 7);
  assert.equal(all[0]!.kind, "policy");
  assert.equal(all[0]!.text, "Worker paws_1 was refused Bash (never:rm)");
  assert.deepEqual(readPolicyLog(10, path).map((entry) => entry.tool), ["Bash", "Edit"]);
  assert.equal(verifyChain(path).ok, true, "policy decisions and actions are one chain");
  assert.equal(POLICY_LOG, AUDIT_LOG, "one log");
});

test("cobra-agent audit verify and tail: ok, a broken line named with exit 1, and recent entries in plain words", () => {
  const path = fresh();
  audit("merge", { actor: "agent", subject: { target: "me/r#7" } }, { path, now: Date.parse("2026-11-08T10:00:00Z") });
  audit("vault.lock", { actor: "cli" }, { path, now: Date.parse("2026-11-08T11:00:00Z") });
  audit("email.sent", { actor: "agent", subject: { project: "paws", card: "ap_9" }, detail: { recipients: 1, domains: ["example.com"] } }, { path, now: Date.parse("2026-11-08T12:00:00Z") });
  let out = "";
  const deps = { path, anchors: () => [], write: (line: string) => void (out += line) };
  assert.equal(auditCommand(["verify"], deps), 0);
  assert.match(out, /^ok: 3 chained records/);
  out = "";
  assert.equal(auditCommand(["tail", "2"], deps), 0);
  assert.deepEqual(out.trim().split("\n"), [
    "2026-11-08 11:00:00  You, on the command line, locked the vault",
    "2026-11-08 12:00:00  Cobra sent an email to 1 address at example.com  [paws ap_9]",
  ]);
  const text = readFileSync(path, "utf8").split("\n");
  text[1] = text[1]!.replace("vault.lock", "vault.init");
  writeFileSync(path, text.join("\n"));
  out = "";
  assert.equal(auditCommand(["verify"], deps), 1);
  assert.match(out, new RegExp(`^broken: ${path} line 3 does not follow the line before it`));
  assert.equal(auditCommand(["nonsense"], deps), 1);
});

test("GET /audit/log answers this computer's desk only, read only", () => {
  const path = fresh();
  audit("merge", { actor: "agent", subject: { target: "me/r#7" } }, { path, now: 1 });
  const query = new URLSearchParams("limit=5");
  assert.equal(auditRoute({ kind: "lead" }, "GET", query, path).status, 403);
  assert.equal(auditRoute({ kind: "desk" }, "POST", query, path).status, 405);
  assert.equal(auditRoute({ kind: "desk" }, "GET", new URLSearchParams("before=../../etc"), path).status, 400);
  const reply = auditRoute({ kind: "desk" }, "GET", query, path);
  assert.equal(reply.status, 200);
  const body = reply.body as { entries: Array<{ kind: string; text: string }>; more: boolean };
  assert.deepEqual(body.entries.map((entry) => [entry.kind, entry.text]), [["merge", "Cobra merged me/r#7"]]);
  assert.equal(body.more, false);
});
