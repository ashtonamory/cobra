import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * One Codex model request, sent on with the account's credential in place of
 * whatever the caller presented. Shared by the localhost broker (your Codex
 * sessions, the Lead and Foremen: codexBroker.ts) and a contained Worker's
 * socket (workerProxy.ts), so both strip the same headers, cap the same body
 * and drop the same hosted tools.
 */

/** Only model traffic passes: the Responses API and the model list. */
export const CODEX_MODEL_PATH = /^\/(?:responses|responses\/compact|models)$/;
const ALLOWED_TOOLS = new Set(["function", "custom", "local_shell"]);
const MAX_BODY = 32 << 20;
/** Credentials a caller may have sent, never passed on: the account's replace them. */
const SENSITIVE_HEADERS = ["authorization", "x-api-key", "chatgpt-account-id", "openai-organization", "openai-project", "cookie", "proxy-authorization"];
/** Meant for the hop to Cobra, not for OpenAI. */
const HOP_HEADERS = ["proxy-connection"];

/**
 * The request's tools without OpenAI's hosted ones (web search, file search,
 * code interpreter…), which would act outside Cobra's policy. Null for a
 * body that is not a JSON object.
 */
export function stripHostedTools(body: string): { body: string; dropped: string[] } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const request = parsed as { tools?: unknown };
  if (!Array.isArray(request.tools)) return { body, dropped: [] };
  const dropped: string[] = [];
  request.tools = request.tools.filter((tool) => {
    const type = tool && typeof tool === "object" ? (tool as { type?: unknown }).type : undefined;
    if (typeof type === "string" && ALLOWED_TOOLS.has(type)) return true;
    dropped.push(String(type).slice(0, 40));
    return false;
  });
  return { body: JSON.stringify(request), dropped };
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain" }).end(`Refused by Cobra: ${message}\n`);
}

function send(req: IncomingMessage, res: ServerResponse, target: URL, path: string, headers: Record<string, string | string[] | undefined>, body: Buffer): void {
  const out = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = out({ host: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80), method: req.method, path, headers: { ...headers, host: target.host } }, (reply) => {
    res.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(res);
  });
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  upstream.end(body);
}

/**
 * Forwards `modelPath` (already checked against CODEX_MODEL_PATH by the
 * caller, which knows its own prefix) to `target`, with `credential` as the
 * only credential. `who` names the caller in the log line for dropped tools.
 */
export function forwardCodex(
  req: IncomingMessage,
  res: ServerResponse,
  options: { target: URL; modelPath: string; search: string; credential: Record<string, string>; who: string; log: (line: string) => void },
): void {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  for (const header of [...SENSITIVE_HEADERS, ...HOP_HEADERS]) delete headers[header];
  Object.assign(headers, options.credential);
  const path = `${options.target.pathname.replace(/\/$/, "")}${options.modelPath}${options.search}`;
  if (req.method !== "POST") return send(req, res, options.target, path, headers, Buffer.alloc(0));
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      refuse(res, 413, "request too large");
      req.destroy();
    } else chunks.push(chunk);
  });
  req.on("end", () => {
    if (size > MAX_BODY) return;
    const checked = stripHostedTools(Buffer.concat(chunks).toString("utf8"));
    if (!checked) return refuse(res, 400, "Codex requests must be JSON");
    const body = Buffer.from(checked.body);
    delete headers["transfer-encoding"];
    headers["content-length"] = String(body.length);
    if (checked.dropped.length) options.log(`${options.who}: removed hosted Codex tools: ${checked.dropped.join(", ")}`);
    send(req, res, options.target, path, headers, body);
  });
}
