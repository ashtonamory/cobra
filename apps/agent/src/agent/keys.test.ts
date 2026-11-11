import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createKeyStore,
  findCaller,
  hashKey,
  KEY_LIFETIME_MS,
  keyView,
  mintDesk,
  mintForeman,
  mintLead,
  ORCH_KEY_LIFETIME_MS,
  parseCallers,
  DESK_SCOPES,
  type Caller,
} from "./keys.ts";

function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cobra-keys-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A desk key as keys.json holds it, with no expiry yet (one made before keys expired). */
function desk(id: string, key: string): Caller {
  return { id, name: "Desk", kind: "desk", keyHash: hashKey(key), scopes: [...DESK_SCOPES], linkedAt: 1 };
}

test("a linked desk is found by its key, and the file holds only the hash", () => {
  const { dir, done } = scratch();
  try {
    const store = createKeyStore(join(dir, "keys.json"));
    store.upsert(desk("desk_aaaaaaaaaaaaaaaa", "the-key"));
    assert.equal(store.authenticate("the-key")?.id, "desk_aaaaaaaaaaaaaaaa");
    assert.equal(store.authenticate("another-key"), null);
    const text = readFileSync(join(dir, "keys.json"), "utf8");
    assert.ok(!text.includes("the-key"));
    assert.equal(statSync(join(dir, "keys.json")).mode & 0o777, 0o600);
  } finally {
    done();
  }
});

test("a change written by another process is seen on the next check", () => {
  const { dir, done } = scratch();
  try {
    const path = join(dir, "keys.json");
    const agent = createKeyStore(path);
    const cli = createKeyStore(path);
    agent.upsert(desk("desk_aaaaaaaaaaaaaaaa", "the-key"));
    assert.ok(agent.authenticate("the-key"));
    cli.remove("desk_aaaaaaaaaaaaaaaa");
    assert.equal(agent.authenticate("the-key"), null);
  } finally {
    done();
  }
});

test("a file other accounts can read, or a symlink, admits nobody", () => {
  const { dir, done } = scratch();
  try {
    const path = join(dir, "keys.json");
    const store = createKeyStore(path);
    store.upsert(desk("desk_aaaaaaaaaaaaaaaa", "the-key"));
    chmodSync(path, 0o644);
    assert.equal(store.authenticate("the-key"), null);
    assert.match(store.load().refused ?? "", /mode 644/);

    const real = join(dir, "real.json");
    writeFileSync(real, JSON.stringify([desk("desk_aaaaaaaaaaaaaaaa", "the-key")]), { mode: 0o600 });
    const linked = join(dir, "linked.json");
    symlinkSync(real, linked);
    const viaLink = createKeyStore(linked);
    assert.equal(viaLink.authenticate("the-key"), null);
    assert.match(viaLink.load().refused ?? "", /symlink/);
  } finally {
    done();
  }
});

test("entries that fail a check are dropped, not trusted", () => {
  const good = desk("desk_aaaaaaaaaaaaaaaa", "k");
  const callers = parseCallers(
    JSON.stringify([
      good,
      { ...good, id: "short" },
      { ...good, keyHash: "not-a-hash" },
      { ...good, kind: "admin" },
      { ...good, scopes: ["root"] },
      { ...good, scopes: ["read", "root"], id: "desk_cccccccccccccccc" },
    ]),
  );
  assert.deepEqual(callers.map((c) => c.id), ["desk_aaaaaaaaaaaaaaaa", "desk_cccccccccccccccc"]);
  assert.deepEqual(callers[1]!.scopes, ["read"]);
  assert.deepEqual(parseCallers("not json"), []);
  assert.deepEqual(parseCallers("{}"), []);
});

test("a key of a kind Cobra no longer has stops working, and never becomes a desk or a Lead key", () => {
  const good = desk("desk_aaaaaaaaaaaaaaaa", "k");
  const old = [
    { id: "iphone_aaaaaaaaaaaaaaaa", name: "iPhone", kind: "phone", keyHash: hashKey("p"), scopes: ["read", "act", "terminal"], linkedAt: 1 },
    { id: "omarchy_HUB1234567890ab", name: "Hub", kind: "peer", keyHash: hashKey("h"), scopes: ["receive"], linkedAt: 1 },
    { id: "widget_iphone_aaaaaaaaaaaaaaaa", name: "Widgets", kind: "widget", keyHash: hashKey("w"), scopes: ["glance"], linkedAt: 1 },
    { id: "api_aaaaaaaaaaaaaaaaaaaa", name: "API", kind: "api", keyHash: hashKey("a"), scopes: ["read", "act"], linkedAt: 1 },
    // A desk key whose only scopes are ones that are gone has nothing left to do.
    { ...good, id: "desk_bbbbbbbbbbbbbbbb", keyHash: hashKey("b"), scopes: ["receive", "glance"] },
  ];
  const callers = parseCallers(JSON.stringify([...old, good]));
  assert.deepEqual(callers.map((c) => c.id), ["desk_aaaaaaaaaaaaaaaa"]);
  for (const key of ["p", "h", "w", "a", "b"]) assert.equal(findCaller(callers, key), null);
  // Fields of the old kinds on a kept entry are ignored, never carried.
  const [kept] = parseCallers(JSON.stringify([{ ...good, pushToken: "ExponentPushToken[abc]", pushKey: "B".repeat(43), signKey: "A".repeat(43), relayKey: "C".repeat(43) }]));
  assert.deepEqual(kept, good);
});

test("a desk gets a key of its own that expires: read and act, no terminal", () => {
  const { caller, key } = mintDesk("  Laptop desk  ", 5);
  assert.equal(caller.kind, "desk");
  assert.equal(caller.name, "Laptop desk");
  assert.match(caller.id, /^desk_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(caller.scopes, ["read", "act"]);
  assert.equal(caller.expiresAt, 5 + KEY_LIFETIME_MS);
  // Only the hash is stored, and it survives a round trip through keys.json.
  assert.equal(JSON.stringify(caller).includes(key), false);
  const [back] = parseCallers(JSON.stringify([caller]));
  assert.deepEqual(back, caller);
  assert.equal(findCaller([back!], key)?.id, caller.id);
  assert.equal(findCaller([back!], `${key}x`), null);
  assert.notEqual(mintDesk("Laptop desk", 5).key, key);
});

const DAY = 24 * 60 * 60_000;

test("the key list shows each key's age and expiry, never a hash", () => {
  const now = 1_800_000_000_000;
  const caller: Caller = { ...desk("desk_aaaaaaaaaaaaaaaa", "secret-key"), linkedAt: now - 70 * DAY, rotatedAt: now - 10 * DAY, expiresAt: now + 80 * DAY };
  const view = keyView(caller, now, "desk_aaaaaaaaaaaaaaaa");
  assert.equal(view.keyAgeDays, 10);
  assert.equal(view.expiresInDays, 80);
  assert.equal(view.expiresAt, new Date(now + 80 * DAY).toISOString());
  assert.equal(view.you, true);
  assert.ok(!JSON.stringify(view).includes(caller.keyHash));
  const other = keyView(mintDesk("Desk", now - DAY).caller, now);
  assert.equal(other.keyAgeDays, 1);
  assert.equal(other.you, false);
});

test("Lead and Foreman keys expire, and are extended only while their orchestrator runs", () => {
  const { dir, done } = scratch();
  try {
    const store = createKeyStore(join(dir, "keys.json"));
    const now = 1_800_000_000_000;
    const { caller: lead, key: leadKey } = mintLead("laptop", now);
    const { caller: foreman, key: foremanKey } = mintForeman("site", now);
    assert.equal(lead.expiresAt, now + ORCH_KEY_LIFETIME_MS);
    assert.equal(foreman.expiresAt, now + ORCH_KEY_LIFETIME_MS);
    for (const caller of [lead, foreman]) store.upsert(caller);
    assert.equal(store.authenticate(leadKey, now)?.expiresAt, now + ORCH_KEY_LIFETIME_MS, "the expiry survives keys.json");

    // A day on, the running Foreman's key is pushed out again; the stopped Lead's is not.
    const later = now + DAY;
    assert.deepEqual(store.extendOrch([foreman.id, "nobody_aaaaaaaaaaaa"], later), [foreman.id]);
    assert.equal(store.authenticate(foremanKey, later)?.expiresAt, later + ORCH_KEY_LIFETIME_MS);
    assert.equal(store.authenticate(leadKey, later)?.expiresAt, now + ORCH_KEY_LIFETIME_MS);
    // Extended again the same hour: nothing to write.
    assert.deepEqual(store.extendOrch([foreman.id], later + 60_000), []);

    // An expired key is never brought back by an extension.
    const gone = now + ORCH_KEY_LIFETIME_MS + 1;
    assert.deepEqual(store.extendOrch([lead.id], gone), []);
    assert.equal(store.authenticate(leadKey, gone)?.expiresAt, now + ORCH_KEY_LIFETIME_MS);
  } finally {
    done();
  }
});

test("a Lead key made before orchestrator keys expired gets its 30 days on first use, not a lockout", () => {
  const { dir, done } = scratch();
  try {
    const store = createKeyStore(join(dir, "keys.json"));
    const now = 1_800_000_000_000;
    const { caller, key } = mintLead("laptop", 1);
    const { expiresAt: _drop, ...old } = caller;
    store.upsert(old);
    assert.equal(store.authenticate(key, now)?.expiresAt, now + ORCH_KEY_LIFETIME_MS);
    assert.equal(parseCallers(readFileSync(join(dir, "keys.json"), "utf8"))[0]?.expiresAt, now + ORCH_KEY_LIFETIME_MS);
  } finally {
    done();
  }
});

test("a desk key made before keys expired gets 90 days on first use, not an instant lockout", () => {
  const { dir, done } = scratch();
  try {
    const store = createKeyStore(join(dir, "keys.json"));
    store.upsert(desk("desk_aaaaaaaaaaaaaaaa", "old-key"));
    const now = 1_800_000_000_000;
    assert.equal(store.authenticate("old-key", now)?.expiresAt, now + KEY_LIFETIME_MS);
    // Written down: a later use does not push it out again.
    assert.equal(store.authenticate("old-key", now + DAY)?.expiresAt, now + KEY_LIFETIME_MS);
    assert.equal(parseCallers(readFileSync(join(dir, "keys.json"), "utf8"))[0]!.expiresAt, now + KEY_LIFETIME_MS);
  } finally {
    done();
  }
});


test("a rotation swaps the key; the old one works until the new one is used, never after", () => {
  const { dir, done } = scratch();
  try {
    const store = createKeyStore(join(dir, "keys.json"));
    const now = 1_800_000_000_000;
    store.upsert({ ...desk("desk_aaaaaaaaaaaaaaaa", "old-key"), expiresAt: now + 10 * DAY });
    const rotated = store.rotate("desk_aaaaaaaaaaaaaaaa", "old-key", hashKey("new-key"), now);
    assert.equal(rotated?.expiresAt, now + KEY_LIFETIME_MS);
    assert.equal(rotated?.rotatedAt, now);
    assert.ok(!readFileSync(join(dir, "keys.json"), "utf8").includes("new-key"));
    // The reply may have been lost: the old key still works, with its own expiry.
    assert.equal(store.authenticate("old-key", now)?.expiresAt, now + 10 * DAY);
    // A second try from the old key replaces the unused new one, and the old key stays the fallback.
    assert.ok(store.rotate("desk_aaaaaaaaaaaaaaaa", "old-key", hashKey("newer-key"), now));
    assert.equal(store.authenticate("new-key", now), null);
    assert.equal(store.authenticate("old-key", now)?.expiresAt, now + 10 * DAY);
    // The first use of the new key retires the old one.
    assert.equal(store.authenticate("newer-key", now)?.expiresAt, now + KEY_LIFETIME_MS);
    assert.equal(store.authenticate("old-key", now), null);
    // A hash already in use, or a caller whose key does not rotate, is refused.
    assert.equal(store.rotate("desk_aaaaaaaaaaaaaaaa", "newer-key", hashKey("newer-key"), now), null);
    const { caller: lead, key: leadKey } = mintLead("laptop", now);
    store.upsert(lead);
    assert.equal(store.rotate(lead.id, leadKey, hashKey("x"), now), null);
  } finally {
    done();
  }
});


test("a desk key that could open terminals loses that; expiry and the rotated-out key survive keys.json", () => {
  const stored = [
    { id: "desk_aaaaaaaaaaaaaaaaaaaaaa", name: "Desk", kind: "desk", keyHash: hashKey("d"), scopes: ["read", "act", "terminal"], linkedAt: 1, expiresAt: 9, rotatedAt: 2, prevKeyHash: hashKey("q"), prevExpiresAt: 8 },
    // A Lead's key is never rotated by its holder, so it keeps no old key.
    { ...mintLead("laptop", 1).caller, prevKeyHash: hashKey("q"), prevExpiresAt: 8 },
  ];
  const [back, lead] = parseCallers(JSON.stringify(stored));
  assert.deepEqual(back!.scopes, ["read", "act"]);
  assert.deepEqual([back!.expiresAt, back!.rotatedAt, back!.prevKeyHash, back!.prevExpiresAt], [9, 2, hashKey("q"), 8]);
  assert.deepEqual([lead!.prevKeyHash, lead!.prevExpiresAt], [undefined, undefined]);
});
