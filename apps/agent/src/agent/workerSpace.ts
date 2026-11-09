// A Worker's Space tools, the agent's side (JK-PLAN-WF-001 part B, section 3;
// decision D3). spaceTools.ts runs in the Worker's sandbox and asks the
// Worker's own socket (workerProxy.ts):
//
//   GET  /space          the tools this Worker has: its owner project's trade
//                        groups (orchMcp.ts tradeGroups), less what a Worker
//                        never does (spaceTools.ts WORKER_SPACE_TOOLS)
//   POST /space/<tool>   one call, its JSON arguments as the body
//
// Who asks is the socket. The project is the Worker's owner, as its record
// (sessions.json, which the sandbox never shows) says; the arguments cannot
// name another, and a Worker started without `spaceTools` gets nothing.
//
// A call runs the very route the Foreman's tool does (orchMcp.ts toolContent,
// orch.ts handleOrch), in this process, as the owner project's Foreman with
// `worker` set: every rule of those routes applies unchanged. What differs:
// a database write is journaled as `worker:<id>` (dbRoutes.ts), nothing runs
// on trust (no trust is given: each send or file is a card), and each card
// says which Worker made it (markCard). A Worker that has read web pages in
// its task (taint.ts) makes cards Cobra never allows herself, under
// Instinct or by the judge (byTaintedWorker: instinctActs.ts, unanswered.ts).
import { hostname } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { StoredApproval } from "./approvals.ts";
import { foremanCallerId } from "./keys.ts";
import { foremanToolNames, toolContent, TOOLS, type Fetcher, type ToolContent } from "./orchMcp.ts";
import { WORKER_SPACE_NAMES } from "./spaceTools.ts";

type Json = Record<string, unknown>;

/** The Space tools a Worker of this trade gets: its trade's Foreman tools that a Worker may have, in their order. "" (no trade) is none. */
export function workerToolNames(trade: string): string[] {
  return foremanToolNames(trade).filter((name) => WORKER_SPACE_NAMES.has(name));
}

/** The tools as tools/list gives them: the Foreman's own description and schema, without `computer` (a Worker's calls stay on its computer). */
export function workerTools(trade: string): Array<{ name: string; description: string; inputSchema: Json }> {
  return workerToolNames(trade).flatMap((name) => {
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) return [];
    const schema = tool.inputSchema as { properties?: Json };
    const { computer: _computer, ...properties } = schema.properties ?? {};
    return [{ ...tool, inputSchema: { ...schema, properties } }];
  });
}

/** A Worker with Space tools as its socket knows it. */
/** `lead`: Cobra started it herself (directWorkers.ts), so its cards' news goes to her. */
export type SpaceWorker = { owner: string; trade: string; tainted: boolean; lead?: true };

/** One call of a Space tool, as the socket decided it. */
export type SpaceCall = { worker: string; project: string; tool: string; args: Json; tainted: boolean; lead?: true };

export type WorkerSpaceDeps = {
  /** The Worker's owner project and trade when it was started with Space tools; else why not. */
  worker: (id: string) => Promise<SpaceWorker | { refused: string }>;
  run: (call: SpaceCall) => Promise<ToolContent[]>;
  log: (line: string) => void;
};

/** Arguments a call may not carry: the socket decides the project and the computer. */
export const SOCKET_DECIDES = ["project", "space", "computer"] as const;

const BODY_MAX = 2_100_000;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > max) {
        reject(new Error("the arguments are too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("the arguments are not JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Serves `/space` and `/space/<tool>` on Worker `id`'s socket. */
export async function serveSpace(id: string, path: string, req: IncomingMessage, res: ServerResponse, deps: WorkerSpaceDeps): Promise<void> {
  const found = await deps.worker(id).catch((caught: unknown) => ({ refused: `Cobra could not read this Worker's record (${caught instanceof Error ? caught.message : String(caught)})` }));
  if ("refused" in found) {
    req.resume();
    return send(res, 403, { error: found.refused });
  }
  if (path === "/space") {
    req.resume();
    if (req.method !== "GET") return send(res, 405, { error: "GET only" });
    return send(res, 200, { tools: workerTools(found.trade) });
  }
  const tool = path.slice("/space/".length);
  if (req.method !== "POST") {
    req.resume();
    return send(res, 405, { error: "POST only" });
  }
  if (!workerToolNames(found.trade).includes(tool)) {
    req.resume();
    deps.log(`worker ${id}: refused Space tool ${tool.slice(0, 60)}: not one of its tools`);
    return send(res, 403, { error: `${tool.slice(0, 60)} is not one of this Worker's Space tools` });
  }
  let args: Json;
  try {
    const parsed = await readJson(req, BODY_MAX);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("the arguments are not an object");
    args = parsed as Json;
  } catch (caught) {
    return send(res, 400, { error: caught instanceof Error ? caught.message : String(caught) });
  }
  // The project is the Worker's owner: an argument naming one is refused, never followed.
  const named = SOCKET_DECIDES.filter((key) => Object.hasOwn(args, key));
  if (named.length) return send(res, 400, { error: `leave out ${named.join(" and ")}: a Worker's Space tools work on its own project only, ${found.owner}` });
  // A site check or preview of a Worker's work: its own only.
  if (Object.hasOwn(args, "worker") && args.worker !== id) return send(res, 403, { error: `a Worker names only itself as worker: ${id}` });
  deps.log(`worker ${id}: Space tool ${tool} for ${found.owner}${found.tainted ? " (it has read the web)" : ""}`);
  try {
    const content = await deps.run({ worker: id, project: found.owner, tool, args, tainted: found.tainted, ...(found.lead ? { lead: true as const } : {}) });
    return send(res, 200, { content });
  } catch (caught) {
    return send(res, 200, { content: [{ type: "text", text: caught instanceof Error ? caught.message : String(caught) }], isError: true });
  }
}

// --- a call, in this process --------------------------------------------------------

/** The caller a Worker's call runs as: its owner project's Foreman, with the Worker named. */
export type WorkerCaller = { id: string; kind: "lead"; name: string; project: string; worker: string };

export function workerCaller(call: Pick<SpaceCall, "worker" | "project">): WorkerCaller {
  return { id: foremanCallerId(call.project), kind: "lead", name: `Worker ${call.worker} for ${call.project}`.slice(0, 80), project: call.project, worker: call.worker };
}

/** What a route handler is given for one in-process call (index.ts passes it to handleOrch). */
export type OrchIo = {
  send: (response: ServerResponse, status: number, body: unknown) => void;
  readBody: (request: IncomingMessage, limit?: number) => Promise<string>;
  caller: WorkerCaller;
  notify: (approval: StoredApproval) => Promise<void>;
};

export type OrchHandle = (route: string, url: URL, request: IncomingMessage, response: ServerResponse, io: OrchIo) => Promise<void>;

/** A card's words and marks when a Worker's Space tool made it. */
export function markCard(approval: StoredApproval, call: Pick<SpaceCall, "worker" | "project" | "tainted" | "lead">): StoredApproval {
  const said = [`Proposed by a Worker (${call.worker}) for ${call.project}.`];
  // A card the route already stamped (taint.ts, orch.ts taintedNotify) says why it asks once.
  if (call.tainted && !approval.taint) said.push("It read text from outside in its task, which may have planted what it proposes, so Cobra never allows this by herself.");
  return { ...approval, body: `${approval.body}\n\n${said.join(" ")}`, byWorker: call.worker, ...(call.tainted ? { byTaintedWorker: true as const } : {}), ...(call.lead ? { byLeadWorker: true as const } : {}) };
}

/** Marks each card a call makes before it is told (and maybe allowed under Instinct: index.ts notifyOrAct reads the mark). */
export function markedNotify(
  call: Pick<SpaceCall, "worker" | "project" | "tainted" | "lead">,
  notify: (approval: StoredApproval) => Promise<void>,
  store: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void },
): (approval: StoredApproval) => Promise<void> {
  return async (approval) => {
    const marked = markCard(approval, call);
    store.save(store.load().map((stored) => (stored.id === approval.id ? marked : stored)));
    await notify(marked);
  };
}

/** Where the in-process calls pretend to go: never fetched. */
const HERE = "http://cobra-space.invalid";

/**
 * Runs one Space tool: the Foreman tool's own translation and words
 * (orchMcp.ts toolContent) over `handle` instead of HTTP, as the Worker's
 * caller, with its cards marked.
 */
export async function runSpaceTool(
  call: SpaceCall,
  handle: OrchHandle,
  notify: (approval: StoredApproval) => Promise<void>,
  store: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void },
): Promise<ToolContent[]> {
  const caller = workerCaller(call);
  const told = markedNotify(call, notify, store);
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    let reply: { status: number; body: unknown } | null = null;
    const request = { method, url: `${url.pathname}${url.search}`, headers: {}, on: () => request } as unknown as IncomingMessage;
    await handle(url.pathname, url, request, {} as ServerResponse, {
      send: (_response, status, sent) => void (reply ??= { status, body: sent }),
      readBody: async (_request, limit = 4096) => {
        if (Buffer.byteLength(body) > limit) throw new Error(`the arguments are over ${limit} bytes`);
        return body;
      },
      caller,
      notify: told,
    });
    const answered = reply as { status: number; body: unknown } | null;
    if (!answered) return new Response(JSON.stringify({ error: "the route gave no answer" }), { status: 500 });
    const empty = answered.status === 204 || answered.status === 205 || answered.status === 304;
    return new Response(empty ? null : JSON.stringify(answered.body ?? {}), { status: answered.status, headers: { "content-type": "application/json" } });
  }) as Fetcher;
  return toolContent(call.tool, call.args, [{ name: hostname(), url: HERE }], fetcher);
}

// --- the live ones -----------------------------------------------------------------

let runner: ((call: SpaceCall) => Promise<ToolContent[]>) | null = null;

/** index.ts gives the live runner at boot: the routes and their io live there. */
export function setSpaceRunner(run: (call: SpaceCall) => Promise<ToolContent[]>): void {
  runner = run;
}

/** The Worker's record, its owner project here and its taint. */
export async function liveSpaceWorker(id: string): Promise<SpaceWorker | { refused: string }> {
  const [{ loadExtras }, { loadRegistry }, { DEFAULT_CONFIG_PATH }, { isTainted }] = await Promise.all([import("./extras.ts"), import("./registry.ts"), import("./collect/projects.ts"), import("./taint.ts")]);
  const extra = (await loadExtras()).find((entry) => entry.id === id);
  if (!extra?.worker) return { refused: `no Worker ${id} on this computer` };
  if (extra.worker.spaceTools !== true) return { refused: "this Worker was not started with Space tools" };
  const owner = extra.worker.owner;
  const project = (await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH)).projects.find((entry) => entry.id === owner && entry.machine === hostname());
  if (!project) return { refused: `this Worker's project ${owner} is not on this computer` };
  return { owner, trade: project.foremanTemplate ?? "", tainted: isTainted(`worker:${id}`) !== null, ...(extra.worker.startedBy === "lead" ? { lead: true as const } : {}) };
}

export function liveSpaceDeps(log: (line: string) => void): WorkerSpaceDeps {
  return {
    worker: liveSpaceWorker,
    run: (call) => (runner ? runner(call) : Promise.reject(new Error("Space tools are not served by this process"))),
    log,
  };
}
