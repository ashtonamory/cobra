import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR } from "./paths.ts";
import type { KeyView } from "@cobra/contracts";

import { audit } from "./auditTrail.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";

/**
 * Who may call this agent, and for what.
 *
 * There is no shared token. Each caller has a key of its own, and only a
 * SHA-256 of it is kept here: the file proves a caller, it cannot become one.
 *
 * Two kinds call. The desk (Cobra's desktop app, and the `cobra-agent`
 * command): `cobra-agent desk` makes it a key. And a Lead (the orchestrator,
 * workers.ts): its key reaches /orch/* and nothing else, Workers and their
 * status, never a session, a file or git, so a Lead key that leaks starts
 * sandboxed Workers at worst. A Foreman's key is a Lead key held to one
 * project.
 *
 * Scopes keep each key to its job. A desk reads and acts; a Lead only
 * orchestrates. No key holds `terminal` (the scope /ticket needs): the desk
 * opens a terminal on this computer itself. A key of a kind Cobra no longer
 * has (a phone's, a peer's, a widget's, a cloud API's) is skipped when
 * keys.json is read, so it stops working and never becomes one of these.
 *
 * A desk key expires (KEY_LIFETIME_MS after it was made or last rotated) and
 * is rotated by its holder before then (POST /keys/rotate), so a copy taken
 * once stops working. A key made before keys expired gets its expiry on
 * first use.
 *
 * A Lead's and a Foreman's key expire too (ORCH_KEY_LIFETIME_MS). Only the
 * agent holds them: it adds them to the calls that come down each
 * orchestrator's line (orchSocket.ts), mints them at its own start and at
 * each Foreman's, and pushes their expiry out while it serves the line
 * (extendOrch, from its hourly tick). A key whose line closed dies within
 * ORCH_KEY_LIFETIME_MS; a key that has expired is never brought back.
 */
export type Scope = "read" | "act" | "terminal" | "orch";
export const DESK_SCOPES: readonly Scope[] = ["read", "act"];
export const LEAD_SCOPES: readonly Scope[] = ["orch"];
const SCOPES: readonly Scope[] = ["read", "act", "terminal", "orch"];

const DAY_MS = 24 * 60 * 60_000;
/** How long a desk key works after it was made or last rotated. */
export const KEY_LIFETIME_MS = 90 * DAY_MS;
/** How long a Lead's or Foreman's key works without a start or a run to extend it. */
export const ORCH_KEY_LIFETIME_MS = 30 * DAY_MS;
/** A running orchestrator's key is pushed out again once a day of it has passed. */
export const ORCH_EXTEND_AFTER_MS = DAY_MS;
/** The desk rotates its key once less than this is left (`x-cobra-key-expires` on every reply). */
export const ROTATE_WITHIN_MS = 30 * DAY_MS;
/** The reply header that tells the desk when its key expires (ms since the epoch). */
export const KEY_EXPIRES_HEADER = "x-cobra-key-expires";

export type Caller = {
  id: string;
  name: string;
  kind: "desk" | "lead";
  keyHash: string;
  scopes: Scope[];
  linkedAt: number;
  /**
   * When the key stops working (ms). Absent on a key made before keys
   * expired, until its first use sets it (createKeyStore).
   */
  expiresAt?: number;
  /** When the key was last rotated (POST /keys/rotate). */
  rotatedAt?: number;
  /**
   * The key the last rotation replaced: still accepted, until its own expiry,
   * so a reply lost on the way never strands the holder. The first request
   * with the new key drops it.
   */
  prevKeyHash?: string;
  prevExpiresAt?: number;
  /**
   * A Foreman's key (foreman.ts): a Lead key held to one project. /orch/*
   * shows and acts on that project and its Workers only (orch.ts).
   */
  project?: string;
};

export const KEYS_PATH = join(CONFIG_DIR, "keys.json");

const CALLER_ID = /^[A-Za-z0-9_-]{16,128}$/;
const KEY_HASH = /^[0-9a-f]{64}$/;

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Entries that fail a check are dropped, never trusted. */
export function parseCallers(text: string): Caller[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const callers: Caller[] = [];
  for (const entry of raw) {
    const v = (entry ?? {}) as Record<string, unknown>;
    if (typeof v.id !== "string" || !CALLER_ID.test(v.id)) continue;
    if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 80) continue;
    // Any other kind is from before Cobra ran on one computer (a phone, a peer, a widget, a cloud API): it stops working here.
    if (v.kind !== "desk" && v.kind !== "lead") continue;
    if (typeof v.keyHash !== "string" || !KEY_HASH.test(v.keyHash)) continue;
    // A key made for another computer, from before Cobra ran on one only: it stops working here, never becomes a local key.
    if (v.remote === true) continue;
    if (!Array.isArray(v.scopes)) continue;
    // A scope Cobra no longer has is dropped. The desk never opens terminals with its key; one made when it could loses that here.
    const scopes = v.scopes.filter((scope): scope is Scope => SCOPES.includes(scope as Scope) && !(v.kind === "desk" && scope === "terminal"));
    if (scopes.length === 0) continue;
    if (typeof v.linkedAt !== "number") continue;
    const caller: Caller = { id: v.id, name: v.name, kind: v.kind, keyHash: v.keyHash, scopes, linkedAt: v.linkedAt };
    if (typeof v.expiresAt === "number" && (expiring(caller) || orchExpiring(caller))) caller.expiresAt = v.expiresAt;
    if (typeof v.rotatedAt === "number") caller.rotatedAt = v.rotatedAt;
    if (typeof v.prevKeyHash === "string" && KEY_HASH.test(v.prevKeyHash) && typeof v.prevExpiresAt === "number" && expiring(caller)) {
      caller.prevKeyHash = v.prevKeyHash;
      caller.prevExpiresAt = v.prevExpiresAt;
    }
    if (typeof v.project === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(v.project) && v.kind === "lead") caller.project = v.project;
    callers.push(caller);
  }
  return callers;
}

/** Whether a caller's key expires and is rotated by its holder: the desk's. */
export function expiring(caller: Pick<Caller, "kind">): boolean {
  return caller.kind === "desk";
}

/** Whether a caller is a Lead's or Foreman's key, which expires and is extended while it runs. */
export function orchExpiring(caller: Pick<Caller, "kind">): boolean {
  return caller.kind === "lead";
}

function sameHash(stored: string | undefined, hash: Buffer): boolean {
  if (!stored) return false;
  const bytes = Buffer.from(stored, "utf8");
  return bytes.length === hash.length && timingSafeEqual(bytes, hash);
}

/**
 * The caller a presented key belongs to, and whether it was the key the last
 * rotation replaced. Every stored hash is compared in constant time, and
 * every one is compared, so the time taken says nothing about which entry
 * (if any) matched.
 */
export function matchCaller(callers: readonly Caller[], presented: string): { caller: Caller; previous: boolean } | null {
  if (!presented) return null;
  const hash = Buffer.from(hashKey(presented), "utf8");
  let found: { caller: Caller; previous: boolean } | null = null;
  for (const caller of callers) {
    const current = sameHash(caller.keyHash, hash);
    const previous = sameHash(caller.prevKeyHash, hash);
    if ((current || previous) && !found) found = { caller, previous: !current };
  }
  return found;
}

/**
 * The caller a presented key belongs to. A key the last rotation replaced is
 * the same caller, with that key's own expiry.
 */
export function findCaller(callers: readonly Caller[], presented: string): Caller | null {
  const match = matchCaller(callers, presented);
  if (!match) return null;
  return match.previous ? { ...match.caller, expiresAt: match.caller.prevExpiresAt } : match.caller;
}

/** A caller as the key list shows it (GET /keys): never a hash or a secret. */
export function keyView(caller: Caller, now: number, you?: string): KeyView {
  const madeAt = caller.rotatedAt ?? caller.linkedAt;
  return {
    id: caller.id,
    name: caller.name,
    kind: caller.kind,
    scopes: [...caller.scopes],
    linkedAt: new Date(caller.linkedAt).toISOString(),
    ...(caller.rotatedAt !== undefined ? { rotatedAt: new Date(caller.rotatedAt).toISOString() } : {}),
    keyAgeDays: Math.max(0, Math.floor((now - madeAt) / DAY_MS)),
    ...(caller.expiresAt !== undefined
      ? { expiresAt: new Date(caller.expiresAt).toISOString(), expiresInDays: Math.floor((caller.expiresAt - now) / DAY_MS) }
      : {}),
    ...(caller.project ? { project: caller.project } : {}),
    you: caller.id === you,
  };
}

/** A new desk caller and the key it will present, returned once for the desk to keep; only the key's hash is stored here. */
export function mintDesk(
  name: string,
  now: number,
  random: (size: number) => Uint8Array = randomBytes,
): { caller: Caller; key: string } {
  const key = Buffer.from(random(32)).toString("base64url");
  const caller: Caller = {
    id: `desk_${Buffer.from(random(16)).toString("base64url")}`,
    name: name.trim().slice(0, 80) || "Desktop",
    kind: "desk",
    keyHash: hashKey(key),
    scopes: [...DESK_SCOPES],
    linkedAt: now,
    expiresAt: now + KEY_LIFETIME_MS,
  };
  return { caller, key };
}

/**
 * A new Lead caller and its key, returned once. `id` is fixed per Lead (the
 * computer the Lead runs on), so minting again rotates the key.
 */
export function mintLead(
  name: string,
  now: number,
  random: (size: number) => Uint8Array = randomBytes,
): { caller: Caller; key: string } {
  const key = Buffer.from(random(32)).toString("base64url");
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "local";
  const caller: Caller = {
    id: `lead_${slug}`.padEnd(16, "_"),
    name: `Lead on ${name.trim().slice(0, 60) || "this computer"}`,
    kind: "lead",
    keyHash: hashKey(key),
    scopes: [...LEAD_SCOPES],
    linkedAt: now,
    expiresAt: now + ORCH_KEY_LIFETIME_MS,
  };
  return { caller, key };
}

export function foremanCallerId(project: string): string {
  return `foreman_${project.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 100)}`.padEnd(16, "_");
}

/** A Foreman's key: a Lead key held to one project (foreman.ts). Minting again rotates it. */
export function mintForeman(
  project: string,
  now: number,
  random: (size: number) => Uint8Array = randomBytes,
): { caller: Caller; key: string } {
  const key = Buffer.from(random(32)).toString("base64url");
  const caller: Caller = {
    id: foremanCallerId(project),
    name: `Foreman for ${project}`.slice(0, 80),
    kind: "lead",
    keyHash: hashKey(key),
    scopes: [...LEAD_SCOPES],
    linkedAt: now,
    expiresAt: now + ORCH_KEY_LIFETIME_MS,
    project,
  };
  return { caller, key };
}

export type KeyStore = ReturnType<typeof createKeyStore>;

/** A key made, rotated or removed, in the audit log (auditTrail.ts): who it is for, never the key or its hash. */
function keyAudit(kind: string, caller: Caller, by: string): void {
  audit(kind, {
    actor: by,
    subject: { target: caller.id, ...(caller.project ? { project: caller.project } : {}) },
    detail: { keyKind: caller.kind, name: caller.name, scopes: caller.scopes, ...(caller.expiresAt !== undefined ? { expires: new Date(caller.expiresAt).toISOString() } : {}) },
  });
}

/**
 * keys.json, read through on change. The agent checks a key on every request,
 * so the parsed list is kept until the file's identity or size or mtime moves
 * (the CLI's `unlink` writes it from another process).
 */
export function createKeyStore(path = KEYS_PATH) {
  let cache: { stamp: string; callers: Caller[]; refused: string | null } | null = null;

  function stamp(): string {
    try {
      const info = statSync(path);
      return `${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch {
      return "absent";
    }
  }

  function load(): { callers: Caller[]; refused: string | null } {
    const now = stamp();
    if (cache && cache.stamp === now) return cache;
    const read = readPrivateFile(path);
    cache = { stamp: now, callers: read.text ? parseCallers(read.text) : [], refused: read.refused };
    return cache;
  }

  function save(callers: Caller[]): void {
    writePrivateFile(path, `${JSON.stringify(callers, null, 2)}\n`);
    cache = null;
  }

  return {
    path,
    load,
    /**
     * The caller for a presented key, or null. A refused file admits nobody.
     * Expiry is the caller's to check (auth.ts): the caller comes back with
     * the expiry of the key presented. A desk key made before keys expired
     * gets one now, and the first use of a rotated key retires the one it
     * replaced.
     */
    authenticate(presented: string, now = Date.now()): Caller | null {
      const { callers, refused } = load();
      if (refused) return null;
      const match = matchCaller(callers, presented);
      if (!match) return null;
      const { caller, previous } = match;
      if (previous) return { ...caller, expiresAt: caller.prevExpiresAt };
      if (orchExpiring(caller)) {
        if (caller.expiresAt !== undefined) return caller;
        // An orchestrator key made before they expired gets its time on first use.
        const next: Caller = { ...caller, expiresAt: now + ORCH_KEY_LIFETIME_MS };
        try {
          save(callers.map((entry) => (entry === caller ? next : entry)));
        } catch (caught) {
          console.warn(`[keys] could not record ${caller.id}'s key expiry: ${caught instanceof Error ? caught.message : caught}`);
        }
        return next;
      }
      if (!expiring(caller) || (caller.expiresAt !== undefined && caller.prevKeyHash === undefined)) return caller;
      const { prevKeyHash: _hash, prevExpiresAt: _until, ...settled } = caller;
      const next: Caller = { ...settled, expiresAt: caller.expiresAt ?? now + KEY_LIFETIME_MS };
      try {
        save(callers.map((entry) => (entry === caller ? next : entry)));
      } catch (caught) {
        // The request still proceeds; the next one tries the write again.
        console.warn(`[keys] could not record ${caller.id}'s key expiry: ${caught instanceof Error ? caught.message : caught}`);
      }
      return next;
    },
    /**
     * Swap the desk's key for one it made (only the hash comes
     * here), good for KEY_LIFETIME_MS. The key presented stays accepted until
     * the new one is first used, or its own expiry. Null when there is no
     * such caller, or the hash is one already in use.
     */
    rotate(id: string, presented: string, keyHash: string, now = Date.now()): Caller | null {
      const { callers } = load();
      const caller = callers.find((entry) => entry.id === id && expiring(entry));
      if (!caller || !KEY_HASH.test(keyHash) || callers.some((entry) => entry.keyHash === keyHash || entry.prevKeyHash === keyHash)) return null;
      const presentedHash = hashKey(presented);
      const wasPrevious = presentedHash === caller.prevKeyHash;
      const next: Caller = {
        ...caller,
        keyHash,
        prevKeyHash: presentedHash,
        prevExpiresAt: (wasPrevious ? caller.prevExpiresAt : caller.expiresAt) ?? now + KEY_LIFETIME_MS,
        expiresAt: now + KEY_LIFETIME_MS,
        rotatedAt: now,
      };
      save(callers.map((entry) => (entry === caller ? next : entry)));
      keyAudit("key.rotated", next, id);
      return next;
    },
    /**
     * Pushes out the expiry of these Lead and Foreman keys, whose
     * orchestrators run now, to ORCH_KEY_LIFETIME_MS from `now`. Only a key
     * still good, and only once ORCH_EXTEND_AFTER_MS has passed since it was
     * last set, so keys.json is written about once a day. Returns the ids
     * extended.
     */
    extendOrch(ids: Iterable<string>, now = Date.now()): string[] {
      const want = new Set(ids);
      const { callers } = load();
      const until = now + ORCH_KEY_LIFETIME_MS;
      const extended: string[] = [];
      const next = callers.map((caller) => {
        if (!want.has(caller.id) || !orchExpiring(caller) || caller.expiresAt === undefined) return caller;
        if (caller.expiresAt <= now || until - caller.expiresAt < ORCH_EXTEND_AFTER_MS) return caller;
        extended.push(caller.id);
        return { ...caller, expiresAt: until };
      });
      if (extended.length) save(next);
      return extended;
    },
    /** Add a caller, or replace the one with the same id and kind (minting again rotates the key). */
    upsert(caller: Caller, by = "agent"): void {
      const rest = load().callers.filter((c) => !(c.id === caller.id && c.kind === caller.kind));
      save([...rest, caller]);
      keyAudit("key.minted", caller, by);
    },
    /** Remove by id; returns whether anything went. */
    remove(id: string, by = "agent"): boolean {
      const { callers } = load();
      const rest = callers.filter((caller) => caller.id !== id);
      if (rest.length === callers.length) return false;
      save(rest);
      for (const gone of callers.filter((caller) => !rest.includes(caller))) keyAudit("key.revoked", gone, by);
      return true;
    },
  };
}
