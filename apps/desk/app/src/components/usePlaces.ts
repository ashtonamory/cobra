/**
 * Where each project sits, for the pages that name a Space instead of the crew (lib/crewVisibility.ts):
 * the seats lib/org.ts builds from the rows the window has, over the org (lib/orgStore.ts), read here
 * once and every minute so a window that never shows the Org page (Home, the Cobra box) has it too.
 */
import { useEffect, useMemo } from "react";
import type { Org } from "../../../../../packages/contracts/src/org.ts";
import { placeOf, rowProject, workingPlaces, type Place } from "../lib/crewVisibility.ts";
import type { Dict } from "../lib/json.ts";
import type { Row } from "../lib/model.ts";
import { townOf, type Town } from "../lib/org.ts";
import { refreshOrg, useOrg } from "../lib/orgStore.ts";

const NOBODY: ReadonlySet<string> = new Set();
const NO_APPROVALS: Record<string, Dict[]> = {};
const NO_ORCH: Record<string, Dict> = {};

export type Places = {
  org: Org;
  town: Town;
  /** A row's place: its repository's Space and skill; null outside a Space. */
  ofRow: (row: Pick<Row, "machine" | "id" | "parent">) => Place | null;
  of: (machine: string, project: string) => Place | null;
  /** Each seat at work now, as its place. */
  working: Array<Place | null>;
};

export function usePlaces(rows: readonly Row[], orch: Record<string, Dict> = NO_ORCH, away: ReadonlySet<string> = NOBODY): Places {
  const { org } = useOrg();
  useEffect(() => {
    void refreshOrg().catch(() => {});
    const timer = setInterval(() => void refreshOrg().catch(() => {}), 60_000);
    return () => clearInterval(timer);
  }, []);
  return useMemo(() => {
    const town = townOf({ rows, orch, org, approvals: NO_APPROVALS, away, colorOf: () => "" });
    const of = (machine: string, project: string) => placeOf(town, org, machine, project);
    return { org, town, of, ofRow: (row) => of(row.machine, rowProject(row)), working: workingPlaces(town, org) };
  }, [rows, orch, org, away]);
}
