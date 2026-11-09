/**
 * What every page reaches for (the desk's `app`): the fleet, the shared verbs,
 * a toast, and the ways to move around the window.
 */
import { createContext, useContext, useSyncExternalStore } from "react";
import type { Fleet } from "../lib/fleet.ts";
import type { Actions } from "../lib/actions.ts";

export type PageKey = "ops" | "agents" | "projects" | "money" | "settings" | "notebook";

export interface AppCtx {
  fleet: Fleet;
  actions: Actions;
  toast: (text: string) => void;
  show: (page: PageKey | string) => void;
  /** Agents, with that session's conversation open. */
  openChat: (machine: string, session: string) => void;
  /** A project's own page (the desk's ProjectPage). */
  openProject: (machine: string, project: string) => void;
  /** The New project dialog, on Projects. */
  newProject: () => void;
  /** Read computers.json again (after linking or removing a computer). */
  reloadMachines: () => Promise<void>;
  /** Bumped when the computers change, so pages re-read them. */
  machinesVersion: number;
}

export const AppContext = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside the app");
  return ctx;
}

/** Re-renders on every fleet change; returns the fleet. */
export function useFleet(): Fleet {
  const { fleet } = useApp();
  useSyncExternalStore(fleet.subscribe, fleet.getVersion);
  return fleet;
}
