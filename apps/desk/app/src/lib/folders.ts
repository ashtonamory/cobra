/**
 * Settings → Projects: where each computer looks for projects (the agent's folders.ts,
 * `GET`/`POST /settings/folders`), in words. Pure, so it is tested without a window.
 */
import { APP_NAME } from "./appName.ts";
import type { Dict } from "./json.ts";

export const BLURB = `The folders ${APP_NAME} looks in for your repositories, offered under New project → ` +
  "On this computer, and where a new one may be made. A folder of repositories two levels down is looked into too.";

/** A path as the person reads it: ~/… inside that computer's home. */
export function shown(path: string, home: string): string {
  if (!home) return path;
  const base = home.replace(/\/+$/, "");
  if (path === base) return "~";
  return path.startsWith(`${base}/`) ? `~/${path.slice(base.length + 1)}` : path;
}

export interface FolderRow {
  path: string;
  title: string;
  /** Added in Settings, so Remove may take it away; the rest are the computer's own. */
  added: boolean;
  word: string;
}

/** Every folder looked in, its own first, then the added ones, as rows. */
export function rows(view: Dict | null | undefined): FolderRow[] {
  const roots = Array.isArray(view?.roots) ? (view!.roots as unknown[]).filter((r): r is string => typeof r === "string") : [];
  const added = new Set(Array.isArray(view?.added) ? (view!.added as unknown[]).filter((r): r is string => typeof r === "string") : []);
  const home = typeof view?.home === "string" ? view.home : "";
  return roots.map((path) => ({ path, title: shown(path, home), added: added.has(path), word: added.has(path) ? "added" : "built in" }));
}

/** What the box takes: a whole path, /… or ~/…; null when it is one, else why not. */
export function problem(typed: string): string | null {
  const t = typed.trim();
  if (!t) return "Type the folder's path.";
  if (!(t === "~" || t.startsWith("~/") || t.startsWith("/"))) return "Give the whole path: /… or ~/….";
  return null;
}

/** Why a computer gave no list: an agent from before this setting answers 404. */
export function failureLine(status: number, message: string, computer: string): string {
  if (status === 404) return `${computer}'s ${APP_NAME} is older than this setting: update it there to add folders.`;
  if (status === 0) return `${computer} did not answer: ${message}`;
  return message;
}
