import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SystemStats } from "@cobra/contracts";

import type { UnitState } from "./collect/units.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import type { PushMessage } from "./push.ts";

/**
 * Machine-health alerting, on the same "each agent watches itself" principle as
 * the session watcher: no machine polls another, so nothing here depends on the
 * Legion being awake.
 *
 * Two things separate this from a threshold check.
 *
 * Hysteresis. A single threshold on a disk sitting at 89.97% produces a
 * notification every time the number wobbles across it. Every condition has a
 * firing level and a lower clearing level, and the band between them holds
 * whatever state it was already in.
 *
 * A sustain window. Load average spikes whenever a build starts. A condition
 * can require that it stay over the line for a while before it counts, which
 * is the difference between "this machine is in trouble" and "this machine is
 * doing something".
 *
 * Note what is deliberately absent: there is no alert for Tailscale being down.
 * The only route a notification has off the machine is the tailnet, so that
 * alert could never be delivered — a rule that can only fire when it cannot be
 * sent is decoration.
 */

export type Level = "warn" | "critical";

/** One evaluated condition at a point in time. `id` is stable across ticks. */
export type Condition = {
  id: string;
  level: Level;
  /** Present tense, for the notification title. */
  title: string;
  body: string;
  value: number;
  fireAt: number;
  /** Must be <= fireAt; the gap is the hysteresis band. */
  clearAt: number;
  /** How long `value >= fireAt` must hold before it fires. 0 fires at once. */
  sustainMs: number;
  /**
   * A point-in-time event (an unknown SSH login), not a standing condition:
   * forgotten on the first tick it is not reported, so the next one pushes
   * again instead of being held as already firing.
   */
  event?: boolean;
};

/**
 * `firing` is the ids firing before this tick, for conditions that can only
 * say they are healthy again by knowing they were reported before.
 */
export type Facts = {
  stats: SystemStats;
  units: UnitState[];
  firing?: ReadonlySet<string>;
  /** Whether Workers run in Cobra's sandbox here (contain.ts containMode); absent, nothing is said. */
  containment?: { contained: boolean; reason: string | null };
};

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Thresholds live here rather than in config: they are judgements about these
 * three machines, and a threshold nobody can see is a threshold nobody tunes.
 */
export function evaluate(facts: Facts): Condition[] {
  const conditions: Condition[] = [];
  const { stats } = facts;

  for (const disk of stats.disks) {
    conditions.push({
      id: `disk:${disk.mount}`,
      level: "critical",
      title: `${stats.host}: ${disk.mount} is filling up`,
      body: `${percent(disk.usage)} used, ${(disk.freeBytes / 1e9).toFixed(1)} GB free`,
      value: disk.usage,
      fireAt: 0.9,
      clearAt: 0.85,
      sustainMs: 0,
    });
  }

  // Swap in use is normal with zram; swap *filling* means the machine is about
  // to start thrashing, which on the Mini is indistinguishable from a hang.
  if (stats.memory.swapTotalBytes > 0) {
    const used = stats.memory.swapUsedBytes / stats.memory.swapTotalBytes;
    conditions.push({
      id: "swap",
      level: "warn",
      title: `${stats.host} is deep into swap`,
      body: `${percent(used)} of swap used, ${percent(stats.memory.usage)} of RAM`,
      value: used,
      fireAt: 0.6,
      clearAt: 0.35,
      sustainMs: 2 * 60_000,
    });
  }

  for (const zone of stats.thermal) {
    conditions.push({
      id: `temp:${zone.label}`,
      level: "warn",
      title: `${stats.host} is running hot`,
      body: `${zone.label} at ${zone.celsius.toFixed(0)}°C`,
      value: zone.celsius,
      fireAt: 90,
      clearAt: 80,
      sustainMs: 5 * 60_000,
    });
  }

  // Normalised by thread count so the same rule means the same thing on
  // machines with different core counts.
  const load = stats.cpu.loadavg[0] / stats.cpu.threads;
  conditions.push({
    id: "load",
    level: "warn",
    title: `${stats.host} is pinned`,
    body: `load ${stats.cpu.loadavg[0].toFixed(1)} across ${stats.cpu.threads} threads`,
    value: load,
    fireAt: 4,
    clearAt: 2,
    sustainMs: 10 * 60_000,
  });

  for (const unit of facts.units) {
    // Only units actually installed here are considered, so cp-home being
    // absent on the Legion is silence rather than a permanent alert.
    if (!unit.enabled) continue;
    conditions.push({
      id: `unit:${unit.unit}`,
      level: "critical",
      title: `${stats.host}: ${unit.unit} is down`,
      body: "The unit is enabled but not running",
      value: unit.active ? 0 : 1,
      fireAt: 1,
      clearAt: 1,
      sustainMs: 0,
    });
  }

  // Workers outside Cobra's sandbox can read the person's whole home folder: a standing warning, never silent.
  if (facts.containment) {
    conditions.push({
      id: "uncontained",
      level: "warn",
      title: "Workers run outside Cobra's sandbox",
      body: `${facts.containment.reason ?? "Cobra's sandbox is off"}. A Worker can read files outside its project.`,
      value: facts.containment.contained ? 0 : 1,
      fireAt: 1,
      clearAt: 1,
      sustainMs: 0,
    });
  }

  return conditions;
}

/**
 * Boolean facts wear the same shape the unit checks already use: value 1 or 0
 * against a fireAt of 1, so `step` handles them without a second state machine.
 */
function flag(
  id: string,
  level: Level,
  title: string,
  body: string,
  on: boolean,
  sustainMs = 0,
): Condition {
  return { id, level, title, body, value: on ? 1 : 0, fireAt: 1, clearAt: 1, sustainMs };
}

/** Per-condition memory. Exported so the caller owns it and tests can inspect it. */
export type AlertState = {
  firing: boolean;
  /** When `value` first reached `fireAt` during the current excursion. */
  since: number | null;
  /** When a firing condition stopped being reported; it is held until HOLD_MISSING_MS. */
  missingSince?: number;
  /** A one-off event's state, forgotten rather than held once it stops being reported. */
  event?: boolean;
};

/**
 * How long a firing condition that stopped being reported is still held as
 * firing. A LAN socket that a program opens and closes all day (the DHCPv6
 * client on udp/546, Spotify's discovery port) used to be forgotten each time
 * it closed and pushed again each time it came back; held, it pushes once.
 */
export const HOLD_MISSING_MS = 24 * 60 * 60_000;

export type Change = { kind: "fired" | "cleared"; condition: Condition };

/**
 * Advances the state machine. Returns only the edges, so a condition that has
 * been firing for an hour produces nothing on every tick but the first.
 */
export function step(
  state: Map<string, AlertState>,
  conditions: Condition[],
  now: number,
): Change[] {
  const changes: Change[] = [];
  const seen = new Set<string>();

  for (const condition of conditions) {
    seen.add(condition.id);
    const previous = state.get(condition.id) ?? { firing: false, since: null };

    if (condition.value >= condition.fireAt) {
      const since = previous.since ?? now;
      const sustained = now - since >= condition.sustainMs;
      if (!previous.firing && sustained) {
        changes.push({ kind: "fired", condition });
        state.set(condition.id, { firing: true, since });
      } else {
        state.set(condition.id, { firing: previous.firing, since });
      }
      continue;
    }

    if (condition.value < condition.clearAt) {
      if (previous.firing) changes.push({ kind: "cleared", condition });
      state.set(condition.id, { firing: false, since: null });
      continue;
    }

    // Inside the hysteresis band: hold the state, but drop the sustain clock so
    // a value that dips back and forth has to earn its firing again.
    state.set(condition.id, { firing: previous.firing, since: null });
  }

  // A condition that stopped being reported at all — a disk unmounted, a unit
  // disabled, a socket closed — is not an ongoing alert, but it may come back.
  // One that was not firing, or was a one-off event, is forgotten at once. One
  // that was firing is held, silently, for HOLD_MISSING_MS, so its return is
  // not a second push; after that it is forgotten rather than left firing
  // forever with nothing left to clear it.
  for (const condition of conditions) {
    const entry = state.get(condition.id);
    if (condition.event && entry) state.set(condition.id, { ...entry, event: true });
  }
  for (const [id, previous] of [...state]) {
    if (seen.has(id)) continue;
    if (!previous.firing || previous.event) {
      state.delete(id);
      continue;
    }
    const missingSince = previous.missingSince ?? now;
    if (now - missingSince >= HOLD_MISSING_MS) state.delete(id);
    else state.set(id, { firing: true, since: previous.since, missingSince });
  }

  return changes;
}

/**
 * Where the state machine is kept between restarts. It used to live only in
 * memory, so every agent restart (each install) pushed every standing alert
 * again: on 2026-10-11 that was 97 pushes from 19 restarts.
 */
export const ALERTS_PATH = join(STATE_DIR, "alerts.json");

/**
 * Only firing conditions are kept: a sustain clock that was running when the
 * agent stopped has not been watched since, so it starts again.
 */
export function serializeAlertState(state: ReadonlyMap<string, AlertState>): string {
  const alerts = [...state]
    .filter(([, entry]) => entry.firing)
    .map(([id, entry]) => ({ id, since: entry.since, ...(entry.missingSince === undefined ? {} : { missingSince: entry.missingSince }) }));
  return `${JSON.stringify({ alerts }, null, 2)}\n`;
}

/** The kept state; a missing or unreadable file is none, and says so in the log. */
export function loadAlertState(path: string, log: (line: string) => void): Map<string, AlertState> {
  const state = new Map<string, AlertState>();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") log(`alerts: could not read ${path} (${code ?? String(caught)}); starting with none firing`);
    return state;
  }
  try {
    const raw = JSON.parse(text) as { alerts?: unknown };
    if (!Array.isArray(raw?.alerts)) throw new Error("no alerts list");
    for (const entry of raw.alerts as Array<Record<string, unknown> | null>) {
      if (typeof entry?.id !== "string" || entry.id === "") continue;
      const since = typeof entry.since === "number" ? entry.since : null;
      const missingSince = typeof entry.missingSince === "number" ? entry.missingSince : undefined;
      state.set(entry.id, { firing: true, since, ...(missingSince === undefined ? {} : { missingSince }) });
    }
  } catch (caught) {
    log(`alerts: ${path} is not readable (${caught instanceof Error ? caught.message : String(caught)}); starting with none firing`);
    state.clear();
  }
  return state;
}

export function saveAlertState(path: string, text: string): void {
  writePrivateFile(path, text);
}

export function compose(machine: string, change: Change): PushMessage {
  const { condition } = change;
  return {
    title: change.kind === "fired" ? condition.title : `Resolved: ${condition.title}`,
    body: change.kind === "fired" ? condition.body : "Back to normal",
    data: { machine, alert: condition.id, level: condition.level, kind: change.kind },
  };
}
