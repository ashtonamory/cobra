import { readFileSync } from "node:fs";
import { join } from "node:path";

import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import type { RenderResult } from "./renderTypes.ts";

/**
 * What the agent rendered: each file report_render wrote, by the sha256 of its
 * bytes, with the project and the template it came from and the sha256 of that
 * template's source. Trust (actionTrust.ts) reads it to know what an attachment is:
 * a pay stub from the shipped template, the same template as last time, or a
 * file the agent never made, which always asks.
 *
 * Kept in `~/.local/state/cobra-agent/renders.json` (0600), the newest
 * RENDERS_KEPT. Hashes and template names only: no path, no value from the
 * database.
 */

export const RENDERS_PATH = join(STATE_DIR, "renders.json");
export const RENDERS_KEPT = 2000;

export type RenderEntry = {
  project: string;
  template: string;
  templateSha: string;
  at: string;
};

type RendersFile = { files: Record<string, RenderEntry> };

export function loadRenders(path = RENDERS_PATH): Record<string, RenderEntry> {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RendersFile>;
    return raw.files && typeof raw.files === "object" ? raw.files : {};
  } catch {
    return {};
  }
}

/** Notes every file of one render, dropping the oldest past RENDERS_KEPT. Never throws: a render that could not be noted only asks again. */
export function recordRenders(project: string, result: Pick<RenderResult, "files" | "template">, now: number = Date.now(), path = RENDERS_PATH): void {
  try {
    const files = loadRenders(path);
    const at = new Date(now).toISOString();
    for (const file of result.files) {
      delete files[file.sha256];
      files[file.sha256] = { project, template: result.template.name, templateSha: result.template.sha256, at };
    }
    const keys = Object.keys(files);
    for (const key of keys.slice(0, Math.max(0, keys.length - RENDERS_KEPT))) delete files[key];
    writePrivateFile(path, `${JSON.stringify({ files })}\n`);
  } catch {
    // Trust is the only reader, and it fails closed.
  }
}

/** The render a file came from, by the sha256 of its bytes, in this project only. */
export function renderOf(files: Record<string, RenderEntry>, project: string, sha256: string): RenderEntry | undefined {
  const entry = files[sha256];
  return entry && entry.project === project ? entry : undefined;
}
