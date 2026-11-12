import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { audit } from "./auditTrail.ts";
import { CONFIG_DIR } from "./paths.ts";
import { readPrivateFile, removePrivateFile, writePrivateFile } from "./privateFs.ts";

/**
 * The vault: secret files sealed at rest (docs/plans/phase-2-security.md, step 1).
 *
 * One 256-bit key seals each secret file with AES-256-GCM, with the file's
 * name as associated data, so a sealed file moved onto another name does not
 * open. The key is kept in one of two places, which vault.json records:
 *
 *   keychain    the OS keychain: libsecret (`secret-tool`) on Linux,
 *               Keychain (`security`) on macOS. Open whenever the keychain is.
 *   passphrase  for a computer with no keychain. vault.json holds the key
 *               wrapped by a key scrypt derives from the person's passphrase;
 *               `cobra-agent vault unlock` puts the key in the runtime folder
 *               (in memory, gone at logout and reboot), where the agent reads
 *               it. Until then the agent runs, and what needs a secret
 *               says the vault is locked.
 *
 * With no vault.json there is no vault: secret files stay plaintext, as
 * before. What this protects is secrets at rest (backups, synced dotfiles, a
 * lost disk); not malware running as this user while the vault is open.
 */

export const SEAL_PREFIX = "cobra-vault:v1:";
export const VAULT_FILE_NAME = "vault.json";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** How long a process trusts the key it read before asking again, so `vault lock` reaches a running agent. */
const KEY_TTL_MS = 30_000;
/** scrypt for the passphrase: about 0.3 s and 128 MB, once per unlock. */
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/**
 * The secret files the vault seals, by name: the ones only the agent reads.
 * github-pat is one since the GitHub launcher gets its token from the agent
 * (githubMcp.ts); github-auth.json holds no token, only how it was made, but
 * goes with it. The Lead's and Foremen's keys are in no file: only the agent holds them
 * (orchSocket.ts).
 */
export const SEALED_NAMES: ReadonlySet<string> = new Set(["anthropic-api-key", "claude-token", "cloudflare.json", "mailboxes.json", "github-pat", "github-auth.json"]);

export function isSealedName(path: string): boolean {
  return SEALED_NAMES.has(basename(path));
}

export type VaultMode = "keychain" | "passphrase";

export type VaultFile = {
  version: 1;
  mode: VaultMode;
  /** The keychain item's account name; random, so two installs never share one. */
  id: string;
  /** passphrase mode: the scrypt salt and the key, sealed with the derived key. */
  salt?: string;
  wrapped?: string;
};

/** The OS keychain, as the vault needs it. */
export interface Keychain {
  readonly name: string;
  get(id: string): Buffer | null;
  set(id: string, key: Buffer): boolean;
  remove(id: string): void;
}

export class VaultError extends Error {}

export type VaultStatus =
  | { mode: "none"; open: false; why: string }
  | { mode: VaultMode; open: boolean; why: string };

// --- the cipher -----------------------------------------------------------------------

/** Seal text for the file named `name`. */
export function seal(key: Buffer, name: string, text: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `${SEAL_PREFIX}${Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64")}\n`;
}

/** Open sealed text of the file named `name`; null when it does not open with this key or name. */
export function unseal(key: Buffer, name: string, sealed: string): string | null {
  const raw = Buffer.from(sealed.trim().slice(SEAL_PREFIX.length), "base64");
  if (raw.length < NONCE_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, NONCE_BYTES));
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function isSealed(text: string): boolean {
  return text.startsWith(SEAL_PREFIX);
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize("NFC"), salt, KEY_BYTES, { ...SCRYPT, maxmem: SCRYPT_MAXMEM });
}

// --- the keychains ------------------------------------------------------------------------

const SERVICE = "cobra-agent";

/** libsecret through `secret-tool` (Linux). The key goes through stdin, never argv. */
export const secretTool: Keychain = {
  name: "the keychain (libsecret)",
  get(id) {
    const run = spawnSync("secret-tool", ["lookup", "service", SERVICE, "vault", id], { encoding: "utf8", timeout: 10_000 });
    return run.status === 0 ? keyFrom(run.stdout) : null;
  },
  set(id, key) {
    const run = spawnSync("secret-tool", ["store", "--label=Cobra vault key", "service", SERVICE, "vault", id], { input: key.toString("base64"), timeout: 30_000 });
    return run.status === 0;
  },
  remove(id) {
    spawnSync("secret-tool", ["clear", "service", SERVICE, "vault", id], { timeout: 10_000 });
  },
};

/** The login Keychain through `security` (macOS). Commands go through stdin (`security -i`), so the key is never in argv. */
export const macKeychain: Keychain = {
  name: "the Keychain",
  get(id) {
    const run = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", id, "-w"], { encoding: "utf8", timeout: 10_000 });
    return run.status === 0 ? keyFrom(run.stdout) : null;
  },
  set(id, key) {
    const run = spawnSync("security", ["-i"], { input: `add-generic-password -U -s ${SERVICE} -a ${id} -l "Cobra vault key" -w ${key.toString("base64")}\n`, timeout: 30_000 });
    return run.status === 0;
  },
  remove(id) {
    spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", id], { timeout: 10_000 });
  },
};

function keyFrom(text: string): Buffer | null {
  const key = Buffer.from(text.trim(), "base64");
  return key.length === KEY_BYTES ? key : null;
}

export function platformKeychain(platform: NodeJS.Platform = process.platform): Keychain | null {
  if (platform === "linux") return secretTool;
  if (platform === "darwin") return macKeychain;
  return null;
}

// --- the vault ----------------------------------------------------------------------------

export type VaultPlaces = {
  /** The config folder that holds vault.json. */
  configDir: string;
  /** Where an unlocked passphrase vault keeps its key: in memory, private to this user. */
  runtimeDir: string;
  keychain: Keychain | null;
  now?: () => number;
};

export function defaultRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.COBRA_RUNTIME_DIR) return env.COBRA_RUNTIME_DIR;
  if (env.XDG_RUNTIME_DIR?.startsWith("/")) return join(env.XDG_RUNTIME_DIR, "cobra-agent");
  return join(tmpdir(), `cobra-agent-${process.getuid?.() ?? "user"}`);
}

export class Vault {
  private cached: { key: Buffer | null; at: number } | null = null;

  private readonly places: VaultPlaces;

  constructor(places: VaultPlaces) {
    this.places = places;
  }

  private get file(): string {
    return join(this.places.configDir, VAULT_FILE_NAME);
  }

  private get runtimeKey(): string {
    return join(this.places.runtimeDir, "vault.key");
  }

  private now(): number {
    return this.places.now?.() ?? Date.now();
  }

  /** vault.json, or null when there is no vault. Throws when it is there but cannot be trusted or read. */
  config(): VaultFile | null {
    const read = readPrivateFile(this.file);
    if (read.refused) throw new VaultError(`${this.file} was refused (${read.refused})`);
    if (read.text === null) return null;
    let parsed: Partial<VaultFile>;
    try {
      parsed = JSON.parse(read.text) as Partial<VaultFile>;
    } catch {
      throw new VaultError(`${this.file} is not valid JSON`);
    }
    if (parsed.version !== 1 || (parsed.mode !== "keychain" && parsed.mode !== "passphrase") || typeof parsed.id !== "string") {
      throw new VaultError(`${this.file} is not a vault this agent knows`);
    }
    return parsed as VaultFile;
  }

  /** Whether a vault is set up here (secret files are then always sealed). */
  configured(): boolean {
    return this.config() !== null;
  }

  /** The key, or null when there is no vault or it is locked. */
  key(): Buffer | null {
    if (this.cached && this.now() - this.cached.at < KEY_TTL_MS) return this.cached.key;
    let key: Buffer | null = null;
    try {
      const config = this.config();
      if (config?.mode === "keychain") key = this.places.keychain?.get(config.id) ?? null;
      if (config?.mode === "passphrase") key = keyFrom(readPrivateFile(this.runtimeKey).text ?? "");
    } catch {
      key = null;
    }
    this.cached = { key, at: this.now() };
    return key;
  }

  /** Forget the cached key: the next read asks again. */
  forget(): void {
    this.cached = null;
  }

  status(): VaultStatus {
    let config: VaultFile | null;
    try {
      config = this.config();
    } catch (error) {
      return { mode: "none", open: false, why: (error as Error).message };
    }
    if (!config) return { mode: "none", open: false, why: "no vault: secret files are kept as plain text (run cobra-agent vault init)" };
    this.forget();
    const open = this.key() !== null;
    if (config.mode === "keychain") {
      return { mode: "keychain", open, why: open ? `open: the key is in ${this.places.keychain?.name ?? "the keychain"}` : `locked: ${this.places.keychain?.name ?? "the keychain"} did not give the key (is it unlocked?)` };
    }
    return { mode: "passphrase", open, why: open ? "open until you log out or restart (cobra-agent vault lock closes it now)" : "locked: run cobra-agent vault unlock and type your passphrase" };
  }

  /**
   * Make the vault. With no passphrase, the key goes in the keychain; that
   * failing is a VaultError that says to give a passphrase. With one, the key
   * is wrapped by it and the vault is left unlocked.
   */
  init(passphrase?: string): VaultMode {
    if (this.configured()) throw new VaultError("a vault is already set up here (cobra-agent vault status)");
    const key = randomBytes(KEY_BYTES);
    const id = randomBytes(8).toString("hex");
    if (passphrase === undefined) {
      const keychain = this.places.keychain;
      if (!keychain || !keychain.set(id, key)) throw new VaultError("no keychain here took the key; set a passphrase instead");
      const back = keychain.get(id);
      if (!back || !timingSafeEqual(back, key)) {
        keychain.remove(id);
        throw new VaultError("the keychain did not give the key back; set a passphrase instead");
      }
      writePrivateFile(this.file, `${JSON.stringify({ version: 1, mode: "keychain", id } satisfies VaultFile, null, 2)}\n`);
      this.forget();
      audit("vault.init", { actor: "cli", detail: { mode: "keychain", keychain: keychain.name } });
      return "keychain";
    }
    if (passphrase.length < 12) throw new VaultError("the passphrase needs at least 12 characters");
    const salt = randomBytes(16);
    const wrapped = seal(deriveKey(passphrase, salt), VAULT_FILE_NAME, key.toString("base64"));
    writePrivateFile(this.file, `${JSON.stringify({ version: 1, mode: "passphrase", id, salt: salt.toString("base64"), wrapped: wrapped.trim() } satisfies VaultFile, null, 2)}\n`);
    this.putRuntimeKey(key);
    audit("vault.init", { actor: "cli", detail: { mode: "passphrase" } });
    return "passphrase";
  }

  /** Open a passphrase vault until logout or restart. A wrong passphrase is a VaultError. */
  unlock(passphrase: string): void {
    const config = this.config();
    if (!config) throw new VaultError("there is no vault here (cobra-agent vault init)");
    if (config.mode !== "passphrase") throw new VaultError("this vault's key is in the keychain; it opens with the keychain");
    const opened = unseal(deriveKey(passphrase, Buffer.from(config.salt ?? "", "base64")), VAULT_FILE_NAME, config.wrapped ?? "");
    const key = opened === null ? null : keyFrom(opened);
    if (!key) {
      audit("vault.unlock", { actor: "cli", outcome: "refused", detail: { why: "wrong passphrase" } });
      throw new VaultError("that passphrase does not open this vault");
    }
    this.putRuntimeKey(key);
    audit("vault.unlock", { actor: "cli" });
  }

  /** Close a passphrase vault now. A keychain vault closes with the keychain. */
  lock(): void {
    const config = this.config();
    if (config?.mode !== "passphrase") throw new VaultError(config ? "this vault's key is in the keychain; lock the keychain to close it" : "there is no vault here");
    removePrivateFile(this.runtimeKey);
    this.forget();
    audit("vault.lock", { actor: "cli" });
  }

  private putRuntimeKey(key: Buffer): void {
    mkdirSync(this.places.runtimeDir, { recursive: true, mode: 0o700 });
    writePrivateFile(this.runtimeKey, `${key.toString("base64")}\n`);
    this.forget();
  }
}

let current: Vault | null = null;

/** This process's vault, in the agent's config folder and this user's runtime folder. */
export function vault(): Vault {
  current ??= new Vault({ configDir: CONFIG_DIR, runtimeDir: defaultRuntimeDir(), keychain: platformKeychain() });
  return current;
}

/** For tests: the vault private.ts seals with. */
export function useVault(next: Vault | null): void {
  current = next;
}
