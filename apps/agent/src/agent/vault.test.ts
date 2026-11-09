import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPrivateFile, writePrivateFile, createPrivateFileOnce } from "./private.ts";
import { isSealed, seal, unseal, useVault, Vault, VaultError, type Keychain } from "./vault.ts";
import { secretFiles } from "./vaultCli.ts";

function fakeKeychain(works = true): Keychain & { items: Map<string, Buffer> } {
  const items = new Map<string, Buffer>();
  return {
    name: "the test keychain",
    items,
    get: (id) => items.get(id) ?? null,
    set: (id, key) => (works ? (items.set(id, Buffer.from(key)), true) : false),
    remove: (id) => void items.delete(id),
  };
}

function places(keychain: Keychain | null = fakeKeychain()) {
  const root = mkdtempSync(join(tmpdir(), "cobra-vault-"));
  mkdirSync(join(root, "config"), { mode: 0o700 });
  return { root, configDir: join(root, "config"), runtimeDir: join(root, "run"), keychain };
}

const KEY = Buffer.alloc(32, 7);

test("a sealed text opens with its key and its file name, and with nothing else", () => {
  const sealed = seal(KEY, "mailboxes.json", '{"boxes":[]}');
  assert.ok(isSealed(sealed));
  assert.doesNotMatch(sealed, /boxes/);
  assert.equal(unseal(KEY, "mailboxes.json", sealed), '{"boxes":[]}');
  assert.equal(unseal(KEY, "cloudflare.json", sealed), null, "moved onto another name, it does not open");
  assert.equal(unseal(Buffer.alloc(32, 8), "mailboxes.json", sealed), null, "another key does not open it");
  assert.notEqual(seal(KEY, "a", "x"), seal(KEY, "a", "x"), "a fresh nonce each time");
});

test("a keychain vault keeps its key in the keychain and is open with it", () => {
  const keychain = fakeKeychain();
  const p = places(keychain);
  const v = new Vault(p);
  assert.equal(v.status().mode, "none");
  assert.equal(v.key(), null);
  assert.equal(v.init(), "keychain");
  assert.equal(keychain.items.size, 1);
  assert.equal(statSync(join(p.configDir, "vault.json")).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(join(p.configDir, "vault.json"), "utf8"), new RegExp([...keychain.items.values()][0]!.toString("base64").replace(/[+/=]/g, ".")), "the key is not in vault.json");
  assert.equal(v.key()?.length, 32);
  assert.deepEqual([v.status().mode, v.status().open], ["keychain", true]);
  assert.throws(() => v.init(), VaultError, "made once");
  keychain.items.clear();
  v.forget();
  assert.deepEqual([v.status().mode, v.status().open], ["keychain", false], "a keychain without the key is locked");
});

test("with no keychain that takes the key, init asks for a passphrase", () => {
  assert.throws(() => new Vault(places(fakeKeychain(false))).init(), /set a passphrase/);
  assert.throws(() => new Vault(places(null)).init(), /set a passphrase/);
});

test("a passphrase vault: open after init, locked after lock, open again with the passphrase only", () => {
  const p = places(null);
  const v = new Vault(p);
  assert.throws(() => v.init("short"), /12 characters/);
  assert.equal(v.init("correct horse battery"), "passphrase");
  const key = v.key();
  assert.equal(key?.length, 32);
  assert.equal(statSync(join(p.runtimeDir, "vault.key")).mode & 0o777, 0o600);
  v.lock();
  assert.equal(v.key(), null);
  assert.equal(v.status().open, false);
  assert.throws(() => v.unlock("wrong horse battery"), /does not open/);
  v.unlock("correct horse battery");
  assert.deepEqual(v.key(), key, "the same key comes back");
  assert.throws(() => new Vault(places()).unlock("anything at all"), /no vault/);
});

test("a secret file is sealed on disk and read back as plain text; other private files are untouched", () => {
  const p = places();
  const v = new Vault(p);
  v.init();
  useVault(v);
  try {
    const secret = join(p.configDir, "mailboxes.json");
    const plain = join(p.configDir, "projects.json");
    writePrivateFile(secret, '{"boxes":[{"password":"hunter2"}]}');
    writePrivateFile(plain, '{"projects":[]}');
    assert.ok(isSealed(readFileSync(secret, "utf8")));
    assert.doesNotMatch(readFileSync(secret, "utf8"), /hunter2/);
    assert.equal(readPrivateFile(secret).text, '{"boxes":[{"password":"hunter2"}]}');
    assert.equal(readFileSync(plain, "utf8"), '{"projects":[]}');
    const once = join(p.configDir, "anthropic-api-key");
    assert.equal(createPrivateFileOnce(once, "sk-ant-test\n"), true);
    assert.ok(isSealed(readFileSync(once, "utf8")));
    assert.equal(readPrivateFile(once).text, "sk-ant-test\n");
  } finally {
    useVault(null);
  }
});

test("a secret file from before the vault is read as it is and sealed by that read", () => {
  const p = places();
  const v = new Vault(p);
  v.init();
  useVault(v);
  try {
    const old = join(p.configDir, "cloudflare.json");
    writeFileSync(old, '{"token":"cf"}', { mode: 0o600 });
    assert.equal(readPrivateFile(old).text, '{"token":"cf"}');
    assert.ok(isSealed(readFileSync(old, "utf8")), "sealed by the read");
    assert.equal(readPrivateFile(old).text, '{"token":"cf"}');
  } finally {
    useVault(null);
  }
});

test("a locked vault refuses a sealed read and a secret write, and says how to open it", () => {
  const p = places(null);
  const v = new Vault(p);
  v.init("correct horse battery");
  useVault(v);
  try {
    const secret = join(p.configDir, "mailboxes.json");
    writePrivateFile(secret, "{}");
    v.lock();
    const read = readPrivateFile(secret);
    assert.equal(read.text, null);
    assert.match(read.refused ?? "", /^the vault is locked: run cobra-agent vault unlock/);
    assert.throws(() => writePrivateFile(secret, '{"boxes":[]}'), /vault is locked, so mailboxes.json was not saved/);
    writePrivateFile(join(p.configDir, "projects.json"), "{}");
  } finally {
    useVault(null);
  }
});

test("with no vault, secret files stay plain text as before", () => {
  const p = places();
  useVault(new Vault(p));
  try {
    const secret = join(p.configDir, "mailboxes.json");
    writePrivateFile(secret, "{}");
    assert.equal(readFileSync(secret, "utf8"), "{}");
  } finally {
    useVault(null);
  }
});

test("the secret files are the vault's names in the config folder and each account's Claude token", () => {
  const p = places();
  writeFileSync(join(p.configDir, "mailboxes.json"), "{}");
  writeFileSync(join(p.configDir, "projects.json"), "{}");
  mkdirSync(join(p.configDir, "accounts", "claude-1a2b"), { recursive: true });
  writeFileSync(join(p.configDir, "accounts", "claude-1a2b", "claude-token"), "sk-ant-x");
  assert.deepEqual(secretFiles(p.configDir).map((path) => path.slice(p.configDir.length + 1)).sort(), ["accounts/claude-1a2b/claude-token", "mailboxes.json"]);
  rmSync(p.root, { recursive: true, force: true });
});
