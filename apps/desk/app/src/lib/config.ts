/**
 * The agent this desktop talks to, as the web side knows it (the desk's config.py). Cobra is one
 * computer: the list from the Rust side (`computers`) is empty before the agent is linked and holds
 * this computer's agent after, without its key: every request is made there (src-tauri/src/api.rs).
 * Pages still read it as a list, so what they add up "across computers" is this one. Pure, so tests
 * can set it.
 */

export interface Machine {
  /** What the agent calls itself (its hostname); /projects reports this. */
  machine: string;
  /** What the UI shows (COBRA_MACHINE_NAME in agent.env, else the hostname). */
  label: string;
  /** The same, as a heading. */
  title: string;
  /** Where its agent answers (http://127.0.0.1:<port>). */
  base: string;
  termBase: string;
  tmuxSocket: string;
  /** Always true: the agent is on this computer. */
  local: boolean;
  /** Its colour. */
  hue: string;
}

export const HUES = ["blue", "cyan", "magenta", "green", "yellow", "orange"] as const;

/** Read once at start and again after the agent is linked or unlinked (`setMachines`). */
export let MACHINES: readonly Machine[] = [];

export function setMachines(found: readonly Machine[]): void {
  MACHINES = found;
}

export function machine(name: string): Machine | undefined {
  return MACHINES.find((m) => m.machine === name);
}

/** The agent on this computer, once linked. */
export function agent(): Machine | undefined {
  return MACHINES[0];
}

export function label(name: string): string {
  return machine(name)?.label ?? (name || "?");
}

export function hue(name: string): string {
  const index = MACHINES.findIndex((m) => m.machine === name);
  return index >= 0 ? HUES[index % HUES.length] : "accent";
}

/** A machine for tests: everything filled in from its name. */
export function testMachine(name: string, extra: Partial<Machine> = {}): Machine {
  return {
    machine: name, label: name, title: name.slice(0, 1).toUpperCase() + name.slice(1),
    base: "http://127.0.0.1:8787", termBase: "http://127.0.0.1:8788",
    tmuxSocket: "cobra", local: true, hue: "blue", ...extra,
  };
}
