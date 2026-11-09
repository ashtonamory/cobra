// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { THEME_KEY, applyPref, parsePref, readPref, savePref } from "./theme.ts";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("the desk's appearance", () => {
  it("only light and dark are choices kept; anything else is System", () => {
    expect(parsePref("light")).toBe("light");
    expect(parsePref("dark")).toBe("dark");
    for (const odd of [null, undefined, "", "system", "sepia", "LIGHT"]) expect(parsePref(odd)).toBe("system");
  });

  it("a choice is put on the page, and System takes it off so the system decides", () => {
    applyPref("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    applyPref("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyPref("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("saving keeps it for the next start, and System clears it", () => {
    savePref("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    expect(readPref()).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    savePref("system");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(readPref()).toBe("system");
  });
});
