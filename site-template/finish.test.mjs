import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkOut, findChromium } from "./check.mjs";
import { cssLoads, finish, readPage, readServices, serviceLines } from "./finish.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP = { name: "Google Maps", why: "the map on Contact", hosts: ["www.google.com"], kinds: ["frame"] };
const FORM = `<form class="cobra-form" method="post" action="/api/inquiry"><input name="name"><input name="email" type="email"><textarea name="message"></textarea><input name="company"><button>Send</button></form>`;
const page = (body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>T</title>${head}</head><body>${body}</body></html>`;

/** A finished-looking build: a site folder with cobra.json and dist/ with the three pages every coded site keeps. */
function built(t, { services = [], pages = {}, forms } = {}) {
  const site = mkdtempSync(join(tmpdir(), "cobra-finish-"));
  t.after(() => rmSync(site, { recursive: true, force: true }));
  writeFileSync(join(site, "cobra.json"), JSON.stringify({ version: 1, services }));
  if (forms !== undefined) {
    mkdirSync(join(site, "src", "content"), { recursive: true });
    writeFileSync(join(site, "src", "content", "forms.json"), typeof forms === "string" ? forms : JSON.stringify(forms));
  }
  const out = join(site, "dist");
  const files = { "index.html": page(`<h1>Home</h1>${FORM}`), "404.html": page("<h1>Not found</h1>"), "thanks/index.html": page("<h1>Thanks</h1>"), ...pages };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(out, file)), { recursive: true });
    writeFileSync(join(out, file), text);
  }
  return { site, out };
}

const refused = (result, pattern) => {
  assert.equal(result.ok, false, "refused");
  assert.ok(result.problems.some((p) => pattern.test(p)), `a problem matching ${pattern}:\n${result.problems.join("\n")}`);
};

test("cobra.json: each service needs a name, why, plain hosts and known kinds", (t) => {
  const site = mkdtempSync(join(tmpdir(), "cobra-services-"));
  t.after(() => rmSync(site, { recursive: true, force: true }));
  const services = (list) => {
    writeFileSync(join(site, "cobra.json"), JSON.stringify({ version: 1, services: list }));
    return () => readServices(site);
  };
  assert.throws(() => readServices(site), /cobra.json is missing/);
  assert.deepEqual(services([MAP])(), [MAP]);
  assert.throws(services([{ ...MAP, why: "" }]), /why the site uses it/);
  assert.throws(services([{ ...MAP, hosts: ["https://www.google.com/maps"] }]), /is not a host name/);
  assert.throws(services([{ ...MAP, kinds: [] }]), /kinds, what the site uses it for/);
  assert.throws(services([{ ...MAP, kinds: ["anything"] }]), /"anything" is not a kind/);
  writeFileSync(join(site, "cobra.json"), "{");
  assert.throws(() => readServices(site), /not JSON/);
  assert.deepEqual(serviceLines([MAP]), ["Google Maps (www.google.com): shows a part of it. The map on Contact."]);
  assert.deepEqual(serviceLines([{ ...MAP, why: "Shows a map of the bar, because the owner asked" }]), ["Google Maps (www.google.com): shows a part of it. Shows a map of the bar, because the owner asked."]);
});

test("finish: a plain site gets the strict CSP, robots.txt, a sitemap of its real pages and .assetsignore", (t) => {
  const { site, out } = built(t, { pages: { "about/index.html": page("<h1>About</h1>") } });
  const result = finish({ site, out, url: "https://happytails.example/" });
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.match(result.csp, /^default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';/);
  assert.doesNotMatch(result.csp, /frame-src|unsafe-eval|script-src[^;]*unsafe-inline/);
  assert.match(readFileSync(join(out, "_headers"), "utf8"), /Content-Security-Policy: default-src 'none'/);
  assert.match(readFileSync(join(out, "robots.txt"), "utf8"), /Sitemap: https:\/\/happytails.example\/sitemap.xml/);
  const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8");
  assert.match(sitemap, /<loc>https:\/\/happytails.example\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/happytails.example\/about\/<\/loc>/);
  assert.doesNotMatch(sitemap, /thanks|404/);
  assert.ok(existsSync(join(out, ".assetsignore")));
});

test("finish: a service's hosts go only into its own kinds, and each inline script is allowed by its hash", (t) => {
  const { site, out } = built(t, {
    services: [MAP],
    pages: { "contact/index.html": page(`<iframe src="https://www.google.com/maps/embed?pb=1&amp;z=3" loading="lazy"></iframe>${FORM}<script type="module">document.body.dataset.ok = "1";</script>`) },
  });
  const result = finish({ site, out });
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.match(result.csp, /frame-src https:\/\/www.google.com/);
  assert.match(result.csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+';/);
  assert.doesNotMatch(result.csp.match(/script-src[^;]*/)[0], /google/, "a map in a frame never runs a script on the page");
  assert.doesNotMatch(result.csp.match(/img-src[^;]*/)[0], /google/);
  assert.deepEqual(result.allow, ["www.google.com"]);
  assert.deepEqual(result.unused, []);
});

test("finish: a load from a host cobra.json does not name is refused, and so is a named host used for another kind", (t) => {
  const stranger = built(t, { pages: { "contact/index.html": page(`<iframe src="https://www.google.com/maps/embed"></iframe>`) } });
  refused(finish(stranger), /<iframe src> loads a frame from www.google.com, which cobra.json does not name/);
  const wrongKind = built(t, { services: [MAP], pages: { "contact/index.html": page(`<script src="https://www.google.com/maps/api.js"></script>`) } });
  refused(finish(wrongKind), /lets Google Maps be used only for frame. Add "script"/);
  const css = built(t, { pages: { "_astro/site.css": `@font-face{font-family:X;src:url(https://fonts.gstatic.com/x.woff2)} .hero{background:url("https://cdn.example/a.jpg")}` } });
  const result = finish(css);
  refused(result, /loads a font from fonts.gstatic.com/);
  refused(result, /loads a image from cdn.example/);
  refused(finish(built(t, { pages: { "a/index.html": page(`<img srcset="/a.png 1x, http://cdn.example/b.png 2x">`) } })), /not https/);
  refused(finish(built(t, { pages: { "a/index.html": page("", `<link rel="stylesheet" href="//cdn.example/x.css">`) } })), /loads a style from cdn.example/);
});

test("finish: links a visitor follows load nothing, and mailto:, tel: and data: images are fine", (t) => {
  const { site, out } = built(t, {
    pages: { "a/index.html": page(`<a href="https://www.instagram.com/happytails">Instagram</a><a href="mailto:a@b.co">Mail</a><a href="tel:+1">Call</a><img src="data:image/png;base64,AA=="><link rel="canonical" href="https://happytails.example/a/">`, `<link rel="preconnect" href="https://elsewhere.example">`) },
  });
  const result = finish({ site, out });
  assert.equal(result.ok, true, result.problems.join("\n"));
});

test("finish: code in attributes, javascript: addresses, <base>, plug-ins and a page's own security policy are refused", (t) => {
  refused(finish(built(t, { pages: { "a/index.html": page(`<button onClick="go()">Go</button>`) } })), /onclick=…> runs code from an attribute/);
  refused(finish(built(t, { pages: { "a/index.html": page(`<a href="  JavaScript:alert(1)">x</a>`) } })), /javascript: address/);
  refused(finish(built(t, { pages: { "a/index.html": page(`<a href="&#106;avascript:alert(1)">x</a>`) } })), /javascript: address/);
  refused(finish(built(t, { pages: { "a/index.html": page("", `<base href="https://elsewhere.example/">`) } })), /<base>/);
  refused(finish(built(t, { pages: { "a/index.html": page(`<embed src="/x.swf">`) } })), /<embed> is not allowed/);
  refused(finish(built(t, { pages: { "a/index.html": page("", `<meta http-equiv="Content-Security-Policy" content="default-src *">`) } })), /a <meta> security policy/);
  refused(finish(built(t, { pages: { "a/index.html": page("", `<meta http-equiv="refresh" content="0;url=https://elsewhere.example">`) } })), /refresh/);
});

test("finish: a form goes only to the site Worker's /api/inquiry by POST, with only the fields the Worker keeps", (t) => {
  refused(finish(built(t, { pages: { "a/index.html": page(`<form action="https://formspree.io/f/x" method="post"><input name="email"></form>`) } })), /a form sends to "https:\/\/formspree.io\/f\/x"/);
  refused(finish(built(t, { pages: { "a/index.html": page(`<form action="/api/inquiry"><input name="email"></form>`) } })), /by GET/);
  refused(finish(built(t, { pages: { "a/index.html": page(`<form action="/api/inquiry" method="post"><input name="email"><input name="card_number"></form>`) } })), /"card_number", which the site's Worker does not keep/);
  refused(finish(built(t, { pages: { "a/index.html": page(`<form action="/api/inquiry" method="post"><input name="name"></form>`) } })), /no email field/);
  refused(finish(built(t, { pages: { "a/index.html": page(`<form action="/api/inquiry" method="post"><input name="email"><button formaction="https://elsewhere.example">x</button></form>`) } })), /formaction=/);
});

const BOOK = {
  book: {
    title: "Table booking",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "email", type: "email", required: true },
      { name: "party_size", type: "number", label: "Party size", required: true },
      { name: "seating", type: "radio", options: ["Inside", "Harbour side"] },
      { name: "source", type: "hidden", value: "booking page" },
    ],
  },
};
const BOOK_FORM = `<form class="cobra-form" method="post" action="/api/form/book"><input name="name"><input name="email" type="email"><input name="party_size"><input type="radio" name="seating" value="Inside"><input type="radio" name="seating" value="Harbour side"><input name="company"><button>Book</button></form>`;

test("finish: a form the site declares in src/content/forms.json posts to /api/form/<id>, and its fields go to the site Worker as _forms.json", (t) => {
  const { site, out } = built(t, { forms: BOOK, pages: { "book/index.html": page(BOOK_FORM) } });
  const result = finish({ site, out });
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.deepEqual(result.forms, ["Table booking"]);
  const forms = JSON.parse(readFileSync(join(out, "_forms.json"), "utf8"));
  assert.deepEqual(forms.book.fields.map((f) => [f.name, f.label, f.required]), [["name", "Name", true], ["email", "Email", true], ["party_size", "Party size", true], ["seating", "Seating", false], ["source", "Source", false]]);
  assert.equal(forms.book.kind, "inquiry");
  assert.match(readFileSync(join(out, ".assetsignore"), "utf8"), /^_forms\.json$/m, "a setting, never a file on the site");
  // No forms of its own: no _forms.json, and the old sites (no forms.json at all) are as before.
  const plain = built(t);
  assert.equal(finish(plain).ok, true);
  assert.equal(existsSync(join(plain.out, "_forms.json")), false);
});

test("finish: a site's own form is refused unless it is declared, guarded, and sends exactly its fields", (t) => {
  const with_ = (html, forms = BOOK) => finish(built(t, { forms, pages: { "book/index.html": page(html) } }));
  refused(with_(BOOK_FORM.replace("/api/form/book", "/api/form/quote")), /posts to \/api\/form\/quote, which src\/content\/forms.json does not declare/);
  refused(with_(BOOK_FORM.replace("<button>", '<input name="card_number"><button>')), /sends "card_number", which src\/content\/forms.json does not give it/);
  refused(with_(BOOK_FORM.replace('<input name="party_size">', "")), /has no control for its field party_size/);
  refused(with_(BOOK_FORM.replace("<button>", '<input type="hidden" name="source" value="x"><button>')), /source is hidden/);
  refused(with_(BOOK_FORM.replace('<input name="company">', "")), /no spam guard/);
  refused(with_(BOOK_FORM.replace('method="post"', 'method="get"')), /by GET/);
  refused(with_(BOOK_FORM, { book: { ...BOOK.book, fields: BOOK.book.fields.filter((f) => f.type !== "email") } }), /src\/content\/forms.json.book.fields: one field of type email/);
  refused(with_(BOOK_FORM, "{"), /src\/content\/forms.json is not JSON/);
  refused(with_(BOOK_FORM, { "Book!": BOOK.book }), /src\/content\/forms.json.Book!: an id like quote/);
});

test("finish: the build may not ship its own host files, links, or more than the size limits", (t) => {
  for (const file of ["_headers", "_redirects", "robots.txt", ".assetsignore", "_worker.js"]) {
    refused(finish(built(t, { pages: { [file]: "x" } })), new RegExp(`${file.replace(".", "\\.")}: Cobra writes the site's own host files`));
  }
  const linked = built(t);
  symlinkSync("/etc/passwd", join(linked.out, "passwd.txt"));
  refused(finish(linked), /passwd.txt: a link to another file/);
  const big = built(t);
  writeFileSync(join(big.out, "video.mp4"), Buffer.alloc(10 * 1024 * 1024 + 1));
  refused(finish(big), /video.mp4: 10.0 MB, over the 10 MB a file may be/);
  const bare = built(t);
  rmSync(join(bare.out, "404.html"));
  rmSync(join(bare.out, "thanks"), { recursive: true });
  const result = finish(bare);
  refused(result, /no 404.html/);
  refused(result, /no thanks page/);
});

test("finish: the spam check adds Turnstile's host for its script and frame only when it is on", (t) => {
  const pages = { "contact/index.html": page(`${FORM}<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`) };
  refused(finish(built(t, { pages })), /challenges.cloudflare.com, which cobra.json does not name/);
  const result = finish({ ...built(t, { pages }), turnstile: true });
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.match(result.csp, /script-src 'self' https:\/\/challenges.cloudflare.com/);
  assert.match(result.csp, /frame-src https:\/\/challenges.cloudflare.com/);
});

test("readPage and cssLoads read what a page and a stylesheet load, past comments and quoting", () => {
  const { loads, scripts } = readPage(page(`<!-- <script src="https://x.example/a.js"></script> --><img src='https://a.example/i.png'><video poster="/p.jpg" src="https://v.example/v.mp4"></video><script type="application/ld+json">{"@type":"LocalBusiness"}</script><script>let s = "</p>";</script>`), "a.html");
  assert.deepEqual(loads.map((l) => `${l.kind} ${l.url}`).sort(), ["image /p.jpg", "image https://a.example/i.png", "media https://v.example/v.mp4"]);
  assert.deepEqual(scripts, ['let s = "</p>";'], "data blocks are not scripts; real ones are hashed as written");
  assert.deepEqual(
    cssLoads(`/* url(https://no.example/x) */ @import "https://s.example/a.css"; @font-face { src: url('/f.woff2') } a { background: url(/b.png) }`).map((l) => `${l.kind} ${l.url}`),
    ["style https://s.example/a.css", "font /f.woff2", "image /b.png"],
  );
});

// The starter itself: built with Astro the way a Worker builds it, finished, and looked at in a browser.
// It builds inside site-template/.builds so its `astro` is this package's own (the same version the starter pins).
test("the starter builds, finishes and passes the site check, also with a map named in cobra.json", async (t) => {
  const astro = join(HERE, "node_modules", "astro", "bin", "astro.mjs");
  if (!existsSync(astro)) return t.skip("site-template's packages are not installed (npm ci)");
  assert.equal(JSON.parse(readFileSync(join(HERE, "coded", "package.json"), "utf8")).dependencies.astro, JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).dependencies.astro, "the starter pins the Astro this package tests with");
  mkdirSync(join(HERE, ".builds"), { recursive: true });
  const site = mkdtempSync(join(HERE, ".builds", "coded-"));
  t.after(() => rmSync(site, { recursive: true, force: true }));
  cpSync(join(HERE, "coded"), site, { recursive: true, filter: (src) => !/[/\\](node_modules|dist|\.astro)$/.test(src) });
  writeFileSync(join(site, "cobra.json"), JSON.stringify({ version: 1, services: [MAP] }, null, 2));
  writeFileSync(
    join(site, "src", "pages", "contact.astro"),
    `---\nimport Base from "../layouts/Base.astro";\nimport Form from "../components/cobra/Form.astro";\n---\n<Base title="Contact">\n  <h1>Contact</h1>\n  <iframe title="Map" src="https://www.google.com/maps/embed?pb=!1m2!2m1!1sBasseterre" width="600" height="300" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>\n  <Form kind="waitlist" consent={{ topic: "news" }} />\n  <script>document.documentElement.dataset.ready = "yes";</script>\n</Base>\n`,
  );
  // The site's own form, every kind of field Cobra draws (hidden ones the site Worker fills in itself).
  writeFileSync(
    join(site, "src", "content", "forms.json"),
    JSON.stringify({
      book: {
        title: "Table booking",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "email", type: "email", required: true },
          { name: "phone", type: "tel" },
          { name: "day", type: "date", required: true },
          { name: "party_size", type: "number", label: "Party size", required: true },
          { name: "time", type: "select", options: ["Breakfast", "Lunch"] },
          { name: "seating", type: "radio", options: ["Inside", "Harbour side"], required: true },
          { name: "extras", type: "checkbox", options: ["High chair", "Step-free"] },
          { name: "notes", type: "textarea" },
          { name: "first_visit", type: "checkbox", label: "First time with us" },
          { name: "news", type: "checkbox", label: "Send me news", topic: "News" },
          { name: "source", type: "hidden", value: "booking page" },
        ],
      },
    }),
  );
  writeFileSync(join(site, "src", "pages", "book.astro"), `---\nimport Base from "../layouts/Base.astro";\nimport Form from "../components/cobra/Form.astro";\n---\n<Base title="Book">\n  <h1>Book a table</h1>\n  <Form form="book" button="Book" />\n</Base>\n`);
  // A post as Cobra writes one (site_edit {post}: every front matter value quoted).
  writeFileSync(join(site, "src", "content", "posts", "spring-hours.md"), '---\ntitle: "Spring hours: earlier"\ndate: "2026-11-02"\n---\nWe open **earlier** now.\n');
  const out = join(site, "dist");
  execFileSync(process.execPath, [astro, "build"], { cwd: site, stdio: "pipe", env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", COBRA_SITE_URL: "https://happytails.example" } });
  const result = finish({ site, out, url: "https://happytails.example" });
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.deepEqual(result.pages, ["404.html", "book/index.html", "contact/index.html", "index.html", "posts/index.html", "posts/spring-hours/index.html", "thanks/index.html"]);
  assert.deepEqual(result.forms, ["Table booking"]);
  const book = readFileSync(join(out, "book", "index.html"), "utf8");
  assert.match(book, /<form class="cobra-form" method="post" action="\/api\/form\/book"/);
  assert.match(book, /Party size <input name="party_size" type="text" inputmode="decimal"[^>]* required/);
  assert.match(book, /Phone \(optional\) <input name="phone" type="tel" autocomplete="tel"/);
  assert.match(book, /<legend[^>]*>Seating<\/legend>/);
  assert.doesNotMatch(book, /name="source"/, "a hidden field is the site Worker's to fill in");
  assert.equal(JSON.parse(readFileSync(join(out, "_forms.json"), "utf8")).book.fields.length, 12);
  assert.match(readFileSync(join(out, "posts", "spring-hours", "index.html"), "utf8"), /<strong>earlier<\/strong>/);
  assert.match(readFileSync(join(out, "sitemap.xml"), "utf8"), /happytails.example\/posts\/spring-hours\//);
  assert.match(readFileSync(join(out, "index.html"), "utf8"), /<link rel="canonical" href="https:\/\/happytails.example\/"/);
  assert.match(result.csp, /frame-src https:\/\/www.google.com/);
  if (!findChromium()) return t.skip("no Chromium to look at it with");
  const checked = await checkOut({ out, shots: join(site, "shots"), allow: result.allow });
  assert.equal(checked.ok, true, (checked.problems ?? []).join("\n"));
});

test("the coded starter's check script builds the site, so a Worker's local check is never empty", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "coded", "package.json"), "utf8"));
  assert.equal(pkg.scripts.check, "astro build");
  assert.equal(pkg.scripts.build, "astro build");
});
