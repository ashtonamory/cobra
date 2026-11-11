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
  PHONE_SCOPES,
  type Caller,
} from "./keys.ts";

/** A widget key as a Cobra phone registered it: Cobra mints none, but an old keys.json may hold one. */
function legacyWidget(keyHash: string): Caller {
  return { id: "widget_iphone_aaaaaaaaaaaaaaaa", name: "iPhone widgets", kind: "widget", keyHash, scopes: ["glance"], linkedAt: 1 };
}

function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cobra-keys-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function phone(id: string, key: string): Caller {
  return { id, name: "iPhone", kind: "phone", keyHash: hashKey(key), scopes: [...PHONE_SCOPES], linkedAt: 1 };
}

test("a linked phone is found by its key, and the file holds only the hash", () => {
  const { dir, done } = scratch();
  try {
    const store = createKeyStore(join(dir, "keys.json"));
    store.upsert(phone("iphone_aaaaaaaaaaaaaaaa", "the-key"));
    assert.equal(store.authenticate("the-key")?.id, "iphone_aaaaaaaaaaaaaaaa");
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
    agent.upsert(phone("iphone_aaaaaaaaaaaaaaaa", "the-key"));
    assert.ok(agent.authenticate("the-key"));
    cli.remove("iphone_aaaaaaaaaaaaaaaa");
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
    store.upsert(phone("iphone_aaaaaaaaaaaaaaaa", "the-key"));
    chmodSync(path, 0o644);
    assert.equal(store.authenticate("the-key"), null);
    assert.match(store.load().refused ?? "", /mode 644/);

    const real = join(dir, "real.json");
    writeFileSync(real, JSON.stringify([phone("iphone_aaaaaaaaaaaaaaaa", "the-key")]), { mode: 0o600 });
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
  const good = phone("iphone_aaaaaaaaaaaaaaaa", "k");
  const callers = parseCallers(
    JSON.stringify([
      good,
      { ...good, id: "short" },
      { ...good, keyHash: "not-a-hash" },
      { ...good, kind: "admin" },
      { ...good, scopes: ["root"] },
      { ...good, scopes: ["read", "root"], id: "iphone_cccccccccccccccc" },
      { ...good, pushToken: "nonsense", id: "iphone_dddddddddddddddd" },
    ]),
  );
  assert.deepEqual(callers.map((c) => c.id), ["iphone_aaaaaaaaaaaaaaaa", "iphone_cccccccccccccccc", "iphone_dddddddddddddddd"]);
  assert.deepEqual(callers[1]!.scopes, ["read"]);
  assert.equal(callers[2]!.pushToken, undefined);
  assert.deepEqual(parseCallers("not json"), []);
  assert.deepEqual(parseCallers("{}"), []);
});

test("a desktop gets a key of its own that expires, read and act but no terminal, and no push", () => {
  const { caller, key, relayKey } = mintDesk("  Legion desk  ", 5);
  assert.equal(caller.kind, "desk");
  assert.equal(caller.name, "Legion desk");
  assert.match(caller.id, /^desk_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(caller.scopes, ["read", "act"]);
  assert.equal(caller.expiresAt, 5 + KEY_LIFETIME_MS);
  assert.equal(caller.pushToken, undefined);
  // Only the hash is stored, and it survives a round trip through keys.json.
  assert.equal(JSON.stringify(caller).includes(key), false);
  const [back] = parseCallers(JSON.stringify([caller]));
  assert.deepEqual(back, caller);
  assert.equal(findCaller([back!], key)?.id, caller.id);
  assert.equal(findCaller([back!], `${key}x`), null);
  assert.notEqual(mintDesk("Legion desk", 5).key, key);
  // The relay key is a second secret, kept whole, never the key itself.
  assert.match(relayKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(caller.relayKey, relayKey);
  assert.notEqual(relayKey, key);
  assert.notEqual(mintDesk("Legion desk", 5).relayKey, relayKey);
});

test("a desktop's relay key round-trips through keys.json, and never opens a request", () => {
  const { caller, key, relayKey } = mintDesk("Legion desk", 5);
  const text = JSON.stringify([caller]);
  assert.equal(text.includes(relayKey), true, "the relay key is stored whole, like a push key");
  assert.equal(text.includes(key), false);
  const [back] = parseCallers(text);
  assert.equal(back?.relayKey, relayKey);
  assert.equal(findCaller([back!], relayKey), null, "a relay key is not a caller's key");
  // A wrong shape is dropped, not kept; a kind without a relay key never gets one.
  assert.equal(parseCallers(JSON.stringify([{ ...caller, relayKey: "short" }]))[0]?.relayKey, undefined);
  assert.equal(parseCallers(JSON.stringify([{ ...caller, kind: "lead", scopes: ["orch"], relayKey }]))[0]?.relayKey, undefined);
});


const DAY = 24 * 60 * 60_000;

test("a phone's signing key is taken once and never replaced", () => {
  const { dir, done } = scratch();
  try {
    const store = createKeyStore(join(dir, "keys.json"));
    store.upsert(phone("iphone_aaaaaaaaaaaaaaaa", "the-key"));
    const first = "A".repeat(43);
    assert.equal(store.setSignKey("iphone_aaaaaaaaaaaaaaaa", first), "set");
    assert.equal(store.setSignKey("iphone_aaaaaaaaaaaaaaaa", first), "set");
    assert.equal(store.setSignKey("iphone_aaaaaaaaaaaaaaaa", "B".repeat(43)), "exists");
    assert.equal(store.authenticate("the-key")?.signKey, first);
    assert.equal(store.setSignKey("iphone_bbbbbbbbbbbbbbbb", first), "missing");
  } finally {
    done();
  }
});

test("the device list shows each key's age and expiry, never a hash or a secret", () => {
  const now = 1_800_000_000_000;
  const caller: Caller = {
    ...phone("iphone_aaaaaaaaaaaaaaaa", "secret-key"),
    linkedAt: now - 70 * DAY,
    rotatedAt: now - 10 * DAY,
    expiresAt: now + 80 * DAY,
    signKey: "A".repeat(43),
    pushKey: "B".repeat(43),
  };
  const view = keyView(caller, now, "iphone_aaaaaaaaaaaaaaaa");
  assert.equal(view.keyAgeDays, 10);
  assert.equal(view.expiresInDays, 80);
  assert.equal(view.expiresAt, new Date(now + 80 * DAY).toISOString());
  assert.equal(view.signs, true);
  assert.equal(view.you, true);
  const text = JSON.stringify(view);
  for (const secret of [caller.keyHash, "A".repeat(43), "B".repeat(43)]) assert.ok(!text.includes(secret));
  const desk = keyView(mintDesk("Desk", now - DAY).caller, now);
  assert.equal(desk.keyAgeDays, 1);
  assert.equal(desk.you, false);
  assert.equal(desk.signs, false);
});

test("Lead and Foreman keys expire, and are extended only while their orchestrator runs (OV-SEC-VPS-001 F23b)", () => {
  const { dir, done } = scratch();
  try {
    const store = createKeyStore(join(dir, "keys.json"));
    const now = 1_800_000_000_000;
    const { caller: lead, key: leadKey } = mintLead("legion", now);
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
    const { caller, key } = mintLead("legion", 1);
    const { expiresAt: _drop, ...old } = caller;
    store.upsert(old);
    assert.equal(store.authenticate(key, now)?.expiresAt, now + ORCH_KEY_LIFETIME_MS);
    assert.equal(parseCallers(readFileSync(join(dir, "keys.json"), "utf8"))[0]?.expiresAt, now + ORCH_KEY_LIFETIME_MS);
  } finally {
    done();
  }
});

test("a phone key made before keys expired gets 90 days on first use, not an instant lockout", () => {
  const { dir, done } = scratch();
  try {
    const store = createKeyStore(join(dir, "keys.json"));
    store.upsert(phone("iphone_aaaaaaaaaaaaaaaa", "old-key"));
    const now = 1_800_000_000_000;
    assert.equal(store.authenticate("old-key", now)?.expiresAt, now + KEY_LIFETIME_MS);
    // Written down: a later use does not push it out again.
    assert.equal(store.authenticate("old-key", now + DAY)?.expiresAt, now + KEY_LIFETIME_MS);
    assert.equal(parseCallers(readFileSync(join(dir, "keys.json"), "utf8"))[0]!.expiresAt, now + KEY_LIFETIME_MS);
    // Keys that do not expire stay that way.
    store.upsert(legacyWidget(hashKey("widget-key")));
    assert.equal(store.authenticate("widget-key", now)?.expiresAt, undefined);
  } finally {
    done();
  }
});


test("a rotation swaps the key; the old one works until the new one is used, never after", () => {
  const { dir, done } = scratch();
  try {
    const store = createKeyStore(join(dir, "keys.json"));
    const now = 1_800_000_000_000;
    store.upsert({ ...phone("iphone_aaaaaaaaaaaaaaaa", "old-key"), expiresAt: now + 10 * DAY });
    const rotated = store.rotate("iphone_aaaaaaaaaaaaaaaa", "old-key", hashKey("new-key"), now);
    assert.equal(rotated?.expiresAt, now + KEY_LIFETIME_MS);
    assert.equal(rotated?.rotatedAt, now);
    assert.ok(!readFileSync(join(dir, "keys.json"), "utf8").includes("new-key"));
    // The reply may have been lost: the old key still works, with its own expiry.
    assert.equal(store.authenticate("old-key", now)?.expiresAt, now + 10 * DAY);
    // A second try from the old key replaces the unused new one, and the old key stays the fallback.
    assert.ok(store.rotate("iphone_aaaaaaaaaaaaaaaa", "old-key", hashKey("newer-key"), now));
    assert.equal(store.authenticate("new-key", now), null);
    assert.equal(store.authenticate("old-key", now)?.expiresAt, now + 10 * DAY);
    // The first use of the new key retires the old one.
    assert.equal(store.authenticate("newer-key", now)?.expiresAt, now + KEY_LIFETIME_MS);
    assert.equal(store.authenticate("old-key", now), null);
    // A hash already in use, or a caller whose key does not rotate, is refused.
    assert.equal(store.rotate("iphone_aaaaaaaaaaaaaaaa", "newer-key", hashKey("newer-key"), now), null);
    store.upsert(legacyWidget(hashKey("widget-key")));
    assert.equal(store.rotate("widget_iphone_aaaaaaaaaaaaaaaa", "widget-key", hashKey("x"), now), null);
  } finally {
    done();
  }
});


test("a desktop key that could open terminals loses that; expiry and signing survive keys.json", () => {
  const stored = [
    { id: "desk_aaaaaaaaaaaaaaaaaaaaaa", name: "Desk", kind: "desk", keyHash: hashKey("d"), scopes: ["read", "act", "terminal"], linkedAt: 1 },
    {
      ...phone("iphone_aaaaaaaaaaaaaaaa", "p"),
      expiresAt: 9,
      rotatedAt: 2,
      prevKeyHash: hashKey("q"),
      prevExpiresAt: 8,
      signKey: "A".repeat(43),
    },
    // A widget never signs, expires or keeps an old key.
    { ...legacyWidget(hashKey("w")), expiresAt: 9, signKey: "A".repeat(43), prevKeyHash: hashKey("q"), prevExpiresAt: 8 },
  ];
  const [desk, phoneBack, widget] = parseCallers(JSON.stringify(stored));
  assert.deepEqual(desk!.scopes, ["read", "act"]);
  assert.deepEqual(
    [phoneBack!.expiresAt, phoneBack!.rotatedAt, phoneBack!.prevKeyHash, phoneBack!.prevExpiresAt, phoneBack!.signKey],
    [9, 2, hashKey("q"), 8, "A".repeat(43)],
  );
  assert.deepEqual([widget!.expiresAt, widget!.signKey, widget!.prevKeyHash], [undefined, undefined, undefined]);
});
