import { test } from "node:test";
import assert from "node:assert/strict";

import type { TemplateData } from "./renderTypes.ts";
import { formatMoney, renderTemplate, TemplateError, TEMPLATE_HELPERS } from "./template.ts";

const data = (over: Partial<TemplateData> = {}): TemplateData => ({
  business: { id: 1, legal_name: "Acme & Sons Ltd", currency: "GBP", logo_path: "assets/logo.png" },
  rows: [
    { id: 1, name: "Ada <Lovelace>", hours: 37.5, net_cents: 123456, status: "closed", period: "2026-10-01" },
    { id: 2, name: "Brian O'Neil", hours: 40, net_cents: 7, status: "open", period: "2026-10-08" },
    { id: 3, name: "Cy", hours: null, net_cents: null, status: "closed", period: null },
  ],
  row: { id: 1, name: "Ada <Lovelace>", hours: 37.5, net_cents: 123456, status: "closed", period: "2026-10-01" },
  args: { period: "October 2026", note: 'say "hi"' },
  now: "2026-10-18T14:05:00Z",
  project: { id: "p1", name: "Northstar Payroll" },
  split: null,
  ...over,
});

const render = (source: string, over: Partial<TemplateData> = {}, options?: Parameters<typeof renderTemplate>[2]) => renderTemplate(source, data(over), options);

/** The TemplateError a render throws. */
function caught(source: string): TemplateError {
  try {
    render(source);
  } catch (error) {
    assert.ok(error instanceof TemplateError, `a TemplateError, not ${String(error)}`);
    return error;
  }
  assert.fail(`${source} rendered`);
}

test("every substitution is HTML-escaped, whatever produced it", () => {
  assert.equal(render("{{row.name}}"), "Ada &lt;Lovelace&gt;");
  assert.equal(render("{{business.legal_name}}"), "Acme &amp; Sons Ltd");
  assert.equal(render("{{args.note}}"), "say &quot;hi&quot;");
  assert.equal(render("{{#each rows}}{{name}};{{/each}}"), "Ada &lt;Lovelace&gt;;Brian O&#39;Neil;Cy;");
  assert.equal(render("{{upper row.name}}"), "ADA &lt;LOVELACE&gt;");
  assert.equal(render('{{default row.missing "<b>none</b>"}}'), "&lt;b&gt;none&lt;/b&gt;");
  assert.equal(render('{{join rows "name" "<br>"}}'), "Ada &lt;Lovelace&gt;&lt;br&gt;Brian O&#39;Neil&lt;br&gt;Cy");
  // There is no raw output: a triple-stache is refused by name.
  assert.match(caught("\n{{{row.name}}}").message, /^line 2: {{{ }}} is not supported/);
});

test("paths: dotted, missing, null, args, project, now", () => {
  assert.equal(render("{{project.name}}|{{args.period}}|{{now}}"), "Northstar Payroll|October 2026|2026-10-18T14:05:00Z");
  assert.equal(render("[{{row.nothing}}][{{nothing.at.all}}][{{row.hours.deeper}}]"), "[][][]");
  assert.equal(render("[{{split}}]"), "[]");
  assert.equal(render("[{{split}}]", { split: 7 }), "[7]");
  assert.equal(render("{{row.hours}} {{row.net_cents}}"), "37.5 123456");
  // A prototype key is not data.
  assert.equal(render("[{{row.constructor}}][{{constructor}}]"), "[][]");
});

test("#each: this, @index, @number, @first, @last, nested lists, outer-scope lookup, nothing for a non-array", () => {
  assert.equal(render("{{#each rows}}{{@number}}.{{name}}{{#if @first}}(first){{/if}}{{#if @last}}(last){{/if}} {{/each}}"), "1.Ada &lt;Lovelace&gt;(first) 2.Brian O&#39;Neil 3.Cy(last) ");
  assert.equal(render("{{#each rows}}{{@index}}{{/each}}"), "012");
  assert.equal(render("{{#each args.list}}[{{this}}]{{/each}}", { args: { list: ["a", "b"] } }), "[a][b]");
  assert.equal(render("{{#each row.name}}x{{/each}}{{#each args.period}}x{{/each}}{{#each nothing}}x{{/each}}"), "");
  // Inside an each, a bare name is the item's, then the outer item's, then the data's.
  assert.equal(render("{{#each rows}}{{name}}/{{business.currency}}/{{args.period}};{{/each}}"), "Ada &lt;Lovelace&gt;/GBP/October 2026;Brian O&#39;Neil/GBP/October 2026;Cy/GBP/October 2026;");
  const nested = render("{{#each args.groups}}{{title}}:{{#each items}}{{@index}}{{this}}{{title}}{{#if @last}}.{{/if}}{{/each}} {{/each}}", {
    args: { groups: [{ title: "A", items: ["x", "y"] }, { title: "B", items: ["z"] }] },
  });
  assert.equal(nested, "A:0xA1yA. B:0zB. ");
  // {{else}} in an each is the empty case.
  assert.equal(render("{{#each args.none}}row{{else}}No rows{{/each}}", { args: { none: [] } }), "No rows");
});

test("#if and #unless with else; falsy is null, undefined, '', 0, false and an empty list", () => {
  const falsy: Record<string, unknown> = { n: null, e: "", z: 0, f: false, l: [] };
  for (const key of Object.keys(falsy)) {
    assert.equal(render(`{{#if args.${key}}}yes{{else}}no{{/if}}`, { args: falsy }), "no", key);
    assert.equal(render(`{{#unless args.${key}}}yes{{else}}no{{/unless}}`, { args: falsy }), "yes", key);
  }
  assert.equal(render("{{#if args.missing}}yes{{else}}no{{/if}}"), "no");
  const truthy: Record<string, unknown> = { s: "x", one: 1, neg: -1, t: true, l: [0], o: {} };
  for (const key of Object.keys(truthy)) {
    assert.equal(render(`{{#if args.${key}}}yes{{else}}no{{/if}}`, { args: truthy }), "yes", key);
    assert.equal(render(`{{#unless args.${key}}}yes{{/unless}}`, { args: truthy }), "", key);
  }
  assert.equal(render("{{#if rows}}has rows{{/if}}"), "has rows");
});

test("(eq a b) inside #if and #unless, and as a helper argument", () => {
  assert.equal(render('{{#each rows}}{{#if (eq status "closed")}}C{{else}}O{{/if}}{{/each}}'), "COC");
  assert.equal(render('{{#each rows}}{{#unless (eq status "closed")}}{{name}}{{/unless}}{{/each}}'), "Brian O&#39;Neil");
  assert.equal(render("{{#each rows}}{{#if (eq @index 1)}}second{{/if}}{{/each}}"), "second");
  assert.equal(render("{{#if (eq row.id 1)}}one{{/if}}{{#if (eq row.id 2)}}two{{/if}}"), "one");
  // A string "1" and the number 1 are the same value; null is never equal to anything but null.
  assert.equal(render('{{#if (eq row.id "1")}}same{{/if}}'), "same");
  assert.equal(render('{{#if (eq row.nothing "")}}eq{{else}}ne{{/if}}'), "ne");
  assert.equal(render('{{default (eq row.status "closed") "x"}}'), "true");
  assert.equal(render('{{#if (eq (upper row.status) "CLOSED")}}deep{{/if}}'), "deep");
});

test("comments render nothing and may span lines", () => {
  assert.equal(render("a{{! a comment }}b{{!\n  two\n  lines }}c"), "abc");
});

test("money: GBP, USD, EUR, other, default currency, negative, null", () => {
  assert.equal(render("{{money row.net_cents}}"), "£1,234.56");
  assert.equal(render('{{money row.net_cents "USD"}}'), "$1,234.56");
  assert.equal(render('{{money row.net_cents "EUR"}}'), "€1,234.56");
  assert.equal(render('{{money row.net_cents "CHF"}}'), "CHF 1,234.56");
  assert.equal(render("{{money row.net_cents}}", { business: { id: 1, currency: "USD" } }), "$1,234.56");
  assert.equal(render("{{money row.net_cents}}", { business: null }), "£1,234.56");
  assert.equal(render("{{money args.n}}", { args: { n: -5 } }), "-£0.05");
  assert.equal(render("{{money args.n}}", { args: { n: 100000000 } }), "£1,000,000.00");
  assert.equal(render("{{money args.n}}", { args: { n: "250" } }), "£2.50");
  assert.equal(render("[{{money args.missing}}][{{money args.n}}]", { args: { n: null } }), "[][]");
  assert.equal(formatMoney(7, "gbp"), "£0.07");
});

test("date and datetime", () => {
  assert.equal(render("{{date row.period}}"), "1 Oct 2026");
  assert.equal(render('{{date "2026-10-18T09:00:00"}}'), "18 Oct 2026");
  assert.equal(render('{{datetime "2026-10-18 14:05:30"}}'), "18 Oct 2026, 14:05");
  // A time with a zone is shown on this computer's clock.
  const local = new Date("2026-10-18T14:05:00Z");
  const expected = `${local.getDate()} Oct ${local.getFullYear()}, ${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
  assert.equal(render("{{datetime now}}"), expected);
  assert.equal(render("[{{date args.missing}}][{{date args.n}}]", { args: { n: null } }), "[][]");
  // Something that is not a date is shown as it is, escaped, rather than hidden.
  assert.equal(render('{{date "next <week>"}}'), "next &lt;week&gt;");
});

test("hours and number", () => {
  assert.equal(render("{{#each rows}}[{{hours hours}}]{{/each}}"), "[37.5][40][]");
  assert.equal(render("{{hours args.n}}", { args: { n: 8.125 } }), "8.13");
  assert.equal(render("{{hours args.n}}", { args: { n: "12.50" } }), "12.5");
  assert.equal(render("{{number row.net_cents}}"), "123,456");
  assert.equal(render("{{number args.n 2}}", { args: { n: 1234.5 } }), "1,234.50");
  assert.equal(render("{{number args.n 0}}", { args: { n: -1234.5 } }), "-1,235");
  assert.equal(render("[{{number args.missing}}]"), "[]");
});

test("sum, moneysum, count, join, upper, lower, default", () => {
  assert.equal(render('{{sum rows "net_cents"}}'), "123463");
  assert.equal(render('{{sum rows "hours"}}'), "77.5");
  assert.equal(render('{{moneysum rows "net_cents"}}'), "£1,234.63");
  assert.equal(render('{{moneysum rows "net_cents" "USD"}}'), "$1,234.63");
  assert.equal(render("{{count rows}}|{{count row}}|{{count args.missing}}"), "3|0|0");
  assert.equal(render('{{join rows "name" ", "}}'), "Ada &lt;Lovelace&gt;, Brian O&#39;Neil, Cy");
  assert.equal(render('{{join rows "period" " / "}}'), "2026-10-01 / 2026-10-08");
  assert.equal(render("{{upper business.currency}} {{lower project.name}}"), "GBP northstar payroll");
  assert.equal(render('{{default row.nothing "n/a"}}|{{default row.name "n/a"}}|{{default args.period "n/a"}}'), "n/a|Ada &lt;Lovelace&gt;|October 2026");
  assert.equal(render('{{default args.empty "n/a"}}', { args: { empty: "" } }), "n/a");
  assert.equal(render('{{default args.zero "n/a"}}', { args: { zero: 0 } }), "0");
});

test("file: a file:// URL through the option, '' without it or when refused", () => {
  const fileUrl = (path: string) => (path === "assets/logo.png" ? "file:///repo/assets/logo.png" : "");
  assert.equal(render('<img src="{{file business.logo_path}}">', {}, { fileUrl }), '<img src="file:///repo/assets/logo.png">');
  assert.equal(render('<img src="{{file business.logo_path}}">'), '<img src="">');
  assert.equal(render('[{{file "../etc/passwd"}}]', {}, { fileUrl }), "[]");
  assert.equal(render("[{{file args.missing}}]", {}, { fileUrl }), "[]");
  assert.equal(render('[{{file "x"}}]', {}, { fileUrl: () => { throw new Error("boom"); } }), "[]");
});

test("a bare word is a path even when it spells a helper's name", () => {
  assert.equal(render("{{#each rows}}{{date}}{{/each}}", { rows: [{ date: "d1" }, { date: "d2" }] }), "d1d2");
  assert.equal(render("[{{count}}]"), "[]");
});

test("an unknown helper names its line", () => {
  const error = caught("line one\nline two\n{{bogus row.name}}");
  assert.equal(error.line, 3);
  assert.match(error.message, /^line 3: unknown helper "bogus"/);
  assert.match(error.message, /money/);
  const inIf = caught("\n\n\n\n{{#if (nope 1)}}x{{/if}}");
  assert.equal(inIf.line, 5);
});

test("unbalanced blocks name their line", () => {
  const unclosed = caught("a\n{{#each rows}}\n{{name}}\n");
  assert.equal(unclosed.line, 2);
  assert.match(unclosed.message, /{{#each}} is never closed/);
  const wrong = caught("{{#if rows}}\n\n{{/each}}");
  assert.equal(wrong.line, 3);
  assert.match(wrong.message, /closes the {{#if}} opened on line 1; write {{\/if}}/);
  const stray = caught("x\n{{/if}}");
  assert.equal(stray.line, 2);
  assert.match(stray.message, /closes nothing/);
  const elseOut = caught("{{else}}");
  assert.match(elseOut.message, /line 1: {{else}} outside a block/);
  const twice = caught("{{#if rows}}{{else}}\n{{else}}{{/if}}");
  assert.equal(twice.line, 2);
  const open = caught("\n{{row.name");
  assert.equal(open.line, 2);
  assert.match(open.message, /never closed/);
  const unknownBlock = caught("{{#with row}}{{/with}}");
  assert.match(unknownBlock.message, /unknown block {{#with}}/);
  const badArg = caught("\n\n{{money row.net_cents $x}}");
  assert.equal(badArg.line, 3);
  const badVar = caught("{{#each rows}}{{@nope}}{{/each}}");
  assert.match(badVar.message, /unknown variable @nope/);
});

test("strings with escapes and the helper list", () => {
  assert.equal(render('{{default row.nothing "say \\"hi\\""}}'), "say &quot;hi&quot;");
  assert.deepEqual([...TEMPLATE_HELPERS].sort(), ["count", "date", "datetime", "default", "eq", "file", "hours", "join", "lower", "money", "moneysum", "number", "sum", "upper"]);
});
