/**
 * Home's charts, as data: today's project lanes, the budget, the throughput,
 * Done today and what waits on you. Pure, a port of the desk's ops.py (itself the phone's
 * apps/mobile/src/opsRules.ts, opsToday.ts and boardRules.ts); keep them in step by hand.
 * components/Charts.tsx draws it; ops.test.ts pins it.
 */
import { LEAD_NAME } from "./appName.ts";
import { nowS, truthy, type Dict } from "./json.ts";
import { boardTime, duration, get, parseIso, type Row } from "./model.ts";
import { pyRound, pySorted, pyStr } from "./py.ts";

// -- today's lanes --------------------------------------------------------------
// Today is one row per project, not per agent: the phone's opsToday.ts projectLanes,
// workedMs and laneSummary. Change both together.

/** What is drawn on top where segments overlap: a wait over work over the queue over idle. */
export const DRAW_ORDER: Readonly<Record<string, number>> = { idle: 0, queue: 1, work: 2, wait: 3 };

/** Every computer's lanes folded into one per project: its Foreman, Workers, extra sessions and
 * queued tasks (the agent tags each lane with its project). The Lead serves every project, has none,
 * and is left out. What waits on you first, then what works, then the most work today, then by name;
 * at most `most`. Each lane has `machine`, its segments in time order and `agents`, how many went in. */
export function projectLanes(histories: readonly (readonly [string, Dict | null | undefined])[], most = 8,
  now: number | null = null): [Dict[], number] {
  const at = now ?? nowS();
  const by = new Map<string, Dict>();
  for (const [machine, h] of histories) {
    for (const lane of (get(h || {}, "lanes") || []) as Dict[]) {
      const project = get(lane, "project");
      // A lane with nothing drawn today (an agent that only stopped) would be an empty "Idle" row.
      if (!truthy(project) || !truthy(get(lane, "segments"))) continue;
      const key = JSON.stringify([machine, project]);
      if (!by.has(key)) {
        by.set(key, { id: project, kind: "project", label: project, project, segments: [], machine, agents: 0 });
      }
      const seen = by.get(key)!;
      seen.segments.push(...(get(lane, "segments") || []));
      seen.agents += 1;
    }
  }
  let lanes = [...by.values()];
  for (const lane of lanes) lane.segments = pySorted(lane.segments as Dict[], (s) => parseIso(get(s, "from")) || 0);

  const live = (lane: Dict) => {
    const open = openStates(lane);
    return open.has("wait") ? 0 : open.has("work") ? 1 : 2;
  };
  lanes = pySorted(lanes, (lane) => [live(lane), -worked(lane, at), lane.label]);
  return [lanes.slice(0, most), Math.max(0, lanes.length - most)];
}

function openStates(lane: Dict): Set<string> {
  return new Set(((get(lane, "segments") || []) as Dict[]).filter((s) => get(s, "to") === null).map((s) => pyStr(get(s, "state"))));
}

/** Seconds anything worked in a lane today, overlapping agents counted once. */
export function worked(lane: Dict, now: number | null = null): number {
  const at = now ?? nowS();
  const spans: [number, number][] = [];
  for (const s of (get(lane, "segments") || []) as Dict[]) {
    if (get(s, "state") !== "work") continue;
    const a = parseIso(get(s, "from"));
    const b = get(s, "to") === null ? at : parseIso(get(s, "to"));
    if (a !== null && b !== null && b > a) spans.push([a, b]);
  }
  let total = 0, end = -Infinity;
  for (const [a, b] of pySorted(spans)) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

/** The words beside a project's name on Today: what it does now, and how much it worked. */
export function laneSummary(lane: Dict, now: number | null = null): string {
  const open = openStates(lane);
  const secs = worked(lane, now);
  const total = secs >= 60 ? `${duration(secs)} of work` : null;
  if (open.has("wait")) return ["Waiting for you", total].filter((w) => w).join(" · ");
  if (open.has("work")) return ["Working", total].filter((w) => w).join(" · ");
  if (total) return total;
  return open.has("queue") ? "Queued" : "Idle";
}

/** "9 AM", "12 PM", "3 PM": Today's hours as the phone writes them. */
export function hourLabel(hour: number): string {
  return `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
}

/** From the earliest whole hour of today's lanes (06:00 at the latest), to now; an hour at least. */
export function window(lanes: readonly Dict[], now: number): [number, number] {
  const six = new Date(now * 1000);
  six.setHours(6, 0, 0, 0);
  let start = six.getTime() / 1000;
  for (const lane of lanes) {
    const segments = (get(lane, "segments") || []) as Dict[];
    const first = segments.length ? parseIso(get(segments[0], "from")) : null;
    if (first !== null && first < start) start = first;
  }
  const h = new Date(start * 1000);
  h.setMinutes(0, 0, 0);
  return [Math.min(h.getTime() / 1000, now - 3600), now];
}

/** A segment as [left, width] fractions of the window, clipped to it; null when outside. */
export function place(segment: Dict, span: readonly [number, number]): [number, number] | null {
  const [frm, to] = span;
  let a = parseIso(get(segment, "from"));
  let b = get(segment, "to") === null ? to : parseIso(get(segment, "to"));
  if (a === null || b === null) return null;
  a = Math.max(frm, a);
  b = Math.min(to, b);
  if (b <= a) return null;
  return [(a - frm) / (to - frm), (b - a) / (to - frm)];
}

// -- done today -------------------------------------------------------------------
// What got done today, in place of the old Heads-up: the PRs merged and opened, one row each, newest
// first (a PR merged today is not listed again as opened), and the rest as one line of counts.

export interface DoneRow {
  key: string;
  time: string;
  title: string;
  /** "plant-shop #82" under a title; null when that is the title. */
  detail: string | null;
  /** MERGED | OPENED | LANDED */
  word: string;
  tone: string;
  machine: string;
  project: string | null;
  /** The PR on GitHub; null for a local landing. */
  url: string | null;
}

/** ["owner/repo", "82"] from "owner/repo#82" or a PR's URL. */
function prRef(detail: string): [string, string] | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(detail) || /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(detail);
  return m ? [m[1], m[2]] : null;
}

/** Every computer's `done` (an older agent sends none) as rows, how many more there were, and
 * today's counts in words from `days`, which every agent sends: "1 merged · 2 opened · 3 Workers
 * started · 1 answer from you". A line with no title takes its PR's from `prs` (every computer's
 * /prs answer) while that PR is still open. */
export function doneToday(histories: readonly (readonly [string, Dict | null | undefined])[], now: number | null = null, most = 8,
  prs: readonly (Dict | null | undefined)[] | null = null): [DoneRow[], number, string] {
  const titles = new Map<string, string>();
  for (const answer of prs || []) {
    for (const repo of (get(answer || {}, "repos") || []) as Dict[]) {
      for (const pr of (get(repo, "prs") || []) as Dict[]) {
        const ref = prRef(pyStr(get(pr, "url") || ""));
        if (ref && truthy(get(pr, "title"))) titles.set(`${ref[0]}#${ref[1]}`, pyStr(pr.title));
      }
    }
  }
  const rows: DoneRow[] = [];
  const merged = new Set<string>();
  const lines = pySorted(histories.flatMap(([m, h]) => ((get(h || {}, "done") || []) as Dict[]).map((d) => [m, d] as const)),
    (md) => parseIso(get(md[1], "at")) || 0, true);
  for (const [, d] of lines) {
    if (get(d, "kind") === "pr-merged") {
      const ref = prRef(pyStr(get(d, "detail") || ""));
      if (ref) merged.add(`${ref[0]}#${ref[1]}`);
    }
  }
  const seen = new Set<string>();
  for (const [m, d] of lines) {
    const kind = get(d, "kind"), detail = pyStr(get(d, "detail") || "");
    if (kind !== "pr-merged" && kind !== "pr-opened") continue;
    const ref = prRef(detail);
    const key = ref ? `${ref[0]}#${ref[1]}` : detail;
    if ((kind === "pr-opened" && merged.has(key)) || seen.has(`${kind}\u0000${key}`)) continue;
    seen.add(`${kind}\u0000${key}`);
    let where: string, url: string | null, word: string;
    if (ref) {
      const [repo, number] = ref;
      where = `${pyStr(get(d, "project") || repo.split("/").at(-1))} #${number}`;
      url = `https://github.com/${repo}/pull/${number}`;
      word = kind === "pr-merged" ? "MERGED" : "OPENED";
    } else {
      // A local landing: "project@abc1234".
      [where, url, word] = [detail.replaceAll("@", " @ "), null, "LANDED"];
    }
    const title = get(d, "title") || titles.get(key);
    rows.push({
      key: `${m}:${kind}:${key}`, time: boardTime(get(d, "at"), now), title: pyStr(title || where),
      detail: title ? where : null, word, tone: kind === "pr-merged" ? "ink" : "muted", machine: m,
      project: get(d, "project"), url,
    });
  }

  const total: Record<string, number> = { merged: 0, opened: 0, started: 0, answered: 0 };
  for (const [, h] of histories) {
    const today = get(h || {}, "today");
    for (const day of (get(h || {}, "days") || []) as Dict[]) {
      if (get(day, "date") === today) for (const k of Object.keys(total)) total[k] += Math.trunc(Number(get(day, k) || 0));
    }
  }
  const words = [
    total.merged ? `${total.merged} merged` : "",
    total.opened ? `${total.opened} opened` : "",
    total.started ? `${total.started} ${total.started === 1 ? "Worker" : "Workers"} started` : "",
    total.answered ? `${total.answered} ${total.answered === 1 ? "answer" : "answers"} from you` : "",
  ];
  return [rows.slice(0, most), Math.max(0, rows.length - most), words.filter((w) => w).join(" · ")];
}

// -- budget and throughput ------------------------------------------------------

/** Each subscription once per account, the fullest reading winning: computers signed in to one
 * account share its windows, and one signed in to another gets a gauge of its own. A reading with no
 * account (an older agent) joins the account its subscription has elsewhere, else stands alone
 * (the phone's opsRules.ts mergeBudget: change both together). */
export function mergeBudget(statuses: readonly (Dict | null | undefined)[]): Dict[] {
  const named = new Map<string, Set<string>>();
  for (const status of statuses) {
    for (const g of (get(status || {}, "budget") || []) as Dict[]) {
      if (truthy(get(g, "account"))) {
        const id = pyStr(get(g, "id"));
        if (!named.has(id)) named.set(id, new Set());
        named.get(id)!.add(pyStr(g.account));
      }
    }
  }
  const seen = new Map<string, { key: [string, string]; g: Dict }>();
  for (const status of statuses) {
    for (const g of (get(status || {}, "budget") || []) as Dict[]) {
      const gid = pyStr(get(g, "id"));
      const accounts = named.get(gid) || new Set<string>();
      const account = pyStr(get(g, "account") || (accounts.size === 1 ? [...accounts][0] : ""));
      const key = JSON.stringify([gid, account]);
      const prev = seen.get(key);
      if (!prev || get(g, "percent", 0) > get(prev.g, "percent", 0)) {
        seen.set(key, { key: [gid, account], g: { ...g, ...(account ? { account } : {}) } });
      }
    }
  }
  return pySorted([...seen.values()], (v) => v.key).map((v) => v.g);
}

/** Every computer's daily counts, summed by date, oldest first. */
export function mergeDays(histories: readonly (Dict | null | undefined)[]): Dict[] {
  const by = new Map<string, Dict>();
  for (const h of histories) {
    for (const d of (get(h || {}, "days") || []) as Dict[]) {
      if (!by.has(d.date)) by.set(d.date, { date: d.date, started: 0, opened: 0, merged: 0, answered: 0 });
      const s = by.get(d.date)!;
      for (const k of ["started", "opened", "merged", "answered"]) s[k] += Math.trunc(Number(get(d, k) || 0));
    }
  }
  return pySorted([...by.keys()]).map((k) => by.get(k)!);
}

/** A gauge's name: the subscriptions by name, the API lane as API credits (the phone's opsRules.ts gaugeName). */
export function gaugeName(gaugeId: string | null | undefined): string {
  const names: Record<string, string> = { claude: "Claude", codex: "Codex", api: "API credits" };
  return Object.prototype.hasOwnProperty.call(names, gaugeId || "") ? names[gaugeId || ""] : pyStr(gaugeId ?? null);
}

/** Whether API credits take Claude's work now: the lane's gauge is there and its cap is not used. */
export function laneCovers(gauges: readonly Dict[]): boolean {
  return gauges.some((g) => get(g, "id") === "api" && get(g, "state") !== "hold");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ["82%", "HOLD · 14:00"]: the value, and a word with the reset. Claude at HOLD
 * says when API credits take its work; the API lane's HOLD is its cap used
 * (the phone's opsRules.ts gaugeWords: change both together). */
export function gaugeWords(g: Dict, now: number | null = null, gauges: readonly Dict[] | null = null): [string, string] {
  const at = now ?? nowS();
  const value = `${pyRound(Number(get(g, "percent") || 0) * 100)}%`;
  const reset = parseIso(get(g, "resetsAt"));
  let when = "";
  if (reset !== null) {
    const d = new Date(reset * 1000);
    when = reset - at < 86400
      ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
      : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }
  const state = get(g, "state");
  const hold = get(g, "id") === "api" ? "CAP USED"
    : get(g, "id") === "claude" && laneCovers(gauges || []) ? "HOLD · on API credits" : "HOLD";
  const prefix = state === "hold" ? hold : state === "tight" ? "TIGHT" : "resets";
  if (!when) return [value, prefix === "resets" ? "" : prefix];
  return [value, prefix === "resets" ? `resets ${when}` : `${prefix} · ${when}`];
}

// -- what waits on you ------------------------------------------------------------

export interface Blocker {
  key: string;
  time: string;
  title: string;
  word: string;
  /** approval | claude | alert | diverged */
  kind: string;
  machine: string;
  approval: Dict | null;
  row: Row | null;
  alert: Dict | null;
}

/** Ranked by who is blocked: what the Lead asked you to allow first (it waits on you), then a
 * Claude parked on a dialog, a critical alert, a diverged checkout. */
export function blockers(approvals: Record<string, Dict[]>, rows: readonly Row[], alerts: Record<string, Dict[]>,
  now: number | null = null): Blocker[] {
  const out: Blocker[] = [];
  const blank = { approval: null, row: null, alert: null };
  for (const [machine, items] of Object.entries(approvals)) {
    for (const a of items) {
      if (get(a, "state", "pending") !== "pending") continue;
      out.push({ ...blank, key: `approval:${machine}:${pyStr(get(a, "id"))}`, time: boardTime(get(a, "createdAt"), now),
        title: pyStr(get(a, "title") || "Approve?"), word: "APPROVE", kind: "approval", machine, approval: a });
    }
  }
  for (const r of rows) {
    if (r.state === "needs" && r.project !== null) {
      out.push({ ...blank, key: `claude:${r.machine}:${r.id}`, time: boardTime(get(r.project, "lastActivityAt"), now),
        title: `${LEAD_NAME} · ${r.title}`, word: "WAITING", kind: "claude", machine: r.machine, row: r });
    }
  }
  for (const [machine, items] of Object.entries(alerts)) {
    for (const a of items) {
      if (get(a, "level") === "critical") {
        out.push({ ...blank, key: `alert:${machine}:${pyStr(get(a, "id"))}`, time: "—", title: pyStr(get(a, "title") || "Alert"),
          word: "ALERT", kind: "alert", machine, alert: a });
      }
    }
  }
  for (const r of rows) {
    if (r.project !== null && get(get(r.project, "git") || {}, "grade") === "Diverged") {
      out.push({ ...blank, key: `diverged:${r.machine}:${r.id}`, time: "—", title: r.name, word: "DIVERGED", kind: "diverged",
        machine: r.machine, row: r });
    }
  }
  return out;
}
