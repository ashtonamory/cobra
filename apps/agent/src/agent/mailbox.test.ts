import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { ApprovalAction } from "@cobra/contracts";

const ROOT = mkdtempSync(join(tmpdir(), "cobra-mailbox-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { ReadRequestError } = await import("./calendar.ts");
const { actionFingerprint, actionNews, actionText, mailboxToday, parseMailboxAction, runAction } = await import("./actions.ts");
const { actionKey } = await import("./actionTrust.ts");
const { MailboxOffError, MAILBOX_DAILY } = await import("./gmailOrganize.ts");
const { GoogleAuthError } = await import("./googleAuth.ts");
const { makeApproval } = await import("./approvals.ts");
const { tradeOrganizes, tradeReads } = await import("./trades.ts");
const foreman = await import("./foreman.ts");

type Batch = NonNullable<ApprovalAction["mailbox"]>;
type MailboxRequest = Parameters<Parameters<typeof parseMailboxAction>[2]>[0];

const project = { id: "tidy", name: "Tidy" };
const ID = (n: number) => `18c2f0a1b2c3d${String(n).padStart(3, "0")}`;

function batch(extra: Partial<Batch> = {}): Batch {
  return {
    op: "archive",
    query: "from:news@substack.com older_than:30d",
    ids: [ID(1), ID(2), ID(3)],
    matched: 5,
    skipped: { alreadyDone: 1, starred: 0, missing: 1 },
    more: false,
    senders: [{ from: "Substack <news@substack.com>", count: 3 }],
    samples: [{ from: "Substack <news@substack.com>", subject: "Issue 41" }],
    ...extra,
  };
}

const resolving = (made: Batch, seen: Array<{ request: MailboxRequest; remaining: number }> = []) => async (request: MailboxRequest, remaining: number) => {
  seen.push({ request, remaining });
  return made;
};

// --- the proposal --------------------------------------------------------------------

test("parseMailboxAction: the resolved batch is frozen on the action, the card is counted by code, and only a summary and an op come from the Foreman", async () => {
  const seen: Array<{ request: MailboxRequest; remaining: number }> = [];
  const action = await parseMailboxAction({ channel: "mailbox", summary: "Archive old Substack issues", op: "archive", query: "from:news@substack.com older_than:30d" }, project, resolving(batch(), seen), 900);
  assert.deepEqual(seen, [{ request: { op: "archive", query: "from:news@substack.com older_than:30d" }, remaining: 900 }]);
  assert.equal(action.channel, "mailbox");
  assert.deepEqual([action.project, action.projectName, action.summary], ["tidy", "Tidy", "Archive old Substack issues"]);
  assert.deepEqual(action.mailbox, batch());
  assert.equal(action.email, undefined);

  const { title, body } = actionText(action);
  assert.equal(title, "Mail: Archive old Substack issues");
  assert.match(body, /^Archive 3 messages: out of the inbox, still in All Mail\n/);
  assert.match(body, /Search: from:news@substack\.com older_than:30d/);
  assert.match(body, /5 found, 1 already as asked, 1 gone since\./);
  assert.match(body, /From:\n {2}3 × Substack <news@substack\.com>/);
  assert.match(body, /For example:\n {2}• Substack <news@substack\.com>: Issue 41/);
  assert.match(body, /Allow does this to exactly these 3 messages and no others\. Nothing is deleted for good\.$/);
});

test("the card says when a search had more than it holds, and when starred mail was left out of a trash", async () => {
  const more = await parseMailboxAction({ summary: "Trash promos", op: "trash", query: "category:promotions" }, project, resolving(batch({ op: "trash", more: true, matched: 200, ids: Array.from({ length: 200 }, (_, i) => ID(i)), skipped: { alreadyDone: 0, starred: 2, missing: 0 } })), 1000);
  const { body } = actionText(more);
  assert.match(body, /Move 200 messages to the trash: Gmail keeps them 30 days, and nothing is deleted for good/);
  assert.match(body, /2 starred, which a batch never trashes/);
  assert.match(body, /More than 200 match: this card holds the newest 200\. The rest need another card\./);
});

test("two proposals of one batch are one question; another batch with the same summary is another", async () => {
  const a = await parseMailboxAction({ summary: "Tidy", op: "archive", query: "a" }, project, resolving(batch()), 1000);
  const same = await parseMailboxAction({ summary: "Tidy", op: "archive", query: "a" }, project, resolving(batch()), 1000);
  const other = await parseMailboxAction({ summary: "Tidy", op: "archive", query: "a" }, project, resolving(batch({ ids: [ID(1), ID(2)] })), 1000);
  assert.equal(actionFingerprint(a), actionFingerprint(same));
  assert.notEqual(actionFingerprint(a), actionFingerprint(other));
});

test("parseMailboxAction refuses an email in disguise, a bad request and a search that finds nothing, each as one thing to change", async () => {
  const never = async (): Promise<Batch> => assert.fail("nothing is asked of Gmail for a request that is wrong");
  for (const key of ["to", "cc", "subject", "text", "folder", "attachments"]) {
    await assert.rejects(parseMailboxAction({ summary: "Tidy", op: "archive", query: "a", [key]: "x" }, project, never, 1000), (caught: unknown) => caught instanceof Error && (caught as { status?: number }).status === 400 && new RegExp(`no ${key}`).test(caught.message));
  }
  await assert.rejects(parseMailboxAction({ op: "archive", query: "a" }, project, never, 1000), /summary is required/);
  await assert.rejects(parseMailboxAction({ summary: "x", op: "archive", query: "a" }, project, never, 1000), /summary needs at least 3/);
  await assert.rejects(parseMailboxAction({ summary: "Tidy", op: "delete", query: "a" }, project, never, 1000), (caught: unknown) => (caught as { status?: number }).status === 400 && /op is one of/.test((caught as Error).message));
  await assert.rejects(
    parseMailboxAction({ summary: "Tidy", op: "archive", query: "zzz" }, project, async () => { throw new ReadRequestError("no message matches that"); }, 1000),
    (caught: unknown) => (caught as { status?: number }).status === 400 && /no message matches that/.test((caught as Error).message),
  );
});

test("the connection's own problems pass through as they are, for the route to answer with the step the person takes", async () => {
  await assert.rejects(parseMailboxAction({ summary: "Tidy", op: "archive", query: "a" }, project, async () => { throw new MailboxOffError(); }, 1000), MailboxOffError);
  await assert.rejects(parseMailboxAction({ summary: "Tidy", op: "archive", query: "a" }, project, async () => { throw new GoogleAuthError("google_not_connected"); }, 1000), (caught: unknown) => caught instanceof GoogleAuthError && caught.problem === "google_not_connected");
  await assert.rejects(parseMailboxAction({ summary: "Tidy", op: "archive", query: "a" }, project, async () => { throw new Error("Gmail had a problem on Google's side"); }, 1000), /problem on Google's side/);
});

// --- the day's limit -----------------------------------------------------------------

test("mailboxToday counts the messages of cards that are waiting, allowed or done in the last day, and nothing else", () => {
  const now = Date.UTC(2026, 9, 26, 12, 0, 0);
  const card = (state: string, ids: number, hoursAgo: number, kind = "action") => ({
    kind: kind as "action",
    state: state as "pending",
    createdAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
    action: { channel: "mailbox", project: "tidy", projectName: "Tidy", summary: "x", mailbox: batch({ ids: Array.from({ length: ids }, (_, i) => ID(i)) }) } as ApprovalAction,
  });
  assert.equal(mailboxToday([card("pending", 10, 1), card("allowed", 20, 2), card("done", 30, 23)], now), 60);
  assert.equal(mailboxToday([card("denied", 10, 1), card("failed", 10, 1), card("expired", 10, 1), card("done", 10, 25)], now), 0, "refused, failed, lapsed and older than a day do not count");
  assert.equal(mailboxToday([{ kind: "action", state: "done", createdAt: new Date(now).toISOString(), action: { channel: "note", project: "p", projectName: "P", summary: "x" } }], now), 0);
  assert.ok(MAILBOX_DAILY >= 200, "a day holds more than one card");
});

// --- trust ---------------------------------------------------------------------------

test("a mailbox action is never trusted, however many times it was allowed", async () => {
  const action = await parseMailboxAction({ summary: "Tidy", op: "archive", query: "a" }, project, resolving(batch()), 1000);
  const keyed = actionKey(action, {});
  assert.equal(keyed.trustable, false);
  assert.match(keyed.trustable ? "" : keyed.why, /channel mailbox is never trusted/);
});

// --- Allow ---------------------------------------------------------------------------

function deps(organizeMail: (b: Batch) => Promise<{ changed: number; failed: number; failure?: string; createdLabel?: string }>) {
  return { organizeMail } as unknown as Parameters<typeof runAction>[0];
}

async function approvalFor(made: Batch) {
  const action = await parseMailboxAction({ summary: "Tidy", op: made.op, query: made.query ?? "a", ...(made.label ? { label: made.label } : {}) }, project, resolving(made), 1000);
  return { ...makeApproval({ kind: "action", ...actionText(action), requestedBy: "foreman_tidy", action }, Date.now()), state: "allowed" as const };
}

test("runAction applies the frozen batch exactly, and says how to put it back", async () => {
  const applied: Batch[] = [];
  const approval = await approvalFor(batch());
  const done = await runAction(deps(async (b) => (applied.push(b), { changed: b.ids.length, failed: 0 })), approval);
  assert.deepEqual(applied, [batch()], "the very ids the card showed");
  assert.equal(done.state, "done");
  assert.equal(done.results?.[0]?.message, "archived 3 messages");
  assert.match(done.results?.[1]?.message ?? "", /to put it back, propose op unarchive on the same messages \(the search "from:news@substack\.com older_than:30d"\)/);
  assert.match(actionNews(done), /The person allowed "Mail: Tidy": archived 3 messages; to put it back/);
});

test("a trash tells the Foreman to search the trash to undo it, and a new label is said", async () => {
  const trash = await approvalFor(batch({ op: "trash", query: "from:news@substack.com" }));
  const done = await runAction(deps(async (b) => ({ changed: b.ids.length, failed: 0 })), trash);
  assert.match(done.results?.[0]?.message ?? "", /moved 3 messages to the trash \(Gmail keeps them 30 days\)/);
  assert.match(done.results?.[1]?.message ?? "", /propose op untrash on the same messages \(the search "from:news@substack\.com" with in:trash\)/);

  const label = await approvalFor(batch({ op: "label", label: "Receipts", newLabel: true }));
  const made = await runAction(deps(async (b) => ({ changed: b.ids.length, failed: 0, createdLabel: "Receipts" })), label);
  assert.equal(made.results?.[0]?.message, 'labelled 3 messages "Receipts" and created the label "Receipts"');
});

test("a batch Gmail only partly took is failed with the counts and Google's words, so it is not taken for done", async () => {
  const approval = await approvalFor(batch({ op: "trash" }));
  const done = await runAction(deps(async () => ({ changed: 2, failed: 1, failure: "Gmail had a problem on Google's side; the next try may work (Google said: 500)" })), approval);
  assert.equal(done.state, "failed");
  assert.match(done.results?.[0]?.message ?? "", /moved 2 messages to the trash.*but Gmail refused 1 of 3: Gmail had a problem/);
  assert.equal(done.results?.[0]?.ok, false);
  assert.match(actionNews(done), /allowed .* but it was not carried out/);
});

test("Organize mail off or Google not connected fails the approval with the words that say what to do; any other error says nothing changed", async () => {
  const approval = await approvalFor(batch());
  const off = await runAction(deps(async () => { throw new MailboxOffError(); }), approval);
  assert.equal(off.state, "failed");
  assert.match(off.results?.[0]?.message ?? "", /does not carry Organize mail/);
  const gone = await runAction(deps(async () => { throw new GoogleAuthError("google_not_connected"); }), approval);
  assert.match(gone.results?.[0]?.message ?? "", /Google is not connected/);
  const broken = await runAction(deps(async () => { throw new Error("Gmail could not be reached: no answer in 30 s"); }), approval);
  assert.equal(broken.results?.[0]?.message, "nothing was changed in the mailbox: Gmail could not be reached: no answer in 30 s");
});

test("a denied mailbox card tells the Foreman not to run it again as it was", async () => {
  const approval = { ...(await approvalFor(batch())), state: "denied" as const };
  assert.match(actionNews(approval), /The person denied "Mail: Tidy"\. Do not run it again as it was; ask them what to change, or move on\./);
});

// --- trades --------------------------------------------------------------------------

test("My day and Inbox organize mail; no other trade does; Inbox reads mail", () => {
  assert.equal(tradeOrganizes("my-day"), true);
  assert.equal(tradeOrganizes("inbox"), true);
  for (const trade of ["sign-ups", "lead-outreach", "projects", "billing", "payroll-manager", "website-builder", "made-up", undefined]) assert.equal(tradeOrganizes(trade), false, String(trade));
  assert.deepEqual(tradeReads("inbox"), ["mail"]);
});

test("the Foreman of an organizing trade is told mail_organize is the one exception and what the person sees; others are not", () => {
  const base = { id: "tidy", name: "Tidy", machine: "m", path: "/p/tidy", session: "tidy" };
  for (const template of ["inbox", "my-day"]) {
    const prompt = foreman.foremanPrompt({ ...base, foremanTemplate: template });
    assert.ok(prompt.includes(foreman.ORGANIZE_NOTE), template);
  }
  assert.match(foreman.ORGANIZE_NOTE, /the person sees the count, who they are from and examples, and allows each batch once/);
  assert.match(foreman.ORGANIZE_NOTE, /Nothing is deleted for good .*starred mail is never trashed/);
  for (const template of ["sign-ups", "lead-outreach", undefined]) {
    const prompt = foreman.foremanPrompt({ ...base, ...(template ? { foremanTemplate: template } : {}) });
    assert.equal(prompt.includes("mail_organize"), false, String(template));
  }
  const inbox = foreman.foremanPrompt({ ...base, foremanTemplate: "inbox" });
  assert.match(inbox, /Your trade is Inbox/);
  assert.match(inbox, /Never trash on a guess/);
  assert.match(inbox, /never unsubscribe from anything/);
});

// --- through the route ---------------------------------------------------------------

type Caller = { id: string; kind: string; name: string; remote?: boolean; project?: string };
const caller = (project: string): Caller => ({ id: `foreman_${project}`.padEnd(16, "_"), kind: "lead", name: `Foreman for ${project}`, project });
const LEAD: Caller = { id: "lead_legion_____", kind: "lead", name: "Lead on legion" };

async function routes(resolve?: (request: MailboxRequest, remaining: number) => Promise<Batch>) {
  const { handleOrch } = await import("./orch.ts");
  mkdirSync(join(ROOT, "config"), { recursive: true });
  const configPath = join(ROOT, "config", "projects.json");
  const entry = (id: string, foremanTemplate?: string) => ({ id, name: id, machine: hostname(), path: `/nowhere/${id}`, session: id, ...(foremanTemplate ? { foremanTemplate } : {}) });
  writeFileSync(configPath, JSON.stringify({ projects: [entry("tidy", "inbox"), entry("day", "my-day"), entry("signups", "sign-ups"), entry("plain")] }));
  const notified: string[] = [];
  const asked: Array<{ request: MailboxRequest; remaining: number }> = [];
  const call = async (body: Record<string, unknown>, who: Caller) => {
    let reply: { status: number; body: unknown } = { status: 0, body: null };
    await handleOrch("/orch/action/propose", new URL("http://agent.invalid/orch/action/propose"), { method: "POST", on: () => undefined } as never, {} as never, {
      send: (_response: unknown, status: number, sent: unknown) => void (reply = { status, body: sent }),
      readBody: async () => JSON.stringify(body),
      configPath,
      log: () => undefined,
      caller: who,
      notify: async (approval: { title: string }) => void notified.push(approval.title),
      machineLabel: "legion",
      port: 8797,
      mailbox: async (request: MailboxRequest, remaining: number) => {
        asked.push({ request, remaining });
        return resolve ? resolve(request, remaining) : batch();
      },
    } as never);
    return reply;
  };
  return { call, notified, asked };
}

type Proposed = { approval: { id: string; kind: string; title: string; body: string; state: string; action?: ApprovalAction } };
const propose = { channel: "mailbox", summary: "Archive old Substack issues", op: "archive", query: "from:news@substack.com older_than:30d" };

test("through the route: an Inbox Foreman proposes a mailbox batch; it is one card with the frozen ids, and the same batch twice waits once", async () => {
  const { call, notified, asked } = await routes();
  const { loadApprovals } = await import("./approvals.ts");
  const reply = await call(propose, caller("tidy"));
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  const { approval } = reply.body as Proposed;
  assert.equal(approval.kind, "action");
  assert.equal(approval.title, "Mail: Archive old Substack issues");
  assert.match(approval.body, /^Archive 3 messages/);
  assert.equal(approval.state, "pending");
  assert.deepEqual(approval.action?.mailbox?.ids, [ID(1), ID(2), ID(3)]);
  assert.equal("requestedBy" in approval, false);
  assert.deepEqual(notified, ["Mail: Archive old Substack issues"]);
  assert.equal(loadApprovals().find((a) => a.id === approval.id)?.requestedBy, caller("tidy").id);
  assert.deepEqual(asked[0], { request: { op: "archive", query: "from:news@substack.com older_than:30d" }, remaining: MAILBOX_DAILY });

  assert.equal((await call(propose, caller("tidy"))).status, 409, "the same card is one question");
  // The cards already waiting count against the day: the next search is told what is left.
  await call({ ...propose, summary: "Another" }, caller("tidy"));
  assert.equal(asked.at(-1)?.remaining, MAILBOX_DAILY - 3);
});

test("through the route: My day may organize; Sign-ups and a project with no trade may not, and nothing is asked of Gmail for them", async () => {
  const { call, asked } = await routes();
  assert.equal((await call(propose, caller("day"))).status, 202);
  const before = asked.length;
  for (const who of ["signups", "plain"]) {
    const reply = await call(propose, caller(who));
    assert.equal(reply.status, 403, who);
    assert.match(JSON.stringify(reply.body), /does not organize the person's mail/);
  }
  assert.equal(asked.length, before);
});

test("through the route: the Lead cannot propose; a changed email field is a 400; a search that finds nothing is a 400 that says so", async () => {
  const lead = await routes();
  const refused = await lead.call(propose, LEAD);
  assert.equal(refused.status, 403);
  assert.match(JSON.stringify(refused.body), /brief the project's Foreman/);

  const { call } = await routes(async () => {
    throw new ReadRequestError("no message matches that");
  });
  const none = await call(propose, caller("tidy"));
  assert.equal(none.status, 400);
  assert.match(JSON.stringify(none.body), /no message matches that/);
  const disguised = await call({ ...propose, to: ["ana@example.com"] }, caller("tidy"));
  assert.equal(disguised.status, 400);
  assert.match(JSON.stringify(disguised.body), /a mailbox action has no to/);
});

test("through the route: Organize mail off is a 409 whose words are the step the person takes", async () => {
  const { call } = await routes(async () => {
    throw new MailboxOffError();
  });
  let status = 0;
  let text = "";
  try {
    const reply = await call(propose, caller("tidy"));
    status = reply.status;
    text = JSON.stringify(reply.body);
  } catch (caught) {
    // The agent's top level answers a SessionError with its status and message.
    status = (caught as { status: number }).status;
    text = (caught as Error).message;
  }
  assert.equal(status, 409);
  assert.match(text, /does not carry Organize mail/);
});

test("a batch in a Space's own mailbox: the card names the box and its folders, and the undo is a search where the messages are now", async () => {
  const box = { id: "box_8ceaaa14cca8", address: "owner@example.com", mailbox: "Zoho Mail" };
  const ids = ["b1700-11-0a1b2c3d", "b1700-12-0a1b2c3d", "b1700-13-0a1b2c3d"];
  const trash = await approvalFor(batch({ op: "trash", query: "from:news@list.example", ids, box }));
  assert.match(trash.body, /^Move 3 messages to the Trash folder; nothing is deleted for good\nMailbox: owner@example\.com \(Zoho Mail\)\nSearch: from:news@list\.example/);
  const applied: Batch[] = [];
  const done = await runAction(deps(async (b) => (applied.push(b), { changed: b.ids.length, failed: 0 })), trash);
  assert.deepEqual(applied[0]?.box, box, "Allow carries the box the card named");
  assert.equal(done.results?.[0]?.message, "moved 3 messages to the Trash folder");
  assert.match(done.results?.[1]?.message ?? "", /propose op untrash on a search in the folder they are in now \(in:trash plus the words of "from:news@list\.example"\); moved messages have new ids there/);

  const label = await approvalFor(batch({ op: "label", label: "Quotes", newLabel: true, ids, box }));
  assert.match(label.body, /^Move 3 messages into the folder "Quotes" \(a new folder Allow creates\)/);
  const made = await runAction(deps(async (b) => ({ changed: b.ids.length, failed: 1, failure: "moved or deleted since the card", createdLabel: "Quotes" })), label);
  assert.equal(made.state, "failed");
  assert.match(made.results?.[0]?.message ?? "", /and created the folder "Quotes", but owner@example\.com refused 1 of 3: moved or deleted since the card/);
});
