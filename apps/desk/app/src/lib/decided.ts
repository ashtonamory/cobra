/**
 * What Cobra did: what Instinct decided
 * without you, on every computer, with its Undo, and Pause, which turns Instinct back to Balanced
 * everywhere it is set. A port of the phone's `src/decidedRules.ts`; the GTK desk's
 * `cobradesk/decided.py` says the same: change all three together.
 */
import * as api from "./api.ts";
import * as config from "./config.ts";
import { isDict, type Dict, type Json } from "./json.ts";
import * as permissions from "./permissions.ts";
import { LEAD_NAME } from "./appName.ts";

export const DECIDED_TITLE = `What ${LEAD_NAME} did`;
export const DECIDED_EMPTY = "Nothing decided without you this week.";
export const PAUSE_LABEL = "Pause Instinct";
export const PAUSED_WORDS = "Instinct is paused: Balanced asks you again. Turn it back on in Settings → Permissions.";
/** At most this many rows on Home; the rest are counted. */
export const DECIDED_SHOWN = 8;

export interface DecidedRow {
  id: string;
  at: string;
  kind: string;
  title: string;
  body: string;
  machine: string;
  project?: string;
  undoLabel: string | null;
  noUndo?: string;
  undone?: string;
  undoNote?: string;
  /** HH:MM today, else the weekday and time. */
  time: string;
  undoable: boolean;
  /** A research run's id (kind web-run), and the run in words when its computer said. */
  run?: string;
  research?: Research;
}

/** One search or page of a research run, in words. */
export interface ResearchRead { word: string; subject: string; why: string; tone: "ok" | "dim" | "warn" }
/** A research receipt's run: how far it got, and each read with what Cobra made of it. */
export interface Research { line: string; live: boolean; reads: ResearchRead[] }

const READ_WORDS: Record<string, { word: string; tone: ResearchRead["tone"] }> = {
  on: { word: "Read", tone: "ok" },
  off: { word: "Judged alone", tone: "dim" },
  refuse: { word: "Kept out", tone: "warn" },
  ask: { word: "Asked you", tone: "warn" },
};

function readSubject(tool: string, subject: string): string {
  const text = tool === "WebSearch" ? `"${subject}"` : subject.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

const num = (value: unknown): number => (typeof value === "number" ? value : 0);

/** A run (GET /web/runs) in words: "12 of 60 reads · until 15:40" while it runs, else how it ended; its reads newest first. */
export function researchOf(run: Dict, now: number = Date.now()): Research {
  const used = `${num(run.reads)} of ${num(run.maxReads)} reads`;
  const ends = typeof run.endsAt === "string" ? Date.parse(run.endsAt) : Number.NaN;
  const live = run.state === "running" && num(run.reads) < num(run.maxReads) && !(ends <= now);
  const clock = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const line = live
    ? `${used}${Number.isFinite(ends) ? ` · until ${clock(new Date(ends))}` : ""}`
    : run.state === "stopped"
      ? `Stopped${run.stoppedBy === "new-run" ? " for a newer run" : ""} · ${used}`
      : run.state === "refused" || run.state === "denied"
        ? `Not started: ${str(run.reason)}`
        : `Ended · ${used}`;
  const log = (Array.isArray(run.log) ? run.log : []).filter(isDict);
  const reads = [...log]
    .sort((a, b) => str(b.at).localeCompare(str(a.at)))
    .map((read) => {
      // A page Cobra found was not what its address claims (agent webClaims.ts), with why.
      if (str(read.claim)) return { word: "Not what it claims", subject: readSubject(str(read.tool), str(read.subject)), why: str(read.claim), tone: "warn" as const };
      const words = READ_WORDS[str(read.verdict)] ?? { word: str(read.verdict), tone: "dim" as const };
      return { word: read.tool === "WebSearch" && read.verdict === "on" ? "Searched" : words.word, subject: readSubject(str(read.tool), str(read.subject)), why: str(read.reason), tone: words.tone };
    });
  return { line, live, reads };
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const pad = (n: number) => String(n).padStart(2, "0");

function timeOf(at: Date, now: number): string {
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (at.toDateString() === new Date(now).toDateString()) return clock;
  return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${clock}`;
}

/**
 * Every computer's entries (GET /decided), newest first. A send on trust is left out: Landed
 * already shows it, with its own way to revoke the trust.
 */
export function decidedRows(lists: ReadonlyArray<readonly [string, Json] | readonly [string, Json, Json]>, now: number = Date.now()): DecidedRow[] {
  const out: DecidedRow[] = [];
  for (const [machine, list, runsReply] of lists) {
    const runs = isDict(runsReply) && Array.isArray(runsReply.runs) ? runsReply.runs.filter(isDict) : [];
    const entries = isDict(list) && Array.isArray(list.decided) ? list.decided : [];
    for (const entry of entries) {
      if (!isDict(entry) || typeof entry.id !== "string" || typeof entry.at !== "string") continue;
      if (entry.kind === "action") continue;
      const undoLabel = typeof entry.undoLabel === "string" && entry.undoLabel ? entry.undoLabel : null;
      const run = typeof entry.run === "string" ? runs.find((candidate) => candidate.id === entry.run) : undefined;
      const research = run ? researchOf(run, now) : undefined;
      out.push({
        id: entry.id,
        at: entry.at,
        kind: str(entry.kind),
        title: str(entry.title),
        body: str(entry.body),
        machine,
        ...(typeof entry.project === "string" ? { project: entry.project } : {}),
        undoLabel,
        ...(typeof entry.noUndo === "string" ? { noUndo: entry.noUndo } : {}),
        ...(typeof entry.undone === "string" ? { undone: entry.undone } : {}),
        ...(typeof entry.undoNote === "string" ? { undoNote: entry.undoNote } : {}),
        time: timeOf(new Date(entry.at), now),
        undoable: !!undoLabel && typeof entry.undone !== "string" && research?.live !== false,
        ...(typeof entry.run === "string" ? { run: entry.run } : {}),
        ...(research ? { research } : {}),
      });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** The line under a row's title: how its Undo went, or its body's first line. */
export function decidedDetail(row: Pick<DecidedRow, "undone" | "undoNote" | "body">): string {
  if (row.undone) return `Undone: ${row.undoNote ?? "done"}`;
  return (row.body.split("\n").find((line) => line.trim()) ?? "").trim();
}

/** What an Undo does, said before its second press. */
export function undoQuestion(row: Pick<DecidedRow, "kind">): string {
  if (row.kind === "merge") return "GitHub opens a PR that reverts it. You merge that one yourself.";
  if (row.kind === "plan") return "Its Workers stop and its queued tasks are dropped. Their worktrees stay for Tidy.";
  if (row.kind === "routine") return "The routine is removed and will not run again.";
  if (row.kind === "org") return "The Foreman moves back to where it was.";
  if (row.kind === "web-run") return "Its next searches and page reads ask again, one by one, as before the run.";
  return `${LEAD_NAME} undoes it.`;
}

/** "3 of 10 merges · 5 of 25 cards", added up from the computers that said. */
export function capsLine(lists: ReadonlyArray<Json>): string | null {
  const add = (key: "merge" | "cards") => {
    const found: Array<{ used: number; cap: number }> = [];
    for (const list of lists) {
      const cap = isDict(list) && isDict(list.caps) ? list.caps[key] : undefined;
      if (isDict(cap) && typeof cap.used === "number" && typeof cap.cap === "number") found.push({ used: cap.used, cap: cap.cap });
    }
    if (!found.length) return null;
    return { used: found.reduce((sum, cap) => sum + cap.used, 0), cap: found[0]!.cap };
  };
  const merge = add("merge");
  const cards = add("cards");
  if (!merge && !cards) return null;
  const parts = [merge ? `${merge.used} of ${merge.cap} merges` : null, cards ? `${cards.used} of ${cards.cap} cards` : null].filter(Boolean);
  return `Daily caps, per computer: ${parts.join(" · ")} in the last day`;
}

const isInstinct = (level: unknown) => isDict(level) && level.preset === "instinct";

/** Whether Instinct is set anywhere in the fleet's policy: the fleet, a computer or a project. */
export function instinctAnywhere(policy: Json | null | undefined): boolean {
  if (!isDict(policy)) return false;
  const levels = (key: string) => (isDict(policy[key]) ? Object.values(policy[key] as Dict) : []);
  return isInstinct(policy) || levels("computers").some(isInstinct) || levels("projects").some(isInstinct);
}

/** Pause: every level set to Instinct becomes Balanced, nothing else changes. It grants nothing. */
export function pausedPolicy(policy: Dict): Dict {
  const calm = (level: Dict): Dict => (isInstinct(level) ? { ...level, preset: "balanced" } : level);
  const each = (levels: Dict) => Object.fromEntries(Object.entries(levels).map(([key, level]) => [key, isDict(level) ? calm(level) : level]));
  const next: Dict = { ...calm(policy) };
  if (isDict(policy.computers)) next.computers = each(policy.computers);
  if (isDict(policy.projects)) next.projects = each(policy.projects);
  return next;
}

/** Every computer's policy read, by machine; one that does not answer is left out. */
export async function policyReads(): Promise<Record<string, Dict>> {
  const reads: Record<string, Dict> = {};
  await Promise.all(config.MACHINES.map(async (m) => {
    try {
      const reply = await api.policy(m.machine);
      if (isDict(reply)) reads[m.machine] = reply;
    } catch {
      // Not answering: left behind, and Settings → Permissions offers Bring up to date.
    }
  }));
  return reads;
}

/** Whether the newest policy the fleet gave sets Instinct anywhere. */
export async function readInstinct(): Promise<boolean> {
  const found = permissions.newest(await policyReads());
  return found ? instinctAnywhere(found[1].policy) : false;
}

/**
 * Pause Instinct on the fleet's policy, as Settings → Permissions writes it: the newest revision
 * plus one, to every computer that answered. It grants nothing, so it goes unconfirmed (an agent
 * would refuse it 428 otherwise). Returns the toast's words.
 */
export async function pauseFleet(): Promise<string> {
  const reads = await policyReads();
  const found = permissions.newest(reads);
  if (!found) return "Not paused: no computer answered with a policy";
  const policy = { ...pausedPolicy(found[1].policy as Dict), revision: permissions.nextRevision(reads) };
  const missed: string[] = [];
  for (const m of config.MACHINES) {
    if (!reads[m.machine]) {
      missed.push(config.label(m.machine));
      continue;
    }
    try {
      await api.policyWrite(m.machine, policy, false);
    } catch {
      missed.push(config.label(m.machine));
    }
  }
  return missed.length ? `Paused, but not reached: ${missed.join(", ")}. Settings → Permissions brings them up to date.` : `Instinct paused. ${PAUSED_WORDS}`;
}
