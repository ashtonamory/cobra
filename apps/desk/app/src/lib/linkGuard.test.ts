// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installLinkGuard } from "./linkGuard.ts";

const opened: string[] = [];
let undo: (() => void) | null = null;
afterEach(() => {
  undo?.();
  undo = null;
  opened.length = 0;
  document.body.innerHTML = "";
});

function click(href: string, taken = false): MouseEvent {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  const inner = document.createElement("b");
  a.append(inner);
  document.body.append(a);
  if (taken) a.addEventListener("click", (e) => e.preventDefault());
  const e = new MouseEvent("click", { bubbles: true, cancelable: true });
  inner.dispatchEvent(e);
  return e;
}

describe("linkGuard", () => {
  it("a web link opens in the browser, never in the window", () => {
    undo = installLinkGuard(window, (url) => opened.push(url));
    expect(click("https://example.com/a").defaultPrevented).toBe(true);
    expect(opened).toEqual(["https://example.com/a"]);
  });

  it("javascript:, data:, file: and relative links do nothing", () => {
    undo = installLinkGuard(window, (url) => opened.push(url));
    for (const href of ["javascript:alert(1)", " javascript:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd", "/index.html?surface=main", "copy:x"]) {
      expect(click(href).defaultPrevented, href).toBe(true);
    }
    expect(opened).toEqual([]);
  });

  it("a click a page already took is left to it", () => {
    undo = installLinkGuard(window, (url) => opened.push(url));
    click("https://example.com/", true);
    expect(opened).toEqual([]);
  });
});
