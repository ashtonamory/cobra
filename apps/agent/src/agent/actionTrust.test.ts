import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-action-trust-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const t = await import("./actionTrust.ts");
const { recordRenders, loadRenders, renderOf, RENDERS_KEPT } = await import("./renders.ts");
const { makeApproval } = await import("./approvals.ts");

type ApprovalAction = import("@cobra/contracts").ApprovalAction;
type StoredApproval = import("./approvals.ts").StoredApproval;
type RenderEntry = import("./renders.ts").RenderEntry;

const STUB_A = "a".repeat(64);
const STUB_B = "b".repeat(64);
const PAY_STUB = "1".repeat(64);
const NOW = Date.parse("2026-10-30T09:05:00Z");

const renders: Record<string, RenderEntry> = {
  [STUB_A]: { project: "payroll", template: "pay-stub", templateSha: PAY_STUB, at: "2026-10-30T09:01:00Z" },
  [STUB_B]: { project: "payroll", template: "pay-stub", templateSha: PAY_STUB, at: "2026-10-30T09:01:00Z" },
};

function email(over: Partial<NonNullable<ApprovalAction["email"]>> = {}, files = [STUB_A, STUB_B]): ApprovalAction {
  return {
    channel: "email",
    project: "payroll",
    projectName: "Pete's Payroll",
    summary: "2 pay stubs for Oct 16 to 31",
    email: {
      to: ["ana@example.com", "Ben@Example.com"],
      subject: "Your pay stub",
      text: "Attached is your pay stub.",
      attachments: files.map((sha, i) => ({ path: `out/pay-stub-${i}.pdf`, name: `pay-stub-${i}.pdf`, bytes: 1000, sha256: sha })),
      ...over,
    },
  };
}

function trustable(keyed: ReturnType<typeof t.actionKey>) {
  assert.equal(keyed.trustable, true, keyed.trustable ? "" : keyed.why);
  return (keyed as Extract<typeof keyed, { trustable: true }>).subject;
}

// --- the key ------------------------------------------------------------------

test("the key: the same people in any order or case, and other text, is the same key", () => {
  const one = trustable(t.actionKey(email(), renders));
  const two = trustable(t.actionKey(email({ to: ["ben@example.com", "ANA@example.com"], subject: "Pay stub, Nov 1 to 15", text: "Here it is." }), renders));
  assert.equal(one.key, two.key);
  assert.equal(one.what, "pay-stub");
  assert.deepEqual(one.templates, ["pay-stub"]);
  assert.deepEqual(one.to, ["ana@example.com", "Ben@Example.com"]);
});

test("the key: a new recipient, a cc or a changed template is another key", () => {
  const base = trustable(t.actionKey(email(), renders)).key;
  assert.notEqual(trustable(t.actionKey(email({ to: ["ana@example.com", "ben@example.com", "cara@example.com"] }), renders)).key, base);
  const cc = trustable(t.actionKey(email({ cc: ["boss@example.com"] }), renders));
  assert.notEqual(cc.key, base);
  assert.deepEqual(cc.to, ["ana@example.com", "Ben@Example.com", "cc boss@example.com"]);
  const changed = { ...renders, [STUB_A]: { ...renders[STUB_A]!, templateSha: "2".repeat(64) } };
  assert.notEqual(trustable(t.actionKey(email(), changed)).key, base);
});

test("the key: a file the agent did not render, or rendered for another project, is never trusted", () => {
  const keyed = t.actionKey(email({}, [STUB_A, "f".repeat(64)]), renders);
  assert.equal(keyed.trustable, false);
  assert.match((keyed as { why: string }).why, /pay-stub-1\.pdf is not a document the agent rendered from a template/);
  const elsewhere = { [STUB_A]: { ...renders[STUB_A]!, project: "billing" } };
  assert.equal(t.actionKey(email({}, [STUB_A]), elsewhere).trustable, false);
});

test("the key: a message with no attachment, a file action by its folder, a note by its project", () => {
  const plain = trustable(t.actionKey(email({ attachments: undefined }), renders));
  assert.equal(plain.what, "a message");
  const files: ApprovalAction = {
    channel: "file",
    project: "payroll",
    projectName: "Pete's Payroll",
    summary: "Pay stubs to Drive",
    files: { to: "drive", label: "your Google Drive", path: "Cobra/Pete's Payroll", items: [{ path: "out/a.pdf", name: "a.pdf", bytes: 1, sha256: STUB_A }] },
  };
  const saved = trustable(t.actionKey(files, renders));
  assert.deepEqual(saved.to, ["your Google Drive (Cobra/Pete's Payroll)"]);
  assert.notEqual(saved.key, trustable(t.actionKey({ ...files, files: { ...files.files!, to: "accountant", path: "/srv/acct" } }, renders)).key);
  const note = trustable(t.actionKey({ channel: "note", project: "payroll", projectName: "Pete's Payroll", summary: "Week ahead", note: { text: "Two shifts open." } }, renders));
  assert.deepEqual(note.to, []);
  assert.equal(note.what, "notes");
  assert.equal(t.actionKey({ channel: "fax", project: "payroll", projectName: "P", summary: "x" }, renders).trustable, false);
});

// --- earning it -------------------------------------------------------------------

const keyed = () => t.actionKey(email(), renders);
const done = (title = "Send: 2 pay stubs") => ({ state: "done", title });

test("three clean Allows in a row propose trust, at the third and only then", () => {
  let state = t.EMPTY_TRUST;
  const one = t.noteOutcome(state, keyed(), done("Send: run 1"), [], NOW);
  assert.equal(one.propose, null);
  state = one.state;
  const two = t.noteOutcome(state, keyed(), done("Send: run 2"), [], NOW);
  assert.equal(two.propose, null);
  const three = t.noteOutcome(two.state, keyed(), done("Send: run 3"), [], NOW);
  assert.equal(three.propose?.clean, 3);
  assert.deepEqual(three.propose?.examples, ["Send: run 1", "Send: run 2", "Send: run 3"]);
});

test("a Deny between starts the count again; a failure or a lapse changes nothing", () => {
  let state = t.noteOutcome(t.EMPTY_TRUST, keyed(), done(), [], NOW).state;
  state = t.noteOutcome(state, keyed(), done(), [], NOW).state;
  state = t.noteOutcome(state, keyed(), { state: "failed", title: "x" }, [], NOW).state;
  state = t.noteOutcome(state, keyed(), { state: "expired", title: "x" }, [], NOW).state;
  assert.equal(state.counts[0]!.clean, 2);
  state = t.noteOutcome(state, keyed(), { state: "denied", title: "x" }, [], NOW).state;
  assert.deepEqual(state.counts, []);
  state = t.noteOutcome(state, keyed(), done(), [], NOW).state;
  state = t.noteOutcome(state, keyed(), done(), [], NOW).state;
  assert.equal(t.noteOutcome(state, keyed(), done(), [], NOW).propose?.clean, 3);
});

test("no trust card while one waits, while trusted, or once the person said keep asking", () => {
  let state = t.EMPTY_TRUST;
  for (let i = 0; i < 2; i++) state = t.noteOutcome(state, keyed(), done(), [], NOW).state;
  const subject = trustable(keyed());
  const card = makeApproval(t.trustApproval(subject, { key: subject.key, clean: 3, examples: [], last: "" }), NOW);
  assert.equal(t.noteOutcome(state, keyed(), done(), [card], NOW).propose, null, "one waits");
  const always = { ...state, always: [{ ...subject, at: "2026-10-30T09:00:00Z" }] };
  assert.equal(t.noteOutcome(always, keyed(), done(), [], NOW).propose, null, "keep asking");
  const granted = { ...state, grants: [{ ...subject, grantedAt: "2026-10-30T09:00:00Z", runsSince: 0 }] };
  assert.equal(t.noteOutcome(granted, keyed(), done(), [], NOW).propose, null, "already trusted");
});

test("the trust card: says who, what, how often, and that anything else still asks", () => {
  const subject = trustable(keyed());
  const card = makeApproval(t.trustApproval(subject, { key: subject.key, clean: 3, examples: ["Send: run 1", "Send: run 2", "Send: run 3"], last: "" }), NOW);
  assert.equal(card.kind, "trust");
  assert.equal(card.title, "Let Pete's Payroll send pay-stub to these 2 addresses without asking?");
  assert.match(card.body, /You allowed this 3 times in a row with nothing changed:\n- Send: run 1\n- Send: run 2\n- Send: run 3/);
  assert.match(card.body, /To: ana@example\.com, Ben@Example\.com/);
  assert.match(card.body, /Templates: pay-stub/);
  assert.match(card.body, /A new recipient, a changed template or anything else still asks\. Revoke it any time on the project page\./);
  assert.equal(card.trust?.key, subject.key);
  assert.equal(card.trust?.runs, 3);
  assert.equal(card.state, "pending");
  assert.equal(Date.parse(card.expiresAt) - NOW, 3 * 24 * 60 * 60_000);
});

// --- answering it, using it, taking it back ------------------------------------------

function card(): StoredApproval {
  const subject = trustable(keyed());
  return makeApproval(t.trustApproval(subject, { key: subject.key, clean: 3, examples: ["Send: run 3"], last: "" }), NOW);
}

test("Allow on the trust card writes the grant; the card reads done and the Foreman is told", () => {
  const counted = t.noteOutcome(t.EMPTY_TRUST, keyed(), done(), [], NOW).state;
  const settled = t.settleTrust(counted, { ...card(), state: "allowed" }, NOW);
  assert.equal(settled.approval.state, "done");
  assert.equal(settled.state.grants.length, 1);
  assert.equal(settled.state.grants[0]!.runsSince, 0);
  assert.equal(settled.state.grants[0]!.grantedAt, new Date(NOW).toISOString());
  assert.equal("runs" in settled.state.grants[0]!, false);
  assert.deepEqual(settled.state.counts, []);
  assert.match(settled.news ?? "", /now trusts you to send pay-stub to these 2 addresses.*carried out at once with no card/);
});

test("Deny on the trust card keeps it asking until the person clears it", () => {
  const settled = t.settleTrust(t.EMPTY_TRUST, { ...card(), state: "denied" }, NOW);
  assert.equal(settled.approval.state, "denied");
  assert.equal(settled.state.always.length, 1);
  assert.equal(settled.state.grants.length, 0);
  assert.match(settled.news ?? "", /keep allowing each time/);
  assert.equal(t.mayRunTrusted(settled.state, keyed(), [], NOW), null);
  const cleared = t.clearAsk(settled.state, settled.state.always[0]!.key);
  assert.equal(cleared.removed?.key, trustable(keyed()).key);
  assert.deepEqual(cleared.state.always, []);
});

test("a trusted key runs, counts its runs, and asks again past ten in a day", () => {
  const granted = t.settleTrust(t.EMPTY_TRUST, { ...card(), state: "allowed" }, NOW).state;
  const grant = t.mayRunTrusted(granted, keyed(), [], NOW);
  assert.equal(grant?.key, trustable(keyed()).key);
  const used = t.useGrant(granted, grant!.key, NOW + 1000);
  assert.equal(used.grants[0]!.runsSince, 1);
  assert.equal(used.grants[0]!.lastUsed, new Date(NOW + 1000).toISOString());
  const runs = Array.from({ length: t.TRUSTED_PER_DAY }, (_, i) => ({ ...card(), id: `ap_${i}`, kind: "action", trusted: { key: grant!.key, grantedAt: grant!.grantedAt }, createdAt: new Date(NOW - i * 60_000).toISOString() }));
  assert.equal(t.mayRunTrusted(granted, keyed(), runs, NOW), null);
  assert.ok(t.mayRunTrusted(granted, keyed(), runs, NOW + 25 * 60 * 60_000));
  assert.equal(t.mayRunTrusted(granted, t.actionKey(email({ to: ["ana@example.com"] }), renders), [], NOW), null, "another key asks");
});

test("Revoke takes the grant back and the count starts again", () => {
  const granted = t.settleTrust(t.EMPTY_TRUST, { ...card(), state: "allowed" }, NOW).state;
  const key = granted.grants[0]!.key;
  const revoked = t.revokeTrust({ ...granted, counts: [{ key, clean: 2, examples: [], last: "" }] }, key);
  assert.equal(revoked.removed?.key, key);
  assert.deepEqual(revoked.state.grants, []);
  assert.deepEqual(revoked.state.counts, []);
  assert.match(t.revokeNews(revoked.removed!), /stopped trusting you to send pay-stub to these 2 addresses: those are cards to allow again/);
  assert.equal(t.revokeTrust(revoked.state, key).removed, null);
});

// --- receipts and the file ----------------------------------------------------------

test("receipts: trusted runs only, a week back, newest first, by project, without who asked", () => {
  const run = (id: string, minutesAgo: number, project = "payroll"): StoredApproval => ({
    ...makeApproval({ kind: "action", title: `Send: ${id}`, body: "", requestedBy: "fm_payroll", action: { ...email(), project }, trusted: { key: "k", grantedAt: "2026-10-29T09:00:00Z" } }, NOW - minutesAgo * 60_000),
    id,
  });
  const asked = { ...makeApproval({ kind: "action", title: "Send: asked", body: "", requestedBy: "fm_payroll", action: email() }, NOW), id: "asked" };
  const list = [run("old", 8 * 24 * 60), run("two", 10), asked, run("one", 30), run("other", 5, "billing")];
  const all = t.receipts(list, NOW);
  assert.deepEqual(all.map((a) => a.id), ["other", "two", "one"]);
  assert.equal("requestedBy" in all[0]!, false);
  assert.equal(all[0]!.state, "allowed");
  assert.deepEqual(t.receipts(list, NOW, "payroll").map((a) => a.id), ["two", "one"]);
});

test("receipt notice: what landed, or that it failed", () => {
  assert.deepEqual(t.receiptNotice({ state: "done", title: "Send: 2 pay stubs", results: [{ ok: true, message: "sent to 2 addresses from pete@example.com" }], action: email() }), {
    title: "Pete's Payroll: Send: 2 pay stubs",
    body: "Done on trust: sent to 2 addresses from pete@example.com.",
  });
  assert.equal(t.receiptNotice({ state: "failed", title: "Send: 2 pay stubs", results: [{ ok: false, message: "Google is not connected" }], action: email() }).title, "Pete's Payroll: not done");
});

test("trust.json is private and reads back as written", () => {
  const path = join(ROOT, "state", "trust-test.json");
  const store = t.trustFileStore(path);
  assert.deepEqual(store.load(), t.EMPTY_TRUST);
  const granted = t.settleTrust(t.EMPTY_TRUST, { ...card(), state: "allowed" }, NOW).state;
  store.save(granted);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(store.load(), granted);
});

test("the render ledger: each file by its hash, for its project only, the newest kept", () => {
  const path = join(ROOT, "state", "renders-test.json");
  recordRenders("payroll", { files: [{ path: "out/a.pdf", name: "a.pdf", bytes: 1, sha256: STUB_A, rows: 1 }], template: { name: "pay-stub", source: "shipped", sha256: PAY_STUB } }, NOW, path);
  const files = loadRenders(path);
  assert.deepEqual(renderOf(files, "payroll", STUB_A), { project: "payroll", template: "pay-stub", templateSha: PAY_STUB, at: new Date(NOW).toISOString() });
  assert.equal(renderOf(files, "billing", STUB_A), undefined);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const many = Array.from({ length: RENDERS_KEPT + 5 }, (_, i) => ({ path: `out/${i}.pdf`, name: `${i}.pdf`, bytes: 1, sha256: i.toString(16).padStart(64, "0"), rows: 1 }));
  recordRenders("payroll", { files: many, template: { name: "pay-stub", source: "shipped", sha256: PAY_STUB } }, NOW, path);
  const kept = loadRenders(path);
  assert.equal(Object.keys(kept).length, RENDERS_KEPT);
  assert.equal(renderOf(kept, "payroll", STUB_A), undefined, "the oldest went first");
});
