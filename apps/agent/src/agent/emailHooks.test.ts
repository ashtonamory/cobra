import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-email-hooks-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { validateTemplate } = await import("../../../../packages/contracts/src/emailTemplate.ts");
const { openProjectDb } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { storeInquiry } = await import("./sitePull.ts");
const { acceptDraft, currentTheme, emailFolders, readVersion, saveDraft } = await import("./emailFiles.ts");
const { EmailQueue } = await import("./emailQueue.ts");
const { sendNext } = await import("./emailSend.ts");
const { renderForView } = await import("./emailSend.ts");
const { fireHooks, newRows, startCursor, valuesFor, HOOK_ONCE_MS } = await import("./emailHooks.ts");
const { STARTERS } = await import("./emailStarters.ts");
const { handleEmailOrch, proposeBranded } = await import("./emailRoutes.ts");
const { actionKey } = await import("./actionTrust.ts");
const tr = await import("./trustRoutes.ts");
const { answer } = await import("./approvals.ts");
const { runAction } = await import("./actions.ts");

type StoredApproval = import("./approvals.ts").StoredApproval;
type TrustState = import("./actionTrust.ts").TrustState;
type EmailRouteDeps = import("./emailRoutes.ts").EmailRouteDeps;
type MailMessage = import("./mime.ts").MailMessage;
type Project = import("@cobra/contracts").Project;

const BRAND = { colors: { brand: "#0b1f3a", accent: "#f5b301", ink: "#0b1220", paper: "#f6f4ee" }, fonts: { heading: "Inter", body: "Inter" } };
const NOW = new Date("2026-11-02T15:00:00Z");

test("each starter is a valid template that draws with its sample values; all but outreach are transactional", () => {
  const folders = emailFolders(mkdtempSync(join(tmpdir(), "cobra-starters-")));
  for (const [id, starter] of Object.entries(STARTERS)) {
    const checked = validateTemplate(starter.template);
    assert.ok(checked.ok, `${id}: ${checked.ok ? "" : checked.errors.join("; ")}`);
    assert.equal(starter.template.kind, id === "outreach" ? "marketing" : "transactional", id);
    const drawn = renderForView(folders, currentTheme(folders, { brand: BRAND as never, business: "Happy Tails", address: "1 High St" }), starter.template, { first_name: "Ana" });
    assert.deepEqual(drawn.errors, [], id);
  }
});

const branded = (over: Record<string, unknown> = {}) =>
  ({
    channel: "branded",
    project: "p1",
    projectName: "Studio",
    summary: "x",
    branded: { space: "s1", template: "form-reply", name: "Form reply", version: 1, templateSha: "a".repeat(64), emailKind: "transactional", to: "ana@example.com", subject: "Hi", values: {}, sha256: "b".repeat(64), links: [], missing: [], ...over },
  }) as never;

test("a branded email is trusted per template version, whoever it goes to; marketing never", () => {
  const one = actionKey(branded(), {});
  const other = actionKey(branded({ to: "ben@example.com", sha256: "c".repeat(64), subject: "Hi Ben" }), {});
  assert.ok(one.trustable && other.trustable);
  assert.equal(one.subject.key, other.subject.key, "another person, another email, the same version: one key");
  const changed = actionKey(branded({ templateSha: "d".repeat(64), version: 2 }), {});
  assert.ok(changed.trustable);
  assert.notEqual(changed.subject.key, one.subject.key, "a new version asks again");
  assert.equal(actionKey(branded({ emailKind: "campaign" }), {}).trustable, false);
});

/** A Space with People and Money, its email folder, queue, trust and approvals, all in memory or a temp folder. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "cobra-hooks-space-"));
  mkdirSync(join(dir, "brand"));
  writeFileSync(join(dir, "brand", "brand.json"), JSON.stringify(BRAND));
  const dbDir = mkdtempSync(join(tmpdir(), "cobra-hooks-db-"));
  const db = openProjectDb("space-s1", SPACE_SCHEMA, dbDir);
  const folders = emailFolders(dir);
  const space = { id: "s1", dir, name: "Happy Tails" };
  const project = { id: "p1", name: "Studio", path: join(dir, "studio") } as Project;
  const queue = new EmailQueue(join(dir, "q.db"));
  let clock = NOW.getTime();
  let approvals: StoredApproval[] = [];
  let state: TrustState = { grants: [], always: [], counts: [] };
  const pushed: StoredApproval[] = [];
  const store = { load: () => structuredClone(approvals), save: (list: StoredApproval[]) => void (approvals = structuredClone(list)) };
  const trustDeps = {
    load: () => structuredClone(state),
    save: (next: TrustState) => void (state = structuredClone(next)),
    approvals: store,
    renders: () => ({}),
    notify: async (a: StoredApproval) => void pushed.push(a),
    tell: () => {},
    now: () => clock,
    log: () => {},
  };
  const actions = { queueBranded: async (b: NonNullable<import("@cobra/contracts").ApprovalAction["branded"]>, id: string) => `queued as email job ${queue.add({ kind: b.emailKind, template: b.template, version: b.version, templateSha: b.templateSha, values: b.values, to: b.to, personId: b.personId ?? null, dueAt: new Date(clock).toISOString(), approval: id }, new Date(clock))}` } as never;
  const carryOut = async (approval: StoredApproval) => {
    const done = await runAction(actions, approval);
    store.save(store.load().map((a) => (a.id === done.id ? done : a)));
    return done;
  };
  const deps: EmailRouteDeps = {
    project: async (id) => (id === "p1" ? project : undefined),
    space: () => space,
    spaceById: (id) => (id === "s1" ? space : null),
    place: () => ({ brand: BRAND as never, business: "Happy Tails", address: "1 High St" }),
    queue: () => queue,
    person: (_s, email) => {
      const row = db.queryRaw("SELECT id, name, email, organization FROM people WHERE lower(email) = lower(?)", [email]).rows[0];
      return row ? { id: Number(row.id), name: String(row.name), email: String(row.email), organization: null } : null;
    },
    approvals: store,
    notify: async (a) => void pushed.push(a),
    log: () => {},
    now: () => clock,
    trust: { approval: (action, by) => tr.trustedApproval(trustDeps as never, action, by), carryOut: (a) => void carryOut(a) },
    hookStart: (_s, event) => startCursor(db, event),
  };
  const sent: MailMessage[] = [];
  const fire = () =>
    fireHooks({
      queue,
      store: (use) => use(db),
      template: (slug) => readVersion(folders, slug)?.template ?? null,
      recently: (to, template, since) => queue.queuedSince(to, template, since) || store.load().some((a) => a.state === "pending" && a.action?.branded?.template === template && a.action.branded.to === to),
      now: () => new Date(clock),
      propose: async (hook, to, values) => {
        const p = await proposeBranded({ template: hook.template, to, values }, { folders, space, project, requestedBy: `email-hook:${hook.event}`, tainted: false }, deps, new Date(clock));
        return "error" in p ? { error: p.error } : { trusted: p.trusted };
      },
      log: () => {},
    });
  // The person's tap, as /approvals/answer does it: a send is carried out and counted toward trust; a trust card writes the grant.
  const allow = async (approval: StoredApproval) => {
    const answered = answer(store.load(), approval.id, true, clock);
    store.save(answered.list);
    if (answered.approval.kind === "trust") {
      const settled = tr.settleTrustCard(trustDeps as never, answered.approval);
      store.save(store.load().map((a) => (a.id === settled.id ? settled : a)));
      return settled;
    }
    const done = await carryOut(answered.approval);
    await tr.afterAnswer(trustDeps as never, done);
    return done;
  };
  const send = () =>
    sendNext({
      folders,
      queue,
      adapter: { provider: "gmail", dailyCap: 200, account: async () => "owner@gmail.com", send: async (m) => (sent.push(m), { account: "owner@gmail.com", messageId: `m${sent.length}@gmail.com`, providerId: `g${sent.length}` }) },
      place: () => ({ brand: BRAND as never, business: "Happy Tails", address: "1 High St" }),
      people: null,
      now: () => new Date(clock),
      log: () => {},
    });
  const foreman = { id: "fm", kind: "lead", project: "p1" };
  const post = (route: string, body: unknown) => handleEmailOrch(route, new URL(`http://x${route}`), JSON.stringify(body), foreman, deps);
  const pending = () => store.load().filter((a) => a.state === "pending");
  return { db, folders, queue, deps, fire, allow, send, sent, post, pending, pushed, tick: (ms: number) => (clock += ms), state: () => state, trustDeps };
}

/** A template from a starter, allowed as v1 (the template card's Allow). */
async function allowed(w: ReturnType<typeof world>, starter: string) {
  const started = await w.post("/orch/email/template/start", { starter });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const draft = saveDraft(w.folders, starter, STARTERS[starter]!.template, NOW);
  acceptDraft(w.folders, starter, draft.sha256, "t1", NOW);
}

const inquiry = (id: number, name: string, email: string) => ({ id, name, email, phone: null, message: "Do you groom poodles?", created_at: "2026-11-02T14:00:00Z" }) as never;

test("phase 2 done: a form reply and a receipt go out with no card after the first trust grant", async () => {
  const w = world();
  // Rows from before the hook is set send nothing.
  storeInquiry(w.db, inquiry(1, "Old Lead", "old@example.com"));
  await allowed(w, "form-reply");
  await allowed(w, "receipt");
  assert.equal((await w.post("/orch/email/hook/set", { event: "form", template: "nope" })).status, 404);
  assert.equal((await w.post("/orch/email/hook/set", { event: "form", template: "form-reply" })).status, 200);
  assert.equal((await w.post("/orch/email/hook/set", { event: "payment", template: "receipt" })).status, 200);
  const listed = (await w.post("/orch/email/templates", {})).body as { hooks: { event: string; template: string }[]; starters: unknown[] };
  assert.deepEqual(listed.hooks.map((h) => `${h.event}→${h.template}`), ["form→form-reply", "payment→receipt"]);
  assert.equal(listed.starters.length, 5);
  assert.deepEqual(await w.fire(), [], "nothing new since the hooks were set");

  w.db.write("business_set", { legal_name: "Happy Tails LLC", tax_rate_bp: 0 }, "foreman");
  w.db.write("item_set", { name: "Full groom", unit: "visit", unit_price_cents: "80.00" }, "foreman");
  const people = ["Ana Silva", "Ben Ode", "Cy Park", "Di Lund"];
  for (const [i, name] of people.entries()) {
    const email = `${name.split(" ")[0]!.toLowerCase()}@example.com`;
    // A website form: the person is added to People and the hook makes a form reply.
    storeInquiry(w.db, inquiry(10 + i, name, email));
    // An invoice paid in part: the hook makes a receipt with what is still owed.
    w.db.write("invoice_create", { customer_id: i + 2, issue_date: "2026-11-01", lines: [{ item_id: 1, quantity: 2 }] }, "foreman");
    w.db.write("invoice_issue", { id: i + 1 }, "foreman");
    w.db.write("payment_record", { invoice_id: i + 1, amount_cents: 10_000, received_on: "2026-11-02" }, "foreman");
    const fired = await w.fire();
    if (i < 3) {
      assert.deepEqual(fired.map((f) => f.outcome), ["card", "card"], `run ${i + 1}: both ask`);
      for (const card of w.pending().filter((a) => a.kind === "action")) assert.equal((await w.allow(card)).state, "done");
      if (i === 2) {
        const trust = w.pending().filter((a) => a.kind === "trust");
        assert.deepEqual(trust.map((a) => a.title), ['Let Studio send "Form reply" emails (v1) to one person at a time without asking?', 'Let Studio send "Payment receipt" emails (v1) to one person at a time without asking?']);
        assert.match(trust[0]!.body, /whoever it is for/);
        for (const card of trust) assert.equal((await w.allow(card)).state, "done");
      }
    } else {
      assert.deepEqual(fired.map((f) => f.outcome), ["trusted", "trusted"], "after the grant: no card");
      assert.deepEqual(w.pending(), []);
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
  for (let n = 0; n < 8; n += 1) {
    assert.ok("sent" in (await w.send()), `email ${n + 1} sends`);
    w.tick(20_000);
  }
  const di = w.sent.filter((m) => m.to.includes("di@example.com"));
  assert.deepEqual(di.map((m) => m.subject).sort(), ["Payment received, thank you", "Thanks for getting in touch, Di"]);
  const receipt = di.find((m) => m.subject.startsWith("Payment"))!;
  assert.match(receipt.text, /GBP 100\.00/);
  assert.match(receipt.text, /INV-4/);
  assert.match(receipt.text, /2 November 2026/);
  assert.match(receipt.text, /Still to pay: GBP 60\.00/);
});

test("a hook mails one address once a day, skips what it cannot send, and never tries a row twice", async () => {
  const w = world();
  await allowed(w, "form-reply");
  await w.post("/orch/email/hook/set", { event: "form", template: "form-reply" });
  storeInquiry(w.db, inquiry(1, "Ana Silva", "ana@example.com"));
  storeInquiry(w.db, inquiry(2, "Ana Again", "ana@example.com"));
  const fired = await w.fire();
  assert.deepEqual(fired.map((f) => f.outcome), ["card", "skipped"]);
  assert.match(fired[1]!.why!, /already went to ana@example.com in the last day/);
  assert.deepEqual(await w.fire(), [], "the cursor moved past both");
  w.tick(HOOK_ONCE_MS + 1);
  assert.equal((await w.post("/orch/email/hook/set", { event: "payment", template: "form-reply" })).status, 200);
  assert.equal((await w.post("/orch/email/hook/remove", { event: "form", template: "form-reply" })).status, 200);
  assert.equal((await w.post("/orch/email/hook/remove", { event: "form", template: "form-reply" })).status, 404);
  storeInquiry(w.db, inquiry(3, "Ben Ode", "ben@example.com"));
  assert.deepEqual(await w.fire(), [], "a removed hook sends nothing");
});

test("a payment row carries only the fields its template declares", () => {
  const w = world();
  w.db.write("person_add", { name: "Ana Silva", email: "ana@example.com" }, "foreman");
  w.db.write("business_set", { legal_name: "Happy Tails LLC", tax_rate_bp: 0 }, "foreman");
  w.db.write("item_set", { name: "Groom", unit_price_cents: "40.00" }, "foreman");
  w.db.write("invoice_create", { customer_id: 1, issue_date: "2026-11-01", lines: [{ item_id: 1, quantity: 1 }] }, "foreman");
  w.db.write("invoice_issue", { id: 1 }, "foreman");
  w.db.write("payment_record", { invoice_id: 1, amount_cents: 4_000, received_on: "2026-11-02" }, "foreman");
  const [row] = newRows(w.db, "payment", 0);
  assert.equal(row?.to, "ana@example.com");
  assert.equal(row?.values.balance, "Nothing");
  assert.deepEqual(Object.keys(valuesFor(STARTERS["form-reply"]!.template, row!.values)), []);
  assert.deepEqual(Object.keys(valuesFor(STARTERS.receipt!.template, row!.values)).sort(), ["amount", "balance", "invoice_number", "paid_on"]);
});

test("taint always asks: a trusted email_send from a turn that read text from outside is a card; a clean turn's goes on trust", async () => {
  const w = world();
  await allowed(w, "form-reply");
  // Trust earned on this template version (as three Allows and the trust card would write it).
  const version = readVersion(w.folders, "form-reply")!;
  const keyed = actionKey({ channel: "branded", project: "p1", projectName: "Studio", summary: "x", branded: { space: "s1", template: "form-reply", name: version.template.name, version: version.version, templateSha: version.sha256, emailKind: "transactional", to: "a@example.com", subject: "s", values: {}, sha256: "x", links: [], missing: [], text: "" } } as never, {});
  assert.ok(keyed.trustable);
  w.trustDeps.save({ grants: [{ ...keyed.subject, grantedAt: NOW.toISOString(), runsSince: 0 }], always: [], counts: [] });
  const values = {};

  const taintedAs = new Set<string>(["foreman:p1"]);
  w.deps.tainted = (who) => taintedAs.has(who);
  const asked = await w.post("/orch/email/send", { template: "form-reply", to: "ana@example.com", values });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal((asked.body as { trusted?: boolean }).trusted, undefined, "a card, though trust would send it");
  assert.equal(w.pending().filter((a) => a.kind === "action").length, 1);

  // A Worker's Space tools go by the Worker's own taint.
  taintedAs.clear();
  taintedAs.add("worker:p1_3");
  const byWorker = await handleEmailOrch("/orch/email/send", new URL("http://x/orch/email/send"), JSON.stringify({ template: "form-reply", to: "ben@example.com", values }), { id: "fm", kind: "lead", project: "p1", worker: "p1_3" }, w.deps);
  assert.equal((byWorker.body as { trusted?: boolean }).trusted, undefined);

  // A clean turn: on trust, as before.
  taintedAs.clear();
  const ran = await w.post("/orch/email/send", { template: "form-reply", to: "cy@example.com", values });
  assert.equal((ran.body as { trusted?: boolean }).trusted, true);
});
