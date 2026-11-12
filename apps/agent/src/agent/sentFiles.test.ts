import { test } from "node:test";
import assert from "node:assert/strict";

import type { ApprovalAction } from "@cobra/contracts";

import type { Args, ProjectDb, TradeSchema } from "./dbTypes.ts";
import { BY_AGENT, markDocumentsSent, sentFiles, type MarkSentDeps } from "./sentFiles.ts";

const SHA = "a".repeat(64);

function email(attachments: Array<{ path: string; sha256: string }>): ApprovalAction {
  return {
    channel: "email",
    project: "acme-billing",
    projectName: "Acme Billing",
    summary: "Invoice INV-1 to Ada",
    email: { to: ["ada@example.com"], subject: "Invoice INV-1", text: "Attached.", attachments: attachments.map((file) => ({ ...file, name: file.path.split("/").pop()!, bytes: 10 })) },
  } as ApprovalAction;
}

const SCHEMA = { trade: "billing", version: 1, migrations: [], tables: {}, mutations: {}, sent: "documents_sent" } as unknown as TradeSchema;

type Call = { name: string; args: Args; by: string };

function deps(write: (name: string, args: Args) => string, schema: TradeSchema | null = SCHEMA): { deps: MarkSentDeps; calls: Call[]; closed: number[] } {
  const calls: Call[] = [];
  const closed: number[] = [];
  const db = {
    write(name: string, args: Args, by: string) {
      calls.push({ name, args, by });
      return { journal: 7, summary: write(name, args), changes: [] };
    },
    close() {
      closed.push(1);
    },
  } as unknown as ProjectDb;
  return { deps: { schemaFor: () => schema, open: () => db }, calls, closed };
}

const PROJECT = { id: "acme-billing", foremanTemplate: "billing" };

test("sentFiles: only an email's attachments count as sent; a note or a Drive copy reached no one", () => {
  assert.deepEqual(sentFiles(email([{ path: "out/invoice-1.pdf", sha256: SHA }])), [{ path: "out/invoice-1.pdf", sha256: SHA }]);
  assert.deepEqual(sentFiles({ channel: "note", note: { text: "x", attachments: [{ path: "out/a.pdf", name: "a.pdf", bytes: 1, sha256: SHA }] } } as unknown as ApprovalAction), []);
  assert.deepEqual(sentFiles({ channel: "file", files: { to: "drive", label: "Drive", path: "/x", items: [{ path: "out/a.pdf", name: "a.pdf", bytes: 1, sha256: SHA }] } } as unknown as ApprovalAction), []);
  assert.deepEqual(sentFiles(undefined), []);
});

test("markDocumentsSent runs the trade's sent mutation as the agent with the files, the time and the card", () => {
  const fake = deps(() => "1 document(s) sent");
  const summary = markDocumentsSent(fake.deps, PROJECT, { action: email([{ path: "out/invoice-1.pdf", sha256: SHA }]), cardId: "card-9", at: "2026-10-23T10:00:00.000Z" });
  assert.equal(summary, "1 document(s) sent");
  assert.deepEqual(fake.calls, [{ name: "documents_sent", args: { files: [{ path: "out/invoice-1.pdf", sha256: SHA }], sent_at: "2026-10-23T10:00:00.000Z", card_id: "card-9" }, by: BY_AGENT }]);
  assert.equal(fake.closed.length, 1);
});

test("markDocumentsSent does nothing for an email with no files, a trade with no database or no sent mutation", () => {
  const fake = deps(() => "x");
  assert.equal(markDocumentsSent(fake.deps, PROJECT, { action: email([]), cardId: "c", at: "t" }), null);
  const noDb = deps(() => "x", null);
  assert.equal(markDocumentsSent(noDb.deps, PROJECT, { action: email([{ path: "out/a.pdf", sha256: SHA }]), cardId: "c", at: "t" }), null);
  const noSent = deps(() => "x", { ...SCHEMA, sent: undefined });
  assert.equal(markDocumentsSent(noSent.deps, PROJECT, { action: email([{ path: "out/a.pdf", sha256: SHA }]), cardId: "c", at: "t" }), null);
  assert.equal(fake.calls.length + noDb.calls.length + noSent.calls.length, 0);
});

test("markDocumentsSent takes 'nothing matches' as nothing to mark, and throws any other refusal after closing the database", () => {
  const none = deps(() => {
    throw new Error("no recorded document matches those files");
  });
  assert.equal(markDocumentsSent(none.deps, PROJECT, { action: email([{ path: "notes.pdf", sha256: SHA }]), cardId: "c", at: "t" }), null);
  const broken = deps(() => {
    throw new Error("sent_at must be an ISO time");
  });
  assert.throws(() => markDocumentsSent(broken.deps, PROJECT, { action: email([{ path: "out/a.pdf", sha256: SHA }]), cardId: "c", at: "t" }), /sent_at must be an ISO time/);
  assert.equal(broken.closed.length, 1);
});
