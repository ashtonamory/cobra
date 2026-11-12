import { describe, expect, it } from "vitest";
import { specialistText } from "./specialistCard.ts";

describe("a change to a specialist", () => {
  it("is drawn whole, however long", () => {
    const body = `Cobra wants to change Rosa.\n\nYour standing instructions for it, now:\n${"Write in Spanish. ".repeat(400)}`;
    expect(specialistText({ kind: "specialist", body })).toBe(body);
  });

  it("is no other kind of card", () => {
    expect(specialistText({ kind: "trade", body: "x" })).toBeNull();
    expect(specialistText({ kind: "specialist", body: "  " })).toBeNull();
    expect(specialistText(null)).toBeNull();
  });
});
