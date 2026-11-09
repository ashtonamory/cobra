import { describe, expect, it } from "vitest";
import { segments, toHtml, withoutLinks } from "./markdown.ts";

/** Every tag closed in order, every & an entity, no stray < or >: what Pango's parse checked. */
function wellFormed(html: string): boolean {
  const stack: string[] = [];
  const rest = html.replace(/<(\/?)([a-z]+)((?:\s+[a-z-]+="[^"<>]*")*)\s*>/g, (_m, close: string, tag: string) => {
    if (close) {
      if (stack.pop() !== tag) stack.push("!");
    } else stack.push(tag);
    return "";
  });
  return stack.length === 0 && !/[<>]/.test(rest) && !/&(?!(amp|lt|gt|quot|#x27);)/.test(rest);
}

describe("Markdown", () => {
  it("emphasis", () => {
    expect(toHtml("Please **verify** it")).toBe("Please <b>verify</b> it");
    expect(toHtml("an *aside* and _another_")).toBe("an <i>aside</i> and <i>another</i>");
    expect(toHtml("__both__ ~~gone~~")).toBe("<b>both</b> <s>gone</s>");
  });

  it("leaves ordinary asterisks and underscores alone", () => {
    expect(toHtml("read my_var_name and 2*3*4")).toBe("read my_var_name and 2*3*4");
    expect(toHtml("a * b")).toBe("a * b");
  });

  it("escapes markup characters", () => {
    expect(toHtml("if a < b && c > d")).toBe("if a &lt; b &amp;&amp; c &gt; d");
  });

  it("code spans are literal", () => {
    expect(toHtml("run `pnpm **check**` now")).toBe("run <code>pnpm **check**</code> now");
    expect(toHtml("`<div>`")).toBe("<code>&lt;div&gt;</code>");
  });

  it("fenced code", () => {
    expect(toHtml("x\n```bash\necho **hi** <x>\n```\ny")).toBe("x\n<code>echo **hi** &lt;x&gt;</code>\ny");
  });

  it("blocks", () => {
    expect(toHtml("## Done")).toBe('<span class="md-heading md-large">Done</span>');
    expect(toHtml("- one\n  - **two**")).toBe("•  one\n  •  <b>two</b>");
    expect(toHtml("> quoted")).toBe("<i>quoted</i>");
    expect(toHtml("---")).toBe("────────");
    expect(toHtml("| a | b |")).toBe("<code>| a | b |</code>");
  });

  it("links", () => {
    expect(toHtml("see [PR #45](https://github.com/x/y/pull/45?a=1&b=2)")).toBe(
      'see <a href="https://github.com/x/y/pull/45?a=1&amp;b=2">PR #45</a>');
  });

  it("output is well-formed markup (the Python test parsed it as Pango)", () => {
    const sample = "## Plan\n- **verify** the `a<b>` case\n> _note_ & [link](https://x.dev/?q=1&r=2)\n" +
      "```\n<raw> **x**\n```\n2*3 my_var ~~old~~";
    expect(wellFormed(withoutLinks(toHtml(sample)))).toBe(true);
    expect(wellFormed(toHtml(sample, true))).toBe(true);
  });
});

describe("CopyCode", () => {
  it("inline code becomes a copy link only when asked", () => {
    expect(toHtml("run `ls -a`")).toBe("run <code>ls -a</code>");
    expect(toHtml("run `ls -a`", true)).toBe('run <a href="copy:ls%20-a" title="Click to copy"><code>ls -a</code></a>');
  });
});

describe("InMessageCopy", () => {
  it("a link gets a copy glyph only in the chat", () => {
    expect(toHtml("see [PR](https://x.dev/pr/1)")).toBe('see <a href="https://x.dev/pr/1">PR</a>');
    expect(toHtml("see [PR](https://x.dev/pr/1)", true)).toBe(
      'see <a href="https://x.dev/pr/1">PR</a> ' +
      '<a href="copy:https%3A%2F%2Fx.dev%2Fpr%2F1" title="Copy link" class="copylink">' +
      '<span class="md-large">⧉</span></a>');
  });

  it("a bare URL is a link and its full stop is not", () => {
    expect(toHtml("Docs: https://a.dev/x_y/. Done")).toBe('Docs: <a href="https://a.dev/x_y/">https://a.dev/x_y/</a>. Done');
  });

  it("segments cut code blocks out of the prose", () => {
    const text = "Run this:\n```bash\nbash install.sh\nsystemctl --user status cp-desk\n```\nThen **check**.";
    expect(segments(text)).toEqual([
      ["prose", "Run this:"],
      ["code", "bash install.sh\nsystemctl --user status cp-desk"],
      ["prose", "Then <b>check</b>."],
    ]);
  });

  it("an unclosed fence is still a block", () => {
    expect(segments("```\nls")).toEqual([["code", "ls"]]);
  });

  it("prose only", () => {
    expect(segments("all quiet")).toEqual([["prose", "all quiet"]]);
  });
});

describe("Safety (the web build's own)", () => {
  it("only http(s) becomes a link, and quotes cannot leave the attribute", () => {
    expect(toHtml("[x](javascript:alert(1))")).not.toContain("<a");
    expect(toHtml('<img src=x onerror="a">')).toBe('&lt;img src=x onerror="a"&gt;');
    const out = toHtml("[x](https://a.dev/\"onmouseover=\"y)");
    expect(out).not.toContain('"onmouseover');
  });
});

// Phase 2 step 5: the chat's markdown goes into the desk's own page (dangerouslySetInnerHTML), so it must never carry
// a tag or a link that runs anything.
describe("Markdown: outside text stays text", () => {
  const nasty = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    '<iframe src="https://evil.example"></iframe>',
    "<a href=\"javascript:alert(1)\">x</a>",
    "[click](javascript:alert(1))",
    "[click](JaVaScRiPt:alert(1))",
    "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[click](vbscript:msgbox)",
    "javascript:alert(1)",
    "```\n<script>alert(1)</script>\n```",
    "# <script>alert(1)</script>",
    "- <svg onload=alert(1)>",
    "> <style>body{display:none}</style>",
    '[x](https://a.example/"onmouseover="alert(1))',
  ];

  it("drops every tag the text brings and links only http(s)", () => {
    for (const text of nasty) {
      for (const html of [toHtml(text), toHtml(text, true), ...segments(text).filter(([k]) => k === "prose").map(([, v]) => v)]) {
        // Only the tags and attributes the renderer makes itself.
        for (const [, tag, attrs] of html.matchAll(/<([a-z]+)([^>]*)>/gi)) {
          expect(["a", "b", "i", "s", "code", "span"], text).toContain(tag);
          for (const [, name, value] of attrs.matchAll(/\s([a-z-]+)="([^"]*)"/gi)) {
            expect(["href", "title", "class"], text).toContain(name);
            if (name === "href") expect(value, text).toMatch(/^(https?:\/\/|copy:)/);
          }
        }
        expect(wellFormed(html), text).toBe(true);
      }
    }
  });

  it("a quote in a link cannot leave the attribute", () => {
    const html = toHtml('[x](https://a.example/"onmouseover="alert(1))');
    expect(html).toContain("&quot;");
    expect(html).not.toContain('" onmouseover');
  });
});
