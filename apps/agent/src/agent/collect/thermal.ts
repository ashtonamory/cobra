import { readdir, readFile } from "node:fs/promises";
import type { ThermalStats } from "@cobra/contracts";

/**
 * Temperature is best-effort. Some computers expose plenty of zones; a Mac may
 * expose few or none, and a machine with no sensors is not an error.
 */
export async function collectThermal(): Promise<ThermalStats[]> {
  const results: ThermalStats[] = [];

  try {
    const zones = (await readdir("/sys/class/thermal"))
      .filter((entry) => entry.startsWith("thermal_zone"));

    for (const zone of zones) {
      try {
        const base = `/sys/class/thermal/${zone}`;
        const [rawTemp, rawType] = await Promise.all([
          readFile(`${base}/temp`, "utf8"),
          readFile(`${base}/type`, "utf8").catch(() => zone),
        ]);
        const milli = Number(rawTemp.trim());
        if (!Number.isFinite(milli)) continue;
        const celsius = milli / 1000;
        // Disconnected sensors report absurd values; drop them rather than
        // showing -273°C in the UI.
        if (celsius < -50 || celsius > 150) continue;
        results.push({ label: rawType.trim(), celsius });
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }

  return results;
}
