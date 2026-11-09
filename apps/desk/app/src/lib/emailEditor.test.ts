import { describe, expect, it } from "vitest";

import { blankTemplate, moveBlock, newBlock, readData, removeBlock, setField, slugOf } from "./emailEditor";

describe("the email block editor", () => {
  it("moves, removes and adds blocks", () => {
    const blocks = blankTemplate("transactional").blocks;
    expect(moveBlock(blocks, 1, -1).map((b) => b.kind)).toEqual(["text", "header", "footer"]);
    expect(moveBlock(blocks, 2, 1).map((b) => b.kind)).toEqual(["header", "text", "footer"]);
    expect(removeBlock(blocks, 1).map((b) => b.kind)).toEqual(["header", "footer"]);
    expect(newBlock("image", [])).toBeNull();
    expect(newBlock("image", ["studio.png"])).toEqual({ kind: "image", image: { src: "images/studio.png", alt: "" } });
    expect(newBlock("divider", [])).toEqual({ kind: "divider" });
    expect(newBlock("nope", [])).toBeNull();
  });
  it("sets a field, and empty takes it away", () => {
    expect(setField({ kind: "text", body: "a" }, "heading", "Hi")).toEqual({ kind: "text", body: "a", heading: "Hi" });
    expect(setField({ kind: "text", body: "a", heading: "Hi" }, "heading", "")).toEqual({ kind: "text", body: "a" });
    expect(setField({ kind: "header", logo: true }, "logo", false)).toEqual({ kind: "header" });
  });
  it("reads data fields and makes slugs", () => {
    expect(readData('[{"label":"A","value":"B"}]')).toEqual({ ok: true, value: [{ label: "A", value: "B" }] });
    expect(readData("[").ok).toBe(false);
    expect(slugOf("Thanks for writing!")).toBe("thanks-for-writing");
    expect(slugOf("Été 2026 — News")).toBe("ete-2026-news");
  });
});
