import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

import type { ApprovalImport, ImportFile } from "@cobra/contracts";

import { isSecret, underHome } from "./credentials.ts";

/**
 * worker_import (Foreman, POST /orch/worker/import {id, files: [{from, to}]}):
 * the sanctioned way to give a Worker a file from outside its worktree (a
 * logo, a font, a shipped template), which its sandbox cannot read. The
 * Foreman names each file and where it goes in the Worker's worktree; the
 * person allows the copy on a card (kind `import`) that lists every path,
 * size and hash; Allow copies exactly those bytes, never over a file that is
 * there, and the Foreman is told. Nothing is copied that the phone's file
 * browser would not serve: a credential, the agent's own folders or any
 * file under home whose name says it holds a secret.
 */

export const MAX_IMPORT_FILES = 10;
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORT_TOTAL = 50 * 1024 * 1024;

export class ImportError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type ImportDeps = {
  home: string;
  /** Folders outside home, or under the agent's own, that files may come from: the shipped and defined trades' templates. */
  sources: readonly string[];
  realpath: (path: string) => Promise<string>;
  /** Size and kind of a path, following links; null when it is not there. */
  stat: (path: string) => Promise<{ file: boolean; size: number } | null>;
  /** Whether anything (a link too) is at the path. */
  exists: (path: string) => Promise<boolean>;
  read: (path: string) => Promise<Buffer>;
  mkdir: (path: string) => Promise<void>;
  /** Copies, refusing when the target is there. */
  copy: (from: string, to: string) => Promise<void>;
};

export function liveImportDeps(sources: readonly string[]): ImportDeps {
  return {
    home: os.homedir(),
    sources,
    realpath: (path) => realpath(path),
    async stat(path) {
      try {
        const found = await stat(path);
        return { file: found.isFile(), size: found.size };
      } catch {
        return null;
      }
    },
    async exists(path) {
      try {
        await lstat(path);
        return true;
      } catch {
        return false;
      }
    },
    read: (path) => readFile(path),
    mkdir: async (path) => void (await mkdir(path, { recursive: true })),
    copy: (from, to) => copyFile(from, to, constants.COPYFILE_EXCL),
  };
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Where a file may come from: one of the listed sources, else under home and not a secret. */
async function checkSource(deps: ImportDeps, asked: string, worktree: string): Promise<{ real: string; size: number }> {
  if (!isAbsolute(asked)) throw new ImportError(`${asked}: from is an absolute path`);
  let real: string;
  try {
    real = await deps.realpath(asked);
  } catch {
    throw new ImportError(`${asked} is not there`, 404);
  }
  const found = await deps.stat(real);
  if (!found?.file) throw new ImportError(`${asked} is not a file`);
  if (found.size > MAX_IMPORT_BYTES) throw new ImportError(`${asked} is over ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
  if (inside(worktree, real)) throw new ImportError(`${asked} is in the Worker's worktree already`);
  if (real.split(sep).includes(".git")) throw new ImportError(`${asked} is inside a .git folder`);
  const listed = deps.sources.some((source) => inside(source, real));
  if (!listed) {
    const rel = underHome(deps.home, real);
    if (rel === null) throw new ImportError(`${asked} is outside your home folder`);
    if (isSecret(rel)) throw new ImportError(`${asked} is a credential or one of the agent's own files, which a Worker never gets`, 403);
  }
  return { real, size: found.size };
}

/** Where it goes: a new path inside the worktree, through no link, never into .git. */
async function checkTarget(deps: ImportDeps, asked: string, worktree: string): Promise<string> {
  if (typeof asked !== "string" || asked.trim() === "") throw new ImportError("to is a path inside the Worker's worktree");
  if (isAbsolute(asked)) throw new ImportError(`${asked}: to is relative to the Worker's worktree`);
  const clean = normalize(asked);
  const parts = clean.split(sep);
  if (parts.includes("..")) throw new ImportError(`${asked}: to stays inside the worktree`);
  if (parts.some((part) => part.toLowerCase() === ".git")) throw new ImportError(`${asked}: never into .git`);
  const target = join(worktree, clean);
  if (await deps.exists(target)) throw new ImportError(`${asked} is there already in the Worker's worktree; choose a new path`, 409);
  // The deepest folder that is there must still be the worktree's own, not a link out of it.
  let folder = dirname(target);
  while (!(await deps.exists(folder)) && inside(worktree, dirname(folder)) && folder !== worktree) folder = dirname(folder);
  const real = await deps.realpath(folder).catch(() => folder);
  const realTree = await deps.realpath(worktree).catch(() => worktree);
  if (!inside(realTree, real)) throw new ImportError(`${asked}: a folder on the way leads out of the worktree`, 403);
  return clean;
}

/** The card's contents: each file checked, sized and hashed as it is now. */
export async function planImport(deps: ImportDeps, project: string, worker: { id: string; path: string }, files: unknown): Promise<ApprovalImport> {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_IMPORT_FILES) {
    throw new ImportError(`files is a list of 1 to ${MAX_IMPORT_FILES} {from, to}`);
  }
  const planned: ImportFile[] = [];
  let total = 0;
  for (const entry of files as Array<{ from?: unknown; to?: unknown }>) {
    if (typeof entry?.from !== "string" || typeof entry.to !== "string") throw new ImportError("each file is {from, to}");
    const source = await checkSource(deps, entry.from, worker.path);
    const to = await checkTarget(deps, entry.to, worker.path);
    if (planned.some((file) => file.to === to)) throw new ImportError(`${to} is named twice`);
    total += source.size;
    if (total > MAX_IMPORT_TOTAL) throw new ImportError(`the files come to over ${MAX_IMPORT_TOTAL / 1024 / 1024} MB`);
    planned.push({ from: source.real, to, bytes: source.size, sha256: sha256(await deps.read(source.real)) });
  }
  return { project, worker: worker.id, files: planned };
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function importText(plan: ApprovalImport, projectName: string): { title: string; body: string } {
  const count = plan.files.length === 1 ? "a file" : `${plan.files.length} files`;
  return {
    title: `Copy ${count} into ${projectName}?`,
    body: [
      `Cobra asks to use these in ${projectName}'s work, which its sandbox cannot read itself:`,
      ...plan.files.map((file) => `${file.from} → ${file.to} (${size(file.bytes)})`),
      "Allow copies exactly these files into the work's folder; nothing there is replaced.",
    ].join("\n"),
  };
}

/** Allow: copies each file whose bytes are still the ones on the card. One line per file. */
export async function runImport(deps: ImportDeps, plan: ApprovalImport, worktree: string): Promise<Array<{ ok: boolean; message: string }>> {
  const results: Array<{ ok: boolean; message: string }> = [];
  for (const file of plan.files) {
    try {
      const source = await checkSource(deps, file.from, worktree);
      if (source.real !== file.from) throw new ImportError("it now leads somewhere else");
      const bytes = await deps.read(source.real);
      if (sha256(bytes) !== file.sha256) throw new ImportError("it changed since you were asked");
      const to = await checkTarget(deps, file.to, worktree);
      await deps.mkdir(dirname(join(worktree, to)));
      await deps.copy(source.real, join(worktree, to));
      results.push({ ok: true, message: `${file.to}: copied` });
    } catch (caught) {
      results.push({ ok: false, message: `${file.to}: not copied, ${caught instanceof Error ? caught.message : String(caught)}` });
    }
  }
  return results;
}

/**
 * Undo (What Cobra did): deletes each copied file that is still the one
 * copied, at its own path in the worktree and through no link. A file the
 * Worker has changed since is kept, and the line says so.
 */
export async function removeImports(
  deps: Pick<ImportDeps, "realpath" | "read">,
  remove: (path: string) => Promise<void>,
  files: ReadonlyArray<{ to: string; sha256: string }>,
  worktree: string,
): Promise<Array<{ ok: boolean; message: string }>> {
  const realTree = await deps.realpath(worktree).catch(() => worktree);
  const results: Array<{ ok: boolean; message: string }> = [];
  for (const file of files) {
    try {
      const clean = normalize(file.to);
      if (isAbsolute(clean) || clean.split(sep).includes("..")) throw new ImportError("it is not a path inside the worktree");
      const own = join(realTree, clean);
      let real: string;
      try {
        real = await deps.realpath(join(worktree, clean));
      } catch {
        results.push({ ok: true, message: `${file.to}: gone already` });
        continue;
      }
      if (real !== own) throw new ImportError("it is a link now");
      if (sha256(await deps.read(real)) !== file.sha256) throw new ImportError("the Worker changed it, so it was kept");
      await remove(real);
      results.push({ ok: true, message: `${file.to}: deleted` });
    } catch (caught) {
      results.push({ ok: false, message: `${file.to}: not deleted, ${caught instanceof Error ? caught.message : String(caught)}` });
    }
  }
  return results;
}

/** The [cobra] line its Foreman gets. */
export function importNews(approvalId: string, plan: ApprovalImport, allowed: boolean, results: ReadonlyArray<{ ok: boolean; message: string }> = []): string {
  if (!allowed) return `[cobra] The person did not allow copying files into Worker ${plan.worker} (approval ${approvalId}). Work without them, or ask the person.`;
  const copied = results.filter((result) => result.ok).length;
  return `[cobra] Files for Worker ${plan.worker} (approval ${approvalId}): ${results.map((result) => result.message).join("; ")}.${copied ? ` worker_send ${plan.worker} where to find them.` : ""}`;
}

/** Files a Worker reads only as pictures or fonts: copying these in brings no words to it. SVG is text, so it is not one. */
const NOT_TEXT = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot)$/i;

/** Whether an import brings text from outside into the Worker (taint.ts "file"): any file that is not a picture or a font. */
export function importsText(plan: Pick<ApprovalImport, "files">): boolean {
  return plan.files.some((file) => !NOT_TEXT.test(file.to));
}
