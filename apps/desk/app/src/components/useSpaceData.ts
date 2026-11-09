/**
 * What the Space cards and a Space's screen read beside the fleet's poll (lib/fleet.ts already has the
 * rows and `/orch/history`): each computer's routines (`GET /routines`) and What Cobra did there
 * (`GET /decided`). Only the computers a Space has a seat on are asked, once a minute while the chart
 * or a Space's screen shows (and at once after Run now, Pause or Remove); one copy is kept for every
 * page here, so the chart and the screen share their reads and coming back costs nothing.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import * as api from "../lib/api.ts";
import { decidedRows } from "../lib/decided.ts";
import { isDict, type Dict, type Json } from "../lib/json.ts";
import { parseRoutines } from "../lib/spaceScreen.ts";
import type { ActivityDecided, MachineRoutine } from "../../../../../packages/contracts/src/spaceScreen.ts";

/** How often a shown page asks again. */
const EVERY_MS = 60_000;
/** A read this fresh is used as it is when a page first shows. */
const FRESH_MS = 20_000;

type Read<T> = { at: number; value: T };

function store<T>(read: (machine: string) => Promise<T>, empty: T) {
  const reads = new Map<string, Read<T>>();
  const pending = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;
  const changed = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  const load = async (machine: string) => {
    if (pending.has(machine)) return;
    pending.add(machine);
    try {
      reads.set(machine, { at: Date.now(), value: await read(machine) });
    } catch (e) {
      // An agent before this route (404) has nothing; one that does not answer keeps what it last said.
      if ((e as { status?: number })?.status === 404 || !reads.has(machine)) reads.set(machine, { at: Date.now(), value: empty });
    } finally {
      pending.delete(machine);
      changed();
    }
  };
  return {
    reads,
    load,
    refresh: (machines: readonly string[], force = false) =>
      Promise.all(machines.filter((m) => force || Date.now() - (reads.get(m)?.at ?? 0) >= FRESH_MS).map(load)),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    version: () => version,
  };
}

/** Each computer's routines, raw (for All routines' `when`) and as the shared rules read them. */
const routineStore = store<{ raw: Dict[]; list: MachineRoutine[] }>(async (machine) => {
  const reply: Json = await api.routines(machine);
  const raw = isDict(reply) && Array.isArray(reply.routines) ? reply.routines.filter(isDict) : [];
  return { raw, list: parseRoutines(machine, reply) };
}, { raw: [], list: [] });

const decidedStore = store<ActivityDecided[]>(async (machine) => {
  const reply = await api.decided(machine);
  return decidedRows([[machine, reply]]).map((row) => ({
    machine, at: row.at, kind: row.kind, title: row.title,
    ...(row.project ? { project: row.project } : {}),
    ...(row.undone ? { undone: row.undone } : {}),
  }));
}, []);

function usePolled<T>(s: ReturnType<typeof store<T>>, machines: readonly string[]): { values: T[]; version: number; reload: () => void } {
  const version = useSyncExternalStore(s.subscribe, s.version);
  const key = machines.join("\0");
  useEffect(() => {
    const list = key ? key.split("\0") : [];
    void s.refresh(list);
    const timer = setInterval(() => void s.refresh(list, true), EVERY_MS);
    return () => clearInterval(timer);
  }, [key, s]);
  const reload = useCallback(() => void s.refresh(key ? key.split("\0") : [], true), [key, s]);
  const values = useMemo(
    () => (key ? key.split("\0") : []).map((m) => s.reads.get(m)?.value).filter((v): v is T => v !== undefined),
    [key, s, version],
  );
  return { values, version, reload };
}

/** The routines on these computers, read once a minute while shown. */
export function useRoutines(machines: readonly string[]): { routines: MachineRoutine[]; raw: Map<string, Dict>; loaded: boolean; reload: () => void } {
  const { values, version, reload } = usePolled(routineStore, machines);
  return useMemo(() => {
    const raw = new Map<string, Dict>();
    for (const m of machines) for (const r of routineStore.reads.get(m)?.value.raw ?? []) if (typeof r.id === "string") raw.set(`${m}:${r.id}`, r);
    return { routines: values.flatMap((v) => v.list), raw, loaded: machines.every((m) => routineStore.reads.has(m)), reload };
  }, [values, version, reload]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** What Cobra did on these computers (for a Space's Activity), read once a minute while shown. */
export function useDecidedOn(machines: readonly string[]): ActivityDecided[] {
  const { values } = usePolled(decidedStore, machines);
  return useMemo(() => values.flat(), [values]);
}

/** The time a page draws "in 16 min" from, moved on every half minute. */
export function useNow(every = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}
