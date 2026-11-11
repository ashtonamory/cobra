import type { ProjectList, SystemStats } from "@cobra/contracts";

import type { Reading, Store } from "./history.ts";

/**
 * Feeds the history store.
 *
 * Deliberately not folded into the watcher, for two reasons. The watcher
 * returns early when no phone is registered — correct for push, wrong for
 * history, which should still be recording on a machine nobody has paired
 * with. And the watcher's five-second tick is the right rate for catching a
 * dialog and far too fast for a metric nobody will plot at that resolution.
 */

/**
 * Flattened from the same stats /system already returns, so a chart and the
 * live tile can never disagree about what "usage" means.
 */
export function readingsFrom(stats: SystemStats): Reading[] {
  const readings: Reading[] = [
    { metric: "cpu", scope: "", value: stats.cpu.usage },
    { metric: "load", scope: "", value: stats.cpu.loadavg[0] },
    { metric: "memory", scope: "", value: stats.memory.usage },
  ];
  // A machine with swap disabled would otherwise record a NaN every minute.
  if (stats.memory.swapTotalBytes > 0) {
    readings.push({
      metric: "swap",
      scope: "",
      value: stats.memory.swapUsedBytes / stats.memory.swapTotalBytes,
    });
  }
  for (const disk of stats.disks) {
    readings.push({ metric: "disk", scope: disk.mount, value: disk.usage });
  }
  for (const zone of stats.thermal) {
    readings.push({ metric: "temp", scope: zone.label, value: zone.celsius });
  }
  return readings;
}

/**
 * One row per project per minute. The bucket is rewritten rather than appended,
 * so a project that is "working" for a whole minute contributes one minute —
 * which is what makes summing them into hours honest.
 */
export function activityFrom(list: ProjectList): Array<{ project: string; activity: string }> {
  return list.projects.map((project) => ({ project: project.id, activity: project.activity }));
}

export type RecorderDeps = {
  store: Store;
  system: () => Promise<SystemStats>;
  projects: () => Promise<ProjectList>;
  intervalMs: number;
  /** Delay before the first sample, so the CPU collector has a real interval. */
  primeDelayMs: number;
  /** How often to roll up and prune. Cheap, but pointless to run every minute. */
  maintainEveryMs: number;
  /**
   * Handed the same sample the store just took. Alerting rides along here
   * rather than running its own loop, so the machine is measured once a minute
   * and two things read the result, rather than collecting /system twice to
   * answer the same question.
   */
  onSample?: (stats: SystemStats, at: number) => Promise<void> | void;
  log: (line: string) => void;
  now?: () => number;
};

export function startRecorder(deps: RecorderDeps): () => void {
  const now = deps.now ?? Date.now;
  let busy = false;
  let lastMaintained = now();

  async function tick(): Promise<void> {
    // A slow collector must not stack ticks up behind it; skipping a minute
    // leaves a gap in a chart, which is honest, whereas queuing them would
    // write several minutes' worth of samples under one timestamp.
    if (busy) return;
    busy = true;
    try {
      const [stats, list] = await Promise.all([deps.system(), deps.projects()]);
      const at = now();
      deps.store.record(readingsFrom(stats), at);
      deps.store.recordActivity(activityFrom(list), at);

      if (at - lastMaintained >= deps.maintainEveryMs) {
        deps.store.maintain(at);
        lastMaintained = at;
      }

      // After recording, so a throwing consumer cannot cost us the sample.
      if (deps.onSample) await deps.onSample(stats, at);
    } catch (error) {
      deps.log(`recorder tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
    }
  }

  // Record soon after startup rather than waiting a full interval, so a restart
  // does not punch a minute-wide hole in the series — but not immediately: CPU
  // usage is measured against the previous sample, and a reading taken
  // microseconds after the collector was primed is a truthful-looking zero.
  const primed = setTimeout(() => void tick(), deps.primeDelayMs);
  const timer = setInterval(() => void tick(), deps.intervalMs);
  return () => {
    clearTimeout(primed);
    clearInterval(timer);
  };
}
