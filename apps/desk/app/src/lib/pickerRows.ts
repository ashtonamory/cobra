/**
 * What the picker writes on each line and in its count (the pure parts of the
 * desk's ui/picker.py), so they are tested without a window.
 */
import * as model from "./model.ts";
import { truthy } from "./json.ts";

/** A row's state as a pill tone (the desk's common.STATE_TONE). */
export const STATE_TONE: Readonly<Record<string, string>> = {
  needs: "needs", working: "working", agent: "idle", shell: "idle", none: "idle", loose: "idle", "loose-live": "working",
};

/** An agent by its agent name (Cobra, a Foreman, a Worker's title); a project by its name. */
export function lineName(r: model.Row): string {
  return r.lead || r.foreman || truthy(r.worker) || r.isExtra ? model.agentName(r) : r.name;
}

/** The pill's word: "idle" for an idle agent, "—" for one not started, else the meta's first word. */
export function lineWord(r: model.Row): string {
  if (r.state === "agent") return "idle";
  if (r.state === "none") return "—";
  return r.meta.split(" ")[0];
}

/** The count by the search box: "3/40" while filtering, else "4 agents · 40 sessions" or "40 projects". */
export function countText(grouped: readonly (readonly [string, model.Row])[], total: number, text: string): string {
  if (text) return `${grouped.length}/${total}`;
  const agents = grouped.filter(([g]) => g === "Agents").length;
  return agents ? `${agents} agents · ${total} sessions` : `${total} projects`;
}

/** Tab: the next row with the same name (the project on another machine), else simply the next one. */
export function nextMachine(rows: readonly model.Row[], at: number): number {
  const cur = rows[at];
  if (!cur) return at;
  const same = rows.map((r, i) => [r, i] as const).filter(([r]) => r.name === cur.name).map(([, i]) => i);
  if (same.length < 2) return Math.max(0, Math.min(rows.length - 1, at + 1));
  const k = same.indexOf(at);
  return k >= 0 ? same[(k + 1) % same.length] : same[0];
}
