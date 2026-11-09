/**
 * My Organization as a chart on the desk: you, Cobra, then each Space with its Foremen under it, one
 * open at a time. A port of the phone's orgChartRules.ts (change both together) over this
 * app's seats (lib/org.ts townOf). Pure, so vitest pins it; pages/Org.tsx draws it.
 */
import { SPACE_KIND_INFO, baselineSeats, isSpaceKind } from "../../../../../packages/contracts/src/spaces.ts";
import type { Org, OrgCompany } from "../../../../../packages/contracts/src/org.ts";
import type { Seat, Town } from "./org.ts";

export type ChartSpace = {
  /** The company's id; null for New arrivals, the Foremen no company has yet. */
  id: string | null;
  name: string;
  color: string;
  /** "Team or group" for a Space; null for a plain company and for New arrivals. */
  kindWords: string | null;
  sensitive: boolean;
  seats: Seat[];
  needs: number;
  working: number;
};

export type Chart = { spaces: ChartSpace[]; outskirts: Seat[] };

export const NEW_ARRIVALS_COLOR = "#6b7288";

/** The role a Foreman has in its Space: what follows the Space's name in its project's ("Happy Tails CRM" is CRM); any other keeps its trade's name. */
export function seatRole(seat: Pick<Seat, "label" | "projectName">, spaceName: string): string {
  const prefix = `${spaceName} `;
  if (seat.projectName.length > prefix.length && seat.projectName.toLowerCase().startsWith(prefix.toLowerCase())) return seat.projectName.slice(prefix.length).trim();
  return seat.label;
}

/** A Space's baseline seats first, in the order the intake starts them, then the others by name. */
function ordered(seats: Seat[], company: OrgCompany): Seat[] {
  const roles = isSpaceKind(company.kind) ? baselineSeats(company.kind).map((seat) => seat.name.toLowerCase()) : [];
  const rank = (seat: Seat): number => {
    const index = roles.indexOf(seatRole(seat, company.name).toLowerCase());
    return index === -1 ? 3 : index;
  };
  return [...seats].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function space(id: string | null, name: string, color: string, kindWords: string | null, sensitive: boolean, seats: Seat[]): ChartSpace {
  return { id, name, color, kindWords, sensitive, seats, needs: seats.filter((s) => s.state === "needs").length, working: seats.filter((s) => s.state === "working").length };
}

export function chartOf(town: Town, org: Org): Chart {
  const seats = [...town.seats.values()];
  const live = seats.filter((seat) => !seat.retired);
  const spaces = org.companies.map((company) =>
    space(company.id, company.name, company.color, isSpaceKind(company.kind) ? SPACE_KIND_INFO[company.kind].label : null, company.sensitive === true, ordered(live.filter((seat) => seat.company === company.id), company)),
  );
  const arrivals = live.filter((seat) => seat.company === null).sort((a, b) => a.name.localeCompare(b.name));
  if (arrivals.length) spaces.push(space(null, "New arrivals", NEW_ARRIVALS_COLOR, null, false, arrivals));
  return { spaces, outskirts: seats.filter((seat) => seat.retired).sort((a, b) => a.name.localeCompare(b.name)) };
}

/** "3 Foremen · 1 needs you", under a Space's name. */
export function spaceLine(item: Pick<ChartSpace, "seats" | "needs">): string {
  const count = item.seats.length;
  const foremen = count === 0 ? "No Foremen yet" : `${count} ${count === 1 ? "Foreman" : "Foremen"}`;
  return item.needs ? `${foremen} · ${item.needs} need${item.needs === 1 ? "s" : ""} you` : foremen;
}

/** The status words on a Foreman's box. */
export function statusWords(seat: Pick<Seat, "state">): string {
  return seat.state === "needs" ? "needs you" : seat.state === "working" ? "working" : seat.state === "away" ? "away" : "idle";
}

/** Which Space is open when the page shows: the first with something waiting on you, else the first, else none (undefined). */
export function defaultOpen(chart: Chart): string | null | undefined {
  const first = chart.spaces.find((item) => item.needs > 0) ?? chart.spaces[0];
  return first ? first.id : undefined;
}
