import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";

import { projectOfWorker, readStanding, type Standing } from "./allowScopes.ts";
import { codexCalls } from "./codexTools.ts";
import { grant, GRANT_MS, takeCallGrant } from "./grants.ts";
import type { JudgeInput, JudgeMode, JudgeVerdict } from "./judge.ts";
import { computerName } from "./computerName.ts";
import { exactOf, recordPending } from "./pendingRequest.ts";
import { gate, loadPolicy, type JudgeConfig, type ResolvedPolicy } from "./permissions.ts";
import { LOG_EXACT_MAX, logDecision, readScope, subjectOf, WORKER_ID, type Decision, type PolicyEntry, type ToolCall, type WorkerScope } from "./policy.ts";
import { STATE_DIR } from "./paths.ts";
import type { PendingRequest } from "./pendingRequest.ts";
import type { InRunAnswer } from "./webRuns.ts";
import { webCallOf, type WebCall } from "./webRules.ts";
import { hostsIn } from "./permissions.ts";
import { isTainted, noteRead } from "./taint.ts";
import { isAfterEvent, type AfterOutput } from "./webClaims.ts";

/**
 * The Gate: where a Worker's or a job's PreToolUse hook gets its answer.
 *
 * The hook (policyHook.ts) sends Claude Code's event here over a Unix socket
 * only this account can open, and prints what comes back. The agent holds the
 * policy, the scopes, the log and the pending requests, so none of them has
 * to be inside a sandbox for a hook in there to be answered (Contain, phase 3: the spike ran a hook this way).
 */

export const GATE_SOCKET = join(STATE_DIR, "gate.sock");

/** What the hook prints for Claude Code, or null for nothing (Claude Code's own prompt stands). */
export type HookOutput = {
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "allow" | "ask" | "deny"; permissionDecisionReason: string };
};

export type AnswerDeps = {
  readScope: (id: string) => WorkerScope | null;
  /** The policy in force for Worker `id`: this computer's and its project's levels too. */
  policy: (id: string) => ResolvedPolicy;
  /** What Worker `id` was allowed for the rest of its task (allowScopes.ts). */
  standing?: (id: string) => Standing;
  log: (entry: PolicyEntry) => void;
  recordPending: (id: string, entry: PendingRequest) => void;
  now: () => number;
  /** The judge (judge.ts); none means every judged call is refused. */
  judge?: (input: JudgeInput, config: JudgeConfig, mode: JudgeMode) => Promise<JudgeVerdict>;
  /** The Worker's task, as it was spawned with, for the judge. */
  taskOf?: (id: string) => Promise<string | null>;
  /** Hosts the judge allowed a contained Worker to reach (grants.ts). */
  grant?: (id: string, hosts: readonly string[], until: number) => void;
  /** Whether the Worker runs on a local model (extras.ts onLocalModel): the judge never opens the network or an outside tool for one. */
  localOf?: (id: string) => Promise<boolean>;
  /** A Worker's research run (webRuns.ts workerResearch), for a web call the judge would rule on. */
  research?: (id: string, call: WebCall, policy: ResolvedPolicy) => Promise<InRunAnswer>;
  /** Whether Worker `id` has read the web, and noting that it did (taint.ts). */
  taint?: { of: (id: string) => boolean; read: (id: string, why: string, hosts: readonly string[]) => void };
};

export const liveAnswerDeps: AnswerDeps = {
  readScope: (id) => readScope(id),
  // Read on every call: a change on the phone reaches the next tool call. Its computer's and project's levels count too.
  policy: (id) => {
    const project = projectOfWorker(id);
    return loadPolicy({ computer: computerName(), ...(project ? { project } : {}) });
  },
  standing: (id) => readStanding(id),
  log: (entry) => logDecision(entry),
  recordPending: (id, entry) => recordPending(id, entry),
  now: () => Date.now(),
  // Loaded only when a call is judged: the hook itself never needs it.
  judge: async (input, config, mode) => {
    const live = await import("./judge.ts");
    return live.judge(input, config, live.liveJudgeDeps, mode);
  },
  async taskOf(id) {
    const { loadExtras } = await import("./extras.ts");
    return (await loadExtras()).find((extra) => extra.id === id)?.worker?.task ?? null;
  },
  grant,
  async localOf(id) {
    const { loadExtras, onLocalModel } = await import("./extras.ts");
    const extra = (await loadExtras()).find((entry) => entry.id === id);
    return extra ? onLocalModel(extra) : false;
  },
  taint: {
    of: (id) => isTainted(`worker:${id}`) !== null,
    read: (id, why, hosts) => noteRead(`worker:${id}`, why, hosts),
  },
  // Only a Worker its Foreman gave a research goal; loaded only then.
  async research(id, call, policy) {
    const { loadExtras } = await import("./extras.ts");
    const extra = (await loadExtras()).find((entry) => entry.id === id);
    if (!extra?.worker?.research) return { decision: "single" };
    const [runs, { liveJudgeDeps }, { finishes }, { recordDecided }, claims] = await Promise.all([import("./webRuns.ts"), import("./judge.ts"), import("./finishes.ts"), import("./decided.ts"), import("./webClaims.ts")]);
    const deps = {
      load: () => runs.loadRuns(),
      save: (list: readonly import("./webRuns.ts").WebRun[]) => runs.saveRuns(list),
      judge: liveJudgeDeps,
      tell: (owner: string, text: string, needs?: import("./onCall.ts").Needs) => finishes.tell(owner, text, "event", needs),
      decided: (entry: Omit<import("./decided.ts").Decided, "id" | "at">) => recordDecided(entry),
      log: (line: string) => console.log(`[cobra-agent] ${line}`),
      now: () => Date.now(),
      flagged: (url: string) => claims.flaggedSite(claims.loadFlags(), url, Date.now()),
    };
    return runs.workerResearch(deps, { id, owner: extra.worker.owner, project: extra.parent, task: extra.worker.task, goal: extra.worker.research }, call, policy);
  },
};

/**
 * What a local model's Worker gets instead of the judge, for reaching the
 * network or an outside tool: the person. An open-weight model is easier to
 * steer with planted text than Claude, and the judge's Allow would open a
 * host for it with nobody looking (reading outside is still judged: it
 * opens nothing).
 */
export const LOCAL_ASKS: ReadonlySet<string> = new Set(["network", "mcp"]);

/** The policy with what the Worker was allowed for its task: its hosts as listed ones, its tools and installs as standing. */
export function withStanding(policy: ResolvedPolicy, standing: Standing | undefined): ResolvedPolicy {
  if (!standing || standing.hosts.length + standing.tools.length + standing.installs.length === 0) return policy;
  return { ...policy, network: [...policy.network, ...standing.hosts], standing: { tools: standing.tools, installs: standing.installs } };
}

/** A verdict the judge gave, kept so the same action is not judged again at once. */
const JUDGED_MS = 10 * 60_000;
const judged = new Map<string, { decision: Decision; until: number }>();

/**
 * The answer to one hook event for Worker (or job) `id`. Anything it cannot
 * read (no scope, not a PreToolUse event, bad input) is null: a broken path
 * can cost you a question, never grant a permission.
 */
export async function answerHook(id: string, event: unknown, deps: AnswerDeps = liveAnswerDeps, via: "gate" | "hook" = "gate"): Promise<HookOutput | null> {
  if (!WORKER_ID.test(id) || typeof event !== "object" || event === null) return null;
  const raw = event as Record<string, unknown>;
  if (raw.hook_event_name !== "PreToolUse") return null;
  const scope = deps.readScope(id);
  if (!scope) return null;
  const call: ToolCall = {
    tool_name: typeof raw.tool_name === "string" ? raw.tool_name : "",
    tool_input: typeof raw.tool_input === "object" && raw.tool_input !== null ? (raw.tool_input as Record<string, unknown>) : {},
    cwd: typeof raw.cwd === "string" && raw.cwd.startsWith("/") ? raw.cwd : scope.worktree,
  };
  const policy = withStanding(deps.policy(id), deps.standing?.(scope.id));
  let answer = gate(call, scope, policy);
  if (answer.decision === "judge" && LOCAL_ASKS.has(answer.capability) && (await deps.localOf?.(scope.id).catch(() => true))) {
    // Fails toward asking: a Worker whose model could not be read is asked about too.
    answer =
      call.tool_name === "WebFetch" || call.tool_name === "WebSearch"
        ? // Its harness would hand the page to the same local model; on Pi it reads through Cobra's reader (webReader.ts).
          { decision: "deny", rule: "local-model:web", reason: "a Worker on a local model reads the web only through Cobra's reader (web_search and web_read on Pi), never with WebFetch or WebSearch" }
        : { decision: "ask", rule: `local-model:${answer.capability}`, reason: "a local model's Worker asks you, never the judge, before it reaches the internet or an outside tool" };
  }
  let verdict: Decision;
  let judgedBy: string | undefined;
  // A web call in the Worker's research run: the run's rules and goal check answer first; what they cannot decide is judged alone.
  const webCall = answer.decision === "judge" && answer.capability === "network" ? webCallOf(call.tool_name, call.tool_input) : null;
  const inRun = webCall && deps.research ? await deps.research(scope.id, webCall, policy).catch((): InRunAnswer => ({ decision: "single" })) : null;
  if (answer.decision === "judge" && inRun && inRun.decision !== "single") {
    judgedBy = inRun.by;
    verdict =
      inRun.decision === "ask"
        ? { decision: "ask", rule: `web-run:${inRun.run}`, reason: `research run ${inRun.run}: ${inRun.reason}` }
        : { decision: inRun.decision, rule: `web-run:${inRun.run}`, reason: inRun.decision === "deny" ? `${inRun.reason}. Work without it; never retry it reworded.` : inRun.reason };
    // On-goal: its host too, so a contained Worker's proxy lets it through, as a judged network call does.
    if (verdict.decision === "allow" && answer.hosts.length > 0) deps.grant?.(scope.id, answer.hosts, deps.now() + GRANT_MS);
  } else if (answer.decision === "judge") {
    const exact = exactOf(call.tool_name, call.tool_input, 3000);
    const key = `${scope.id}\0${answer.capability}\0${exact}`;
    const kept = judged.get(key);
    if (kept && kept.until > deps.now()) {
      verdict = kept.decision;
      judgedBy = "kept";
    } else {
      const task = (await deps.taskOf?.(scope.id).catch(() => null)) ?? "(no task was recorded for this Worker)";
      // Instinct: the judge may pass a call to you, and one it cannot answer comes to you rather than being refused.
      const mode: JudgeMode = { escalate: policy.escalate, rules: policy.rules, ...(deps.taint?.of(scope.id) ? { tainted: true } : {}) };
      const failed = (reason: string): JudgeVerdict =>
        mode.escalate ? { verdict: "escalate", reason: `${reason}, so it comes to you`, by: "none" } : { verdict: "refuse", reason: `${reason}, so Cobra refused this`, by: "none" };
      const result: JudgeVerdict = deps.judge
        ? await deps.judge({ task, capability: answer.capability, rule: answer.ruled.rule, reason: answer.ruled.reason, action: exact }, policy.judge, mode).catch(() => failed("the judge failed"))
        : failed("the judge is not available here");
      judgedBy = result.by;
      // Refused: the Worker is told why and carries on (block, explain, carry on). Escalated: a prompt, as the rules would have asked.
      verdict =
        result.verdict === "allow"
          ? { decision: "allow", rule: `judge:${answer.capability}`, reason: result.reason }
          : result.verdict === "escalate"
            ? { decision: "ask", rule: `judge:${answer.capability}`, reason: `the judge passed this to you: ${result.reason}` }
            : { decision: "deny", rule: `judge:${answer.capability}`, reason: result.reason };
      judged.set(key, { decision: verdict, until: deps.now() + JUDGED_MS });
    }
    // An allowed network call: its hosts too, so a contained Worker's proxy lets it through.
    if (verdict.decision === "allow" && answer.hosts.length > 0) deps.grant?.(scope.id, answer.hosts, deps.now() + GRANT_MS);
  } else {
    verdict = answer;
  }
  const at = deps.now();
  if (readsWeb(call.tool_name, verdict)) {
    try {
      deps.taint?.read(scope.id, `${call.tool_name} ${subjectOf(call)}`.slice(0, 200), hostsIn(call.tool_name, call.tool_input));
    } catch {
      // A hook answering for itself may not write the agent's state; the answer still stands.
    }
  }
  deps.log({
    at,
    worker: scope.id,
    tool: call.tool_name,
    decision: verdict.decision,
    rule: verdict.rule,
    subject: subjectOf(call),
    exact: exactOf(call.tool_name, call.tool_input, LOG_EXACT_MAX),
    ...(via === "hook" ? { via } : {}),
    ...(judgedBy ? { judge: judgedBy, reason: verdict.reason } : {}),
  });
  if (verdict.decision === "ask" || verdict.decision === "none") {
    // Never throws; a request it could not keep is read off the screen instead.
    deps.recordPending(scope.id, {
      at,
      tool: call.tool_name,
      ...(typeof raw.tool_use_id === "string" ? { toolUseId: raw.tool_use_id } : {}),
      input: call.tool_input,
      decision: verdict.decision,
      rule: verdict.rule,
      reason: verdict.reason,
    });
  }
  if (verdict.decision === "none") return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: verdict.decision,
      permissionDecisionReason: `Cobra policy (${verdict.rule}): ${verdict.reason}`,
    },
  };
}

/**
 * Whether a call taints its Worker (taint.ts): a web search or page read
 * that may run (allowed, or left to you, who may allow it), or a shell call
 * to the internet that the judge or a research run allowed. A listed host,
 * an install and loopback do not.
 */
export function readsWeb(tool: string, verdict: Decision): boolean {
  if (tool === "WebFetch" || tool === "WebSearch") return verdict.decision !== "deny";
  return verdict.decision === "allow" && (verdict.rule === "judge:network" || verdict.rule.startsWith("web-run:"));
}

function codexOutput(decision: "allow" | "deny", reason: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } };
}

/** What Codex should do after Cobra has made a remote approval request. */
export function codexAskedReason(reason: string): string {
  return `Cobra asked you: ${reason}. Wait for an answer, or say you are blocked and stop.`;
}

/** Keep the same audit shape as answerHook for Codex's translated calls. */
function logCodexDecision(deps: AnswerDeps, scope: WorkerScope, call: ToolCall, verdict: Decision, via: "gate" | "hook"): void {
  deps.log({
    at: deps.now(),
    worker: scope.id,
    tool: call.tool_name,
    decision: verdict.decision,
    rule: verdict.rule,
    subject: subjectOf(call),
    exact: exactOf(call.tool_name, call.tool_input, LOG_EXACT_MAX),
    ...(via === "hook" ? { via } : {}),
  });
}

/**
 * Codex's hook is fail-open when it returns no decision, unlike Claude's.
 * This adapter therefore returns only allow or deny: an unparseable call,
 * unknown Worker, unavailable judge, or policy ask never executes directly.
 *
 * The full event is stored when a remote approval is needed, so its matching
 * one-time grant can authorize only the retry of that original event.
 */
export async function answerCodexHook(
  id: string,
  event: unknown,
  deps: AnswerDeps = liveAnswerDeps,
  via: "gate" | "hook" = "gate",
): Promise<HookOutput> {
  const denyUnreadable = (reason: string): HookOutput => codexOutput("deny", `Cobra policy (codex-unreadable): ${reason}`);
  if (!WORKER_ID.test(id) || typeof event !== "object" || event === null) return denyUnreadable("Cobra could not read this tool call, so it did not run");
  const raw = event as Record<string, unknown>;
  if (raw.hook_event_name !== "PreToolUse") return denyUnreadable("Cobra answers only PreToolUse calls here");
  const scope = deps.readScope(id);
  if (!scope) return denyUnreadable("Cobra does not know this Worker, so the call did not run");
  const call: ToolCall = {
    tool_name: typeof raw.tool_name === "string" ? raw.tool_name : "",
    tool_input: typeof raw.tool_input === "object" && raw.tool_input !== null ? (raw.tool_input as Record<string, unknown>) : {},
    cwd: typeof raw.cwd === "string" && raw.cwd.startsWith("/") ? raw.cwd : scope.worktree,
  };
  if (takeCallGrant(scope.id, call.tool_name, call.tool_input, deps.now())) {
    const verdict: Decision = { decision: "allow", rule: "granted-once", reason: "you allowed this exact call" };
    logCodexDecision(deps, scope, call, verdict, via);
    return codexOutput("allow", "Cobra: you allowed this call");
  }
  const calls = codexCalls(call);
  if (!calls) {
    const verdict: Decision = { decision: "deny", rule: "codex-unreadable", reason: `Cobra could not read this ${call.tool_name} call, so it did not run` };
    logCodexDecision(deps, scope, call, verdict, via);
    return codexOutput("deny", `Cobra policy (${verdict.rule}): ${verdict.reason}`);
  }
  const policy = withStanding(deps.policy(id), deps.standing?.(scope.id));
  let asked: Decision | null = null;
  for (const translated of calls) {
    const result = gate(translated, scope, policy);
    // A Codex Worker cannot run a judge request until that asynchronous path is
    // explicitly wired. Refuse rather than accidentally broadening access;
    // under Instinct, ask you instead, as a call the judge cannot answer does.
    const verdict: Decision =
      result.decision !== "judge"
        ? result
        : policy.escalate
          ? { decision: "ask", rule: "codex-judge-unavailable", reason: "Cobra cannot judge this Codex call yet, so it comes to you" }
          : { decision: "deny", rule: "codex-judge-unavailable", reason: "Cobra cannot judge this Codex call yet, so it did not run" };
    logCodexDecision(deps, scope, translated, verdict, via);
    if (verdict.decision === "deny") return codexOutput("deny", `Cobra policy (${verdict.rule}): ${verdict.reason}`);
    if (verdict.decision === "ask") asked ??= verdict;
  }
  if (asked) {
    deps.recordPending(scope.id, {
      at: deps.now(),
      tool: call.tool_name,
      ...(typeof raw.tool_use_id === "string" ? { toolUseId: raw.tool_use_id } : {}),
      input: call.tool_input,
      decision: "ask",
      rule: asked.rule,
      reason: asked.reason,
      // No dialog of Codex's shows it: the agent draws it as the prompt (codexAsks.ts).
      remote: true,
    });
    return codexOutput("deny", codexAskedReason(asked.reason));
  }
  return codexOutput("allow", "Cobra policy: allowed");
}

const BODY_MAX = 2_000_000;

/** A request's body as text, up to BODY_MAX (a longer one is cut off). */
export function readBody(req: IncomingMessage, then: (body: string) => void): void {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    body += chunk;
    if (body.length > BODY_MAX) req.destroy();
  });
  req.on("end", () => then(body));
}

/** The Gate's server: `POST /hook?worker=<id>&engine=codex` with the hook's event, answered `{output}`. */
export function startGate(
  options: {
    socket?: string;
    deps?: AnswerDeps;
    log?: (line: string) => void;
    /** `POST /permission?worker=<id>`: a headless Worker's permission tool out of the sandbox (headlessWorkers.ts servePermission). */
    permission?: (id: string, req: IncomingMessage, res: ServerResponse) => void;
    /** `POST /hook?orch=lead|foreman:<id>`: the Lead's or a Foreman's web read under Instinct (orchWeb.ts). */
    orch?: (who: string, event: unknown) => Promise<HookOutput | null>;
    /** A page read's after-event (PostToolUse, PostToolUseFailure) from any of them: `who` is lead, foreman:<id> or worker:<id> (webClaims.ts). */
    after?: (who: string, event: unknown) => AfterOutput | null;
    /** `POST /usage?as=<role>:<session>`: a turn's tokens from the Stop hook of a Lead, Foreman or uncontained Worker (usageLedger.ts). */
    usage?: (as: string, body: unknown) => void;
  } = {},
): () => void {
  const socket = options.socket ?? GATE_SOCKET;
  const deps = options.deps ?? liveAnswerDeps;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://gate");
    if (url.pathname === "/permission" && options.permission) {
      options.permission(url.searchParams.get("worker") ?? "", req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/usage" && options.usage) {
      const take = options.usage;
      readBody(req, (body) => {
        try {
          take(url.searchParams.get("as") ?? "", JSON.parse(body));
        } catch {
          // Not a turn: nothing counted.
        }
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/hook") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > BODY_MAX) req.destroy();
    });
    req.on("end", () => {
      void (async () => {
        let output: HookOutput | AfterOutput | null = null;
        try {
          const id = url.searchParams.get("worker") ?? "";
          const orch = url.searchParams.get("orch");
          const event: unknown = JSON.parse(body);
          output = isAfterEvent(event)
            ? (options.after?.(orch ?? `worker:${id}`, event) ?? null)
            : orch !== null
              ? ((await options.orch?.(orch, JSON.parse(body))) ?? null)
              : url.searchParams.get("engine") === "codex"
                ? await answerCodexHook(id, JSON.parse(body), deps)
                : await answerHook(id, JSON.parse(body), deps);
        } catch {
          output = null;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ output }));
      })();
    });
  });
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  if (existsSync(socket)) unlinkSync(socket);
  server.on("error", (error) => options.log?.(`gate: ${error.message}`));
  server.listen(socket, () => {
    try {
      chmodSync(socket, 0o600);
    } catch {
      // The state folder is 700 already.
    }
  });
  return () => server.close();
}

/**
 * The hook's side: the Gate's answer, `undefined` when the Gate could not be
 * reached in time (the agent restarting), so the hook can answer for itself.
 */
/** How long a hook waits for its answer once the Gate has it: a judged call is a model run (judge.ts JUDGE_TIMEOUT_MS). */
export const ANSWER_WAIT_MS = 25_000;

export function askGate(id: string, event: string, socket = GATE_SOCKET, waitMs = 2500, engine?: "codex"): Promise<HookOutput | null | undefined> {
  return postHook(`/hook?worker=${encodeURIComponent(id)}${engine === "codex" ? "&engine=codex" : ""}`, event, socket, waitMs);
}

/** The Lead's or a Foreman's web read (orchWeb.ts), asked the same way; `undefined` when the Gate is not there. */
export function askGateOrch(who: string, event: string, socket = GATE_SOCKET, waitMs = 2500): Promise<HookOutput | null | undefined> {
  return postHook(`/hook?orch=${encodeURIComponent(who)}`, event, socket, waitMs);
}

/**
 * A page read's after-event (webClaims.ts), asked the same way: `orch` for
 * the Lead or a Foreman, else the Worker by its id (contained, its own
 * socket answers for it whatever the id says). Its answer is a note for the
 * reader or nothing.
 */
export function askGateAfter(who: { orch: string } | { worker: string }, event: string, socket = GATE_SOCKET, waitMs = 2500): Promise<AfterOutput | null | undefined> {
  const path = "orch" in who ? `/hook?orch=${encodeURIComponent(who.orch)}` : `/hook?worker=${encodeURIComponent(who.worker)}`;
  return postHook(path, event, socket, waitMs) as Promise<unknown> as Promise<AfterOutput | null | undefined>;
}

function postHook(path: string, event: string, socket: string, waitMs: number): Promise<HookOutput | null | undefined> {
  const deadline = Date.now() + waitMs;
  const once = (): Promise<HookOutput | null | undefined> =>
    new Promise((done) => {
      const req = request(
        { socketPath: socket, method: "POST", path, timeout: ANSWER_WAIT_MS },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => {
            try {
              const reply = JSON.parse(text) as { output?: HookOutput | null };
              done(reply.output ?? null);
            } catch {
              done(null);
            }
          });
        },
      );
      // Reached but no answer in time: no answer (Claude Code's prompt), not a retry.
      req.on("timeout", () => {
        req.destroy();
        done(null);
      });
      req.on("error", () => done(undefined));
      req.end(event);
    });
  return (async () => {
    for (;;) {
      const answer = await once();
      if (answer !== undefined || Date.now() + 250 > deadline) return answer;
      await new Promise((wait) => setTimeout(wait, 250));
    }
  })();
}
