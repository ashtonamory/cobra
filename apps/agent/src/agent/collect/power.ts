import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { PowerStats } from "@cobra/contracts";

const run = promisify(execFile);

/**
 * Battery, charger, lid and lid-awake — the facts behind "can I close this
 * laptop and leave it running". A desktop (no battery, no lid) reports
 * nulls rather than failing, and `lidAwake.available` is false wherever
 * desktop/lid-awake was never installed.
 *
 * Lid-awake is `lid-awake.service`, a user unit holding a logind inhibitor on
 * handle-lid-switch and sleep. It is static (never enabled), so "installed"
 * is LoadState=loaded, not is-enabled as collect/units.ts asks.
 */
export const LID_AWAKE_UNIT = "lid-awake.service";

async function read(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

/** `/proc/acpi/button/lid/*\/state` reads "state:      open". */
export function parseLidState(raw: string | null): "open" | "closed" | null {
  const word = raw?.split(/\s+/).at(-1);
  return word === "open" || word === "closed" ? word : null;
}

type Supply = { type: string | null; online: string | null; capacity: string | null };

/** AC is any Mains supply online; battery is the first BAT's capacity. */
export function summariseSupplies(supplies: Supply[]): { ac: boolean | null; battery: number | null } {
  const mains = supplies.filter((s) => s.type === "Mains");
  const ac = mains.length ? mains.some((s) => s.online === "1") : null;
  const bat = supplies.find((s) => s.type === "Battery" && s.capacity !== null);
  const pct = bat ? Number(bat.capacity) : NaN;
  return { ac, battery: Number.isFinite(pct) ? pct : null };
}

async function systemctl(args: string[]): Promise<string> {
  // Non-zero exits report a state (is-active → 3 when inactive); read stdout.
  try {
    const { stdout } = await run("systemctl", ["--user", ...args], { timeout: 3000 });
    return stdout.trim();
  } catch (caught) {
    const out = (caught as { stdout?: unknown }).stdout;
    return typeof out === "string" ? out.trim() : "";
  }
}

export async function lidAwakeState(): Promise<{ available: boolean; on: boolean }> {
  const load = await systemctl(["show", LID_AWAKE_UNIT, "-p", "LoadState", "--value"]);
  if (load !== "loaded") return { available: false, on: false };
  return { available: true, on: (await systemctl(["is-active", LID_AWAKE_UNIT])) === "active" };
}

/** Start or stop lid-awake; resolves to the state afterwards. */
export async function setLidAwake(on: boolean): Promise<{ available: boolean; on: boolean }> {
  const before = await lidAwakeState();
  if (!before.available) return before;
  await run("systemctl", ["--user", on ? "start" : "stop", LID_AWAKE_UNIT], { timeout: 10000 });
  return lidAwakeState();
}

export async function collectPower(): Promise<PowerStats> {
  if (process.platform === "darwin") {
    // pmset for AC and the battery; a Mac's lid and lid-awake are not read here.
    const { output, pmsetBattery } = await import("./darwin.ts");
    return { ...pmsetBattery(await output("pmset", ["-g", "batt"])), lid: null, lidAwake: { available: false, on: false } };
  }
  const base = "/sys/class/power_supply";
  const names = await readdir(base).catch(() => [] as string[]);
  const supplies = await Promise.all(
    names.map(async (name) => ({
      type: await read(`${base}/${name}/type`),
      online: await read(`${base}/${name}/online`),
      capacity: await read(`${base}/${name}/capacity`),
    })),
  );
  const lidDirs = await readdir("/proc/acpi/button/lid").catch(() => [] as string[]);
  const lid = lidDirs.length
    ? parseLidState(await read(`/proc/acpi/button/lid/${lidDirs[0]}/state`))
    : null;
  return { ...summariseSupplies(supplies), lid, lidAwake: await lidAwakeState() };
}
