import { describe, expect, it } from "vitest";
import { failure, isReceiptFile, plan, problem, readingLine, READ_MAX, sendingLine } from "./receipts.ts";

describe("receipts on the desk", () => {
  it("takes photos and says why anything else cannot go", () => {
    expect(problem("/home/a/Pictures/lunch.JPG")).toBeNull();
    expect(problem("C:\\scans\\fuel.webp")).toBeNull();
    expect(problem("/a/IMG_1.heic")).toContain("HEIC");
    expect(problem("/a/invoice.pdf")).toContain("screenshot");
    expect(problem("/a/notes.txt")).toContain("PNG, JPEG, GIF or WebP");
  });

  it("knows a receipt photo from a statement, for the page's two drops", () => {
    expect(isReceiptFile("/a/r.png")).toBe(true);
    expect(isReceiptFile("/a/r.HEIC")).toBe(true);
    expect(isReceiptFile("/a/bank.csv")).toBe(false);
    expect(isReceiptFile("/a/bank.pdf")).toBe(false);
  });

  it("sends each photo once, and at most what the agent reads in one go", () => {
    const many = Array.from({ length: READ_MAX + 2 }, (_, i) => `/a/r${i}.png`);
    const planned = plan([...many, "/a/r0.png", "/a/x.pdf"]);
    expect(planned.send).toHaveLength(READ_MAX);
    expect(planned.refused).toHaveLength(3);
    expect(planned.refused[0]).toContain(`${READ_MAX} receipts at a time`);
    expect(planned.refused[2]).toContain("x.pdf");
  });

  it("tells the person that a card asks before anything is recorded", () => {
    expect(readingLine(1)).toContain("is reading 1 receipt.");
    expect(readingLine(2)).toContain("is reading 2 receipts. A card will ask you before anything is recorded.");
    expect(sendingLine(0, 1)).toBe("Sending 1 receipt…");
    expect(sendingLine(1, 3)).toBe("Sending receipt 2 of 3…");
  });

  it("puts the agent's refusals in plain words", () => {
    expect(failure(404, "receipts go to a Space")).toContain("no Money yet");
    expect(failure(413, "x")).toContain("over 20 MB");
    expect(failure(415, "x")).toContain("PNG or JPEG");
    expect(failure(500, "the computer is busy")).toBe("the computer is busy");
  });
});
