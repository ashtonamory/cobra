import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";

import { CONFIG_DIR } from "./paths.ts";
import { readPrivateFile } from "./private.ts";
import { REDACTED, scrubTokens } from "./redact.ts";
import { SEALED_NAMES } from "./vault.ts";

/**
 * The one redactor for what leaves the agent toward a model, a log or an
 * error (docs/plans/phase-2-security.md, step 2). It takes out two things:
 *
 *   1. the secret values the agent holds right now, read from its own secret
 *      files (the vault's SEALED_NAMES, the Lead's and Foremen's keys, the
 *      ticket key, each account's Claude and Codex sign-in), whatever shape
 *      they have;
 *   2. secrets certain by their shape (redact.ts scrubTokens), which also
 *      catches one the agent never held: a token in an email or a web page.
 *
 * Reading the files on every call would be slow, so each file's values are
 * kept with its inode, size and change time, and the files are looked at
 * again at most every few seconds; only one that changed is read again. A
 * sealed file read while the vault is locked keeps the values it had, so
 * locking the vault never lets a value it knew through.
 *
 * Where it runs, one choke point per channel: every /orch/* answer (orch.ts
 * handleOrch), every HTTP error body (index.ts sendJson), the agent's
 * console (installLogRedaction), the files it appends to (events, notices,
 * the thread, the audit log), and the text it types into a session
 * (dispatch.ts).
 */

/** Shorter than this is not looked for: a short value would match ordinary text. */
const MIN_LENGTH = 12;
const REFRESH_MS = 5_000;
/** A JSON field that holds a secret: token, accessToken, refresh_token, password, key, OPENAI_API_KEY. */
const SECRET_FIELD = /(?:token|password|secret|key)$/i;

/** Every file whose values are secrets here, whether or not it exists. */
export function secretSources(configDir = CONFIG_DIR, home = homedir()): string[] {
  const each = (dir: string, ...name: string[]): string[] => {
    try {
      return readdirSync(dir).map((id) => join(dir, id, ...name));
    } catch {
      return [];
    }
  };
  return [
    ...[...SEALED_NAMES].map((name) => join(configDir, name)),
    // Left by an install from when Cobra served a terminal; the installer removes it, and until then its value stays out of the logs.
    join(configDir, "ticket.key"),
    ...each(join(configDir, "accounts"), "claude-token"),
    ...each(join(configDir, "accounts"), "codex", "auth.json"),
    join(home, ".claude", ".credentials.json"),
    join(home, ".codex", "auth.json"),
  ];
}

/** The secret values in one file's text: a JSON file's secret fields, else the whole text when it is one word. */
export function valuesIn(text: string): string[] {
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed.length >= MIN_LENGTH && !/\s/.test(trimmed) ? [trimmed] : [];
  }
  const out: string[] = [];
  const walk = (value: unknown, field: string | null): void => {
    if (typeof value === "string") {
      if (field !== null && SECRET_FIELD.test(field) && value.length >= MIN_LENGTH) out.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, field);
    } else if (value !== null && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) walk(inner, key);
    }
  };
  walk(parsed, null);
  return out;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type SecretRead = (path: string) => { text: string | null; refused: string | null };

export class KnownSecrets {
  private readonly files = new Map<string, { stamp: string; values: string[] }>();
  private checkedAt = Number.NEGATIVE_INFINITY;
  private pattern: RegExp | null = null;
  private all: string[] = [];

  private readonly sources: () => string[];
  private readonly read: SecretRead;
  private readonly now: () => number;
  private readonly refreshMs: number;

  constructor(sources: () => string[], read: SecretRead = readPrivateFile, now: () => number = Date.now, refreshMs = REFRESH_MS) {
    this.sources = sources;
    this.read = read;
    this.now = now;
    this.refreshMs = refreshMs;
  }

  private refresh(): void {
    if (this.now() - this.checkedAt < this.refreshMs) return;
    this.checkedAt = this.now();
    let changed = false;
    for (const path of this.sources()) {
      let stamp: string;
      try {
        const info = statSync(path);
        stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
      } catch {
        // Gone: what it held is no longer held, but a value seen once is still kept out of text.
        continue;
      }
      if (this.files.get(path)?.stamp === stamp) continue;
      let read: ReturnType<SecretRead>;
      try {
        read = this.read(path);
      } catch {
        continue;
      }
      // Refused (a locked vault, a loose mode): keep what it held, and try again when it changes.
      if (read.text === null) continue;
      this.files.set(path, { stamp, values: valuesIn(read.text) });
      changed = true;
    }
    if (!changed) return;
    this.all = [...new Set([...this.files.values()].flatMap((file) => file.values))].sort((a, b) => b.length - a.length);
    this.pattern = this.all.length ? new RegExp(this.all.map(escape).join("|"), "g") : null;
  }

  /** The values held now, longest first. */
  values(): string[] {
    this.refresh();
    return this.all;
  }

  /** The text with every held value and every secret certain by its shape replaced by [redacted]. */
  redact(text: string): string {
    this.refresh();
    const known = this.pattern ? text.replace(this.pattern, REDACTED) : text;
    return scrubTokens(known);
  }

  /** Look at the files again at the next call. */
  forget(): void {
    this.checkedAt = Number.NEGATIVE_INFINITY;
  }
}

let current: KnownSecrets | null = null;

export function knownSecrets(): KnownSecrets {
  current ??= new KnownSecrets(() => secretSources());
  return current;
}

/** For tests: the secrets the redactor looks for. */
export function useKnownSecrets(next: KnownSecrets | null): void {
  current = next;
}

/** Text with no secret value the agent holds and no secret certain by its shape. Never throws. */
export function redact(text: string): string {
  try {
    return knownSecrets().redact(text);
  } catch {
    return scrubTokens(text);
  }
}

/** A JSON-like value with every string in it redacted; numbers, booleans and anything not plain are kept. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = redactDeep(inner);
    return out as T;
  }
  return value;
}

/** An HTTP body as it is sent: an error never needs a secret, and one can carry it (a provider's reply, a command line), so every error body is redacted. */
export function sentBody(status: number, body: unknown): unknown {
  return status >= 400 ? redactDeep(body) : body;
}

let installed = false;

/**
 * The agent's console, redacted: its log lines go to the journal, where
 * they outlive any session. Each call is formatted as console would format
 * it, then redacted, so an object logged whole is covered too.
 */
export function installLogRedaction(target: Pick<Console, "log" | "info" | "warn" | "error"> = console): void {
  if (installed && target === console) return;
  if (target === console) installed = true;
  for (const method of ["log", "info", "warn", "error"] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(redact(format(...args)));
  }
}
