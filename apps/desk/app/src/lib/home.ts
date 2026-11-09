/**
 * Home's rules (pages/Home.tsx, components/CobraChat.tsx): which Lead
 * Cobra's pane talks to, what she alerts you to beside it, and whether
 * today's morning brief was dismissed. A port of the phone's homeRules.ts and
 * morningRules.ts (todaysBrief); keep them in step by hand. Home is Cobra's
 * conversation first: the work map and the pull request list went (a Foreman
 * asks for a merge as an approval, which Cobra alerts like any other).
 */
import type { Blocker } from "./ops.ts";
import type { Dict } from "./json.ts";
import { get, parseIso, type Row } from "./model.ts";
import { LEAD_NAME } from "./appName.ts";

/**
 * The Lead Home talks to: of those running, one whose computer answers first,
 * then one that waits on you, then the most recently active. Null when no Lead
 * runs. `away` holds the labels of the computers that do not answer.
 */
export function homeLead(rows: readonly Row[], away: ReadonlySet<string>): Row | null {
  const leads = rows.filter((r) => r.lead);
  const rank = (r: Row) => (away.has(r.label) ? 2 : r.state === "needs" ? 0 : 1);
  const at = (r: Row) => parseIso(get(r.project || {}, "lastActivityAt")) ?? 0;
  return [...leads].sort((a, b) => rank(a) - rank(b) || at(b) - at(a))[0] ?? null;
}

/** What Cobra alerts you to: everything that waits on you less her own question, which her pane's dock answers. */
export function cobraAlerts(blockers: readonly Blocker[], lead: Row | null): Blocker[] {
  if (!lead) return [...blockers];
  return blockers.filter((b) => !(b.kind === "claude" && b.row?.machine === lead.machine && b.row.session === lead.session));
}

/** Cobra's line over her alerts, in her voice; null when nothing waits. */
export function alertWords(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "This needs you." : `These ${count} need you.`;
}

/** The line under Cobra's name. `computers` is how many are linked. */
export function leadStatus(lead: Row | null, computers: number, away: ReadonlySet<string>, working: boolean): string {
  if (!computers) return `Link a computer to talk to ${LEAD_NAME}`;
  if (!lead) return "Not running";
  if (away.has(lead.label)) return `${lead.label} is not answering`;
  if (lead.state === "needs") return "Asks you something";
  return working || lead.state === "working" ? "Working" : "Here";
}

/** YYYY-MM-DD of this computer's local day. */
export function localDay(nowMs: number): string {
  const at = new Date(nowMs);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/** Today's brief: from the computer that says it sends (the freshest when two do), or null when none went today. */
export function todaysBrief(reads: readonly (readonly [string, Dict])[], nowMs: number): { machine: string; brief: Dict } | null {
  const senders = reads.filter(([, status]) => status.sends === true);
  senders.sort(([, a], [, b]) => String(b.latest?.at ?? "").localeCompare(String(a.latest?.at ?? "")));
  const sender = senders[0];
  const brief = sender?.[1].latest;
  return sender && brief && brief.day === localDay(nowMs) ? { machine: sender[0], brief } : null;
}

/** Today's brief stays dismissed by its own time: tomorrow's comes back. */
export function briefDismissed(brief: Dict, dismissedAt: string | null): boolean {
  return dismissedAt !== null && dismissedAt === String(brief.at ?? "");
}
