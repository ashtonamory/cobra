// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  emailPreview: async () => ({ subject: "Hello", html: '<!doctype html><html><head><script>parent.postMessage(1,"*")</script></head><body><a href="javascript:alert(1)">x</a></body></html>', text: "", sample: true }),
  editBatchCopy: async () => ({}),
}));

const { PreviewFrame } = await import("./PreviewFrame.tsx");
const { EmailPreviewDialog } = await import("./EmailPreview.tsx");
const { PREVIEW_CSP } = await import("../lib/previewFrame.ts");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});

async function draw(node: React.ReactNode): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await act(async () => {});
  return host;
}

function checkFrame(frame: HTMLIFrameElement | null) {
  expect(frame).not.toBeNull();
  // Present and empty: every allow-* off, allow-scripts and allow-same-origin above all.
  expect(frame!.hasAttribute("sandbox")).toBe(true);
  expect(frame!.getAttribute("sandbox")).toBe("");
  expect(frame!.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(frame!.hasAttribute("src")).toBe(false);
  const doc = frame!.getAttribute("srcdoc") ?? "";
  expect(doc.indexOf(META)).toBeGreaterThanOrEqual(0);
  expect(doc.indexOf(META)).toBeLessThan(doc.search(/<html|<head|<script|<body/i) === -1 ? Infinity : doc.search(/<html|<head|<script|<body/i));
}

describe("PreviewFrame", () => {
  it("is a frame with an empty sandbox and the policy first", async () => {
    const page = await draw(<PreviewFrame title="Email" html="<!doctype html><html><head><script>1</script></head><body>Hi</body></html>" />);
    checkFrame(page.querySelector("iframe"));
  });

  it("the email card's preview draws in it", async () => {
    const page = await draw(<EmailPreviewDialog machine="here" approval="ap_1" onClose={() => {}} />);
    const frames = page.querySelectorAll("iframe");
    expect(frames.length).toBe(1);
    checkFrame(frames[0]);
    // The page's own script is still in the page, but the policy is above it and the sandbox runs none.
    expect(frames[0].getAttribute("srcdoc")).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy"/);
  });
});

declare global {
  interface ImportMeta {
    glob(pattern: string[], options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
  }
}

describe("the desk draws generated HTML only in PreviewFrame", () => {
  // Every source file of the desk, tests left out, as text (Vite reads them).
  const raw = import.meta.glob(["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx"], { query: "?raw", import: "default", eager: true });
  const files = Object.entries(raw).map(([path, text]) => ({ path: path.replace(/^\.\//, "components/").replace(/^\.\.\//, ""), text }));
  const join = (...parts: string[]) => parts.join("/");

  it("reads the whole desk", () => {
    expect(files.length).toBeGreaterThan(100);
    for (const path of ["main.tsx", "components/PreviewFrame.tsx", "components/Chat.tsx", "lib/markdown.ts"]) expect(files.some((f) => f.path === path), path).toBe(true);
  });

  it("no other frame, srcdoc, object or embed", () => {
    for (const f of files) {
      if (f.path === join("components", "PreviewFrame.tsx")) continue;
      expect(f.text, f.path).not.toMatch(/<iframe\b|srcDoc|<object\b|<embed\b|<webview\b/);
    }
  });

  it("each email preview uses it", () => {
    for (const name of ["EmailPreview.tsx", "EmailEditor.tsx", "MarketingBoard.tsx"]) {
      const f = files.find((x) => x.path === join("components", name))!;
      expect(f.text, name).toMatch(/<PreviewFrame\b/);
    }
  });

  it("HTML goes into the desk's own page only from the markdown renderer", () => {
    for (const f of files) {
      for (const [line] of f.text.matchAll(/.*dangerouslySetInnerHTML.*/g)) {
        expect(line, f.path).toMatch(/__html: (toHtml\(|value \})/);
      }
      expect(f.text, f.path).not.toMatch(/\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|document\.write\(/);
    }
  });
});
