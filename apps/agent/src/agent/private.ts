import { basename } from "node:path";

import {
  createPrivateFileOnce as createRawOnce,
  readPrivateFile as readRaw,
  writePrivateFile as writeRaw,
  type PrivateRead,
} from "./privateFs.ts";
import { audit } from "./auditTrail.ts";
import { isSealed, isSealedName, seal, unseal, vault } from "./vault.ts";

export { privateRefusal, removePrivateFile, type PrivateRead } from "./privateFs.ts";

/**
 * Files only this account may read or change, with the vault on top
 * (vault.ts): a secret file (SEALED_NAMES) is sealed when it is written and
 * opened when it is read, so every caller keeps reading and writing plain
 * text. Other private files are as privateFs.ts keeps them.
 *
 * A refusal is not the same as an absence. Missing means "not set up yet";
 * refused means "a file is there and something is wrong with it", and the two
 * must not collapse into each other: a refusal is a misconfiguration someone
 * needs to see, not a state to carry on in. A sealed file while the vault is
 * locked is a refusal, never an empty file.
 */
export function readPrivateFile(path: string): PrivateRead {
  const read = readRaw(path);
  if (read.text === null || read.refused) return read;
  const name = basename(path);
  if (isSealed(read.text)) {
    const key = vault().key();
    if (!key) return { text: null, refused: "the vault is locked: run cobra-agent vault unlock (or unlock the keychain)" };
    const text = unseal(key, name, read.text);
    return text === null ? { text: null, refused: "it does not open with this vault's key" } : { text, refused: null };
  }
  // A secret file from before the vault: read as it is, and sealed now if the vault is open.
  if (isSealedName(path)) {
    const key = vault().key();
    if (key) {
      try {
        writeRaw(path, seal(key, name, read.text));
        audit("vault.sealed", { actor: "agent", subject: { target: name } });
      } catch {
        // Sealing waits for the next read; the text is still good.
      }
    }
  }
  return read;
}

/** The text to write: sealed for a secret file when there is a vault. A locked vault refuses the write rather than leave a secret in plain text. */
function toWrite(path: string, text: string): string {
  if (!isSealedName(path)) return text;
  const v = vault();
  const key = v.key();
  if (key) return seal(key, basename(path), text);
  if (v.configured()) throw new Error(`the vault is locked, so ${basename(path)} was not saved: run cobra-agent vault unlock (or unlock the keychain)`);
  return text;
}

/** Replace the file in one step: a reader sees the old text or the new, never half. */
export function writePrivateFile(path: string, text: string): void {
  writeRaw(path, toWrite(path, text));
}

/**
 * Create the file only if it is absent, whole, in one step. Two processes may
 * race here (the agent and the terminal gateway both want the ticket key at
 * start); exactly one wins and the other reads the winner's file. Returns
 * whether this call created it.
 */
export function createPrivateFileOnce(path: string, text: string): boolean {
  return createRawOnce(path, toWrite(path, text));
}
