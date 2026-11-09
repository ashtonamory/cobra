/**
 * Allow, the way Meta Muse does it: a Worker's prompt allowed
 * once, for the rest of its task, for this project or always. The agent offers the scopes on the
 * request (`allow`, agent allowScopes.ts) and keeps once and task itself; for this project and
 * always the desk also writes the hosts to the policy's allowlist, as Settings → Permissions does,
 * on every computer. A port of the phone's `src/allowScopeRules.ts`; the GTK desk's
 * `cobradesk/allow_scope.py` says the same: change all three together.
 */
import * as api from "./api.ts";
import * as config from "./config.ts";
import { isDict, type Dict, type Json } from "./json.ts";
import * as permissions from "./permissions.ts";
import { pySorted } from "./py.ts";

export interface AllowOffer {
  scopes: string[];
  hosts?: string[];
  tool?: string;
  install?: string;
  project?: string;
  suggest?: string;
}

export interface ScopeChoice {
  scope: string;
  label: string;
  /** What it covers, in a few words. */
  detail: string;
  /** Cobra suggests it: several clean Allows of the same host here. */
  suggested: boolean;
  /** Where it writes the policy: the project's allowlist, the fleet's, or nowhere. */
  writes: "project" | "fleet" | null;
}

const strings = (value: Json): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : undefined;
const word = (value: Json): string | undefined => (typeof value === "string" && value ? value : undefined);

/** A request's `allow`, as the agent sent it, or null from an older agent or when once is all. */
export function allowOffer(request: Json): AllowOffer | null {
  const found = isDict(request) ? request.allow : null;
  if (!isDict(found)) return null;
  const scopes = strings(found.scopes);
  if (!scopes) return null;
  const out: AllowOffer = { scopes };
  const hosts = strings(found.hosts);
  if (hosts) out.hosts = hosts;
  for (const key of ["tool", "install", "project", "suggest"] as const) {
    const value = word(found[key]);
    if (value) out[key] = value;
  }
  return out;
}

/** An MCP tool's name for people: `mcp__github__get_issue` → "github get_issue". */
export function toolName(tool: string): string {
  const [, server = "", ...rest] = tool.split("__");
  return [server, rest.join("__")].filter(Boolean).join(" ") || tool;
}

function covers(offer: AllowOffer): string {
  if (offer.tool) return toolName(offer.tool);
  if (offer.install) return `${offer.install} installs`;
  const hosts = offer.hosts ?? [];
  return hosts.length === 1 ? hosts[0] : `${hosts.length} sites`;
}

/** A project's policy key (owner/repo) for people: its repository's name. */
function projectName(project: string): string {
  return project.split("/").pop() || project;
}

/** The ways an Allow can go beyond this once, in order; none when the agent offers only once. */
export function scopeChoices(offer: AllowOffer | null): ScopeChoice[] {
  if (!offer) return [];
  const what = covers(offer);
  const choices: ScopeChoice[] = [];
  for (const scope of offer.scopes) {
    if (scope === "task") choices.push({ scope, label: "For this task", detail: `${what} until this Worker is done`, suggested: false, writes: null });
    if (scope === "project" && offer.project)
      choices.push({ scope, label: `Always in ${projectName(offer.project)}`, detail: `${what} for every Worker in ${projectName(offer.project)}`, suggested: offer.suggest === "project", writes: "project" });
    if (scope === "always") choices.push({ scope, label: "Always", detail: `${what} for every Worker on every computer`, suggested: offer.suggest === "always", writes: "fleet" });
  }
  return choices;
}

/** The choices with Cobra's suggestion first. */
export function ordered(choices: readonly ScopeChoice[]): ScopeChoice[] {
  return [...choices.filter((c) => c.suggested), ...choices.filter((c) => !c.suggested)];
}

/** Why Cobra suggests one, for the line over the choices. */
export function suggestLine(offer: AllowOffer | null): string | null {
  const choice = scopeChoices(offer).find((entry) => entry.suggested);
  return choice && offer ? `You have allowed ${covers(offer)} here before. ${choice.label}?` : null;
}

/** The policy with the offer's hosts on the allowlist the choice writes; unchanged when it writes none. */
export function withAllowedHosts(policy: Dict, choice: ScopeChoice, offer: AllowOffer): Dict {
  const hosts = offer.hosts ?? [];
  if (hosts.length === 0 || choice.writes === null) return policy;
  if (choice.writes === "fleet") return hosts.reduce((next, host) => permissions.addFleetHost(next, host), policy);
  const project = offer.project;
  if (!project) return policy;
  const level: Dict = { ...((policy.projects || {})[project] || {}) };
  const allow = pySorted([...new Set([...(((level.network || {}).allow || []) as string[]), ...hosts])]);
  return { ...policy, projects: { ...(policy.projects || {}), [project]: { ...level, network: { allow } } } };
}

/**
 * The Allow entries of a menu (the Verbs menu, the Projects row's ▾): Allow once, then each
 * scope the request offers, Cobra's suggestion first. Empty when once is all, so the menu keeps
 * its plain Allow.
 */
export function allowMenu(offer: AllowOffer | null): Array<{ action: string; label: string; choice: ScopeChoice | null }> {
  const choices = ordered(scopeChoices(offer));
  if (!choices.length) return [];
  return [
    { action: "approve", label: "Allow once", choice: null },
    ...choices.map((choice) => ({ action: `approve:${choice.scope}`, label: choice.suggested ? `${choice.label} (suggested)` : choice.label, choice })),
  ];
}

/** What the confirmation names. */
export function confirmWords(choice: ScopeChoice | null): string {
  if (!choice) return "Allow this command";
  return choice.writes ? `Allow ${choice.detail}` : `Allow this ${choice.detail}`;
}

/** The /session body's extra for an Allow: the dialog key, and the scope when it is not once. */
export function allowExtra(key: string, choice: ScopeChoice | null): Dict {
  return { ...(key ? { dialogKey: key } : {}), ...(choice && choice.scope !== "once" ? { scope: choice.scope } : {}) };
}

/**
 * An Allow with its scope: the agent allows this call and keeps a task scope itself; for this
 * project or always the hosts then go on the fleet's policy, the newest revision plus one, on every
 * computer that answers, confirmed (the caller took the second press). Returns the toast's words.
 */
export async function allowWithScope(machine: string, session: string, key: string, offer: AllowOffer | null, choice: ScopeChoice | null): Promise<string> {
  await api.sessionAction(machine, session, "approve", allowExtra(key, choice));
  if (!choice) return "Allowed";
  if (!choice.writes || !offer) return `Allowed: ${choice.detail}`;
  const reads: Record<string, Dict> = {};
  await Promise.all(config.MACHINES.map(async (m) => {
    try {
      const reply = await api.policy(m.machine);
      if (isDict(reply)) reads[m.machine] = reply;
    } catch {
      // Not answering: it is left behind, and Settings → Permissions offers Bring up to date.
    }
  }));
  const found = permissions.newest(reads);
  if (!found) return `Allowed once here; no computer answered with a policy`;
  const next = withAllowedHosts(found[1].policy, choice, offer);
  if (next === found[1].policy) return `Allowed: ${choice.detail}`;
  const policy = { ...next, revision: permissions.nextRevision(reads) };
  const missed: string[] = [];
  for (const m of config.MACHINES) {
    if (!reads[m.machine]) {
      missed.push(config.label(m.machine));
      continue;
    }
    try {
      await api.policyWrite(m.machine, policy, true);
    } catch {
      missed.push(config.label(m.machine));
    }
  }
  return missed.length ? `Allowed here; not reached: ${missed.join(", ")}. Settings → Permissions brings them up to date.` : `Allowed: ${choice.detail}`;
}
