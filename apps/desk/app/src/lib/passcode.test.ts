import { describe, expect, it } from "vitest";
import { MIN_LEN, askMode, fields, problem, statusLine, type PasscodeStatus } from "./passcode.ts";

const st = (extra: Partial<PasscodeStatus> = {}): PasscodeStatus => ({ set: true, unlocked: false, unlockedForS: 0, waitS: 0, ...extra });

describe("the desk's passcode, in words", () => {
  it("what an act asks for: nothing when unlocked, a passcode to make when there is none, else the passcode", () => {
    expect(askMode(st({ unlocked: true, unlockedForS: 200 }))).toBe("open");
    expect(askMode(st({ set: false }))).toBe("make");
    expect(askMode(st())).toBe("unlock");
  });

  it("each dialog asks its fields in order", () => {
    expect(fields("make").map(([f]) => f)).toEqual(["next", "again"]);
    expect(fields("unlock").map(([f]) => f)).toEqual(["code"]);
    expect(fields("change").map(([f]) => f)).toEqual(["current", "next", "again"]);
    expect(fields("remove").map(([f]) => f)).toEqual(["code"]);
  });

  it("a form is sent only when whole: nothing empty, long enough, the two alike", () => {
    expect(problem("unlock", {})).toBe("Passcode is empty.");
    expect(problem("unlock", { code: "x" })).toBeNull();
    expect(problem("make", { next: "short", again: "short" })).toBe(`A passcode is at least ${MIN_LEN} characters.`);
    expect(problem("make", { next: "long enough", again: "long enough!" })).toBe("The two do not match.");
    expect(problem("make", { next: "long enough", again: "long enough" })).toBeNull();
    expect(problem("change", { next: "long enough", again: "long enough" })).toBe("Current passcode is empty.");
    expect(problem("change", { current: "old", next: "long enough", again: "long enough" })).toBeNull();
    // Eight characters, not eight bytes: an accented or emoji passcode is counted as typed.
    expect(problem("make", { next: "éééééééé", again: "éééééééé" })).toBeNull();
  });

  it("the Settings line says where it stands", () => {
    expect(statusLine(null)).toBe("Reading…");
    expect(statusLine(st({ set: false }))).toContain("None yet");
    expect(statusLine(st({ unlocked: true, unlockedForS: 61 }))).toBe("Unlocked for 2 more minutes.");
    expect(statusLine(st({ unlocked: true, unlockedForS: 30 }))).toBe("Unlocked for 1 more minute.");
    expect(statusLine(st({ waitS: 40 }))).toContain("Locked out for 40 more seconds");
    expect(statusLine(st())).toContain("Locked.");
  });
});
