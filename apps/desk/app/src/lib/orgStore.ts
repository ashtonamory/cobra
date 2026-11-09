/**
 * The org as the desk knows it (agent orgRoutes.ts), as the phone's useOrg.ts
 * keeps it: read from every computer, kept from the one that keeps the
 * fleet's (the Lead's), else the newest. Changes go to that computer only. A
 * computer without /org (an older agent) is dropped; one that blinks keeps
 * what it said last.
 */
import { useSyncExternalStore } from "react";
import { EMPTY_ORG, type Org, type OrgChange } from "../../../../../packages/contracts/src/org.ts";
import * as api from "./api.ts";
import * as config from "./config.ts";
import type { Dict } from "./json.ts";
import { orgHome, orgReply } from "./org.ts";
import { LEAD_NAME } from "./appName.ts";

type Read = { machine: string; org: Org; home: boolean };
export type OrgSnapshot = { org: Org; home: string | null; loaded: boolean; hiring: { id: string; name: string } | null };

let reads = new Map<string, Read>();
let snapshot: OrgSnapshot = { org: EMPTY_ORG, home: null, loaded: false, hiring: null };
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function publish(extra: Partial<OrgSnapshot> = {}): void {
  const home = orgHome([...reads.values()]);
  snapshot = { ...snapshot, org: home?.org ?? EMPTY_ORG, home: home?.machine ?? config.MACHINES[0]?.machine ?? null, loaded: true, ...extra };
  for (const listener of listeners) listener();
}

export function refreshOrg(): Promise<void> {
  inFlight ??= (async () => {
    try {
      const machines = config.MACHINES.map((m) => m.machine);
      await Promise.all(
        machines.map(async (machine) => {
          try {
            reads.set(machine, { machine, ...orgReply(await api.org(machine)) });
          } catch (e) {
            if ((e as api.ApiError).status === 404) reads.delete(machine);
          }
        }),
      );
      reads = new Map([...reads].filter(([machine]) => machines.includes(machine)));
      publish();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** One change on the org's home computer at the revision read; on a 409, read again and try once more. */
export async function changeOrg(change: OrgChange): Promise<{ org: Org; created?: string }> {
  const home = snapshot.home;
  if (!home) throw new Error(`Add a computer first: your organization is kept on the computer ${LEAD_NAME} runs on.`);
  const attempt = async () => {
    const read = reads.get(home);
    const done = (await api.orgChange(home, change as unknown as Dict, read?.org.revision ?? 0)) as Dict;
    const { org } = orgReply(done);
    reads.set(home, { machine: home, org, home: read?.home ?? true });
    publish();
    return { org, ...(typeof done.created === "string" ? { created: done.created } : {}) };
  };
  try {
    return await attempt();
  } catch (e) {
    if ((e as api.ApiError).status !== 409) throw e;
    await refreshOrg();
    return attempt();
  }
}

/** Hire on a company's page: the next project made in New project joins it. */
export function setHiring(hiring: OrgSnapshot["hiring"]): void {
  snapshot = { ...snapshot, hiring };
  for (const listener of listeners) listener();
}

export function getOrg(): OrgSnapshot {
  return snapshot;
}

export function useOrg(): OrgSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}
