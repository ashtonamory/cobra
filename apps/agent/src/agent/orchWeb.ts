import type { HookOutput } from "./gate.ts";
import type { JudgeInput, JudgeMode, JudgeVerdict } from "./judge.ts";
import { exactOf } from "./pendingRequest.ts";
import { hostsIn, type JudgeConfig, type ResolvedPolicy } from "./permissions.ts";
import { LOG_EXACT_MAX, type PolicyEntry } from "./policy.ts";
import type { InRunAnswer } from "./webRuns.ts";
import { webCallOf, type WebCall } from "./webRules.ts";
import { isTainted, noteRead } from "./taint.ts";
import { afterReadHooks } from "./webClaims.ts";

/**
 * The Lead's and Foremen's web reads under Instinct: each WebFetch and WebSearch goes to the judge before Claude Code
 * asks you. The judge's allow runs it and its refusal tells the orchestrator
 * why; an escalation, a judge that cannot answer, or any policy but Instinct
 * prints nothing, so Claude Code's own prompt stands and reaches your phone
 * as it always did.
 *
 * Only those two tools: the hook is registered for them alone (orchWebHooks),
 * and anything else that reaches it is left to Claude Code. The judge sees
 * the role, never the conversation or the pages already read, so a page
 * cannot argue for the next fetch.
 *
 * Inside a research run (webRuns.ts) the run
 * answers first: its code rules refuse or ask, and a call its goal check
 * finds on-goal runs; anything else is judged alone as below.
 */

export const ORCH_WEB_TOOLS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch"]);

/** Who asks: the Lead, or the Foreman of a project (its id in projects.json). */
export type OrchWho = { role: "lead" } | { role: "foreman"; project: string };

const PROJECT_ID = /^[A-Za-z0-9._-]{1,80}$/;

/** The hook's argument read back: `lead`, or `foreman:<project id>`. */
export function parseOrchWho(text: string): OrchWho | null {
  if (text === "lead") return { role: "lead" };
  const match = /^foreman:(.+)$/.exec(text);
  return match && PROJECT_ID.test(match[1]!) ? { role: "foreman", project: match[1]! } : null;
}

export function orchWhoText(who: OrchWho): string {
  return who.role === "lead" ? "lead" : `foreman:${who.project}`;
}

/** What the judge is told the orchestrator is for: its role, in Cobra's words, never its own. */
export function orchTask(who: OrchWho, projectName?: string): string {
  if (who.role === "lead") {
    return "This is Cobra's Lead, not a Worker: the person's assistant. It answers the person's questions, keeps their notes and briefs the Foremen that run the coding Workers. It cannot write files, run commands or start Workers itself. It reads the web to answer the person and to plan their work.";
  }
  return `This is the Foreman of the project "${projectName ?? who.project}", not a Worker: it plans the project's work, briefs the Workers that do it and reviews what they hand back. It reads the web to plan and check that work.`;
}

/**
 * The PreToolUse entry that sends those two tools to the Gate, for a Lead's
 * or a Foreman's --settings beside its other hooks. The Gate reads the
 * policy at each call, so a switch to or from Instinct needs no restart.
 */
export function orchWebHooks(paths: { node: string; policyHook: string }, who: OrchWho): Record<string, unknown> {
  const quote = (value: string) => (/^[A-Za-z0-9_./:=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);
  const command = [quote(paths.node), "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", quote(paths.policyHook), "--orch", orchWhoText(who)].join(" ");
  // And after each page read: whether it was what its address claims (webClaims.ts), under any preset.
  return { PreToolUse: [{ matcher: [...ORCH_WEB_TOOLS].join("|"), hooks: [{ type: "command", command, timeout: 30 }] }], ...afterReadHooks(command) };
}

export type OrchWebDeps = {
  /** The policy in force where it works: the Lead's computer, a Foreman's project. Null when it cannot be read. */
  policy: (who: OrchWho) => Promise<ResolvedPolicy | null>;
  /** The project's name for a Foreman's task line. */
  nameOf?: (project: string) => Promise<string | undefined>;
  judge?: (input: JudgeInput, config: JudgeConfig, mode: JudgeMode) => Promise<JudgeVerdict>;
  /** The orchestrator's research run in force, for this call (webRuns.ts checkInRun). */
  research?: (who: OrchWho, call: WebCall, policy: ResolvedPolicy) => Promise<InRunAnswer>;
  /** Whether the orchestrator's conversation has read the web, and noting that it did (taint.ts). */
  taint?: { of: (who: string) => boolean; read: (who: string, why: string, hosts: readonly string[]) => void };
  log: (entry: PolicyEntry) => void;
  now: () => number;
};

const JUDGED_MS = 10 * 60_000;
const judged = new Map<string, { verdict: "allow" | "refuse"; reason: string; until: number }>();

/** Forgets the kept verdicts (tests). */
export function forgetOrchVerdicts(): void {
  judged.clear();
}

/**
 * The answer to one of the orchestrator's hook events: allow or deny when
 * the judge decided under Instinct, else null (Claude Code asks you).
 */
export async function answerOrchWeb(who: OrchWho, event: unknown, deps: OrchWebDeps): Promise<HookOutput | null> {
  const answer = await answerWeb(who, event, deps);
  // Anything not refused may run (allowed, or left to Claude Code's prompt, which the person may allow): from here the conversation has read the web.
  if (answer?.hookSpecificOutput.permissionDecision !== "deny" && deps.taint && typeof event === "object" && event !== null) {
    const raw = event as Record<string, unknown>;
    const input = typeof raw.tool_input === "object" && raw.tool_input !== null ? (raw.tool_input as Record<string, unknown>) : {};
    if (raw.hook_event_name === "PreToolUse" && typeof raw.tool_name === "string" && ORCH_WEB_TOOLS.has(raw.tool_name)) {
      const subject = typeof input.url === "string" ? input.url : typeof input.query === "string" ? input.query : "";
      deps.taint.read(orchWhoText(who), `${raw.tool_name} ${subject}`.slice(0, 200), hostsIn(raw.tool_name, input));
    }
  }
  return answer;
}

async function answerWeb(who: OrchWho, event: unknown, deps: OrchWebDeps): Promise<HookOutput | null> {
  if (typeof event !== "object" || event === null) return null;
  const raw = event as Record<string, unknown>;
  if (raw.hook_event_name !== "PreToolUse" || typeof raw.tool_name !== "string" || !ORCH_WEB_TOOLS.has(raw.tool_name)) return null;
  const tool = raw.tool_name;
  const input = typeof raw.tool_input === "object" && raw.tool_input !== null ? (raw.tool_input as Record<string, unknown>) : {};
  const policy = await deps.policy(who).catch(() => null);
  if (!policy?.escalate || !deps.judge) return null;
  const exact = exactOf(tool, input, 3000);
  const asker = orchWhoText(who);
  const subject = (typeof input.url === "string" ? input.url : typeof input.query === "string" ? input.query : "").replace(/\s+/g, " ").slice(0, 300);
  const call = webCallOf(tool, input);
  const inRun = call && deps.research ? await deps.research(who, call, policy).catch((): InRunAnswer => ({ decision: "single" })) : null;
  if (inRun && inRun.decision !== "single") {
    deps.log({ at: deps.now(), worker: asker, tool, decision: inRun.decision, rule: `web-run:${inRun.run}`, subject, exact: exactOf(tool, input, LOG_EXACT_MAX), judge: inRun.by, reason: inRun.reason });
    // A people-search site or a personal profile: Claude Code's prompt is the question to you.
    if (inRun.decision === "ask") return null;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: inRun.decision,
        permissionDecisionReason:
          inRun.decision === "allow" ? `Cobra policy (web-run): ${inRun.reason}` : `Cobra's research rules: ${inRun.reason}. Work without it; never retry it reworded.`,
      },
    };
  }
  const key = `${asker}\0${exact}`;
  let verdict: { verdict: "allow" | "refuse" | "escalate"; reason: string };
  let by = "kept";
  const kept = judged.get(key);
  if (kept && kept.until > deps.now()) {
    verdict = kept;
  } else {
    const name = who.role === "foreman" ? await deps.nameOf?.(who.project).catch(() => undefined) : undefined;
    const result = await deps
      .judge(
        { task: orchTask(who, name), capability: "network", rule: `${who.role}-web`, reason: `the ${who.role === "lead" ? "Lead" : "Foreman"} reads the web outside Cobra's sandbox`, action: exact },
        policy.judge,
        { escalate: true, rules: policy.rules, ...(deps.taint?.of(asker) ? { tainted: true } : {}) },
      )
      .catch((): JudgeVerdict => ({ verdict: "escalate", reason: "the judge failed, so it comes to you", by: "none" }));
    verdict = result;
    by = result.by;
    if (result.verdict !== "escalate") judged.set(key, { verdict: result.verdict, reason: result.reason, until: deps.now() + JUDGED_MS });
  }
  const decision = verdict.verdict === "allow" ? "allow" : verdict.verdict === "refuse" ? "deny" : "ask";
  deps.log({
    at: deps.now(),
    worker: asker,
    tool,
    decision,
    rule: `judge:${who.role}-web`,
    subject,
    exact: exactOf(tool, input, LOG_EXACT_MAX),
    judge: by,
    reason: verdict.reason,
  });
  // Escalated: nothing printed, and Claude Code's prompt is the question to you.
  if (decision === "ask") return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: `Cobra policy (judge:${who.role}-web): ${verdict.reason}`,
    },
  };
}

/** The live ones: the policy read at each call, the project's key from its checkout, the fleet's judge. */
export const liveOrchWebDeps: OrchWebDeps = {
  async policy(who) {
    const [{ loadPolicy }, { computerName, projectKeyFor }] = await Promise.all([import("./permissions.ts"), import("./memory.ts")]);
    if (who.role === "lead") return loadPolicy({ computer: computerName() });
    const project = await projectById(who.project);
    // A Foreman whose project is gone is not judged: Claude Code asks.
    if (!project) return null;
    return loadPolicy({ computer: computerName(), project: await projectKeyFor(project) });
  },
  async nameOf(id) {
    return (await projectById(id))?.name;
  },
  judge: async (input, config, mode) => {
    const live = await import("./judge.ts");
    return live.judge(input, config, live.liveJudgeDeps, mode);
  },
  taint: {
    of: (who) => isTainted(who) !== null,
    read: (who, why, hosts) => noteRead(who, why, hosts),
  },
  research: async (who, call, policy) => {
    const [runs, { liveJudgeDeps }] = await Promise.all([import("./webRuns.ts"), import("./judge.ts")]);
    const claims = await import("./webClaims.ts");
    const flagged = (url: string) => claims.flaggedSite(claims.loadFlags(), url, Date.now());
    const { finishes } = await import("./finishes.ts");
    const tell = (owner: string, text: string, needs?: import("./onCall.ts").Needs) => finishes.tell(owner, text, "event", needs);
    return runs.checkInRun({ load: () => runs.loadRuns(), save: (list) => runs.saveRuns(list), judge: liveJudgeDeps, now: () => Date.now(), flagged, tell }, orchWhoText(who), call, policy);
  },
  log: (entry) => {
    void import("./policy.ts").then(({ logDecision }) => logDecision(entry));
  },
  now: () => Date.now(),
};

async function projectById(id: string): Promise<{ id: string; path: string; name: string } | undefined> {
  const [{ loadRegistry }, { DEFAULT_CONFIG_PATH }] = await Promise.all([import("./registry.ts"), import("./collect/projects.ts")]);
  return (await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH)).projects.find((project) => project.id === id);
}
