/** Projects pinned to the top of the Projects page (model.pinKey), cached from the Rust side. */
import { bridge } from "./bridge.ts";

let pins: string[] = [];
let version = 0;
const listeners = new Set<() => void>();

export async function loadPins(): Promise<void> {
  pins = await bridge.pins().catch(() => []);
  version++;
  listeners.forEach((f) => f());
}

export function pinned(key: string | null): boolean | null {
  return key === null ? null : pins.includes(key);
}

export function allPins(): readonly string[] {
  return pins;
}

export async function togglePin(key: string): Promise<boolean> {
  const now = await bridge.togglePin(key);
  await loadPins();
  return now;
}

export const pinStore = {
  subscribe: (f: () => void) => {
    listeners.add(f);
    return () => void listeners.delete(f);
  },
  version: () => version,
};
