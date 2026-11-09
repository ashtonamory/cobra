import { readFile } from "node:fs/promises";
import type { NetStats } from "@cobra/contracts";

type Counters = { rx: number; tx: number; at: number };

const previous = new Map<string, Counters>();

/** Loopback, virtual bridges and macOS's own tunnels say nothing about real connectivity. */
const IGNORED = /^(lo|docker\d+|br-|veth|virbr|gif|stf|utun|awdl|llw|anpi|ap\d|bridge)/;

/** Each interface's byte counters: /proc/net/dev on Linux, netstat on macOS. */
async function counters(): Promise<Array<{ iface: string; rxBytes: number; txBytes: number }>> {
  if (process.platform === "darwin") {
    const { netstatBytes, output } = await import("./darwin.ts");
    return netstatBytes(await output("netstat", ["-ibn"]));
  }
  const raw = await readFile("/proc/net/dev", "utf8");
  // First two lines are headers.
  return raw.split("\n").slice(2).flatMap((line) => {
    const [namePart, rest] = line.split(":");
    if (!namePart || !rest) return [];
    const fields = rest.trim().split(/\s+/).map(Number);
    return [{ iface: namePart.trim(), rxBytes: fields[0] ?? 0, txBytes: fields[8] ?? 0 }];
  });
}

export async function collectNetwork(): Promise<NetStats[]> {
  let found: Awaited<ReturnType<typeof counters>>;
  try {
    found = await counters();
  } catch {
    return [];
  }

  const now = Date.now();
  const results: NetStats[] = [];

  for (const { iface, rxBytes, txBytes } of found) {
    if (!iface || IGNORED.test(iface)) continue;

    const before = previous.get(iface);
    let rxRate: number | null = null;
    let txRate: number | null = null;

    if (before) {
      const seconds = (now - before.at) / 1000;
      if (seconds > 0) {
        // Counters wrap on 32-bit kernels and reset when an interface bounces;
        // a negative delta means the baseline is gone, so report null.
        rxRate = rxBytes >= before.rx ? (rxBytes - before.rx) / seconds : null;
        txRate = txBytes >= before.tx ? (txBytes - before.tx) / seconds : null;
      }
    }

    previous.set(iface, { rx: rxBytes, tx: txBytes, at: now });
    results.push({ iface, rxBytes, txBytes, rxRate, txRate });
  }

  return results;
}
