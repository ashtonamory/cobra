/**
 * What the Agents page (the desk's ui/chat.py) works out before it draws anything: who is in the
 * inbox and under which heading, the words on a tool card or a slash command, and what the dock
 * shows for the dialog on screen. Pure, so it is tested without a window.
 */
import * as model from "./model.ts";
import { isDict, truthy, type Dict } from "./json.ts";
import { LEAD_NAME } from "./appName.ts";

export interface Inbox {
  /** LEAD, FOREMEN, WORKERS, SESSIONS, each with its rows; a heading with none is left out,
   * except WORKERS while tasks wait in the queue. */
  groups: Array<readonly [string, model.Row[]]>;
  /** Waiting tasks from each computer's queue, listed under WORKERS. */
  queued: Array<readonly [string, Dict]>;
  /** With no Lead running: the computer a "Start Cobra" row starts it on (the first one). */
  starter: string | null;
}

/** The inbox: the agents that run, the Lead pinned on top, then Foremen, Workers and the queue, and
 * your own sessions. */
export function inbox(rows: readonly model.Row[], orch: Record<string, Dict>, machines: readonly string[]): Inbox {
  const live = rows.filter((r) => r.project && r.active);
  const all: Array<readonly [string, model.Row[]]> = [
    ["LEAD", live.filter((r) => r.lead)],
    ["FOREMEN", live.filter((r) => r.foreman)],
    ["WORKERS", live.filter((r) => r.worker)],
    ["SESSIONS", live.filter((r) => !(r.lead || r.foreman || r.worker))],
  ];
  const queued: Array<readonly [string, Dict]> = [];
  for (const [m, o] of Object.entries(orch)) {
    const queue = o?.queue;
    if (!Array.isArray(queue)) continue;
    for (const q of queue) if (isDict(q) && q.state === "waiting") queued.push([m, q]);
  }
  const starter = all[0][1].length ? null : (machines[0] ?? null);
  const groups = all.filter(([title, members]) => members.length || (title === "WORKERS" && queued.length));
  return { groups, queued, starter };
}

/**
 * A Foreman's roster (the agent's orch.ts `rosterOf`, from its computer's
 * /orch/status), as the phone's rosterRules.ts writes it: "Billing ·
 * Cobra's · 2 routines · 1 trusted". Empty when the status says nothing
 * of it. Change both together.
 */
export function rosterLine(orch: Record<string, Dict>, machine: string, project: string | null | undefined): string {
  const status = orch[machine];
  if (!project || !status || !Array.isArray(status.projects)) return "";
  const p = (status.projects as unknown[]).find((x) => isDict(x) && x.id === project) as Dict | undefined;
  if (!p) return "";
  const trades = Array.isArray(status.trades) ? (status.trades as unknown[]).filter(isDict) : [];
  const trade = typeof p.trade === "string" ? String(trades.find((t) => t.id === p.trade)?.name ?? p.trade) : "";
  const on = isDict(p.routines) && typeof p.routines.on === "number" ? p.routines.on : 0;
  const trusted = Array.isArray(p.trusted) ? p.trusted.length : 0;
  return [trade, p.briefed === true ? `${LEAD_NAME}'s` : "", on ? `${on} routine${on === 1 ? "" : "s"}` : "", trusted ? `${trusted} trusted` : ""].filter((x) => x).join(" · ");
}

/** A slash command as it ran: "/compact focus", then what it printed. */
export function commandText(r: Dict): string {
  let out = `/${r.name}` + (truthy(r.args) ? ` ${r.args}` : "");
  if (truthy(r.output)) out += `\n${r.output}`;
  return out;
}

/** A run of tool calls folded into one card: its heading, and a line per call. */
export function toolCard(tools: readonly Dict[]): { head: string; lines: string[] } {
  const lines = tools.map((t) => `${t.status === "ok" ? "✓" : t.status === "error" ? "✗" : "…"} ${t.summary}`);
  const n = tools.length;
  const last = n ? tools[n - 1].summary : "";
  return { head: `${n} tool call${n !== 1 ? "s" : ""} · ${last}`, lines };
}

/** What a toast says after a copy link was clicked. */
export function copiedWord(value: string): string {
  return value.startsWith("http://") || value.startsWith("https://") ? "Link copied" : "Copied";
}

export interface Dock {
  /** The dialog on screen now; null when nothing waits on you. */
  dialog: string | null;
  /** The question to answer, when the dialog is one this view can draw. */
  active: Dict | null;
  /** The permission prompt in plain words, when the agent sends them. */
  request: model.PermissionRequest | null;
  /** The screen's last lines, for a permission prompt with no words from the agent. */
  tail: string;
  /** Changes whenever the dock must be drawn afresh (and a half-answered question start over). */
  key: string;
}

export function dockOf(entries: readonly Dict[], screen: Dict | null): Dock {
  const s: Dict = screen || {};
  const dialog = truthy(s.needsInput) && s.dialog ? String(s.dialog) : null;
  const active = dialog === "question" ? model.activeQuestion(entries, screen) : null;
  const request = dialog === "permission" ? model.permissionRequest(s) : null;
  const lines = (Array.isArray(s.tail) ? s.tail : []).map((t) => String(t));
  const tail = lines.filter((t) => t.trim()).join("\n");
  const key = JSON.stringify([dialog, active ? active.key : null, lines,
    request ? [request.headline, request.plain, request.why, request.exact] : null]);
  return { dialog, active, request, tail, key };
}

/** A narrow window shows the list or the conversation, not both. */
export function layout(compact: boolean, hasTarget: boolean, browsing: boolean): { side: boolean; chat: boolean } {
  const chat = !compact || (hasTarget && !browsing);
  return { side: !compact || !chat, chat };
}
