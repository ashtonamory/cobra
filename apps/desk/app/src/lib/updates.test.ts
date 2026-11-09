import { describe, expect, it } from "vitest";
import { shortNotes, updateLine } from "./updates.ts";

describe("updateLine", () => {
  it("says this copy's version, and what a check found", () => {
    expect(updateLine({ kind: "idle" }, "0.1.7")).toBe("This is version 0.1.7.");
    expect(updateLine({ kind: "current" }, "0.1.7")).toBe("This is version 0.1.7. It is the newest.");
    expect(updateLine({ kind: "ready", version: "0.2.0", notes: null }, "0.1.7")).toBe("Version 0.2.0 is ready. This is version 0.1.7.");
    expect(updateLine({ kind: "checking" }, null)).toBe("Checking…");
  });
  it("shows how far an install is, when the size is known", () => {
    expect(updateLine({ kind: "installing", version: "0.2.0", done: 50, total: 200 }, "0.1.7")).toBe("Installing version 0.2.0… 25%");
    expect(updateLine({ kind: "installing", version: "0.2.0", done: 50, total: null }, "0.1.7")).toBe("Installing version 0.2.0…");
  });
  it("says why it failed", () => {
    expect(updateLine({ kind: "failed", why: "the signature does not match" }, "0.1.7")).toBe("Could not update: the signature does not match");
  });
});

describe("shortNotes", () => {
  it("keeps short notes and cuts long ones", () => {
    expect(shortNotes("  Fixes.  ")).toBe("Fixes.");
    expect(shortNotes("")).toBeNull();
    expect(shortNotes(null)).toBeNull();
    expect(shortNotes("a".repeat(400), 10)).toBe(`${"a".repeat(9)}…`);
  });
});
