import { describe as group, expect, it } from "vitest";
import { ApiError } from "./api.ts";
import * as newproject from "./newProject.ts";
import { Draft } from "./newProject.ts";

group("Directory", () => {
  it("a typed name becomes a directory the agent accepts", () => {
    expect(newproject.directoryFrom("  The Ledger  ")).toBe("the-ledger");
    expect(newproject.directoryFrom("..hidden")).toBe("hidden");
    expect(newproject.directoryFrom("a/b c!")).toBe("a-b-c");
    expect(newproject.directoryFrom("v1.2_beta")).toBe("v1.2_beta");
    expect(newproject.directoryFrom("!!!")).toBe("");
    expect(newproject.directoryFrom("x".repeat(100)).length).toBe(64);
  });
});

group("Blocker", () => {
  it("each mode names what is missing", () => {
    expect(newproject.blocker(new Draft("adopt", "omarchy"), true)).toBe("Pick a repository on this computer");
    expect(newproject.blocker(new Draft("adopt", "omarchy", { path: "/p/x" }), false)).toBeNull();
    expect(newproject.blocker(new Draft("clone", "omarchy", { repo: "a/b" }), false)).toBe("This computer is not logged in to GitHub");
    expect(newproject.blocker(new Draft("clone", "omarchy"), true)).toBe("Pick a repository to clone");
    expect(newproject.blocker(new Draft("clone", "omarchy", { repo: "a/b" }), true)).toBeNull();
    expect(newproject.blocker(new Draft("init", "omarchy", { name: " ! " }), true)).toBe("Give it a name");
    expect(newproject.blocker(new Draft("init", "omarchy", { name: "x", remote: true }), false)).toBe(
      "This computer is not logged in to GitHub");
    expect(newproject.blocker(new Draft("init", "omarchy", { name: "x" }), false)).toBeNull();
  });
});

group("Request", () => {
  it("only the fields of the mode are sent", () => {
    expect(newproject.requestFor(new Draft("adopt", "omarchy", { root: "/h" }))).toBeNull();
    expect(newproject.requestFor(new Draft("adopt", "omarchy", { root: "/h", path: "/h/x", repo: "a/b" }))).toEqual(
      { mode: "adopt", path: "/h/x" });
    expect(newproject.requestFor(new Draft("clone", "omarchy", { root: "/h/Projects", repo: "a/b", remote: true }))).toEqual(
      { mode: "clone", repo: "a/b", root: "/h/Projects" });
    expect(newproject.requestFor(new Draft("clone", "omarchy", { repo: "a/b" }))).toEqual({ mode: "clone", repo: "a/b" });
  });

  it("init keeps the typed name for display", () => {
    expect(newproject.requestFor(new Draft("init", "omarchy", { root: "/h", name: " The Ledger ", remote: true }))).toEqual(
      { mode: "init", directory: "the-ledger", name: "The Ledger", remote: true, root: "/h" });
    expect(newproject.requestFor(new Draft("init", "omarchy", { name: "" }))).toBeNull();
  });
});

group("Roots", () => {
  it("home and labels", () => {
    const roots = ["/home/mini/Projects", "/home/mini"];
    const home = newproject.homeFrom(roots);
    expect(home).toBe("/home/mini");
    expect(roots.map((r) => newproject.rootLabel(r, home))).toEqual(["~/Projects", "~"]);
    expect(newproject.rootLabel("/srv/x", home)).toBe("/srv/x");
    expect(newproject.rootLabel("/home/minimal", home)).toBe("/home/minimal");
    expect(newproject.homeFrom([])).toBeNull();
  });

  it("Projects wins over bare home", () => {
    expect(newproject.preferredRoot(["/h", "/h/Projects"])).toBe("/h/Projects");
    expect(newproject.preferredRoot(["/h"])).toBe("/h");
    expect(newproject.preferredRoot([])).toBeNull();
  });
});

group("Lists", () => {
  const REPOS = [
    { nameWithOwner: "me/cobra", name: "cobra", description: "One app for your life" },
    { nameWithOwner: "me/plant-shop", name: "plant-shop", description: null },
  ];

  it("search matches name or description", () => {
    expect(newproject.matchRepos(REPOS, "").length).toBe(2);
    expect(newproject.matchRepos(REPOS, " LIFE ").map((r) => r.name)).toEqual(["cobra"]);
    expect(newproject.matchRepos(REPOS, "plant").map((r) => r.name)).toEqual(["plant-shop"]);
    expect(newproject.matchRepos(REPOS, "nothing")).toEqual([]);
  });

  it("a discovered repo says its branch or what is in the way", () => {
    expect(newproject.adoptStatus({ git: { branch: "main", dirty: false } })).toEqual(["main", "muted"]);
    expect(newproject.adoptStatus({ git: { branch: "feat/x", dirty: true } })).toEqual(["feat/x •", "ink"]);
    expect(newproject.adoptStatus({ git: { branch: "main" }, sessionTaken: true })).toEqual(["SESSION IN USE", "ink"]);
    expect(newproject.adoptStatus({ git: null })).toEqual(["", "muted"]);
  });
});

group("Words", () => {
  it("errors read as sentences", () => {
    expect(newproject.describe(new ApiError(0, "unreachable: x"), "mini")).toBe("mini is not reachable.");
    expect(newproject.describe(new ApiError(401, "no"), "mini")).toContain("cobra-desk add");
    expect(newproject.describe(new ApiError(409, "already a project"), "mini")).toBe("already a project");
  });

  it("outcome and verbs", () => {
    expect(newproject.outcome({ project: { name: "x" }, trusted: true }, "mini")).toBe("x added on mini, not started");
    expect(newproject.outcome({ project: { name: "x" }, trusted: false }, "mini")).toContain("trusting");
    expect(["adopt", "clone", "init"].map((m) => newproject.busyWord(m))).toEqual(["Adding…", "Cloning…", "Creating…"]);
    expect(["adopt", "clone", "init"].map((m) => newproject.doneWord(m))).toEqual(["Added", "Cloned", "Created"]);
  });
});
