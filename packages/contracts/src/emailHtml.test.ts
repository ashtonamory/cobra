import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { checkEmailHtml, EMAIL_STANDARD, expandSections, fillHtml, htmlEscape, htmlMerges, htmlToText } from "./emailHtml.ts";
import { PERSON_FIELDS, templateFields, templateImages, validateTemplate } from "./emailTemplate.ts";

const REFERENCE = readFileSync(new URL("../../../apps/agent/email-standard/reference.html", import.meta.url), "utf8");

/** A small email that meets the standard, to break one rule at a time. */
const page = (body: string, head = "") =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hi</title>` +
  `<style>@media (max-width:620px){.w{width:100%!important}}${head}</style></head><body style="margin:0">` +
  `<div style="display:none;max-height:0;overflow:hidden">Preheader</div>` +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">` +
  `<table role="presentation" class="w" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;font-family:Arial,sans-serif">` +
  `<tr><td style="padding:20px"><p style="margin:0">Hi {{first_name|there}},</p>${body}` +
  `<p style="font-size:11px"><a href="{{unsubscribe_url}}" style="color:#777">Unsubscribe</a> · {{address}}</p></td></tr></table></td></tr></table></body></html>`;
const check = (html: string, kind: "marketing" | "transactional" = "marketing") => checkEmailHtml(html, kind, {}, PERSON_FIELDS);

test("the reference email meets its own standard with no warning", () => {
  const got = check(REFERENCE);
  assert.deepEqual(got.errors, []);
  assert.deepEqual(got.warnings, []);
  assert.deepEqual(got.fields.map((f) => f.name), ["first_name", "address", "unsubscribe_url"]);
  assert.match(EMAIL_STANDARD, /never Haiku/);
});

test("a small email to the standard passes; each broken rule is named", () => {
  assert.deepEqual(check(page("")).errors, []);
  const broken: [string, RegExp][] = [
    [page('<script>alert(1)</script>'), /<script> is not allowed/],
    [page('<a href="https://x.dev" onclick="go()">x</a>'), /event attributes are not allowed: onclick/],
    [page('<a href="#">Book</a>'), /"#" goes nowhere/],
    [page('<a href="http://x.dev">x</a>'), /not an https:\/\/, mailto: or tel: address/],
    [page('<a href="javascript:go()">x</a>'), /javascript: and vbscript: are not allowed/],
    [page('<img src="images/a.png" width="40">'), /1 <img> without alt/],
    [page('<img src="images/a.png" alt="">'), /without a width attribute/],
    [page('<img src="data:image/png;base64,AAA" alt="" width="4">'), /is an images\/<file>/],
    [page('<div style="display:flex">x</div>'), /flexbox, grid, float and position/],
    [page("", "@import url(https://x.dev/a.css);"), /@import is not allowed/],
    [page("<p>{{frist name}}</p>"), /not merge fields: \{\{frist name\}\}/],
    [page("<p>{{plan}}</p>"), /\{\{plan\}\} is neither a People field/],
    [page('<form action="https://x.dev"><input name="a"></form>'), /<form> is not allowed/],
    [page("").replace(/@media[^}]*\}\}/, ""), /no phone layout/],
    [page("").replace(/width="600"/, 'width="900"').replace("width:600px", "width:900px"), /no 600px card/],
    [page("").replace('<meta name="viewport" content="width=device-width,initial-scale=1">', ""), /no <meta name="viewport"/],
    [page("").replace("<!DOCTYPE html>", ""), /starts with <!DOCTYPE html>/],
  ];
  for (const [html, want] of broken) assert.match(check(html).errors.join("\n"), want, String(want));
  assert.match(check(page("").replace('<a href="{{unsubscribe_url}}" style="color:#777">Unsubscribe</a>', "")).errors.join("\n"), /marketing email has an unsubscribe link/);
  assert.match(check(page(""), "transactional").errors.join("\n"), /transactional email has no unsubscribe link/);
  assert.match(check(page("<p>Hi [name]</p>")).warnings.join("\n"), /"\[name\]" is a placeholder/);
  assert.match(check(page('<img src="https://x.dev/a.png" alt="" width="4">')).warnings.join("\n"), /loads from another site/);
  assert.ok(check("x".repeat(100 * 1024)).errors.some((e) => /at most 90 KB/.test(e)));
});

test("merge fields: two braces, a fallback, escaped values; one-brace CSS is never a field", () => {
  assert.deepEqual(htmlMerges("a{color:red} {{ first_name | there }} {{plan}} {{first_name}}"), [{ name: "first_name", fallback: "there" }, { name: "plan" }]);
  const filled = fillHtml("Hi {{first_name|there}}, {{plan}} {{x}}", { first_name: "<b>Ana</b>" }, { plan: "Pro" }, htmlEscape);
  assert.equal(filled.text, "Hi &lt;b&gt;Ana&lt;/b&gt;, Pro ");
  assert.deepEqual(filled.missing, ["x"]);
  assert.equal(fillHtml("Hi {{first_name|there}},", { first_name: "  " }, {}, htmlEscape).text, "Hi there,");
});

test("a designed template: html in place of blocks, checked, with its fields and images", () => {
  const good = validateTemplate({ version: 1, name: "Agents", kind: "marketing", subject: "For you, {{first_name|there}}", fields: { plan: { default: "Pro" } }, html: page('<p>{{plan}}</p><img src="images/a.png" alt="" width="40">') });
  assert.ok(good.ok, good.ok ? "" : good.errors.join("\n"));
  if (good.ok) {
    assert.deepEqual(templateFields(good.template), ["first_name", "plan"]);
    assert.deepEqual(templateImages(good.template), ["images/a.png"]);
  }
  const both = validateTemplate({ version: 1, name: "A", kind: "marketing", subject: "x", html: page(""), blocks: [{ kind: "footer" }] });
  assert.ok(!both.ok && both.errors.some((e) => /blocks or html, not both/.test(e)));
  const brace = validateTemplate({ version: 1, name: "A", kind: "marketing", subject: "Hi {first_name}", html: page("") });
  assert.ok(!brace.ok && brace.errors.some((e) => /two braces/.test(e)));
  const bad = validateTemplate({ version: 1, name: "A", kind: "marketing", subject: "x", html: page("<script></script>") });
  assert.ok(!bad.ok && bad.errors.some((e) => e.startsWith("html: <script>")));
});

test("the plain-text part reads the email: no head or preheader, links with their address", () => {
  const text = htmlToText('<html><head><title>T</title><style>p{color:red}</style></head><body><div style="display:none">pre&#847;</div><h1>Big&nbsp;news</h1><p>Line<br>two &amp; more</p><a href="https://x.dev/b">Book now</a> <a href="https://x.dev/">x.dev</a><img src="a" alt="A phone"></body></html>');
  assert.equal(text, "Big news\n\nLine\ntwo & more\n\nBook now: https://x.dev/b https://x.dev/ [A phone]\n");
});

test("sections: a list's rows repeat with their own fields; an optional part shows only with a value", () => {
  const lists = new Set(["lines"]);
  const html = "<table>{{#lines}}<tr><td>{{item}}</td><td>{{qty|1}}</td><td>{{amount}}</td></tr>{{/lines}}{{^lines}}<tr><td>Nothing</td></tr>{{/lines}}</table>{{#note}}<p>{{note}}</p>{{/note}}{{^note}}<p>No note</p>{{/note}}";
  const rows = [{ item: "Walk <30 min>", amount: "$20" }, { item: "{{unsubscribe_url}}", qty: "2", amount: "$5" }];
  const drawn = expandSections(html, { lines: rows, note: "" }, {}, lists, htmlEscape);
  assert.equal(drawn, "<table><tr><td>Walk &lt;30 min&gt;</td><td>1</td><td>$20</td></tr><tr><td>&#123;&#123;unsubscribe_url&#125;&#125;</td><td>2</td><td>$5</td></tr></table><p>No note</p>");
  assert.equal(expandSections(html, { lines: [], note: "Thanks" }, {}, lists, htmlEscape), "<table><tr><td>Nothing</td></tr></table><p>{{note}}</p>");
  assert.deepEqual(htmlMerges(html, lists).map((f) => f.name), ["lines", "note"], "row fields are the rows', not the template's");

  const ok = checkEmailHtml(page(`<table role="presentation">${"{{#lines}}<tr><td>{{item}}</td><td>{{amount}}</td></tr>{{/lines}}"}</table>`), "marketing", { lines: { list: true } }, PERSON_FIELDS);
  assert.deepEqual(ok.errors, []);
  const bad = (body: string) => checkEmailHtml(page(body), "marketing", { lines: { list: true }, note: {} }, PERSON_FIELDS).errors.join("\n");
  assert.match(bad("<p>{{lines}}</p>"), /\{\{lines\}\} is a list: draw its rows with \{\{#lines\}\}/);
  assert.match(bad("{{#note}}<p>x</p>"), /\{\{#note\}\} is never closed/);
  assert.match(bad("{{#note}}{{#lines}}{{/note}}{{/lines}}"), /sections cannot cross/);
  assert.match(bad("<p>{{item}}</p>"), /\{\{item\}\} is neither a People field/, "a row field outside its list is unknown");
  assert.match(bad("{{#unsubscribe_url}}x{{/unsubscribe_url}}"), /the agent's field, not a section/);

  const receipt = validateTemplate({ version: 1, name: "Receipt", kind: "transactional", subject: "Receipt {{invoice}}", fields: { invoice: {}, lines: { list: true }, total: {} }, html: page("{{#lines}}<p>{{item}} {{amount}}</p>{{/lines}}<p>{{total}}</p>").replace(/<p style="font-size:11px">[\s\S]*?<\/p>/, "") });
  assert.ok(receipt.ok, receipt.ok ? "" : receipt.errors.join("\n"));
  if (receipt.ok) assert.deepEqual(templateFields(receipt.template), ["invoice", "lines", "first_name", "total"]);
});
