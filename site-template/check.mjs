#!/usr/bin/env node
// The site check: a built site opened
// in a real browser before anyone is asked to put it live.
//
//   node check.mjs --out <dir> --shots <dir> [--allow host,host] [--json]
//   node check.mjs --url <https address> --shots <dir> [--json]   (a site someone else coded: checkUrl)
//
// <out> is what build.mjs wrote. It is served on 127.0.0.1 with its own
// _headers, so the Content-Security-Policy is the one Cloudflare will send.
// Every page is opened in Chromium (playwright-core, the computer's own
// Chromium) at desktop (1440) and phone (390) width, and so is a missing page,
// which must answer 404 with the site's own page. Problems:
//   - a console error, a page error, a CSP violation, a request that failed or
//     answered 400 or more, a resource from another host
//   - an image that did not load, a font that failed, a page wider than the window
//   - pixel art (img.pixel or image-rendering: pixelated) drawn at a scale that
//     is not a whole number, which makes its pixels uneven
// Cloudflare's spam check is answered with an empty script, so the check never
// leaves the computer. Full-page JPEG screenshots of each page at each width go
// to <shots> (<page>-desktop.jpg, <page>-phone.jpg; the home page is "home").
//
// --json prints {ok, problems, pages, shots: [{page, view, file, width, height, bytes}]}.
// No Chromium: {ok: false, unavailable: "<what to install>"}, exit 2.
// Problems exit 1.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const VIEWS = [
  { view: "desktop", width: 1440, height: 900 },
  { view: "phone", width: 390, height: 844 },
];
/** A screenshot taller than this (CSS pixels) is cut there: Claude reads images up to 8000 pixels a side. */
export const MAX_SHOT_HEIGHT = 7200;
const TURNSTILE_HOST = "challenges.cloudflare.com";
const MISSING = "/cobra-check-missing-page/";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".js": "text/javascript",
};

/** Where Chromium usually is; CHROMIUM names another. */
const CHROMIUMS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export function findChromium(env = process.env) {
  if (env.CHROMIUM) return existsSync(env.CHROMIUM) ? env.CHROMIUM : null;
  return CHROMIUMS.find((path) => existsSync(path)) ?? null;
}

/**
 * _headers as Cloudflare reads it: a path pattern on its own line, then its
 * headers indented. A pattern is an exact path or ends in "*".
 */
export function parseHeaders(text) {
  const rules = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) rules.push({ pattern: line.trim(), headers: {} });
    else if (rules.length) {
      const at = line.indexOf(":");
      if (at > 0) rules.at(-1).headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
  }
  return rules;
}

function headersAt(rules, path) {
  const found = {};
  for (const rule of rules) {
    const match = rule.pattern.endsWith("*") ? path.startsWith(rule.pattern.slice(0, -1)) : path === rule.pattern;
    if (match) Object.assign(found, rule.headers);
  }
  return found;
}

/** Each page of a built site as its address: index.html is "/", a/index.html "/a/", 404.html "/404.html". */
export function pagesOf(out) {
  return readdirSync(out, { recursive: true })
    .map((file) => String(file).split(sep).join("/"))
    .filter((file) => file.endsWith(".html"))
    .map((file) => (file === "index.html" ? "/" : file.endsWith("/index.html") ? `/${file.slice(0, -"index.html".length)}` : `/${file}`))
    .filter((page) => page !== "/404.html")
    .sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
}

/** A page's name in screenshot files: "/" is home, "/thanks/" thanks, "/posts/hello/" posts-hello. */
export function shotName(page) {
  return page === "/" ? "home" : page.replace(/\.html$/, "").replace(/^\/|\/$/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "page";
}

export function serve(out) {
  const root = resolve(out);
  const headersFile = join(root, "_headers");
  const rules = existsSync(headersFile) ? parseHeaders(readFileSync(headersFile, "utf8")) : [];
  const server = createServer((request, response) => {
    let path;
    try {
      path = decodeURIComponent(new URL(request.url ?? "/", "http://check").pathname);
    } catch {
      path = "/";
    }
    let file = resolve(root, `.${path.endsWith("/") ? `${path}index.html` : path}`);
    let status = 200;
    const inside = file === root || file.startsWith(root + sep);
    if (!inside || !existsSync(file) || statSync(file).isDirectory() || file.endsWith(`${sep}_headers`)) {
      file = join(root, "404.html");
      status = 404;
    }
    const body = existsSync(file) ? readFileSync(file) : Buffer.from("not found");
    response.writeHead(status, { ...headersAt(rules, path), "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
    response.end(body);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

/** Runs the check. Never throws for the site's problems: they are in `problems`. */
/**
 * Whether a request is the site's own business to judge: a load by the page
 * itself or a frame it opens, but not a load inside a frame of a service the
 * site names (`allow`), which is that service's own (a map's tiles).
 */
export function judged(sent, mainFrame, allow) {
  let frame;
  try {
    frame = sent.frame();
  } catch {
    return true;
  }
  if (frame === mainFrame) return true;
  if (sent.isNavigationRequest() && frame.parentFrame() === mainFrame) return true;
  let top = frame;
  while (top.parentFrame() && top.parentFrame() !== mainFrame) top = top.parentFrame();
  try {
    return !allow.includes(new URL(top.url()).hostname);
  } catch {
    return true;
  }
}

/**
 * A coded site often shows its sections, and loads its lazy images and frames
 * (a map), only as they scroll into view: scroll down once, a screen at a time,
 * and back up, then wait for what that started.
 */
export async function scrollThrough(page) {
  await page.evaluate(() => document.querySelectorAll("iframe[loading=lazy]").forEach((frame) => frame.setAttribute("loading", "eager"))).catch(() => undefined);
  await page
    .evaluate(async () => {
      const pause = (ms) => new Promise((done) => setTimeout(done, ms));
      for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 60; y += Math.round(window.innerHeight * 0.8), i += 1) {
        window.scrollTo(0, y);
        await pause(150);
      }
      window.scrollTo(0, 0);
      await pause(400);
    })
    .catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
}

export async function checkOut({ out, shots, chromium: executablePath = findChromium(), allow = [] }) {
  if (!existsSync(join(out, "index.html"))) return { ok: false, problems: ["the build has no index.html"], pages: [], shots: [] };
  if (!executablePath) {
    return { ok: false, unavailable: "Chromium is not installed, so the site cannot be checked. Install it (Arch: pacman -S chromium; Debian or Ubuntu: apt install chromium; macOS: Google Chrome), or set CHROMIUM to its path." };
  }
  let playwright;
  try {
    playwright = await import("playwright-core");
  } catch {
    return { ok: false, unavailable: "playwright-core is missing from the site template (npm ci in site-template/)." };
  }
  const server = await serve(out);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pages = pagesOf(out);
  const problems = [];
  const kept = [];
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const browser = await playwright.chromium.launch({ executablePath, args: ["--no-sandbox"] });
  try {
    for (const { view, width, height } of VIEWS) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce" });
      // Cloudflare's spam check answers with nothing, so nothing leaves the computer.
      await context.route(`https://${TURNSTILE_HOST}/**`, (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
      for (const path of [...pages, MISSING]) {
        const missing = path === MISSING;
        const tag = `${view} ${missing ? "a missing page" : path}`;
        const page = await context.newPage();
        page.on("console", (message) => {
          if (message.type() !== "error") return;
          if (missing && /404/.test(message.text())) return;
          // Said better by the response's own line, which names the file.
          if (/^Failed to load resource/.test(message.text())) return;
          problems.push(`${tag}: console error: ${message.text()}`);
        });
        page.on("pageerror", (caught) => problems.push(`${tag}: page error: ${caught.message}`));
        page.on("requestfailed", (failed) => problems.push(`${tag}: did not load ${failed.url().replace(origin, "")} (${failed.failure()?.errorText ?? "failed"})`));
        page.on("request", (sent) => {
          const url = new URL(sent.url());
          if (url.origin === origin || url.hostname === TURNSTILE_HOST || url.protocol === "data:" || !judged(sent, page.mainFrame(), allow)) return;
          if (!allow.includes(url.hostname)) problems.push(`${tag}: loads ${url.href} from another host`);
        });
        page.on("response", (answer) => {
          const own = answer.url().startsWith(origin);
          if (own && answer.status() >= 400 && !(missing && answer.url().endsWith(MISSING))) problems.push(`${tag}: ${answer.status()} for ${answer.url().replace(origin, "")}`);
        });
        const answer = await page.goto(origin + path, { waitUntil: "load", timeout: 30_000 }).catch((caught) => {
          problems.push(`${tag}: did not open (${caught.message.split("\n")[0]})`);
          return null;
        });
        if (!answer) {
          await page.close();
          continue;
        }
        if (missing && answer.status() !== 404) problems.push(`a missing page answers ${answer.status()}, not 404`);
        await scrollThrough(page);
        // Every image now, not when it scrolls into view, then every font.
        await page.evaluate(() => document.querySelectorAll("img[loading=lazy]").forEach((image) => image.setAttribute("loading", "eager")));
        await page
          .waitForFunction(() => [...document.images].every((image) => image.complete), null, { timeout: 15_000 })
          .catch(() => problems.push(`${tag}: images still loading after 15 seconds`));
        await page.evaluate(() => document.fonts.ready);
        const report = await page.evaluate(() => ({
          sideways: document.documentElement.scrollWidth - window.innerWidth,
          tall: document.documentElement.scrollHeight,
          broken: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.getAttribute("src")),
          fonts: [...document.fonts].filter((font) => font.status === "error").map((font) => font.family),
          uneven: [...document.images]
            .filter((image) => image.naturalWidth > 0 && (image.classList.contains("pixel") || getComputedStyle(image).imageRendering === "pixelated"))
            .map((image) => ({ src: image.getAttribute("src"), scale: image.getBoundingClientRect().width / image.naturalWidth, fit: getComputedStyle(image).objectFit }))
            .filter((found) => found.fit !== "cover" && found.scale > 1.01 && Math.abs(found.scale - Math.round(found.scale)) > 0.05),
        }));
        if (report.sideways > 0) problems.push(`${tag}: the page is ${report.sideways}px wider than the window, so it scrolls sideways`);
        for (const src of report.broken) problems.push(`${tag}: image did not load: ${src}`);
        for (const family of new Set(report.fonts)) problems.push(`${tag}: font did not load: ${family}`);
        for (const found of report.uneven) problems.push(`${tag}: pixel art ${found.src} drawn at ${found.scale.toFixed(2)}x; use a whole number so its pixels stay even`);
        if (!missing) {
          const file = join(shots, `${shotName(path)}-${view}.jpg`);
          const shotHeight = Math.min(report.tall, MAX_SHOT_HEIGHT);
          await page.screenshot({ path: file, type: "jpeg", quality: 80, fullPage: report.tall <= MAX_SHOT_HEIGHT, ...(report.tall > MAX_SHOT_HEIGHT ? { clip: { x: 0, y: 0, width, height: shotHeight } } : {}) });
          kept.push({ page: path, view, file, width, height: Math.max(shotHeight, height), bytes: statSync(file).size });
        }
        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  const unique = [...new Set(problems)];
  return { ok: unique.length === 0, problems: unique, pages, shots: kept };
}

/** Words for a page that is a sign-in wall instead of the site (a host's protected preview). */
export function walled(requested, reached, status) {
  if (status === 401 || status === 403) return `the page answered ${status}: the host keeps it behind a sign-in`;
  try {
    const from = new URL(requested).hostname;
    const to = new URL(reached).hostname;
    if (from !== to && /(^|\.)(vercel\.com|netlify\.com|cloudflareaccess\.com|github\.com)$/.test(to)) return `the page sent the browser to ${to}: the host keeps it behind a sign-in`;
  } catch {
    // an address the browser could not read: judged by the rest
  }
  return null;
}

/**
 * A website someone else coded: one https
 * page opened as it is served, at desktop and phone width. It is the site's
 * own page on its own host, so scripts and other hosts are its business; the
 * problems are what a visitor would see go wrong: a page error, a failed load
 * from the site's own host, a broken image or font, sideways scrolling.
 */
export async function checkUrl({ url, shots, chromium: executablePath = findChromium() }) {
  let address;
  try {
    address = new URL(url);
  } catch {
    return { ok: false, problems: [`not an address: ${url}`], pages: [], shots: [] };
  }
  if (address.protocol !== "https:") return { ok: false, problems: ["only an https address is opened"], pages: [], shots: [] };
  if (!executablePath) {
    return { ok: false, unavailable: "Chromium is not installed, so the site cannot be opened. Install it (Arch: pacman -S chromium; Debian or Ubuntu: apt install chromium; macOS: Google Chrome), or set CHROMIUM to its path." };
  }
  let playwright;
  try {
    playwright = await import("playwright-core");
  } catch {
    return { ok: false, unavailable: "playwright-core is missing from the site template (npm ci in site-template/)." };
  }
  const path = address.pathname || "/";
  const problems = [];
  const kept = [];
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const browser = await playwright.chromium.launch({ executablePath, args: ["--no-sandbox"] });
  try {
    for (const { view, width, height } of VIEWS) {
      const tag = `${view} ${path}`;
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce" });
      const page = await context.newPage();
      page.on("pageerror", (caught) => problems.push(`${tag}: page error: ${caught.message}`));
      page.on("console", (message) => {
        if (message.type() === "error" && !/^Failed to load resource/.test(message.text())) problems.push(`${tag}: console error: ${message.text().slice(0, 300)}`);
      });
      page.on("response", (answer) => {
        const own = new URL(answer.url()).origin === address.origin;
        if (own && answer.status() >= 400 && answer.request().resourceType() !== "document") problems.push(`${tag}: ${answer.status()} for ${answer.url().replace(address.origin, "")}`);
      });
      const answer = await page.goto(address.href, { waitUntil: "load", timeout: 45_000 }).catch((caught) => {
        problems.push(`${tag}: did not open (${caught.message.split("\n")[0]})`);
        return null;
      });
      if (!answer) {
        await context.close();
        continue;
      }
      const wall = walled(address.href, page.url(), answer.status());
      if (wall) {
        await context.close();
        return { ok: false, unavailable: `The page could not be looked at: ${wall}. Ask the person to open it themselves, or to let its previews be seen without signing in.`, pages: [], shots: [] };
      }
      if (answer.status() >= 400) problems.push(`${tag}: the page answered ${answer.status()}`);
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      await scrollThrough(page);
      await page.evaluate(() => document.querySelectorAll("img[loading=lazy]").forEach((image) => image.setAttribute("loading", "eager")));
      await page
        .waitForFunction(() => [...document.images].every((image) => image.complete), null, { timeout: 15_000 })
        .catch(() => problems.push(`${tag}: images still loading after 15 seconds`));
      await page.evaluate(() => document.fonts.ready);
      const report = await page.evaluate(() => ({
        sideways: document.documentElement.scrollWidth - window.innerWidth,
        tall: document.documentElement.scrollHeight,
        broken: [...document.images].filter((image) => image.complete && image.naturalWidth === 0 && image.getAttribute("src")).map((image) => image.getAttribute("src")),
        // A framework's metric fallback (next/font's "<family> Fallback", src local()) is not the site's font.
        fonts: [...document.fonts].filter((font) => font.status === "error" && !/ fallback$/i.test(font.family.replace(/["']/g, "").trim())).map((font) => font.family),
      }));
      if (report.sideways > 0) problems.push(`${tag}: the page is ${report.sideways}px wider than the window, so it scrolls sideways`);
      for (const src of report.broken) problems.push(`${tag}: image did not load: ${src}`);
      for (const family of new Set(report.fonts)) problems.push(`${tag}: font did not load: ${family}`);
      const file = join(shots, `${shotName(path)}-${view}.jpg`);
      const shotHeight = Math.min(report.tall, MAX_SHOT_HEIGHT);
      await page.screenshot({ path: file, type: "jpeg", quality: 80, fullPage: report.tall <= MAX_SHOT_HEIGHT, ...(report.tall > MAX_SHOT_HEIGHT ? { clip: { x: 0, y: 0, width, height: shotHeight } } : {}) });
      kept.push({ page: path, view, file, width, height: Math.max(shotHeight, height), bytes: statSync(file).size });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const unique = [...new Set(problems)];
  return { ok: unique.length === 0, problems: unique, pages: [path], shots: kept };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: "string" }, url: { type: "string" }, shots: { type: "string" }, allow: { type: "string" }, json: { type: "boolean" } } });
  if ((!values.out && !values.url) || !values.shots) {
    console.error("usage: node check.mjs (--out <dir> [--allow host,host] | --url <https address>) --shots <dir> [--json]");
    process.exit(64);
  }
  const allow = (values.allow ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  const result = values.url ? await checkUrl({ url: values.url, shots: resolve(values.shots) }) : await checkOut({ out: resolve(values.out), shots: resolve(values.shots), allow });
  if (values.json) console.log(JSON.stringify(result));
  else if (result.unavailable) console.error(result.unavailable);
  else console.log(result.ok ? `check passed: ${result.pages.length} pages, ${result.shots.length} screenshots in ${values.shots}` : result.problems.join("\n"));
  process.exit(result.unavailable ? 2 : result.ok ? 0 : 1);
}
