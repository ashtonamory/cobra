import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EmailQueue } from "./emailQueue.ts";
import { buildBoard, linkOf, routineTemplates, type BoardInput, type SendRowLite } from "./marketing.ts";
import type { StoredRoutine } from "./routines.ts";

const NOW = Date.parse("2026-11-07T15:00:00Z");

const routine = (id: string, extra: Partial<StoredRoutine> = {}): StoredRoutine => ({
  id, project: "northwind-crm", projectName: "Northwind CRM", name: id, rule: { every: "day", interval: 1, at: "09:00" }, brief: "Find prospects", enabled: true,
  nextRun: "2026-11-08T14:00:00Z", lastRun: null, createdAt: "2026-11-01T00:00:00Z", createdBy: "lead", ...extra,
});

let sendId = 0;
const send = (template: string, sentAt: string, extra: Partial<SendRowLite> = {}): SendRowLite => ({
  id: ++sendId, jobId: sendId, kind: "outreach", template, to: `p${sendId}@x.example`, account: "owner@example.com", personId: sendId, sentAt, routine: null, routineRun: null, campaign: null, ...extra,
});

function input(extra: Partial<BoardInput> = {}): BoardInput {
  return {
    space: { id: "northwind", name: "Northwind" },
    sender: { mailbox: "Zoho Mail", address: "owner@example.com", usedToday: 0, cap: 200 },
    range: "30d",
    now: NOW,
    today: "2026-11-07",
    own: ["owner@example.com", "me@gmail.example"],
    templates: [
      { slug: "realtor", name: "Realtor outreach", kind: "marketing", versions: [{ version: 1, acceptedAt: "2026-11-01", sha: "s1" }, { version: 2, acceptedAt: "2026-11-03", sha: "s2" }] },
      { slug: "early", name: "Early access", kind: "marketing", versions: [{ version: 1, acceptedAt: "2026-11-01", sha: "e1" }] },
      { slug: "realtor-test", name: "Realtor (test copy)", kind: "transactional", versions: [{ version: 1, acceptedAt: "2026-11-01", sha: "t1" }] },
    ],
    sends: [],
    clicks: [],
    replies: [],
    routines: [],
    runsOf: () => [],
    campaigns: [],
    needs: { toAllow: 0, stopped: 0 },
    status: { unsubscribes: 0, bounces: 0 },
    audience: { people: 0, onLists: 0, stopped: 0, lists: [], segments: [] },
    sequences: [],
    ...extra,
  };
}

test("test sends never count: to the owner's own address or of a test template", () => {
  const board = buildBoard(input({
    sends: [send("realtor", "2026-11-06T10:00:00Z"), send("realtor", "2026-11-06T10:01:00Z", { to: "Me@Gmail.example" }), send("realtor-test", "2026-11-06T10:02:00Z")],
  }));
  const realtor = board.templates.find((t) => t.slug === "realtor")!;
  assert.equal(realtor.sends, 1);
  assert.equal(realtor.tests, 1);
  assert.equal(board.band.health.sent, 1);
  assert.equal(board.templates.find((t) => t.slug === "realtor-test")!.shelf, "A test copy");
});

test("a reply counts for the template of the person's last send before it, and per day", () => {
  const board = buildBoard(input({
    sends: [send("early", "2026-11-03T10:00:00Z", { personId: 7 }), send("realtor", "2026-11-05T10:00:00Z", { personId: 7 })],
    replies: [{ id: 1, personId: 7, name: "Dana", summary: "Interested", on: "2026-11-06" }, { id: 2, personId: 7, name: "Dana", summary: "Earlier", on: "2026-11-04" }],
  }));
  assert.equal(board.templates.find((t) => t.slug === "realtor")!.replies, 1);
  assert.equal(board.templates.find((t) => t.slug === "early")!.replies, 1);
  assert.equal(board.replies[0]!.template, "realtor");
  assert.equal(board.band.days.find((d) => d.day === "2026-11-06")!.replies, 1);
});

test("Coming up: a routine's runs with its first template, about the median of its last runs", () => {
  const florida = routine("rt_florida", { name: "Florida realtors", templates: ["realtor"], brief: "Find 12 prospects" });
  const sends = [
    ...Array.from({ length: 10 }, (_, i) => send("realtor", `2026-11-05T14:0${i % 10}:00Z`, { routine: "rt_florida", routineRun: "2026-11-05T14:00:00Z" })),
    ...Array.from({ length: 8 }, (_, i) => send("realtor", `2026-11-06T14:0${i}:00Z`, { routine: "rt_florida", routineRun: "2026-11-06T14:00:00Z" })),
  ];
  const board = buildBoard(input({ routines: [florida, routine("rt_report", { brief: "Write the report" })], sends, runsOf: (r) => (r.id === "rt_florida" ? ["2026-11-08T14:00:00Z", "2026-11-09T14:00:00Z"] : ["2026-11-08T10:00:00Z"]) }));
  assert.equal(board.comingUp.length, 2);
  assert.deepEqual(board.comingUp[0], { at: "2026-11-08T14:00:00Z", routine: { id: "rt_florida", name: "Florida realtors" }, template: "realtor", templateName: "Realtor outreach", version: 2, sha: "s2", about: 9 });
  const realtor = board.templates.find((t) => t.slug === "realtor")!;
  assert.equal(realtor.status, "sending");
  assert.deepEqual(realtor.routines, [{ id: "rt_florida", name: "Florida realtors", enabled: true }]);
  assert.deepEqual(realtor.senders.map((s) => [s.name, s.count]), [["Florida realtors", 18]]);
  // With no runs sent yet, the brief's number.
  assert.equal(buildBoard(input({ routines: [florida], runsOf: () => ["2026-11-08T14:00:00Z"] })).comingUp[0]!.about, 12);
});

test("a routine that sent a template it does not name is flagged; one with no field falls back to its brief", () => {
  const agents = routine("rt_agents", { name: "Agents check-in", templates: ["early"] });
  const board = buildBoard(input({ routines: [agents], sends: [send("realtor", "2026-11-06T10:00:00Z", { routine: "rt_agents" }), send("realtor", "2026-11-06T11:00:00Z")] }));
  const realtor = board.templates.find((t) => t.slug === "realtor")!;
  assert.deepEqual(realtor.mismatch, ["Agents check-in"]);
  assert.deepEqual(realtor.senders.map((s) => s.name).sort(), ["Agents check-in", "Cobra by hand"]);
  assert.deepEqual(routineTemplates({ brief: "Batch them on realtor via email_batch" }, ["realtor", "early"]), ["realtor"]);
});

test("campaigns count their linked sends and take their status from them", () => {
  const board = buildBoard(input({
    campaigns: [{ id: 3, name: "Florida agents", goal: null, audience: null, status: "planned", startsOn: "2026-11-04", endsOn: null }, { id: 4, name: "Tax season", goal: null, audience: null, status: "planned", startsOn: null, endsOn: null }],
    sends: [send("realtor", "2026-11-06T10:00:00Z", { campaign: 3 }), send("realtor", "2026-11-06T10:01:00Z", { campaign: 3, jobId: 99 })],
    clicks: [{ jobId: 99, at: "2026-11-06T12:00:00Z" }],
  }));
  assert.deepEqual(board.campaigns.map((c) => [c.name, c.status, c.sends, c.clicks, c.templates]), [["Florida agents", "running", 2, 1, ["Realtor outreach"]], ["Tax season", "planned", 0, 0, []]]);
  assert.deepEqual(board.templates.find((t) => t.slug === "realtor")!.campaign, { id: 3, name: "Florida agents" });
});

test("a job learns the routine its Foreman ran within six hours of the card, preferring one that names its template", () => {
  const ran = (at: string) => ({ due: at, at, outcome: "started" });
  const routines = [
    routine("rt_old", { lastRun: ran("2026-11-07T01:00:00Z"), templates: ["realtor"] }),
    routine("rt_named", { lastRun: ran("2026-11-07T12:00:00Z"), templates: ["realtor"], campaign: 3 }),
    routine("rt_other", { lastRun: ran("2026-11-07T13:00:00Z") }),
    routine("rt_elsewhere", { project: "rivera", lastRun: ran("2026-11-07T13:30:00Z") }),
  ];
  const approval = (template: string, extra: Record<string, unknown> = {}) => ({
    createdAt: "2026-11-07T14:00:00Z",
    action: { channel: "email-batch", project: "northwind-crm", projectName: "Northwind CRM", summary: "", batch: { template, ...extra } },
  }) as unknown as Parameters<typeof linkOf>[0];
  assert.deepEqual(linkOf(approval("realtor"), routines), { routine: "rt_named", routineRun: "2026-11-07T12:00:00Z", campaign: 3 });
  assert.deepEqual(linkOf(approval("early"), routines), { routine: "rt_other", routineRun: "2026-11-07T13:00:00Z", campaign: null });
  assert.deepEqual(linkOf(approval("early", { marketingCampaign: 5 }), routines.slice(3)), { routine: null, routineRun: null, campaign: 5 });
  assert.equal(linkOf(approval("early"), routines.slice(3)), null);
  assert.equal(linkOf(undefined, routines), null);
});

test("the queue stamps a job's link and copies it onto its send", () => {
  const dir = mkdtempSync(join(tmpdir(), "mkt-queue-"));
  try {
    const queue = new EmailQueue(join(dir, "space-x.email.db"));
    queue.linker = (approval) => (approval === "ap_1" ? { routine: "rt_florida", routineRun: "2026-11-07T14:00:00Z", campaign: 3 } : null);
    const now = new Date("2026-11-07T15:00:00Z");
    const id = queue.add({ kind: "outreach", template: "realtor", version: 1, templateSha: "s", values: {}, to: "a@x.example", dueAt: now.toISOString(), approval: "ap_1" }, now);
    queue.add({ kind: "outreach", template: "realtor", version: 1, templateSha: "s", values: {}, to: "b@x.example", dueAt: now.toISOString(), approval: "ap_2" }, now);
    const job = queue.job(id)!;
    const sent = queue.sent(job, { themeSha: "t", renderer: 1, provider: "zoho", account: "me@x.example", messageId: "<m>", providerId: "p", threadId: null, sha256: "h", subject: "Hi", sentAt: now.toISOString() });
    const row = queue.db.prepare("SELECT routine, routine_run, campaign FROM email_sends WHERE id = ?").get(sent) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { routine: "rt_florida", routine_run: "2026-11-07T14:00:00Z", campaign: 3 });
    const other = queue.db.prepare("SELECT routine, campaign FROM email_jobs WHERE to_email = 'b@x.example'").get() as Record<string, unknown>;
    assert.deepEqual({ ...other }, { routine: null, campaign: null });
    queue.close();
    // Opening it again keeps the columns (the migration runs once).
    new EmailQueue(join(dir, "space-x.email.db")).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
