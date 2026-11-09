import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { STATE_DIR } from "./paths.ts";

/**
 * What Cobra did: one list of what was
 * decided without you, each with its undo. Kept in `decided.json`, 14 days.
 *
 *   plan     Instinct started a Foreman's plan: Undo stops its Workers and
 *            drops its queued tasks (their worktrees stay for Tidy).
 *   routine  Instinct wrote a routine: Undo removes it.
 *   org      Instinct moved a Foreman: Undo moves it back to where it was.
 *   trade    Instinct installed a trade: no Undo (nothing uses it until a
 *            Foreman is hired for it).
 *   merge    a PR merged on green: Undo opens GitHub's revert PR, which you
 *            merge like any other.
 *   action   an email or file sent on trust: no Undo (it is sent); the
 *            trust itself is revoked under Trust.
 *   web-run  a research run the judge allowed (webRuns.ts): Undo stops it,
 *            and its reads are judged one by one again.
 *
 * The daily caps keep a bad day small: past `DAILY_CAPS` in 24 hours, the
 * next one asks you again (notifyOrAct, merge on green).
 */

export type DecidedUndo =
  | { kind: "plan"; approval: string }
  | { kind: "routine"; project: string; name: string }
  | { kind: "org"; seat: string; company: string | null }
  | { kind: "merge"; prs: Array<{ repo: string; number: number }> }
  | { kind: "import"; project: string; worker: string; files: Array<{ to: string; sha256: string }> }
  /** A send on trust: it went, so Undo takes back the trust that sent it, and the next one asks. */
  | { kind: "trust"; key: string }
  /** A research run: Stop ends it now. */
  | { kind: "web-run"; run: string }
  | { kind: "none"; why: string };

export type Decided = {
  id: string;
  at: string;
  /** The approval's kind: plan, routine, org, trade, import, merge, action. */
  kind: string;
  title: string;
  body: string;
  /** The approval it was, when it was one. */
  approval?: string;
  /** The project's id here, for opening it. */
  project?: string;
  undo: DecidedUndo;
  /** When it was undone, and how that went. */
  undone?: string;
  undoNote?: string;
};

export const DECIDED_PATH = join(STATE_DIR, "decided.json");
const KEEP_MS = 14 * 24 * 60 * 60_000;
const MAX = 500;

/** Automatic decisions in 24 hours before Cobra asks again: merges on green, and cards she allows. */
export const DAILY_CAPS: Readonly<Record<"merge" | "cards", number>> = { merge: 10, cards: 25 };
const DAY_MS = 24 * 60 * 60_000;

export function loadDecided(path = DECIDED_PATH): Decided[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { decided?: unknown };
    return Array.isArray(raw.decided) ? (raw.decided as Decided[]).filter((entry) => typeof entry?.id === "string" && typeof entry.at === "string" && !!entry.undo) : [];
  } catch {
    return [];
  }
}

export function saveDecided(list: readonly Decided[], now = Date.now(), path = DECIDED_PATH): void {
  const kept = list.filter((entry) => now - Date.parse(entry.at) < KEEP_MS).slice(-MAX);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ decided: kept }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function recordDecided(entry: Omit<Decided, "id" | "at">, now = Date.now(), path = DECIDED_PATH): Decided {
  const kept: Decided = { id: `jd_${randomBytes(9).toString("base64url")}`, at: new Date(now).toISOString(), ...entry, title: entry.title.slice(0, 160), body: entry.body.slice(0, 1200) };
  saveDecided([...loadDecided(path), kept], now, path);
  return kept;
}

/** Which cap a kind counts toward. */
export function capOf(kind: string): "merge" | "cards" | null {
  if (kind === "merge") return "merge";
  if (kind === "plan" || kind === "routine" || kind === "org" || kind === "trade" || kind === "import") return "cards";
  return null;
}

/** Whether one more `kind` stays under its daily cap. */
export function underCap(list: readonly Decided[], kind: string, now = Date.now()): boolean {
  const cap = capOf(kind);
  if (!cap) return true;
  const today = list.filter((entry) => capOf(entry.kind) === cap && now - Date.parse(entry.at) < DAY_MS).length;
  return today < DAILY_CAPS[cap];
}

/** The words on Undo, or null when it has none. */
export function undoLabel(undo: DecidedUndo): string | null {
  if (undo.kind === "plan") return "Stop its Workers";
  if (undo.kind === "routine") return "Remove the routine";
  if (undo.kind === "org") return "Move it back";
  if (undo.kind === "merge") return undo.prs.length === 1 ? "Open a revert PR" : "Open revert PRs";
  if (undo.kind === "import") return undo.files.length === 1 ? "Delete the file" : "Delete the files";
  if (undo.kind === "trust") return "Stop trusting it";
  if (undo.kind === "web-run") return "Stop the research";
  return null;
}

/** The newest first, from the last `days`. */
export function recentDecided(list: readonly Decided[], now = Date.now(), days = 7): Decided[] {
  return list.filter((entry) => now - Date.parse(entry.at) < days * DAY_MS).sort((a, b) => b.at.localeCompare(a.at));
}

export type UndoDeps = {
  stopPlan: (approval: string) => Promise<string>;
  removeRoutine: (project: string, name: string) => Promise<string>;
  moveSeat: (seat: string, company: string | null) => Promise<string>;
  revertPr: (repo: string, number: number) => Promise<string>;
  /** Deletes each file copied into the Worker's worktree that is still as it was copied. */
  removeImported: (project: string, worker: string, files: ReadonlyArray<{ to: string; sha256: string }>) => Promise<string>;
  /** Revokes the trust grant under `key` (actionTrust.ts revokeTrust). */
  revokeTrust: (key: string) => Promise<string>;
  /** Stops a research run (webRuns.ts stopRun). */
  stopWebRun: (run: string) => Promise<string>;
};

/** The lock-screen category for a receipt of this entry (the phone's push.ts): Stop for a plan, Undo for the rest, none without one. */
export function receiptCategory(undo: DecidedUndo): "receipt-stop" | "receipt" | undefined {
  if (undo.kind === "none") return undefined;
  return undo.kind === "plan" ? "receipt-stop" : "receipt";
}

/**
 * Undoes one entry once, through `deps`, and says how it went. An entry
 * already undone, or one with no undo, is refused with why.
 */
export async function undoDecided(id: string, deps: UndoDeps, now = Date.now(), path = DECIDED_PATH): Promise<{ status: number; entry?: Decided; error?: string }> {
  const list = loadDecided(path);
  const entry = list.find((each) => each.id === id);
  if (!entry) return { status: 404, error: "nothing Cobra did has that id" };
  if (entry.undone) return { status: 409, error: `already undone: ${entry.undoNote ?? entry.undone}` };
  const undo = entry.undo;
  let note: string;
  try {
    if (undo.kind === "plan") note = await deps.stopPlan(undo.approval);
    else if (undo.kind === "routine") note = await deps.removeRoutine(undo.project, undo.name);
    else if (undo.kind === "org") note = await deps.moveSeat(undo.seat, undo.company);
    else if (undo.kind === "merge") note = (await Promise.all(undo.prs.map((pr) => deps.revertPr(pr.repo, pr.number)))).join("; ");
    else if (undo.kind === "import") note = await deps.removeImported(undo.project, undo.worker, undo.files);
    else if (undo.kind === "trust") note = await deps.revokeTrust(undo.key);
    else if (undo.kind === "web-run") note = await deps.stopWebRun(undo.run);
    else return { status: 409, error: undo.why };
  } catch (caught) {
    return { status: 502, error: caught instanceof Error ? caught.message : String(caught) };
  }
  const done: Decided = { ...entry, undone: new Date(now).toISOString(), undoNote: note.slice(0, 400) };
  saveDecided(
    loadDecided(path).map((each) => (each.id === id ? done : each)),
    now,
    path,
  );
  return { status: 200, entry: done };
}
