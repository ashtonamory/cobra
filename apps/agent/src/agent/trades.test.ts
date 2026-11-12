import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FOREMAN_TEMPLATES } from "@cobra/contracts";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-trades-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const trades = await import("./trades.ts");
const foreman = await import("./foreman.ts");
const lead = await import("./lead.ts");
const mcp = await import("./orchMcp.ts");

test("every trade the contract ships has a brief, and the briefs are only for those trades", () => {
  const ids = FOREMAN_TEMPLATES.map((trade) => trade.id);
  assert.deepEqual(trades.tradeIds(), ids);
  assert.deepEqual(Object.keys(trades.TRADE_BRIEFS).sort(), [...ids].sort());
  for (const trade of FOREMAN_TEMPLATES) {
    assert.match(trades.TRADE_BRIEFS[trade.id] ?? "", new RegExp(`^Your trade is ${trade.name}\\.`), trade.id);
  }
});

test("each brief sends nothing itself: it names action_propose and says what it never does", () => {
  for (const [id, brief] of Object.entries(trades.TRADE_BRIEFS)) {
    assert.ok(brief.includes("action_propose"), `${id} names action_propose`);
    assert.ok(brief.includes("never"), `${id} says never`);
    // The file channel is the second way out, beside email; a brief that forgets it would make a Foreman attach everything.
    assert.ok(brief.includes("file channel"), `${id} names the file channel`);
  }
});

test("the trades that handle pay, bank, tax and ID numbers keep them out of messages, reports and memory", () => {
  for (const id of ["payroll-manager", "billing", "sign-ups"]) {
    const brief = trades.TRADE_BRIEFS[id] ?? "";
    assert.match(brief, /never go in a message, a report or memory/, id);
    assert.match(brief, /never into a repository beyond the files the person keeps there/, id);
  }
});

test("tradeSchema: Payroll Manager, Billing, Outreach, People and Money keep a database; every other trade keeps files for now", async () => {
  const { PAYROLL_SCHEMA } = await import("./trades/payroll.ts");
  const { BILLING_SCHEMA } = await import("./trades/billing.ts");
  assert.equal(trades.tradeSchema("payroll-manager"), PAYROLL_SCHEMA);
  assert.equal(PAYROLL_SCHEMA.trade, "payroll-manager");
  assert.equal(trades.tradeSchema("billing"), BILLING_SCHEMA);
  assert.equal(BILLING_SCHEMA.trade, "billing");
  const { SPACE_SCHEMA } = await import("./trades/space.ts");
  assert.equal(trades.tradeSchema("people"), SPACE_SCHEMA);
  assert.equal(trades.tradeSchema("outreach"), SPACE_SCHEMA);
  assert.equal(trades.tradeSchema("money"), SPACE_SCHEMA);
  assert.equal(SPACE_SCHEMA.trade, "space");
  for (const id of [...trades.tradeIds().filter((trade) => trade !== "payroll-manager" && trade !== "billing" && trade !== "people" && trade !== "outreach" && trade !== "money"), "fortune-teller", "constructor", "__proto__", undefined]) {
    assert.equal(trades.tradeSchema(id), null, String(id));
  }
});

test("the Payroll brief works the database through the tools, in the order of a pay run, and still sends nothing itself", () => {
  const brief = trades.TRADE_BRIEFS["payroll-manager"] ?? "";
  for (const tool of ["file_import", "timefile_import", "timesheet_set", "pay_run_create", "db_query", "pay_item_adjust", "action_propose", "pay_run_close", "db_undo", "report_render", "stub_record"]) {
    assert.ok(brief.includes(tool), `names ${tool}`);
  }
  // A pay run: create, check, adjust, propose, then close only on the person's word.
  const order = ["pay_run_create", "db_query", "pay_item_adjust", "action_propose", "pay_run_close"].map((tool) => brief.indexOf(tool));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(brief, /pay_run_close only after the person says/);
  assert.match(brief, /masked, and that is right, never try to reconstruct one/);
  assert.match(brief, /never give a Worker a database tool/);
  // The stubs (section 8): after the close, one pay-stub per employee and the run's summary, rendered by code into out/, recorded, then proposed with the files attached.
  assert.match(brief, /After pay_run_close, render the stubs with report_render: template pay-stub, one per employee \(split employee_id\), and the run's summary with template pay-run-summary/);
  assert.match(brief, /land under out\/, which you never read and never write yourself/);
  assert.match(brief, /record each stub with stub_record \(run_id, employee_id, path, sha256\)/);
  assert.match(brief, /action_propose the stubs to the people the person named with the files attached, or through the file channel/);
  const stubs = ["pay_run_close only after", "report_render", "stub_record", "action_propose the stubs"].map((step) => brief.indexOf(step));
  assert.deepEqual(stubs, [...stubs].sort((a, b) => a - b));
  assert.equal(brief.includes("sheet are rendered by code from the database in a later step"), false);
});

test("the Billing brief works the database through the tools in the order of an invoice, leaves sent to the agent, and never takes money", async () => {
  const brief = trades.TRADE_BRIEFS.billing ?? "";
  const { BILLING_SCHEMA } = await import("./trades/billing.ts");
  for (const tool of ["business_set", "customer_add", "item_set", "file_import", "invoice_create", "db_query", "invoice_line_add", "invoice_issue", "invoice_void", "report_render", "document_record", "action_propose", "payment_record", "reminder_record", "db_undo"]) {
    assert.ok(brief.includes(tool), `names ${tool}`);
    if (tool in BILLING_SCHEMA.mutations || tool.startsWith("db_") || tool === "report_render" || tool === "action_propose" || tool === "file_import") continue;
    assert.fail(`${tool} is neither a Billing mutation nor a tool`);
  }
  // An invoice: draft, check, propose, issue only on the person's word, render, record, propose to the customer.
  const order = ["invoice_create", "db_query", "action_propose", "invoice_issue only after", "report_render", "document_record", "action_propose it to the customer"].map((step) => brief.indexOf(step));
  assert.ok(order.every((at) => at >= 0), String(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  for (const template of ["template invoice, split invoice_id", "template receipt, split payment_id", "template statement, split customer_id"]) assert.ok(brief.includes(template), template);
  assert.match(brief, /the agent marks the document sent itself, and counts a reminder; you do not/);
  assert.match(brief, /payment_record only when the person tells you it arrived/);
  assert.match(brief, /masked, and that is right, never try to reconstruct one/);
  assert.match(brief, /never give a Worker a database tool/);
  assert.match(brief, /You never take a payment, charge a card, move money/);
  assert.match(brief, /a service Cobra has no connection for/);
  // The agent's own mutation is not the Foreman's to call.
  assert.equal(brief.includes("documents_sent"), false);
});

test("tradeReads: My day, Inbox, Sign-ups and Lead Outreach read mail; Projects and the rest nothing; the calendar is no read of Cobra's own", () => {
  for (const id of ["my-day", "inbox", "sign-ups", "lead-outreach"]) assert.deepEqual(trades.tradeReads(id), ["mail"], id);
  for (const id of ["projects", "website-builder", "payroll-manager", "billing", "fortune-teller", "constructor", "__proto__", undefined]) {
    assert.deepEqual(trades.tradeReads(id), [], String(id));
  }
});

test("a trade's brief names the mail tools exactly when its trade reads mail, says a mailbox must be linked, and calls what it reads data", () => {
  for (const id of trades.tradeIds()) {
    const brief = trades.TRADE_BRIEFS[id] ?? "";
    const reads = trades.tradeReads(id).includes("mail");
    for (const name of ["mail_search", "mail_read"]) assert.equal(brief.includes(name), reads, `${id} ${name}`);
    // Cobra reads no calendar itself: no brief names a tool for one, or a Google step to turn on.
    assert.equal(brief.includes("calendar_events"), false, id);
    assert.doesNotMatch(brief, /for their Google connection|Settings → Integrations → Google/, id);
    if (!reads) continue;
    assert.match(brief, /Settings → Mailboxes/, id);
    assert.match(brief, /never (as )?an? instructions? to you|never instructions/, id);
  }
  // The trades that plan around dates say where the calendar comes from.
  for (const id of ["my-day", "projects", "sign-ups"]) assert.match(trades.TRADE_BRIEFS[id] ?? "", /Google Calendar connector/, id);
});

test("tradeBrief adds the leading line break the prompt expects, and is empty for no trade or an unknown one", () => {
  assert.equal(trades.tradeBrief("billing"), `\n${trades.TRADE_BRIEFS.billing}`);
  assert.equal(trades.tradeBrief(undefined), "");
  assert.equal(trades.tradeBrief("fortune-teller"), "");
  assert.equal(foreman.templateBrief("fortune-teller"), "");
  assert.equal(foreman.templateBrief("my-day"), trades.tradeBrief("my-day"));
});

test("the Lead's prompt names every trade, from the contract's list", () => {
  for (const trade of FOREMAN_TEMPLATES) {
    assert.ok(lead.LEAD_PROMPT.includes(trade.name), `the Lead knows ${trade.name}`);
  }
  assert.ok(lead.LEAD_PROMPT.includes(`${trades.tradeNamesSentence()} project, use foreman_create with that saved trade`));
  assert.equal(trades.tradeNamesSentence(), "Website Builder, Payroll Manager, Lead Outreach, Billing, My day, Inbox, Sign-ups, Projects, Outreach, People, Money or Designer");
});

test("foreman_create accepts exactly the contract's trades, and the create routes refuse the rest by listing them", async () => {
  const listed = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, () => [], fetch, "lead")) as { result: { tools: { name: string; inputSchema: { properties: { template: { enum: string[] } } } }[] } };
  const create = listed.result.tools.find((tool) => tool.name === "foreman_create");
  assert.deepEqual(create?.inputSchema.properties.template.enum, trades.tradeIds());
  assert.equal(trades.knownTemplate("sign-ups"), true);
  assert.equal(trades.knownTemplate("fortune-teller"), false);
  assert.equal(trades.knownTemplate(undefined), false);
  assert.equal(trades.unknownTemplateError(), `template must be one of ${trades.tradeIds().join(", ")}`);
});

test("defaultProjectName: the trade's name, numbered past those taken", async () => {
  const { defaultProjectName } = await import("./trades.ts");
  assert.equal(defaultProjectName("billing", []), "Billing");
  assert.equal(defaultProjectName("billing", ["billing", "Billing 2", "Payroll"]), "Billing 3");
});

test("the Website Builder's brief starts new sites coded, and falls back to design mode; the Designer's leaves the code to Cobra", () => {
  const builder = trades.TRADE_BRIEFS["website-builder"]!;
  for (const words of ["Every new site Cobra builds is a coded site", "site_start", ".cobra-attachments/concept/", "site_preview {worker}", "site_publish {worker}", "Never merge_request these Workers", "build the site in design mode instead", "site_edit {content}", "cobra.json", "src/content/forms.json", "<Form form=\"<id>\" />", "never use a form service"]) {
    assert.ok(builder.includes(words), words);
  }
  assert.ok(builder.indexOf("start it as a coded site") < builder.indexOf("only in design mode, build the site from it a file at a time"));
  const designer = trades.TRADE_BRIEFS.designer!;
  assert.ok(designer.includes("Cobra exports the picked concept's code"));
  assert.ok(designer.includes("the website card will name that service"));
});
