import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import type { Caller, KeyStore } from "./keys.ts";
import { CONFIG_DIR, STATE_DIR } from "./paths.ts";

/**
 * The Lead's and each Foreman's line to the agent: a Unix socket the agent
 * serves, one per orchestrator, which adds that orchestrator's key to each
 * call on its way to the /orch/* routes.
 *
 * The key never leaves the agent. Before, it sat in a computers.json that
 * cobra-orch read; a Codex Lead or Foreman runs cobra-orch inside its fence
 * (orchFence.ts), where the model's own shell could read that file too and
 * send the key anywhere. Now there is nothing to read: the socket is the
 * capability, the agent knows whose call it is by the socket it came in on,
 * and the key it adds is held in memory and minted again at each start of
 * the agent. A shell that talks to its own socket gets only what its tools
 * already give it, only on this computer, and only while the agent serves it.
 *
 * The folder, not the socket, is what a fence binds: the agent makes the
 * socket again at each start, and a bind of the old one would point at
 * nothing. So the folder is never removed, only the socket in it.
 */

export const ORCH_SOCKET_ROOT = join(STATE_DIR, "orch");
export const LEAD_LINE = "lead";
const SOCKET = "orch.sock";

/** A Foreman's line: a short name, as a socket path has a hard limit (108 bytes on Linux). */
export function foremanLineName(project: string): string {
  return `fm-${createHash("sha256").update(project).digest("hex").slice(0, 16)}`;
}

export function lineDir(name: string, root = ORCH_SOCKET_ROOT): string {
  return join(root, name);
}

export function lineSocket(dir: string): string {
  return join(dir, SOCKET);
}

/** The line's folder, made now if it is not there: a fence binds it at launch, before the agent may serve it. */
export function prepareLine(name: string, root = ORCH_SOCKET_ROOT): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = lineDir(name, root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

type Line = { server: Server; caller: string; key: string };

export type LineDeps = {
  /** The agent's own port on 127.0.0.1, where each call goes on. */
  port: number;
  keys: Pick<KeyStore, "upsert" | "extendOrch">;
  root?: string;
  now?: () => number;
};

/** The sockets this agent serves, by line name. */
export class OrchLines {
  private readonly lines = new Map<string, Line>();
  private readonly deps: LineDeps;

  constructor(deps: LineDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Serves the line with a key minted now; one already served is closed first,
   * and its old key stops working (minting again replaces it, keys.ts).
   */
  async serve(name: string, mint: (now: number) => { caller: Caller; key: string }): Promise<string> {
    await this.close(name);
    const dir = prepareLine(name, this.deps.root);
    const path = lineSocket(dir);
    const now = this.now();
    const { caller, key } = mint(now);
    this.deps.keys.upsert(caller);
    const server = createServer((req, res) => this.pass(name, req, res));
    rmSync(path, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(path, 0o600);
    this.lines.set(name, { server, caller: caller.id, key });
    return path;
  }

  has(name: string): boolean {
    return this.lines.has(name);
  }

  names(): string[] {
    return [...this.lines.keys()];
  }

  /** Stops serving the line; its key is forgotten, so it works no more from here. */
  async close(name: string): Promise<void> {
    const line = this.lines.get(name);
    if (!line) return;
    this.lines.delete(name);
    line.key = "";
    await new Promise<void>((resolve) => line.server.close(() => resolve()));
    rmSync(lineSocket(lineDir(name, this.deps.root)), { force: true });
  }

  /**
   * Pushes out the expiry of every key served now (keys.ts
   * ORCH_KEY_LIFETIME_MS), from the agent's hourly tick: a line keeps working
   * while it is served, and its key is never swapped under a call.
   */
  extendAll(): string[] {
    const callers = [...this.lines.values()].map((line) => line.caller);
    return callers.length ? this.deps.keys.extendOrch(callers, this.now()) : [];
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.names().map((name) => this.close(name)));
  }

  /** One call: /orch/* only, GET or POST, with the line's key and nothing else the caller sent but its body. */
  private pass(name: string, req: IncomingMessage, res: ServerResponse): void {
    const line = this.lines.get(name);
    // As the agent will read it: a raw "/orch/../keys" is "/keys", and refused here.
    let path = "";
    try {
      const url = new URL(req.url ?? "", "http://line");
      path = `${url.pathname}${url.search}`;
    } catch {
      // refused below
    }
    if (!line || !path.startsWith("/orch/") || (req.method !== "GET" && req.method !== "POST")) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not on this line" }));
      req.resume();
      return;
    }
    const headers: Record<string, string> = { authorization: `Bearer ${line.key}` };
    const type = req.headers["content-type"];
    if (typeof type === "string") headers["content-type"] = type;
    const length = req.headers["content-length"];
    if (typeof length === "string") headers["content-length"] = length;
    const upstream = request({ host: "127.0.0.1", port: this.deps.port, path, method: req.method, headers }, (answer) => {
      const out: Record<string, string> = {};
      const answerType = answer.headers["content-type"];
      if (typeof answerType === "string") out["content-type"] = answerType;
      res.writeHead(answer.statusCode ?? 502, out);
      answer.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "the agent did not answer" }));
    });
    req.pipe(upstream);
  }
}

/** The computers.json files that held the Lead's and each Foreman's key before the lines. */
export function oldComputerFiles(configDir = CONFIG_DIR): string[] {
  const lead = join(configDir, "lead");
  const foremen = join(lead, "foremen");
  const each = existsSync(foremen) ? readdirSync(foremen).map((id) => join(foremen, id, "computers.json")) : [];
  return [join(lead, "computers.json"), ...each].filter((path) => existsSync(path));
}

let current: OrchLines | null = null;

/** The agent's lines (index.ts sets them at start); null in any other process. */
export function orchLines(): OrchLines | null {
  return current;
}

export function useOrchLines(lines: OrchLines | null): void {
  current = lines;
}

/**
 * fetch over a line: what cobra-orch and the github launcher call the agent
 * with. The URL's host is ignored; its path and query go down the socket.
 */
export function lineFetch(socket: string): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body === undefined || init.body === null ? undefined : String(init.body);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    return new Promise<Response>((resolve, reject) => {
      const req = request({ socketPath: socket, path: `${url.pathname}${url.search}`, method: init?.method ?? "GET", headers, signal: init?.signal ?? undefined }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 502;
          const type = res.headers["content-type"];
          resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: typeof type === "string" ? { "content-type": type } : {} }));
        });
      });
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (error.name === "AbortError" || error.name === "TimeoutError") reject(error);
        else reject(new Error(`Cobra's agent is not answering on this session's line (${error.code ?? error.message}); is cobra-agent running?`));
      });
      req.end(body);
    });
  }) as typeof fetch;
}
