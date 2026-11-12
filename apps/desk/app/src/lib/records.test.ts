import { describe, expect, it } from "vitest";
import * as records from "./records.ts";

const entry = (extra: Record<string, unknown> = {}) => ({
  id: 6, at: "2026-10-23T09:00:00Z", by: "foreman", mutation: "record_hours", summary: "Hours for week 42", changes: 4,
  undone: false, undoable: true, undoneAt: null, undoOf: null, ...extra,
});

describe("whether the project page shows records", () => {
  it("asks only for a project made for a trade", () => {
    expect(records.asksForRecords("payroll-manager")).toBe(true);
    expect(records.asksForRecords("website-builder")).toBe(true);
    expect(records.asksForRecords(undefined)).toBe(false);
    expect(records.asksForRecords("")).toBe(false);
  });

  it("shows for a trade with a database, or once there is a journal", () => {
    const empty = { project: "p", entries: [] };
    expect(records.showsRecords("payroll-manager", empty)).toBe(true);
    expect(records.showsRecords("billing", empty)).toBe(true);
    expect(records.showsRecords("website-builder", empty)).toBe(false);
    // A trade Cobra defined: this build does not know it, the agent says it keeps records.
    expect(records.showsRecords("dog-walking", { ...empty, records: true })).toBe(true);
    expect(records.showsRecords("website-builder", { entries: [entry()] })).toBe(true);
  });
});

describe("entriesOf", () => {
  it("keeps the entries in the agent's order and drops anything that is not one", () => {
    expect(records.entriesOf({ entries: [entry({ id: 2 }), "junk", { id: "x" }, entry({ id: 1 })] }).map((e) => e.id)).toEqual([2, 1]);
    expect(records.entriesOf(null)).toEqual([]);
  });
});

describe("words for a change", () => {
  it("a named write, an import and an undo", () => {
    expect(records.mutationWords("add_employee")).toBe("Add employee");
    expect(records.mutationWords("import:employees")).toBe("Import employees from a file");
    expect(records.mutationWords("undo:add_employee")).toBe("Undo of add employee");
    expect(records.mutationWords(undefined)).toBe("A change");
  });

  it("who made it", () => {
    expect(["foreman", "person", "import", "routine", "lead", ""].map(records.byWords))
      .toEqual(["the Foreman", "you", "a file import", "a routine", "lead", "someone"]);
  });
});

describe("entryView", () => {
  it("an undoable change offers Undo, with its summary as the title", () => {
    const v = records.entryView(entry());
    expect(v).toEqual({ title: "Hours for week 42", word: "", tone: "ink", detail: "Record hours · by the Foreman · 4 rows", undo: true });
  });

  it("an undone change is dimmed and offers nothing; an undo says so", () => {
    expect(records.entryView(entry({ undone: true, undoable: true }))).toMatchObject({ word: "UNDONE", tone: "dim", undo: false });
    expect(records.entryView(entry({ mutation: "undo:record_hours", undoOf: 5, undoable: false, summary: undefined })))
      .toMatchObject({ title: "Undo of record hours", word: "UNDO", undo: false, detail: "by the Foreman · 4 rows" });
  });

  it("one row is one row", () => {
    expect(records.entryView(entry({ changes: 1 })).detail).toContain("1 row");
    expect(records.entryView(entry({ changes: 0 })).detail).toBe("Record hours · by the Foreman");
  });
});

describe("undoConfirm", () => {
  it("names the change, says what happens and that the Foreman is told", () => {
    const c = records.undoConfirm(entry(), "paws");
    expect(c.title).toBe("Undo “Hours for week 42”?");
    expect(c.body).toContain("paws's rows go back");
    expect(c.body).toContain("The Foreman is told.");
    expect(c.yes).toBe("Undo");
  });
});
