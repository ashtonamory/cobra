import { describe, expect, it } from "vitest";
import * as attach from "./attach.ts";

// The Upload cases of tests/test_attach.py exercise api.attach over HTTP and are not ported here.
describe("Rules", () => {
  it("the path goes after the text on one line", () => {
    expect(attach.withImage("what is wrong\nwith this?", "/p/.cobra-attachments/x.png")).toBe(
      "what is wrong with this? [Image: /p/.cobra-attachments/x.png]");
    expect(attach.withImage("  ", "/p/x.png")).toBe("[Image: /p/x.png]");
  });

  it("the text is shortened, never the path", () => {
    const path = "/home/a/p/.cobra-attachments/20261009-101010-0123abcd.jpg";
    const message = attach.withImage("x".repeat(5000), path);
    expect(message.length).toBe(attach.MAX_SAY);
    expect(message.endsWith(`… [Image: ${path}]`)).toBe(true);
  });

  it("only the four image types", () => {
    for (const name of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp"]) expect(attach.problem(name), name).toBeNull();
    expect(attach.problem("/home/a/IMG_0001.HEIC")).toContain("HEIC");
    expect(attach.problem("notes.pdf")).toContain("Only PNG");
    expect(attach.problem("notes")).toContain("Only PNG");
  });
});
