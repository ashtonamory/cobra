/**
 * Spaces: what a company becomes when Cobra opens it from an intake
 *. A Space has a kind, one home computer, a folder with
 * a profile, and three baseline seats named by its kind.
 *
 * No zod here: the agent imports this file by path and runs with no
 * node_modules (`apps/agent/scripts/package.sh` ships it beside org.ts).
 */

/** The four things a Space can be, in the order the intake offers them. */
export const SPACE_KINDS = ["client", "own", "team", "family"] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

export function isSpaceKind(value: unknown): value is SpaceKind {
  return typeof value === "string" && (SPACE_KINDS as readonly string[]).includes(value);
}

/** The kind as the person reads it, and one line on what it is, for the intake's picker. */
export const SPACE_KIND_INFO: Record<SpaceKind, { label: string; hint: string }> = {
  client: { label: "Client business", hint: "A business you work for" },
  own: { label: "My own business", hint: "One of your ventures" },
  team: { label: "Team or group", hint: "A club, band, volunteers" },
  family: { label: "Family or personal", hint: "Home, kids, a project" },
};

/** What each baseline seat is for: one talks to the world, one knows the people, one handles money. */
export const SEAT_ROLES = ["outreach", "people", "money"] as const;
export type SeatRole = (typeof SEAT_ROLES)[number];

/** A baseline seat: its role, the name the person reads, and the folder name inside the Space (one word each). */
export type BaselineSeat = { role: SeatRole; name: string; directory: string };

export const BASELINE_SEATS: Record<SpaceKind, readonly [BaselineSeat, BaselineSeat, BaselineSeat]> = {
  client: [
    { role: "outreach", name: "Marketing", directory: "marketing" },
    { role: "people", name: "CRM", directory: "crm" },
    { role: "money", name: "Finance", directory: "finance" },
  ],
  own: [
    { role: "outreach", name: "Marketing", directory: "marketing" },
    { role: "people", name: "CRM", directory: "crm" },
    { role: "money", name: "Finance", directory: "finance" },
  ],
  team: [
    { role: "outreach", name: "Announcements", directory: "announcements" },
    { role: "people", name: "Roster", directory: "roster" },
    { role: "money", name: "Dues", directory: "dues" },
  ],
  family: [
    { role: "outreach", name: "Messages", directory: "messages" },
    { role: "people", name: "Contacts", directory: "contacts" },
    { role: "money", name: "Budget", directory: "budget" },
  ],
};

export function baselineSeats(kind: SpaceKind): readonly BaselineSeat[] {
  return BASELINE_SEATS[kind];
}

/** Which baseline seat a folder name or seat name is, for a Space's kind; null for anything else (an extra Foreman). */
export function baselineSeatOf(kind: SpaceKind, word: string): BaselineSeat | null {
  const w = word.trim().toLowerCase();
  return BASELINE_SEATS[kind].find((seat) => seat.directory === w || seat.name.toLowerCase() === w) ?? null;
}

/** Whether the intake offers Sensitive on at first: a team or a family holds other people's details. */
export const SENSITIVE_BY_DEFAULT: Record<SpaceKind, boolean> = { client: false, own: false, team: true, family: true };

/** Foremen in one Space before Cobra asks instead of hiring (the baseline three count). */
export const MAX_SPACE_FOREMEN = 6;

/** The machine a Space is pinned to, as a seat names it (`<machine>/<project>`). */
export const HOME_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * What the intake learned, kept once in the Space's folder so a Foreman reads
 * it instead of asking again. Plain words, one field each, as the person said
 * them. Voice, tools and money are optional: a Family Space may have no
 * outgoing mail to give a voice to.
 */
export type SpaceProfile = {
  version: 1;
  /** What the Space is for. */
  purpose: string;
  /** Who it serves or who is in it. */
  people: string;
  /** How it talks to those people. */
  voice?: string;
  /** What it already uses: Google, Stripe, a booking app. */
  tools?: string;
  /** Pricing, billing, what is paid and to whom; dues and expenses for a team. */
  money?: string;
  /** Anything else the person said that a Foreman should know. */
  notes?: string;
  /** When it was written, ISO. */
  updated: string;
};

export const PROFILE_FIELD_MAX = 1500;

/** The profile's fields in reading order, with the heading each gets in profile.md. */
export const PROFILE_FIELDS: readonly { key: Exclude<keyof SpaceProfile, "version" | "updated">; heading: string }[] = [
  { key: "purpose", heading: "What it is for" },
  { key: "people", heading: "Who it serves" },
  { key: "voice", heading: "How it talks" },
  { key: "tools", heading: "What it already uses" },
  { key: "money", heading: "Money" },
  { key: "notes", heading: "Notes" },
];

const clean = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\r/g, "").trim().slice(0, PROFILE_FIELD_MAX);
  return text || undefined;
};

/** Read a profile from a file or a request leniently: null unless it has a purpose and people; unknown fields are dropped. */
export function parseProfile(value: unknown): SpaceProfile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const purpose = clean(raw.purpose);
  const people = clean(raw.people);
  if (!purpose || !people) return null;
  const updated = typeof raw.updated === "string" && !Number.isNaN(Date.parse(raw.updated)) ? raw.updated : new Date(0).toISOString();
  const out: SpaceProfile = { version: 1, purpose, people, updated };
  for (const key of ["voice", "tools", "money", "notes"] as const) {
    const text = clean(raw[key]);
    if (text) out[key] = text;
  }
  return out;
}

/** The profile as markdown a Foreman reads: the Space's name and kind, then each answer under its heading. */
export function profileText(name: string, kind: SpaceKind, profile: SpaceProfile): string {
  const lines = [`# ${name}`, "", `${SPACE_KIND_INFO[kind].label}. Written ${profile.updated.slice(0, 10)} from what the person told Cobra.`];
  for (const { key, heading } of PROFILE_FIELDS) {
    const text = profile[key];
    if (typeof text === "string" && text) lines.push("", `## ${heading}`, "", text);
  }
  return `${lines.join("\n")}\n`;
}
