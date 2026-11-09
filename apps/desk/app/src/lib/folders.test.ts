import { describe, expect, it } from "vitest";
import * as folders from "./folders.ts";

describe("folders", () => {
  it("shows a path inside the home as ~/…", () => {
    expect(folders.shown("/home/ann/code", "/home/ann")).toBe("~/code");
    expect(folders.shown("/home/ann", "/home/ann/")).toBe("~");
    expect(folders.shown("/home/annex/code", "/home/ann")).toBe("/home/annex/code");
    expect(folders.shown("/mnt/work", "")).toBe("/mnt/work");
  });

  it("lists the computer's own folders and the added ones, marked", () => {
    const view = { home: "/home/ann", roots: ["/home/ann", "/home/ann/Projects", "/mnt/work"], added: ["/mnt/work"] };
    expect(folders.rows(view)).toEqual([
      { path: "/home/ann", title: "~", added: false, word: "built in" },
      { path: "/home/ann/Projects", title: "~/Projects", added: false, word: "built in" },
      { path: "/mnt/work", title: "/mnt/work", added: true, word: "added" },
    ]);
    expect(folders.rows(null)).toEqual([]);
    expect(folders.rows({ roots: [3, "/x"], added: "no" })).toEqual([{ path: "/x", title: "/x", added: false, word: "built in" }]);
  });

  it("asks for a whole path", () => {
    expect(folders.problem("~/code")).toBeNull();
    expect(folders.problem(" /mnt/work ")).toBeNull();
    expect(folders.problem("code")).toContain("whole path");
    expect(folders.problem("  ")).toContain("Type");
  });

  it("says an older agent needs updating", () => {
    expect(folders.failureLine(404, "not found", "legion")).toContain("update it");
    expect(folders.failureLine(0, "timed out", "mini")).toBe("mini did not answer: timed out");
    expect(folders.failureLine(400, "~/x is not a folder on this computer", "mini")).toBe("~/x is not a folder on this computer");
  });
});
