/**
 * My Organization on the desk, built from what the fleet poller already
 * reads: each computer's /projects rows (a seat per repository, its Foreman's
 * name and look from `crew`), its /orch/status
 * (each project's trade, whether Cobra briefed it), the org from the Lead's
 * computer (/org) and Cobra's pending `org` approvals. A port of the phone's
 * orgRules.ts: change both together.
 */
import { parseOrg, seatKey, type Org } from "../../../../../packages/contracts/src/org.ts";
import { buildingKindOf, type TownData, type TownForeman, type TownState } from "../../../../../packages/contracts/src/orgModel.ts";
import { isDict, type Dict } from "./json.ts";
import type { Row } from "./model.ts";

export type Seat = {
  key: string;
  /** The desk's name for the computer. */
  machine: string;
  /** The repository's project id there. */
  project: string;
  name: string;
  /** What this specialist is for, in one line, when the computer says (agent specialists.ts). */
  title?: string;
  /** The repository's own name, which a Space's seats start with the Space's name ("Happy Tails CRM"). */
  projectName: string;
  /** The repository's /projects entry, for its sprite. */
  repo: Dict;
  label: string;
  /** The trade's id (agent trades.ts), when the computer says which: what the seat's skill word comes from. */
  trade?: string;
  company: string | null;
  retired: boolean;
  state: TownState;
  /** The session that needs you, which the bubble opens. */
  needing: Row | null;
  /** The Foreman's own session, when one runs. */
  foreman: Row | null;
};

export type Town = { data: TownData; seats: Map<string, Seat>; proposal: { machine: string; approval: Dict } | null };

/** A repository, not a session in it, nor the Lead's folder. */
export function isRepository(row: Row): boolean {
  return row.project !== null && !row.parent && !row.lead && !row.foreman && !row.worker;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** The bubble's words, as the phone writes them. */
export function askWords(row: Row): string {
  const dialog = row.dialog;
  if (dialog === "permission") return row.request?.headline ? clip(row.request.headline, 26) : "Needs your OK";
  if (dialog === "trust") return "Trust this folder?";
  if (dialog === "model") return "Pick a model";
  return "Has a question";
}

export function leadState(rows: readonly Row[], away: ReadonlySet<string>): TownData["lead"] {
  const leads = rows.filter((row) => row.lead);
  if (!leads.length || leads.every((row) => away.has(row.machine))) return "away";
  return leads.some((row) => row.state === "working" && !away.has(row.machine)) ? "working" : "idle";
}

function roster(orch: Record<string, Dict>, machine: string, project: string): { trade?: string; tradeName?: string; briefed: boolean } {
  const status = orch[machine];
  const p = Array.isArray(status?.projects) ? (status.projects as unknown[]).find((x) => isDict(x) && x.id === project) : undefined;
  if (!isDict(p)) return { briefed: false };
  const trades = Array.isArray(status?.trades) ? (status.trades as unknown[]).filter(isDict) : [];
  const trade = typeof p.trade === "string" ? p.trade : undefined;
  const named = trade ? trades.find((t) => t.id === trade)?.name : undefined;
  return { ...(trade ? { trade, tradeName: typeof named === "string" ? named : trade } : {}), briefed: p.briefed === true };
}

export function townOf(input: {
  rows: readonly Row[];
  orch: Record<string, Dict>;
  org: Org;
  approvals: Record<string, Dict[]>;
  away: ReadonlySet<string>;
  colorOf: (machine: string) => string;
}): Town {
  const { rows, org, away } = input;
  const companies = new Set(org.companies.map((c) => c.id));
  const seats = new Map<string, Seat>();
  const foremen: TownForeman[] = [];
  for (const row of rows) {
    if (!isRepository(row)) continue;
    const p = row.project!;
    const host = typeof p.machine === "string" ? p.machine : row.machine;
    const key = seatKey(host, row.id);
    if (seats.has(key)) continue;
    const inside = rows.filter((other) => other.machine === row.machine && (other === row || other.parent === row.id));
    const gone = away.has(row.machine);
    const needing = gone ? undefined : inside.find((other) => other.state === "needs");
    const working = !gone && inside.some((other) => other.state === "working");
    const workers = gone ? 0 : inside.filter((other) => other.worker && other.state === "working").length;
    const r = roster(input.orch, row.machine, row.id);
    const trade = r.trade ?? (typeof p.foremanTemplate === "string" ? p.foremanTemplate : undefined);
    const label = r.tradeName ?? trade ?? "Code";
    const seat = org.seats[key];
    const company = seat?.company && companies.has(seat.company) ? seat.company : null;
    const retired = seat?.retired === true;
    const state: TownState = gone ? "away" : needing ? "needs" : working ? "working" : "idle";
    const crew = isDict(p.crew) ? p.crew : null;
    const name = typeof crew?.name === "string" ? crew.name : row.name;
    const title = typeof crew?.title === "string" && crew.title.trim() ? crew.title.trim() : undefined;
    seats.set(key, { key, machine: row.machine, project: row.id, name, ...(title ? { title } : {}), projectName: typeof p.name === "string" ? p.name : row.name, repo: p, label, ...(trade ? { trade } : {}), company, retired, state, needing: needing ?? null, foreman: inside.find((other) => other.foreman) ?? null });
    foremen.push({
      key,
      project: row.id,
      name,
      look: typeof crew?.look === "number" ? crew.look : 0,
      hat: typeof crew?.hat === "number" ? crew.hat : 0,
      kind: buildingKindOf(trade),
      label,
      company,
      retired,
      state,
      workers,
      pennants: [input.colorOf(row.machine)],
      briefed: r.briefed,
      ...(needing ? { ask: askWords(needing) } : {}),
    });
  }
  let proposal: Town["proposal"] = null;
  for (const [machine, list] of Object.entries(input.approvals)) {
    for (const approval of list) {
      const o = approval.org;
      if (proposal || approval.kind !== "org" || approval.state !== "pending" || !isDict(o) || typeof o.seat !== "string" || !seats.has(o.seat)) continue;
      proposal = { machine, approval };
    }
  }
  const o = proposal?.approval.org as Dict | undefined;
  const data: TownData = {
    companies: org.companies,
    foremen,
    lead: leadState(rows, away),
    proposal:
      o && typeof o.seat === "string"
        ? { foreman: o.seat, to: typeof o.company === "string" ? o.company : "", ask: clip(`${seats.get(o.seat)?.name ?? String(o.foreman)} → ${typeof o.companyName === "string" ? o.companyName : "a company"}?`, 32) }
        : null,
  };
  return { data, seats, proposal };
}

export function needingSeats(town: Town): Seat[] {
  return [...town.seats.values()].filter((seat) => seat.state === "needs" && !seat.retired).sort((a, b) => a.name.localeCompare(b.name));
}

export function summaryLine(town: Town): string {
  const active = [...town.seats.values()].filter((seat) => !seat.retired);
  const needs = active.filter((seat) => seat.state === "needs").length;
  const working = active.filter((seat) => seat.state === "working").length;
  return [`${active.length} ${active.length === 1 ? "Foreman" : "Foremen"}`, working ? `${working} working` : "", needs ? `${needs} need${needs === 1 ? "s" : ""} you` : ""].filter(Boolean).join(" · ");
}

/** One computer's /org reply, read leniently. */
export function orgReply(json: unknown): { org: Org; home: boolean } {
  return { org: parseOrg(isDict(json) ? json.org : null), home: isDict(json) && json.home === true };
}

/** Which computer keeps the fleet's org: the one that says so, else the newest revision, else the first. */
export function orgHome<T extends { machine: string; org: Org; home: boolean }>(reads: readonly T[]): T | null {
  const homes = reads.filter((read) => read.home);
  const pool = homes.length ? homes : reads;
  if (!pool.length) return null;
  const newest = Math.max(...pool.map((read) => read.org.revision));
  return pool.find((read) => read.org.revision === newest) ?? null;
}
