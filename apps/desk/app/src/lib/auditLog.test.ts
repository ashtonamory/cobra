import { describe, expect, it } from "vitest";
import { failureLine, more, rows, timeOf, wordOf } from "./auditLog.ts";

const NOW = Date.parse("2026-11-08T12:00:00");

describe("the audit log's rows", () => {
  it("keeps the agent's words, the time, where and a word for the kind; drops what it cannot read", () => {
    const reply = {
      entries: [
        { id: "a".repeat(16), at: Date.parse("2026-11-08T10:05:00"), kind: "merge", actor: "agent", outcome: "ok", subject: { target: "me/r#7" }, text: "Cobra merged me/r#7" },
        { id: "b".repeat(16), at: Date.parse("2026-11-07T09:00:00"), kind: "email.sent", outcome: "failed", subject: { project: "paws", card: "ap_1" }, text: "Cobra sent an email (failed)" },
        { id: "c".repeat(16), at: NOW, kind: "policy", outcome: "allow", text: "Worker x was allowed Edit" },
        { id: 3, text: "bad" },
        "nonsense",
      ],
      more: true,
    };
    const got = rows(reply, NOW);
    expect(got.map((r) => [r.time, r.text, r.where, r.word, r.tone])).toEqual([
      ["10:05", "Cobra merged me/r#7", null, "merge", "muted"],
      ["2026-11-07 09:00", "Cobra sent an email (failed)", "paws · ap_1", "failed", "ink"],
      ["12:00", "Worker x was allowed Edit", null, "tool", "dim"],
    ]);
    expect(more(reply)).toBe(true);
    expect(rows(null)).toEqual([]);
    expect(more({})).toBe(false);
  });

  it("words: kinds, times and why there is no log", () => {
    expect(wordOf("approval.allowed", "ok")).toBe("card");
    expect(wordOf("vault.unlock", "refused")).toBe("refused");
    expect(timeOf(NOW, NOW)).toBe("12:00");
    expect(failureLine(404, "", "mini")).toMatch(/older than the audit log/);
    expect(failureLine(403, "", "mini")).toMatch(/its own desk only/);
    expect(failureLine(0, "timeout", "mini")).toBe("mini did not answer: timeout");
  });
});
