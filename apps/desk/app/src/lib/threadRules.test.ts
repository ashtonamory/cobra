import { describe, expect, it } from "vitest";
import * as model from "./model.ts";
import { historyOf, cobraNote, markerLabel, mergeThread, parseThreadPage, threadRows, type ThreadEntry } from "./threadRules.ts";

const at = (d: number, h: number, min = 0) => new Date(2026, 9, d, h, min).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
let next = 0;
const entry = (conversation: string, kind: string, ms: number, text = "", extra: Partial<ThreadEntry> = {}): ThreadEntry =>
  ({ id: ++next, at: iso(ms), kind, conversation, text, ...extra });

describe("Cobra's thread", () => {
  it("a page is read loosely: entries that cannot be drawn are dropped, a bad page is null", () => {
    const page = parseThreadPage({
      entries: [{ id: 3, at: "2026-10-26T10:00:00Z", kind: "you", conversation: "c", text: "hi" }, { id: 0, at: "x" }, "no", { id: 4, at: "t", kind: "cobra", conversation: "c" }],
      current: "c", more: true,
    });
    expect(page?.entries.map((e) => [e.id, e.text])).toEqual([[3, "hi"], [4, ""]]);
    expect([page?.current, page?.more]).toEqual(["c", true]);
    expect(parseThreadPage({ entries: [], current: null })).toEqual({ entries: [], current: null, more: false });
    expect(parseThreadPage({ error: "not-hub" })).toBeNull();
    expect(parseThreadPage(null)).toBeNull();
  });

  it("pages merge by id, oldest first, each once", () => {
    const a = entry("s", "you", at(26, 9), "one");
    const b = entry("s", "cobra", at(26, 9, 1), "two");
    const c = entry("s", "you", at(26, 9, 2), "three");
    expect(mergeThread([b, c], [a, b]).map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });

  it("a conversation's line says how it began and when", () => {
    const now = at(26, 12);
    expect(markerLabel("new-conversation", at(26, 3, 12), now)).toBe("New conversation · Today 3:12 AM");
    expect(markerLabel("start", at(25, 18, 5), now)).toBe("Cobra started · Yesterday 6:05 PM");
    expect(markerLabel("idle", at(26, 9), now)).toBe("Fresh start · Today 9:00 AM");
    expect(markerLabel("something-newer", at(26, 9), now)).toBe("New conversation · Today 9:00 AM");
  });

  it("earlier conversations are drawn faded, the current one only by its line, which comes before its first words", () => {
    const now = at(26, 12);
    const entries = [
      entry("old", "session", at(25, 18), "", { reason: "start" }),
      entry("old", "you", at(25, 17, 59), "What landed overnight?"),
      entry("old", "question", at(25, 18, 2), "Which one first?"),
      entry("old", "answer", at(25, 18, 3), "Payroll"),
      entry("old", "digest", at(25, 20), "While you were out: 3 landed."),
      entry("old", "morning", at(26, 8), "Good morning: a quiet night."),
      entry("old", "routine-ran", at(26, 8, 30), "a kind this app does not know"),
      entry("now", "session", at(26, 10, 0), "", { reason: "new-conversation" }),
      entry("now", "you", at(26, 10, 0), "Fresh start please"),
      entry("now", "cobra", at(26, 10, 1), "Here."),
      entry("now", "digest", at(26, 11, 30), "While you were out: 2 landed."),
    ];
    const items = historyOf(entries, "now", now);
    expect(items.map((i) => (i.kind === "marker" ? `— ${i.label}${i.earlier ? " (earlier)" : ""}` : i.kind === "said" ? `${i.who}: ${i.text}${i.digest ? " [digest]" : ""}` : `designs: ${i.text}`))).toEqual([
      "— Cobra started · Yesterday 5:59 PM (earlier)",
      "you: What landed overnight?",
      "cobra: Which one first?",
      "you: Payroll",
      "cobra: While you were out: 3 landed. [digest]",
      "— New conversation · Today 10:00 AM",
      "cobra: While you were out: 2 landed. [digest]",
    ]);
    expect(Date.parse(items[0]!.at)).toBeLessThan(Date.parse(entries[1]!.at));
    expect(Date.parse(items[5]!.at)).toBeLessThan(Date.parse(entries[8]!.at));
  });

  it("an older morning brief stays; nothing is drawn while the conversation now running is unknown", () => {
    const now = at(26, 12);
    const brief = entry("old", "morning", at(25, 8), "Good morning");
    expect(historyOf([brief], "now", now).map((i) => i.kind === "said" && i.text)).toEqual(["Good morning"]);
    expect(historyOf([brief], null, now)).toEqual([]);
  });

  it("a [cobra] line is a note, never what the person said", () => {
    expect(cobraNote("[cobra] Worker w3 finished: ok")).toBe("Worker w3 finished: ok");
    expect(cobraNote("  [cobra]   padded")).toBe("padded");
    expect(cobraNote("tell [cobra] hi")).toBeNull();
    const rows = model.rowsOf(model.mergeMessages([], [
      { kind: "text", id: "1", at: "2026-10-26T10:00:00Z", role: "user", text: "[cobra] Worker w3 finished" },
      { kind: "text", id: "2", at: "2026-10-26T10:01:00Z", role: "user", text: "ship it" },
      { kind: "text", id: "3", at: "2026-10-26T10:02:00Z", role: "assistant", text: "[cobra] I said this myself" },
    ]));
    expect(rows.map((r) => [r.kind, r.text])).toEqual([["note", "Worker w3 finished"], ["text", "ship it"], ["text", "[cobra] I said this myself"]]);
  });

  it("the pane's rows: earlier conversations and every line first, the current digests among the transcript by time", () => {
    const now = at(26, 12);
    const history = historyOf([
      entry("old", "you", at(25, 17), "yesterday"),
      entry("now", "session", at(26, 10), "", { reason: "idle" }),
      entry("now", "digest", at(26, 10, 30), "While you were out: 1 landed."),
      entry("now", "digest", at(26, 11, 30), "While you were out: 2 landed."),
    ], "now", now);
    const rows = model.rowsOf(model.mergeMessages([], [
      { kind: "text", id: "a", at: iso(at(26, 10, 5)), role: "user", text: "morning" },
      { kind: "tool", id: "t", at: iso(at(26, 10, 6)), name: "Bash", summary: "Bash · ls" },
      { kind: "text", id: "b", at: iso(at(26, 11)), role: "assistant", text: "done" },
    ]));
    const out = threadRows(history, [...rows, { kind: "text", id: "local:1", at: "", role: "user", text: "sending", pending: true }]);
    expect(out.map((r) => r.kind === "marker" ? `— ${r.label}` : r.kind === "tools" ? "tools" : String(r.text))).toEqual([
      "yesterday",
      "— Fresh start · Today 10:00 AM",
      "morning",
      "tools",
      "While you were out: 1 landed.",
      "done",
      "While you were out: 2 landed.",
      "sending",
    ].map((x) => x));
    expect(out[0]).toMatchObject({ kind: "said", earlier: true });
    expect(out[4]).toMatchObject({ kind: "said", earlier: false, digest: true });
  });

  it("designs a Designer showed: read from the page, drawn in either conversation, the current ones among the transcript by time", () => {
    const file = { path: "/home/a/Spaces/acme/designs/exports/sale-1.png", name: "sale-1.png", bytes: 1000, width: 1080, height: 1350 };
    const page = parseThreadPage({ entries: [{ id: 9, at: "2026-10-31T10:00:00Z", kind: "designs", conversation: "c", text: "Takes", files: [file, { path: "x" }, "no"] }], current: "c", more: false });
    expect(page?.entries[0]?.files).toEqual([file]);

    const now = at(31, 12);
    const entries = [
      entry("old", "session", at(30, 9)),
      entry("old", "designs", at(30, 9, 5), "Yesterday's take.", { files: [file] }),
      entry("now", "session", at(31, 11)),
      entry("now", "designs", at(31, 11, 30), "Three takes.", { files: [file, { ...file, name: "sale-2.png" }] }),
      entry("now", "designs", at(31, 11, 31), "Broken.", { files: [{ ...file, width: 0 }] }),
    ];
    const history = historyOf(entries, "now", now);
    expect(history.filter((item) => item.kind === "designs").map((item) => item.kind === "designs" && [item.text, item.files.length, item.earlier])).toEqual([
      ["Yesterday's take.", 1, true],
      ["Three takes.", 2, false],
    ]);
    const rows = threadRows(history, [
      { kind: "text", role: "user", id: "t1", text: "Make a sale post", at: iso(at(31, 11, 20)) },
      { kind: "text", role: "assistant", id: "t2", text: "Here they are", at: iso(at(31, 11, 40)) },
    ]);
    expect(rows.map((row) => `${row.kind}:${row.text ?? row.label ?? ""}`)).toEqual([
      expect.stringMatching(/^marker:/),
      "designs:Yesterday's take.",
      expect.stringMatching(/^marker:/),
      "text:Make a sale post",
      "designs:Three takes.",
      "text:Here they are",
    ]);
  });
});
