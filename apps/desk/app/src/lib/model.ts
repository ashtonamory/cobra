/**
 * Pure logic: no DOM, no Tauri, no network. A port of the desk's cobradesk/model.py (itself a
 * port of code the phone already tests: apps/mobile/src/chat.ts, git.ts, usage.ts, history.ts,
 * repos.ts, tidy.ts, audit.ts). Keep them in step by hand.
 *
 * Times are seconds since the epoch (floats), as Python's time.time().
 */
import { APP_NAME } from "./appName.ts";
import * as config from "./config.ts";
import { LEAD_NAME } from "./crew.ts";
import { isDict, nowS, truthy, type Dict, type Json } from "./json.ts";
import { cobraNote } from "./threadRules.ts";

// -- Python helpers ---------------------------------------------------------

/** Python's round(x) to an integer: halves go to the even neighbour. */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python's f"{x:.{digits}f}": correctly rounded from the float's exact value, and an exact half
 * goes to the even neighbour (JavaScript's toFixed takes it away from zero). */
export function pyFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return x.toFixed(digits);
  // A tie has an exact decimal expansion of digits + 1 places ending in 5; with 30 more places
  // shown exactly, no other double can look like one.
  const wide = Math.abs(x).toFixed(Math.min(100, digits + 30));
  const dot = wide.indexOf(".");
  const after = wide.slice(dot + 1 + digits);
  if (/^50*$/.test(after)) {
    const kept = wide.slice(0, dot + 1 + digits).replace(/\.$/, "");
    const lastDigit = Number(kept[kept.length - 1]);
    if (lastDigit % 2 === 0) return (x < 0 ? "-" : "") + kept;
  }
  return x.toFixed(digits);
}

/** Python's str() for the values the agent sends: None, True, False, numbers, strings. */
export function pyStr(v: Json): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** dict.get(key, default): only an own key counts, so "constructor" is never found on {}. */
export function get(d: Json, key: string, dflt: Json = null): Json {
  if (!isDict(d) || !Object.prototype.hasOwnProperty.call(d, key)) return dflt;
  const v = d[key];
  return v === undefined ? dflt : v;
}

function own<T>(table: Readonly<Record<string, T>>, key: Json): T | undefined {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** Compares two Python sort-key tuples (numbers, booleans, strings, nested tuples). */
export function cmpKeys(a: readonly Json[], b: readonly Json[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (Array.isArray(x) && Array.isArray(y)) {
      const c = cmpKeys(x, y);
      if (c) return c;
      continue;
    }
    const xv = typeof x === "boolean" ? Number(x) : x;
    const yv = typeof y === "boolean" ? Number(y) : y;
    if (xv < yv) return -1;
    if (xv > yv) return 1;
  }
  return a.length - b.length;
}

/** sorted(items, key=…): stable, by tuple keys. */
export function sortedBy<T>(items: Iterable<T>, keyOf: (item: T) => readonly Json[]): T[] {
  return [...items].map((item) => [keyOf(item), item] as const)
    .sort((p, q) => cmpKeys(p[0], q[0])).map((p) => p[1]);
}

function upperFirst(s: string): string {
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}

// -- time -------------------------------------------------------------------

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?$/i;

/** datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp(); no offset means local time. */
export function parseIso(value: Json): number | null {
  if (!truthy(value)) return null;
  const m = ISO.exec(String(value));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) => Number(x ?? 0));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const frac = m[7] ? Number(`0.${m[7]}`) : 0;
  const zone = m[8];
  let ms: number;
  if (zone) {
    const dt = new Date(Date.UTC(2000, mo - 1, d, h, mi, s));
    dt.setUTCFullYear(y, mo - 1, d);
    if (dt.getUTCDate() !== d) return null;
    ms = dt.getTime();
    if (zone.toUpperCase() !== "Z") {
      const sign = zone[0] === "-" ? -1 : 1;
      const digits = zone.slice(1).replace(/:/g, "");
      const off = Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4) || 0) * 60 + Number(digits.slice(4, 6) || 0);
      ms -= sign * off * 1000;
    }
  } else {
    const dt = new Date(2000, mo - 1, d, h, mi, s);
    dt.setFullYear(y, mo - 1, d);
    if (dt.getDate() !== d) return null;
    ms = dt.getTime();
  }
  return ms / 1000 + frac;
}

/** Terse, for narrow columns: now / 4m / 3h / 2d. */
export function ago(value: Json, now?: number | null): string {
  const t = parseIso(value);
  return t === null ? "—" : since(t, now);
}

export function since(t: number, now?: number | null): string {
  const mins = Math.max(0, pyRound(((now || nowS()) - t) / 60));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = pyRound(mins / 60);
  return hrs < 24 ? `${hrs}h` : `${pyRound(hrs / 24)}d`;
}

// -- projects ---------------------------------------------------------------

// Readable names for an extra session. The phone's sessionNames.ts has the same
// rules (packages/contracts/src/sessionNames.ts): change both together.
export const KIND_WORDS: Readonly<Record<string, string>> = { feat: "Feature", fix: "Fix", chore: "Chore", docs: "Docs", wip: "WIP" };

/** "docs/lab-ste-guide-setup" -> ["docs", "lab-ste-guide-setup"]; the kind is null for an unknown prefix. */
export function branchParts(branch: string): readonly [string | null, string] {
  const at = branch.indexOf("/");
  if (at >= 0) {
    const head = branch.slice(0, at);
    if (own(KIND_WORDS, head) !== undefined) return [head, branch.slice(at + 1)];
  }
  return [null, branch];
}

/** "lab-ste-guide-setup" -> "Lab ste guide setup": separators to spaces, the first letter up. */
export function humanizeSlug(slug: string): string {
  const words = slug.replace(/[-_/.\s]+/g, " ").trim();
  return upperFirst(words);
}

/** The prefix as a word: Docs, Fix, Feature, Chore, WIP; null for a branch with no known prefix. */
export function sessionTypeWord(branch: string): string | null {
  const [kind] = branchParts(branch);
  return kind ? KIND_WORDS[kind] : null;
}

/** A title from the branch alone: the prefix dropped (it is the type word), the slug humanized. */
export function fallbackTitle(branch: string): string {
  return humanizeSlug(branchParts(branch)[1]) || branch;
}

/** The agent's title for an extra session when it has one, else the branch made readable. */
export function sessionTitle(title: string | null | undefined, branch: string): string {
  const given = (title || "").trim();
  return given || fallbackTitle(branch);
}

export interface RowInit {
  id: string;
  name: string;
  machine: string;
  session: string;
  path: string;
  rank: number;
  state: string;
  meta: string;
  active: boolean;
  project?: Dict | null;
  parent?: string | null;
  branch?: string | null;
  lead?: boolean;
  worker?: Dict | null;
  foreman?: boolean;
  specialist?: boolean;
  givenTitle?: string | null;
}

/** One project or loose session, carrying what the UI shows *and* what
 * launching it needs, so no surface looks anything back up. */
export class Row {
  id: string;
  name: string;
  machine: string;
  session: string;
  path: string;
  rank: number;
  /** needs | working | agent | shell | none | loose | loose-live */
  state: string;
  meta: string;
  active: boolean;
  project: Dict | null;
  /** An extra Claude session of the project with this id, in its own worktree on its own branch. */
  parent: string | null;
  branch: string | null;
  /** The Lead: the orchestrator, listed while it runs. */
  lead: boolean;
  /** Set on an extra session the Lead started as a Worker: owner, task, model. */
  worker: Dict | null;
  /** A project's Foreman, listed under its project. */
  foreman: boolean;
  /** A specialist hired on its own (the agent's Project.specialist): the row is the specialist, not a project of the person's. */
  specialist: boolean;
  /** The agent's short name for an extra session, when it made one. */
  givenTitle: string | null;

  constructor(o: RowInit) {
    this.id = o.id;
    this.name = o.name;
    this.machine = o.machine;
    this.session = o.session;
    this.path = o.path;
    this.rank = o.rank;
    this.state = o.state;
    this.meta = o.meta;
    this.active = o.active;
    this.project = o.project ?? null;
    this.parent = o.parent ?? null;
    this.branch = o.branch ?? null;
    this.lead = o.lead ?? false;
    this.worker = o.worker ?? null;
    this.foreman = o.foreman ?? false;
    this.specialist = o.specialist ?? false;
    this.givenTitle = o.givenTitle ?? null;
  }

  get isExtra(): boolean {
    return Boolean(this.parent && this.branch) && !this.foreman;
  }

  /** The project's Foreman as its agent keeps it: name, look, hat; null from an older agent. */
  get crew(): Dict | null {
    const found = get(this.project || {}, "crew");
    return isDict(found) && typeof found.name === "string" ? found : null;
  }

  /** What a row is called: an extra session or Worker by its title (else its branch made
   * readable), the Lead as Cobra, the Foreman by its name (else its word), everything else by its name. */
  get title(): string {
    if (this.lead) return LEAD_NAME;
    if (this.foreman) {
      const crew = this.crew;
      return crew && truthy(crew) ? crew.name : "Foreman";
    }
    if (!this.isExtra) return this.name;
    return sessionTitle(this.givenTitle, this.branch || "");
  }

  /** `name` with an extra session's branch replaced by its title: "Cobra · Lab STE setup guide";
   * the Lead as Cobra and a named Foreman by its name. */
  get displayName(): string {
    if (this.lead || (this.foreman && truthy(this.crew))) return this.title;
    const suffix = ` · ${this.branch}`;
    if (this.isExtra && this.name.endsWith(suffix)) return `${this.name.slice(0, -suffix.length)} · ${this.title}`;
    // Hired on its own, the row is the specialist: its name first, then what the person calls its work.
    const crew = this.crew;
    if (this.specialist && this.parent === null && crew && truthy(crew)) return `${crew.name} · ${this.name}`;
    return this.name;
  }

  /** What kind of work an extra session is and what runs it: "Docs · sonnet". Empty for the rest. */
  get kindLine(): string {
    if (!this.isExtra) return "";
    const p = this.project || {};
    const model = truthy(this.worker)
      ? String(get(this.worker, "model") || "claude")
      : String(get(p, "localModel") || (get(p, "engine") === "codex" ? "Codex" : ""));
    const bare = model.startsWith("local:") ? model.slice("local:".length) : model;
    const runs = [bare, harnessLabel(this.project)].filter((x) => x).join(" ");
    return [sessionTypeWord(this.branch || ""), runs].filter((x) => x).join(" · ");
  }

  get label(): string {
    return config.label(this.machine);
  }

  get dialog(): string | null {
    return get(this.project || {}, "dialog");
  }

  /** The permission prompt on screen, whole and in plain words, when the agent sends it. */
  get request(): PermissionRequest | null {
    return permissionRequest(this.project);
  }

  get isAgent(): boolean {
    return this.state === "needs" || this.state === "working" || this.state === "agent";
  }
}

export function rowForProject(p: Dict, machine: string, now?: number | null): Row {
  const activity = get(p, "activity") || "none";
  let rank: number, state: string, meta: string;
  if (get(p, "needsInput") === true) [rank, state, meta] = [0, "needs", "needs you"];
  else if (activity === "agent-working") [rank, state, meta] = [1, "working", "working"];
  else if (activity === "busy") [rank, state, meta] = [1, "working", pyStr(get(p, "command") || "busy")];
  else if (activity === "agent-idle") [rank, state, meta] = [2, "agent", "idle " + ago(get(p, "lastActivityAt"), now)];
  else if (activity === "none") [rank, state, meta] = [5, "none", "not started"];
  else [rank, state, meta] = [3, "shell", "shell"];
  const title = get(p, "title");
  return new Row({
    id: pyStr(get(p, "id") || get(p, "session") || "?"),
    name: pyStr(get(p, "name") || get(p, "session") || "?"),
    machine, session: pyStr(get(p, "session") || ""), path: pyStr(get(p, "path") || ""),
    rank, state, meta, active: activity !== "none", project: p,
    parent: truthy(get(p, "parent")) ? pyStr(p.parent) : null,
    branch: truthy(get(p, "branch")) ? pyStr(p.branch) : null,
    lead: get(p, "lead") === true,
    worker: isDict(get(p, "worker")) ? p.worker : null,
    foreman: get(p, "foreman") === true,
    specialist: get(p, "specialist") === true,
    givenTitle: typeof title === "string" && title.trim() ? title : null,
  });
}

export function rowForSession(s: Dict, machine: string, now?: number | null): Row {
  // Only /projects reads panes, so a session nobody registered cannot report
  // a dialog. Recent output is the strongest honest claim available.
  const t = parseIso(get(s, "lastActivityAt"));
  const live = t !== null && (now || nowS()) - t < 60;
  const name = pyStr(get(s, "name") || "?");
  return new Row({
    id: `${machine}:${name}`, name, machine, session: name, path: "",
    rank: 4, state: live ? "loose-live" : "loose",
    meta: `${pyStr(get(s, "command") || "shell")} · ${ago(get(s, "lastActivityAt"), now)}`,
    active: true,
  });
}

export type Tone = readonly [string, string];

/** The chat list's word for a session, and its tone: you / busy / done / shell. "done" means the
 * agent finished its turn and is waiting for the next prompt, and says how long ago. */
export function sessionBadge(r: Row, now?: number | null): Tone {
  if (r.state === "needs") return ["you", "needs"];
  if (r.state === "working") return ["busy", "working"];
  if (r.state === "agent") {
    const when = ago(get(r.project || {}, "lastActivityAt"), now);
    return [when !== "—" && when !== "now" ? `done ${when}` : "done", "done"];
  }
  return ["shell", "idle"];
}

// -- the board ------------------------------------------------------------------
// Every list is drawn as the phone's board (apps/mobile/src/repos.ts): a time,
// a name and one plain status word. Only what waits on you is lit ("signal");
// what runs is ink, the quiet rest muted, and a finished or absent thing dim.

export const GRADE_WORDS: Readonly<Record<string, Tone>> = {
  Diverged: ["DIVERGED", "signal"], Unpushed: ["UNPUSHED", "ink"], Parked: ["PARKED", "ink"],
  Cluttered: ["CLUTTERED", "ink"], "Off-standard": ["OFF-STD", "ink"], Behind: ["BEHIND", "muted"],
  // The grade for uncommitted work; WORKING is what Claude is doing.
  Working: ["CHANGED", "muted"], Clean: ["CLEAN", "muted"],
};

export function gradeWord(grade: string | null | undefined): Tone {
  if (!grade) return ["IDLE", "muted"];
  return own(GRADE_WORDS, grade) ?? [String(grade).toUpperCase(), "ink"];
}

/** A project row's status word and tone. */
export function boardStatus(r: Row): Tone {
  if (r.state === "needs") return ["WAITING", "signal"];
  if (r.state === "working") {
    return get(r.project || {}, "activity") === "agent-working" ? ["WORKING", "ink"] : ["RUNNING", "muted"];
  }
  if (r.state === "agent") return ["DONE", "muted"];
  if (r.state === "shell" || r.state === "loose") return ["SHELL", "muted"];
  if (r.state === "loose-live") return ["RUNNING", "muted"];
  const word = gradeWord(get(get(r.project || {}, "git") || {}, "grade"));
  // A parked extra session reads PARKED unless its grade asks for something.
  if (r.parent && word[1] === "muted") return ["PARKED", "muted"];
  return word;
}

export const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/** The time column: "14:05" today, a weekday this week, "9/20" before. Local time. */
export function boardTime(value: Json, now?: number | null): string {
  const t = parseIso(value);
  if (t === null) return "—";
  const at = new Date(t * 1000), today = new Date((now || nowS()) * 1000);
  const dayOf = (d: Date) => {
    const u = new Date(0);
    u.setUTCFullYear(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round(u.getTime() / 86400000);
  };
  const days = dayOf(today) - dayOf(at);
  if (days <= 0) return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (days < 7) return WEEKDAYS[(at.getDay() + 6) % 7];
  return `${at.getMonth() + 1}/${at.getDate()}`;
}

/** `polls` maps machine → {projects: ProjectList | null, tmux: {...} | null}. */
export function buildRows(polls: Record<string, Dict>, now?: number | null): Row[] {
  const rows: Row[] = [];
  for (const [machine, poll] of Object.entries(polls)) {
    const plist = get(get(poll, "projects") || {}, "projects");
    if (!Array.isArray(plist)) continue;
    const configured = new Set<string>();
    for (const p of plist) {
      configured.add(pyStr(get(p, "session")));
      rows.push(rowForProject(p, machine, now));
    }
    for (const s of get(get(poll, "tmux") || {}, "sessions") || []) {
      const name = pyStr(get(s, "name"));
      // `name@desk` is the grouped view launch.sh opens: our own plumbing.
      if (configured.has(name) || name.endsWith("@desk")) continue;
      rows.push(rowForSession(s, machine, now));
    }
  }
  const sorted = sortedBy(rows, (r) => [r.rank, r.name.toLowerCase(), r.label]);
  rows.splice(0, rows.length, ...sorted);
  return rows;
}

/** Each project's extra sessions right after it, in the order given; one
 * whose project is not in the list keeps its own place. */
export function nest(rows: readonly Row[]): Row[] {
  const present = new Set(rows.filter((r) => r.parent === null).map((r) => `${r.machine}\u0000${r.id}`));
  const out: Row[] = [];
  for (const r of rows) {
    if (r.parent !== null && present.has(`${r.machine}\u0000${r.parent}`)) continue;
    out.push(r);
    if (r.parent === null) out.push(...rows.filter((c) => c.parent === r.id && c.machine === r.machine));
  }
  return out;
}

/** Whether a project or any of its extra sessions is running, for a row of either: a family is
 * listed together, under Active when any of it is. */
/**
 * Whether a row belongs to a specialist hired on its own: the specialist's
 * row, or its conversation and helpers under it. Such a family is listed
 * with the specialists, never among the person's projects.
 */
export function ofSpecialist(r: Row, rows: readonly Row[]): boolean {
  if (r.parent === null) return r.specialist;
  return rows.some((p) => p.parent === null && p.specialist && p.id === r.parent && p.machine === r.machine);
}

/** The person's projects among these rows, and the specialists hired on their own (with their conversations and helpers). */
export function splitSpecialists(rows: readonly Row[]): { projects: Row[]; specialists: Row[] } {
  const projects: Row[] = [];
  const specialists: Row[] = [];
  for (const r of rows) (ofSpecialist(r, rows) ? specialists : projects).push(r);
  return { projects, specialists };
}

export function familyActive(r: Row, rows: readonly Row[]): boolean {
  let root = r;
  if (r.parent !== null) {
    root = rows.find((p) => p.parent === null && p.id === r.parent && p.machine === r.machine) ?? r;
  }
  if (root.parent !== null) return r.active;
  return root.active || rows.some((c) => c.active && c.parent === root.id && c.machine === root.machine);
}

/** Another Claude in this project: a registered project (not an extra session itself) whose
 * folder is a git repository. */
export function canAddSession(r: Row): boolean {
  return r.project !== null && r.parent === null && truthy(get(r.project, "git"));
}

/** The Ollama models a new session may run on (/capabilities localModels). */
export function localModels(caps: Dict | null | undefined): string[] {
  return localModelChoices(caps).map(([name]) => name);
}

/** Whether this computer has an active Codex sign-in for a new session. */
export function codexReady(caps: Dict | null | undefined): boolean {
  return get(caps || {}, "codex") === true;
}

/** What runs a session besides its model: "on Pi" for a Pi session, else nothing. */
export function harnessLabel(project: Dict | null | undefined): string {
  return get(project || {}, "command") === "pi" ? "on Pi" : "";
}

export function isPi(project: Dict | null | undefined): boolean {
  return get(project || {}, "command") === "pi";
}

/** Whether a local model starts on Pi on that computer (/capabilities `pi`). */
export function piReady(caps: Dict | null | undefined): boolean {
  return get(caps || {}, "pi") === true;
}

// The New session dialog's switch for a local model where the computer offers Pi (the phone's words).
export const PI_SWITCH = "Run in Claude Code instead";
export const PI_SWITCH_HINT = "Slower: Claude Code's own prompt is about 20,000 tokens. Pi is made for local models.";

// How a model that is not "ready" reads in the New session picker.
export const LOCAL_TAGS: Readonly<Record<string, string>> = { slow: "slower", unchecked: "not checked" };

/** [name, what the picker shows] for each model a new session may run on, in the agent's order
 * from `localModelInfo`, tagged when not ready. An agent from before phase 1 sends only `localModels`. */
export function localModelChoices(caps: Dict | null | undefined): (readonly [string, string])[] {
  const info = get(caps || {}, "localModelInfo");
  if (Array.isArray(info)) {
    const out: (readonly [string, string])[] = [];
    for (const item of info) {
      if (!isDict(item) || !truthy(item.name)) continue;
      const name = pyStr(item.name);
      const tag = own(LOCAL_TAGS, String(get(item, "verdict") || "")) ?? "";
      out.push([name, tag ? `${name} (${tag})` : name]);
    }
    return out;
  }
  const found = get(caps || {}, "localModels");
  return Array.isArray(found) ? found.filter((m) => truthy(m)).map((m) => [pyStr(m), pyStr(m)] as const) : [];
}

/** Substring over name and machine, so "office" narrows to a machine and "stab" to a project. */
export function filterRows(rows: Row[], text: string): Row[] {
  const q = text.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(q) || r.label.toLowerCase().includes(q) || r.machine.toLowerCase().includes(q));
}

/** An extra session's second line: its type, its model, what it is doing, then the last line on
 * its screen: "Docs · sonnet · Working · Editing guide.md". */
export function sessionDetail(r: Row): string {
  const tail = ((get(r.project || {}, "tail") || []) as Json[]).filter((t) => String(t).trim()).map((t) => String(t).trim());
  const doing = r.state === "none" ? "Parked" : upperFirst(r.meta);
  const last = tail.length && (r.state === "needs" || r.state === "working") ? tail[tail.length - 1].slice(0, 80) : "";
  return [r.kindLine, doing, last].filter((x) => x).join(" · ");
}

export interface PermissionRequest {
  headline: string;
  plain: string;
  why: string;
  by: string;
  exact: string;
}

/** What a permission prompt asks, from a project or a transcript's screen (the agent's optional
 * `request`). null while no permission dialog is up, from an older agent, or with no words. */
export function permissionRequest(source: Json): PermissionRequest | null {
  if (!isDict(source)) return null;
  const dialog = get(source, "dialog");
  if (get(source, "needsInput") === false || (dialog !== null && dialog !== "permission")) return null;
  const found = get(source, "request");
  if (!isDict(found)) return null;
  const word = (k: string) => pyStr(get(found, k) || "").trim();
  const out: PermissionRequest = {
    headline: word("headline"), plain: word("plain"), why: word("why"), by: word("by"),
    exact: pyStr(get(found, "exact") || ""),
  };
  if (!(out.headline || out.plain)) return null;
  return out;
}

/** The key of the permission dialog a project or a transcript's screen shows, or "". */
export function dialogKey(source: Json): string {
  const found = isDict(source) ? get(source, "request") : null;
  return isDict(found) ? pyStr(get(found, "key") || "") : "";
}

/** The /session body's extra for an Allow: the dialog key when there is one. */
export function allowExtra(key: string): Dict {
  return key ? { dialogKey: key } : {};
}

/** The /git merge-pr body's extra for a PR as shown: its number, the head commit the row showed,
 * and `force` only after the second confirmation. */
export function mergeExtra(pr: Dict, force = false): Dict {
  const out: Dict = { number: get(pr, "number") };
  if (truthy(get(pr, "headSha"))) out.head = pyStr(pr.headSha);
  if (force) out.force = true;
  return out;
}

/** Whether a plain Merge goes through on the checks shown: green, or none configured. */
export function checksAgree(pr: Dict): boolean {
  const c = get(pr, "checks");
  return c === "green" || c === "none";
}

/** What an agent is called in a list: Cobra, a Foreman by its name with its project (else
 * Foreman · <project>), or the row's own title. */
export function agentName(r: Row): string {
  if (r.lead) return LEAD_NAME;
  if (r.foreman) {
    const crew = r.crew;
    return crew && truthy(crew) ? `${crew.name} · ${r.parent || ""}` : `Foreman · ${r.parent || ""}`;
  }
  return r.title;
}

/** SUPER+P's list: the agents first (the Lead, Foremen, Workers that run), then what waits on
 * you, what runs, and the projects not started; each row once, under its group. */
export function pickerGroups(rows: readonly Row[], text: string): (readonly [string, Row])[] {
  const q = text.trim().toLowerCase();
  const shown = rows.filter((r) => !q || agentName(r).toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
    || r.label.toLowerCase().includes(q) || r.machine.toLowerCase().includes(q) || (r.branch || "").toLowerCase().includes(q));
  const agents = sortedBy(shown.filter((r) => r.active && (r.lead || r.foreman || truthy(r.worker))),
    (r) => [r.lead ? 0 : r.foreman ? 1 : 2, r.rank]);
  const out: (readonly [string, Row])[] = agents.map((r) => ["Agents", r] as const);
  const rest = sortedBy(shown.filter((r) => !agents.includes(r)), (r) => [r.rank]);
  for (const r of rest) out.push([r.state === "needs" ? "Needs you" : r.active ? "Running" : "Not started", r]);
  return out;
}

// -- git (port of apps/mobile/src/git.ts) ------------------------------------

const OFFERS: Readonly<Record<string, Tone>> = { Behind: ["sync", "Sync"], Unpushed: ["park", "Park"], Parked: ["resume", "Resume"] };

export function offerFor(git: Dict | null | undefined): Tone | null {
  return own(OFFERS, get(git || {}, "grade")) ?? null;
}

export function brief(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function gradeReason(git: Dict, now?: number | null): string | null {
  const grade = get(git, "grade");
  const at = now || nowS();
  if (grade === "Behind") return `${pyStr(get(git, "behind"))} behind origin`;
  if (grade === "Unpushed" || grade === "Working") {
    const dirty = get(git, "dirty"), ahead = get(git, "ahead") || 0;
    if (!truthy(dirty) && !truthy(ahead)) return null;
    const what = truthy(dirty) && truthy(ahead) ? "dirty, unpushed" : truthy(dirty) ? "uncommitted" : "unpushed";
    const from = parseIso(get(git, "dirtySince"));
    return from ? `${what} for ${brief(at - from)}` : what;
  }
  if (grade === "Parked") return get(git, "parked");
  if (grade === "Diverged") {
    const n = get(git, "mainAhead");
    return `${pyStr(n)} local commit${n === 1 ? "" : "s"} not on origin`;
  }
  if (grade === "Off-standard") return (truthy(get(git, "offStandard")) ? git.offStandard : [null])[0];
  if (grade === "Cluttered") {
    const parts: string[] = [];
    if ((get(git, "staleBranches") || 0) > 0) parts.push(`${git.staleBranches} stale branches`);
    if ((get(git, "oldestPrDays") || 0) > 0) parts.push(`oldest PR ${git.oldestPrDays}d`);
    return parts.join(" · ") || null;
  }
  return null;
}

export const OFFER_SENTENCE: Readonly<Record<string, string>> = {
  sync: "Sync from origin", park: "Park uncommitted work", resume: "Resume parked work",
};

/** "⎇ main ● ↑2 ↓3": branch, uncommitted work, unpushed, unpulled. */
export function gitLine(git: Dict): string {
  return [`⎇ ${get(git, "branch") || "?"}`, truthy(get(git, "dirty")) ? "●" : "",
    truthy(get(git, "ahead")) ? `↑${git.ahead}` : "",
    truthy(get(git, "behind")) ? `↓${git.behind}` : ""].filter((x) => x).join(" ");
}

/** The facts worth a line on the project page, beyond the grade's reason. */
export function gitFacts(git: Dict, now?: number | null): string[] {
  const facts: string[] = [];
  let n = get(git, "openPrs");
  if (truthy(n)) facts.push(`${n} open PR${n === 1 ? "" : "s"}`);
  n = get(git, "stashes");
  if (truthy(n)) facts.push(`${n} stash${n === 1 ? "" : "es"}`);
  n = get(git, "localBranches");
  if (n !== null) {
    const stale = get(git, "staleBranches");
    facts.push(`${n} local branch${n === 1 ? "" : "es"}` + (truthy(stale) ? `, ${stale} stale` : ""));
  }
  if (truthy(get(git, "fetchError"))) {
    facts.push(`fetch failed: ${git.fetchError}`);
  } else if (truthy(get(git, "fetchedAt"))) {
    const when = ago(git.fetchedAt, now);
    facts.push(when === "now" ? "fetched just now" : `fetched ${when} ago`);
  } else {
    facts.push("not fetched yet");
  }
  return facts;
}

/** Why a PR cannot be merged from here, or null when it can. */
export function prWord(pr: Dict): string | null {
  if (truthy(get(pr, "isDraft"))) return "draft";
  if (get(pr, "mergeable") === "CONFLICTING") return "conflicting";
  if (get(pr, "checks") === "red") return "checks failing";
  if (get(pr, "checks") === "pending") return "checks running";
  if (get(pr, "mergeable") !== "MERGEABLE") return "not yet mergeable";
  return null;
}

export function branchWord(b: Dict): string {
  if (truthy(get(b, "current"))) return "checked out";
  if (truthy(get(b, "merged"))) return "merged" + (truthy(get(b, "gone")) ? ", upstream gone" : "");
  const n = get(b, "aheadOfMain");
  return `${n === null ? "?" : n} commit${n === 1 ? "" : "s"} not in main` + (truthy(get(b, "stale")) ? ", stale" : "");
}

/** The one safe thing a branch row offers: resume parked work, delete a merged branch, or ask
 * Claude about a stale one with commits main lacks. */
export function branchVerb(b: Dict, dirty: boolean): string | null {
  if (truthy(get(b, "current"))) return null;
  if (truthy(get(b, "parked")) && !dirty) return "resume";
  if (truthy(get(b, "merged"))) return "delete";
  if (truthy(get(b, "stale"))) return "ask";
  return null;
}

// -- the row menu (choicesFor in apps/mobile/app/(tabs)/projects.tsx) ----------

export class Choice {
  readonly action: string;
  readonly label: string;
  readonly destructive: boolean;

  constructor(action: string, label: string, destructive = false) {
    this.action = action;
    this.label = label;
    this.destructive = destructive;
  }
}

/** What a pin is kept under: the remote, so a repository stays pinned on every computer that
 * holds it; an extra session is not pinned on its own. */
export function pinKey(r: Row): string | null {
  if (r.project === null || r.parent !== null) return null;
  const remote = get(get(r.project, "git") || {}, "remote");
  return truthy(remote) ? `repo:${remote}` : `${r.machine}:${r.id}`;
}

/** What a project row's menu offers, given what runs in it — the phone's hold sheet, in the same
 * order. `pinned` is null where pinning does not apply. */
export function choicesFor(r: Row, pinned: boolean | null | undefined): Choice[] {
  const p = r.project;
  if (p === null) {
    // A loose tmux session: no project, so no page, git or templates.
    return [new Choice("open-chat", "Open as chat"),
      new Choice("interrupt", "Interrupt"), new Choice("new-window", "New shell window"),
      new Choice("kill", "Kill session…", true)];
  }
  if (truthy(get(p, "headless"))) return headlessChoices(p, pinned);
  const head = [new Choice("open-page", "Open project page")];
  if (pinned !== null && pinned !== undefined) head.push(new Choice("pin", pinned ? "Unpin" : "Pin to top"));
  if (canAddSession(r)) head.push(new Choice("new-session", "New session…"));
  // Only a project made from a phone or this desk can come off the list; a
  // tracked one lives in the repo and would come back on the next deploy.
  const forget = get(p, "source") === "local" ? [new Choice("forget", "Remove from list…", true)] : [];
  const offer = offerFor(get(p, "git"));
  const sync = offer ? [new Choice(`git-${offer[0]}`, OFFER_SENTENCE[offer[0]])] : [];
  const templates = [new Choice("templates", "Run a template…")];
  const activity = get(p, "activity") || "none";
  if (activity === "none") {
    return [...head, new Choice("start", `Start ${APP_NAME}`), new Choice("prompt", "Start with a prompt…"),
      ...templates, ...sync, ...forget];
  }
  const out = [...head, new Choice("open-chat", "Open as chat")];
  // A Pi session's screen is Pi's, not Claude Code's: no resume, shell window or template is typed into it.
  const pi = isPi(p);
  if (activity === "idle" && !pi) {
    out.push(new Choice("resume-claude", `Resume ${APP_NAME}`));
  } else if (truthy(get(p, "needsInput"))) {
    if (get(p, "dialog") === "permission") out.push(new Choice("approve", "Allow"));
    out.push(new Choice("deny", "Dismiss dialog"));
  } else {
    out.push(new Choice("interrupt", "Interrupt"));
  }
  if (pi) return [...out, ...sync, new Choice("kill", "Kill session…", true), ...forget];
  out.push(new Choice("new-window", "New shell window"));
  return [...out, ...templates, ...sync, new Choice("kill", "Kill session…", true), ...forget];
}

/** A headless Worker: no tmux session, so no terminal, shell window or resume; its conversation
 * and its answers only. */
export function headlessChoices(p: Dict, pinned: boolean | null | undefined): Choice[] {
  const out = [new Choice("open-page", "Open project page")];
  if (pinned !== null && pinned !== undefined) out.push(new Choice("pin", pinned ? "Unpin" : "Pin to top"));
  if ((get(p, "activity") || "none") === "none") return out;
  out.push(new Choice("open-chat", "Open conversation"));
  if (truthy(get(p, "needsInput"))) {
    if (get(p, "dialog") === "permission") out.push(new Choice("approve", "Allow"));
    out.push(new Choice("deny", "Dismiss dialog"));
  } else {
    out.push(new Choice("interrupt", "Interrupt"));
  }
  return [...out, new Choice("kill", "Stop Worker…", true)];
}

/** `r` and each other computer's checkout of its repository, matched by remote, for the project
 * page's switch. An extra session, and a second checkout on the same computer, are pages of their own. */
export function checkouts(r: Row, rows: readonly Row[]): Row[] {
  const remote = get(get(r.project || {}, "git") || {}, "remote");
  if (r.parent !== null || !truthy(remote)) return [r];
  const found: Row[] = [];
  const seen = new Set([r.machine]);
  for (const x of rows) {
    if (x === r) {
      found.push(x);
    } else if (x.parent === null && !seen.has(x.machine) && get(get(x.project || {}, "git") || {}, "remote") === remote) {
      seen.add(x.machine);
      found.push(x);
    }
  }
  return found;
}

export function extrasOf(r: Row, rows: readonly Row[]): Row[] {
  return rows.filter((x) => x.parent === r.id && x.machine === r.machine);
}

const SESSION_WORDS: Readonly<Record<string, string>> = {
  "agent-working": `${APP_NAME} working`, "agent-idle": `${APP_NAME} done`, busy: "running", idle: "shell open",
};

/** What a checkout's session is doing, one or two words. */
export function sessionWord(r: Row): string {
  const activity = get(r.project || {}, "activity") || "none";
  if (truthy(get(r.project || {}, "needsInput"))) return "waiting on you";
  return own(SESSION_WORDS, activity) ?? "no session";
}

// -- Tidy (apps/mobile/src/tidy.ts) -------------------------------------------

export interface TidySection {
  key: string;
  machine: string;
  project: Json;
  title: string;
  rows: Dict[];
  deletable: number;
}

/** [machine, TidyRow] pairs as one section per repository per computer, worst first, with how
 * many merged branches one tap may delete. */
export function tidySections(found: readonly (readonly [string, Dict])[]): TidySection[] {
  const sections = new Map<string, TidySection>();
  for (const [machine, row] of found) {
    const key = `${machine}:${pyStr(get(row, "project"))}`;
    let sec = sections.get(key);
    if (!sec) {
      sec = { key, machine, project: get(row, "project"), title: pyStr(get(row, "projectName") || get(row, "project")), rows: [], deletable: 0 };
      sections.set(key, sec);
    }
    sec.rows.push(row);
    if (get(row, "action") === "delete") sec.deletable += 1;
  }
  return sortedBy(sections.values(), (s) => [-s.rows.length, s.title.toLowerCase(), s.machine]);
}

export function tidyLabel(row: Dict): string {
  if (get(row, "kind") === "pr") return `#${pyStr(get(row, "number"))} ${get(row, "title") || ""}`.trim();
  return String(get(row, "branch") || "");
}

export const TIDY_VERBS: Readonly<Record<string, string>> = {
  delete: "Delete", close: "Close", "ask-claude": `Ask ${APP_NAME}`, discard: "Delete…",
};

// The security audit (GET /security/audit): fails first, then warnings, then passes, each in the
// agent's order. A fail is lit like what waits on you; a warn is ink; a pass is muted.
// -- notification edges -----------------------------------------------------

export interface EventInit {
  /** needs | finished | alert | approval | cleared */
  kind: string;
  key: string;
  row?: Row | null;
  alert?: Dict | null;
  machine?: string;
  approval?: Dict | null;
  /** What the agent decided to tell you (its notices.ts): title and body in its words. */
  notice?: Dict | null;
}

export class Event {
  kind: string;
  key: string;
  row: Row | null;
  alert: Dict | null;
  machine: string;
  approval: Dict | null;
  notice: Dict | null;

  constructor(o: EventInit) {
    this.kind = o.kind;
    this.key = o.key;
    this.row = o.row ?? null;
    this.alert = o.alert ?? null;
    this.machine = o.machine ?? "";
    this.approval = o.approval ?? null;
    this.notice = o.notice ?? null;
  }
}

/** Turns successive polls into notification events, on the same two edges the agents' push
 * watcher uses (→ needsInput, agent-working → agent-idle), debounced a minute per project, plus
 * new alerts. The first poll of each machine only records a baseline.
 *
 * An agent that serves /notices decides itself which of its sessions' moments reach you: `projects`
 * is then called with quiet=true and only clears, and `notices` makes the events. */
export class EdgeTracker {
  debounce: number;
  lastState = new Map<string, string>();
  lastFired = new Map<string, number>();
  seenAlerts = new Map<string, Set<string>>();
  seenApprovals = new Map<string, Set<string>>();
  primed = new Set<string>();

  constructor(o: { debounce?: number } = {}) {
    this.debounce = o.debounce ?? 60.0;
  }

  projects(machine: string, rows: readonly Row[], now?: number | null, quiet = false): Event[] {
    const at = now ?? nowS();
    const events: Event[] = [];
    const first = !this.primed.has(machine);
    this.primed.add(machine);
    const present = new Set<string>();
    for (const r of rows) {
      if (r.machine !== machine || r.project === null) continue;
      const key = `${machine}:${r.id}`;
      present.add(key);
      const before = this.lastState.get(key);
      const after = r.state;
      this.lastState.set(key, after);
      if (first || before === after) continue;
      if (before === "needs" && after !== "needs") events.push(new Event({ kind: "cleared", key, row: r, machine }));
      if (quiet) continue;
      let kind: string | null = null;
      if (after === "needs") kind = "needs";
      else if (before === "working" && after === "agent") kind = "finished";
      if (kind === null) continue;
      const fired = this.lastFired.get(`${kind}:${key}`);
      if (fired !== undefined && at - fired < this.debounce) continue;
      this.lastFired.set(`${kind}:${key}`, at);
      events.push(new Event({ kind, key, row: r, machine }));
    }
    for (const key of [...this.lastState.keys()].filter((k) => k.startsWith(machine + ":") && !present.has(k))) {
      const was = this.lastState.get(key);
      this.lastState.delete(key);
      if (was === "needs") events.push(new Event({ kind: "cleared", key, machine }));
    }
    return events;
  }

  /** The agent's notices since the last read: a question pops up while it is still on screen; a
   * finish, the Lead's run being done, the Lead's own word, a routine that was skipped or
   * could not start, the receipt of an action that ran on trust and the morning brief are notifications. */
  notices(machine: string, rows: readonly Row[], notices: readonly Dict[]): Event[] {
    const byId = new Map<string, Row>();
    for (const r of rows) if (r.machine === machine && r.project !== null) byId.set(r.id, r);
    const events: Event[] = [];
    for (const n of notices) {
      const pid = pyStr(get(n, "projectId") || "");
      const r = byId.get(pid) ?? null;
      const key = `${machine}:${pid}`;
      const kind = get(n, "kind");
      if (kind === "needs-input") {
        if (r !== null && r.state === "needs") events.push(new Event({ kind: "needs", key, row: r, machine, notice: n }));
      } else if (kind === "finished" || kind === "run-done" || kind === "lead" || kind === "routine" || kind === "receipt" || kind === "morning" || kind === "website" || kind === "audit") {
        // "audit": the agent could not write its audit log (its auditTrail.ts); it keeps working, and says so once.
        // "website": a website form inquiry the agent pulled into the Space (the agent's sitePull.ts).
        // "morning": the morning brief, from the Lead's computer only, for no project (the agent's morning.ts).
        // "routine": a routine skipped because its Foreman was busy, or one that could not start (the agent's routines.ts).
        // "receipt": an action that ran on trust, with no card (the agent's actionTrust.ts): what landed, or that it failed.
        events.push(new Event({ kind: "finished", key, row: r, machine, notice: n }));
      }
    }
    return events;
  }

  alerts(machine: string, alerts: readonly Dict[]): Event[] {
    const ids = new Set(alerts.map((a) => pyStr(get(a, "id"))));
    const seen = this.seenAlerts.get(machine);
    this.seenAlerts.set(machine, ids);
    if (seen === undefined) return [];
    const events = alerts.filter((a) => !seen.has(pyStr(get(a, "id"))))
      .map((a) => new Event({ kind: "alert", key: `alert:${machine}:${pyStr(get(a, "id"))}`, alert: a, machine }));
    for (const i of seen) if (!ids.has(i)) events.push(new Event({ kind: "cleared", key: `alert:${machine}:${i}`, machine }));
    return events;
  }

  /** What the Lead asks you to allow: a new one pops up with Allow and Deny; one answered
   * anywhere, or expired, clears. */
  approvals(machine: string, pending: readonly Dict[]): Event[] {
    const ids = new Set(pending.map((a) => pyStr(get(a, "id"))));
    const seen = this.seenApprovals.get(machine);
    this.seenApprovals.set(machine, ids);
    if (seen === undefined) return [];
    const events = pending.filter((a) => !seen.has(pyStr(get(a, "id"))))
      .map((a) => new Event({ kind: "approval", key: `approval:${machine}:${pyStr(get(a, "id"))}`, machine, approval: a }));
    for (const i of sortedBy([...seen].filter((i) => !ids.has(i)), (i) => [i])) {
      events.push(new Event({ kind: "cleared", key: `approval:${machine}:${i}`, machine }));
    }
    return events;
  }
}

// -- chat (port of apps/mobile/src/chat.ts) ------------------------------------

/** Results attach to their call, re-read records are ignored, and a message typed here is replaced
 * when the transcript echoes it. */
export function mergeMessages(entries: readonly Dict[], incoming: readonly Dict[]): Dict[] {
  const out: Dict[] = entries.map((e) => ({ ...e }));
  const seen = new Set<Json>(out.map((e) => e.id));
  for (const m of incoming) {
    const kind = get(m, "kind");
    if (kind === "result") {
      const call = out.find((e) => e.kind === "tool" && e.id === get(m, "toolUseId"));
      if (call === undefined) continue;
      call.status = truthy(get(m, "ok")) ? "ok" : "error";
      call.result = get(m, "preview", "");
      if (truthy(get(m, "answers"))) call.answers = m.answers;
      continue;
    }
    if (kind === "command") {
      const known = out.find((e) => e.kind === "command" && e.id === m.id);
      if (known) {
        if (truthy(get(m, "output"))) known.output = m.output;
        continue;
      }
      const echo = out.findIndex((e) => e.kind === "command" && truthy(get(e, "pending")) && e.name === get(m, "name"));
      if (echo >= 0) out.splice(echo, 1);
      seen.add(m.id);
      const entry: Dict = {};
      for (const k of ["kind", "id", "at", "name", "args", "output"]) if (truthy(get(m, k))) entry[k] = m[k];
      out.push(entry);
      continue;
    }
    if (seen.has(get(m, "id"))) continue;
    seen.add(m.id);
    if (kind === "text") {
      if (get(m, "role") === "user") {
        const echo = out.findIndex((e) => e.kind === "text" && truthy(get(e, "pending")) && e.text === get(m, "text"));
        if (echo >= 0) out.splice(echo, 1);
      }
      out.push({ kind: "text", id: m.id, at: get(m, "at", ""), role: get(m, "role"), text: get(m, "text", "") });
    } else if (kind === "tool") {
      const e: Dict = { kind: "tool", id: m.id, at: get(m, "at", ""), name: get(m, "name", ""), summary: get(m, "summary", ""), status: "running" };
      if (truthy(get(m, "questions"))) e.questions = m.questions;
      out.push(e);
    }
  }
  return out;
}

export function withPending(entries: readonly Dict[], text: string): Dict[] {
  return [...entries, { kind: "text", id: `local:${nowS()}`, at: "", role: "user", text, pending: true }];
}

/** A run of tool calls folds into one card; a question is its own row. A line the agent typed into the session
 * ("[cobra] Worker w3 finished …", see threadRules.cobraNote) is a quiet note, never the person's own message. */
export function rowsOf(entries: readonly Dict[]): Dict[] {
  const rows: Dict[] = [];
  for (const e of entries) {
    if (e.kind === "text") {
      const note = e.role === "user" ? cobraNote(String(e.text ?? "")) : null;
      rows.push(note === null ? e : { kind: "note", id: e.id, at: e.at, text: note });
    } else if (e.kind === "command") rows.push(e);
    else if (e.name === "AskUserQuestion" && truthy(get(e, "questions"))) rows.push({ kind: "question", id: e.id, tool: e });
    else if (rows.length && rows[rows.length - 1].kind === "tools") rows[rows.length - 1].tools.push(e);
    else rows.push({ kind: "tools", id: `tools:${e.id}`, tools: [e] });
  }
  return rows;
}

const CHROME = ["Type something", "Chat about this"];

export function questionFromScreen(screen: Dict | null | undefined): Dict | null {
  const shown = get(screen || {}, "question");
  if (!truthy(screen) || !truthy(get(screen, "needsInput")) || get(screen, "dialog") !== "question" || !truthy(shown)) return null;
  if (truthy(get(shown, "submit"))) {
    return { key: "submit", submit: true, question: { question: `Send these answers to ${APP_NAME}?`, options: [{ label: "Submit answers" }] } };
  }
  const rows = ((get(shown, "rows") || []) as Dict[]).filter((r) => !CHROME.some((c) => pyStr(get(r, "label", "")).startsWith(c)));
  if (!rows.length || rows.some((r, i) => get(r, "n") !== i + 1)) return null;
  const q: Dict = {
    question: get(shown, "text", ""), multiSelect: truthy(get(shown, "multiSelect")),
    options: rows.map((r) => ({ label: r.label, ...(truthy(get(r, "description")) ? { description: r.description } : {}) })),
  };
  if (truthy(get(shown, "header"))) q.header = shown.header;
  return { key: get(shown, "text", ""), submit: false, question: q };
}

function sameQuestion(onScreen: string, asked: string): boolean {
  const squash = (s: string) => s.split(/\s+/).filter((w) => w).join(" ");
  const a = squash(onScreen), b = squash(asked);
  return a === b || (b.slice(0, 40).length > 0 && a.startsWith(b.slice(0, 40)));
}

/** The screen says a question is up; the transcript, when it has caught up, says it with full
 * descriptions. Prefer the transcript's wording. */
export function activeQuestion(entries: readonly Dict[], screen: Dict | null | undefined): Dict | null {
  const fromScreen = questionFromScreen(screen);
  if (!fromScreen || fromScreen.submit) return fromScreen;
  const shown = get(get(screen || {}, "question") || {}, "text", "");
  for (let j = entries.length - 1; j >= 0; j--) {
    const e = entries[j];
    if (e.kind !== "tool" || get(e, "name") !== "AskUserQuestion") continue;
    if (get(e, "status") !== "running" || !truthy(get(e, "questions"))) break;
    const questions = e.questions as Dict[];
    for (let i = 0; i < questions.length; i++) {
      if (sameQuestion(shown, get(questions[i], "question", ""))) return { key: `${e.id}:${i}`, submit: false, question: questions[i] };
    }
    break;
  }
  return fromScreen;
}

const DIALOG_WORDS: Readonly<Record<string, string>> = {
  permission: "wants permission", trust: "asks to trust the folder", model: "picking a model",
};

export function statusOf(screen: Dict | null | undefined, reachable: boolean): Tone {
  if (!reachable) return ["reconnecting…", "faint"];
  if (!truthy(screen) || !truthy(get(screen, "recognised"))) return [`${APP_NAME} is not running`, "faint"];
  if (truthy(get(screen, "needsInput"))) return [own(DIALOG_WORDS, get(screen, "dialog")) ?? "asking you", "warn"];
  if (truthy(get(screen, "working"))) return ["working", "ok"];
  return ["idle", "muted"];
}

export function pollInterval(screen: Dict | null | undefined): number {
  if (!truthy(screen)) return 3000;
  if (truthy(get(screen, "working"))) return 1200;
  if (truthy(get(screen, "needsInput"))) return 2000;
  return 3000;
}

/** claude-opus-5 → Opus 5; a display name passes through. */
export function modelName(model: string | null | undefined): string {
  if (!model) return "";
  if (!model.startsWith("claude-")) return model;
  const parts = model.slice("claude-".length).split("-").filter((p) => !(/^\d+$/.test(p) && p.length === 8));
  if (!parts.length) return model;
  const cap = parts[0].slice(0, 1).toUpperCase() + parts[0].slice(1).toLowerCase();
  return [cap, parts.slice(1).join(".")].join(" ").trim();
}

// -- durations ----------------------------------------------------------------

export function duration(seconds: number): string {
  const s = Math.max(0, Math.trunc(seconds));
  const days = Math.floor(s / 86400), hours = Math.floor((s % 86400) / 3600), minutes = Math.floor((s % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
