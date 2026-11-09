import { readFile } from "node:fs/promises";
import os from "node:os";
import type { MemoryStats } from "@cobra/contracts";

function parseMeminfo(raw: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const match = /^(\S+):\s+(\d+)(?:\s+kB)?$/.exec(line);
    if (match?.[1] && match[2]) out.set(match[1], Number(match[2]) * 1024);
  }
  return out;
}

/** macOS: vm_stat for what is available, sysctl for swap. */
async function macMemory(): Promise<MemoryStats> {
  const { output, swapUsage, vmAvailable } = await import("./darwin.ts");
  const totalBytes = os.totalmem();
  const availableBytes = Math.min(totalBytes, vmAvailable(await output("vm_stat", [])) ?? os.freemem());
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const swap = swapUsage(await output("sysctl", ["-n", "vm.swapusage"]));
  return { totalBytes, availableBytes, usedBytes, usage: totalBytes > 0 ? usedBytes / totalBytes : 0, swapTotalBytes: swap.total, swapUsedBytes: swap.used, zram: false };
}

export async function collectMemory(): Promise<MemoryStats> {
  if (process.platform === "darwin") return macMemory();
  const info = parseMeminfo(await readFile("/proc/meminfo", "utf8"));

  const totalBytes = info.get("MemTotal") ?? 0;
  // MemAvailable, not MemFree: free memory is meaningless when page cache is
  // doing its job. This is the number that actually predicts pressure.
  const availableBytes = info.get("MemAvailable") ?? 0;
  const usedBytes = Math.max(0, totalBytes - availableBytes);

  const swapTotalBytes = info.get("SwapTotal") ?? 0;
  const swapFreeBytes = info.get("SwapFree") ?? 0;

  let zram = false;
  try {
    const swaps = await readFile("/proc/swaps", "utf8");
    zram = swaps.includes("zram");
  } catch {
    // /proc/swaps is always present on Linux; a failure here is not worth
    // failing the whole stats call over.
  }

  return {
    totalBytes,
    availableBytes,
    usedBytes,
    usage: totalBytes > 0 ? usedBytes / totalBytes : 0,
    swapTotalBytes,
    swapUsedBytes: Math.max(0, swapTotalBytes - swapFreeBytes),
    zram,
  };
}
