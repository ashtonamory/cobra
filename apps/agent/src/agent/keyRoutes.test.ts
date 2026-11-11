import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KeyList } from "@cobra/contracts";

import { keyRoute } from "./keyRoutes.ts";
import { createKeyStore, hashKey, KEY_LIFETIME_MS, mintDesk, PHONE_SCOPES, type Caller } from "./keys.ts";

const NOW = 1_800_000_000_000;
const PUSH_KEY = Buffer.from(new Uint8Array(32).fill(9)).toString("base64url");

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "cobra-keyroutes-"));
  return { store: createKeyStore(join(dir, "keys.json")), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const phone: Caller = {
  id: "iphone_1234567890abcdef",
  name: "iPhone",
  kind: "phone",
  keyHash: hashKey("phone-key"),
  scopes: [...PHONE_SCOPES],
  linkedAt: NOW - 1000,
  expiresAt: NOW + 10_000,
  pushKey: PUSH_KEY,
};

test("GET /keys lists every key with its age and expiry, in the contract's shape", () => {
  const { store, done } = scratch();
  try {
    store.upsert(phone);
    store.upsert(mintDesk("Legion desktop", NOW).caller);
    const reply = keyRoute("/keys", "GET", phone, "phone-key", "", store, "omarchy", NOW);
    assert.equal(reply.status, 200);
    const list = KeyList.parse(reply.body);
    assert.equal(list.machine, "omarchy");
    assert.deepEqual(list.keys.map((key) => [key.kind, key.you]), [["phone", true], ["desk", false]]);
    assert.ok(!JSON.stringify(reply.body).includes(PUSH_KEY));
    assert.ok(!JSON.stringify(reply.body).includes(phone.keyHash));
    assert.equal(keyRoute("/keys", "POST", phone, "phone-key", "{}", store, "omarchy", NOW).status, 405);
  } finally {
    done();
  }
});

test("a desktop rotates with its key alone; a widget or a Lead does not rotate this way", () => {
  const { store, done } = scratch();
  try {
    const { caller: desk, key } = mintDesk("Legion desktop", NOW);
    store.upsert(desk);
    const reply = keyRoute("/keys/rotate", "POST", desk, key, JSON.stringify({ keyHash: hashKey("desk-next") }), store, "m", NOW + 1);
    assert.equal(reply.status, 200);
    assert.equal(store.authenticate("desk-next", NOW + 1)?.id, desk.id);
    assert.equal(store.authenticate(key, NOW + 1), null);
    const widget: Caller = { ...phone, id: "widget_iphone_1234567890abcdef", kind: "widget", scopes: ["glance"] };
    assert.equal(keyRoute("/keys/rotate", "POST", widget, "w", JSON.stringify({ keyHash: hashKey("x") }), store, "m", NOW).status, 403);
  } finally {
    done();
  }
});
