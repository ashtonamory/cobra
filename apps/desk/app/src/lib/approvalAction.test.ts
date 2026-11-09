import { describe, expect, it } from "vitest";
import * as aa from "./approvalAction.ts";

const file = (path: string, bytes: number) => ({ path, name: path.split("/").pop(), bytes, sha256: "ab".repeat(32) });
const approval = (action: unknown) => ({ id: "a1", kind: "action", title: "Send: x", body: "", action });

describe("actionOf", () => {
  it("takes a known channel with its block, and nothing else", () => {
    expect(aa.actionOf(approval({ channel: "email", summary: "s", email: { to: [], subject: "", text: "" } }))).not.toBeNull();
    expect(aa.actionOf(approval({ channel: "email", summary: "s" }))).toBeNull();
    expect(aa.actionOf(approval({ channel: "fax", summary: "s", fax: {} }))).toBeNull();
    expect(aa.actionOf({ kind: "merge" })).toBeNull();
    expect(aa.actionView(null)).toBeNull();
  });
});

describe("an email", () => {
  it("To, Cc, Subject, the text and the attachments", () => {
    const v = aa.actionView(approval({
      channel: "email", project: "p", projectName: "p", summary: "Pay stubs",
      email: { to: ["ann@example.com", "bo@example.com"], cc: ["books@example.com"], subject: "Week 42", text: "Hi Ann,\nAttached.",
        attachments: [file("out/stubs.pdf", 182_000), file("summary.csv", 900)] },
    }))!;
    expect(v.channel).toBe("email");
    expect(v.word).toBe("EMAIL");
    expect(v.fields).toEqual([["To", "ann@example.com, bo@example.com"], ["Cc", "books@example.com"], ["Subject", "Week 42"]]);
    expect([v.text, v.folded, v.preview]).toEqual(["Hi Ann,\nAttached.", false, "Hi Ann,"]);
    expect(v.files).toEqual([{ name: "stubs.pdf", path: "out/stubs.pdf", size: "178 KB" }, { name: "summary.csv", path: "", size: "900 B" }]);
    expect(aa.allowLine(v)).toBe("Allow sends exactly this from your Gmail.");
  });

  it("no Cc row without one; a long text opens folded", () => {
    const text = ["a", "b", "c", "d", "e"].join("\n");
    const v = aa.actionView(approval({ channel: "email", summary: "s", email: { to: ["a@b.c"], subject: "", text } }))!;
    expect(v.fields.map(([k]) => k)).toEqual(["To", "Subject"]);
    expect(v.fields[1][1]).toBe("(no subject)");
    expect(v.folded).toBe(true);
    expect(aa.actionView(approval({ channel: "email", summary: "s", email: { to: ["a@b.c"], subject: "x", text: "y".repeat(400) } }))!.folded).toBe(true);
  });
});

describe("files", () => {
  it("to your Google Drive's Cobra/<project>", () => {
    const v = aa.actionView(approval({
      channel: "file", summary: "Report",
      files: { to: "drive", label: "your Google Drive", path: "Cobra/paws", items: [file("out/report.pdf", 2_400_000)], text: "For your records." },
    }))!;
    expect(v.word).toBe("FILES");
    expect(v.fields).toEqual([["To", "Your Google Drive, in Cobra/paws"]]);
    expect(v.filesLabel).toBe("Files");
    expect(v.files[0].size).toBe("2.3 MB");
    expect(v.text).toBe("For your records.");
    expect(aa.allowLine(v)).toBe("Allow puts these files in your Drive.");
  });

  it("to a local folder, by its label and path", () => {
    const v = aa.actionView(approval({
      channel: "file", summary: "Copy",
      files: { to: "shared", label: "Shared folder", path: "/home/me/Shared", items: [file("a.txt", 5)] },
    }))!;
    expect(v.fields).toEqual([["To", "Shared folder (/home/me/Shared)"]]);
    expect(v.text).toBe("");
    expect(aa.allowLine(v)).toBe("Allow copies these files there.");
  });

  it("a folder keyed drive with an absolute path is a local folder", () => {
    expect(aa.whereWords({ to: "drive", label: "Drive", path: "/mnt/drive" })).toBe("Drive (/mnt/drive)");
    expect(aa.whereWords({ to: "x", label: "", path: "C:\\Exports" })).toBe("C:\\Exports");
  });
});

describe("a note", () => {
  it("its text and attachments; nothing is sent", () => {
    const v = aa.actionView(approval({ channel: "note", summary: "Missing", note: { text: "Two timesheets are missing.", attachments: [file("out/m.md", 300)] } }))!;
    expect([v.word, v.fields.length, v.text, v.files.length]).toEqual(["NOTE", 0, "Two timesheets are missing.", 1]);
    expect(aa.allowLine(v)).toBe("Nothing is sent: Allow marks it read.");
  });
});

describe("formatBytes", () => {
  it("B, KB, MB", () => {
    expect([0, 1023, 1536, 20_000, 1_048_576 * 3.25, 1_048_576 * 15, -4, null].map(aa.formatBytes))
      .toEqual(["0 B", "1023 B", "1.5 KB", "20 KB", "3.3 MB", "15 MB", "0 B", "0 B"]);
  });
});
