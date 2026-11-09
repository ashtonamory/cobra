import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-trust-routes-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const tr = await import("./trustRoutes.ts");
const t = await import("./actionTrust.ts");
const r = await import("./routines.ts");
const { answer, makeApproval } = await import("./approvals.ts");
const { parseAction, runAction } = await import("./actions.ts");

type StoredApproval = import("./approvals.ts").StoredApproval;
type TrustState = import("./actionTrust.ts").TrustState;
type TrustDeps = import("./trustRoutes.ts").TrustDeps;
type RenderEntry = import("./renders.ts").RenderEntry;
type ActionDeps = import("./actions.ts").ActionDeps;
type StoredRoutine = import("./routines.ts").StoredRoutine;
type TickDeps = import("./routines.ts").TickDeps;

const LONDON = "Europe/London";
const PAY_STUB_TEMPLATE = "1".repeat(64);

/** Trust's world in memory: trust.json, the approvals file, the ledger, the clock, and what was pushed, told and logged. */
function world(start: number) {
  let state: TrustState = { grants: [], always: [], counts: [] };
  let approvals: StoredApproval[] = [];
  const ledger: Record<string, RenderEntry> = {};
  const pushed: StoredApproval[] = [];
  const told: Array<{ owner: string; text: string }> = [];
  const logged: string[] = [];
  const clock = { now: start };
  const deps: TrustDeps = {
    load: () => structuredClone(state),
    save: (next) => void (state = structuredClone(next)),
    approvals: { load: () => structuredClone(approvals), save: (list) => void (approvals = structuredClone(list)) },
    renders: () => ledger,
    notify: async (approval) => void pushed.push(approval),
    tell: (owner, text) => void told.push({ owner, text }),
    now: () => clock.now,
    log: (line) => void logged.push(line),
  };
  return { deps, ledger, pushed, told, logged, clock, state: () => state, list: () => approvals };
}

const url = (path: string) => new URL(`http://agent${path}`);

// --- the person's routes -----------------------------------------------------------

function granted(w: ReturnType<typeof world>) {
  const subject = { key: "k".repeat(64), project: "payroll", projectName: "Pete's Payroll", channel: "email", what: "pay-stub", to: ["ana@example.com"], templates: ["pay-stub"] };
  w.deps.save({ grants: [{ ...subject, grantedAt: "2026-10-30T09:00:00.000Z", runsSince: 2 }], always: [{ ...subject, key: "a".repeat(64), project: "billing", at: "2026-10-30T09:00:00.000Z" }], counts: [] });
  return subject;
}

test("/trust: a phone or a desk only, GET for the list and POST for the rest", async () => {
  const w = world(Date.parse("2026-10-30T10:00:00Z"));
  assert.equal((await tr.handleTrustPerson("/trust", "GET", url("/trust"), "", { kind: "lead" }, w.deps)).status, 403);
  assert.equal((await tr.handleTrustPerson("/trust/revoke", "GET", url("/trust/revoke"), "", { kind: "phone" }, w.deps)).status, 405);
  assert.equal((await tr.handleTrustPerson("/trust", "POST", url("/trust"), "", { kind: "phone" }, w.deps)).status, 405);
  assert.equal((await tr.handleTrustPerson("/trust/revoke", "POST", url("/trust/revoke"), "{", { kind: "phone" }, w.deps)).status, 400);
  assert.equal((await tr.handleTrustPerson("/trust/revoke", "POST", url("/trust/revoke"), "{}", { kind: "phone" }, w.deps)).status, 400);
});

test("/trust lists the grants, the keys that always ask and the receipts, for one project when asked", async () => {
  const w = world(Date.parse("2026-10-30T10:00:00Z"));
  granted(w);
  const all = (await tr.handleTrustPerson("/trust", "GET", url("/trust"), "", { kind: "desk" }, w.deps)).body as import("@cobra/contracts").TrustList;
  assert.equal(all.grants.length, 1);
  assert.equal(all.always.length, 1);
  assert.deepEqual(all.receipts, []);
  const one = (await tr.handleTrustPerson("/trust", "GET", url("/trust?project=payroll"), "", { kind: "phone" }, w.deps)).body as import("@cobra/contracts").TrustList;
  assert.equal(one.grants.length, 1);
  assert.equal(one.always.length, 0);
});

test("/trust/revoke takes a grant back and tells the Foreman; /trust/clear lets a key earn trust again", async () => {
  const w = world(Date.parse("2026-10-30T10:00:00Z"));
  const subject = granted(w);
  const revoked = await tr.handleTrustPerson("/trust/revoke", "POST", url("/trust/revoke"), JSON.stringify({ key: subject.key }), { kind: "phone" }, w.deps);
  assert.equal(revoked.status, 200);
  assert.deepEqual(w.state().grants, []);
  assert.deepEqual(w.told, [{ owner: "payroll", text: "The person stopped trusting you to send pay-stub to ana@example.com: those are cards to allow again." }]);
  assert.equal((await tr.handleTrustPerson("/trust/revoke", "POST", url("/trust/revoke"), JSON.stringify({ key: subject.key }), { kind: "phone" }, w.deps)).status, 404);
  const cleared = await tr.handleTrustPerson("/trust/clear", "POST", url("/trust/clear"), JSON.stringify({ key: "a".repeat(64) }), { kind: "desk" }, w.deps);
  assert.equal(cleared.status, 200);
  assert.deepEqual(w.state().always, []);
  assert.equal(w.told.length, 1, "clearing tells nobody");
});

// --- the done-when -------------------------------------------------------------------

test("done when: the payroll routine runs 3 times, Cobra proposes trust, and the 4th run lands as a receipt with no tap", async () => {
  const repo = mkdtempSync(join(ROOT, "repo-"));
  mkdirSync(join(repo, "out"));
  const project = { id: "payroll", name: "Pete's Payroll", path: repo };
  const w = world(Date.parse("2026-10-30T08:00:00Z"));

  // The Foreman, as the routine's brief makes it act: render this fortnight's stubs (the ledger notes them), then propose them.
  let fortnight = 0;
  const foreman = async (): Promise<void> => {
    fortnight += 1;
    const paths: string[] = [];
    for (const person of ["ana", "ben"]) {
      const path = `out/pay-stub-${person}-${fortnight}.pdf`;
      const bytes = Buffer.from(`%PDF pay stub for ${person}, fortnight ${fortnight}`);
      writeFileSync(join(repo, path), bytes);
      w.ledger[createHash("sha256").update(bytes).digest("hex")] = { project: "payroll", template: "pay-stub", templateSha: PAY_STUB_TEMPLATE, at: new Date(w.clock.now).toISOString() };
      paths.push(path);
    }
    const action = parseAction(
      { channel: "email", summary: `2 pay stubs, fortnight ${fortnight}`, to: ["ana@example.com", "ben@example.com"], subject: "Your pay stub", text: `Your pay stub for fortnight ${fortnight} is attached.`, attachments: paths },
      project,
    );
    // As /orch/action/propose does: on trust it runs now, else it is a card.
    const run = tr.trustedApproval(w.deps, action, "fm_payroll");
    w.deps.approvals.save([...w.deps.approvals.load(), run ?? makeApproval({ kind: "action", title: `Send: ${action.summary}`, body: "…", requestedBy: "fm_payroll", action }, w.clock.now)]);
  };

  // The routine, and the minute tick as the agent runs it.
  let routines: StoredRoutine[] = [
    {
      id: "rt_payroll",
      project: "payroll",
      projectName: "Pete's Payroll",
      name: "Fortnightly payroll",
      rule: { every: "week", interval: 2, days: ["fri"], at: "09:00", starts: "2026-10-30" },
      brief: "Run this fortnight's payroll and propose the pay stubs.",
      enabled: true,
      nextRun: "2026-10-30T09:00:00.000Z",
      lastRun: null,
      createdAt: "2026-10-23T10:00:00.000Z",
      createdBy: "foreman",
      owner: "payroll",
    },
  ];
  const typed: string[] = [];
  const tick: TickDeps = {
    load: () => structuredClone(routines),
    save: (next) => void (routines = structuredClone(next)),
    run: async (_routine, text) => {
      typed.push(text);
      await foreman();
      return { ok: true };
    },
    timeline: () => undefined,
    notifyOnce: () => undefined,
    log: () => undefined,
    tz: LONDON,
  };

  // What leaves the computer: Gmail, faked.
  const sent: Array<{ to: string[]; subject: string; files: string[] }> = [];
  const actions: ActionDeps = {
    sendBox: async () => {
      throw new Error("no mailbox in this test");
    },
    sendGmail: async (message) => {
      sent.push({ to: message.to, subject: message.subject, files: (message.attachments ?? []).map((file) => file.name) });
      return { id: `m${sent.length}`, from: "pete@example.com" };
    },
    organizeMail: async (batch) => ({ changed: batch.ids.length, failed: 0 }),
    uploadToDrive: async () => [],
    readFile: (path) => readFile(path),
    projectPath: async () => repo,
    readFilesConfig: async () => ({ exports: {} }) as never,
    mkdir: async () => undefined,
    listDir: async () => [],
    copyFile: async () => undefined,
  };
  const carryOut = async (approval: StoredApproval): Promise<StoredApproval> => {
    const done = await runAction(actions, approval);
    w.deps.approvals.save(w.deps.approvals.load().map((a) => (a.id === done.id ? done : a)));
    return done;
  };
  // The person's tap on a card, as /approvals/answer does it.
  const allow = async (approval: StoredApproval): Promise<StoredApproval> => {
    const answered = answer(w.deps.approvals.load(), approval.id, true, w.clock.now);
    w.deps.approvals.save(answered.list);
    if (answered.approval.kind === "trust") {
      const settled = tr.settleTrustCard(w.deps, answered.approval);
      w.deps.approvals.save(w.deps.approvals.load().map((a) => (a.id === settled.id ? settled : a)));
      return settled;
    }
    const done = await carryOut(answered.approval);
    await tr.afterAnswer(w.deps, done);
    return done;
  };
  const pending = () => w.deps.approvals.load().filter((a) => a.state === "pending");

  const fridays = ["2026-10-30", "2026-11-13", "2026-11-27", "2026-12-11"];
  for (const [i, day] of fridays.entries()) {
    w.clock.now = Date.parse(`${day}T09:00:20Z`);
    assert.deepEqual(await r.tickRoutines(tick, w.clock.now), [{ id: "rt_payroll", outcome: "started" }], `run ${i + 1} on ${day}`);
    if (i < 3) {
      const cards = pending();
      assert.equal(cards.length, 1, `run ${i + 1} is a card`);
      assert.equal(cards[0]!.kind, "action");
      assert.equal((await allow(cards[0]!)).state, "done");
      if (i < 2) assert.deepEqual(w.pushed, [], "no trust yet");
      // The off Friday between: nothing runs.
      assert.deepEqual(await r.tickRoutines(tick, Date.parse(`${day}T09:00:20Z`) + 7 * 24 * 60 * 60_000), []);
    }
    if (i === 2) {
      // After the third clean run, Cobra proposes trust: one card, pushed, naming who and what.
      assert.equal(w.pushed.length, 1);
      const trust = pending();
      assert.equal(trust.length, 1);
      assert.equal(trust[0]!.kind, "trust");
      assert.equal(trust[0]!.title, "Let Pete's Payroll send pay-stub to these 2 addresses without asking?");
      assert.deepEqual(trust[0]!.trust?.examples, ["Send: 2 pay stubs, fortnight 1", "Send: 2 pay stubs, fortnight 2", "Send: 2 pay stubs, fortnight 3"]);
      assert.equal((await allow(trust[0]!)).state, "done");
      assert.match(w.told.at(-1)!.text, /now trusts you to send pay-stub to these 2 addresses/);
    }
  }

  // The fourth: no card waited, and the email went out as soon as it was proposed.
  assert.deepEqual(pending(), []);
  const fourth = w.deps.approvals.load().at(-1)!;
  assert.equal(fourth.state, "allowed");
  assert.ok(fourth.trusted);
  assert.equal(sent.length, 3, "nothing sent yet: the agent carries it out next");
  const landed = await carryOut(fourth);
  assert.equal(landed.state, "done");
  assert.equal(sent.length, 4);
  assert.deepEqual(sent[3], { to: ["ana@example.com", "ben@example.com"], subject: "Your pay stub", files: ["pay-stub-ana-4.pdf", "pay-stub-ben-4.pdf"] });
  assert.deepEqual(typed, Array(4).fill("Routine Fortnightly payroll: Run this fortnight's payroll and propose the pay stubs."));

  // It is a receipt under Landed, and the grant counted it.
  const list = t.trustList(w.state(), w.deps.approvals.load(), w.clock.now, "payroll");
  assert.deepEqual(list.receipts.map((a) => a.id), [landed.id]);
  assert.equal(list.receipts[0]!.state, "done");
  assert.equal(list.grants[0]!.runsSince, 1);
  assert.equal(await tr.afterAnswer(w.deps, landed), null, "a trusted run earns nothing more");

  // A new person on the list asks again.
  const action = parseAction({ channel: "email", summary: "3 pay stubs", to: ["ana@example.com", "ben@example.com", "cara@example.com"], subject: "Your pay stub", text: "Attached.", attachments: ["out/pay-stub-ana-4.pdf"] }, project);
  assert.equal(tr.trustedApproval(w.deps, action, "fm_payroll"), null);
});

test("a save to the person's own Drive runs at once on their Connect, with no grant; a local folder still asks", () => {
  const repo = mkdtempSync(join(ROOT, "drive-"));
  mkdirSync(join(repo, "out"));
  writeFileSync(join(repo, "out", "checklist.pdf"), "%PDF go-live checklist");
  const project = { id: "chrishi-beach-marketing", name: "Chrishi Beach Marketing", path: repo };
  const w = world(Date.parse("2026-10-29T15:45:00Z"));
  const drive = parseAction({ channel: "file", summary: "Go-live checklist v2 to Drive", attachments: ["out/checklist.pdf"] }, project);
  const run = tr.trustedApproval(w.deps, drive, "fm_marketing");
  assert.equal(run?.state, "allowed");
  assert.equal(run?.trusted?.key, t.DRIVE_CONSENT);
  assert.deepEqual(w.state(), { grants: [], always: [], counts: [] }, "no trust spent or earned");
  const done = { ...run!, state: "done" as const, results: [{ ok: true, message: "put 1 file in your Google Drive" }] };
  assert.equal(t.receiptNotice(done).body, "Done as you agreed when you connected Google: put 1 file in your Google Drive.");

  // A day's saves are capped: past it, the next one is a card again.
  w.deps.approvals.save(Array.from({ length: t.DRIVE_SAVES_PER_DAY }, () => ({ ...run! })));
  assert.equal(tr.trustedApproval(w.deps, drive, "fm_marketing"), null);

  const local = parseAction({ channel: "file", summary: "Checklist to the shared folder", folder: "shared", attachments: ["out/checklist.pdf"] }, project, {
    shared: { label: "Shared", path: join(ROOT, "shared") },
  });
  assert.equal(tr.trustedApproval(world(Date.parse("2026-10-29T15:45:00Z")).deps, local, "fm_marketing"), null);
});
