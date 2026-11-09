import { describe, expect, it } from "vitest";

import { copyHeading, copyNote, copyWordsProblem, emailPreviewLabel, emailPreviewNote, stepCopy } from "./email";

describe("branded email cards", () => {
  it("a template card and a branded send have a button to the drawn email; others do not", () => {
    expect(emailPreviewLabel({ kind: "email_template", emailTemplate: { name: "Booking" } })).toBe("See the email");
    expect(emailPreviewLabel({ kind: "action", action: { channel: "branded", branded: { subject: "Hi" } } })).toBe("See the email as it will go");
    expect(emailPreviewLabel({ kind: "action", action: { channel: "campaign", campaign: { count: 40 } } })).toBe("See one copy");
    expect(emailPreviewLabel({ kind: "action", action: { channel: "sequence", sequence: { name: "Welcome" } } })).toBe("See the first email");
    expect(emailPreviewLabel({ kind: "action", action: { channel: "batch", batch: { copies: [] } } })).toBe("See each copy");
    expect(emailPreviewLabel({ kind: "action", action: { channel: "email" } })).toBeNull();
    expect(emailPreviewLabel({ kind: "email_template" })).toBeNull();
    expect(emailPreviewLabel(null)).toBeNull();
  });
  it("says whether the values are samples", () => {
    expect(emailPreviewNote(true)).toMatch(/sample/);
    expect(emailPreviewNote(false)).toMatch(/Exactly/);
  });
  it("an outreach batch's copies: which one, stepping, what the words may be, and the note", () => {
    const copy = { index: 2, count: 30, to: "a@x.example", name: "Ana", send: true, edited: false, subject: "Hi", body: "Hello" };
    expect(copyHeading(copy)).toBe("3 of 30 · Ana");
    expect(stepCopy(0, 30, -1)).toBeNull();
    expect(stepCopy(2, 30, 1)).toBe(3);
    expect(copyWordsProblem("s", "x".repeat(4001))).toBe("The words are at most 4,000 characters.");
    expect(copyWordsProblem("s", "x")).toBeNull();
    expect(copyNote({ ...copy, send: false, edited: true })).toBe("Unticked: it will not go. You changed its words.");
  });
});
