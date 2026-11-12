import { describe, expect, it } from "vitest";
import * as google from "./google.ts";

describe("googleView", () => {
  const status = (connected: Record<string, boolean>) => ({
    connectors: Object.entries(connected).map(([name, on]) => ({ name, connected: on })),
  });

  it("an agent that has not looked yet points to the Claude account's connectors", () => {
    for (const reply of [{}, null, "junk", { connectors: [] }]) {
      const v = google.googleView(reply, "Office");
      expect([v.word, v.tone]).toEqual(["through your Claude account", "muted"]);
      expect(v.detail).toContain("Office has not checked your Claude account yet");
      expect(v.detail).toContain("claude.ai → Settings → Connectors");
      expect(v.allows).toEqual([]);
    }
  });

  it("says which of Gmail, Calendar and Drive the Claude account has", () => {
    const some = google.googleView(status({ Gmail: true, "Google Calendar": true, "Google Drive": false }), "Office");
    expect([some.word, some.tone]).toEqual(["Gmail and Google Calendar connected", "ink"]);
    expect(some.detail).toBe("Google Drive is not connected. Connect them at claude.ai → Settings → Connectors.");
    expect(some.allows.join(" ")).toContain("only when you allow it");
    const none = google.googleView(status({ Gmail: false, "Google Calendar": false, "Google Drive": false }), "Office");
    expect([none.word, none.tone]).toEqual(["not connected", "signal"]);
    expect(none.detail).toContain("none of Gmail, Google Calendar and Google Drive");
    expect(none.allows).toEqual([]);
    const all = google.googleView(status({ Gmail: true, "Google Calendar": true, "Google Drive": true }), "Office");
    expect([all.word, all.detail]).toEqual(["Gmail, Google Calendar and Google Drive connected", ""]);
  });

  it("what an older agent said about a Google sign-in of its own is not shown: only the connectors count", () => {
    const old = { cloudLinked: true, connected: true, email: "penny@example.com", scopes: ["https://www.googleapis.com/auth/gmail.send"], problem: null };
    const v = google.googleView(old, "Laptop");
    expect(v.word).toBe("through your Claude account");
    expect(JSON.stringify(v)).not.toContain("penny@example.com");
    const both = google.googleView({ ...old, connectors: [{ name: "Gmail", connected: true }] }, "Laptop");
    expect(both.word).toBe("Gmail connected");
  });

  it("the words promise an Allow before anything is sent or changed", () => {
    expect(google.BLURB).toContain("nothing is sent, changed or deleted without your Allow");
    expect(google.CONNECTORS_PAGE).toBe("https://claude.ai/settings/connectors");
  });
});

describe("failureLine", () => {
  it("a 404 is an agent from before Google", () => {
    expect(google.failureLine(404, "no route", "Office")).toBe("Update the agent on Office to use Google from here.");
    expect(google.failureLine(0, "timed out", "Office")).toBe("timed out");
    expect(google.failureLine(500, "", "Office")).toBe("Office did not answer.");
  });
});
