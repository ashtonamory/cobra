// cobra-voice: the voice front's MCP server (stdio), the call's tools.
//
//   node voiceMcp.ts      with COBRA_VOICE_SOCKET, the call's own socket
//
// Each tool is one POST to the call's socket (voiceLive.ts serveTools, 0600 in
// the agent's state folder), which the agent answers for that call alone
// (voiceFront.ts Call.tool). Like orchMcp.ts it is the MCP wire format by
// hand (JSON-RPC 2.0, one message a line), so the package needs no library.
import { realpathSync } from "node:fs";
import http from "node:http";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
type Tool = { name: string; description: string; inputSchema: Json };

const PROTOCOL = "2025-06-18";
const none = { type: "object", properties: {}, additionalProperties: false };

/** The voice front's tools: reads, plus the two that act (hand_to_cobra, show_card) and end_call. */
export const VOICE_TOOLS: Tool[] = [
  {
    name: "thread_recent",
    description: "The last entries of the conversation with the person (what they and Cobra said, typed or spoken), and whether the full Cobra is still working on a reply.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "How many entries, 1 to 10. Default 6." } }, additionalProperties: false },
  },
  { name: "glance", description: "Fresh status: what waits on the person, what is in progress, what finished today, and their Spaces.", inputSchema: none },
  {
    name: "space_status",
    description: "One Space's routines (with their next and last runs) and what in it waits on the person.",
    inputSchema: { type: "object", properties: { space: { type: "string", description: "The Space's name as the context lists it." } }, required: ["space"], additionalProperties: false },
  },
  { name: "pending_cards", description: "Each card (an approval) waiting on the person: its id, title and what it does in plain words.", inputSchema: none },
  {
    name: "show_card",
    description: "Puts one waiting card on the person's screen so they can approve it with Face ID. It never approves anything. Use only after the person said yes to it.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The card's id, from pending_cards." } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "hand_to_cobra",
    description: "Gives what the person just asked to the full Cobra, exactly as they said it, to do as real work. Use for anything that changes, makes, sends or looks into something. Takes no text: the person's own words go.",
    inputSchema: none,
  },
  { name: "end_call", description: "Ends the call after your goodbye. Use when the person says goodbye or that they are done.", inputSchema: none },
];

/** One tool call to the call's socket: its text and whether it failed. */
function callSocket(socketPath: string, name: string, args: Json): Promise<{ text: string; error?: boolean }> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ name, arguments: args });
    const request = http.request(
      { socketPath, path: "/tool", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 30_000 },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => {
          try {
            const parsed = JSON.parse(text) as { text?: unknown; error?: unknown };
            resolve({ text: typeof parsed.text === "string" ? parsed.text : "No answer.", ...(parsed.error === true ? { error: true } : {}) });
          } catch {
            resolve({ text: "The agent did not answer.", error: true });
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", (error) => resolve({ text: `The agent did not answer (${error.message}).`, error: true }));
    request.end(body);
  });
}

/** The answer to one JSON-RPC request, or null for a notification. */
export async function answer(message: Json, socketPath: string): Promise<Json | null> {
  const id = message.id;
  if (id === undefined || id === null) return null;
  const reply = (result: unknown): Json => ({ jsonrpc: "2.0", id, result });
  switch (message.method) {
    case "initialize":
      return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "cobra-voice", version: "1" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: VOICE_TOOLS });
    case "tools/call": {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === "string" ? params.name : "";
      if (!VOICE_TOOLS.some((tool) => tool.name === name)) return reply({ content: [{ type: "text", text: `No tool ${name}.` }], isError: true });
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Json) : {};
      const result = await callSocket(socketPath, name, args);
      // What the agent read is data: the prompt says so, and the fence marks it.
      return reply({ content: [{ type: "text", text: `<data>\n${result.text}\n</data>` }], ...(result.error ? { isError: true } : {}) });
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `no method ${String(message.method)}` } };
  }
}

function main(): void {
  const socketPath = process.env.COBRA_VOICE_SOCKET ?? "";
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return;
    }
    void answer(message, socketPath).then((out) => {
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    });
  });
  lines.on("close", () => process.exit(0));
}

/** Run as the server, not imported by a test: the install's `current` is a link, so real paths are compared. */
function isMain(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

if (isMain()) main();
