import { describe, expect, it } from "vitest";
import { allowLine } from "./approvalAction.ts";
import * as trust from "./trust.ts";

// Local times throughout, so the words do not depend on the zone the test runs in.
const local = (month: number, day: number, hour: number, minute = 0, year = 2026) => new Date(year, month - 1, day, hour, minute);
const NOW = local(11, 27, 12).getTime(); // Friday 27 November 2026, 12:00
const at = (month: number, day: number, hour: number, minute = 0) => local(month, day, hour, minute).toISOString();

const subject = {
  key: "k".repeat(64), project: "payroll", projectName: "Pete's Payroll", channel: "email", what: "pay-stub",
  to: ["ana@example.com", "ben@example.com"], templates: ["pay-stub"],
};

const card = (extra: Record<string, unknown> = {}) => ({
  id: "ap-trust", machine: "laptop", kind: "trust", state: "pending",
  title: "Let Pete's Payroll send pay-stub to these 2 addresses without asking?", body: "You allowed this 3 times in a row…",
  trust: { ...subject, runs: 3, examples: ["Send: run 1", "Send: run 2", "Send: run 3"], ...extra },
});

const receipt = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id, machine: "laptop", kind: "action", state: "done", title: "Send: 2 pay stubs", body: "", createdAt,
  results: [{ ok: true, message: "sent to 2 addresses from pete@example.com" }],
  action: { channel: "email", project: "payroll", projectName: "Pete's Payroll", summary: "2 pay stubs" },
  trusted: { key: subject.key, grantedAt: at(11, 13, 9) },
  ...extra,
});

describe("the trust card", () => {
  it("says who, the templates, the project, how often, and the cards it was, with Trust and Keep asking", () => {
    const v = trust.trustApprovalView(card())!;
    expect(v.channel).toBe("trust");
    expect(v.word).toBe("TRUST");
    expect(v.summary).toBe("send pay-stub");
    expect(v.fields).toEqual([
      ["To", "ana@example.com, ben@example.com"],
      ["Templates", "pay-stub"],
      ["Project", "Pete's Payroll"],
      ["You allowed", "3 times in a row"],
    ]);
    expect(v.text).toBe("• Send: run 1\n• Send: run 2\n• Send: run 3");
    expect(v.yes).toBe("Trust");
    expect(v.no).toBe("Keep asking");
    expect(allowLine(v)).toMatch(/^Trust lets Cobra do these with no card; each one lands as a receipt under Landed\./);
    expect(allowLine(v)).not.toMatch(/Claude/);
  });

  it("a note reaches nobody, and a message with no template says so", () => {
    const v = trust.trustApprovalView(card({ channel: "note", what: "notes", to: [], templates: [] }))!;
    expect(v.summary).toBe("leave notes");
    expect(v.fields[0]).toEqual(["Templates", "None: the text is the Foreman's each time"]);
    expect(trust.trustApprovalView(card({ channel: "file", what: "invoice", to: ["your Google Drive (Cobra/Pete's Payroll)"] }))!.summary).toBe("save invoice");
  });

  it("is no card for anything else", () => {
    expect(trust.trustApprovalView({ kind: "action", action: {} })).toBeNull();
    expect(trust.trustApprovalView({ kind: "trust", trust: { what: "x" } })).toBeNull();
    expect(trust.trustApprovalView(null)).toBeNull();
    expect(trust.runsWords(undefined)).toBe("Several times in a row");
    expect(trust.runsWords(1)).toBe("Once");
  });
});

describe("receipts", () => {
  it("a receipt row: the time, what, the project and what happened", () => {
    const v = trust.receiptView(receipt("ap1", at(11, 27, 9, 2)), NOW);
    expect(v).toEqual({
      id: "ap1", time: "09:02", title: "Send: 2 pay stubs", word: "SENT", tone: "dim",
      detail: "Pete's Payroll · sent to 2 addresses from pete@example.com", failed: false, project: "payroll",
    });
    expect(trust.receiptView(receipt("ap2", at(11, 27, 9), { state: "failed", results: [{ ok: false, message: "Google is not connected" }] }), NOW))
      .toMatchObject({ word: "FAILED", tone: "signal", failed: true, detail: "Pete's Payroll · Google is not connected" });
    expect(trust.receiptView(receipt("ap3", at(11, 27, 9), { state: "allowed", results: undefined }), NOW))
      .toMatchObject({ word: "RUNNING", detail: "Pete's Payroll · Cobra is doing it now" });
    expect(trust.receiptView(receipt("ap4", at(11, 25, 9), { action: { channel: "file", project: "payroll" } }), NOW))
      .toMatchObject({ word: "SAVED", time: "Wed 25 Nov at 09:00" });
  });

  it("Landed: today's receipts on every computer, newest first, nothing else", () => {
    const lists = [
      ["laptop", { receipts: [receipt("a", at(11, 27, 9)), receipt("old", at(11, 26, 9)), { id: "asked", kind: "action", createdAt: at(11, 27, 10) }] }],
      ["office", { receipts: [receipt("b", at(11, 27, 11))] }],
      ["mbp", null],
    ] as const;
    expect(trust.landedToday(lists, NOW).map((x) => [x.machine, x.approval.id])).toEqual([["office", "b"], ["laptop", "a"]]);
  });

  it("Next: the soonest routine that runs, on any computer", () => {
    const lists = [
      ["laptop", { routines: [
        { id: "r1", name: "Fortnightly payroll", projectName: "Pete's Payroll", project: "payroll", enabled: true, nextRun: at(12, 11, 9) },
        { id: "r2", name: "Paused", enabled: false, nextRun: at(11, 28, 9) },
      ] }],
      ["office", { routines: [{ id: "r3", name: "Month-end summary", projectName: "Billing", project: "billing", enabled: true, nextRun: at(11, 30, 17) }] }],
    ] as const;
    const next = trust.nextRoutine(lists, NOW)!;
    expect(next.machine).toBe("office");
    expect(next.line).toBe("Next: Month-end summary · Billing · Mon 30 Nov at 17:00");
    expect(trust.nextRoutine([["laptop", { routines: [] }]], NOW)).toBeNull();
  });
});

describe("the project page", () => {
  const list = {
    grants: [{ ...subject, grantedAt: at(11, 13, 9, 30), runsSince: 2, lastUsed: at(11, 27, 9) }, { ...subject, key: "other", project: "billing" }],
    always: [{ ...subject, key: "a".repeat(64), what: "a message", templates: [], at: at(11, 20, 10) }],
    receipts: [receipt("ap1", at(11, 27, 9)), receipt("ap9", at(11, 27, 9), { action: { channel: "email", project: "billing" } })],
  };

  it("picks this project's grants, keys that keep asking and receipts", () => {
    const t = trust.trustFor(list, "payroll");
    expect(t.grants.map((g) => g.runsSince)).toEqual([2]);
    expect(t.always.length).toBe(1);
    expect(t.receipts.map((a) => a.id)).toEqual(["ap1"]);
    expect(trust.showsTrust(t)).toBe(true);
    expect(trust.showsTrust(trust.trustFor({}, "payroll"))).toBe(false);
    expect(trust.showsTrust(null)).toBe(false);
  });

  it("a grant row and a keeps-asking row", () => {
    const t = trust.trustFor(list, "payroll");
    expect(trust.grantView(t.grants[0], NOW)).toEqual({
      key: subject.key,
      title: "Send pay-stub",
      detail: "To ana@example.com, ben@example.com · from pay-stub",
      since: "Trusted since Fri 13 Nov at 09:30 · 2 runs since · last today at 09:00",
    });
    expect(trust.askView(t.always[0], NOW)).toEqual({
      key: "a".repeat(64),
      title: "Send a message",
      detail: "To ana@example.com, ben@example.com",
      since: "Keeps asking since Fri 20 Nov at 10:00",
    });
  });

  it("the toasts and the notes", () => {
    expect(trust.doneWords("revoke", "Send pay-stub")).toBe("Send pay-stub: asks again from now on");
    expect(trust.doneWords("clear", "Send a message")).toBe("Send a message: Cobra may offer trust again");
    expect(trust.NOTE).toMatch(/^Revoke takes trust back/);
  });
});

describe("taintNote", () => {
  it("says why a card from a turn that read text from outside asks, and nothing on any other card", () => {
    const note = "Cobra read an email from outside in this conversation, so it asks you before this goes out.";
    expect(trust.taintNote({ id: "ap_1", taint: { read: ["an email from outside"], note } })).toBe(note);
    expect(trust.taintNote({ id: "ap_2" })).toBeNull();
    expect(trust.taintNote({ id: "ap_3", taint: { read: [], note: "  " } })).toBeNull();
    expect(trust.taintNote(null)).toBeNull();
  });
});
