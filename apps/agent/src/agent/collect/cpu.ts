import { readFile } from "node:fs/promises";
import os from "node:os";
import type { CpuStats } from "@cobra/contracts";

type Sample = { idle: number; total: number };

let previous: Sample | null = null;

/** Aggregate line from /proc/stat: cpu <user> <nice> <system> <idle> <iowait> <irq> <softirq> <steal> ... */
async function sample(): Promise<Sample> {
  if (process.platform !== "linux") return timesSample();
  const stat = await readFile("/proc/stat", "utf8");
  const line = stat.split("\n", 1)[0] ?? "";
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0); // idle + iowait
  const total = fields.reduce((a, b) => a + b, 0);
  return { idle, total };
}

/** Every core's times, as Node reads them on macOS (no /proc there). */
function timesSample(): Sample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const { user, nice, sys, idle: free, irq } = cpu.times;
    idle += free;
    total += user + nice + sys + free + irq;
  }
  return { idle, total };
}

/**
 * Busy fraction since the previous call. The first call after start has no
 * baseline, so it reports 0 rather than a misleading since-boot average.
 */
export async function collectCpu(): Promise<CpuStats> {
  const current = await sample();
  let usage = 0;

  if (previous) {
    const totalDelta = current.total - previous.total;
    const idleDelta = current.idle - previous.idle;
    if (totalDelta > 0) {
      usage = Math.min(1, Math.max(0, 1 - idleDelta / totalDelta));
    }
  }
  previous = current;

  const cpus = os.cpus();
  const [one = 0, five = 0, fifteen = 0] = os.loadavg();

  return {
    model: cpus[0]?.model?.trim() ?? "unknown",
    threads: cpus.length,
    usage,
    loadavg: [one, five, fifteen],
  };
}

/**
 * Prime the baseline at startup so the first request returns a real number
 * instead of a zero.
 */
export async function primeCpu(): Promise<void> {
  previous = await sample();
}
