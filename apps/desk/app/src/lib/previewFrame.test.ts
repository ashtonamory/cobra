// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { PREVIEW_CSP, PREVIEW_SANDBOX, withPreviewPolicy } from "./previewFrame.ts";

const META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;

describe("previewFrame", () => {
  it("the sandbox allows nothing", () => {
    expect(PREVIEW_SANDBOX).toBe("");
  });

  it("the policy runs no script and loads nothing but images, fonts and inline styles", () => {
    const parts = Object.fromEntries(PREVIEW_CSP.split(/;\s*/).map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
    expect(parts["default-src"]).toEqual(["'none'"]);
    expect(parts["script-src"]).toBeUndefined();
    expect(parts["style-src"]).toEqual(["'unsafe-inline'"]);
    expect(parts["img-src"]).toEqual(["data:", "https:"]);
    expect(parts["base-uri"]).toEqual(["'none'"]);
    expect(parts["form-action"]).toEqual(["'none'"]);
    expect(PREVIEW_CSP).not.toMatch(/unsafe-eval|script-src|connect-src|frame-src|'self'|\*/);
  });

  it("puts the policy first, after the doctype", () => {
    const email = '<!doctype html><html lang="en"><head><meta charset="utf-8"><base href="https://evil.example/"><script>x</script></head><body>Hi</body></html>';
    expect(withPreviewPolicy(email)).toBe(`<!doctype html>${META}<html lang="en"><head><meta charset="utf-8"><base href="https://evil.example/"><script>x</script></head><body>Hi</body></html>`);
    expect(withPreviewPolicy("  <!-- a --><!DOCTYPE html><p>x")).toBe(`  <!-- a --><!DOCTYPE html>${META}<p>x`);
    expect(withPreviewPolicy("<p>no doctype</p>")).toBe(`${META}<p>no doctype</p>`);
    expect(withPreviewPolicy("")).toBe(META);
  });

  it("the policy is the head's first element when parsed", () => {
    const doc = new DOMParser().parseFromString(withPreviewPolicy('<!doctype html><html lang="fr"><head><script>1</script></head><body>x</body></html>'), "text/html");
    expect(doc.head.firstElementChild?.outerHTML).toBe(META);
    expect(doc.documentElement.lang).toBe("fr");
    expect(doc.compatMode).toBe("CSS1Compat");
  });
});
