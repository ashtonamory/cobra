import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR } from "./paths.ts";
import { readPrivateFile } from "./private.ts";
import { readPrivateFile as readRaw } from "./privateFs.ts";
import { isSealed, SEALED_NAMES, vault, VaultError } from "./vault.ts";

/**
 * `cobra-agent vault`: the vault that seals secret files at rest (vault.ts).
 *
 *   cobra-agent vault status                  where the key is, and whether it is open
 *   cobra-agent vault init                    the key in the keychain, else a passphrase you set
 *   cobra-agent vault init --keychain-only    the keychain or nothing (install.sh; exit 3 when there is none)
 *   cobra-agent vault init --passphrase       a passphrase even where there is a keychain
 *   cobra-agent vault unlock                  type the passphrase; open until logout or restart
 *   cobra-agent vault lock                    close a passphrase vault now
 *   cobra-agent vault seal                    seal the secret files still in plain text
 */
export async function vaultCommand(args: string[], fail: (message: string) => never): Promise<void> {
  const say = (line: string) => process.stdout.write(`${line}\n`);
  const v = vault();
  try {
    switch (args[0]) {
      case "status":
      case undefined: {
        const status = v.status();
        say(`Vault: ${status.mode}. ${status.why}`);
        const plain = secretFiles().filter((path) => !isSealed(readRaw(path).text ?? ""));
        if (status.mode !== "none" && plain.length) say(`In plain text still: ${plain.join(", ")} (cobra-agent vault seal)`);
        break;
      }
      case "init": {
        const keychainOnly = args.includes("--keychain-only");
        if (v.configured()) {
          say("A vault is already set up here.");
          break;
        }
        let mode;
        if (args.includes("--passphrase")) {
          mode = v.init(await newPassphrase());
        } else {
          try {
            mode = v.init();
          } catch (error) {
            if (!(error instanceof VaultError)) throw error;
            if (keychainOnly) {
              say(`No keychain took the vault key (${error.message}). Set a passphrase with: cobra-agent vault init`);
              process.exitCode = 3;
              return;
            }
            say("No keychain here, so the vault uses a passphrase. You type it after each restart (cobra-agent vault unlock).");
            mode = v.init(await newPassphrase());
          }
        }
        say(mode === "keychain" ? "Vault made: its key is in the keychain." : "Vault made and open: its key is wrapped by your passphrase. Keep the passphrase safe; without it the secret files cannot be read.");
        sealAll(say);
        break;
      }
      case "unlock":
        v.unlock(await askHidden("Vault passphrase: "));
        say("Open until you log out or restart. The agent uses it within 30 seconds.");
        sealAll(say);
        break;
      case "lock":
        v.lock();
        say("Locked. The agent stops using secrets within 30 seconds.");
        break;
      case "seal": {
        if (!v.key()) fail(v.configured() ? "The vault is locked: run cobra-agent vault unlock first." : "There is no vault yet: run cobra-agent vault init.");
        sealAll(say);
        break;
      }
      default:
        fail("cobra-agent vault status | init [--keychain-only | --passphrase] | unlock | lock | seal");
    }
  } catch (error) {
    if (error instanceof VaultError) fail(error.message);
    throw error;
  }
}

/** The secret files here that the vault seals: in the config folder, and each account's Claude token. */
export function secretFiles(configDir = CONFIG_DIR): string[] {
  const found = [...SEALED_NAMES].map((name) => join(configDir, name)).filter((path) => existsSync(path));
  const accounts = join(configDir, "accounts");
  if (existsSync(accounts)) {
    for (const id of readdirSync(accounts)) {
      const token = join(accounts, id, "claude-token");
      if (existsSync(token)) found.push(token);
    }
  }
  return found;
}

/** Read each secret file once: a read with the vault open seals one still in plain text (private.ts). */
function sealAll(say: (line: string) => void): void {
  let sealed = 0;
  for (const path of secretFiles()) {
    const before = readRaw(path).text ?? "";
    if (isSealed(before)) continue;
    readPrivateFile(path);
    if (isSealed(readRaw(path).text ?? "")) sealed += 1;
    else say(`Not sealed: ${path} (is it yours and mode 600?)`);
  }
  if (sealed) say(`Sealed ${sealed} secret file${sealed === 1 ? "" : "s"}.`);
}

async function newPassphrase(): Promise<string> {
  for (;;) {
    const first = await askHidden("New vault passphrase (12 characters or more): ");
    if (first.length < 12) {
      process.stdout.write("Too short.\n");
      continue;
    }
    if ((await askHidden("Type it again: ")) === first) return first;
    process.stdout.write("They did not match.\n");
  }
}

/** Lines from a pipe, kept between asks: two lines can come in one chunk. */
const piped: { lines: string[]; ended: boolean; waiting: Array<(line: string) => void>; started: boolean } = { lines: [], ended: false, waiting: [], started: false };

function nextPipedLine(): Promise<string> {
  const input = process.stdin;
  if (!piped.started) {
    piped.started = true;
    let rest = "";
    input.setEncoding("utf8");
    const give = () => {
      while (piped.waiting.length && (piped.lines.length || piped.ended)) piped.waiting.shift()!(piped.lines.shift() ?? "");
    };
    input.on("data", (chunk: string) => {
      rest += chunk;
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? "";
      piped.lines.push(...parts);
      give();
    });
    input.on("end", () => {
      if (rest) piped.lines.push(rest);
      piped.ended = true;
      give();
    });
  }
  if (piped.lines.length || piped.ended) return Promise.resolve(piped.lines.shift() ?? "");
  return new Promise((resolve) => piped.waiting.push(resolve));
}

/** One line from the terminal without showing it; from a pipe, the next line. */
export function askHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) return nextPipedLine();
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let text = "";
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    const done = () => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          done();
          resolve(text);
          return;
        }
        if (char === "\u0003") {
          done();
          reject(new VaultError("stopped"));
          return;
        }
        if (char === "\u007f" || char === "\b") text = text.slice(0, -1);
        else if (char >= " ") text += char;
      }
    };
    input.on("data", onData);
  });
}
