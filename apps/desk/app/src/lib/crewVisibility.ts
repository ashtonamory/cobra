/**
 * The hidden crew on the desk: the person talks only to Cobra.
 * Her Foremen and Workers still do the work, but with Settings → This app → "Show the crew" off (the
 * default) nobody sees their names, sprites, the roster, Hire or code projects: a Space shows tiles by
 * skill, her thread one activity line, and what needs you names the Space or Cobra. The switch is kept
 * in this webview's storage as Appearance is (lib/theme.ts), so every window (main, popup, picker,
 * box) reads it and follows a change made in another. The rules are pure so vitest pins them; the
 * switch on means everything works as it did before.
 */
import { useSyncExternalStore } from "react";
import type { Org } from "../../../../../packages/contracts/src/org.ts";
import type { Seat, Town } from "./org.ts";
import type { Chart, ChartSpace } from "./orgChart.ts";
import { LEAD_NAME } from "./appName.ts";

export const SHOW_CREW_KEY = "cobra.showCrew";
export const SHOW_CREW_LABEL = "Show the crew";
export const SHOW_CREW_HELP = `Shows ${LEAD_NAME}'s Foremen and Workers, their names and code projects. For you only; nobody else sees them.`;

/** Only "on" shows the crew; anything else (nothing kept, a private window) hides it. */
export function parseShowCrew(raw: string | null | undefined): boolean {
  return raw === "on";
}

export function readShowCrew(): boolean {
  try {
    return parseShowCrew(localStorage.getItem(SHOW_CREW_KEY));
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();
let current: boolean | null = null;

export function saveShowCrew(on: boolean): void {
  try {
    if (on) localStorage.setItem(SHOW_CREW_KEY, "on");
    else localStorage.removeItem(SHOW_CREW_KEY);
  } catch {
    // A private window keeps the choice for this window only.
  }
  current = on;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another window's change comes as a `storage` event in this one.
  const storage = (e: StorageEvent) => {
    if (e.key === SHOW_CREW_KEY || e.key === null) {
      current = readShowCrew();
      listener();
    }
  };
  window.addEventListener("storage", storage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", storage);
  };
}

function snapshot(): boolean {
  current ??= readShowCrew();
  return current;
}

/** Whether the crew is shown, following the switch in every window. */
export function useShowCrew(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

// -- skills -----------------------------------------------------------------------

/** Each shipped trade as one plain word (agent trades.ts): what the person reads on a Space's tile. */
const SKILL_WORDS: Readonly<Record<string, string>> = {
  people: "People", outreach: "Outreach", money: "Money", "website-builder": "Website", designer: "Designer",
  billing: "Billing", "payroll-manager": "Payroll", "lead-outreach": "Leads", "my-day": "My day", inbox: "Inbox",
  "sign-ups": "Sign-ups", projects: "Projects",
};
/** Words that name the worker, not the work: "Social Media Manager" is Social Media. */
const ROLE_NOUNS = new Set(["manager", "builder", "keeper", "assistant", "specialist", "coordinator", "foreman"]);

/** A seat's skill as a plain word: its trade's word, else its trade's name less the worker's noun. */
export function skillWord(seat: Pick<Seat, "trade" | "label">): string {
  if (seat.trade && SKILL_WORDS[seat.trade]) return SKILL_WORDS[seat.trade]!;
  const label = seat.label.trim();
  if (SKILL_WORDS[label]) return SKILL_WORDS[label]!;
  // A defined trade's id ("social-media") when the computer gave no name.
  const named = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(label) ? label.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()) : label;
  const words = named.split(/\s+/).filter((w) => w && !ROLE_NOUNS.has(w.toLowerCase()));
  return words.join(" ") || named || "Work";
}

export type SkillTile = { seat: Seat; skill: string };

/** One tile per seat, labelled by its skill; a second seat of the same skill is "Website 2". */
export function skillTiles(seats: readonly Seat[]): SkillTile[] {
  const seen = new Map<string, number>();
  return seats.map((seat) => {
    const word = skillWord(seat);
    const n = (seen.get(word) ?? 0) + 1;
    seen.set(word, n);
    return { seat, skill: n === 1 ? word : `${word} ${n}` };
  });
}

/** "People, Outreach and Money" (at most `max`, then "and 2 more"). */
export function andList(words: readonly string[], max = 3): string {
  const shown = words.slice(0, max);
  const rest = words.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

const needWords = (n: number) => `${n} need${n === 1 ? "s" : ""} you`;

/** The line under a Space with the crew hidden: its skills, and what needs you. */
export function spaceSkillsLine(item: Pick<ChartSpace, "seats" | "needs">): string {
  const skills = skillTiles(item.seats).map((t) => t.skill);
  const head = skills.length ? andList(skills) : "Nothing set up yet";
  return item.needs ? `${head} · ${needWords(item.needs)}` : head;
}

/** The chart the person sees: with the crew hidden, no New arrivals (code projects) and no Outskirts. */
export function visibleChart(chart: Chart, show: boolean): Chart {
  if (show) return chart;
  return { spaces: chart.spaces.filter((item) => item.id !== null), outskirts: [] };
}

/** The Org bar's line with the crew hidden: "2 Spaces · 1 needs you". */
export function spacesSummary(chart: Chart): string {
  const count = chart.spaces.length;
  const needs = chart.spaces.reduce((n, item) => n + item.needs, 0);
  const head = count === 0 ? "No Spaces yet" : `${count} ${count === 1 ? "Space" : "Spaces"}`;
  return needs ? `${head} · ${needWords(needs)}` : head;
}

/** A Space with no seats yet, with the crew hidden: Cobra hires each skill the first time a request needs it. */
export function emptySpaceWords(name: string): string {
  return `Nothing here yet. Ask ${LEAD_NAME} for something in ${name}.`;
}

// -- where work happens -----------------------------------------------------------

/** Which Space a project sits in and its skill there; null for a project in no Space (a code project). */
export type Place = { space: string; skill: string };

export function placeOf(town: Town, org: Org, machine: string, project: string): Place | null {
  for (const seat of town.seats.values()) {
    if (seat.machine !== machine || seat.project !== project) continue;
    if (seat.retired || !seat.company) return null;
    const company = org.companies.find((c) => c.id === seat.company);
    if (!company) return null;
    const tiles = skillTiles(townSeats(town, seat.company));
    return { space: company.name, skill: tiles.find((t) => t.seat.key === seat.key)?.skill ?? skillWord(seat) };
  }
  return null;
}

function townSeats(town: Town, company: string): Seat[] {
  return [...town.seats.values()].filter((s) => s.company === company && !s.retired);
}

/** The repository a row works in: a Foreman's, a Worker's or an extra session's parent, else its own. */
export function rowProject(row: { id: string; parent: string | null }): string {
  return row.parent ?? row.id;
}

/** Who asks, with the crew hidden: "Happy Tails · People", or Cobra for her own and anything outside a Space. */
export function whoWords(place: Place | null): string {
  return place ? `${place.space} · ${place.skill}` : `${LEAD_NAME}`;
}

/**
 * The one activity line in Cobra's thread instead of the Foremen and Workers at work: in one Space
 * "Working on People and Website in Happy Tails", in several "Working on Happy Tails and Fern & Field",
 * work in no Space "Working in the background"; null when nothing works.
 */
export function activityLine(working: ReadonlyArray<Place | null>): string | null {
  if (!working.length) return null;
  const places = working.filter((p): p is Place => p !== null);
  const spaces = [...new Set(places.map((p) => p.space))];
  if (!spaces.length) return "Working in the background";
  if (spaces.length === 1) {
    const skills = [...new Set(places.map((p) => p.skill))];
    return `Working on ${andList(skills)} in ${spaces[0]}`;
  }
  return `Working on ${andList(spaces)}`;
}

/** What works now, each seat at work as its place (Space seats) or null (a code project). */
export function workingPlaces(town: Town, org: Org): Array<Place | null> {
  return [...town.seats.values()]
    .filter((seat) => seat.state === "working" && !seat.retired)
    .map((seat) => placeOf(town, org, seat.machine, seat.project));
}

// -- the Space chip ---------------------------------------------------------------

/** The Spaces the chip offers, in the org's order. */
export function spaceChoices(org: Org): Array<{ id: string; name: string }> {
  return org.companies.map((c) => ({ id: c.id, name: c.name }));
}

/** The chip's words: "Space: All ▾" or "Space: Happy Tails ▾". */
export function chipWords(name: string | null): string {
  return `Space: ${name ?? "All"} ▾`;
}

/** The message sent to Cobra with a Space picked: "[Space: Happy Tails] …", the phone's format exactly. */
export function withSpace(text: string, space: string | null): string {
  return space ? `[Space: ${space}] ${text}` : text;
}

/** The picked Space, still one of the org's; null (All) when it was closed or renamed away. */
export function pickedSpace(org: Org, id: string | null): { id: string; name: string } | null {
  if (!id) return null;
  return spaceChoices(org).find((c) => c.id === id) ?? null;
}

// -- lists ------------------------------------------------------------------------

/** The Agents list with the crew hidden: Cobra only (the desk has no general chats); everything when shown. */
export function visibleGroups<T>(groups: ReadonlyArray<readonly [string, T[]]>, show: boolean): Array<readonly [string, T[]]> {
  return show ? [...groups] : groups.filter(([title]) => title === "LEAD");
}

/** Whether a row is crew (a Foreman or a Worker), which the lists leave out when it is hidden. */
export function isCrew(row: { foreman: boolean; worker: unknown }): boolean {
  return row.foreman || Boolean(row.worker);
}
