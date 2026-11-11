/**
 * A Space's boards: the tabs across the top of a
 * Space's screen. Overview is the screen as it was; then the boards its trades ship, each
 * named by the Space's kind (a business's CRM and Finance, a team's Roster and Dues, a
 * family's Contacts and Budget); then the boards Cobra made, marked as hers; then + to ask
 * her for one. Shared by the desk so both list the same tabs in one order.
 *
 * No zod here: the agent imports this file by path, as views.ts.
 */
import { BASELINE_SEATS, SPACE_KIND_INFO, SPACE_KINDS, type SeatRole, type SpaceKind } from "./spaces.ts";
import type { PublicView, ViewResult } from "./views.ts";
import { parsePublicView, parseViewResult } from "./viewsRead.ts";

export type BoardTab =
  | { id: "overview"; label: string; by: "overview" }
  /** A trade's board: the seat's dashboard with its charts, by the seat's key. */
  | { id: string; label: string; by: "trade"; seat: string }
  /** A board Cobra made and the person added (slice C), by its id in the Space store. */
  | { id: string; label: string; by: "cobra"; board: string }
  | { id: "add"; label: string; by: "add" };

/** What a tab needs to know of a seat: its key, its trade, its skill word, and whether its trade draws charts. */
export type BoardSeat = { key: string; trade?: string; skill: string; charts: boolean };

/** A Cobra-made board as a tab needs it. */
export type BoardName = { id: string; title: string };

/** A Space's kind from the words the apps show for it ("Team or group"); null for a plain company. */
export function kindOfWords(words: string | null | undefined): SpaceKind | null {
  return SPACE_KINDS.find((kind) => SPACE_KIND_INFO[kind].label === words) ?? null;
}

const SEAT_ROLES: readonly string[] = ["people", "money", "outreach"];
/** A board's name for a seat with no kind to name it by: a plain company's people and money. */
const PLAIN: Record<string, string> = { people: "CRM", money: "Finance" };

/** The tab's name for a trade's board: the kind's name for that seat, else CRM or Finance, else the skill word. */
export function tradeBoardName(kind: SpaceKind | null, seat: Pick<BoardSeat, "trade" | "skill">): string {
  const role = seat.trade && SEAT_ROLES.includes(seat.trade) ? (seat.trade as SeatRole) : null;
  if (role && kind) return BASELINE_SEATS[kind].find((b) => b.role === role)?.name ?? seat.skill;
  return (role && PLAIN[role]) || seat.skill;
}

/** Order: people, then money, then any other trade with charts, by its skill word. */
function rank(seat: BoardSeat): number {
  return seat.trade === "people" ? 0 : seat.trade === "money" ? 1 : 2;
}

/**
 * The tabs of a Space's screen: Overview, a board for each seat whose trade draws charts (a
 * second seat of one trade numbered), Cobra's boards, then +. A seat without charts keeps its
 * tile on Overview only.
 */
export function boardTabs(kind: SpaceKind | null, seats: readonly BoardSeat[], boards: readonly BoardName[] = []): BoardTab[] {
  const tabs: BoardTab[] = [{ id: "overview", label: "Overview", by: "overview" }];
  const seen = new Map<string, number>();
  const charted = seats.filter((s) => s.charts).sort((a, b) => rank(a) - rank(b) || a.skill.localeCompare(b.skill));
  for (const seat of charted) {
    const name = tradeBoardName(kind, seat);
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    tabs.push({ id: `seat:${seat.key}`, label: n === 1 ? name : `${name} ${n}`, by: "trade", seat: seat.key });
  }
  for (const board of boards) tabs.push({ id: `board:${board.id}`, label: board.title, by: "cobra", board: board.id });
  tabs.push({ id: "add", label: "+", by: "add" });
  return tabs;
}

/** What + puts in Cobra's box, with the Space's chip set: she asks what the board should show. */
export const BOARD_DRAFT = "Make a board for this Space that shows ";

/** A board Cobra made, as `GET /boards` lists it: its widgets without SQL. */
export type BoardInfo = { id: string; title: string; describe: string; by: "cobra"; views: PublicView[] };

/** `GET /boards?project=`: the Cobra-made boards of the Space a project is seated in (none for any other project). */
export type BoardList = { project: string; space: string | null; currency: string; boards: BoardInfo[] };

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Reads `GET /boards` leniently: a board with nothing this build can draw is left out. */
export function parseBoardList(input: unknown): BoardList {
  const raw = obj(input);
  const boards = (Array.isArray(raw.boards) ? raw.boards : []).flatMap((b): BoardInfo[] => {
    const one = obj(b);
    const views = (Array.isArray(one.views) ? one.views : []).map(parsePublicView).filter((v): v is PublicView => v !== null);
    return str(one.id) && str(one.title) && views.length ? [{ id: str(one.id), title: str(one.title), describe: str(one.describe), by: "cobra", views }] : [];
  });
  return { project: str(raw.project), space: str(raw.space) || null, currency: str(raw.currency) || "USD", boards };
}

/** A board card's widgets with the rows each had when Cobra made it, the ones this build can draw. */
export function boardPreview(board: { views: readonly unknown[]; preview: readonly unknown[] }): Array<{ view: PublicView; result: ViewResult }> {
  return board.views.flatMap((raw, i) => {
    const view = parsePublicView(raw);
    return view ? [{ view, result: parseViewResult(board.preview[i] ?? {}) }] : [];
  });
}
