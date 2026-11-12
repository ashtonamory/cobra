import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Whether this machine's own systemd user units are up.
 *
 * The distinction that matters is enabled versus active. A unit that was
 * never installed here would report "inactive" forever and alert on
 * something that was never supposed to be there, so is-enabled is checked
 * first: this computer answers only for the units it has.
 */

export type UnitState = { unit: string; enabled: boolean; active: boolean };

/** The user units this project installs. */
export const COBRA_UNITS = ["cobra-agent"] as const;

/**
 * systemctl exits non-zero to *report* a state — is-active returns 3 for an
 * inactive unit — so a rejection here is an answer, not a failure. Both are
 * read off stdout.
 */
async function ask(args: string[]): Promise<string> {
  try {
    const { stdout } = await run("systemctl", args, { timeout: 3000 });
    return stdout.trim();
  } catch (caught) {
    const error = caught as { stdout?: string; code?: unknown };
    if (typeof error.stdout === "string") return error.stdout.trim();
    return "";
  }
}

export async function collectUnits(
  units: readonly string[] = COBRA_UNITS,
): Promise<UnitState[]> {
  if (process.platform === "darwin") {
    // launchd user agents (launchd/*.plist) stand in for the systemd units.
    const { LAUNCHD_LABEL, launchdState, output } = await import("./darwin.ts");
    const uid = process.getuid?.() ?? 0;
    return Promise.all(units.map(async (unit) => ({ unit, ...launchdState(await output("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL[unit] ?? unit}`])) })));
  }
  const states = await Promise.all(
    units.map(async (unit) => {
      const enabled = await ask(["--user", "is-enabled", unit]);
      // "enabled" and "enabled-runtime" both mean installed here; "not-found",
      // "disabled" and "" mean this machine does not run it.
      const isEnabled = enabled.startsWith("enabled");
      if (!isEnabled) return { unit, enabled: false, active: false };
      const active = await ask(["--user", "is-active", unit]);
      return { unit, enabled: true, active: active === "active" };
    }),
  );
  return states;
}
