import { describe, expect, it } from "vitest";
import * as google from "./google.ts";

const DRIVE = "https://www.googleapis.com/auth/drive.file";
const GMAIL = "https://www.googleapis.com/auth/gmail.send";
const CALENDAR_READ = "https://www.googleapis.com/auth/calendar.readonly";
const MAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";

describe("googleView", () => {
  it("connected says as whom and what it allows, with nothing to fix", () => {
    const v = google.googleView({ cloudLinked: true, connected: true, email: "penny@example.com", scopes: ["openid", DRIVE, GMAIL], problem: null }, "Legion");
    expect([v.word, v.tone, v.fix, v.detail]).toEqual(["connected as penny@example.com", "ink", "none", ""]);
    expect(v.allows).toHaveLength(2);
    expect(v.allows[0]).toContain("It cannot see your other files.");
    expect(v.allows[1]).toContain("only the messages you allow");
  });

  it("connected with no email still reads connected", () => {
    expect(google.googleView({ connected: true }, "Legion").word).toBe("connected");
  });

  it("an agent from before the Google sign-in says to update it", () => {
    const v = google.googleView({ cloudLinked: false, connected: false, problem: "no_cloud_link" }, "Mini");
    expect([v.word, v.fix]).toEqual(["update the agent", "none"]);
    expect(v.detail).toContain("Update it");
  });

  it("no client yet offers the setup steps", () => {
    const v = google.googleView({ cloudLinked: true, connected: false, problem: "google_no_client" }, "Mini");
    expect([v.word, v.tone, v.fix]).toEqual(["not set up", "signal", "setup"]);
    expect(google.SETUP_STEPS.join(" ")).toContain("Desktop app");
    expect(google.SETUP_STEPS.join(" ")).toContain("Publish app");
  });

  it("not connected and reconnect both offer Connect Google", () => {
    expect(google.googleView({ cloudLinked: true, connected: false, problem: "google_not_connected" }, "Mini").fix).toBe("connect");
    const again = google.googleView({ cloudLinked: true, connected: false, problem: "google_reconnect" }, "Mini");
    expect([again.word, again.fix]).toEqual(["connect again", "connect"]);
  });

  it("unavailable says try again shortly and keeps what it last allowed", () => {
    const v = google.googleView({ cloudLinked: true, connected: false, problem: "google_unavailable", scopes: [DRIVE] }, "Mini");
    expect([v.word, v.tone, v.fix]).toEqual(["not reachable", "muted", "retry"]);
    expect(v.detail).toContain("Try again shortly");
    expect(v.allows).toHaveLength(1);
  });

  it("a problem from a newer agent reads as needing attention, in its own words", () => {
    const v = google.googleView({ connected: false, problem: "google_quota_spent" }, "Mini");
    expect([v.word, v.fix]).toEqual(["needs attention", "retry"]);
    expect(v.detail).toBe("Mini said: google quota spent.");
  });

  it("an answer that is not an object, or no reason at all, offers Connect Google", () => {
    expect(google.googleView(null, "Mini").fix).toBe("connect");
    expect(google.googleView("junk", "Mini").fix).toBe("connect");
    expect(google.googleView({ connected: false }, "Mini").word).toBe("not connected");
  });
});

describe("scopeLines", () => {
  it("leaves out the sign-in scopes, names unknown ones and drops repeats", () => {
    expect(google.scopeLines(["openid", "email", "https://www.googleapis.com/auth/userinfo.email"])).toEqual([]);
    expect(google.scopeLines([DRIVE, DRIVE, "https://www.googleapis.com/auth/tasks"])).toEqual([
      expect.stringContaining("Make and open its own files"),
      'Google\'s "tasks" access.',
    ]);
    expect(google.scopeLines(null)).toEqual([]);
    expect(google.scopeLines([7, ""])).toEqual([]);
  });
});

describe("connected reads", () => {
  const ready = (scopes: string[]) => ({ cloudLinked: true, connected: true, email: "penny@example.com", scopes, problem: null });

  it("a connected computer shows Calendar and Mail, off until Google granted each", () => {
    const rows = google.readRows(ready(["openid", DRIVE, GMAIL]));
    expect(rows.map((r) => [r.name, r.title, r.word, r.tone])).toEqual([["calendar", "Calendar", "off", "muted"], ["mail", "Mail", "off", "muted"]]);
    expect(rows[0]!.line).toBe(google.CALENDAR_LINE);
    expect(rows[0]!.note).toBe("");
    expect(rows[1]!.line).toBe(google.MAIL_LINE);
    expect(rows[1]!.note).toBe("");
  });

  it("a granted read is on; the scope may come short or as Google's URL", () => {
    expect(google.readRows(ready([DRIVE, CALENDAR_READ])).map((r) => r.word)).toEqual(["on", "off"]);
    expect(google.readRows(ready(["calendar.readonly", "gmail.readonly"])).map((r) => r.on)).toEqual([true, true]);
    expect(google.readOn(ready([MAIL_READ]), "mail")).toBe(true);
    expect(google.readOn(ready([MAIL_READ]), "calendar")).toBe(false);
  });

  it("no rows until the computer is connected", () => {
    expect(google.readRows({ connected: false, problem: "google_not_connected", scopes: [CALENDAR_READ] })).toEqual([]);
    expect(google.readRows({ connected: false, problem: "google_unavailable", scopes: [CALENDAR_READ] })).toEqual([]);
    expect(google.readRows(null)).toEqual([]);
  });

  it("the reads are their rows, not lines under What it allows, and sending no longer says it cannot read mail", () => {
    const v = google.googleView(ready([DRIVE, GMAIL, CALENDAR_READ, MAIL_READ]), "Legion");
    expect(v.allows).toHaveLength(2);
    expect(v.allows.join(" ")).not.toContain("cannot read your mail");
    expect(google.BLURB).toContain("reads your calendar or mail only when you turn that on");
    expect(google.READS_NOTE).toContain("press Disconnect and connect again");
  });

  it("after Turn on the desk watches until that read is on", () => {
    const start = 1_000_000;
    expect(google.keepWatching(ready([DRIVE]), start, start + 10_000, "calendar")).toBe(true);
    expect(google.keepWatching(ready([DRIVE, CALENDAR_READ]), start, start + 10_000, "calendar")).toBe(false);
    expect(google.keepWatching(ready([DRIVE, CALENDAR_READ]), start, start + 10_000, "mail")).toBe(true);
    expect(google.keepWatching(ready([DRIVE]), start, start + google.WATCH_FOR_MS + 1, "calendar")).toBe(false);
    expect(google.watchToast("mail")).toBe("Turn on Mail on the page that opened; this computer is read again when you have");
    expect(google.watchLine("calendar")).toBe("Waiting for Calendar to be turned on…");
    expect(google.watchLine(null)).toBe("Waiting for Google to be connected…");
  });
});

describe("signInPage", () => {
  it("opens only Google's own sign-in address", () => {
    expect(google.signInPage("https://accounts.google.com/o/oauth2/v2/auth?client_id=x")).toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=x");
    expect(google.signInPage(null)).toBeNull();
    expect(google.signInPage("")).toBeNull();
    expect(google.signInPage("https://accounts.google.com.evil.example/x")).toBeNull();
    expect(google.signInPage("http://accounts.google.com/x")).toBeNull();
    expect(google.signInPage("javascript:alert(1)")).toBeNull();
  });
});

describe("failureLine", () => {
  it("a 404 is an agent from before Google", () => {
    expect(google.failureLine(404, "no route", "Mini")).toBe("Update the agent on Mini to use Google from here.");
    expect(google.failureLine(0, "timed out", "Mini")).toBe("timed out");
    expect(google.failureLine(500, "", "Mini")).toBe("Mini did not answer.");
  });
});

describe("checkedLine", () => {
  const now = 1_800_000_000_000;
  it("says how long ago the agent asked the cloud", () => {
    expect(google.checkedLine(null, now)).toBe("");
    expect(google.checkedLine(now - 10_000, now)).toBe("Checked just now.");
    expect(google.checkedLine(now - 60_000, now)).toBe("Checked 1 minute ago.");
    expect(google.checkedLine(now - 5 * 3_600_000, now)).toBe("Checked 5 hours ago.");
    expect(google.checkedLine(now - 3 * 86_400_000, now)).toBe("Checked 3 days ago.");
  });
});

describe("keepWatching", () => {
  it("reads again after Connect Google until connected or the watch ends", () => {
    const start = 1_000_000;
    const waiting = { connected: false, problem: "google_not_connected" };
    expect(google.keepWatching(waiting, start, start + 10_000)).toBe(true);
    expect(google.keepWatching({ connected: true, email: "a@b.c" }, start, start + 10_000)).toBe(false);
    expect(google.keepWatching(waiting, start, start + google.WATCH_FOR_MS + 1)).toBe(false);
  });
});
