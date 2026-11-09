import { describe, expect, it } from "vitest";
import * as d from "./decided.ts";

const NOW = Date.parse("2026-10-25T18:00:00");

describe("What Cobra did", () => {
  it("every computer's decisions, newest first, without trusted sends", () => {
    const rows = d.decidedRows(
      [
        ["legion", { decided: [{ id: "a", at: "2026-10-25T09:00:00", kind: "merge", title: "Merged #12 on green", body: "a/b#12 Fix", undoLabel: "Open a revert PR" }] }],
        ["mini", {
          decided: [
            { id: "b", at: "2026-10-25T10:00:00", kind: "plan", title: "Cobra started 2 Workers", body: "", undoLabel: "Stop its Workers", undone: "2026-10-25T11:00:00", undoNote: "stopped 2 of 2 Workers" },
            { id: "c", at: "2026-10-25T11:00:00", kind: "action", title: "Sent the invoice", body: "", undoLabel: null },
            { id: "d", at: "2026-10-24T11:00:00", kind: "trade", title: "Installed a trade", body: "", undoLabel: null, noUndo: "Nothing uses it yet." },
          ],
        }],
        ["mbp", "not a list"],
      ],
      NOW,
    );
    expect(rows.map((row) => [row.id, row.machine, row.undoable])).toEqual([["b", "mini", false], ["a", "legion", true], ["d", "mini", false]]);
    expect(rows[1]!.time).toBe("09:00");
    expect(d.decidedDetail(rows[0]!)).toBe("Undone: stopped 2 of 2 Workers");
    expect(d.decidedDetail(rows[1]!)).toBe("a/b#12 Fix");
    expect(d.undoQuestion(rows[1]!)).toMatch(/revert/);
  });

  it("a research receipt carries its run: how far it got, its reads newest first, and Stop only while it runs (as the phone's)", () => {
    const receipt = { id: "r", at: "2026-10-25T16:00:00", kind: "web-run", title: "Research: yoga studios", body: "", undoLabel: "Stop the research", run: "wr_1" };
    const run = (over: Record<string, unknown> = {}) => ({
      id: "wr_1", who: "foreman:lumen", goal: "yoga studios", why: "leads", askedAt: "2026-10-25T16:00:00", endsAt: "2026-10-25T18:30:00",
      reads: 3, maxReads: 60, state: "running", reason: "", by: "x",
      log: [
        { at: "2026-10-25T16:01:00", tool: "WebSearch", subject: "yoga studio grand cayman", verdict: "on", reason: "on goal" },
        { at: "2026-10-25T16:02:00", tool: "WebFetch", subject: "https://caymanyogaclub.com/contact/", verdict: "on", reason: "on goal" },
        { at: "2026-10-25T16:03:00", tool: "WebFetch", subject: "https://www.facebook.com/profile.php?id=1", verdict: "ask", reason: "a person's own social profile" },
      ],
      ...over,
    });
    const [live] = d.decidedRows([["legion", { decided: [receipt] }, { runs: [run()] }]], NOW);
    expect(live!.undoable).toBe(true);
    expect(live!.research!.line).toBe("3 of 60 reads · until 18:30");
    expect(live!.research!.reads.map((read) => [read.word, read.subject, read.tone])).toEqual([
      ["Asked you", "www.facebook.com/profile.php?id=1", "warn"],
      ["Read", "caymanyogaclub.com/contact", "ok"],
      ["Searched", '"yoga studio grand cayman"', "ok"],
    ]);
    const [over] = d.decidedRows([["legion", { decided: [receipt] }, { runs: [run({ endsAt: "2026-10-25T17:00:00" })] }]], NOW);
    expect(over!.undoable).toBe(false);
    expect(over!.research!.line).toBe("Ended · 3 of 60 reads");
    expect(d.decidedRows([["legion", { decided: [receipt] }, { runs: [run({ state: "stopped", stoppedBy: "new-run" })] }]], NOW)[0]!.research!.line).toBe("Stopped for a newer run · 3 of 60 reads");
    const [plain] = d.decidedRows([["legion", { decided: [receipt] }, null]], NOW);
    expect(plain!.research).toBeUndefined();
    expect(plain!.undoable).toBe(true);
    expect(d.undoQuestion(plain!)).toMatch(/ask again/);
    expect(d.researchOf(run({ state: "refused", reason: "not for this work" }), NOW).line).toBe("Not started: not for this work");
    // A page found not to be what its address claims (agent webClaims.ts): said so, with why.
    const found = d.researchOf(run({ log: [{ at: "2026-10-25T15:20:00", tool: "WebFetch", subject: "https://nwccpilatesyoga.net/", verdict: "on", reason: "a studio's own site", claim: "nwccpilatesyoga.net shows a betting or gambling page, not the business its address names" }] }), NOW);
    expect(found.reads).toEqual([{ word: "Not what it claims", subject: "nwccpilatesyoga.net", why: "nwccpilatesyoga.net shows a betting or gambling page, not the business its address names", tone: "warn" }]);
  });

  it("the caps line adds the computers up", () => {
    expect(d.capsLine([{ decided: [] }])).toBeNull();
    expect(d.capsLine([
      { decided: [], caps: { merge: { used: 2, cap: 10 }, cards: { used: 1, cap: 25 } } },
      { decided: [], caps: { merge: { used: 1, cap: 10 } } },
    ])).toBe("Daily caps, per computer: 3 of 10 merges · 1 of 25 cards in the last day");
  });

  it("Pause turns every Instinct level to Balanced and nothing else", () => {
    const policy = {
      version: 1,
      revision: 9,
      preset: "auto",
      computers: { legion: { preset: "instinct" }, mini: { preset: "locked" } },
      projects: { "a/b": { preset: "instinct", foreman: { mergeOnGreen: true } } },
    };
    expect(d.instinctAnywhere(policy)).toBe(true);
    const paused = d.pausedPolicy(policy);
    expect(paused).toEqual({
      version: 1,
      revision: 9,
      preset: "auto",
      computers: { legion: { preset: "balanced" }, mini: { preset: "locked" } },
      projects: { "a/b": { preset: "balanced", foreman: { mergeOnGreen: true } } },
    });
    expect(d.instinctAnywhere(paused)).toBe(false);
    expect(d.pausedPolicy({ version: 1, revision: 1, preset: "instinct" }).preset).toBe("balanced");
    expect(d.instinctAnywhere(null)).toBe(false);
  });
});
