import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkDraft } from "./check.ts";
import { reportToHtml } from "./html.ts";
import { parseDraft } from "./prompt.ts";

const parsed = parseDraft(readFileSync(new URL("./fixtures/legion-linger.json", import.meta.url), "utf8"));
if (!parsed.ok) throw new Error(parsed.error);
const report = { ...parsed.draft, check: checkDraft(parsed.draft), revised: false };

test("the printable page escapes text, keeps code, and puts a CAUTION before its step", () => {
  const html = reportToHtml({ ...report, title: "Boot <before> login" }, { svgs: ["<svg id='x'></svg>"], date: "5 October 2026", checkLabel: "STE structure ✓" });
  assert.match(html, /<h1>Boot &lt;before&gt; login<\/h1>/);
  assert.match(html, /<code>sudo loginctl enable-linger \$USER<\/code>/);
  assert.ok(html.indexOf('class="safety caution"') < html.indexOf("enable-linger"));
  assert.match(html, /<div class="svg"><svg id='x'><\/svg><\/div>/);
  assert.match(html, /STE structure ✓/);
});

test("a diagram that could not be drawn prints its source", () => {
  const html = reportToHtml(report, { svgs: [null] });
  assert.match(html, /<pre>flowchart TD/);
  assert.match(html, /&quot;Legion starts&quot;/);
});
