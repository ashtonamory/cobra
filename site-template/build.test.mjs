// The build check: the example site, which
// uses all ten sections, a post, a draft, images and a brand kit, builds, and
// the output holds what a Worker serves and nothing it should not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildSite, checkSite, HEADERS, headersFor } from "./build.mjs";
import { checkOut, findChromium, parseHeaders, shotName } from "./check.mjs";
import { contrast, FONTS, readableOn, themeOf } from "./theme.mjs";

const HERE = import.meta.dirname;
// .builds/ is not in git: a fresh checkout has none until the first build.
const scratch = () => (mkdirSync(join(HERE, ".builds"), { recursive: true }), mkdtempSync(join(HERE, ".builds", "test-")));

test("the example site builds every page, leaves the draft out and has no script", async (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "out");
  const result = await buildSite({ site: join(HERE, "example/site"), brand: join(HERE, "example/brand"), out, url: "https://pinestreet.example" });
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
  for (const page of ["index.html", "classes/index.html", "posts/index.html", "posts/new-evening-class/index.html", "thanks/index.html", "404.html"]) {
    assert.ok(existsSync(join(out, page)), page);
  }
  assert.equal(existsSync(join(out, "posts/winter-hours/index.html")), false, "a draft is not built");
  const home = readFileSync(join(out, "index.html"), "utf8");
  const classes = readFileSync(join(out, "classes/index.html"), "utf8");
  for (const kind of ["hero", "services", "testimonials", "posts", "contact"]) assert.match(home, new RegExp(`section-${kind}`));
  for (const kind of ["prices", "hours", "booking", "gallery", "faq"]) assert.match(classes, new RegExp(`section-${kind}`));
  for (const file of ["index.html", "classes/index.html", "posts/new-evening-class/index.html"]) {
    const html = readFileSync(join(out, file), "utf8");
    assert.doesNotMatch(html, /<script/i, `${file} has no script`);
    assert.doesNotMatch(html, /\sstyle=|<style/i, `${file} has no inline style (the CSP allows none)`);
  }
  assert.match(home, /<form class="form" method="post" action="\/api\/inquiry">/);
  // The names the Worker reads (apps/agent siteDeploy.ts WORKER_SOURCE).
  for (const field of ["name", "email", "phone", "message", "company"]) assert.match(home, new RegExp(`name="${field}"`), `the form has ${field}`);
  assert.match(home, /<link rel="canonical" href="https:\/\/pinestreet.example\/">/);
  assert.match(readFileSync(join(out, "_headers"), "utf8"), /Content-Security-Policy: default-src 'none'/);
  assert.match(readFileSync(join(out, "sitemap.xml"), "utf8"), /<loc>https:\/\/pinestreet.example\/posts\/new-evening-class\/<\/loc>/);
  assert.ok(existsSync(join(out, "brand/logo.png")));
  assert.ok(existsSync(join(out, "fonts/PlayfairDisplay.woff2")));
  assert.equal(existsSync(join(out, "fonts/Lora.woff2")), false, "only the brand's fonts are copied");
  assert.ok(existsSync(join(out, ".assetsignore")));
});

test("text is escaped, and a second build replaces only its own output", async (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const site = join(dir, "site");
  cpSync(join(HERE, "example/site"), site, { recursive: true });
  const doc = JSON.parse(readFileSync(join(site, "site.json"), "utf8"));
  doc.name = "Fish & Chips \"Co\"";
  writeFileSync(join(site, "site.json"), JSON.stringify(doc));
  const out = join(dir, "out");
  assert.equal((await buildSite({ site, out })).ok, true);
  assert.match(readFileSync(join(out, "index.html"), "utf8"), /Fish &amp; Chips/);
  assert.equal((await buildSite({ site, out })).ok, true, "a build replaces its own folder");
  const other = join(dir, "other");
  cpSync(join(HERE, "src"), other, { recursive: true });
  const refused = await buildSite({ site, out: other });
  assert.equal(refused.ok, false);
  assert.match(refused.errors[0], /not a site build; refusing/);
});

test("the check names every problem: bad JSON fields, a missing image, a fake image, a bad post", (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const site = join(dir, "site");
  cpSync(join(HERE, "example/site"), site, { recursive: true });
  const doc = JSON.parse(readFileSync(join(site, "site.json"), "utf8"));
  doc.pages[0].sections[0].image.src = "images/missing.jpg";
  doc.pages[0].sections[0].heading = "<b>Hi</b>";
  writeFileSync(join(site, "site.json"), JSON.stringify(doc));
  writeFileSync(join(site, "images/room.webp"), "not an image");
  writeFileSync(join(site, "posts/bad.md"), "---\ntitle: Bad\ndate: 2026-10-31\n---\n<script>alert(1)</script>\n");
  const result = checkSite({ site });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("heading: plain text only")));
  assert.ok(result.errors.includes("images/missing.jpg: file not found"));
  assert.ok(result.errors.includes("images/room.webp: the file is not a WEBP image"));
  assert.ok(result.errors.some((e) => e.includes("posts/bad.md: no HTML")));
});

test("the theme keeps text readable on any brand colour", () => {
  const pale = themeOf({ colors: { brand: "#F5E663", accent: "#FFFFFF", ink: "#222222", paper: "#FFFFFF" }, fonts: { heading: "Bebas Neue", body: "Lora" } });
  assert.ok(contrast(pale.tokens["on-brand"], "#F5E663") >= 4.5);
  assert.equal(pale.tokens.link, "#222222", "a pale brand colour is not used for links on white");
  assert.equal(pale.theme.headingWeight, 400, "a one-weight face is not faked bold");
  const lowInk = themeOf({ colors: { brand: "#123456", accent: "#654321", ink: "#EEEEEE", paper: "#FFFFFF" } });
  assert.ok(contrast(lowInk.tokens.ink, "#FFFFFF") >= 4.5);
  const none = themeOf(null);
  assert.deepEqual(none.theme, { headingFont: "Inter", bodyFont: "Inter", headingWeight: 700 });
  assert.equal(themeOf({ fonts: { heading: "Comic Sans", body: "../../etc" } }).theme.bodyFont, "Inter");
  assert.equal(readableOn("#000000", ["#111111", "#FFFFFF"]), "#FFFFFF");
});

test("every brand font has its woff2 file, and the list matches the Designer's", async () => {
  const { BRAND_FONTS } = await import("../apps/agent/src/agent/designer.ts");
  assert.deepEqual(Object.keys(FONTS).sort(), [...BRAND_FONTS].sort());
  for (const { files } of Object.values(FONTS)) for (const [file] of files) assert.ok(existsSync(join(HERE, "fonts", file)), file);
});

test("with a Turnstile sitekey the form shows the check and the CSP lets in exactly its script and frame", async (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "out");
  const result = await buildSite({ site: join(HERE, "example/site"), out, turnstile: "0x4AAAAAAAtestkey" });
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
  const home = readFileSync(join(out, "index.html"), "utf8");
  assert.match(home, /<div class="cf-turnstile" data-sitekey="0x4AAAAAAAtestkey"><\/div>\s*<button class="button" type="submit">/, "the check sits above the Send button");
  const scripts = [...home.matchAll(/<script[^>]*>/gi)].map((m) => m[0]);
  assert.deepEqual(scripts, ['<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer>'], "Turnstile's script is the only one");
  assert.doesNotMatch(home, /\sstyle=|<style/i);
  const classes = readFileSync(join(out, "classes/index.html"), "utf8");
  assert.doesNotMatch(classes, /<script|cf-turnstile/i, "a page with no contact form loads no script");
  const csp = /Content-Security-Policy: (.*)/.exec(readFileSync(join(out, "_headers"), "utf8"))[1];
  assert.equal(
    csp,
    "default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self'; style-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  const bad = await buildSite({ site: join(HERE, "example/site"), out, turnstile: 'x" onload="alert(1)' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /--turnstile/);
});

test("without a sitekey the CSP is unchanged: default-src 'none' and no script source at all", () => {
  assert.equal(HEADERS, headersFor(null));
  assert.match(HEADERS, /Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'\n/);
  assert.doesNotMatch(HEADERS, /script-src|frame-src|challenges/);
});

// Design mode: a site's own Mustache
// templates and stylesheet, Cobra's head and form, linted before and after.
const designCopy = (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const site = join(dir, "site");
  cpSync(join(HERE, "example-design"), site, { recursive: true });
  return { dir, site, out: join(dir, "out") };
};
const edit = (path, change) => writeFileSync(path, change(readFileSync(path, "utf8")));

test("the example design builds its pages with Cobra's head and form, and no script", async (t) => {
  const { site, out } = designCopy(t);
  const result = await buildSite({ site, out, url: "https://corner-bakery.example" });
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
  assert.equal(result.designed, true);
  for (const file of ["index.html", "thanks/index.html", "404.html", "site.css", "fonts/Silkscreen-Regular.ttf", "fonts/Silkscreen-OFL.txt", "images/crew-don.png", "_headers", "robots.txt", "sitemap.xml", ".assetsignore"]) {
    assert.ok(existsSync(join(out, file)), file);
  }
  const home = readFileSync(join(out, "index.html"), "utf8");
  assert.doesNotMatch(home, /<script|\sstyle=|<style/i);
  assert.match(home, /<link rel="canonical" href="https:\/\/corner-bakery.example\/">/);
  assert.match(home, /<link rel="stylesheet" href="\/site.css\?v=[0-9a-f]{10}">/);
  assert.match(home, /<form class="form form-waitlist" method="post" action="\/api\/inquiry">/);
  for (const field of ["name", "email", "message", "company"]) assert.match(home, new RegExp(`name="${field}"`), field);
  assert.match(home, /<input type="hidden" name="kind" value="waitlist">/);
  assert.match(home, /<input name="name" autocomplete="name" maxlength="200" placeholder="Your name_">/, "a waitlist's name is optional");
  assert.match(home, /<input name="email" type="email"[^>]* required>/);
  assert.match(home, /<input type="hidden" name="message" value="Corner Bakery waitlist">/);
  assert.match(home, /aria-label="Unknown face">\?<\/div>/, "a member with no image");
  assert.doesNotMatch(readFileSync(join(out, "sitemap.xml"), "utf8"), /thanks|404/);
  assert.match(readFileSync(join(out, "_headers"), "utf8"), /Content-Security-Policy: default-src 'none'; img-src/);
  assert.equal(existsSync(join(out, "images/yellow.png")), false, "only images a page names");
});

test("a designed site with a sitekey gets Turnstile's script once and the CSP for it", async (t) => {
  const { site, out } = designCopy(t);
  assert.equal((await buildSite({ site, out, turnstile: "0x4AAAAAAA_test-key" })).ok, true);
  const home = readFileSync(join(out, "index.html"), "utf8");
  assert.equal(home.match(/<script/g).length, 1);
  assert.match(home, /data-sitekey="0x4AAAAAAA_test-key" data-theme="light"/);
  assert.doesNotMatch(readFileSync(join(out, "thanks/index.html"), "utf8"), /<script/);
  assert.match(readFileSync(join(out, "_headers"), "utf8"), /script-src https:\/\/challenges.cloudflare.com/);
});

test("a form's kind: a waitlist asks only an email (its name optional or left out), an inquiry everything", async (t) => {
  const { site, out } = designCopy(t);
  const form = (change) => {
    const content = JSON.parse(readFileSync(join(site, "content.json"), "utf8"));
    content.form = change(content.form);
    writeFileSync(join(site, "content.json"), JSON.stringify(content));
  };
  const formHtml = () => readFileSync(join(out, "index.html"), "utf8").match(/<form[\s\S]*?<\/form>/)[0];
  form((f) => ({ kind: "waitlist", askName: false, button: f.button }));
  assert.equal((await buildSite({ site, out })).ok, true);
  assert.doesNotMatch(formHtml(), /name="name"|name="message"/);
  assert.match(formHtml(), /name="kind" value="waitlist"/);
  form(() => ({ kind: "inquiry" }));
  assert.equal((await buildSite({ site, out })).ok, true);
  assert.doesNotMatch(formHtml(), /name="kind"/);
  for (const field of ["name", "message"]) assert.match(formHtml(), new RegExp(`name="${field}"[^>]* required`), field);
  form(() => ({ kind: "waitlist", askName: "yes" }));
  const bad = await buildSite({ site, out });
  assert.ok(!bad.ok && bad.errors.some((e) => /form\.askName: true or false/.test(e)), bad.errors?.join("\n"));
});

test("words are escaped, so content cannot become markup or a link out", async (t) => {
  const { site, out } = designCopy(t);
  edit(join(site, "content.json"), (s) => s.replace('"Kid, that tree', '"<script>alert(1)</script> Kid, that tree'));
  assert.equal((await buildSite({ site, out })).ok, true);
  assert.match(readFileSync(join(out, "index.html"), "utf8"), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  edit(join(site, "content.json"), (s) => s.replace('"href": "/#story"', '"href": "javascript:alert(1)"'));
  const bad = await buildSite({ site, out });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /link javascript:alert\(1\)/.test(e)), bad.errors.join("\n"));
});

test("the lint refuses what the CSP or the safety rules forbid, naming each", async (t) => {
  const { site } = designCopy(t);
  const page = join(site, "design/pages/index.html");
  edit(page, (s) => s.replace("<main id=\"main\">", '<main id="main" style="color:red" onclick="x()"><script>x()</script>{{{raw}}}<link rel="stylesheet" href="https://evil.example/a.css"><img src="https://evil.example/x.png" alt="">'));
  edit(join(site, "design/site.css"), (s) => `@import url("https://evil.example/a.css");\n${s}body{background:url(https://evil.example/b.png)}\n`);
  writeFileSync(join(site, "design/notes.js"), "x");
  const result = checkSite({ site });
  assert.equal(result.ok, false);
  const all = result.errors.join("\n");
  for (const want of [/no <script>/, /no style= attribute/, /no on…= handler/, /triple braces/, /<meta> and <link> belong to/, /no @import/, /url\(https:\/\/evil.example\/b.png\)/, /design\/notes.js: not part of a design/]) assert.match(all, want);
});

test("a design must keep its parts: the home page, the thanks page for a form, a font's licence, Cobra's partials", async (t) => {
  const { site } = designCopy(t);
  rmSync(join(site, "design/pages/thanks.html"));
  rmSync(join(site, "design/fonts/Silkscreen-OFL.txt"));
  writeFileSync(join(site, "design/partials/head.html"), "<title>mine</title>");
  const all = checkSite({ site }).errors.join("\n");
  assert.match(all, /thanks.html: not found; the form lands on \/thanks\//);
  assert.match(all, /Silkscreen-Regular.ttf is not one of Cobra's fonts, so its licence goes beside it/);
  assert.match(all, /\{\{> head\}\} is Cobra's/);
  rmSync(join(site, "design/pages/index.html"));
  assert.match(checkSite({ site }).errors.join("\n"), /index.html: not found/);
});

test("one of Cobra's own fonts needs no licence copied in: the build ships Cobra's, found by the font's bytes whatever its name", async (t) => {
  const { site, out } = designCopy(t);
  // Silkscreen is not Cobra's, so it keeps its own licence; Poppins comes in under another name, with none.
  copyFileSync(join(HERE, "fonts/Poppins-Bold.woff2"), join(site, "design/fonts/Heading.woff2"));
  edit(join(site, "design/site.css"), (s) => `@font-face{font-family:"Heading";src:url(/fonts/Heading.woff2) format("woff2")}\n${s}h1{font-family:"Heading",sans-serif}\n`);
  const built = await buildSite({ site, out });
  assert.equal(built.ok, true, (built.errors ?? []).join("\n"));
  assert.equal(readFileSync(join(out, "fonts/poppins-OFL.txt"), "utf8"), readFileSync(join(HERE, "fonts/licenses/poppins-OFL.txt"), "utf8"));
  assert.ok(existsSync(join(out, "fonts/Silkscreen-OFL.txt")));
  // With only Cobra's fonts left, no licence file at all is needed.
  rmSync(join(site, "design/fonts/Silkscreen-OFL.txt"));
  rmSync(join(site, "design/fonts/Silkscreen-Regular.ttf"));
  edit(join(site, "design/site.css"), (s) => s.replace(/@font-face\s*\{[^}]*Silkscreen[^}]*\}/g, "").replace(/"?Silkscreen"?\s*,?/g, ""));
  const alone = checkSite({ site });
  assert.equal(alone.ok, true, (alone.errors ?? []).join("\n"));
});

test("every font the stylesheet names is served by the site itself, or a generic family (the Run Club site drew in Georgia)", async (t) => {
  const { site } = designCopy(t);
  const css = join(site, "design/site.css");
  // Run Club's: custom properties naming families with no @font-face.
  edit(css, (s) => `${s}\n:root{--serif:"DM Serif Display",Georgia,serif;--sans:Montserrat,system-ui,sans-serif}\nh1{font-family:var(--serif)}\np{font:300 17px/1.8 var(--sans)}\n`);
  const all = checkSite({ site }).errors.join("\n");
  assert.match(all, /design\/site.css: font-family "DM Serif Display" has no @font-face with a file in design\/fonts/);
  assert.match(all, /font-family "Montserrat" has no @font-face/, "the font shorthand too");
  assert.doesNotMatch(all, /"Georgia"|"Silkscreen"/, "a fallback after the first family, and a family with a face, pass");

  // A face whose file is not in design/fonts serves nothing.
  copyFileSync(join(HERE, "fonts/InstrumentSerif-Regular.woff2"), join(site, "design/fonts/InstrumentSerif-Regular.woff2"));
  edit(css, (s) => s.replace(/:root\{--serif[^\n]*\n/, "") + '@font-face{font-family:"Instrument Serif";src:url("/fonts/InstrumentSerif-Regular.woff2") format("woff2")}\n@font-face{font-family:"Geist";src:url("/fonts/Geist.woff2") format("woff2")}\n:root{--serif:"Instrument Serif",Georgia,serif;--sans:"Geist",sans-serif}\nh2{font-family:serif}\nem{font:italic 400 clamp(40px,5.6vw,76px)/1 var(--serif)}\n');
  const now = checkSite({ site }).errors.join("\n");
  assert.doesNotMatch(now, /"Instrument Serif"/);
  assert.match(now, /\/fonts\/Geist.woff2 is not in design\/fonts\//);
  assert.match(now, /font-family "Geist" has no @font-face/);
  copyFileSync(join(HERE, "fonts/Geist.woff2"), join(site, "design/fonts/Geist.woff2"));
  assert.equal(checkSite({ site }).ok, true, checkSite({ site }).errors?.join("\n"));
});

test("an image a page names must be in images/ and be what its name says", async (t) => {
  const { site, out } = designCopy(t);
  rmSync(join(site, "images/crew-moe.png"));
  writeFileSync(join(site, "images/crew-tito.png"), "not a png");
  const result = await buildSite({ site, out });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /images\/crew-moe.png: file not found/);
  assert.match(result.errors.join("\n"), /images\/crew-tito.png: the file is not a PNG image/);
});

// The site check: the built site in a
// real browser, under its own _headers. Skipped where no Chromium is found.
const browser = findChromium();

test("the check passes the example design, with a screenshot per page and width", { skip: !browser && "no Chromium on this computer" }, async (t) => {
  const { site, out, dir } = designCopy(t);
  assert.equal((await buildSite({ site, out, url: "https://corner-bakery.example", turnstile: "0x4AAAAAAA_test-key" })).ok, true);
  const result = await checkOut({ out, shots: join(dir, "shots") });
  assert.equal(result.ok, true, result.problems?.join("\n"));
  assert.deepEqual(result.pages, ["/", "/thanks/"]);
  assert.deepEqual(result.shots.map((s) => `${shotName(s.page)}-${s.view}`), ["home-desktop", "thanks-desktop", "home-phone", "thanks-phone"]);
  assert.equal(result.shots.find((s) => s.page === "/" && s.view === "phone").width, 390);
  for (const shot of result.shots) assert.deepEqual([...readFileSync(shot.file).subarray(0, 3)], [0xff, 0xd8, 0xff], "a JPEG");
});

test("the check names a missing image, a page wider than a phone, a script the CSP blocks and a link out for a resource", { skip: !browser && "no Chromium on this computer" }, async (t) => {
  const { site, out, dir } = designCopy(t);
  assert.equal((await buildSite({ site, out })).ok, true);
  writeFileSync(join(out, "site.css"), `${readFileSync(join(out, "site.css"), "utf8")}\n.hero { min-width: 900px; }\n`);
  rmSync(join(out, "images/crew-moe.png"));
  const thanks = join(out, "thanks/index.html");
  writeFileSync(thanks, readFileSync(thanks, "utf8").replace("</body>", '<script>console.log(1)</script><img src="https://evil.example/x.png" alt=""></body>'));
  const all = (await checkOut({ out, shots: join(dir, "shots") })).problems.join("\n");
  assert.match(all, /404 for \/images\/crew-moe.png/);
  assert.match(all, /image did not load: \/images\/crew-moe.png/);
  assert.match(all, /phone \/: the page is \d+px wider than the window/);
  assert.match(all, /thanks\/: console error: .*Content Security Policy/);
  assert.match(all, /loads https:\/\/evil.example\/x.png from another host/);
  assert.doesNotMatch(all, /Failed to load resource/);
});

test("_headers is read as Cloudflare does, and pages are named by their address", () => {
  const rules = parseHeaders("/*\n  Content-Security-Policy: default-src 'none'\n  X-Test: 1\n/fonts/*\n  Cache-Control: immutable\n");
  assert.deepEqual(rules.map((r) => r.pattern), ["/*", "/fonts/*"]);
  assert.equal(rules[0].headers["content-security-policy"], "default-src 'none'");
  assert.equal(shotName("/"), "home");
  assert.equal(shotName("/posts/hello-world/"), "posts-hello-world");
  assert.equal(findChromium({ CHROMIUM: "/nowhere/chromium" }), null);
});

// A design's own forms (content.json `forms`).
const QUOTE = {
  title: "Quote request",
  fields: [
    { name: "name", type: "text", required: true },
    { name: "email", type: "email", required: true },
    { name: "business_type", type: "select", label: "Business type", options: ["Bakery", "Florist", "Other"], required: true },
    { name: "extras", type: "checkbox", label: "Extras", options: ["Logo", "Photos"] },
    { name: "start", type: "date", label: "Start date" },
    { name: "source", type: "hidden", value: "spring flyer" },
  ],
};
const QUOTE_FORM = `<section class="quote">
  <form class="quote-form" method="post" action="/api/form/quote">
    <label>Your name <input name="name" required></label>
    <label>Email <input name="email" type="email" required></label>
    <fieldset><legend>Business</legend>
      <select name="business_type"><option>Bakery</option><option>Florist</option><option>Other</option></select>
    </fieldset>
    <label><input type="checkbox" name="extras" value="Logo"> Logo</label>
    <label><input type="checkbox" name="extras" value="Photos"> Photos</label>
    <label>Start <input type="date" name="start"></label>
    {{> form-guard}}
    <button>Ask for a quote</button>
  </form>
</section>`;

function withQuote(site, { form = QUOTE_FORM, forms = { quote: QUOTE } } = {}) {
  const content = JSON.parse(readFileSync(join(site, "content.json"), "utf8"));
  content.forms = forms;
  writeFileSync(join(site, "content.json"), JSON.stringify(content));
  edit(join(site, "design", "pages", "index.html"), (html) => html.replace("</body>", `${form}\n</body>`));
}

test("a design's own form: its markup and look, Cobra's guard inside, the forms written for the Worker and kept off the site", async (t) => {
  const { site, out } = designCopy(t);
  withQuote(site);
  const result = await buildSite({ site, out, turnstile: "0x4AAAAAAA_test-key" });
  assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
  const home = readFileSync(join(out, "index.html"), "utf8");
  const quote = home.match(/<form class="quote-form"[\s\S]*?<\/form>/)[0];
  assert.match(quote, /<label class="trap" aria-hidden="true">Company <input name="company"/);
  assert.match(quote, /<div class="cf-turnstile" data-sitekey="0x4AAAAAAA_test-key"/);
  assert.equal(home.match(/<script/g).length, 1, "the spam check's script once for both forms");
  const forms = JSON.parse(readFileSync(join(out, "_forms.json"), "utf8"));
  assert.deepEqual(forms.quote.fields.map((f) => [f.name, f.label, f.required]), [
    ["name", "Name", true],
    ["email", "Email", true],
    ["business_type", "Business type", true],
    ["extras", "Extras", false],
    ["start", "Start date", false],
    ["source", "Source", false],
  ]);
  assert.equal(forms.quote.kind, "inquiry");
  assert.equal(forms.quote.fields.at(-1).value, "spring flyer");
  assert.match(readFileSync(join(out, ".assetsignore"), "utf8"), /^_forms\.json$/m);
});

test("a design's own form is refused, naming why: an undeclared field, a missing control, no guard, an unknown form, no email field", async (t) => {
  const cases = [
    [{ form: QUOTE_FORM.replace('name="start"', 'name="when"') }, [/form quote sends when, which its fields in content.json do not have/, /form quote has no control for its field start/]],
    [{ form: QUOTE_FORM.replace("{{> form-guard}}", "") }, [/form quote has \{\{> form-guard\}\} inside/]],
    [{ form: QUOTE_FORM.replace("/api/form/quote", "/api/form/booking") }, [/\/api\/form\/booking is not a form in content.json forms/]],
    [{ form: QUOTE_FORM.replace('method="post"', 'method="get"') }, [/form quote has method="post"/]],
    [{ form: QUOTE_FORM.replace("/api/form/quote", "https://evil.example/collect") }, [/a <form> has action="\/api\/form\/<id>"/]],
    [{ form: QUOTE_FORM.replace("</form>", '<input type="hidden" name="source" value="x"></form>') }, [/source is hidden; the site sends its value itself/]],
    [{ forms: { quote: { ...QUOTE, fields: QUOTE.fields.filter((f) => f.type !== "email") } }, form: QUOTE_FORM.replace(/<label>Email[^\n]*\n/, "") }, [/one field of type email/]],
    [{ forms: { quote: { ...QUOTE, fields: [...QUOTE.fields, { name: "company", type: "text" }] } } }, [/name: like business_type/]],
    [{ forms: { quote: { ...QUOTE, fields: [...QUOTE.fields, { name: "size", type: "select" }] } } }, [/options: 1 to 30 choices/]],
  ];
  for (const [change, wanted] of cases) {
    const { site, out } = designCopy(t);
    withQuote(site, change);
    const result = await buildSite({ site, out });
    assert.equal(result.ok, false, `expected a refusal for ${wanted}`);
    for (const pattern of wanted) assert.ok(result.errors.some((e) => pattern.test(e)), `${pattern}\n${result.errors.join("\n")}`);
  }
});
