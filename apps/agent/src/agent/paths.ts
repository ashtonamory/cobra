import { mkdtempSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative } from "node:path";

/**
 * Where the agent keeps its files, in the user's own XDG folders.
 *
 *   config  token, projects.json, projects.local.json, exposure.json,
 *           files.json, push-tokens.json   (mode 600 files, 700 folder)
 *   state   history.db
 *   data    file uploads and the delivery queue
 */
function xdg(variable: string, fallback: string[]): string {
  const value = process.env[variable];
  return value && value.startsWith("/") ? value : join(homedir(), ...fallback);
}

let testHome: string | undefined;

/**
 * Under `node --test` (NODE_TEST_CONTEXT is set in every test file's process),
 * a default folder inside the person's real home becomes the same path inside
 * a scratch folder of this process's own. A test that forgets its
 * COBRA_AGENT_*_DIR then reads and writes nothing live: on 2026-11-03 one
 * that did (morning.test.ts) ran a branch's store migrations on the live
 * Spaces, and the installed agent refused them. A folder a test names itself
 * is used as named.
 */
export function awayFromLive(dir: string): string {
  if (process.env.NODE_TEST_CONTEXT === undefined) return dir;
  const home = userInfo().homedir;
  if (dir !== home && !dir.startsWith(`${home}/`)) return dir;
  testHome ??= mkdtempSync(join(tmpdir(), "cobra-test-home-"));
  return join(testHome, relative(home, dir));
}

export const CONFIG_DIR = process.env.COBRA_AGENT_CONFIG_DIR ?? awayFromLive(join(xdg("XDG_CONFIG_HOME", [".config"]), "cobra-agent"));
export const STATE_DIR = process.env.COBRA_AGENT_STATE_DIR ?? awayFromLive(join(xdg("XDG_STATE_HOME", [".local", "state"]), "cobra-agent"));
export const DATA_DIR = process.env.COBRA_AGENT_DATA_DIR ?? awayFromLive(join(xdg("XDG_DATA_HOME", [".local", "share"]), "cobra-agent"));

/** Where files sent from the phone land on this machine. */
export const DROP_DIR = process.env.COBRA_DROP_DIR ?? join(homedir(), "Downloads", "Cobra");
