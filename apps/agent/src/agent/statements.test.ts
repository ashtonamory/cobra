import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-statements-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { addStatement, dayFirstIn, parseCents, parseDay, parsePdfReply, pdfParts, PDF_PART_CHARS, readStatement, readStatementCsv } = await import("./statements.ts");
const { parseCsv } = await import("./csvImport.ts");
const { openProjectDb } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { openSpace, registerSeat } = await import("./spaces.ts");

const SPACE = "happy-tails";
const MONEY = "paws-money";

function setup(replies: string[] = [], pdfText = "") {
  const dir = mkdtempSync(join(ROOT, "case-"));
  const spacesRoot = join(dir, "Spaces");
  const dbDir = join(dir, "db");
  openSpace({ id: SPACE, name: "Happy Tails", kind: "own", home: hostname(), sensitive: false }, hostname(), spacesRoot);
  registerSeat(SPACE, MONEY, "money", spacesRoot);
  const store = () => openProjectDb(MONEY, SPACE_SCHEMA, dbDir, spacesRoot);
  const parts: string[] = [];
  const stored: string[] = [];
  const deps = {
    spacesRoot,
    open: () => store(),
    pdfText: async () => pdfText,
    readPdf: async (part: string) => {
      parts.push(part);
      return replies.shift() ?? "";
    },
    stored: (space: string) => void stored.push(space),
    log: () => {},
  };
  const query = (sql: string) => {
    const db = store();
    try {
      return db.queryRaw(sql, []).rows;
    } finally {
      db.close();
    }
  };
  const write = (mutation: string, args: Record<string, unknown>) => {
    const db = store();
    try {
      return db.write(mutation, args, "foreman");
    } finally {
      db.close();
    }
  };
  return { deps, spacesRoot, parts, stored, query, write };
}

const body = (text: string | Buffer) => Readable.from([Buffer.from(text)]);

test("dates are read as banks write them, and a slashed date's order is found from the column", () => {
  assert.equal(parseDay("2026-11-07"), "2026-11-07");
  assert.equal(parseDay("2026/11/7"), "2026-11-07");
  assert.equal(parseDay("20261107"), "2026-11-07");
  assert.equal(parseDay("11/07/2026"), "2026-11-07");
  assert.equal(parseDay("07/11/2026", true), "2026-11-07");
  assert.equal(parseDay("7/11/26", true), "2026-11-07");
  assert.equal(parseDay("07 Nov 2026"), "2026-11-07");
  assert.equal(parseDay("7-Nov-2026"), "2026-11-07");
  assert.equal(parseDay("Nov 7, 2026"), "2026-11-07");
  assert.equal(parseDay("September 30 2026"), "2026-09-30");
  assert.equal(parseDay("31/02/2026", true), null);
  assert.equal(parseDay("Opening balance"), null);
  assert.equal(dayFirstIn(["03/04/2026", "25/10/2026"]), true);
  assert.equal(dayFirstIn(["03/04/2026", "10/25/2026"], true), false);
  assert.equal(dayFirstIn(["03/04/2026"], true), true, "nothing over 12 keeps the fallback");
});

test("money is read to signed cents in every way a bank writes it", () => {
  assert.equal(parseCents("-12.34"), -1234);
  assert.equal(parseCents("(12.34)"), -1234);
  assert.equal(parseCents("$1,234.56"), 123456);
  assert.equal(parseCents("CA$ 62.40"), 6240);
  assert.equal(parseCents("12.34-"), -1234);
  assert.equal(parseCents("12.34 DR"), -1234);
  assert.equal(parseCents("12.34 CR"), 1234);
  assert.equal(parseCents("+5"), 500);
  assert.equal(parseCents("12.3"), 1230);
  assert.equal(parseCents(""), null);
  assert.equal(parseCents("n/a"), null);
});

test("a CSV with one signed amount is read by its header; balance lines are left out", () => {
  const grid = parseCsv([
    "Account,Chequing 0042",
    "Date,Description,Amount,Balance",
    "2026-10-31,PETRO-CANADA 04512 KAMLOOPS BC,-62.40,1200.00",
    "2026-10-30,STRIPE PAYOUT,150.00,1262.40",
    "2026-10-29,Closing balance,,1112.40",
    "",
  ].join("\n"));
  const read = readStatementCsv(grid);
  assert.ok(!("why" in read));
  assert.deepEqual(read.lines, [
    { posted_on: "2026-10-31", description: "PETRO-CANADA 04512 KAMLOOPS BC", amount_cents: -6240 },
    { posted_on: "2026-10-30", description: "STRIPE PAYOUT", amount_cents: 15000 },
  ]);
  assert.equal(read.skipped, 1);
});

test("a CSV with money out and money in, day-first dates, and one with no header, are read too", () => {
  const split = readStatementCsv(parseCsv("Transaction Date,Details,Debit,Credit\n25/10/2026,FLOW BILL,85.00,\n03/11/2026,SALARY,,2400.00\n"));
  assert.ok(!("why" in split));
  assert.deepEqual(split.lines, [
    { posted_on: "2026-10-25", description: "FLOW BILL", amount_cents: -8500 },
    { posted_on: "2026-11-03", description: "SALARY", amount_cents: 240000 },
  ]);
  const bare = readStatementCsv(parseCsv("2026-10-01,Time To Pet*Subscription,-49.00\n2026-10-02,E-TRANSFER SARAH K,225.00\n"));
  assert.ok(!("why" in bare));
  assert.equal(bare.lines.length, 2);
  assert.equal(bare.lines[0]!.amount_cents, -4900);
  assert.match((readStatementCsv(parseCsv("name,colour\ndog,brown\n")) as { why: string }).why, /no header/);
  assert.match((readStatementCsv(parseCsv("Date,Description,Amount\n2026-10-01,Opening balance,100.00\n")) as { why: string }).why, /no line/);
});

test("the PDF reader's JSON is checked line by line; text it cannot use is said so", () => {
  const read = parsePdfReply('Here you go: {"lines":[{"date":"2026-10-31","description":"PETRO-CANADA  04512","amount":"-62.40"},{"date":"2026-10-30","description":"STRIPE","amount":150},{"date":"soon","description":"X","amount":"-1"},{"date":"2026-10-30","description":"","amount":"-1"}]}');
  assert.deepEqual(read.lines, [
    { posted_on: "2026-10-31", description: "PETRO-CANADA 04512", amount_cents: -6240 },
    { posted_on: "2026-10-30", description: "STRIPE", amount_cents: 15000 },
  ]);
  assert.equal(read.dropped, 2);
  assert.deepEqual(parsePdfReply('{"lines":[],"why":"a menu"}'), { lines: [], dropped: 0, why: "a menu" });
  assert.match(parsePdfReply("no idea").why ?? "", /no JSON/);
  assert.match(parsePdfReply("{nope}").why ?? "", /did not parse/);
});

test("a PDF's text is cut into parts at page breaks", () => {
  assert.deepEqual(pdfParts("page one\fpage two\f"), ["page one\n\f\npage two"]);
  const big = "x".repeat(PDF_PART_CHARS - 10);
  assert.equal(pdfParts(`${big}\f${big}`).length, 2);
  assert.equal(pdfParts("y".repeat(PDF_PART_CHARS * 2 + 1)).length, 3);
});

test("a statement is kept once by its hash in the Space's statements folder; anything but CSV or PDF is refused", async () => {
  const { deps, spacesRoot } = setup();
  const csv = "Date,Description,Amount\n2026-10-31,PETRO-CANADA,-62.40\n";
  const first = await addStatement(MONEY, "rbc.csv", body(csv), deps);
  assert.equal(first.status, 200);
  const again = await addStatement(MONEY, "rbc (1).csv", body(csv), deps);
  assert.deepEqual(again.body, first.body);
  assert.equal(readdirSync(join(spacesRoot, SPACE, "statements")).length, 1);
  assert.equal((await addStatement(MONEY, "rbc.ofx", body(csv), deps)).status, 415);
  assert.equal((await addStatement(MONEY, "fake.pdf", body("not a pdf"), deps)).status, 415);
  assert.equal(readdirSync(join(spacesRoot, SPACE, "statements")).length, 1, "a refused file is not kept");
  assert.equal((await addStatement("no-such-project", "rbc.csv", body(csv), deps)).status, 404);
});

test("reading a CSV statement asks for the account when there is a choice, then matches and proposes", async () => {
  const { deps, write, query, stored } = setup();
  write("account_add", { name: "Chequing", kind: "bank", opening_cents: 100000, opening_on: "2026-10-01" });
  write("account_add", { name: "Visa", kind: "card", opening_cents: 0, opening_on: "2026-10-01" });
  write("expense_propose", { amount_cents: 6240, spent_on: "2026-10-31", sender: "Petro-Canada", account: "Chequing", source: "mail", source_ref: "m1" });
  const csv = "Date,Description,Amount\n2026-11-01,PETRO-CANADA 04512 KAMLOOPS BC,-62.40\n2026-10-28,KAMLOOPS PET SUPPLY #22,-38.15\nOct 27 2026,Balance forward,\n";
  const added = await addStatement(MONEY, "rbc.csv", body(csv), deps);
  const file = (added.body as { file: string }).file;

  const ask = await readStatement(MONEY, { file, name: "RBC October.csv" }, deps);
  assert.equal(ask.status, 409);
  assert.deepEqual((ask.body as { accounts: unknown[] }).accounts, [{ id: 1, name: "Chequing" }, { id: 2, name: "Visa" }]);

  const read = await readStatement(MONEY, { file, name: "RBC October.csv", account_id: 1 }, deps);
  assert.equal(read.status, 200);
  assert.match((read.body as { summary: string }).summary, /2 lines read, 1 already in the books, 1 new to allow/);
  assert.match((read.body as { note: string }).note, /1 rows that were not money/);
  assert.deepEqual(stored, [SPACE]);
  assert.deepEqual(query("SELECT sender, amount_cents, status, source, proposed_by FROM expenses WHERE source = 'statement'"), [
    { sender: "Kamloops Pet Supply", amount_cents: 3815, status: "proposed", source: "statement", proposed_by: "Cobra (statement)" },
  ]);
  assert.deepEqual(query("SELECT file_name, source, status FROM import_batches"), [{ file_name: "RBC October.csv", source: "csv", status: "read" }]);
  assert.equal((await readStatement(MONEY, { file: "../../etc/passwd" }, deps)).status, 400);
});

test("a PDF statement is read by the model in parts, checked, and an empty or scanned one is refused", async () => {
  const reply = '{"lines":[{"date":"2026-10-27","description":"E-TRANSFER SARAH K","amount":"225.00"}]}';
  const { deps, write, query, parts } = setup([reply], "RBC Chequing statement\nOct 27 E-TRANSFER SARAH K 225.00\f");
  write("account_add", { name: "Chequing", kind: "bank", opening_cents: 0, opening_on: "2026-10-01" });
  const added = await addStatement(MONEY, "rbc.pdf", body("%PDF-1.7 fake"), deps);
  assert.equal(added.status, 200);
  const read = await readStatement(MONEY, { file: (added.body as { file: string }).file }, deps);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(parts.length, 1);
  assert.match(parts[0]!, /E-TRANSFER SARAH K/);
  assert.deepEqual(query("SELECT sender, amount_cents, kind FROM money_moves WHERE source = 'statement'"), [{ sender: "E-Transfer Sarah K", amount_cents: 22500, kind: "income" }]);

  const scan = setup([], "   ");
  scan.write("account_add", { name: "Chequing", kind: "bank", opening_cents: 0, opening_on: "2026-10-01" });
  const scanned = await addStatement(MONEY, "scan.pdf", body("%PDF-1.4 scan"), scan.deps);
  const refused = await readStatement(MONEY, { file: (scanned.body as { file: string }).file }, scan.deps);
  assert.equal(refused.status, 422);
  assert.match((refused.body as { error: string }).error, /a scan/);
});

test("a PDF that cannot be read now is said plainly and kept for another try", async () => {
  const { deps, write, spacesRoot } = setup([], "some text");
  write("account_add", { name: "Chequing", kind: "bank", opening_cents: 0, opening_on: "2026-10-01" });
  const added = await addStatement(MONEY, "rbc.pdf", body("%PDF-1.7 fake"), deps);
  const held = await readStatement(MONEY, { file: (added.body as { file: string }).file }, { ...deps, readPdf: async () => { throw new Error("the subscription is at its hold: send a CSV, or try the PDF later"); } });
  assert.equal(held.status, 503);
  assert.match((held.body as { error: string }).error, /at its hold/);
  assert.equal(readdirSync(join(spacesRoot, SPACE, "statements")).length, 1);
});
