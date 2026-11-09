import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectDb, QueryResult, Row, SchemaDescription } from "./dbTypes.ts";
import { csvCell, fileUrlFor, printArgs, printBrowser, printWithChromium, RenderError, renderReport, sampleColumns, toCsv, type PrintDeps } from "./render.ts";
import type { RenderDeps, RenderProject, RenderRequest } from "./renderTypes.ts";

const ROWS: Row[] = [
  { employee: "Ada Lovelace", period: "2026-10-01", hours: 37.5, net_cents: 123456, note: "=SUM(A1)" },
  { employee: "Brian O'Neil", period: "2026-10-01", hours: 40, net_cents: 7, note: 'say "hi", twice' },
  { employee: "Ada Lovelace", period: "2026-10-08", hours: 12, net_cents: 9900, note: null },
];

type FakeDb = ProjectDb & { calls: Array<{ sql: string; params: unknown; limit: unknown }> };

/** A ProjectDb that answers every SELECT with fixed rows and knows a business table. */
function fakeDb(over: { rows?: Row[]; truncated?: boolean; business?: Row | null; hasBusiness?: boolean } = {}): FakeDb {
  const rows = over.rows ?? ROWS;
  const columns = rows.length > 0 ? Object.keys(rows[0]!) : ["employee", "period", "hours", "net_cents", "note"];
  const business = over.business === undefined ? { id: 1, legal_name: "Acme & Sons Ltd", currency: "GBP", logo_path: "assets/logo.png" } : over.business;
  const calls: FakeDb["calls"] = [];
  const notHere = (): never => {
    throw new Error("not for the renderer");
  };
  return {
    calls,
    describe: (): SchemaDescription => ({
      trade: "payroll-manager",
      version: 1,
      tables: over.hasBusiness === false ? [] : [{ name: "business", describe: "the business", columns: [] }, { name: "employees", describe: "people", columns: [] }],
      mutations: [],
    }),
    query: notHere,
    queryRaw: (sql, params, limit): QueryResult => {
      calls.push({ sql, params, limit });
      if (/FROM business/i.test(sql)) return { columns: business ? Object.keys(business) : [], rows: business ? [business] : [], truncated: false, masked: [] };
      return { columns, rows, truncated: over.truncated === true, masked: [] };
    },
    write: notHere,
    importRows: notHere,
    undo: notHere,
    journal: notHere,
    tables: notHere,
    close: () => undefined,
  };
}

type World = { repo: string; shipped: string; project: RenderProject; deps: RenderDeps; printed: Array<{ html: string; pdf: string; htmlExisted: boolean; page: string }> };

const PROJECT_TEMPLATE = `<!doctype html><title>{{project.name}}</title><h1>{{business.legal_name}}</h1><img src="{{file business.logo_path}}">
<p>Period {{args.period}} for {{row.employee}} ({{split}})</p>
<ul>{{#each rows}}<li>{{@number}}. {{employee}} {{hours hours}}h {{money net_cents}} {{note}}</li>{{/each}}</ul>
<p>Total {{moneysum rows "net_cents"}} over {{count rows}} rows; project template</p>`;

const SHIPPED_TEMPLATE = `<!doctype html><h1>Shipped {{business.legal_name}}</h1>{{#each rows}}<p>{{employee}}</p>{{/each}}`;

function world(over: { projectTemplates?: Record<string, string>; shippedTemplates?: Record<string, string>; trade?: string | undefined } = {}): World {
  const root = mkdtempSync(join(tmpdir(), "cobra-render-"));
  const repo = join(root, "repo");
  const shipped = join(root, "shipped");
  mkdirSync(join(repo, "assets"), { recursive: true });
  writeFileSync(join(repo, "assets", "logo.png"), "png");
  writeFileSync(join(repo, "assets", "client-secret.png"), "png");
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside", "secret.png"), "png");
  symlinkSync(join(root, "outside", "secret.png"), join(repo, "assets", "link.png"));
  const projectTemplates = over.projectTemplates ?? { "pay-stub": PROJECT_TEMPLATE };
  for (const [name, source] of Object.entries(projectTemplates)) {
    mkdirSync(join(repo, "templates", name), { recursive: true });
    writeFileSync(join(repo, "templates", name, "index.html"), source);
  }
  const trade = "trade" in over ? over.trade : "payroll-manager";
  const shippedTemplates = over.shippedTemplates ?? { "pay-stub": SHIPPED_TEMPLATE, "pay-run": SHIPPED_TEMPLATE };
  for (const [name, source] of Object.entries(shippedTemplates)) {
    mkdirSync(join(shipped, "payroll-manager", name), { recursive: true });
    writeFileSync(join(shipped, "payroll-manager", name, "index.html"), source);
  }
  const printed: World["printed"] = [];
  const deps: RenderDeps = {
    printPdf: async (html, pdf) => {
      const page = readFileSync(html, "utf8");
      printed.push({ html, pdf, htmlExisted: existsSync(html), page });
      writeFileSync(pdf, `%PDF-fake ${page.length}`);
    },
    now: () => new Date(2026, 9, 18, 14, 5, 0),
    shippedTemplates: shipped,
  };
  const project: RenderProject = { id: "p1", name: "Northstar Payroll", path: repo, ...(trade === undefined ? {} : { foremanTemplate: trade }) };
  return { repo, shipped, project, deps, printed };
}

const request = (over: Partial<RenderRequest> = {}): RenderRequest => ({ template: "pay-stub", sql: "SELECT * FROM pay_items", format: "html", ...over });

async function refused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RenderError, `a RenderError, not ${String(error)}`);
    return error.message;
  }
  assert.fail("was not refused");
}

test("html renders the project's template over the shipped one, with the business row and the file helper", async () => {
  const w = world();
  const db = fakeDb();
  const result = await renderReport(w.deps, w.project, db, request({ args: { period: "October 2026" } }));
  assert.equal(result.template.source, "project");
  assert.equal(result.template.name, "pay-stub");
  assert.equal(result.rows, 3);
  assert.equal(result.files.length, 1);
  const [file] = result.files;
  assert.equal(file!.path, "out/pay-stub-2026-10-18.html");
  assert.equal(file!.name, "pay-stub-2026-10-18.html");
  assert.equal(file!.rows, 3);
  assert.equal("split" in file!, false);
  const full = join(w.repo, file!.path);
  const html = readFileSync(full, "utf8");
  assert.equal(file!.bytes, Buffer.byteLength(html));
  assert.equal(file!.sha256, createHash("sha256").update(html).digest("hex"));
  assert.match(html, /<h1>Acme &amp; Sons Ltd<\/h1>/);
  assert.match(html, /<title>Northstar Payroll<\/title>/);
  assert.match(html, /Period October 2026 for Ada Lovelace \(\)/);
  assert.match(html, /1\. Ada Lovelace 37\.5h £1,234\.56 =SUM\(A1\)/);
  assert.match(html, /2\. Brian O&#39;Neil 40h £0\.07 say &quot;hi&quot;, twice/);
  assert.match(html, /Total £1,333\.63 over 3 rows; project template/);
  assert.match(html, new RegExp(`<img src="file://${w.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/assets/logo.png">`));
  // The real SELECT ran raw with the renderer's cap, and the business row was read.
  assert.deepEqual(db.calls[0], { sql: "SELECT * FROM pay_items", params: [], limit: 5000 });
  assert.match(db.calls[1]!.sql, /FROM business/);
  // out/ is private to the owner.
  assert.equal(statSync(join(w.repo, "out")).mode & 0o777, 0o700);
});

test("the shipped template is used when the project has none, and business is null without the table", async () => {
  const w = world({ projectTemplates: {} });
  const result = await renderReport(w.deps, w.project, fakeDb({ hasBusiness: false }), request());
  assert.equal(result.template.source, "shipped");
  const html = readFileSync(join(w.repo, result.files[0]!.path), "utf8");
  assert.match(html, /<h1>Shipped <\/h1>/);
  assert.match(html, /<p>Ada Lovelace<\/p><p>Brian O&#39;Neil<\/p>/);
});

test("a trade Cobra defined renders from its own templates folder", async () => {
  const w = world({ projectTemplates: {}, trade: "dog-walking" });
  const definedDir = join(w.shipped, "..", "defined-templates");
  mkdirSync(join(definedDir, "pay-stub"), { recursive: true });
  writeFileSync(join(definedDir, "pay-stub", "index.html"), "<h1>Walks</h1>{{#each rows}}<p>{{employee}}</p>{{/each}}");
  const deps: RenderDeps = { ...w.deps, definedTemplates: (trade) => (trade === "dog-walking" ? definedDir : null) };
  const result = await renderReport(deps, w.project, fakeDb({ hasBusiness: false }), request());
  assert.equal(result.template.source, "shipped");
  assert.match(readFileSync(join(w.repo, result.files[0]!.path), "utf8"), /<h1>Walks<\/h1><p>Ada Lovelace<\/p>/);
});

test("a template with a sample.json is refused a query that leaves out a column its sample rows have, naming them", async () => {
  const reads = `<!doctype html>{{! planted never prints }}<!-- nor net_cents -->{{#each rows}}<p>{{employee}} {{tax_code}} {{period}} {{business.hours}}</p>{{/each}}`;
  const w = world({ projectTemplates: {}, shippedTemplates: { "pay-stub": reads, "pay-run": SHIPPED_TEMPLATE } });
  // planted and net_cents are named only in comments, and hours only as business.hours: none is asked for.
  const sample = { business: null, rows: [{ employee: "Ada", hours: 1, net_cents: 100, tax_code: "1257L", planted: "x" }, { employee: "Bob", period: "Oct" }], args: {} };
  writeFileSync(join(w.shipped, "payroll-manager", "pay-stub", "sample.json"), JSON.stringify(sample));
  const message = await refused(renderReport(w.deps, w.project, fakeDb(), request()));
  assert.match(message, /template pay-stub reads columns the query did not return: tax_code\. Return each one, named exactly so \(AS tax_code; NULL AS tax_code when there is none\)\. It reads employee, tax_code, period$/);
  // A CSV is the query's own columns: the template's sample does not apply.
  const csv = await renderReport(w.deps, w.project, fakeDb(), request({ format: "csv" }));
  assert.equal(csv.files.length, 1);
  // No sample, or one that is not JSON: nothing to check against.
  writeFileSync(join(w.shipped, "payroll-manager", "pay-stub", "sample.json"), "{not json");
  assert.equal((await renderReport(w.deps, w.project, fakeDb(), request())).files.length, 1);
  assert.equal(await sampleColumns(join(w.shipped, "payroll-manager", "pay-run"), SHIPPED_TEMPLATE), null);
});

test("an unknown template is refused naming the templates of both places", async () => {
  const w = world();
  const message = await refused(renderReport(w.deps, w.project, fakeDb(), request({ template: "invoice" })));
  assert.match(message, /no template "invoice"/);
  assert.match(message, /pay-stub \(project\)/);
  assert.match(message, /pay-run \(payroll-manager\), pay-stub \(payroll-manager\)/);
  const bare = world({ projectTemplates: {}, trade: undefined });
  const none = await refused(renderReport(bare.deps, bare.project, fakeDb(), request()));
  assert.match(none, /no template "pay-stub": the project has no templates\/ folder with one and the project has no trade/);
  assert.match(none, /templates\/pay-stub\/index\.html/);
});

test("the request is checked before anything runs", async () => {
  const w = world();
  const db = fakeDb();
  for (const [bad, pattern] of [
    [{ template: "Pay Stub" }, /template is a folder name/],
    [{ template: "../x" }, /template is a folder name/],
    [{ template: "" }, /template is a folder name/],
    [{ format: "docx" as never }, /format is one of pdf, html, csv/],
    [{ sql: "  " }, /sql is the SELECT/],
    [{ params: ["a", {} as never] }, /params is a list/],
    [{ args: [] as never }, /args is an object/],
    [{ split: "" }, /split is the name of a result column/],
    [{ name: "..." }, /leaves nothing usable/],
    [{ name: 3 as never }, /name is the file's base name/],
  ] as Array<[Partial<RenderRequest>, RegExp]>) {
    assert.match(await refused(renderReport(w.deps, w.project, db, request(bad))), pattern);
  }
  assert.equal(db.calls.length, 0);
  assert.equal(existsSync(join(w.repo, "out")), false);
});

test("split makes one file per distinct value, in first-seen order, with that group's rows and a sanitised name", async () => {
  const w = world();
  const result = await renderReport(w.deps, w.project, fakeDb(), request({ split: "employee", args: { period: "W41" } }));
  assert.equal(result.rows, 3);
  assert.deepEqual(
    result.files.map((file) => ({ name: file.name, split: file.split, rows: file.rows })),
    [
      { name: "pay-stub-2026-10-18-Ada-Lovelace.html", split: "Ada Lovelace", rows: 2 },
      { name: "pay-stub-2026-10-18-Brian-O-Neil.html", split: "Brian O'Neil", rows: 1 },
    ],
  );
  const ada = readFileSync(join(w.repo, result.files[0]!.path), "utf8");
  assert.match(ada, /for Ada Lovelace \(Ada Lovelace\)/);
  assert.match(ada, /1\. Ada Lovelace 37\.5h/);
  assert.match(ada, /2\. Ada Lovelace 12h £99\.00/);
  assert.doesNotMatch(ada, /Brian/);
  assert.match(ada, /Total £1,333\.56 over 2 rows/);
  const brian = readFileSync(join(w.repo, result.files[1]!.path), "utf8");
  assert.match(brian, /1\. Brian O&#39;Neil 40h/);
  assert.doesNotMatch(brian, /Ada/);
  assert.match(brian, /over 1 rows/);
  // A split on a column the query did not return is refused.
  assert.match(await refused(renderReport(w.deps, w.project, fakeDb(), request({ split: "nope" }))), /"nope" is not one of employee, period, hours, net_cents, note/);
  // A null split value gets a name too.
  const nulls = await renderReport(w.deps, w.project, fakeDb({ rows: [{ employee: null, net_cents: 1 }, { employee: 7, net_cents: 2 }] }), request({ split: "employee", name: "x" }));
  assert.deepEqual(nulls.files.map((file) => [file.name, file.split]), [["x-none.html", null], ["x-7.html", 7]]);
  assert.match(await refused(renderReport(w.deps, w.project, fakeDb({ rows: [] }), request({ split: "employee" }))), /no rows/);
});

test("csv: header, RFC 4180 quoting, cents kept, the apostrophe rule; no template needed", async () => {
  const w = world({ projectTemplates: {}, shippedTemplates: {} });
  const result = await renderReport(w.deps, w.project, fakeDb(), request({ template: "pay-items", format: "csv", name: "items" }));
  assert.equal(result.files[0]!.name, "items.csv");
  assert.equal(result.template.source, "project");
  const csv = readFileSync(join(w.repo, "out", "items.csv"), "utf8");
  assert.equal(
    csv,
    ["employee,period,hours,net_cents,note", "Ada Lovelace,2026-10-01,37.5,123456,'=SUM(A1)", `Brian O'Neil,2026-10-01,40,7,"say ""hi"", twice"`, "Ada Lovelace,2026-10-08,12,9900,", ""].join("\r\n"),
  );
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("-2"), "'-2");
  assert.equal(csvCell("@x"), "'@x");
  assert.equal(csvCell(-2), "-2");
  assert.equal(csvCell("a\nb"), '"a\nb"');
  assert.equal(toCsv(["=cmd"], [{ "=cmd": "v" }]), "'=cmd\r\nv\r\n");
  // With a split, each CSV holds its group.
  const split = await renderReport(w.deps, w.project, fakeDb(), request({ template: "pay-items", format: "csv", split: "period" }));
  assert.deepEqual(split.files.map((file) => file.name), ["pay-items-2026-10-18-2026-10-01.csv", "pay-items-2026-10-18-2026-10-08.csv"]);
  assert.equal(readFileSync(join(w.repo, split.files[1]!.path), "utf8").split("\r\n").length, 3);
  // The name is still checked, since it names the file.
  assert.match(await refused(renderReport(w.deps, w.project, fakeDb(), request({ template: "Bad Name", format: "csv" }))), /template is a folder name/);
});

test("pdf calls printPdf with a temp HTML beside the PDF, then removes it", async () => {
  const w = world();
  const result = await renderReport(w.deps, w.project, fakeDb(), request({ format: "pdf", name: "stub" }));
  assert.equal(w.printed.length, 1);
  const [print] = w.printed;
  assert.match(print!.html, /\/out\/\.render-[0-9a-f]{12}\.html$/);
  assert.equal(print!.htmlExisted, true);
  assert.equal(print!.pdf, join(w.repo, "out", "stub.pdf"));
  assert.match(print!.page, /project template/);
  assert.equal(existsSync(print!.html), false);
  assert.deepEqual(readdirSync(join(w.repo, "out")), ["stub.pdf"]);
  assert.equal(result.files[0]!.path, "out/stub.pdf");
  assert.match(readFileSync(join(w.repo, "out", "stub.pdf"), "utf8"), /^%PDF-fake/);
  assert.equal(result.files[0]!.bytes, statSync(join(w.repo, "out", "stub.pdf")).size);
  // A name with the extension already is not doubled.
  const named = await renderReport(w.deps, w.project, fakeDb(), request({ format: "pdf", name: "Stub October.PDF" }));
  assert.equal(named.files[0]!.name, "Stub October.pdf");
});

test("a failed print names the step, leaves no PDF and removes the page", async () => {
  const w = world();
  const deps: RenderDeps = { ...w.deps, printPdf: async () => { throw new Error("could not reach Google's download server for chrome-headless-shell: fetch failed"); } };
  await assert.rejects(renderReport(deps, w.project, fakeDb(), request({ format: "pdf" })), (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof RenderError));
    assert.match((error as Error).message, /^printing pay-stub-2026-10-18\.pdf: could not reach Google's download server for chrome-headless-shell: fetch failed$/);
    return true;
  });
  assert.deepEqual(readdirSync(join(w.repo, "out")), []);
});

test("a second render of the same name does not overwrite", async () => {
  const w = world();
  const first = await renderReport(w.deps, w.project, fakeDb(), request({ name: "stub" }));
  const second = await renderReport(w.deps, w.project, fakeDb(), request({ name: "stub" }));
  const third = await renderReport(w.deps, w.project, fakeDb(), request({ name: "stub", split: "employee" }));
  assert.equal(first.files[0]!.name, "stub.html");
  assert.equal(second.files[0]!.name, "stub (2).html");
  assert.deepEqual(third.files.map((file) => file.name), ["stub-Ada-Lovelace.html", "stub-Brian-O-Neil.html"]);
  const again = await renderReport(w.deps, w.project, fakeDb(), request({ name: "stub", split: "employee" }));
  assert.deepEqual(again.files.map((file) => file.name), ["stub-Ada-Lovelace (2).html", "stub-Brian-O-Neil (2).html"]);
  // A file somebody else put there is kept too.
  writeFileSync(join(w.repo, "out", "stub (3).html"), "theirs");
  const fourth = await renderReport(w.deps, w.project, fakeDb(), request({ name: "stub" }));
  assert.equal(fourth.files[0]!.name, "stub (4).html");
  assert.equal(readFileSync(join(w.repo, "out", "stub (3).html"), "utf8"), "theirs");
});

test("a truncated result and a failing query are refused", async () => {
  const w = world();
  assert.match(await refused(renderReport(w.deps, w.project, fakeDb({ truncated: true }), request())), /more than 5000 rows; narrow the query/);
  const failing = fakeDb();
  failing.queryRaw = () => {
    throw new Error("no such column: nett");
  };
  assert.match(await refused(renderReport(w.deps, w.project, failing, request())), /the query failed: no such column: nett/);
  assert.equal(existsSync(join(w.repo, "out")), false);
});

test("the file helper resolves inside the repository and refuses everything else", async () => {
  const w = world();
  const url = fileUrlFor(w.repo);
  assert.equal(url("assets/logo.png"), `file://${w.repo}/assets/logo.png`);
  assert.equal(url("./assets/logo.png"), `file://${w.repo}/assets/logo.png`);
  assert.equal(url("../outside/secret.png"), "");
  assert.equal(url(join(w.repo, "assets", "logo.png")), "");
  assert.equal(url("assets/link.png"), "", "a symlink out of the repository");
  assert.equal(url("assets/client-secret.png"), "", "a credential-looking file");
  assert.equal(url("assets"), "", "a folder");
  assert.equal(url("assets/missing.png"), "");
  assert.equal(url(""), "");
  assert.equal(fileUrlFor(join(w.repo, "nowhere"))("assets/logo.png"), "");
  // Through a template, with a path from the data.
  const result = await renderReport(w.deps, w.project, fakeDb({ business: { id: 1, legal_name: "X", currency: "GBP", logo_path: "../outside/secret.png" } }), request());
  assert.match(readFileSync(join(w.repo, result.files[0]!.path), "utf8"), /<img src="">/);
});

test("a template error is passed on with its line", async () => {
  const w = world({ projectTemplates: { broken: "ok\n{{#each rows}}\n{{nope x}}\n{{/each}}" } });
  await assert.rejects(renderReport(w.deps, w.project, fakeDb(), request({ template: "broken" })), /line 3: unknown helper "nope"/);
});

// --- the printer ----------------------------------------------------------------

/** A stand-in browser: a shell script that records its arguments and writes the PDF it is told to, or fails as told. */
function fakeBrowser(dir: string, body = 'for a in "$@"; do case "$a" in --print-to-pdf=*) printf "%%PDF-fake" > "${a#--print-to-pdf=}";; esac; done'): { path: string; args: () => string[] } {
  const path = join(dir, "chrome-headless-shell");
  const log = join(dir, "args.txt");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n${body}\n`, { mode: 0o755 });
  return { path, args: () => readFileSync(log, "utf8").trim().split("\n") };
}

function printWorld(env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cobra-printer-"));
  const browser = fakeBrowser(dir);
  const html = join(dir, "page.html");
  writeFileSync(html, "<!doctype html><p>Hello</p>");
  let ensured = 0;
  const deps: PrintDeps = {
    env,
    ensureBrowser: async () => {
      ensured++;
      return browser.path;
    },
    spawn,
  };
  return { dir, browser, html, pdf: join(dir, "page.pdf"), deps, ensured: () => ensured };
}

test("the printer uses the agent's own browser, never one on PATH", async () => {
  const w = printWorld();
  // A chromium on PATH is not looked for.
  mkdirSync(join(w.dir, "bin"));
  writeFileSync(join(w.dir, "bin", "chromium"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  w.deps.env = { PATH: join(w.dir, "bin") };
  assert.deepEqual(await printBrowser(w.deps), { binary: w.browser.path, managed: true });
  await printWithChromium(w.html, w.pdf, w.deps);
  assert.equal(w.ensured(), 2);
  assert.equal(readFileSync(w.pdf, "utf8"), "%PDF-fake");
  const args = w.browser.args();
  assert.equal(args.includes("--headless=new"), false, "chrome-headless-shell takes no --headless");
  assert.ok(args.includes(`--print-to-pdf=${w.pdf}`));
  assert.ok(args.includes("--no-sandbox"));
  assert.ok(args.some((arg) => arg.startsWith("--user-data-dir=")));
  assert.equal(args.at(-1), `file://${w.html}`);
});

test("COBRA_CHROMIUM overrides the agent's browser and runs headless", async () => {
  const w = printWorld();
  const other = fakeBrowser(mkdtempSync(join(tmpdir(), "cobra-printer-other-")));
  w.deps.env = { COBRA_CHROMIUM: ` ${other.path} ` };
  await printWithChromium(w.html, w.pdf, w.deps);
  assert.equal(w.ensured(), 0, "nothing is downloaded");
  assert.equal(other.args()[0], "--headless=new");
  w.deps.env = { COBRA_CHROMIUM: join(w.dir, "nowhere") };
  await assert.rejects(printWithChromium(w.html, w.pdf, w.deps), /^Error: COBRA_CHROMIUM is .*nowhere, which is not a program on this computer$/);
  assert.deepEqual(printArgs(false, "/p", "/o.pdf", "file:///x.html").slice(0, 1), ["--headless=new"]);
  assert.equal(printArgs(true, "/p", "/o.pdf", "file:///x.html").includes("--headless=new"), false);
});

test("a failed download is the print's error, in its own words", async () => {
  const w = printWorld();
  w.deps.ensureBrowser = async () => {
    throw new Error("the chrome-headless-shell 156.0.8078.47 download is not the one this agent expects (its SHA-256 differs), so it was not installed");
  };
  await assert.rejects(printWithChromium(w.html, w.pdf, w.deps), /^Error: the chrome-headless-shell 156\.0\.8078\.47 download is not the one this agent expects/);
  assert.equal(existsSync(w.pdf), false);
});

test("a browser that cannot load its libraries says which one is missing", async () => {
  const w = printWorld();
  const broken = fakeBrowser(mkdtempSync(join(tmpdir(), "cobra-printer-broken-")), "echo 'chrome-headless-shell: error while loading shared libraries: libnss3.so: cannot open shared object file' >&2; exit 127");
  w.deps.ensureBrowser = async () => broken.path;
  await assert.rejects(printWithChromium(w.html, w.pdf, w.deps), /^Error: chrome-headless-shell cannot start: this computer is missing libnss3\.so, a library it needs/);
  const silent = fakeBrowser(mkdtempSync(join(tmpdir(), "cobra-printer-silent-")), "exit 0");
  w.deps.ensureBrowser = async () => silent.path;
  await assert.rejects(printWithChromium(w.html, w.pdf, w.deps), /^Error: chrome-headless-shell exited without writing the PDF$/);
});

test("the live printPdf downloads chrome-headless-shell and prints a page with it", { skip: !process.env.COBRA_TEST_CHROMIUM && "set COBRA_TEST_CHROMIUM=1 to download the agent's browser (126 MB on Linux) and print with it" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-print-test-"));
  const html = join(dir, "page.html");
  const pdf = join(dir, "page.pdf");
  writeFileSync(html, "<!doctype html><p>Hello from Cobra</p>");
  await printWithChromium(html, pdf);
  assert.equal(readFileSync(pdf).subarray(0, 4).toString(), "%PDF");
});

test("a Money project prints with Billing's shipped templates, and its own folder still wins", async () => {
  const w = world({ projectTemplates: {}, shippedTemplates: {}, trade: "money" });
  mkdirSync(join(w.shipped, "billing", "pay-stub"), { recursive: true });
  writeFileSync(join(w.shipped, "billing", "pay-stub", "index.html"), "<h1>Billing's</h1>{{#each rows}}<p>{{employee}}</p>{{/each}}");
  const result = await renderReport(w.deps, w.project, fakeDb({ hasBusiness: false }), request());
  assert.equal(result.template.source, "shipped");
  assert.match(readFileSync(join(w.repo, result.files[0]!.path), "utf8"), /<h1>Billing's<\/h1><p>Ada Lovelace<\/p>/);
  mkdirSync(join(w.repo, "templates", "pay-stub"), { recursive: true });
  writeFileSync(join(w.repo, "templates", "pay-stub", "index.html"), "<h1>Mine</h1>");
  const own = await renderReport(w.deps, w.project, fakeDb({ hasBusiness: false }), request());
  assert.equal(own.template.source, "project");
});
