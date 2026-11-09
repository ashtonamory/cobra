import { describe, expect, it } from "vitest";
import type { Dict } from "./json.ts";
import * as p from "./permissions.ts";

function status(revision: number, preset = "locked", refused: string | null = null): Dict {
  return {
    computer: "legion",
    policy: { version: 1, revision, preset },
    refused,
    resolved: { preset, network: [], judge: { model: "claude-haiku-5-5", fallback: "local:qwen-tuned:fast96k" }, notes: [] },
    presets: [{ name: "locked", title: "Locked", rows: {} }, { name: "balanced", title: "Balanced", rows: {} }, { name: "auto", title: "Auto", rows: {} }],
    floor: [],
    capabilities: {},
    changes: [],
  };
}

describe("Fleet", () => {
  it("the newest revision is the fleet's and older is behind", () => {
    const reads = { legion: status(3, "balanced"), mini: status(2), macbook: null };
    expect(p.newest(reads)![0]).toBe("legion");
    expect(p.nextRevision(reads)).toBe(4);
    expect(p.nextRevision({})).toBe(1);
    expect(p.computerLine(reads.legion, 3)).toBe("Balanced");
    expect(p.computerLine(reads.mini, 3)).toBe("Locked · behind");
    expect(p.computerLine(status(3, "locked", "it is mode 644"), 3)).toBe("Locked · its file was refused");
    expect(p.isBehind(reads.mini, 3)).toBe(true);
    expect(p.isBehind(null, 3)).toBe(false);
  });
});

describe("Hosts", () => {
  it("hosts and projects as the agent takes them", () => {
    expect(p.cleanHost(" https://Registry.NPMJS.org/left-pad ")).toBe("registry.npmjs.org");
    for (const bad of ["localhost", "10.0.0.1", "*.evil.com", "a b.com", ""]) expect(p.cleanHost(bad), bad).toBeNull();
    expect(p.cleanProject("https://github.com/example/lookfocus.git")).toBe("example/lookfocus");
    expect(p.cleanProject("lookfocus")).toBeNull();
  });
});

describe("Projects", () => {
  it("offers what the computers run, by name, less those set apart", () => {
    const legion = { ...status(3), projects: [{ key: "local/inbox-manager", name: "inbox-manager", preset: "instinct" }, { key: "example/web-app", name: "web-app", preset: "instinct" }] };
    const mini = { ...status(3), computer: "mini", projects: [{ key: "example/web-app", name: "web-app", preset: "balanced" }, { key: "example/plant-shop", name: "plant-shop", preset: "instinct" }] };
    const policy = { version: 1, revision: 3, preset: "balanced", projects: { "example/plant-shop": { preset: "locked" } } };
    const choices = p.projectChoices({ legion, mini, mbp: null, old: status(2) }, policy);
    expect(choices.map((choice) => choice.key)).toEqual(["local/inbox-manager", "example/web-app"]);
    expect(choices[1]!.runs).toEqual(["instinct", "balanced"]);
    expect(p.startingPreset(choices[0]!)).toBe("instinct");
    expect(p.startingPreset(choices[1]!)).toBe("balanced");
    expect(p.projectChoices({ old: status(2) }, policy)).toEqual([]);
  });
});

describe("Project websites", () => {
  it("removes a project's own website, and an empty level goes", () => {
    const policy = { version: 1, revision: 6, preset: "balanced", projects: { "local/inbox-manager": { preset: "balanced", network: { allow: ["example.org", "httpbin.org"] } }, "a/b": { network: { allow: ["x.example.com"] } } } };
    const one = p.removeProjectHost(policy, "local/inbox-manager", "example.org");
    expect(one.projects["local/inbox-manager"]).toEqual({ preset: "balanced", network: { allow: ["httpbin.org"] } });
    expect(p.removeProjectHost(one, "local/inbox-manager", "httpbin.org").projects["local/inbox-manager"]).toEqual({ preset: "balanced" });
    expect(p.removeProjectHost(policy, "a/b", "x.example.com").projects).not.toHaveProperty("a/b");
  });
});

describe("Edits", () => {
  it("edits leave no empty levels", () => {
    const base = { version: 1, revision: 3, preset: "locked" };
    expect(p.setFleetPreset(base, "balanced").preset).toBe("balanced");
    const legion = p.setComputerPreset(base, "legion", "auto");
    expect(legion.computers).toEqual({ legion: { preset: "auto" } });
    expect(p.setComputerPreset(legion, "legion", null).computers).toEqual({});
    // A preset edit keeps the level's other settings, such as merge on green.
    const merging = { ...base, projects: { "a/b": { preset: "auto", foreman: { mergeOnGreen: true } } } };
    expect(p.setProjectPreset(merging, "a/b", null).projects).toEqual({ "a/b": { foreman: { mergeOnGreen: true } } });
    const hosts = p.addFleetHost(p.addFleetHost(base, "pypi.org"), "docs.expo.dev");
    expect(hosts.network.allow).toEqual(["docs.expo.dev", "pypi.org"]);
    expect(p.removeFleetHost(p.removeFleetHost(hosts, "pypi.org"), "docs.expo.dev")).not.toHaveProperty("network");
    expect(p.changed(base, { ...base, revision: 9 })).toBe(false);
    expect(p.changed(p.setFleetPreset(base, "auto"), base)).toBe(true);
    expect(p.changeLine({ text: "the fleet: Locked → Auto", widens: true })).toBe("+ the fleet: Locked → Auto");
  });
});

describe("Refused", () => {
  it("the last day's refusals, newest first", () => {
    const now = 1_800_000_000.0;
    const rows = p.refusedRows(
      [
        ["legion", [{ at: (now - 60) * 1000, worker: "lookfocus_3", rule: "judge:outside-read", reason: "saved logins do not serve the task" }]],
        ["mini", [{ at: (now - 30) * 1000, worker: "app_2", rule: "judge:network", reason: "could leak data" },
          { at: (now - 2 * 86400) * 1000, worker: "old", rule: "never:mcp" }]],
      ],
      now,
    );
    expect(rows.map((r) => [r.computer, r.worker])).toEqual([["mini", "app_2"], ["legion", "lookfocus_3"]]);
    expect(p.refusedLine(rows[0])).toBe("app_2 · reach a website: could leak data");
  });
});

describe("Roles", () => {
  it("fleet roles default to today, and a default is nothing", () => {
    const base = { version: 1, revision: 1, preset: "locked" };
    expect(p.fleetRole(base, "foreman", "maxWorkers")).toBe(3);
    expect(p.fleetRole(base, "foreman", "maxWorkersPerComputer")).toBe(8);
    const four = p.setFleetRole(base, "foreman", "maxWorkers", 4);
    expect(four.foreman).toEqual({ maxWorkers: 4 });
    expect(p.setFleetRole(four, "foreman", "maxWorkers", 3)).not.toHaveProperty("foreman");
    expect(p.setFleetRole(four, "foreman", "maxWorkersPerComputer", 12).foreman).toEqual({ maxWorkers: 4, maxWorkersPerComputer: 12 });
    // The Lead's web tools: off by default, and written either way, so an agent from before (default on) agrees.
    expect(p.fleetRole(base, "lead", "webTools")).toBe(false);
    expect(p.setFleetRole(base, "lead", "webTools", false).lead).toEqual({ webTools: false });
    expect(p.setFleetRole(base, "lead", "webTools", true).lead).toEqual({ webTools: true });
    expect(p.fleetRole(base, "foreman", "webTools")).toBe(true);
    expect(p.setFleetRole(base, "foreman", "webTools", false).foreman).toEqual({ webTools: false });
    const merging = p.setProjectMergeOnGreen(base, "a/b", true);
    expect(merging.projects).toEqual({ "a/b": { foreman: { mergeOnGreen: true } } });
    expect(p.setProjectMergeOnGreen(merging, "a/b", false).projects).toEqual({});
    expect(p.toggleModel(null, "opus")).toEqual(["claude", "sonnet", "haiku", "local:*"]);
    expect(p.toggleModel(["claude", "sonnet", "haiku", "local:*"], "opus")).toBeNull();
  });

  it("a project's own Worker cap, and the fleet's value written as nothing", () => {
    const base = p.setFleetRole({ version: 1, revision: 1, preset: "locked", projects: { "a/b": { preset: "locked" } } }, "foreman", "maxWorkers", 2);
    expect(p.projectMaxWorkers(base, "a/b")).toEqual([2, false]);
    const six = p.setProjectMaxWorkers(base, "a/b", 6);
    expect(six.projects["a/b"]).toEqual({ preset: "locked", foreman: { maxWorkers: 6 } });
    expect(p.projectMaxWorkers(six, "a/b")).toEqual([6, true]);
    expect(p.setProjectMaxWorkers(six, "a/b", 2).projects["a/b"]).toEqual({ preset: "locked" });
    expect(p.setProjectMaxWorkers(base, "c/d", 0).projects["c/d"]).toEqual({ foreman: { maxWorkers: 0 } });
    expect(p.removeProject(p.setProjectMergeOnGreen(six, "a/b", true), "a/b").projects).toEqual({});
  });
});

describe("ApiCredits", () => {
  const lane = (over: Dict = {}): Dict => ({
    key: true, open: true, workspace: false, keptToken: true, gateway: true,
    here: { dollars: 2.5, requests: 7 }, fleetUsd: 10.0, lastError: null, ...over,
  });

  it("the lane is off until policy says so", () => {
    expect(p.apiLane({})).toEqual({ enabled: false, monthlyCapUsd: 0.0, testMode: false });
    expect(p.setApiLane({ revision: 3 }, true, 49.999)).toEqual({ revision: 3, apiLane: { enabled: true, monthlyCapUsd: 50.0 } });
    expect(p.setApiLane({}, true, -4).apiLane.monthlyCapUsd).toBe(0.0);
    // API test mode: kept through a cap change, ended with the lane off, set when given.
    const testing = { apiLane: { enabled: true, monthlyCapUsd: 50, testMode: true } };
    expect(p.apiLane(testing).testMode).toBe(true);
    expect(p.setApiLane(testing, true, 80).apiLane).toEqual({ enabled: true, monthlyCapUsd: 80, testMode: true });
    expect(p.setApiLane(testing, false, 50).apiLane).toEqual({ enabled: false, monthlyCapUsd: 50 });
    expect(p.setApiLane(testing, true, 50, false).apiLane).toEqual({ enabled: true, monthlyCapUsd: 50 });
    const report = (since: string, worker: number, lead: number, until?: string) => ({
      test: { since, ...(until ? { until } : {}), spentUsd: worker + lead, requests: 2, byRole: [{ role: "worker", spentUsd: worker }, { role: "lead", spentUsd: lead }] },
    });
    expect(p.testLine({ legion: report("2026-10-24T10:00:00.000Z", 3, 1), mini: report("2026-10-24T09:00:00.000Z", 2, 0), mbp: null })).toBe(
      "spent $6.00 since 2026-10-24 09:00 · Workers $5.00 · Cobra $1.00",
    );
    expect(p.testLine({ legion: { key: true } })).toBeNull();
  });

  it("the fleet spend is the highest any computer reports", () => {
    expect(p.fleetSpend({ a: lane({ fleetUsd: 10 }), b: lane({ fleetUsd: 12.5 }), c: null })).toBe(12.5);
    expect(p.fleetSpend({})).toBe(0.0);
  });

  it("each computer says what keeps it off the key", () => {
    expect(p.laneLine(lane({ key: false }))).toContain("no key");
    expect(p.laneLine(lane()).startsWith("ready · $2.50 this month in 7 requests")).toBe(true);
    expect(p.laneLine(lane({ open: false, lastError: { message: "not scoped to a workspace" } }))).toContain("needs a workspace ID");
    expect(p.laneLine(lane({ keptToken: false }))).toContain("cobra-agent claude-token");
  });
});

describe("House rules", () => {
  it("tidied, at most 20 of 300 characters, no repeats", () => {
    const base: Dict = { version: 1, revision: 2 };
    expect(p.cleanRule("  No   spending. ")).toBe("No spending.");
    expect(p.cleanRule("   ")).toBeNull();
    expect(p.cleanRule("x".repeat(p.RULE_MAX + 1))).toBeNull();
    const one = p.addRule(base, "No spending.");
    expect(one.rules).toEqual(["No spending."]);
    expect(p.addRule(one, "No spending.")).toBe(one);
    const full = Array.from({ length: p.RULES_MAX }, (_, at) => `Rule ${at}.`).reduce((next, rule) => p.addRule(next, rule), base);
    expect(p.addRule(full, "One more.")).toBe(full);
    expect(p.removeRule(p.addRule(one, "Ask before emailing anyone new."), 0).rules).toEqual(["Ask before emailing anyone new."]);
  });
});
