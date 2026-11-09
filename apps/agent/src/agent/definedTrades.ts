import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR, STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { compileSchema, migrationFor, type InstalledTrade, type TradeDefinition } from "./tradeDefine.ts";
import type { TradeSchema } from "./dbTypes.ts";

/**
 * Where the trades Cobra defined live (tradeDefine.ts has the rules):
 * `~/.config/cobra-agent/trades/<id>/trade.json` (the definition and every
 * migration its database took) and `templates/<name>/index.html` beside it,
 * read by render.ts as a shipped trade's templates are. A definition waiting
 * for the person's Allow is kept whole in the state folder under its approval
 * (`trade-proposals/<approval id>.json`), since a card holds only its words
 * and hash; Allow installs that file only if its hash is the card's.
 */

export const DEFINED_DIR = join(CONFIG_DIR, "trades");
export const PROPOSALS_DIR = join(STATE_DIR, "trade-proposals");

const ID = /^[a-z][a-z0-9-]{1,39}$/;

type Cached = { mtimeMs: number; installed: InstalledTrade; schema: TradeSchema | null };
const cache = new Map<string, Cached>();

function tradeFile(id: string, dir: string): string {
  return join(dir, id, "trade.json");
}

/** An installed defined trade, or null for none (or a file that does not read: logged by the caller's absence of it). */
export function loadDefined(id: string | undefined, dir = DEFINED_DIR): InstalledTrade | null {
  return id && ID.test(id) ? (cached(id, dir)?.installed ?? null) : null;
}

/** The database schema a defined trade's database runs, or null. */
export function definedSchema(id: string | undefined, dir = DEFINED_DIR): TradeSchema | null {
  return id && ID.test(id) ? (cached(id, dir)?.schema ?? null) : null;
}

function cached(id: string, dir: string): Cached | null {
  const path = tradeFile(id, dir);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    cache.delete(`${dir}\0${id}`);
    return null;
  }
  const key = `${dir}\0${id}`;
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  try {
    const installed = JSON.parse(readFileSync(path, "utf8")) as InstalledTrade;
    if (installed?.definition?.id !== id || !Array.isArray(installed.migrations)) return null;
    const entry = { mtimeMs, installed, schema: compileSchema(installed) };
    cache.set(key, entry);
    return entry;
  } catch {
    return null;
  }
}

/** Every defined trade installed here, by id. */
export function listDefined(dir = DEFINED_DIR): InstalledTrade[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .sort()
    .map((name) => loadDefined(name, dir))
    .filter((trade): trade is InstalledTrade => trade !== null);
}

/** The folder a defined trade's templates are in, or null for one not installed here. */
export function definedTemplatesDir(id: string | undefined, dir = DEFINED_DIR): string | null {
  return loadDefined(id, dir) ? join(dir, id!, "templates") : null;
}

/**
 * Writes a definition the person allowed: its migration appended when its
 * tables changed, its templates replaced (a template it no longer has is
 * removed), and trade.json last, so a reader sees the old trade or the new.
 */
export function installDefinition(definition: TradeDefinition, now: Date, dir = DEFINED_DIR): InstalledTrade {
  const was = loadDefined(definition.id, dir);
  const step = migrationFor(was?.definition, definition);
  const installed: InstalledTrade = {
    definition,
    migrations: [...(was?.migrations ?? []), ...(step ? [step] : [])],
    installedAt: now.toISOString(),
    revision: (was?.revision ?? 0) + 1,
  };
  const root = join(dir, definition.id);
  const templates = join(root, "templates");
  mkdirSync(templates, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(templates)) {
    if (!Object.hasOwn(definition.templates, name)) rmSync(join(templates, name), { recursive: true, force: true });
  }
  for (const [name, template] of Object.entries(definition.templates)) {
    mkdirSync(join(templates, name), { recursive: true, mode: 0o700 });
    writePrivateFile(join(templates, name, "index.html"), template.html);
    if (template.sample) writePrivateFile(join(templates, name, "sample.json"), `${JSON.stringify(template.sample, null, 2)}\n`);
    else rmSync(join(templates, name, "sample.json"), { force: true });
  }
  writePrivateFile(tradeFile(definition.id, dir), `${JSON.stringify(installed, null, 2)}\n`);
  return installed;
}

/** Keeps a definition waiting for the person's answer to its card. */
export function keepProposal(approvalId: string, definition: TradeDefinition, dir = PROPOSALS_DIR): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateFile(join(dir, `${approvalId}.json`), JSON.stringify(definition));
}

/** The definition a card is for, or null when it is gone; removed once read. */
export function takeProposal(approvalId: string, dir = PROPOSALS_DIR): TradeDefinition | null {
  if (!/^ap_[A-Za-z0-9_-]+$/.test(approvalId)) return null;
  const path = join(dir, `${approvalId}.json`);
  try {
    const definition = JSON.parse(readFileSync(path, "utf8")) as TradeDefinition;
    rmSync(path, { force: true });
    return definition;
  } catch {
    return null;
  }
}
