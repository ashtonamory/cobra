import { describe, expect, it } from "vitest";
import * as s from "./allowScope.ts";

const network = { scopes: ["once", "task", "project", "always"], hosts: ["api.example.com"], project: "example/cobra" };

describe("Allow scopes", () => {
  it("no offer, no choices: an older agent's card stays Allow", () => {
    expect(s.allowOffer({ headline: "x" })).toBeNull();
    expect(s.allowOffer(null)).toBeNull();
    expect(s.scopeChoices(null)).toEqual([]);
  });

  it("reads the agent's offer", () => {
    expect(s.allowOffer({ allow: { ...network, suggest: "project", junk: 1 } })).toEqual({ ...network, suggest: "project" });
    expect(s.allowOffer({ allow: { hosts: ["a.example"] } })).toBeNull();
  });

  it("a host can be allowed for the task, the project or always", () => {
    const choices = s.scopeChoices(network);
    expect(choices.map((c) => [c.scope, c.label, c.writes])).toEqual([
      ["task", "For this task", null],
      ["project", "Always in cobra", "project"],
      ["always", "Always", "fleet"],
    ]);
    expect(choices[1].detail).toBe("api.example.com for every Worker in cobra");
    expect(s.confirmWords(choices[0])).toBe("Allow this api.example.com until this Worker is done");
    expect(s.confirmWords(null)).toBe("Allow this command");
  });

  it("a menu's Allow entries: once, then the offer's scopes with Cobra's suggestion first; none when once is all", () => {
    expect(s.allowMenu(null)).toEqual([]);
    expect(s.allowMenu({ scopes: ["once"] })).toEqual([]);
    expect(s.allowMenu({ ...network, suggest: "project" }).map((e) => [e.action, e.label])).toEqual([
      ["approve", "Allow once"],
      ["approve:project", "Always in cobra (suggested)"],
      ["approve:task", "For this task"],
      ["approve:always", "Always"],
    ]);
  });

  it("an MCP tool or a package tool is for the task only", () => {
    expect(s.scopeChoices({ scopes: ["once", "task"], tool: "mcp__github__get_issue" }).map((c) => c.detail)).toEqual(["github get_issue until this Worker is done"]);
    expect(s.scopeChoices({ scopes: ["once", "task"], hosts: ["registry.npmjs.org"], install: "pnpm" }).map((c) => c.detail)).toEqual(["pnpm installs until this Worker is done"]);
    expect(s.toolName("mcp__x")).toBe("x");
  });

  it("a scope with nothing to name is left out", () => {
    expect(s.scopeChoices({ scopes: ["once", "project", "forever"], hosts: ["a.example"] })).toEqual([]);
  });

  it("Cobra's suggestion comes first, with why", () => {
    const offer = { ...network, project: "a/stable", suggest: "project" };
    expect(s.ordered(s.scopeChoices(offer)).map((c) => c.scope)).toEqual(["project", "task", "always"]);
    expect(s.suggestLine(offer)).toBe("You have allowed api.example.com here before. Always in stable?");
    expect(s.suggestLine({ scopes: ["once", "task"], tool: "mcp__a__b" })).toBeNull();
  });

  it("the Allow's body names the dialog and a scope beyond once", () => {
    const [task] = s.scopeChoices(network);
    expect(s.allowExtra("k1", null)).toEqual({ dialogKey: "k1" });
    expect(s.allowExtra("k1", task)).toEqual({ dialogKey: "k1", scope: "task" });
    expect(s.allowExtra("", task)).toEqual({ scope: "task" });
  });

  it("this project and always write the hosts where Settings → Permissions would", () => {
    const offer = { scopes: ["once", "task", "project", "always"], hosts: ["b.example", "a.example"], project: "a/b" };
    const policy = { version: 1, revision: 4, preset: "instinct" };
    const [task, project, always] = s.scopeChoices(offer);
    expect(s.withAllowedHosts(policy, task, offer)).toBe(policy);
    expect(s.withAllowedHosts({ ...policy, projects: { "a/b": { preset: "balanced", network: { allow: ["c.example"] } } } }, project, offer).projects).toEqual({
      "a/b": { preset: "balanced", network: { allow: ["a.example", "b.example", "c.example"] } },
    });
    expect(s.withAllowedHosts({ ...policy, network: { allow: ["docs.rs"] } }, always, offer).network).toEqual({ allow: ["a.example", "b.example", "docs.rs"] });
  });
});
