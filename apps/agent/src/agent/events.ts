import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { FleetEvent } from "@cobra/contracts";

import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { redactDeep } from "./secretValues.ts";

/**
 * A week of what happened here (needs you, finished, unpushed, diverged, a
 * PR gone green): the same moments the watcher pushes, kept so the phone's
 * daily brief can say what happened overnight. Recorded whether or not any
 * phone wants pushes; one JSON line each, pruned to a week.
 */
export const EVENTS_PATH = join(STATE_DIR, "events.jsonl");
const KEEP_MS = 7 * 24 * 60 * 60_000;
const MAX_LINES = 2000;

export type NewEvent = { kind: string; projectId: string; projectName: string; detail?: string };

export function recordEvents(events: readonly NewEvent[], now = Date.now(), path = EVENTS_PATH): void {
  if (events.length === 0) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const at = new Date(now).toISOString();
  appendFileSync(path, events.map((event) => `${JSON.stringify(redactDeep({ at, ...event }))}\n`).join(""), { mode: 0o600 });
  prune(now, path);
}

function parse(path: string): FleetEvent[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const events: FleetEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as FleetEvent;
      if (typeof event.at === "string" && typeof event.kind === "string" && typeof event.projectId === "string") events.push(event);
    } catch {
      // A torn last line from a crash: skipped.
    }
  }
  return events;
}

function prune(now: number, path: string): void {
  const events = parse(path);
  const kept = events.filter((event) => now - Date.parse(event.at) <= KEEP_MS).slice(-MAX_LINES);
  if (kept.length === events.length) return;
  writePrivateFile(path, kept.map((event) => `${JSON.stringify(event)}\n`).join(""));
}

/** Events at or after `since`, oldest first, at most 200. */
export function readEvents(since: number, path = EVENTS_PATH): FleetEvent[] {
  return parse(path)
    .filter((event) => Date.parse(event.at) >= since)
    .slice(-200);
}
