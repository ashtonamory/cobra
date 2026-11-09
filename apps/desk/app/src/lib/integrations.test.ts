import { describe, expect, it } from "vitest";
import * as ints from "./integrations.ts";
import type { Dict, Json } from "./json.ts";

const PATH = "/home/user/.local/share/mise/installs/github-github-mcp-server/1.4.0/github-mcp-server";
const PIN = { path: PATH, sha256: "ab".repeat(32), version: "v1.4.0", release: "v1.4.0", verifiedAt: "2026-10-07T09:00:00Z" };

function status({ pin = null, binary = null, why = null, enabled = true, gh = null }:
  { pin?: Json; binary?: Json; why?: string | null; enabled?: boolean; gh?: Json } = {}): Dict {
  const entry: Dict = { name: "github", preset: "github", transport: "stdio", roles: ["lead", "foreman"],
    readOnly: true, enabled, available: why === null };
  if (why) entry.why = why;
  if (pin) entry.pin = pin;
  return { machine: "omarchy", gh: gh || { installed: true, authed: true, user: "example" },
    github: { binary, pin }, entries: [entry] };
}

describe("GithubState", () => {
  it("no pin and no binary is not installed, with the install hint", () => {
    const s = ints.githubState(status({ why: "no github-mcp-server is pinned" }));
    expect([s.word, s.verify, s.hint]).toEqual(["not installed", null, "mise use -g github:github/github-mcp-server"]);
  });

  it("a binary with no pin is not verified and offers Verify", () => {
    const s = ints.githubState(status({ binary: PATH, why: "no github-mcp-server is pinned" }));
    expect([s.word, s.verify, s.hint, s.detail, s.tone]).toEqual(["not verified", "Verify", null, PATH, "signal"]);
  });

  it("a pin the agent says no longer matches is binary changed", () => {
    const why = `the pinned github-mcp-server changed since you allowed it (${PATH})`;
    for (const reason of [why, `the pinned github-mcp-server is missing (${PATH})`,
      `the pinned github-mcp-server moved: ${PATH} now resolves to /tmp/x`]) {
      const s = ints.githubState(status({ pin: PIN, binary: PATH, why: reason }));
      expect([s.word, s.verify, s.tone], reason).toEqual(["binary changed, re-verify", "Re-verify", "signal"]);
    }
  });

  it("a pin that holds is verified, with its path, version and release", () => {
    const s = ints.githubState(status({ pin: PIN, binary: PATH }));
    expect([s.word, s.verify, s.tone]).toEqual(["verified", "Re-verify", "ink"]);
    expect(s.detail).toBe(`${PATH} · v1.4.0 · matched v1.4.0`);
  });

  it("a pin with no release says it was not matched", () => {
    const s = ints.githubState(status({ pin: { ...PIN, release: null }, binary: PATH }));
    expect(s.word).toBe("verified");
    expect(s.detail.endsWith("not matched to an official release")).toBe(true);
  });

  it("gh logged out does not make the pin changed", () => {
    const s = ints.githubState(status({ pin: PIN, binary: PATH, why: "gh is not logged in",
      gh: { installed: true, authed: false, user: null } }));
    expect(s.word).toBe("verified");
  });

  it("a pin with no version still reads", () => {
    const s = ints.githubState(status({ pin: { ...PIN, version: "" }, binary: PATH }));
    expect(s.detail).toContain("unknown version");
  });

  it("an answer with no github entry is read as not installed", () => {
    const s = ints.githubState({ machine: "m", gh: {}, github: { binary: null, pin: null }, entries: [] });
    expect(s.word).toBe("not installed");
  });
});

describe("Toggled", () => {
  it("the saved entry replaces the cached one", () => {
    const before = status({ pin: PIN, binary: PATH, enabled: true });
    const saved = { ...before.entries[0], enabled: false, available: false, why: "gh is not logged in" };
    const after = ints.withEntry(before, saved);
    expect(ints.githubEntry(after)!.enabled).toBe(false);
    expect(ints.whyNotReady(after)).toBe(""); // off, so nothing is being left out
    expect(after.gh).toEqual(before.gh);
    expect(ints.githubEntry(before)!.enabled, "the old status is not changed").toBe(true);
  });

  it("an answer without an entry changes nothing", () => {
    const before = status({ pin: PIN, binary: PATH });
    expect(ints.withEntry(before, null)).toBe(before);
    expect(ints.withEntry(before, { ok: true })).toBe(before);
  });

  it("an entry the status lacked is added", () => {
    const bare = { machine: "m", gh: {}, github: { binary: null, pin: null }, entries: [] };
    expect(ints.githubEntry(ints.withEntry(bare, { name: "github", enabled: true }))!.enabled).toBe(true);
  });
});

describe("Words", () => {
  it("gh line", () => {
    expect(ints.ghLine({ installed: true, authed: true, user: "example" })).toBe("gh logged in as example");
    expect(ints.ghLine({ installed: true, authed: false, user: null })).toBe("gh is not logged in");
    expect(ints.ghLine({ installed: false, authed: false, user: null })).toBe("gh is not installed");
    expect(ints.ghLine(null)).toBe("gh is not installed");
  });

  it("token line", () => {
    const withToken = (token: Dict) => ({ machine: "m", github: { binary: null, pin: null, token }, entries: [] });
    expect(ints.tokenLine(withToken({ present: true, login: "example" }))).toBe("token for example");
    expect(ints.tokenLine(withToken({ present: false, login: null, why: "no GitHub token: …" }))).toBe("no GitHub token");
    expect(ints.tokenLine(withToken({ present: true, login: null, why: "could not reach GitHub to check the token" })))
      .toBe("could not reach GitHub to check the token");
    // An agent from before the token file: gh's line.
    expect(ints.tokenLine(status({ pin: PIN }))).toBe("gh logged in as example");
  });

  it("why not ready only matters while it is on", () => {
    expect(ints.whyNotReady(status({ pin: PIN, why: "gh is not logged in" }))).toBe("gh is not logged in");
    expect(ints.whyNotReady(status({ pin: PIN, why: "gh is not logged in", enabled: false }))).toBe("");
    expect(ints.whyNotReady(status({ pin: PIN }))).toBe("");
  });

  it("an agent without integrations says to update", () => {
    expect(ints.failureText(404, "no route /mcp")).toBe("update agent");
    expect(ints.failureText(0, "unreachable: timed out")).toBe("unreachable: timed out");
  });

  it("the notes", () => {
    expect(ints.askedText("legion")).toBe("Asked for your Allow on legion");
    expect(ints.APPLIES_NOTE).toBe("Applies when the Lead or a Foreman next starts, or at its New conversation.");
  });
});

function integration(state: string, over: Dict = {}): Dict {
  return { id: "github", title: "GitHub", state,
    account: state === "connected" || state === "off" ? "octocat" : null,
    enabled: state === "connected", methods: ["device", "token"], ...over };
}

describe("Controller", () => {
  it("each state has its words", () => {
    expect(ints.stateWord(integration("connected"))).toBe("connected as octocat");
    expect(ints.stateWord(integration("connected", { account: null }))).toBe("connected");
    expect(ints.stateWord(integration("off"))).toBe("off");
    expect(ints.stateWord(integration("not-connected"))).toBe("not connected");
    expect(ints.stateWord(integration("signing-in"))).toBe("waiting for you on GitHub");
    expect(ints.stateWord(integration("installing"))).toBe("installing…");
    expect(ints.stateWord(integration("needs-repos"))).toBe("choose repositories");
    expect(ints.stateWord(integration("attention"))).toBe("needs attention");
    expect(ints.stateWord(integration("from-a-newer-agent"))).toBe("needs attention");
  });

  it("what each state offers", () => {
    expect(ints.integrationAction(integration("not-connected"))).toBe("connect");
    expect(ints.integrationAction(integration("attention"))).toBe("connect");
    expect(ints.integrationAction(integration("from-a-newer-agent"))).toBe("connect");
    expect(ints.integrationAction(integration("signing-in"))).toBe("wait");
    expect(ints.integrationAction(integration("installing"))).toBe("wait");
    expect(ints.integrationAction(integration("needs-repos"))).toBe("choose-repos");
    expect(ints.integrationAction(integration("connected"))).toBe("manage");
    expect(ints.integrationAction(integration("off"))).toBe("manage");
    expect(ints.stateTone(integration("connected"))).toBe("ink");
    expect(ints.stateTone(integration("attention"))).toBe("signal");
    expect(ints.stateTone(integration("signing-in"))).toBe("muted");
  });

  it("polling only while something is under way", () => {
    for (const state of ["signing-in", "installing", "needs-repos"]) expect(ints.shouldPoll(integration(state)), state).toBe(true);
    for (const state of ["connected", "off", "not-connected", "attention"]) expect(ints.shouldPoll(integration(state)), state).toBe(false);
    expect(ints.shouldPoll(null)).toBe(false);
  });

  it("an answer replaces the integration it names", () => {
    const before = { machine: "m", integrations: [integration("not-connected")] };
    const after = ints.withIntegration(before, integration("signing-in"));
    expect(ints.githubIntegration(after)!.state).toBe("signing-in");
    expect(ints.withIntegration(before, null)).toBe(before);
    expect(ints.githubIntegration({ machine: "m" }), "an agent from before the controller").toBeNull();
    expect(ints.updateAgentLine("legion")).toContain("Update the agent on legion");
  });
});
