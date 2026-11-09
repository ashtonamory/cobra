/**
 * My Organization's data as the apps build it from their own reads (`/projects`,
 * `/orch/status`, `/approvals`, `/org`): each Foreman's state, its company, its
 * trade's kind, Cobra's own state and her suggested move. Plain data, no DOM,
 * zod-free. The names are from the town these once drew (a pixel map, retired
 * for the chart); the chart reads `state`, `briefed`, `lead` and `proposal`.
 * The phone's `orgRules.ts` and the desk's `lib/org.ts` build it; change both together.
 */

/** A building's shape says its trade. */
export type BuildingKind = "workshop" | "bank" | "post" | "clock" | "mail" | "studio" | "tower" | "web";

/** A Foreman's state as the town shows it: lit and busy, a flag up, dark, or a computer that is away. */
export type TownState = "working" | "needs" | "idle" | "away";

export type TownForeman = {
  /** `<machine>/<project id>`: the same key as `/org` seats. */
  key: string;
  /** The project id the Foreman's sprite is drawn from (crew `foremanSpec`). */
  project: string;
  name: string;
  look: number;
  hat: number;
  kind: BuildingKind;
  /** The trade's name, or "Code" for a plain Foreman. */
  label: string;
  /** A company id, or null for New arrivals. */
  company: string | null;
  retired: boolean;
  state: TownState;
  /** Workers running for it now: drawn walking around its yard (at most 3). */
  workers: number;
  /** The colour of each computer it runs on, drawn as pennants. */
  pennants: string[];
  /** Briefed by Cobra: a blue line to HQ when lines are on. */
  briefed: boolean;
  /** A short question for its bubble when it needs you ("Merge #381?"). */
  ask?: string;
};

export type TownCompany = { id: string; name: string; color: string };

/** Cobra's suggested move, drawn as a blue bubble over HQ and a dashed path. */
export type TownProposal = { foreman: string; to: string; ask: string };

export type TownData = {
  companies: TownCompany[];
  foremen: TownForeman[];
  proposal?: TownProposal | null;
  /** Cobra's own state, drawn at HQ's door. */
  lead: "working" | "idle" | "away";
};

/** Which building a trade gets. Shipped trades by id; a defined trade or none: a studio or a workshop. */
export function buildingKindOf(trade: string | null | undefined): BuildingKind {
  switch (trade) {
    case undefined:
    case null:
    case "":
      return "workshop";
    case "payroll-manager":
      return "bank";
    case "billing":
      return "post";
    case "my-day":
      return "clock";
    case "lead-outreach":
      return "mail";
    case "website-builder":
      return "web";
    case "projects":
      return "tower";
    default:
      return "studio";
  }
}
