// A Worker's Space tools (JK-PLAN-WF-001 part B, section 3; decision D3): the
// MCP server a Worker started with `spaceTools` runs inside its sandbox, for
// the Space tools of its owner project and nothing else.
//
//   node spaceTools.ts      JSON-RPC on stdio, no library
//
// It holds no rules and no list of its own: tools/list asks the Worker's own
// socket (COBRA_AGENT_SOCKET, GET /space), and each call goes to that socket
// as POST /space/<tool> with the call's arguments. Who asks is the socket, as
// for the permission tool (permissionTool.ts): the agent finds the Worker's
// project from the socket, never from the arguments, and refuses whatever the
// Worker may not do (workerSpace.ts). Anything it cannot reach is an error
// the Worker reads, never a call made some other way.
import { request } from "node:http";
import { createInterface } from "node:readline";

/** The server's name in a Worker's MCP config: its tools are mcp__cobra_space__<tool> (policy.ts allows those to the socket). */
export const SPACE_SERVER = "cobra_space";

/**
 * The Space tools a Worker may be given, by the Foreman tool groups of
 * orchMcp.ts (FOREMAN_GROUPS), less what a Worker never does. A Worker gets
 * the groups of its owner project's trade (orchMcp.ts tradeGroups) and, of
 * those, only the tools named here. The core group is never a Worker's: its
 * Workers, merges, plans, routines, memory and the person (ask_person) are
 * the Foreman's and the Lead's, and a Worker asks its own questions through
 * its permission path. A write goes to the journal with Undo; whatever leaves
 * the computer is a card the person allows, as from the Foreman.
 */
export const WORKER_SPACE_TOOLS = {
  // The trade's database: every write journaled with Undo, as the Worker (dbRoutes.ts).
  data: ["db_schema", "db_query", "db_write", "db_undo", "db_journal", "sheet_import", "mirror_status", "report_render"],
  // The calendar and mail reads the trade does; mail_organize is a card.
  reads: ["calendar_events", "mail_search", "mail_read", "mail_organize"],
  email: [
    "email_templates",
    "email_image",
    "email_template_save",
    "email_template_get",
    "email_design_standard",
    "email_template_preview",
    // A new version is a card the person allows.
    "email_template_propose",
    // A sequence is a card the person allows.
    "email_sequence_propose",
    // An outreach batch is a card the person allows; never on trust.
    "email_batch",
    "email_sent",
    "email_template_start",
    // Left out: email_design_save. It makes the Designer's own Tessel file into a template; the Designer designs in Tessel itself.
    // Left out: email_send. One email can go on trust (a template version's grant): a Worker drafts, the Foreman sends.
    // Left out: email_campaign. It mails a whole topic: the Foreman's call, not a Worker's.
    // Left out: email_hook_set and email_hook_remove. A hook sends by itself on each event, with no card for each email.
  ],
  site: [
    "site_read",
    // Journaled, with site_undo.
    "site_edit",
    "site_undo",
    "site_check",
    // A preview only, never the live site.
    "site_preview",
    // Left out: site_start. It makes the site's private GitHub repository: setup, the Foreman's.
    // Left out: site_publish. Going live is the Foreman's card.
    // Left out: site_domain. A domain changes DNS records.
    // Left out: site_link. It ties the Space to a site someone else coded.
  ],
  // Each one a card or a file the person sees: a brand kit, designs, a website concept.
  design: ["brand_propose", "designs_show", "website_concept"],
} as const satisfies Record<string, readonly string[]>;

export type WorkerSpaceGroup = keyof typeof WORKER_SPACE_TOOLS;

/** Every tool a Worker may ever be given, whatever its trade. */
export const WORKER_SPACE_NAMES: ReadonlySet<string> = new Set(Object.values(WORKER_SPACE_TOOLS).flat());

type Json = Record<string, unknown>;

/** What the socket answered: its status and its JSON body (null when it was not JSON). */
export type SocketReply = { status: number; body: unknown };

/** One request to the Worker's socket; a refused connection (the agent restarting) is tried again for up to `patienceMs`. */
export function askSocket(socketPath: string, method: "GET" | "POST", path: string, body: unknown, patienceMs = 30_000, retryMs = 2000): Promise<SocketReply> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const until = Date.now() + patienceMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const again = (why: string) => (Date.now() < until ? void setTimeout(attempt, retryMs) : resolve({ status: 503, body: { error: `Cobra's agent cannot be reached (${why})` } }));
      const req = request(
        { socketPath, method, path, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text) } },
        (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (raw += chunk));
          res.on("end", () => {
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = { error: raw.trim().slice(0, 300) || `status ${res.statusCode}` };
            }
            resolve({ status: res.statusCode ?? 500, body: parsed });
          });
          res.on("error", (error) => again(error.message));
        },
      );
      req.on("error", (error) => again(error.message));
      req.end(text);
    };
    attempt();
  });
}

const errorOf = (reply: SocketReply): string => {
  const body = reply.body as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Cobra answered ${reply.status}`;
};

/** One JSON-RPC message in, the reply out (null for a notification). `ask` reaches the Worker's socket. */
export async function handle(message: unknown, ask: (method: "GET" | "POST", path: string, body?: unknown) => Promise<SocketReply>): Promise<unknown | null> {
  if (typeof message !== "object" || message === null) return null;
  const m = message as { id?: unknown; method?: unknown; params?: Json };
  if (m.id === undefined || m.id === null) return null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
  const error = (code: number, text: string) => ({ jsonrpc: "2.0", id: m.id, error: { code, message: text } });
  switch (m.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: SPACE_SERVER, version: "1" },
        instructions: "The Space tools of the project that started this Worker. Writes go to the journal with Undo; what leaves the computer is a card the person allows.",
      });
    case "ping":
      return reply({});
    case "tools/list": {
      const listed = await ask("GET", "/space");
      const tools = (listed.body as { tools?: unknown } | null)?.tools;
      if (listed.status !== 200 || !Array.isArray(tools)) return error(-32603, errorOf(listed));
      return reply({ tools });
    }
    case "tools/call": {
      const name = typeof m.params?.name === "string" ? m.params.name : "";
      const args = typeof m.params?.arguments === "object" && m.params.arguments !== null && !Array.isArray(m.params.arguments) ? m.params.arguments : {};
      if (!/^[a-z][a-z_]{0,39}$/.test(name)) return reply({ content: [{ type: "text", text: `no tool called ${name.slice(0, 60)}` }], isError: true });
      const called = await ask("POST", `/space/${name}`, args);
      const content = (called.body as { content?: unknown } | null)?.content;
      if (called.status !== 200 || !Array.isArray(content)) return reply({ content: [{ type: "text", text: errorOf(called) }], isError: true });
      return reply({ content, ...((called.body as { isError?: unknown }).isError === true ? { isError: true } : {}) });
    }
    default:
      return error(-32601, "method not found");
  }
}

function main(): void {
  const socketPath = process.env.COBRA_AGENT_SOCKET ?? "";
  const ask = (method: "GET" | "POST", path: string, body?: unknown): Promise<SocketReply> =>
    socketPath ? askSocket(socketPath, method, path, body) : Promise.resolve({ status: 503, body: { error: "Cobra's socket is not known here: Space tools run only in Cobra's sandbox" } });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    void handle(message, ask).then((answer) => {
      if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
    });
  });
  lines.on("close", () => process.exit(0));
}

if (process.argv[1] && import.meta.filename === process.argv[1]) main();
