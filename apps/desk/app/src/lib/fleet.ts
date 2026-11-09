/**
 * The one poller (the desk's fleet.py). Everything on screen — the window, the
 * picker, the popups, the tray — and every notification reads from here, so
 * the agent is asked once per tick no matter how many surfaces are open. The
 * name is the desk's; in Cobra the "fleet" is the one agent on this computer. It lives in the main window, which is hidden and never closed;
 * the picker and the popup get its rows as events (`fleet-snapshot`).
 *
 * The clock is the Rust side's `tick` event, not a page timer: a hidden
 * webview's timers are throttled.
 */
import * as api from "./api.ts";
import * as config from "./config.ts";
import * as model from "./model.ts";
import { isDict, nowS, type Dict, type Json } from "./json.ts";

export const PROJECTS_EVERY = 5; // seconds; how soon a new "needs you" is seen
export const SLOW_EVERY = 30; // alerts
export const ORCH_EVERY = 15; // the work map and the budget, as the phone polls them
export const ORCH_HISTORY_EVERY = 60; // today's lanes and two weeks of counts
export const PRS_EVERY = 60; // open PRs: the agent serves git sync's copy, so this costs no gh call

type Listener = () => void;
type EventsListener = (events: model.Event[]) => void;

/** What the picker and the popup windows are sent after each tick. */
export interface Snapshot {
  machines: config.Machine[];
  polls: Record<string, { projects: Json; tmux: Json }>;
  approvals: Record<string, Dict[]>;
  now: number;
}

export class Fleet {
  rows: model.Row[] = [];
  unreachable: string[] = [];
  alerts: Record<string, Dict[]> = {};
  /** Machines whose agent answered the last tick. */
  reachable = new Set<string>();
  orch: Record<string, Dict> = {};
  orchHistory: Record<string, Dict> = {};
  approvals: Record<string, Dict[]> = {};
  prs: Record<string, Dict> = {};
  loaded = false;
  updatedAt = 0;
  /** Bumped on every change, for React's useSyncExternalStore. */
  version = 0;
  tracker = new model.EdgeTracker();
  /** Where this desk is in each agent's notices (boot, seq); see EdgeTracker.notices. */
  noticeCursor: Record<string, [string, number]> = {};
  lastPolls: Snapshot["polls"] = {};

  private listeners = new Set<Listener>();
  private eventListeners = new Set<EventsListener>();
  private busy = false;
  private nextAt = 0;
  private slowAt = 0;
  private orchAt = 0;
  private orchHistoryAt = 0;
  private prsAt = 0;

  // -- public ------------------------------------------------------------
  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  onEvents(fn: EventsListener): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  getVersion = () => this.version;

  /** Called every second; polls when due, or now after `refresh`. */
  tick(): void {
    if (this.busy || nowS() < this.nextAt) return;
    this.busy = true;
    this.poll()
      .then((snap) => this.apply(snap))
      .catch((e) => console.error("cobra-desktop: poll failed", e))
      .finally(() => {
        this.busy = false;
        this.nextAt = nowS() + PROJECTS_EVERY;
      });
  }

  /** Poll now rather than at the next tick — after any action. */
  refresh(): void {
    this.nextAt = 0;
    this.tick();
  }

  /** Poll now and read the PRs again — after a merge. */
  refreshPrs(): void {
    this.prsAt = 0;
    this.refresh();
  }

  /** Poll now and include the slow endpoints — after changing a machine. */
  refreshSlow(): void {
    this.slowAt = 0;
    this.refresh();
  }

  needsYou(): model.Row[] {
    return this.rows.filter((r) => r.state === "needs");
  }

  pendingApprovals(): number {
    return Object.values(this.approvals).reduce((n, v) => n + v.length, 0);
  }

  row(machine: string, session: string): model.Row | undefined {
    return this.rows.find((r) => r.machine === machine && r.session === session);
  }

  async answerApproval(machine: string, approval: string, allow: boolean, models?: Dict | null, accounts?: Record<string, number>, skip?: number[]): Promise<void> {
    await api.answerApproval(machine, approval, allow, models, accounts, skip);
    this.refresh();
  }

  snapshot(): Snapshot {
    return { machines: [...config.MACHINES], polls: this.lastPolls, approvals: this.approvals, now: this.updatedAt };
  }

  // -- the poll ----------------------------------------------------------
  private async poll() {
    const now = nowS();
    // The agent on this computer, on loopback (none before it is linked).
    const targets = [...config.MACHINES];
    const slow = now - this.slowAt >= SLOW_EVERY;
    const orch = now - this.orchAt >= ORCH_EVERY;
    const orchHistory = now - this.orchHistoryAt >= ORCH_HISTORY_EVERY;
    const prs = now - this.prsAt >= PRS_EVERY;

    const fetch = (m: config.Machine, path: string, timeout = 4) => api.get(m.machine, path, timeout).catch(() => null);
    const jobs: Array<Promise<void>> = [];
    const results = new Map<string, Json>();
    const want = (m: config.Machine, what: string, path: string, timeout?: number) =>
      jobs.push(fetch(m, path, timeout).then((v) => void results.set(`${m.machine}\u0000${what}`, v)));
    for (const m of targets) {
      want(m, "projects", "/projects");
      want(m, "tmux", "/tmux");
      want(m, "approvals", "/approvals");
      const cursor = this.noticeCursor[m.machine];
      want(m, "notices", cursor ? `/notices?boot=${api.q(cursor[0])}&after=${cursor[1]}` : "/notices");
      if (orch) want(m, "orch", "/orch/status", 8);
      if (orchHistory) want(m, "orch_history", "/orch/history?days=14", 8);
      if (prs) want(m, "prs", "/prs", 8);
      if (slow) want(m, "alerts", "/alerts");
    }
    await Promise.all(jobs);
    if (slow) this.slowAt = now;
    if (orch) this.orchAt = now;
    if (orchHistory) this.orchHistoryAt = now;
    if (prs) this.prsAt = now;
    const res = (m: string, what: string) => results.get(`${m}\u0000${what}`) ?? null;
    return { now, targets: targets.map((m) => m.machine), res, slow };
  }

  private apply(snap: Awaited<ReturnType<Fleet["poll"]>>): void {
    const { res } = snap;
    const polls: Snapshot["polls"] = {};
    for (const m of snap.targets) polls[m] = { projects: res(m, "projects"), tmux: res(m, "tmux") };
    // Keep the last good rows for a machine whose agent did not answer this
    // tick, so a blip does not empty the lists or fire a "cleared".
    const answered = new Set(snap.targets.filter((m) => Array.isArray(polls[m].projects?.projects)));
    const kept = this.rows.filter((r) => !answered.has(r.machine) && snap.targets.includes(r.machine));
    const fresh: Snapshot["polls"] = {};
    for (const m of answered) fresh[m] = polls[m];
    for (const m of Object.keys(this.lastPolls)) if (!answered.has(m) && snap.targets.includes(m)) fresh[m] = this.lastPolls[m];
    this.lastPolls = fresh;
    const built = model.buildRows(Object.fromEntries([...answered].map((m) => [m, polls[m]])), snap.now);
    this.rows = [...built, ...kept].sort(
      (a, b) => a.rank - b.rank || cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.label, b.label),
    );
    this.unreachable = snap.targets.filter((m) => !answered.has(m)).map((m) => config.label(m));
    this.reachable = answered;

    const events: model.Event[] = [];
    for (const m of answered) {
      // An agent that serves /notices says itself what is news (its notifyPolicy.ts).
      const n = res(m, "notices");
      const told = isDict(n) && Array.isArray(n.notices) && Number.isInteger(n.seq);
      events.push(...this.tracker.projects(m, this.rows, snap.now, told));
      if (told) {
        this.noticeCursor[m] = [String(n.boot ?? ""), n.seq];
        events.push(...this.tracker.notices(m, this.rows, n.notices));
      }
    }
    for (const m of snap.targets) {
      // An agent too old for any of these answers 404: it simply has none.
      const a = res(m, "approvals");
      if (isDict(a) && Array.isArray(a.approvals)) {
        this.approvals[m] = a.approvals.filter((x: Dict) => (x.state ?? "pending") === "pending");
        events.push(...this.tracker.approvals(m, this.approvals[m]));
      }
      const o = res(m, "orch");
      if (isDict(o) && Array.isArray(o.workers)) this.orch[m] = o;
      const h = res(m, "orch_history");
      if (isDict(h) && Array.isArray(h.lanes)) this.orchHistory[m] = h;
      const p = res(m, "prs");
      if (isDict(p) && Array.isArray(p.repos)) this.prs[m] = p;
    }
    for (const store of [this.approvals, this.orch, this.orchHistory, this.prs] as Record<string, Json>[]) {
      for (const m of Object.keys(store)) if (!snap.targets.includes(m)) delete store[m];
    }
    if (snap.slow) {
      for (const m of snap.targets) {
        const a = res(m, "alerts");
        if (a !== null) {
          this.alerts[m] = a?.alerts ?? [];
          events.push(...this.tracker.alerts(m, this.alerts[m]));
        }
      }
      for (const m of Object.keys(this.alerts)) if (!snap.targets.includes(m)) delete this.alerts[m];
    }
    this.loaded = true;
    this.updatedAt = snap.now;
    this.version++;
    for (const fn of this.listeners) fn();
    if (events.length) for (const fn of this.eventListeners) fn(events);
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
