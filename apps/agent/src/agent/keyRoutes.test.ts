import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KeyList } from "@cobra/contracts";

import { keyRoute } from "./keyRoutes.ts";
import { createKeyStore, hashKey, mintDesk, mintLead } from "./keys.ts";

const NOW = 1_800_000_000_000;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "cobra-keyroutes-"));
  return { store: createKeyStore(join(dir, "keys.json")), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("GET /keys lists every key with its age and expiry, in the contract's shape", () => {
  const { store, done } = scratch();
  try {
    const { caller: desk, key } = mintDesk("Laptop desktop", NOW);
    const { caller: lead } = mintLead("laptop", NOW);
    store.upsert(desk);
    store.upsert(lead);
    const reply = keyRoute("/keys", "GET", desk, key, "", store, "omarchy", NOW);
    assert.equal(reply.status, 200);
    const list = KeyList.parse(reply.body);
    assert.equal(list.machine, "omarchy");
    assert.deepEqual(list.keys.map((entry) => [entry.kind, entry.you]), [["desk", true], ["lead", false]]);
    assert.ok(!JSON.stringify(reply.body).includes(desk.keyHash));
    assert.ok(!JSON.stringify(reply.body).includes(lead.keyHash));
    assert.equal(keyRoute("/keys", "POST", desk, key, "{}", store, "omarchy", NOW).status, 405);
  } finally {
    done();
  }
});

test("the desk rotates with its key alone; a Lead does not rotate this way", () => {
  const { store, done } = scratch();
  try {
    const { caller: desk, key } = mintDesk("Laptop desktop", NOW);
    store.upsert(desk);
    const reply = keyRoute("/keys/rotate", "POST", desk, key, JSON.stringify({ keyHash: hashKey("desk-next") }), store, "m", NOW + 1);
    assert.equal(reply.status, 200);
    assert.equal(store.authenticate("desk-next", NOW + 1)?.id, desk.id);
    assert.equal(store.authenticate(key, NOW + 1), null);
    const { caller: lead, key: leadKey } = mintLead("laptop", NOW);
    assert.equal(keyRoute("/keys/rotate", "POST", lead, leadKey, JSON.stringify({ keyHash: hashKey("x") }), store, "m", NOW).status, 403);
  } finally {
    done();
  }
});
