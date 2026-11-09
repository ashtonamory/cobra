import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleMailboxes } from "./mailboxRoutes.ts";

const PERSON = new Set(["phone", "desk"]);

test("phase 7: the phone or desk adds a box, points a Space at it, and never sees the password", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "cobra-box-routes-")), "mailboxes.json");
  const logs: string[] = [];
  const deps = { spaces: () => [{ id: "s1", name: "Happy Tails" }], now: () => new Date("2026-11-02T15:00:00Z"), log: (l: string) => logs.push(l), path, checks: { smtp: async () => {}, imap: async () => {} } };
  const call = (route: string, method: string, body: unknown, kind = "phone") => handleMailboxes(route, method, JSON.stringify(body ?? {}), { kind }, deps, PERSON);

  assert.equal((await call("/email/mailboxes", "GET", null, "foreman")).status, 403);
  const empty = (await call("/email/mailboxes", "GET", null)).body as { boxes: unknown[]; providers: { id: string }[]; spaces: { box: string }[] };
  assert.deepEqual(empty.providers.map((p) => p.id), ["icloud", "zoho"]);
  assert.equal(empty.spaces[0]!.box, "gmail");

  const added = await call("/email/mailboxes", "POST", { provider: "icloud", address: "studio@icloud.com", password: "abcd-efgh-ijkl-mnop" });
  assert.equal(added.status, 200);
  assert.doesNotMatch(JSON.stringify(added.body), /abcd-efgh/);
  assert.ok(!logs.some((l) => l.includes("abcd")));
  const id = (added.body as { box: { id: string } }).box.id;

  assert.equal((await call("/email/mailboxes/space", "POST", { space: "nope", box: id })).status, 404);
  const pointed = (await call("/email/mailboxes/space", "POST", { space: "s1", box: id })).body as { spaces: { box: string }[]; boxes: { spaces: string[] }[] };
  assert.equal(pointed.spaces[0]!.box, id);
  assert.deepEqual(pointed.boxes[0]!.spaces, ["s1"]);
  assert.equal((await call("/email/mailboxes/remove", "POST", { id })).status, 409, "a Space still sends from it");
  await call("/email/mailboxes/space", "POST", { space: "s1", box: "gmail" });
  assert.equal(((await call("/email/mailboxes/remove", "POST", { id })).body as { boxes: unknown[] }).boxes.length, 0);
});

test("F18: a mailboxes.json others can read is a 500 that says what to do, not an empty list", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "cobra-box-routes-")), "mailboxes.json");
  const deps = { spaces: () => [{ id: "s1", name: "Happy Tails" }], now: () => new Date("2026-11-02T15:00:00Z"), log: () => {}, path, checks: { smtp: async () => {}, imap: async () => {} } };
  const call = (route: string, method: string, body: unknown) => handleMailboxes(route, method, JSON.stringify(body ?? {}), { kind: "phone" }, deps, PERSON);
  assert.equal((await call("/email/mailboxes", "POST", { provider: "icloud", address: "studio@icloud.com", password: "abcd-efgh-ijkl-mnop" })).status, 200);
  chmodSync(path, 0o644);
  const listed = await call("/email/mailboxes", "GET", null);
  assert.equal(listed.status, 500);
  assert.match((listed.body as { error: string }).error, /chmod 600/);
  assert.doesNotMatch(JSON.stringify(listed.body), /abcd-efgh/);
});
