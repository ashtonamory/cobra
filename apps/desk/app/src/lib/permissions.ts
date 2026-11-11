/**
 * Settings → Permissions in words and edits. A port of the
 * desk's permissions.py (itself the phone's `src/permissionsRules.ts`): change them together. Pure.
 *
 * The policy is fleet-wide: every computer keeps the same file, and the newest revision any computer
 * has is the fleet's. A change goes out as the next revision; one that grants more needs the second
 * press.
 */
import { APP_NAME, LEAD_NAME } from "./appName.ts";
import { isDict, nowS, truthy, type Dict, type Json } from "./json.ts";
import { canonicalJson, pyEq, pyFixed, pyGet, pyRound, pySorted, pyStr } from "./py.ts";

export const PRESET_ORDER = ["locked", "balanced", "auto", "instinct"] as const;

export const PRESET_BLURB: Readonly<Record<string, string>> = {
  locked: `Every gray-zone action comes to you, as ${APP_NAME} has always worked.`,
  balanced: "A judge decides reading outside a Worker's folder; websites on your allowlist are allowed. The rest comes to you.",
  auto: "The judge also decides any other website and outside tools. Closest to Claude's auto mode.",
  instinct: "The judge also decides adding packages to a project, and passes to you only what you should decide; if it cannot answer, it asks you. Closest to Grok Bot and Meta Muse.",
};

export const BLURB = "What Workers may do without asking you, on every computer. Some things always come to you, whatever you choose here.";

export const VERDICT_WORD: Readonly<Record<string, string>> = {
  allow: "allowed",
  ask: "asks you",
  judge: "judge decides",
  never: "never",
  default: `${APP_NAME} asks`,
};

export const WIDENS_NOTE = "This lets Workers do more without asking you. Press Apply again to confirm.";

/** [machine, PolicyStatus] of the newest revision among the computers that answered. */
export function newest(reads: Readonly<Record<string, Json>>): [string, Dict] | null {
  let best: [string, Dict] | null = null;
  for (const [machine, status] of Object.entries(reads)) {
    if (!isDict(status) || !("policy" in status)) continue;
    if (best === null || pyGet(status.policy, "revision", 0) > pyGet(best[1].policy, "revision", 0)) best = [machine, status];
  }
  return best;
}

/** A project the computers run with no level of its own yet: its policy key, its name and the presets it runs under now. */
export type ProjectChoice = { key: string; name: string; runs: string[] };

/**
 * The projects the computers that answered report (GET /policy `projects`) that the policy does not set
 * apart yet, by name. Its key is owner/repo, or local/<id> for a project with no origin, which nobody
 * would type.
 */
export function projectChoices(reads: Readonly<Record<string, Json>>, policy: Dict): ProjectChoice[] {
  const taken = isDict(policy.projects) ? policy.projects : {};
  const found = new Map<string, ProjectChoice>();
  for (const status of Object.values(reads)) {
    if (!isDict(status) || !("policy" in status) || !Array.isArray(status.projects)) continue;
    for (const project of status.projects) {
      if (!isDict(project) || typeof project.key !== "string" || !project.key || project.key in taken) continue;
      const choice = found.get(project.key) ?? { key: project.key, name: typeof project.name === "string" && project.name ? project.name : project.key, runs: [] };
      if (typeof project.preset === "string" && project.preset && !choice.runs.includes(project.preset)) choice.runs.push(project.preset);
      found.set(project.key, choice);
    }
  }
  return [...found.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.key.localeCompare(b.key));
}

/** The preset a project is set apart at: the one it runs under now, so nothing changes until you pick; the narrowest when computers differ. */
export function startingPreset(choice: ProjectChoice): string {
  return PRESET_ORDER.find((preset) => choice.runs.includes(preset)) ?? "locked";
}

export function nextRevision(reads: Readonly<Record<string, Json>>): number {
  const found = newest(reads);
  return (found ? pyGet(found[1].policy, "revision", 0) : 0) + 1;
}

export function presetTitle(name: string | null, status: Dict | null): string {
  if (!name) return "Same as the fleet";
  for (const preset of pyGet(status || {}, "presets", []) as Dict[]) {
    if (preset.name === name) return pyGet(preset, "title", name);
  }
  return name;
}

export function computerLine(status: Dict | null, fleetRevision: number): string {
  if (status === null || status === undefined) return "Asking…";
  const here = presetTitle(status.resolved.preset, status);
  if (truthy(status.refused)) return `${here} · its file was refused`;
  if (pyGet(status.policy, "revision", 0) < fleetRevision) return `${here} · behind`;
  return here;
}

export function isBehind(status: Dict | null, fleetRevision: number): boolean {
  return isDict(status) && pyGet(status.policy, "revision", 0) < fleetRevision;
}

const HOST = /^(?=[^\n]{1,253}$)(?!\d+(?:\.\d+){3}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function cleanHost(typed: string): string | null {
  let host = typed.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "");
  host = host.replace(/[/?#][^\n]*$/, "").replace(/\.+$/, "");
  return HOST.test(host) ? host : null;
}

export function cleanProject(typed: string): string | null {
  let key = typed.trim();
  key = key.replace(/^https?:\/\/github\.com\//, "");
  key = key.replace(/\.git$/, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(key) ? key : null;
}

// -- edits: each returns a new draft -----------------------------------------

/** A level without its empty preset, allowlist and judge; every other setting (foreman, lead, local, models) is kept. */
function tidy(level: Dict): Dict {
  const { preset: _preset, network: _network, judge: _judge, ...rest } = level;
  const out: Dict = { ...rest };
  if (truthy(level.preset)) out.preset = level.preset;
  if (truthy((level.network || {}).allow)) out.network = { allow: level.network.allow };
  if (truthy(level.judge)) out.judge = level.judge;
  return out;
}

export function setFleetPreset(policy: Dict, preset: string): Dict {
  return { ...policy, preset };
}

function setLevel(policy: Dict, kind: string, key: string, preset: string | null): Dict {
  const levels: Dict = { ...(policy[kind] || {}) };
  const level = tidy({ ...(levels[key] || {}), preset });
  if (truthy(level)) levels[key] = level;
  else delete levels[key];
  return { ...policy, [kind]: levels };
}

export function setComputerPreset(policy: Dict, computer: string, preset: string | null): Dict {
  return setLevel(policy, "computers", computer, preset);
}

export function setProjectPreset(policy: Dict, project: string, preset: string | null): Dict {
  return setLevel(policy, "projects", project, preset);
}

export function addFleetHost(policy: Dict, host: string): Dict {
  const allow: string[] = [...((policy.network || {}).allow || [])];
  if (allow.includes(host)) return policy;
  return { ...policy, network: { allow: pySorted([...allow, host]) } };
}

export function removeFleetHost(policy: Dict, host: string): Dict {
  const allow = (((policy.network || {}).allow || []) as Json[]).filter((entry) => entry !== host);
  const out: Dict = Object.fromEntries(Object.entries(policy).filter(([k]) => k !== "network"));
  if (allow.length) out.network = { allow };
  return out;
}

/**
 * House rules (Instinct): standing rules in your own words that the judge
 * reads as yours ("No spending."), fleet-wide, at most RULES_MAX of RULE_MAX characters (agent
 * permissions.ts houseRules). Any change to them grants more, so Apply takes the second press.
 */
export const RULES_MAX = 20;
export const RULE_MAX = 300;

/** A rule as typed, tidied, or null when it is empty or too long. */
export function cleanRule(typed: string): string | null {
  const rule = typed.replace(/\s+/g, " ").trim();
  return rule.length > 0 && rule.length <= RULE_MAX ? rule : null;
}

export function addRule(policy: Dict, rule: string): Dict {
  const rules: string[] = (policy.rules || []) as string[];
  if (rules.includes(rule) || rules.length >= RULES_MAX) return policy;
  return { ...policy, rules: [...rules, rule] };
}

export function removeRule(policy: Dict, index: number): Dict {
  return { ...policy, rules: ((policy.rules || []) as string[]).filter((_, at) => at !== index) };
}

/** Whether the draft differs from the fleet's policy, revisions aside. */
export function changed(draft: Dict, fleet: Dict): boolean {
  const canonical = (policy: Dict) => canonicalJson({ ...policy, revision: 0 });
  return canonical(draft) !== canonical(fleet);
}

export function judgeLine(status: Dict): string {
  const judge: Dict = status.resolved.judge;
  const fallback: Json = judge.fallback ?? null;
  if (truthy(fallback)) {
    const name = (fallback as string).startsWith("local:") ? (fallback as string).slice("local:".length) : fallback;
    return `${pyStr(judge.model)}; ${name} on a computer that has it, when your plan is at its limit`;
  }
  return judge.model;
}

export function changeLine(line: Dict): string {
  return (truthy(line.widens) ? "+ " : "− ") + pyGet(line, "text", "");
}

// -- Ops: what the judge refused ----------------------------------------------

/** Every computer's refusals from the last day, newest first: [computer, refused[]] in, rows out.
 * `now` is in seconds (time.time()); each row's `at` is in milliseconds, as the agent sends it. */
export function refusedRows(lists: readonly (readonly [string, Json[] | null])[], now: number | null = null, limit = 20): Dict[] {
  const nowMs = (now !== null && now !== undefined ? now : nowS()) * 1000;
  let rows: Dict[] = lists.flatMap(([computer, refused]) => ((refused || []) as Dict[]).map((entry) => ({ ...entry, computer })));
  rows = rows.filter((row) => nowMs - pyGet(row, "at", 0) < 24 * 3600 * 1000);
  return pySorted(rows, (row) => pyGet(row, "at", 0), true).slice(0, limit);
}

export function refusedLine(row: Dict): string {
  let what = pyStr(pyGet(row, "rule", "")).replace(/^(judge|never):/, "");
  what = what.replaceAll("outside-read", "read outside its folder").replaceAll("network", "reach a website")
    .replaceAll("mcp", "use an outside tool");
  return `${pyStr(pyGet(row, "worker", ""))} · ${what}: ${truthy(row.reason) ? pyStr(row.reason) : "refused"}`;
}

// -- the Lead and Foremen (phase 6) -------------------------------------------

/** The agent's permissions.ts DEFAULT_ROLES: the Lead's web tools are off unless the owner turns them on. */
export const DEFAULT_ROLES: Readonly<Record<string, Readonly<Dict>>> = {
  lead: { webTools: false },
  foreman: { maxWorkers: 3, maxWorkersPerComputer: 8, workerModels: null, mergeOnGreen: false, webTools: true },
  job: { models: null, concurrent: 2 },
};

export const HARD_CAPS_FALLBACK = { workersPerProject: 8, workersPerComputer: 16, jobsAtOnce: 4 };

export const MODEL_CHOICES: readonly (readonly [string, string])[] = [
  ["claude", "Claude"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"], ["local:*", "Local"],
];

export function fleetRole(policy: Dict, role: string, key: string): Json {
  const value: Json = (policy[role] || {})[key];
  return value === null || value === undefined ? DEFAULT_ROLES[role][key] : value;
}

/** Fields whose default changed, written even at their default: an agent from before the change
 * still has the old default (the Lead's web tools were on until the 2026-10-12 audit). */
export const ALWAYS_WRITTEN: readonly (readonly [string, string])[] = [["lead", "webTools"]];

/** A role field at the fleet level; the default value is written as no setting at all (but ALWAYS_WRITTEN). */
export function setFleetRole(policy: Dict, role: string, key: string, value: Json): Dict {
  const current: Dict = { ...(policy[role] || {}) };
  const always = ALWAYS_WRITTEN.some(([r, k]) => r === role && k === key);
  if (value === null || value === undefined || (pyEq(value, DEFAULT_ROLES[role][key]) && !always)) delete current[key];
  else current[key] = value;
  const out: Dict = Object.fromEntries(Object.entries(policy).filter(([k]) => k !== role));
  if (truthy(current)) out[role] = current;
  return out;
}

/** projects[project].foreman, edited by `edit`, with empty levels dropped. */
function withProjectForeman(policy: Dict, project: string, edit: (foreman: Dict) => void): Dict {
  const projects: Dict = { ...(policy.projects || {}) };
  const level: Dict = { ...(projects[project] || {}) };
  const foreman: Dict = { ...(level.foreman || {}) };
  edit(foreman);
  if (truthy(foreman)) level.foreman = foreman;
  else delete level.foreman;
  if (truthy(level)) projects[project] = level;
  else delete projects[project];
  return { ...policy, projects };
}

export function setProjectMergeOnGreen(policy: Dict, project: string, on: boolean): Dict {
  return withProjectForeman(policy, project, (foreman) => {
    if (on) foreman.mergeOnGreen = true;
    else delete foreman.mergeOnGreen;
  });
}

/** Takes a website off a project's own allowlist (what Always in this project wrote); an empty level goes. */
export function removeProjectHost(policy: Dict, project: string, host: string): Dict {
  const projects: Dict = { ...(policy.projects || {}) };
  const level: Dict = { ...(projects[project] || {}) };
  const allow = ((isDict(level.network) && Array.isArray(level.network.allow) ? level.network.allow : []) as string[]).filter((entry) => entry !== host);
  if (allow.length) level.network = { ...(level.network as Dict), allow };
  else delete level.network;
  if (truthy(level)) projects[project] = level;
  else delete projects[project];
  return { ...policy, projects };
}

/** null (any model) loses one; a list gains or loses it; every choice again is null. */
export function toggleModel(models: string[] | null, model: string): string[] | null {
  const every = MODEL_CHOICES.map(([choice]) => choice);
  let current = models !== null && models !== undefined ? [...models] : [...every];
  current = current.includes(model) ? current.filter((m) => m !== model) : [...current, model];
  return every.every((m) => current.includes(m)) ? null : every.filter((m) => current.includes(m));
}

/** A project's Worker cap and whether it is its own; else the fleet's. */
export function projectMaxWorkers(policy: Dict, project: string): [number, boolean] {
  const own: Json = (((policy.projects || {})[project] || {}).foreman || {}).maxWorkers;
  return own === null || own === undefined ? [fleetRole(policy, "foreman", "maxWorkers"), false] : [own, true];
}

/** A project's Worker cap; the fleet's value is written as no setting, so the project follows the fleet again. */
export function setProjectMaxWorkers(policy: Dict, project: string, value: number): Dict {
  const fleet = fleetRole(policy, "foreman", "maxWorkers");
  return withProjectForeman(policy, project, (foreman) => {
    if (pyEq(value, fleet)) delete foreman.maxWorkers;
    else foreman.maxWorkers = value;
  });
}

/** A project's own settings, all of them, gone: it follows the computer and the fleet. */
export function removeProject(policy: Dict, project: string): Dict {
  return { ...policy, projects: Object.fromEntries(Object.entries(policy.projects || {}).filter(([key]) => key !== project)) };
}

// -- API credits --

export const API_BLURB =
  `${APP_NAME} uses your Claude subscription first. With API credits on, work moves to your Anthropic API key ` +
  "when the subscription is at its limit, or when a session is started on it, until this month's cap is used. " +
  "Chats and your own sessions keep your sign-in and its connectors; they use the key only at the limit or when you pick it.";
export const KEY_HOWTO = "Set the key on each computer: cobra-agent api-key (a key made outside a workspace also needs --workspace wrkspc_…).";

export function money(value: number): string {
  return `$${pyFixed(value, 2)}`;
}

/** policy.json's apiLane, off with no cap when it is not there. */
export function apiLane(policy: Dict): { enabled: boolean; monthlyCapUsd: number; testMode: boolean } {
  const lane: Dict = policy.apiLane || {};
  return { enabled: truthy(lane.enabled), monthlyCapUsd: Number(lane.monthlyCapUsd || 0), testMode: lane.testMode === true };
}

/** The lane changed; API test mode is kept as it was unless given, and ends with the lane off. */
export function setApiLane(policy: Dict, enabled: boolean, cap: number, testMode: boolean = apiLane(policy).testMode): Dict {
  return { ...policy, apiLane: { enabled, monthlyCapUsd: pyRound(Math.max(0.0, Math.min(100_000.0, cap)), 2), ...(enabled && testMode ? { testMode: true } : {}) } };
}

export const TEST_BLURB =
  `For a test against the subscription: ${APP_NAME}, every Foreman, new Workers and the helpers run on API credits only, each on the model it uses now. ` +
  `${APP_NAME} and running Foremen restart headless in a fresh conversation; running Workers finish on the subscription. ` +
  "At the cap the test stops and you are told: nothing moves back to the subscription. Turning it off restarts them in their terminals.";

const ROLE_WORDS: Readonly<Record<string, string>> = { lead: LEAD_NAME, foreman: "Foremen", worker: "Workers", helper: "helpers", job: "jobs", session: "your sessions", chat: "chats" };

/** The test's spend, every computer's added up: "$6.00 since … · Workers $5.00 · Cobra $1.00", or null with no test yet. */
export function testLine(lanes: Readonly<Record<string, Json>>): string | null {
  const reports = Object.values(lanes).flatMap((lane) => (truthy(lane) && truthy((lane as Dict).test) ? [(lane as Dict).test as Dict] : []));
  if (reports.length === 0) return null;
  const roles = new Map<string, number>();
  for (const report of reports) for (const row of (report.byRole || []) as Dict[]) roles.set(String(row.role), (roles.get(String(row.role)) ?? 0) + Number(row.spentUsd || 0));
  const total = reports.reduce((sum, report) => sum + Number(report.spentUsd || 0), 0);
  const since = reports.map((report) => String(report.since)).sort()[0]!;
  const rows = [...roles].sort((a, b) => b[1] - a[1]).map(([role, dollars]) => `${ROLE_WORDS[role] ?? role} ${money(dollars)}`);
  const ended = reports.every((report) => truthy(report.until));
  return [`${ended ? "the last test spent" : "spent"} ${money(total)} since ${since.slice(0, 16).replace("T", " ")}`, ...rows].join(" · ");
}

/** The fleet's spend this month: the highest any computer reports. */
export function fleetSpend(lanes: Readonly<Record<string, Json>>): number {
  const spends = Object.values(lanes).filter((lane) => truthy(lane)).map((lane) => Number((lane || {}).fleetUsd || 0));
  return Math.max(...(spends.length ? spends : [0.0]));
}

/** One computer's line: its key, what it spent, and what keeps it off the key. */
export function laneLine(lane: Dict): string {
  if (!truthy(lane.key)) return "no key: its sessions use the subscription only";
  const here: Dict = lane.here || {};
  const requests = Math.trunc(Number(here.requests || 0));
  const parts = [`${truthy(lane.open) ? "ready" : "key set"} · ${money(Number(here.dollars || 0))} this month in ${requests} request${requests === 1 ? "" : "s"}`];
  const error: Json = lane.lastError;
  if (truthy(error) && pyStr(pyGet(error, "message", "")).toLowerCase().includes("workspace") && !truthy(lane.workspace)) {
    parts.push("its key needs a workspace ID: cobra-agent api-key --workspace wrkspc_…");
  }
  if (!truthy(lane.keptToken)) parts.push("the Lead and Foremen stay on the subscription: keep a token with cobra-agent claude-token");
  if (!truthy(lane.gateway)) parts.push("its model gateway is not running");
  return parts.join(" · ");
}
