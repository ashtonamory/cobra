import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * What the Linux collectors read from /proc and /sys, read on macOS from the
 * commands it ships with: vm_stat and sysctl for memory, mount for disks,
 * netstat for the network, pmset for power, launchctl for Cobra's services.
 * Each parser is pure; each reader gives an empty answer when its command is
 * missing or fails, never an error: a computer stat is best-effort.
 */

export async function output(command: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run(command, [...args], { timeout: 3000 });
    return stdout;
  } catch (caught) {
    // launchctl and pmset report some states with a non-zero exit; their output is still the answer.
    const out = (caught as { stdout?: unknown }).stdout;
    return typeof out === "string" ? out : "";
  }
}

/**
 * `vm_stat`: memory a program can have now without pressure, as MemAvailable
 * is on Linux: free, inactive, speculative and purgeable pages.
 */
export function vmAvailable(text: string): number | null {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!Number.isFinite(size) || size <= 0) return null;
  const pages = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)\\.?$`, "m").exec(text)?.[1] ?? 0);
  return (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) * size;
}

/** `sysctl -n vm.swapusage`: "total = 2048.00M  used = 1024.50M  free = ...". */
export function swapUsage(text: string): { total: number; used: number } {
  const bytes = (name: string) => {
    const match = new RegExp(`${name} = ([\\d.]+)([KMGT])`).exec(text);
    if (!match) return 0;
    const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[match[2] as "K" | "M" | "G" | "T"];
    return Math.round(Number(match[1]) * unit);
  };
  return { total: bytes("total"), used: bytes("used") };
}

/**
 * `mount`: "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)".
 * The disks a person means: the data volume (shown as /), and drives under
 * /Volumes. The sealed system snapshot and the other APFS helper volumes
 * share the data volume's container and would only repeat it.
 */
export function macMounts(text: string): Array<{ device: string; mount: string; fstype: string }> {
  const all = text.split("\n").flatMap((line) => {
    const match = /^(\/dev\/\S+) on (.+) \(([^,)]+)/.exec(line);
    return match ? [{ device: match[1]!, mount: match[2]!, fstype: match[3]! }] : [];
  });
  const data = all.find((entry) => entry.mount === "/System/Volumes/Data");
  return all.filter((entry) => {
    if (entry.mount === "/") return !data;
    if (entry.mount.startsWith("/System/Volumes/")) return entry === data;
    return entry.mount.startsWith("/Volumes/");
  });
}

/**
 * `netstat -ibn`: one line per interface and address; the <Link#n> line
 * carries the byte counters (Ibytes, Obytes) once per interface.
 */
export function netstatBytes(text: string): Array<{ iface: string; rxBytes: number; txBytes: number }> {
  const lines = text.split("\n");
  const head = (lines[0] ?? "").trim().split(/\s+/);
  const ib = head.indexOf("Ibytes");
  const ob = head.indexOf("Obytes");
  if (ib < 0 || ob < 0) return [];
  const seen = new Set<string>();
  const out: Array<{ iface: string; rxBytes: number; txBytes: number }> = [];
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    const iface = fields[0];
    if (!iface || seen.has(iface) || !(fields[2] ?? "").startsWith("<Link#")) continue;
    // A Link line with no address has one field fewer before the counters.
    const shift = fields.length === head.length - 1 ? -1 : 0;
    const rx = Number(fields[ib + shift]);
    const tx = Number(fields[ob + shift]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    seen.add(iface);
    out.push({ iface, rxBytes: rx, txBytes: tx });
  }
  return out;
}

/** `pmset -g batt`: "Now drawing from 'AC Power'" and " -InternalBattery-0 (id=…)	87%; charged; …". */
export function pmsetBattery(text: string): { ac: boolean | null; battery: number | null } {
  const source = /Now drawing from '([^']+)'/.exec(text)?.[1];
  const pct = Number(/InternalBattery[^\t]*\t(\d+)%/.exec(text)?.[1]);
  return { ac: source ? source === "AC Power" : null, battery: Number.isFinite(pct) ? pct : null };
}

/** `launchctl print gui/<uid>/<label>`: loaded, and "state = running" while it runs. */
export function launchdState(text: string): { enabled: boolean; active: boolean } {
  if (!text.trim() || /Could not find service/.test(text)) return { enabled: false, active: false };
  return { enabled: true, active: /^\s*state = running\s*$/m.test(text) };
}

/** Cobra's launchd labels, by the systemd unit name each stands for. */
export const LAUNCHD_LABEL: Readonly<Record<string, string>> = { "cobra-agent": "app.cobra.agent", "cobra-term": "app.cobra.term" };
