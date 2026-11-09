import { test } from "node:test";
import assert from "node:assert/strict";

import { validateTemplate, type EmailTemplate } from "../../../../packages/contracts/src/emailTemplate.ts";
import { render, type RenderOptions } from "./emailRender.ts";
import { contrast, fontStack, imageSize, parseTheme, themeFromBrand, themeHash } from "./emailTheme.ts";

const theme = themeFromBrand({
  brand: { colors: { brand: "#0b1f3a", accent: "#f5b301", ink: "#0b1220", paper: "#f6f4ee" }, fonts: { heading: "Playfair Display", body: "Inter" } },
  business: "Example.com",
  address: "1 Main St, Austin TX",
});

const images: RenderOptions["image"] = (file) => ({ src: `cid:${file.replace(/\W/g, "")}@cobra`, width: 1200, height: 600 });

const welcome: EmailTemplate = {
  version: 1,
  name: "Welcome",
  kind: "transactional",
  subject: "Welcome, {first_name}",
  preheader: "Your first class is on us",
  fields: { link: {} },
  blocks: [
    { kind: "header" },
    { kind: "hero", image: { src: "images/studio.jpg", alt: "The studio" } },
    { kind: "text", heading: "Hi {first_name}", body: "Line one\nline two\n\nNew <b>paragraph</b> & more" },
    { kind: "button", label: "Book a class", href: "{link}" },
    { kind: "divider" },
    { kind: "signature", name: "Sam", role: "Owner" },
    { kind: "footer", text: "You booked with us." },
  ],
};

test("themeFromBrand keeps the kit's colours and picks readable button words", () => {
  assert.equal(theme.colors.brand, "#0b1f3a");
  assert.equal(theme.colors.onBrand, "#ffffff");
  assert.ok(contrast(theme.colors.ink, theme.colors.paper) >= 4.5);
  assert.match(theme.fonts.headingStack, /^'Playfair Display', Georgia/);
  assert.match(fontStack("Inter"), /Helvetica/);
  assert.match(fontStack("x'; } body{"), /^'x  body', /);
  const yellow = themeFromBrand({ brand: { colors: { brand: "#f5d000", accent: "#000000", ink: "#111111", paper: "#ffffff" }, fonts: { heading: "Inter", body: "Inter" } }, business: "B" });
  assert.equal(yellow.colors.onBrand, "#111111");
});

test("a dark paper becomes the page around a white email", () => {
  const dark = themeFromBrand({ brand: { colors: { brand: "#ff0066", accent: "#00ffcc", ink: "#ffffff", paper: "#101010" }, fonts: { heading: "Inter", body: "Inter" } }, business: "Night" });
  assert.equal(dark.colors.paper, "#ffffff");
  assert.equal(dark.colors.page, "#101010");
  assert.ok(contrast(dark.colors.ink, dark.colors.paper) >= 4.5);
});

test("no brand kit gives the plain theme; parseTheme reads it back", () => {
  const plain = themeFromBrand({ brand: null, business: "" });
  assert.equal(plain.business, "Your business");
  assert.deepEqual(parseTheme(JSON.parse(JSON.stringify(plain))), plain);
  assert.equal(parseTheme({ ...plain, colors: { ...plain.colors, brand: "red" } }), null);
  assert.equal(themeHash(plain), themeHash(JSON.parse(JSON.stringify(plain))));
});

test("render escapes every text and fills merge fields", () => {
  const out = render(theme, welcome, { first_name: "Ana <script>", link: "https://example.com/book" }, { image: images });
  assert.equal(out.subject, "Welcome, Ana <script>");
  assert.ok(out.html.includes("Hi Ana &lt;script&gt;"));
  assert.ok(!out.html.includes("<script>"));
  assert.ok(out.html.includes("Line one<br>line two"));
  assert.ok(out.html.includes("New &lt;b&gt;paragraph&lt;/b&gt; &amp; more"));
  assert.ok(out.html.includes('href="https://example.com/book"'));
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.missing, []);
  assert.deepEqual(out.images, ["images/studio.jpg"]);
  assert.deepEqual(out.links, [{ href: "https://example.com/book", label: "Book a class" }]);
  assert.match(out.text, /Book a class: https:\/\/example.com\/book/);
  assert.match(out.text, /Example.com · 1 Main St, Austin TX/);
  assert.ok(!out.text.includes("Unsubscribe"));
});

test("render is deterministic, and the hash covers every part", () => {
  const values = { first_name: "Ana", link: "https://example.com/book" };
  const a = render(theme, welcome, values, { image: images });
  const b = render(theme, welcome, values, { image: images });
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.html, b.html);
  const c = render(theme, welcome, { ...values, first_name: "Bo" }, { image: images });
  assert.notEqual(a.sha256, c.sha256);
});

test("a link that fills to something unsafe stops the send", () => {
  const out = render(theme, welcome, { first_name: "Ana", link: "javascript:alert(1)" }, { image: images });
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0]!, /blocks\[3\]\.href/);
  assert.ok(!out.html.includes("javascript:"));
});

test("an image that will not read stops the send; a logo that will not read falls back to words", () => {
  const withLogo = { ...theme, logo: { file: "brand/logo.png", width: 400, height: 100 } };
  const out = render(withLogo, welcome, { first_name: "A", link: "https://a.example" }, { image: () => null });
  assert.deepEqual(out.errors, ["blocks[1]: images/studio.jpg cannot be read"]);
  assert.ok(out.html.includes(">Example.com</p>"));
  const logo = render(withLogo, welcome, { first_name: "A", link: "https://a.example" }, { image: images });
  assert.ok(logo.images.includes("brand/logo.png"));
  assert.match(logo.html, /width="96" height="48" alt="Example.com"/);
});

test("marketing carries an unsubscribe link, and cannot send without one", () => {
  const news: EmailTemplate = { ...welcome, kind: "marketing", topic: "news" };
  const sent = render(theme, news, { first_name: "A", link: "https://a.example" }, { image: images, unsubscribe: "https://example.com/u/abc" });
  assert.deepEqual(sent.errors, []);
  assert.ok(sent.html.includes('href="https://example.com/u/abc"'));
  assert.match(sent.text, /Unsubscribe: https:\/\/example.com\/u\/abc/);
  const none = render(theme, news, { first_name: "A", link: "https://a.example" }, { image: images });
  assert.deepEqual(none.errors, ["marketing email needs an unsubscribe address"]);
  const preview = render(theme, news, { first_name: "A", link: "https://a.example" }, { image: images, preview: true });
  assert.deepEqual(preview.errors, []);
});

test("links go through the click redirect, the card keeps the real address", () => {
  const out = render(theme, welcome, { first_name: "A", link: "https://example.com/book" }, { image: images, link: (href, i) => `https://example.com/c/${i}?to=${encodeURIComponent(href)}` });
  assert.ok(out.html.includes('href="https://example.com/c/0?to=https%3A%2F%2Fexample.com%2Fbook"'));
  assert.equal(out.links[0]!.href, "https://example.com/book");
  assert.match(out.text, /Book a class: https:\/\/example.com\/book/);
});

test("missing values are listed and drawn empty", () => {
  const out = render(theme, welcome, { link: "https://a.example" }, { image: images });
  assert.deepEqual(out.missing, ["first_name"]);
  assert.equal(out.subject, "Welcome,");
});

test("a receipt draws its rows and total", () => {
  const receipt: EmailTemplate = {
    version: 1,
    name: "Receipt",
    kind: "transactional",
    subject: "Receipt",
    fields: { lines: { list: true }, total: {} },
    blocks: [{ kind: "receipt", heading: "Your order", rows: "lines", total: "{total}", note: "Paid by card." }],
  };
  const out = render(theme, receipt, { lines: [{ item: "Flow class", qty: "2", amount: "$40.00" }, { item: "Mat <rental>", amount: "$5.00" }], total: "$45.00" }, { image: images });
  assert.ok(out.html.includes("Flow class"));
  assert.ok(out.html.includes("Mat &lt;rental&gt;"));
  assert.ok(out.html.includes("$45.00"));
  assert.match(out.text, /Flow class x 2 {2}\$40.00/);
  assert.match(out.text, /Total {2}\$45.00/);
  const empty = render(theme, receipt, { total: "$0" }, { image: images });
  assert.deepEqual(empty.missing, ["lines"]);
});

test("every block kind renders", () => {
  const all: EmailTemplate = {
    version: 1,
    name: "All",
    kind: "transactional",
    subject: "All",
    blocks: [
      { kind: "header", text: "Studio" },
      { kind: "hero", image: { src: "images/a.jpg", alt: "A" }, href: "https://a.example" },
      { kind: "text", heading: "H", body: "B", align: "center" },
      { kind: "button", label: "Go", href: "mailto:hi@example.com", align: "center" },
      { kind: "image", image: { src: "images/b.png", alt: "B" }, caption: "Cap" },
      { kind: "columns", items: [{ image: { src: "images/c.png", alt: "C" }, heading: "One", body: "x" }, { heading: "Two", body: "y" }] },
      { kind: "product", name: "Mat", price: "$40", body: "Grippy", image: { src: "images/d.png", alt: "D" }, button: { label: "Buy", href: "https://a.example/buy" } },
      { kind: "details", heading: "When", rows: [{ label: "Date", value: "Mon" }] },
      { kind: "divider" },
      { kind: "signature", name: "Sam", body: "Thanks" },
      { kind: "footer" },
    ],
  };
  const out = render(theme, all, {}, { image: images });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.images, ["images/a.jpg", "images/b.png", "images/c.png", "images/d.png"]);
  assert.equal(out.links.length, 3);
  assert.ok(out.bytes < 30_000);
  assert.ok(out.html.includes('class="e-col"'));
});

test("imageSize reads png, gif, jpeg and webp", () => {
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(imageSize(png), { width: 640, height: 480 });
  const gif = Buffer.from("GIF89a\x10\x00\x20\x00", "latin1");
  assert.deepEqual(imageSize(gif), { width: 16, height: 32 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03]);
  assert.deepEqual(imageSize(jpeg), { width: 600, height: 300 });
  assert.equal(imageSize(Buffer.from("nope")), null);
});

test("dark mode swaps a brand colour too dark to read for the accent", () => {
  assert.equal(theme.dark.brand, "#f5b301");
  assert.equal(theme.dark.onBrand, "#111111");
  const bright = themeFromBrand({ brand: { colors: { brand: "#ff6a3d", accent: "#000000", ink: "#111111", paper: "#ffffff" }, fonts: { heading: "Inter", body: "Inter" } }, business: "B" });
  assert.equal(bright.dark.brand, "#ff6a3d");
  const dull = themeFromBrand({ brand: { colors: { brand: "#101820", accent: "#202020", ink: "#111111", paper: "#ffffff" }, fonts: { heading: "Inter", body: "Inter" } }, business: "B" });
  assert.equal(dull.dark.brand, "#f2f2f2");
  const out = render(theme, welcome, { first_name: "A", link: "https://a.example" }, { image: images });
  assert.ok(out.html.includes(".e-btn{background-color:#f5b301!important}"));
});

test("an email over Gmail's 102 KB is refused for sending, not for a preview", () => {
  const long = { version: 1, name: "Long", kind: "transactional", subject: "Long", blocks: [{ kind: "header" }, ...Array.from({ length: 20 }, () => ({ kind: "text", body: "&".repeat(3900) })), { kind: "footer" }] };
  const template = validateTemplate(long);
  assert.ok(template.ok, JSON.stringify(template));
  const sent = render(theme, template.template as EmailTemplate, {}, { image: () => null });
  assert.match(sent.errors.join(" "), /Gmail clips one over 102 KB/);
  const preview = render(theme, template.template as EmailTemplate, {}, { image: () => null, preview: true });
  assert.equal(preview.errors.length, 0);
});

test("a centred image sits in a centred cell with auto margins, its caption centred; left is unchanged", () => {
  const small: RenderOptions["image"] = (file) => ({ src: `cid:${file.replace(/\W/g, "")}@cobra`, width: 200, height: 100 });
  const of = (align?: "left" | "center"): EmailTemplate => ({
    version: 1,
    name: "Logo",
    kind: "transactional",
    subject: "Hi",
    blocks: [{ kind: "image", image: { src: "images/logo.png", alt: "Logo" }, caption: "Our mark", ...(align ? { align } : {}) }],
  });
  const centred = render(theme, of("center"), {}, { image: small });
  assert.deepEqual(centred.errors, []);
  assert.match(centred.html, /<td class="e-pad" align="center" style="padding:12px 32px 12px 32px"><img [^>]*width="200" height="100" alt="Logo" style="display:block;margin:0 auto;width:100%;max-width:200px;/);
  assert.match(centred.html, /text-align:center;padding-top:8px">Our mark</);
  const left = render(theme, of(), {}, { image: small });
  assert.doesNotMatch(left.html, /margin:0 auto|align="center" style="padding:12px/);
  assert.equal(render(theme, of("left"), {}, { image: small }).html, left.html);
});
