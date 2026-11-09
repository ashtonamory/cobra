import { test } from "node:test";
import assert from "node:assert/strict";

import { SECTION_KINDS, pagePath, paragraphs, siteImages, validatePost, validateSite } from "./website.ts";

const home = (sections: unknown[]) => ({ slug: "", title: "Home", sections });
const site = (pages: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, name: "Pine Yoga", description: "Yoga in Pinewood.", pages, ...extra });
const errorsOf = (value: unknown) => {
  const check = validateSite(value);
  return check.ok ? [] : check.errors;
};

const ALL_TEN = [
  { kind: "hero", heading: "Breathe", body: "Classes for every body.", image: { src: "images/studio.jpg", alt: "The studio" }, cta: { label: "Book", href: "/classes/" } },
  { kind: "services", items: [{ title: "Vinyasa", body: "Flow." }] },
  { kind: "prices", items: [{ name: "Drop-in", price: "$20", unit: "class" }], note: "Cash or card." },
  { kind: "testimonials", items: [{ quote: "Best studio.", name: "Sam" }] },
  { kind: "gallery", images: [{ src: "images/room.webp", alt: "The room" }] },
  { kind: "faq", items: [{ q: "Mats?", a: "We lend them." }] },
  { kind: "contact", heading: "Write to us" },
  { kind: "hours", days: [{ day: "mon", open: "09:00", close: "17:00" }, { day: "sun", closed: true }] },
  { kind: "booking", url: "https://cal.com/pine", button: "Book a class" },
  { kind: "posts", limit: 3 },
];

test("a site with every section kind passes, in the order given", () => {
  const check = validateSite(site([home(ALL_TEN), { slug: "classes", title: "Classes", sections: [{ kind: "contact" }] }]));
  assert.equal(check.ok, true, check.ok ? "" : check.errors.join("\n"));
  if (!check.ok) return;
  assert.deepEqual(check.site.pages[0]!.sections.map((s) => s.kind), [...SECTION_KINDS]);
  assert.deepEqual(siteImages(check.site), ["images/studio.jpg", "images/room.webp"]);
});

test("unknown fields are dropped and text is trimmed", () => {
  const check = validateSite(site([home([{ kind: "hero", heading: "  Hi  ", script: "x" }])], { theme: "dark" }));
  assert.equal(check.ok, true);
  if (!check.ok) return;
  assert.deepEqual(check.site.pages[0]!.sections[0], { kind: "hero", heading: "Hi" });
  assert.equal("theme" in check.site, false);
});

test("every problem is reported with its path, not only the first", () => {
  const errors = errorsOf({ version: 2, name: "", description: "x", pages: [{ slug: "about", title: "", sections: [{ kind: "carousel" }] }] });
  assert.ok(errors.includes("site.version: must be 1"));
  assert.ok(errors.includes("site.name: required"));
  assert.ok(errors.some((e) => e.startsWith('site.pages[0].slug: the first page is the home page')));
  assert.ok(errors.includes("site.pages[0].title: required"));
  assert.ok(errors.some((e) => e.startsWith("site.pages[0].sections[0].kind: one of hero,")));
});

test("text is plain: angle brackets are refused, so no HTML gets in", () => {
  const errors = errorsOf(site([home([{ kind: "hero", heading: "<script>alert(1)</script>" }])]));
  assert.deepEqual(errors, ["site.pages[0].sections[0].heading: plain text only, no < or >"]);
});

test("links: https, mailto and tel out; only existing pages in", () => {
  const cta = (href: string) => errorsOf(site([home([{ kind: "hero", heading: "Hi", cta: { label: "Go", href } }])]));
  assert.deepEqual(cta("https://example.com/a"), []);
  assert.deepEqual(cta("mailto:hi@example.com"), []);
  assert.deepEqual(cta("tel:+15551234567"), []);
  assert.deepEqual(cta("/"), []);
  assert.deepEqual(cta("/posts/"), []);
  assert.deepEqual(cta("/#contact"), []);
  assert.ok(cta("javascript:alert(1)").some((e) => e.includes("cta.href")));
  assert.ok(cta("http://example.com").some((e) => e.includes("cta.href")));
  assert.deepEqual(cta("/missing/"), ["site.pages[0].sections[0].cta.href: no page at /missing/"]);
  assert.ok(errorsOf(site([home([{ kind: "booking", url: "http://cal.com/x", button: "Book" }])])).some((e) => e.includes("url")));
});

test("images are files in images/ with alt text", () => {
  const gallery = (images: unknown[]) => errorsOf(site([home([{ kind: "gallery", images }])]));
  assert.deepEqual(gallery([{ src: "images/a-1.jpg", alt: "A" }]), []);
  assert.ok(gallery([{ src: "https://cdn.example.com/a.jpg", alt: "A" }]).some((e) => e.endsWith(".src: a file in images/ (lowercase name, .jpg, .png or .webp)")));
  assert.ok(gallery([{ src: "images/../secret.jpg", alt: "A" }]).length > 0);
  assert.ok(gallery([{ src: "images/a.svg", alt: "A" }]).length > 0);
  assert.deepEqual(gallery([{ src: "images/a.png" }]), ["site.pages[0].sections[0].images[0].alt: required"]);
});

test("page slugs: one home first, no repeats, none of the template's own", () => {
  const two = (slug: string) => errorsOf(site([home([{ kind: "contact" }]), { slug, title: "P", sections: [{ kind: "contact" }] }]));
  assert.deepEqual(two("about-us"), []);
  assert.ok(two("posts").some((e) => e.includes("template's own")));
  assert.ok(two("").some((e) => e.includes("only the first page")));
  assert.ok(two("About").some((e) => e.includes("lowercase")));
  const dup = errorsOf(site([home([{ kind: "contact" }]), { slug: "a", title: "A", sections: [{ kind: "contact" }] }, { slug: "a", title: "B", sections: [{ kind: "contact" }] }]));
  assert.ok(dup.some((e) => e.includes('"a" is used twice')));
});

test("hours: HH:MM with close after open, or closed; each day once", () => {
  const hours = (days: unknown[]) => errorsOf(site([home([{ kind: "hours", days }])]));
  assert.deepEqual(hours([{ day: "tue", open: "08:30", close: "20:00" }]), []);
  assert.ok(hours([{ day: "tue", open: "8:30", close: "20:00" }]).length > 0);
  assert.ok(hours([{ day: "tue", open: "20:00", close: "08:00" }]).some((e) => e.includes("close must be after open")));
  assert.ok(hours([{ day: "tue", closed: true }, { day: "tue", closed: true }]).some((e) => e.includes("listed twice")));
});

test("limits: a heading too long and too many pages are named", () => {
  assert.ok(errorsOf(site([home([{ kind: "hero", heading: "x".repeat(81) }])])).includes("site.pages[0].sections[0].heading: at most 80 characters (has 81)"));
  const pages = [home([{ kind: "contact" }]), ...Array.from({ length: 12 }, (_, i) => ({ slug: `p${i}`, title: "P", sections: [{ kind: "contact" }] }))];
  assert.ok(errorsOf(site(pages)).includes("site.pages: at most 12"));
});

test("a heading too long is reported once", () => {
  const errors = errorsOf(site([home([{ kind: "faq", heading: "x".repeat(81), items: [{ q: "Q", a: "A" }] }])]));
  assert.equal(errors.length, 1);
});

test("contact details are checked", () => {
  assert.deepEqual(errorsOf(site([home([{ kind: "contact" }])], { contact: { email: "hi@pine.yoga", phone: "+1 (555) 123-4567" } })), []);
  assert.ok(errorsOf(site([home([{ kind: "contact" }])], { contact: { email: "nope" } })).includes("site.contact.email: not an email address"));
});

test("paths and paragraphs", () => {
  assert.equal(pagePath(""), "/");
  assert.equal(pagePath("about"), "/about/");
  assert.deepEqual(paragraphs("One\nline.\n\n  Two.  \n\n\n"), ["One line.", "Two."]);
  assert.deepEqual(paragraphs(undefined), []);
});

const post = (front: string, body = "Hello.") => `---\n${front}\n---\n${body}`;

test("a post needs a title and a date and keeps its slug from the file name", () => {
  const check = validatePost("first-week.md", post('title: "Our first week"\ndate: 2026-10-31\ndescription: How it went'));
  assert.equal(check.ok, true);
  if (!check.ok) return;
  assert.deepEqual(check.post, { slug: "first-week", title: "Our first week", date: "2026-10-31", description: "How it went", body: "Hello." });
  const bad = validatePost("First Week.md", post("date: 2026-13-45\ncolour: red"));
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.ok(bad.errors.some((e) => e.includes("name it <slug>.md")));
  assert.ok(bad.errors.some((e) => e.includes("title is required")));
  assert.ok(bad.errors.some((e) => e.includes("date as YYYY-MM-DD")));
  assert.ok(bad.errors.some((e) => e.includes('unknown front matter "colour"')));
});

test("a post refuses raw HTML and script links, but code may show them", () => {
  const body = (text: string) => validatePost("p.md", post("title: T\ndate: 2026-10-31", text));
  assert.equal(body("Use `<div>` here.\n\n```html\n<script>x</script>\n```\n").ok, true);
  assert.equal(body("<script>alert(1)</script>").ok, false);
  assert.equal(body("<img src=x onerror=alert(1)>").ok, false);
  assert.equal(body("[click](javascript:alert(1))").ok, false);
  assert.equal(body("[ref]: javascript:alert(1)\n\nSee [it][ref].").ok, false);
  assert.equal(body("[ok](https://example.com) [mail](mailto:a@b.co) [page](/about/)").ok, true);
  assert.equal(body("![logo](/images/logo.png)").ok, true);
  assert.equal(body("![remote](https://example.com/x.png)").ok, false);
});

test("a draft is marked, and draft must be true or false", () => {
  const check = validatePost("d.md", post("title: T\ndate: 2026-10-31\ndraft: true"));
  assert.equal(check.ok && check.post.draft, true);
  assert.equal(validatePost("d.md", post("title: T\ndate: 2026-10-31\ndraft: yes")).ok, false);
});

test("the inquiry email setting takes two plain addresses, and nothing that could reach an email's headers", () => {
  const check = validateSite(site([home([{ kind: "contact" }])], { form: { emailTo: " owner@pine.example ", from: "website@pine.example", extra: 1 } }));
  assert.equal(check.ok, true, check.ok ? "" : check.errors.join("\n"));
  if (!check.ok) return;
  assert.deepEqual(check.site.form, { emailTo: "owner@pine.example", from: "website@pine.example" });
  const bad = (form: unknown) => errorsOf(site([home([{ kind: "contact" }])], { form }));
  assert.ok(bad({ emailTo: "owner@pine.example" }).some((e) => e === "site.form.from: required"));
  assert.ok(bad({ emailTo: "a@b.example\r\nBcc: x@evil.example", from: "w@pine.example" }).some((e) => e.startsWith("site.form.emailTo: a plain email address")));
  assert.ok(bad({ emailTo: "a,b@pine.example", from: "w@pine.example" }).some((e) => e.startsWith("site.form.emailTo")));
  assert.ok(bad({ emailTo: "o@pine.example", from: "\"Pine\" <w@pine.example>" }).some((e) => e.startsWith("site.form.from")));
  assert.ok(bad({ emailTo: "o@pine.example", from: "w@localhost" }).some((e) => e.startsWith("site.form.from")));
  assert.ok(bad("o@pine.example").includes("site.form: must be an object"));
});
