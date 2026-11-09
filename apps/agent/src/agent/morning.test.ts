import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "cobra-morning-"));
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
// The brief's sequence digest opens every Space's store: never the person's live ones (2026-11-03 it migrated them).
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");
process.env.COBRA_SPACES_DIR = join(ROOT, "Spaces");

const m = await import("./morning.ts");
import type { Brief, MorningDeps, MorningFacts } from "./morning.ts";

const at = (hours: number, minutes = 0, day = 24) => new Date(2026, 9, day, hours, minutes);
const quietFacts = (computer: string): MorningFacts => ({ computer, day: "2026-10-23", landed: [], counts: { merged: 0, actions: 0, routines: 0 }, today: [], waiting: [] });
const busyFacts: MorningFacts = {
  computer: "legion",
  day: "2026-10-23",
  landed: [{ project: "payroll", report: "Pay stubs for 4 people sent." }],
  counts: { merged: 2, actions: 1, routines: 1 },
  today: [{ project: "Billing", name: "Monday invoices", at: at(10).toISOString() }],
  waiting: ["Send 3 invoices?"],
};

test("the brief is due once a day, from its hour, and not hours late", () => {
  const on = { enabled: true, at: "08:00" };
  assert.equal(m.morningDue(on, null, at(7, 59)), false);
  assert.equal(m.morningDue(on, null, at(8)), true);
  assert.equal(m.morningDue(on, "2026-10-24", at(8, 1)), false);
  assert.equal(m.morningDue(on, "2026-10-23", at(10, 59)), true);
  // The computer was off at eight: past three hours it waits for tomorrow.
  assert.equal(m.morningDue(on, "2026-10-23", at(11, 1)), false);
  assert.equal(m.morningDue({ enabled: false, at: "08:00" }, null, at(8)), false);
});

test("only the Lead's computer sends, while its Lead runs", () => {
  assert.equal(m.sendsHere(true, true, undefined), true);
  assert.equal(m.sendsHere(true, true, "off"), false);
  assert.equal(m.sendsHere(true, false, undefined), false);
  assert.equal(m.sendsHere(false, true, undefined), false);
});

test("settings: either field alone, over what is in force; anything else refused", () => {
  const current = { enabled: true, at: "08:00" };
  assert.deepEqual(m.parseSettings({ at: "07:30" }, current), { enabled: true, at: "07:30" });
  assert.deepEqual(m.parseSettings({ enabled: false }, current), { enabled: false, at: "08:00" });
  assert.equal(typeof m.parseSettings({ at: "7:30" }, current), "string");
  assert.equal(typeof m.parseSettings({ at: "24:00" }, current), "string");
  assert.equal(typeof m.parseSettings({ enabled: "yes" }, current), "string");
  assert.equal(typeof m.parseSettings({ at: "08:00", push: true }, current), "string");
  assert.equal(typeof m.parseSettings([], current), "string");
  m.saveSettings({ enabled: false, at: "06:30" });
  assert.deepEqual(m.loadSettings(), { enabled: false, at: "06:30" });
});

test("facts: each project's last report yesterday, yesterday's counts, today's routines, what waits", () => {
  const now = at(8);
  const yesterday = at(15, 0, 23).toISOString();
  const facts = m.gatherFacts({
    computer: "legion",
    now,
    feed: (since, until) => {
      assert.equal(since, at(0, 0, 23).getTime());
      assert.equal(until, at(0).getTime());
      return [
        { role: "foreman", project: "payroll", lastMessage: "## Done\nFirst try.", at: yesterday },
        { role: "foreman", project: "payroll", lastMessage: "Done:\n- **Pay stubs** for 4 people sent.", at: yesterday },
        { role: "worker", project: "payroll", lastMessage: "A Worker's word is not a report.", at: yesterday },
        { role: "foreman", project: "billing" },
      ].map((item) => ({ at: yesterday, ...item }));
    },
    timeline: () => [{ count: "pr-merged", detail: "a#1" }, { count: "pr-merged", detail: "a#1" }, { count: "pr-merged", detail: "a#2" }, { count: "action-done" }, { count: "routine-ran" }, { count: "answered" }, {}],
    routines: () => [
      { project: "billing", projectName: "Billing", name: "Monday invoices", enabled: true, nextRun: at(10).toISOString() },
      { project: "billing", name: "Paused", enabled: false, nextRun: at(9).toISOString() },
      { project: "billing", name: "Tomorrow", enabled: true, nextRun: at(9, 0, 25).toISOString() },
      { project: "billing", name: "Never", enabled: true, nextRun: null },
    ],
    waiting: () => ["Send 3 invoices?"],
  });
  assert.equal(facts.day, "2026-10-23");
  assert.deepEqual(facts.landed, [{ project: "payroll", report: "Pay stubs for 4 people sent." }]);
  assert.deepEqual(facts.counts, { merged: 2, actions: 1, routines: 1 });
  assert.deepEqual(facts.today.map((r) => [r.project, r.name]), [["Billing", "Monday invoices"]]);
  assert.deepEqual(facts.waiting, ["Send 3 invoices?"]);
});

test("another computer's facts are read as data, and anything else is none", () => {
  assert.equal(m.parseFacts(null), null);
  assert.equal(m.parseFacts({ computer: "mini" }), null);
  const read = m.parseFacts({ ...quietFacts("mini"), landed: [{ project: "a", report: "ok" }, { project: 3 }], counts: { merged: "2" } });
  assert.deepEqual(read?.landed, [{ project: "a", report: "ok" }]);
  assert.deepEqual(read?.counts, { merged: 2, actions: 0, routines: 0 });
});

test("the plain brief: a quiet night said plainly, else three lines", () => {
  assert.match(m.plainBrief([quietFacts("legion"), quietFacts("mini")]), /^Quiet night/);
  const text = m.plainBrief([busyFacts, quietFacts("mini")]);
  assert.equal(text.split("\n").length, 3);
  assert.match(text, /^Yesterday: payroll reported; 2 updates went live; 1 action carried out\./);
  assert.match(text, /Today: Monday invoices at 10:00 AM \(Billing\)\./);
  assert.match(text, /Waiting on you: 1 \(Send 3 invoices\?\)\./);
});

test("a card that lapsed unanswered in the last day is a fourth line, and read from another computer", () => {
  const now = at(8).getTime();
  const hour = 60 * 60_000;
  const titles = m.lapsedTitles(
    [
      { state: "expired", expiresAt: new Date(now - 2 * hour).toISOString(), title: "Merge #41 (deploys on merge)?" },
      { state: "expired", expiresAt: new Date(now - 30 * hour).toISOString(), title: "Last week's" },
      { state: "pending", expiresAt: new Date(now + hour).toISOString(), title: "Still waiting" },
      { state: "denied", expiresAt: new Date(now - hour).toISOString(), title: "You said no" },
    ],
    now,
  );
  assert.deepEqual(titles, ["Merge #41 (deploys on merge)?"]);
  const text = m.plainBrief([{ ...quietFacts("legion"), lapsed: titles }]);
  assert.doesNotMatch(text, /^Quiet night/);
  assert.match(text, /Lapsed unanswered: 1 \(Merge #41 \(deploys on merge\)\?\); ask again/);
  assert.deepEqual(m.parseFacts({ ...quietFacts("mini"), lapsed: ["A", 3] })?.lapsed, ["A"]);
  assert.equal(m.parseFacts(quietFacts("mini"))?.lapsed, undefined, "an older agent says nothing of it");
});

test("the brief says what each email sequence sent, and a night of only sequences is not quiet", () => {
  const email = [{ space: "Happy Tails", name: "Welcome series", sent: 3, running: 5, paused: false }, { space: "Happy Tails", name: "Renewal", sent: 0, running: 2, paused: true }];
  const text = m.plainBrief([{ ...quietFacts("legion"), email }]);
  assert.doesNotMatch(text, /^Quiet night/);
  assert.match(text, /Email sequences: Welcome series: 3 emails sent, 5 part way; Renewal \(paused\): 0 emails sent, 2 part way\. Pause one in People's Email sequences\./);
  assert.deepEqual(m.parseFacts({ ...quietFacts("mini"), email: [...email, { name: 4 }] })?.email, email);
  assert.equal(m.parseFacts(quietFacts("mini"))?.email, undefined, "an older agent says nothing of it");
});

test("the model's reply is cut to four plain lines", () => {
  assert.equal(m.cleanBrief("## Morning\n- **Payroll** sent.\n\nTwo PRs merged.\nA\nB\nC"), "Morning\nPayroll sent.\nTwo PRs merged.\nA");
  assert.equal(m.cleanBrief(" \n "), null);
  assert.ok(m.briefInput([busyFacts]).startsWith("<facts>\n"));
});

function deps(over: Partial<MorningDeps> = {}) {
  const sent: Brief[] = [];
  const runs: string[] = [];
  let latest: Brief | null = null;
  const d: MorningDeps = {
    settings: () => ({ enabled: true, at: "08:00" }),
    latest: { load: () => latest, save: (brief) => (latest = brief) },
    own: () => busyFacts,
    peers: async () => [quietFacts("mini"), null],
    models: async () => ["haiku"],
    run: async (model) => {
      runs.push(model);
      return "Three invoices wait on you.\nPayroll went out.";
    },
    deliver: async (brief) => void sent.push(brief),
    log: () => undefined,
    now: () => at(8, 1),
    ...over,
  };
  return { d, sent, runs, latest: () => latest };
}

test("the tick writes the day's brief once, from every computer's facts", async () => {
  const { d, sent, runs } = deps();
  const brief = await m.morningTick(d);
  assert.equal(brief?.by, "model");
  assert.equal(brief?.day, "2026-10-24");
  assert.deepEqual(runs, ["haiku"]);
  assert.equal(sent.length, 1);
  assert.equal(await m.morningTick(d), null);
  assert.equal(sent.length, 1);
});

test("a quiet day asks no model; at HOLD or a failed run the plain words go", async () => {
  const quiet = deps({ own: () => quietFacts("legion") });
  assert.equal((await m.morningTick(quiet.d))?.by, "plain");
  assert.deepEqual(quiet.runs, []);
  assert.match(quiet.sent[0]!.text, /^Quiet night/);

  const held = deps({ models: async () => [] });
  const plain = await m.morningTick(held.d);
  assert.equal(plain?.by, "plain");
  assert.match(plain!.text, /^Yesterday:/);

  const failed = deps({
    models: async () => ["haiku", "sonnet"],
    run: async (model) => {
      throw new Error(`${model} down`);
    },
  });
  assert.equal((await m.morningTick(failed.d))?.by, "plain");
});

test("a brief whose push fails is not sent twice", async () => {
  const { d, latest } = deps({
    deliver: async () => {
      throw new Error("push failed");
    },
  });
  await assert.rejects(m.morningTick(d));
  assert.equal(latest()?.day, "2026-10-24");
  assert.equal(await m.morningTick(d), null);
});

test("GET /orch/morning: this computer's facts for a Lead's key, local or remote; never a Foreman's", async () => {
  const { handleOrch, ORCH_ROUTES, FOREMAN_ONLY } = await import("./orch.ts");
  const { foremanCallerId } = await import("./keys.ts");
  assert.ok(ORCH_ROUTES.has("/orch/morning"));
  assert.equal(FOREMAN_ONLY.has("/orch/morning"), false);
  type Caller = { id: string; kind: string; name: string; remote?: boolean; project?: string };
  const call = async (caller: Caller) => {
    let reply: { status: number; body: unknown } = { status: 0, body: null };
    await handleOrch("/orch/morning", new URL("http://agent/orch/morning"), { method: "GET", on: () => undefined } as never, {} as never, {
      send: (_response: unknown, status: number, sent: unknown) => void (reply = { status, body: sent }),
      readBody: async () => "",
      configPath: join(ROOT, "config", "projects.json"),
      log: () => undefined,
      caller,
      notify: async () => undefined,
      machineLabel: "legion",
      port: 8797,
    } as never);
    return reply;
  };
  const local = await call({ id: "lead_legion", kind: "lead", name: "Lead on legion" });
  assert.equal(local.status, 200);
  assert.ok(m.parseFacts(local.body));
  assert.equal((await call({ id: "lead_mini", kind: "lead", name: "Lead on mini", remote: true })).status, 200);
  assert.equal((await call({ id: foremanCallerId("payroll"), kind: "lead", name: "Foreman", project: "payroll" })).status, 403);
});

test("the brief groups projects by company, from My Organization on the Lead's computer", () => {
  const org = { revision: 2, companies: [{ id: "happy-tails", name: "Happy Tails", color: "#c0763a" }], seats: { "omarchy/payroll": { company: "happy-tails" }, "omarchy/billing": { company: "happy-tails" } } };
  const facts: MorningFacts = {
    ...busyFacts,
    machine: "omarchy",
    landed: [{ project: "payroll", report: "Sent." }, { project: "site", report: "Deployed." }],
    today: [{ project: "Billing", projectId: "billing", name: "Monday invoices", at: at(10).toISOString() }],
  };
  const [grouped] = m.withCompanies([facts], org);
  assert.deepEqual(grouped!.landed, [{ project: "payroll", report: "Sent.", company: "Happy Tails" }, { project: "site", report: "Deployed." }]);
  assert.equal(grouped!.today[0]!.company, "Happy Tails");
  const text = m.plainBrief([grouped!]);
  assert.match(text, /^Yesterday: Happy Tails \(payroll\), site reported/);
  assert.match(text, /Monday invoices at 10:00 AM \(Happy Tails · Billing\)/);
  // An older computer that does not say its host name, or no companies: nothing changes.
  assert.deepEqual(m.withCompanies([busyFacts], org), [{ ...busyFacts }]);
  assert.deepEqual(m.withCompanies([facts], null), [facts]);
  // Another computer's facts keep their host name and project ids through the parse.
  const parsed = m.parseFacts(JSON.parse(JSON.stringify(facts)))!;
  assert.equal(parsed.machine, "omarchy");
  assert.equal(parsed.today[0]!.projectId, "billing");
});
