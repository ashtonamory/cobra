import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { expandSections, fillHtml, htmlEscape } from "../../../../packages/contracts/src/emailHtml.ts";
import { convertDesign, type DesignOptions } from "./emailDesign.ts";

const TEMPLATES = new URL("../../designer/templates/", import.meta.url);
const noImages: DesignOptions["image"] = () => ({ error: "no images here" });

/** Each shipped email template's fields, as its description names them. */
const FIELDS: Record<string, { kind: "transactional" | "marketing"; fields: Record<string, { list?: boolean }> }> = {
  "email-receipt": { kind: "transactional", fields: { amount: {}, invoice_number: {}, paid_on: {}, balance: {}, lines: { list: true } } },
  "email-invoice": { kind: "transactional", fields: { invoice_number: {}, amount_due: {}, due_date: {}, how_to_pay: {}, lines: { list: true }, note: {} } },
  "email-booking": { kind: "transactional", fields: { what: {}, date: {}, time: {}, place: {} } },
  "email-form-reply": { kind: "transactional", fields: { reply_within: {}, signed: {} } },
  "email-outreach": { kind: "marketing", fields: { subject: {}, body: {} } },
  "email-newsletter": { kind: "marketing", fields: {} },
};

let ids = 0;
const id = () => `n_t${String(++ids).padStart(9, "0")}`;
const text = (content: string, extra: Record<string, unknown> = {}) => ({ id: id(), name: "Words", kind: "text", content, fills: [{ type: "solid", color: "#111111" }], style: { font_family: "Inter", font_size: 16 }, ...extra });
const frame = (name: string, children: unknown[], extra: Record<string, unknown> = {}) => ({ id: id(), name, kind: "frame", layout: { direction: "column", gap: 8, padding: [0, 40, 0, 40] }, children, ...extra });
const doc = (children: unknown[], width = 600) => ({ pages: [{ id: "p_page000001", children: [{ id: id(), name: "Email", kind: "frame", width, fills: [{ type: "solid", color: "#ffffff" }], layout: { direction: "column", gap: 0 }, children }] }] });
const footer = frame("Footer", [text("{{address}}"), text("Unsubscribe", { name: "link:{{unsubscribe_url}}" })]);
const convert = (children: unknown[], options: Partial<DesignOptions> = {}, width?: number) =>
  convertDesign(doc(children, width), { image: noImages, subject: "Hello", kind: "marketing", ...options });

test("every shipped email template makes an email to the standard, with no problem", () => {
  const shipped = readdirSync(TEMPLATES).filter((f) => f.startsWith("email-")).map((f) => f.replace(".tessel.json", ""));
  assert.deepEqual(shipped.sort(), Object.keys(FIELDS).sort(), "each email template has its fields here");
  for (const name of shipped) {
    const design = JSON.parse(readFileSync(new URL(`${name}.tessel.json`, TEMPLATES), "utf8"));
    assert.equal(design.pages[0].children[0].width, 600, name);
    const made = convertDesign(design, { image: noImages, subject: name, preheader: "A line.", ...FIELDS[name]! });
    assert.deepEqual(made.errors, [], name);
    assert.deepEqual(made.warnings, [], name);
    assert.ok(made.bytes < 40_000, `${name} is ${made.bytes} bytes`);
    assert.match(made.html, /@media \(max-width:620px\)/, name);
    if (FIELDS[name]!.kind === "marketing") assert.match(made.html, /<a href="\{\{unsubscribe_url\}\}"/, name);
    for (const field of Object.keys(FIELDS[name]!.fields)) assert.ok(made.html.includes(`{{${field}`) || made.html.includes(`{{#${field}}}`) || field === "subject", `${name} uses ${field}`);
  }
});

test("a receipt's rows: repeat:lines repeats per row, if: and ifnot: draw by whether a field has a value", () => {
  const design = JSON.parse(readFileSync(new URL("email-invoice.tessel.json", TEMPLATES), "utf8"));
  const made = convertDesign(design, { image: noImages, subject: "Invoice", ...FIELDS["email-invoice"]! });
  assert.match(made.html, /\{\{#lines\}\}[\s\S]*\{\{item\}\}[\s\S]*\{\{\/lines\}\}/);
  const values = { lines: [{ item: "Walk <long>", qty: "2", amount: "$40" }, { item: "Bath", amount: "$15" }], note: "" };
  const drawn = expandSections(made.html, values, {}, new Set(["lines"]), htmlEscape);
  assert.match(drawn, /Walk &lt;long&gt; × 2/);
  assert.match(drawn, /Bath × 1/, "a row's fallback");
  assert.doesNotMatch(drawn, /\{\{note\}\}/, "no note, no callout");
  assert.match(expandSections(made.html, { ...values, note: "Thanks" }, {}, new Set(["lines"]), htmlEscape), /\{\{note\}\}/);
  assert.match(fillHtml(drawn, { invoice_number: "7" }, {}, htmlEscape).text, /Invoice 7/);

  assert.match(convert([frame("repeat:lines", [text("{{item}}")]), footer]).errors.join("\n"), /lines is not a list field/);
  assert.match(convert([frame("ifnot:note", [text("Nothing to add")]), footer], { fields: { note: {} } }).html, /\{\{\^note\}\}/);
});

test("what email cannot draw is refused, each with what to do instead", () => {
  const errors = (children: unknown[], width?: number) => convert([...children, footer], {}, width).errors.join("\n");
  assert.match(errors([text("x", { layout_child: { position: "absolute" } })]), /placed absolutely/);
  assert.match(errors([{ id: id(), name: "Star", kind: "vector" }]), /vectors cannot be drawn/);
  assert.match(errors([{ id: id(), name: "Bits", kind: "group", children: [] }]), /make it an auto-layout frame/);
  assert.match(errors([{ id: id(), name: "Card", kind: "instance" }]), /detach it/);
  assert.match(errors([{ id: id(), name: "Loose", kind: "frame", children: [] }]), /turn on auto-layout/);
  assert.match(errors([], 400), /is 400 px wide; an email is 600/);
  assert.match(errors([text("Go", { name: "link:javascript:alert(1)" })]), /a link is https/);
  assert.match(errors([text("[here](http://x.dev)")]), /is not https/);
  assert.match(errors([{ id: id(), name: "Pic", kind: "image", asset: "abc.png", width: 200, height: 100 }]), /Pic.*no images here/);
  assert.match(convertDesign({ pages: [] }, { image: noImages, subject: "x", kind: "transactional" }).errors[0]!, /no frame/);
  assert.match(convert([frame("Body", [text("Hi")])]).errors.join("\n"), /unsubscribe link/, "the standard's own checks run too");
});

test("buttons, links, words and images come out as email draws them", () => {
  const button = { id: id(), name: "link:https://example.com/book", kind: "frame", semantic: "button", fills: [{ type: "solid", color: "#ff5500" }], corner_radius: 8, layout: { direction: "row", padding: [12, 24, 12, 24] }, children: [text("Book <now>", { fills: [{ type: "solid", color: "#ffffff" }] })] };
  const images: string[] = [];
  const made = convert(
    [
      frame("Top", [
        text("Hello **you** and [read this](https://example.com/a?b=1&c=2)\nsecond line", { semantic: "h1" }),
        button,
        { id: id(), name: "A dog on a beach", kind: "image", asset: "abc123.png", width: 1040, height: 520 },
        { id: id(), name: "decoration", kind: "image", asset: "def456.png", width: 100, height: 100 },
      ]),
      frame("Side", [text("Left", { layout_child: { width: "fill" } }), text("Right", { layout_child: { width: "hug" } })], { layout: { direction: "row", gap: 12, padding: [0, 0, 0, 0] }, semantic: "columns" }),
      footer,
    ],
    {
      image: (asset) => {
        images.push(asset);
        return { file: `images/x-${asset}` };
      },
    },
  );
  assert.deepEqual(made.errors, []);
  assert.match(made.html, /<h1 [^>]*>Hello <b>you<\/b> and <a href="https:\/\/example\.com\/a\?b=1&amp;c=2"[^>]*>read this<\/a><br>second line<\/h1>/);
  assert.match(made.html, /bgcolor="#ff5500"[^>]*><a class="bt" href="https:\/\/example\.com\/book"[^>]*>Book &lt;now&gt;<\/a>/);
  assert.match(made.html, /<img src="images\/x-abc123\.png" width="520" height="260" alt="A dog on a beach"/, "a wide image fits its column, its height kept in proportion");
  assert.match(made.html, /<img src="images\/x-def456\.png" width="100" height="100" alt=""/);
  assert.deepEqual(made.images, ["images/x-abc123.png", "images/x-def456.png"]);
  assert.match(made.html, /<td class="st"[^>]*>.*Left/, "columns stack on a phone");
  assert.match(made.html, /\.st\{display:block!important/);
  assert.match(made.html, /<a href="\{\{unsubscribe_url\}\}" style="color:inherit;text-decoration:underline">Unsubscribe<\/a>/);
  assert.match(made.html, /<title>Hello<\/title>/);
});
