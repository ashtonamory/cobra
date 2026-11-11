import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Project } from "@cobra/contracts";

import type { StoredApproval } from "./approvals.ts";
import { runAction, type ActionDeps } from "./actions.ts";
import { EmailQueue } from "./emailQueue.ts";
import { handleEmailOrch, handleEmailPerson, personValues, settleTemplateApproval, type EmailRouteDeps, type SpacePlace } from "./emailRoutes.ts";

const TEMPLATE = {
  version: 1,
  name: "Booking confirmation",
  kind: "transactional",
  subject: "You're booked, {first_name}",
  fields: { class_name: {} },
  blocks: [{ kind: "header" }, { kind: "text", body: "See you at {class_name}." }, { kind: "button", label: "Directions", href: "https://example.com/map" }, { kind: "footer" }],
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cobra-email-routes-"));
  mkdirSync(join(dir, "brand"));
  writeFileSync(join(dir, "brand", "brand.json"), JSON.stringify({ colors: { brand: "#0b1f3a", accent: "#f5b301", ink: "#0b1220", paper: "#f6f4ee" }, fonts: { heading: "Inter", body: "Inter" } }));
  const space: SpacePlace = { id: "example-com", dir, name: "Example.com" };
  const project = { id: "p1", name: "Studio", path: join(dir, "studio") } as Project;
  let approvals: StoredApproval[] = [];
  const notified: StoredApproval[] = [];
  const queue = new EmailQueue(join(dir, "q.db"));
  const deps: EmailRouteDeps = {
    project: async (id) => (id === "p1" ? project : undefined),
    space: () => space,
    spaceById: (id) => (id === space.id ? space : null),
    place: () => ({ brand: { colors: { brand: "#0b1f3a", accent: "#f5b301", ink: "#0b1220", paper: "#f6f4ee" }, fonts: { heading: "Inter", body: "Inter" } }, business: "Example.com" }),
    queue: () => queue,
    person: (_space, email) => (email === "ana@example.com" ? { id: 7, name: "Ana Silva", email, organization: null } : null),
    approvals: { load: () => approvals, save: (list) => (approvals = list) },
    notify: async (a) => void notified.push(a),
    log: () => {},
    now: () => Date.parse("2026-11-02T15:00:00Z"),
    hookStart: () => 0,
  };
  const foreman = { id: "fm", kind: "lead", project: "p1" };
  const post = (route: string, body: unknown) => handleEmailOrch(route, new URL(`http://x${route}`), JSON.stringify(body), foreman, deps);
  return { dir, space, deps, queue, notified, post, approvals: () => approvals };
}

test("only a Foreman of a Space works on its email", async () => {
  const t = setup();
  const reply = await handleEmailOrch("/orch/email/templates", new URL("http://x/orch/email/templates"), "", { id: "lead", kind: "lead" }, t.deps);
  assert.equal(reply.status, 403);
});

test("email_templates says which mailbox and address the Space's email goes from; refusals carry no from", async () => {
  const t = setup();
  const asked: string[] = [];
  t.deps.sender = async (space) => {
    asked.push(space);
    return { mailbox: "Zoho Mail", address: "owner@example.com" };
  };
  const reply = await t.post("/orch/email/templates", {});
  assert.equal(reply.status, 200);
  assert.deepEqual((reply.body as { from?: unknown }).from, { mailbox: "Zoho Mail", address: "owner@example.com" });
  assert.deepEqual(asked, ["example-com"]);
  const refused = await t.post("/orch/email/send", { template: "nothing", to: "ana@example.com" });
  assert.equal(refused.status, 404);
  assert.equal((refused.body as { from?: unknown }).from, undefined);
});

test("a template is saved, proposed as one card, and Allow makes it v1", async () => {
  const t = setup();
  assert.equal((await t.post("/orch/email/template/propose", { slug: "booking" })).status, 404);
  const saved = await t.post("/orch/email/template/save", { slug: "booking", template: TEMPLATE });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const preview = await t.post("/orch/email/template/preview", { slug: "booking" });
  assert.equal((preview.body as { subject: string }).subject, "You're booked, Alex");
  const proposed = await t.post("/orch/email/template/propose", { slug: "booking" });
  assert.equal(proposed.status, 202, JSON.stringify(proposed.body));
  assert.equal((await t.post("/orch/email/template/propose", { slug: "booking" })).status, 409, "one card waits at a time");
  const card = t.approvals()[0]!;
  assert.equal(card.kind, "email_template");
  assert.equal(card.title, "New email: Booking confirmation");
  assert.match(card.body, /Links: Directions → example\.com/);
  assert.deepEqual(card.emailTemplate?.fields, ["first_name", "class_name"]);
  const view = handleEmailPerson("/email/preview", "GET", new URL(`http://x/email/preview?approval=${card.id}`), { kind: "desk" }, t.deps, new Set(["desk"]));
  assert.equal(view.status, 200);
  assert.match((view.body as { html: string }).html, /Alex/);
  assert.equal(handleEmailPerson("/email/preview", "GET", new URL(`http://x/email/preview?approval=${card.id}`), { kind: "lead" }, t.deps, new Set(["desk"])).status, 403);

  const settled = settleTemplateApproval({ ...card, state: "allowed" }, t.deps, new Date());
  assert.equal(settled.approval.state, "done");
  assert.match(settled.news, /saved as booking v1/);
  const denied = settleTemplateApproval({ ...card, state: "denied" }, t.deps, new Date());
  assert.match(denied.news, /stays a draft/);
});

test("a send is one card with the email as it goes, and Allow queues exactly it", async () => {
  const t = setup();
  await t.post("/orch/email/template/save", { slug: "booking", template: TEMPLATE });
  assert.equal((await t.post("/orch/email/send", { template: "booking", to: "ana@example.com", values: { class_name: "Flow" } })).status, 404, "no allowed version yet");
  await t.post("/orch/email/template/propose", { slug: "booking" });
  settleTemplateApproval({ ...t.approvals()[0]!, state: "allowed" }, t.deps, new Date());
  assert.equal((await t.post("/orch/email/send", { template: "booking", to: "not an address" })).status, 400);
  assert.equal((await t.post("/orch/email/send", { template: "booking", to: "ana@example.com", values: { nope: "x" } })).status, 400);
  const sent = await t.post("/orch/email/send", { template: "booking", to: "ana@example.com", values: { class_name: "Flow" } });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const card = t.approvals().at(-1)!;
  assert.equal(card.kind, "action");
  assert.equal(card.title, "Email ana@example.com: You're booked, Ana");
  assert.match(card.body, /To: ana@example.com \(Ana Silva\)/);
  const b = card.action!.branded!;
  assert.equal(b.version, 1);
  assert.equal(b.personId, 7);
  assert.deepEqual(b.values, { class_name: "Flow", first_name: "Ana" });

  let queued: unknown = null;
  const deps = { queueBranded: async (branded: unknown, id: string) => ((queued = { branded, id }), "queued as email job 1") } as unknown as ActionDeps;
  const done = await runAction(deps, { ...card, state: "allowed" });
  assert.equal(done.state, "done");
  assert.deepEqual(queued, { branded: b, id: card.id });
  const none = await runAction({} as ActionDeps, { ...card, state: "allowed" });
  assert.equal(none.state, "failed");
});

test("People fields fill only what the Foreman left out", () => {
  const template = { ...TEMPLATE, subject: "{first_name} {organization} {email}" } as never;
  assert.deepEqual(personValues(template, { first_name: "Annie" }, { id: 1, name: "Ana Silva", email: "a@x.co", organization: "Silva Co" }, "a@x.co"), { first_name: "Annie", organization: "Silva Co", email: "a@x.co" });
  assert.deepEqual(personValues(template, {}, null, "a@x.co"), { email: "a@x.co" });
});

/** A 1×1 PNG, so the email images folder has real images. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("the person's own HTML email is saved from its file, read back, previewed and proposed as it is", async () => {
  const t = setup();
  const reference = readFileSync(new URL("../../email-standard/reference.html", import.meta.url), "utf8");
  const work = join(t.dir, "marketing", "email");
  mkdirSync(join(work, "images"), { recursive: true });
  writeFileSync(join(work, "agents.html"), reference);
  for (const file of ["acme-logo.png", "studio-avatar.png", "class-photo.jpg"]) {
    writeFileSync(join(work, "images", file), PNG);
    const added = await t.post("/orch/email/image", { from: join(work, "images", file) });
    assert.equal(added.status, 200, JSON.stringify(added.body));
  }
  const meta = { version: 1, name: "Agents", kind: "marketing", subject: "Winter wheel classes at Acme Studio", preheader: "Six weeks on the wheel, from clay to a mug you made." };
  assert.equal((await t.post("/orch/email/template/save", { slug: "agents", template: meta, htmlFile: "/etc/passwd" })).status, 400, "only a file inside the Space's folder");
  const saved = await t.post("/orch/email/template/save", { slug: "agents", template: meta, htmlFile: join(work, "agents.html") });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const got = (await t.post("/orch/email/template/get", { slug: "agents" })).body as { draft: boolean; template: { html: string } };
  assert.equal(got.draft, true);
  assert.equal(got.template.html, reference, "kept exactly as written");

  const preview = (await t.post("/orch/email/template/preview", { slug: "agents" })).body as { subject: string; text: string; errors: string[]; links: { href: string }[] };
  assert.deepEqual(preview.errors, []);
  assert.match(preview.text, /Hi Alex,/);
  assert.match(preview.text, /Book your first class: https:\/\/example\.com\/classes/);
  assert.equal(preview.links.length, 3);

  const proposed = await t.post("/orch/email/template/propose", { slug: "agents" });
  assert.equal(proposed.status, 202, JSON.stringify(proposed.body));
  const view = handleEmailPerson("/email/preview", "GET", new URL(`http://x/email/preview?approval=${t.approvals()[0]!.id}`), { kind: "desk" }, t.deps, new Set(["desk"]));
  const drawn = (view.body as { html: string }).html;
  assert.match(drawn, /From a lump of clay to your own&nbsp;mug\./, "the design itself, not blocks");
  assert.match(drawn, /src="data:image\/png;base64,/, "its images drawn from the email images folder");

  const standard = (await handleEmailOrch("/orch/email/standard", new URL("http://x/orch/email/standard"), "", { id: "fm", kind: "lead", project: "p1" }, t.deps)).body as { standard: string; reference: string };
  assert.match(standard.standard, /email design standard/);
  assert.equal(standard.reference, reference);
});

test("a Designer's Tessel email is saved as a designed template: converted, its images copied in, its design file named", async () => {
  const t = setup();
  const designs = join(t.dir, "designs", "email");
  mkdirSync(join(designs, "receipt.assets"), { recursive: true });
  writeFileSync(join(designs, "receipt.assets", "a1b2c3d4e5f6.png"), PNG);
  const design = JSON.parse(readFileSync(new URL("../../designer/templates/email-receipt.tessel.json", import.meta.url), "utf8"));
  // The Designer puts the logo in as an image layer.
  design.pages[0].children[0].children[0].children[0] = { id: "n_10g0xx9999", name: "Example.com", kind: "image", asset: "a1b2c3d4e5f6.png", width: 120, height: 32 };
  writeFileSync(join(designs, "receipt.tessel.json"), JSON.stringify(design));
  const meta = { version: 1, name: "Payment receipt", kind: "transactional", subject: "Payment received, thank you", preheader: "We received {{amount}} for invoice {{invoice_number}}.", fields: { amount: {}, invoice_number: {}, paid_on: {}, balance: { default: "Nothing" }, lines: { list: true } } };

  assert.equal((await t.post("/orch/email/design/save", { slug: "receipt", design: "/etc/passwd", template: meta })).status, 400, "only a design inside the Space's folder");
  assert.equal((await t.post("/orch/email/design/save", { slug: "receipt", design: join(designs, "receipt.tessel.json"), template: { ...meta, html: "<p>x</p>" } })).status, 400, "the design gives the html");
  const undeclared = await t.post("/orch/email/design/save", { slug: "receipt", design: join(designs, "receipt.tessel.json"), template: { ...meta, fields: { amount: {}, invoice_number: {}, paid_on: {}, balance: {} } } });
  assert.equal(undeclared.status, 400);
  assert.match(JSON.stringify(undeclared.body), /lines is not a list field/);

  const saved = await t.post("/orch/email/design/save", { slug: "receipt", design: "designs/email/receipt.tessel.json", template: meta });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual((saved.body as { images: string[] }).images, ["images/receipt-a1b2c3d4e5f6.png"]);
  const got = (await t.post("/orch/email/template/get", { slug: "receipt" })).body as { template: { html: string; design: string } };
  assert.equal(got.template.design, "designs/email/receipt.tessel.json");
  assert.match(got.template.html, /<img src="images\/receipt-a1b2c3d4e5f6\.png" width="120" height="32" alt="Example\.com"/);

  const preview = (await t.post("/orch/email/template/preview", { slug: "receipt", values: { amount: "$45", invoice_number: "INV-9", paid_on: "6 Nov", lines: [{ item: "Walk", qty: "3", amount: "$45" }] } })).body as { text: string; errors: string[] };
  assert.deepEqual(preview.errors, []);
  assert.match(preview.text, /Walk × 3\s+\$45/);
  assert.match(preview.text, /Still to pay\s+Nothing/, "a field's default");
  assert.equal((await t.post("/orch/email/template/propose", { slug: "receipt" })).status, 202);

  const standard = (await handleEmailOrch("/orch/email/standard", new URL("http://x/orch/email/standard"), "", { id: "fm", kind: "lead", project: "p1" }, t.deps)).body as { design: string };
  assert.match(standard.design, /repeat:<list>/);
});
