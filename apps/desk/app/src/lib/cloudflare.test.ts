import { describe, expect, it } from "vitest";
import * as cloudflare from "./cloudflare.ts";

const base = { scopes: [], connectedAt: null, problem: null, clientId: "c", redirect: "https://cobra.example.com/connect/cloudflare" };

describe("cloudflareView", () => {
  it("not connected offers Connect", () => {
    const v = cloudflare.cloudflareView({ ...base, state: "not-connected", account: null, accounts: [] }, "Laptop");
    expect([v.word, v.tone, v.fix, v.waiting]).toEqual(["not connected", "signal", "connect", false]);
    expect(v.detail).toContain("Laptop");
  });

  it("a sign-in under way waits for its code and still offers Connect", () => {
    const v = cloudflare.cloudflareView({ ...base, state: "connecting", account: null, accounts: [] }, "Laptop");
    expect([v.word, v.fix, v.waiting]).toEqual(["signing in", "connect", true]);
  });

  it("several accounts and none chosen asks to choose", () => {
    const v = cloudflare.cloudflareView({ ...base, state: "choose-account", account: null, accounts: [{ id: "a", name: "Home" }, { id: "b", name: "Studio" }] }, "Office");
    expect([v.word, v.fix]).toEqual(["choose an account", "choose"]);
  });

  it("connected names the account, with nothing to fix", () => {
    const v = cloudflare.cloudflareView({ ...base, state: "connected", account: { id: "a", name: "Pine Yoga" }, accounts: [{ id: "a", name: "Pine Yoga" }] }, "Office");
    expect([v.word, v.tone, v.fix, v.detail]).toEqual(["connected to Pine Yoga", "ink", "none", ""]);
  });

  it("connected without the optional permissions says how to add the spam check and email, and nothing else changes", () => {
    const account = { id: "a", name: "Pine Yoga" };
    const without = cloudflare.cloudflareView({ ...base, state: "connected", account, accounts: [account], features: { spamCheck: false, email: true } }, "Office");
    expect([without.word, without.fix, without.detail]).toEqual(["connected to Pine Yoga", "none", cloudflare.FEATURES_NOTE]);
    const all = cloudflare.cloudflareView({ ...base, state: "connected", account, accounts: [account], features: { spamCheck: true, email: true } }, "Office");
    expect(all.detail).toBe("");
  });

  it("attention shows the agent's problem and offers Connect again", () => {
    const v = cloudflare.cloudflareView({ ...base, state: "attention", account: null, accounts: [], problem: "Cloudflare did not grant d1.write. Connect again and allow every permission." }, "Office");
    expect([v.word, v.fix]).toEqual(["connect again", "connect"]);
    expect(v.detail).toContain("did not grant d1.write");
    expect(cloudflare.cloudflareView({ state: "attention" }, "Office").detail).toContain("Connect again");
  });

  it("a state from a newer agent, or no answer at all, reads as needing attention with Refresh", () => {
    const v = cloudflare.cloudflareView({ state: "paused-by-cloudflare" }, "Office");
    expect([v.word, v.fix, v.detail]).toEqual(["needs attention", "retry", "Office said: paused by cloudflare."]);
    expect(cloudflare.cloudflareView(null, "Office").fix).toBe("retry");
    expect(cloudflare.cloudflareView("junk", "Office").fix).toBe("retry");
  });
});

describe("accounts", () => {
  it("reads the accounts and the chosen one loosely", () => {
    const status = { account: { id: "b", name: "Studio" }, accounts: [{ id: "a", name: "Home" }, { id: 3 }, "x", { id: "b", name: "Studio" }] };
    expect(cloudflare.accountsOf(status)).toEqual([{ id: "a", name: "Home" }, { id: "b", name: "Studio" }]);
    expect(cloudflare.accountOf(status)).toEqual({ id: "b", name: "Studio" });
    expect(cloudflare.accountOf({ account: null })).toBeNull();
    expect(cloudflare.accountsOf(null)).toEqual([]);
  });
});

describe("failureLine", () => {
  it("an agent from before Cloudflare is asked to update", () => {
    expect(cloudflare.failureLine(404, "no such route", "Office")).toBe("Update the agent on Office to connect Cloudflare from here.");
    expect(cloudflare.failureLine(0, "timed out", "Office")).toBe("timed out");
    expect(cloudflare.failureLine(0, "", "Office")).toBe("Office did not answer.");
  });
});

describe("checkCode", () => {
  it("takes <state>.<code>, trimmed, with dots in the code", () => {
    expect(cloudflare.checkCode("  abc_1.xyz.789  ")).toEqual({ ok: true, code: "abc_1.xyz.789" });
  });

  it("takes the whole return address, https or cobra://", () => {
    expect(cloudflare.checkCode("https://cobra.example.com/connect/cloudflare?code=c1&state=s1").ok).toBe(true);
    expect(cloudflare.checkCode("cobra://connect/cloudflare?code=c1&state=s1").ok).toBe(true);
  });

  it("refuses an empty paste, a cancelled sign-in, an address without the code, and anything else", () => {
    expect(cloudflare.checkCode("   ")).toEqual({ ok: false, why: "Paste the connection code first" });
    const denied = cloudflare.checkCode("https://cobra.example.com/connect/cloudflare?error=access_denied&state=s1");
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.why).toContain("cancelled");
    expect(cloudflare.checkCode("https://cobra.example.com/connect/cloudflare").ok).toBe(false);
    for (const bad of ["nodot", ".code", "state.", "st ate.code", "state.co de"]) expect(cloudflare.checkCode(bad).ok).toBe(false);
  });
});
