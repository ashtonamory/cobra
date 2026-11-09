import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-receipts-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { addReceipt, centsOf, chooseAccounts, guessAccount, parseReceiptReply, readArgs, settleExpensesApproval, startReading, readReceipts } = await import("./receipts.ts");
const { openProjectDb } = await import("./db.ts");
const { SPACE_SCHEMA } = await import("./trades/space.ts");
const { openSpace, registerSeat } = await import("./spaces.ts");
const { useFxTable } = await import("./fx.ts");
const { receiptAmounts } = await import("../../../../packages/contracts/src/viewsRead.ts");
type StoredApproval = import("./approvals.ts").StoredApproval;

const SPACE = "happy-tails";
const MONEY = "paws-money";
const NOW = Date.parse("2026-11-01T15:00:00Z");
// The smallest PNG there is: its signature and a header are all the sniff reads.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f4a5b40000000049454e44ae426082", "hex");

function setup(replies: string[]) {
  const dir = mkdtempSync(join(ROOT, "case-"));
  const spacesRoot = join(dir, "Spaces");
  const dbDir = join(dir, "db");
  openSpace({ id: SPACE, name: "Happy Tails", kind: "own", home: hostname(), sensitive: false }, hostname(), spacesRoot);
  registerSeat(SPACE, MONEY, "money", spacesRoot);
  let approvals: StoredApproval[] = [];
  const store = () => openProjectDb(MONEY, SPACE_SCHEMA, dbDir, spacesRoot);
  const read: string[] = [];
  const deps = {
    spacesRoot,
    open: () => store(),
    read: async (folder: string, name: string) => {
      read.push(readdirSync(folder).join(","));
      assert.equal(name.startsWith("receipt."), true);
      return replies.shift() ?? "";
    },
    approvals: { load: () => approvals, save: (list: StoredApproval[]) => void (approvals = list) },
    notify: async () => {},
    stored: () => {},
    log: () => {},
    now: () => NOW,
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
      return db.write(mutation, args, "person");
    } finally {
      db.close();
    }
  };
  return { deps, spacesRoot, approvals: () => approvals, read, query, write };
}

test("a receipt's answer is read to whole cents, a real date, and why not when it is no receipt", () => {
  assert.equal(centsOf("1,204.50"), 120450);
  assert.equal(centsOf("12,50"), 1250);
  assert.equal(centsOf("$86.40"), 8640);
  assert.equal(centsOf("nope"), null);
  assert.deepEqual(parseReceiptReply('Here: {"receipt": true, "vendor": "Pet Supply Co", "date": "2026-10-30", "total": "86.40", "tax": "6.40", "category": "Supplies"}', "2026-11-01"),
    { vendor: "Pet Supply Co", date: "2026-10-30", totalCents: 8640, taxCents: 640, category: "Supplies", paid: null, currency: null });
  assert.equal((parseReceiptReply('{"receipt": true, "vendor": "X", "total": "5", "currency": "eur"}', "2026-11-01") as { currency: string }).currency, "EUR");
  assert.equal((parseReceiptReply('{"receipt": true, "vendor": "X", "total": "5", "currency": "EC$"}', "2026-11-01") as { currency: null }).currency, null);
  assert.equal((parseReceiptReply('{"receipt": true, "vendor": "X", "total": "5", "currency": "ABC"}', "2026-11-01") as { currency: null }).currency, null);
  assert.equal((parseReceiptReply('{"receipt": true, "vendor": "X", "total": "5", "paid": "cash"}', "2026-11-01") as { paid: string }).paid, "cash");
  assert.equal((parseReceiptReply('{"receipt": true, "vendor": "X", "total": "5", "paid": "cheque"}', "2026-11-01") as { paid: null }).paid, null);
  assert.deepEqual(parseReceiptReply('{"receipt": false, "why": "a photo of a dog"}', "2026-11-01"), { why: "a photo of a dog" });
  assert.deepEqual(parseReceiptReply('{"receipt": true, "vendor": "X", "total": "0"}', "2026-11-01"), { why: "its total could not be read" });
  assert.equal((parseReceiptReply('{"receipt": true, "vendor": "X", "date": "Oct 30", "total": "5"}', "2026-11-01") as { date: string }).date, "2026-11-01");
  // The reader gets the image's folder and Read alone.
  assert.deepEqual(readArgs().slice(readArgs().indexOf("--tools"), readArgs().indexOf("--tools") + 2), ["--tools", "Read"]);
});

test("a photo is kept once by its hash in the Space's receipts folder; anything but an image is refused", async () => {
  const { deps, spacesRoot } = setup([]);
  const first = await addReceipt(MONEY, Readable.from([PNG]), deps);
  assert.equal(first.status, 200);
  const { file } = first.body as { file: string };
  assert.match(file, /^[0-9a-f]{64}\.png$/);
  assert.equal((await addReceipt(MONEY, Readable.from([PNG]), deps)).status, 200);
  assert.deepEqual(readdirSync(join(spacesRoot, SPACE, "receipts")), [file]);
  assert.equal((await addReceipt(MONEY, Readable.from([Buffer.from("not an image at all")]), deps)).status, 415);
  assert.equal((await addReceipt("elsewhere", Readable.from([PNG]), deps)).status, 404);
  assert.equal(startReading(MONEY, { files: ["../../etc/passwd"] }, deps).status, 400);
  assert.equal(startReading(MONEY, { files: [] }, deps).status, 400);
});

test("receipts become proposed expenses with their photos on one card; Allow records them and matches the bank line", async () => {
  const s = setup([
    '{"receipt": true, "vendor": "Pet Supply Co", "date": "2026-10-30", "total": "86.40", "tax": "6.40", "category": "Supplies"}',
    '{"receipt": false, "why": "too blurry to read"}',
  ]);
  // A bank line of the same amount two days later, allowed, so it can be matched.
  s.write("transactions_import", { file_name: "oct.csv", source: "csv", rows: [{ posted_on: "2026-11-01", description: "PET SUPPLY CO 0042", amount_cents: -8640 }] });
  s.write("transactions_allow", { batch_id: 1 });
  const a = await addReceipt(MONEY, Readable.from([PNG]), s.deps);
  const b = await addReceipt(MONEY, Readable.from([Buffer.concat([PNG, Buffer.from([0])])]), s.deps);
  const files = [(a.body as { file: string }).file, (b.body as { file: string }).file];
  const card = await readReceipts({ id: SPACE, name: "Happy Tails" }, MONEY, files, s.deps);
  assert.ok(card);
  assert.deepEqual(s.read, ["receipt.png", "receipt.png"], "each read sees only its own image");
  assert.equal(card.kind, "expenses");
  assert.equal(card.title, "Allow 1 expense for Happy Tails?");
  assert.match(card.body, /Pet Supply Co · 2026-10-30 · 86\.40 USD · Supplies · matches the bank line "PET SUPPLY CO 0042"/);
  assert.match(card.body, /Not read: too blurry to read\./);
  const item = card.expenses!.items[0]!;
  assert.equal(item.match?.id, 1);
  assert.equal(existsSync(item.file), true);
  assert.deepEqual(s.query("SELECT status, proposed_by FROM expenses"), [{ status: "proposed", proposed_by: "Cobra (receipt scan)" }]);
  assert.equal(s.query("SELECT expense_id FROM receipts")[0]!.expense_id, item.expense);

  const done = settleExpensesApproval(s.deps, { ...card, state: "allowed" });
  assert.equal(done.state, "done");
  assert.deepEqual(s.query("SELECT status, transaction_id FROM expenses"), [{ status: "recorded", transaction_id: 1 }]);
  assert.deepEqual(s.query("SELECT status, match_kind FROM transactions"), [{ status: "matched", match_kind: "expense" }]);

  // The same photo again is not read twice.
  const again = await readReceipts({ id: SPACE, name: "Happy Tails" }, MONEY, [files[0]!], s.deps);
  assert.equal(again!.expenses!.items.length, 0);
  assert.match(again!.body, /read before/);
});

test("Not mine voids every expense on the card", async () => {
  const s = setup(['{"receipt": true, "vendor": "Cafe", "date": "2026-10-31", "total": "4.50", "tax": null, "category": "Meals"}']);
  const a = await addReceipt(MONEY, Readable.from([PNG]), s.deps);
  const card = await readReceipts({ id: SPACE, name: "Happy Tails" }, MONEY, [(a.body as { file: string }).file], s.deps);
  settleExpensesApproval(s.deps, { ...card!, state: "denied" });
  assert.deepEqual(s.query("SELECT status, void_reason FROM expenses"), [{ status: "voided", void_reason: "Not mine (receipt scan)" }]);
});

test("each receipt says which account paid: the receipt's word, else the only account; the person's pick on the card wins", async () => {
  const accounts = [{ id: 1, name: "Cash", kind: "cash" }, { id: 2, name: "Bank", kind: "bank" }, { id: 3, name: "Visa", kind: "card" }];
  assert.equal(guessAccount(accounts, "cash"), 1);
  assert.equal(guessAccount(accounts, "card"), 3);
  assert.equal(guessAccount(accounts.slice(0, 2), "card"), 2, "no card account: a card is paid from the bank");
  assert.equal(guessAccount(accounts, null), undefined, "two or more and the receipt says nothing: the person picks");
  assert.equal(guessAccount([accounts[1]!], null), 2);

  const s = setup([
    '{"receipt": true, "vendor": "Ram\'s Supermarket", "date": "2026-11-01", "total": "74.80", "tax": null, "category": "Groceries", "paid": "cash"}',
    '{"receipt": true, "vendor": "Fuel Stop", "date": "2026-11-01", "total": "40.00", "tax": null, "category": "Fuel"}',
  ]);
  s.write("account_add", { name: "Cash", kind: "cash", opening_cents: 54000, opening_on: "2026-11-01" });
  s.write("account_add", { name: "Bank", kind: "bank", opening_on: "2026-11-01" });
  const a = await addReceipt(MONEY, Readable.from([PNG]), s.deps);
  const b = await addReceipt(MONEY, Readable.from([Buffer.concat([PNG, Buffer.from([1])])]), s.deps);
  const card = (await readReceipts({ id: SPACE, name: "Happy Tails" }, MONEY, [(a.body as { file: string }).file, (b.body as { file: string }).file], s.deps))!;
  assert.deepEqual(card.expenses!.accounts, [{ id: 1, name: "Cash", kind: "cash" }, { id: 2, name: "Bank", kind: "bank" }]);
  assert.deepEqual(card.expenses!.items.map((i) => i.account), [1, undefined]);
  assert.match(card.body, /Groceries · from Cash/);
  assert.match(card.body, /Fuel · which account paid\?/);
  assert.deepEqual(s.query("SELECT account_id FROM expenses ORDER BY id"), [{ account_id: 1 }, { account_id: null }]);

  // Only the card's own expenses and accounts may be picked.
  assert.deepEqual(chooseAccounts(card.expenses!, { 99: 1 }), { error: "expense 99 is not on this card" });
  assert.deepEqual(chooseAccounts(card.expenses!, { [card.expenses!.items[1]!.expense]: 7 }), { error: "account 7 is not one this card offers" });
  const picked = chooseAccounts(card.expenses!, { [card.expenses!.items[1]!.expense]: "2" });
  assert.ok(!("error" in picked));
  const done = settleExpensesApproval(s.deps, { ...card, expenses: picked, state: "allowed" });
  assert.equal(done.state, "done");
  assert.deepEqual(done.results!.map((r) => r.message), ["Recorded Ram's Supermarket from Cash", "Recorded Fuel Stop from Bank"]);
  assert.deepEqual(s.query("SELECT name, balance_cents FROM account_balances ORDER BY id"), [{ name: "Cash", balance_cents: 54000 - 7480 }, { name: "Bank", balance_cents: -4000 }]);
});

test("a receipt in another currency: its own amount on the card with the home one; the account it lands on is charged in its own", async () => {
  // One US dollar bought 0.80 euros on the day: €45.00 is US$56.25, EC$151.88.
  useFxTable({ version: 1, days: { "2026-10-01": { EUR: 0.8 } } });
  const s = setup([
    '{"receipt": true, "vendor": "Café de Flore", "date": "2026-11-01", "total": "45,00", "tax": null, "category": "Eating out", "currency": "EUR", "paid": "cash"}',
    '{"receipt": true, "vendor": "Ram\'s", "date": "2026-11-01", "total": "20.00", "tax": null, "category": "Groceries", "paid": "cash"}',
  ]);
  s.write("home_currency_set", { currency: "XCD", name: "Rivera household" });
  s.write("account_add", { name: "Cash", kind: "cash", opening_on: "2026-10-01" });
  s.write("account_add", { name: "Visa", kind: "card", currency: "USD", opening_on: "2026-10-01" });
  const a = await addReceipt(MONEY, Readable.from([PNG]), s.deps);
  const b = await addReceipt(MONEY, Readable.from([Buffer.concat([PNG, Buffer.from([2])])]), s.deps);
  const card = (await readReceipts({ id: SPACE, name: "Personal" }, MONEY, [(a.body as { file: string }).file, (b.body as { file: string }).file], s.deps))!;
  const [cafe, rams] = card.expenses!.items;
  assert.deepEqual([cafe!.totalCents, cafe!.paid, cafe!.homeCents, cafe!.account], [15188, { cents: 4500, currency: "EUR" }, 15188, 1]);
  assert.deepEqual([rams!.totalCents, rams!.paid, rams!.homeCents], [2000, undefined, undefined]);
  assert.deepEqual(receiptAmounts(cafe!, card.expenses!.currency), { own: "€45.00", home: "≈ EC$151.88" });
  assert.match(card.body, /Café de Flore · 2026-11-01 · €45\.00 · ≈ EC\$151\.88 · Eating out · from Cash/);
  assert.match(card.body, /Total 171\.88 XCD\./);
  // The person says it went on the US$ card: Visa is charged the receipt at the day's rate, not the EC$ amount.
  const picked = chooseAccounts(card.expenses!, { [cafe!.expense]: 2 });
  assert.ok(!("error" in picked));
  assert.equal(settleExpensesApproval(s.deps, { ...card, expenses: picked, state: "allowed" }).state, "done");
  assert.deepEqual(s.query("SELECT account_id, amount_cents, paid_cents, paid_currency, rate_source, status FROM expenses ORDER BY id")[0], { account_id: 2, amount_cents: 5625, paid_cents: 4500, paid_currency: "EUR", rate_source: "feed", status: "recorded" });
  assert.deepEqual(s.query("SELECT name, currency, balance_cents FROM account_balances ORDER BY id"), [{ name: "Cash", currency: "XCD", balance_cents: -2000 }, { name: "Visa", currency: "USD", balance_cents: -5625 }]);
  useFxTable(null);
});
