import { test } from "node:test";
import assert from "node:assert/strict";

import { fillText, mergeNames, safeHref, templateFields, templateImages, validateTemplate, validateValues, type EmailTemplate } from "./emailTemplate.ts";

const receipt: EmailTemplate = {
  version: 1,
  name: "Class receipt",
  kind: "transactional",
  subject: "Your receipt for {class_name}",
  preheader: "Thanks, {first_name}",
  fields: {
    class_name: { describe: "The class booked" },
    lines: { list: true },
    total: {},
    note: { default: "See you on the mat." },
  },
  blocks: [
    { kind: "header" },
    { kind: "text", heading: "Thanks, {first_name}", body: "{note}" },
    { kind: "receipt", rows: "lines", total: "{total}" },
    { kind: "button", label: "Manage booking", href: "https://example.com/b" },
    { kind: "footer" },
  ],
};

test("a good template passes", () => {
  const check = validateTemplate(receipt);
  assert.equal(check.ok, true, JSON.stringify(check));
});

test("every problem comes back with its path", () => {
  const check = validateTemplate({
    version: 2,
    name: "",
    kind: "loud",
    subject: "Hi {frist_name}",
    blocks: [{ kind: "button", label: "Go", href: "javascript:alert(1)" }, { kind: "footer" }, { kind: "text" }, { kind: "html", html: "<b>" }],
  });
  assert.equal(check.ok, false);
  const errors = check.ok ? [] : check.errors;
  for (const want of ["version:", "name:", "kind:", "blocks[0].href:", "blocks[1]: the footer is the last block", "blocks[2]: a text block", "blocks[3].kind:"]) {
    assert.ok(errors.some((e) => e.startsWith(want)), `${want} in ${errors.join(" | ")}`);
  }
});

test("merge fields must be People fields or declared", () => {
  const check = validateTemplate({ ...receipt, subject: "Hi {frist_name}" });
  assert.equal(check.ok, false);
  assert.match(check.ok ? "" : check.errors.join(), /\{frist_name\} is neither/);
  const bad = validateTemplate({ ...receipt, subject: "Hi { first name }" });
  assert.match(bad.ok ? "" : bad.errors.join(), /is not a merge field/);
});

test("a list field fills only a receipt's rows", () => {
  const check = validateTemplate({ ...receipt, subject: "Lines {lines}" });
  assert.match(check.ok ? "" : check.errors.join(), /\{lines\} is a list/);
  const undeclared = validateTemplate({ ...receipt, blocks: [{ kind: "receipt", rows: "items", total: "1" }] });
  assert.match(undeclared.ok ? "" : undeclared.errors.join(), /"items" must be declared/);
});

test("marketing needs a footer, and only marketing takes a topic", () => {
  const noFooter = validateTemplate({ ...receipt, kind: "marketing", blocks: [{ kind: "text", body: "Hi" }] });
  assert.match(noFooter.ok ? "" : noFooter.errors.join(), /ends with a footer/);
  const topic = validateTemplate({ ...receipt, topic: "news" });
  assert.match(topic.ok ? "" : topic.errors.join(), /topic: is for marketing/);
});

test("images are files in the images folder", () => {
  const check = validateTemplate({ ...receipt, blocks: [{ kind: "hero", image: { src: "https://evil.example/x.png", alt: "x" } }] });
  assert.match(check.ok ? "" : check.errors.join(), /images\/studio.jpg/);
  const ok = validateTemplate({ ...receipt, blocks: [{ kind: "hero", image: { src: "images/studio.jpg", alt: "The studio" } }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(templateImages(ok.ok ? ok.template : receipt), ["images/studio.jpg"]);
});

test("a person field may not be declared", () => {
  const check = validateTemplate({ ...receipt, fields: { ...receipt.fields, first_name: {} } });
  assert.match(check.ok ? "" : check.errors.join(), /comes from People/);
});

test("fillText fills, falls back to the default and lists what is missing", () => {
  const fields = receipt.fields;
  assert.deepEqual(fillText("Hi {first_name}. {note}", { first_name: "Ana" }, fields), { text: "Hi Ana. See you on the mat.", missing: [] });
  assert.deepEqual(fillText("Hi {first_name}", {}, fields), { text: "Hi ", missing: ["first_name"] });
  assert.deepEqual(fillText("{lines}", { lines: [{ item: "a", amount: "1" }] }, fields), { text: "", missing: ["lines"] });
  assert.deepEqual(mergeNames("{a} {b} {a}"), ["a", "b"]);
});

test("templateFields lists subject first and a receipt's list", () => {
  assert.deepEqual(templateFields(receipt), ["class_name", "first_name", "note", "total", "lines"]);
});

test("validateValues checks kinds and refuses unused names", () => {
  const ok = validateValues(receipt, { class_name: "Flow", lines: [{ item: "Flow", qty: "1", amount: "$20" }], total: "$20" });
  assert.equal(ok.ok, true);
  const bad = validateValues(receipt, { class_name: ["x"], lines: "x", other: "y" });
  assert.equal(bad.ok, false);
  const errors = bad.ok ? "" : bad.errors.join(" | ");
  assert.match(errors, /values.class_name/);
  assert.match(errors, /values.lines/);
  assert.match(errors, /does not use \{other\}/);
});

test("safeHref takes https and mailto only", () => {
  assert.equal(safeHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeHref("mailto:a@example.com"), "mailto:a@example.com");
  for (const bad of ["http://example.com", "javascript:alert(1)", "data:text/html,x", "mailto:nobody", "//example.com", "example.com"]) assert.equal(safeHref(bad), null, bad);
});

test("an image block may be centred; any other align is refused", () => {
  const base = { version: 1, name: "Logo", kind: "transactional", subject: "Hi" } as const;
  const ok = validateTemplate({ ...base, blocks: [{ kind: "image", image: { src: "images/logo.png", alt: "Logo" }, align: "center" }] });
  assert.equal(ok.ok, true);
  const bad = validateTemplate({ ...base, blocks: [{ kind: "image", image: { src: "images/logo.png", alt: "Logo" }, align: "right" }] });
  assert.deepEqual(bad.ok ? [] : bad.errors, ['blocks[0].align: is "left" or "center"']);
});
