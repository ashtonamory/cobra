import http from "node:http";
import os from "node:os";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { spawn, type IPty } from "node-pty";
import { WebSocketServer, type WebSocket } from "ws";

import { mintReconnectTicket, verifyTicket } from "./verify.ts";
import { TERMINAL_PAGE, terminalPageHeaders } from "./page.ts";
import { loadTicketKey, TICKET_KEY_PATH } from "../agent/ticketKey.ts";
import { ensureTmuxConf, tmuxArgs } from "../agent/tmuxHost.ts";

/**
 * The terminal gateway.
 *
 * Every path under /term/ belongs to this service. The agent mints tickets
 * at /ticket, outside that prefix.
 *
 * This process spawns interactive shells on request, which makes it code
 * execution by design. It therefore:
 *   - binds loopback only
 *   - accepts single-use HMAC tickets, never a caller's key
 *   - runs tmux rather than a bare shell, so a dropped socket does not kill work
 */

const SERVICE = "cobra-term";
const VERSION = "0.1.0";
const PORT = Number(process.env.COBRA_TERM_PORT ?? 8788);
// Loopback only: Cobra is never reachable from another computer.
const BIND = process.env.COBRA_TERM_BIND?.trim() === "::1" ? "::1" : "127.0.0.1";
/**
 * The ticket key (agent/ticketKey.ts): its own file, never a caller's key.
 * Read with the same care as the agent's, and refused the same way.
 */
const key = (() => {
  const ticket = loadTicketKey();
  if (ticket.key) return ticket.key;
  console.error(`[${SERVICE}] refusing to start: ${TICKET_KEY_PATH}: ${ticket.refused ?? "missing"}`);
  process.exit(1);
})();
// The agent's own tmux server reads this when it starts (agent/tmuxHost.ts).
ensureTmuxConf();

/**
 * Nonces of tickets already redeemed. A ticket lives 30s, so anything older
 * than a couple of minutes can never be replayed and is dropped to keep this
 * from growing without bound.
 */
const usedNonces = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [nonce, at] of usedNonces) if (at < cutoff) usedNonces.delete(nonce);
}, 60_000).unref();

/**
 * xterm's dist files, read once at startup. Serving them from here rather than
 * a CDN keeps the terminal working with no internet, and keeps the WebSocket
 * same-origin with the page that opens it.
 */
const ASSETS: Record<string, { body: string | Buffer; type: string }> = (() => {
  const require = createRequire(import.meta.url);
  const read = (spec: string) => readFileSync(require.resolve(spec), "utf8");
  try {
    return {
      "/term/xterm.js": { body: read("@xterm/xterm/lib/xterm.js"), type: "text/javascript" },
      "/term/xterm.css": { body: read("@xterm/xterm/css/xterm.css"), type: "text/css" },
      "/term/addon-fit.js": {
        body: read("@xterm/addon-fit/lib/addon-fit.js"),
        type: "text/javascript",
      },
    };
  } catch (error) {
    console.error(`[${SERVICE}] could not load xterm assets:`, error);
    process.exit(1);
  }
})();

const server = http.createServer((request, response) => {
  const route = (request.url ?? "").split("?")[0] ?? "";

  if (route === "/term/health") {
    const body = JSON.stringify({ ok: true, service: SERVICE, version: VERSION });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
    return;
  }

  const asset = ASSETS[route];
  if (asset) {
    response.writeHead(200, {
      "content-type": asset.type,
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    });
    response.end(asset.body);
    return;
  }

  // The page carries no credential itself — the ticket arrives in the query
  // string and is only spent when the socket opens.
  if (route === "/term/" || route === "/term") {
    response.writeHead(200, terminalPageHeaders(request.headers.host));
    response.end(TERMINAL_PAGE);
    return;
  }

  response.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/term/attach") {
    socket.destroy();
    return;
  }

  const ticket = url.searchParams.get("ticket") ?? "";
  const result = verifyTicket(key, ticket);
  if (!result.ok) {
    console.warn(`[${SERVICE}] rejected attach: ${result.reason}`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  if (usedNonces.has(result.claims.nonce)) {
    console.warn(`[${SERVICE}] rejected attach: ticket already used`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  usedNonces.set(result.claims.nonce, Date.now());

  const cols = clamp(Number(url.searchParams.get("cols")), 20, 500, 80);
  const rows = clamp(Number(url.searchParams.get("rows")), 5, 200, 24);

  wss.handleUpgrade(request, socket, head, (ws) => {
    attach(ws, result.claims.session, result.claims.cwd, cols, rows);
  });
});

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function attach(ws: WebSocket, session: string, cwd: string, cols: number, rows: number) {
  console.log(`[${SERVICE}] attach session="${session}" cwd="${cwd}" ${cols}x${rows}`);

  let pty: IPty;
  try {
    // `new -A` is attach-or-create in one command, so the same invocation works
    // whether or not the session already exists. -c only applies on create, so
    // reattaching never moves an existing session's directory.
    // Mouse mode makes a scroll gesture enter copy-mode and page through
    // tmux's history, which is the only place the output actually lives — the
    // outer terminal's scrollback only ever holds the last repaint.
    //
    // A person's own tmux.conf may or may not set this, so the gateway sets
    // it per session rather than assuming. `set -t` keeps it scoped to
    // sessions we opened.
    pty = spawn(
      "tmux",
      tmuxArgs([
        "new-session",
        "-A",
        "-s",
        session,
        "-c",
        cwd,
        ";",
        "set",
        "-t",
        `=${session}:`,
        "mouse",
        "on",
      ]),
      {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          // Claude Code and most TUIs emit colour only when they believe the
          // terminal supports it.
          COLORTERM: "truecolor",
        },
      },
    );
  } catch (error) {
    ws.send(`\r\n\x1b[31mFailed to start tmux: ${String(error)}\x1b[0m\r\n`);
    ws.close();
    return;
  }

  // Hand the page a ticket it can reattach with, and keep it fresh for as long
  // as the socket lives. Sent as a binary frame: pty output is always text, so
  // the two can never be confused for one another.
  const sendReconnectTicket = () => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(
      Buffer.from(
        JSON.stringify({ t: "reconnect-ticket", ticket: mintReconnectTicket(key, session, cwd) }),
      ),
    );
  };
  sendReconnectTicket();
  const refreshTicket = setInterval(sendReconnectTicket, 300_000);

  pty.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  pty.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[2m[session ended, exit ${exitCode}]\x1b[0m\r\n`);
      ws.close();
    }
  });

  ws.on("message", (raw) => {
    let message: { t?: string; d?: string; cols?: number; rows?: number };
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.t === "input" && typeof message.d === "string") {
      pty.write(message.d);
    } else if (message.t === "resize") {
      const nextCols = clamp(Number(message.cols), 20, 500, cols);
      const nextRows = clamp(Number(message.rows), 5, 200, rows);
      try {
        pty.resize(nextCols, nextRows);
      } catch {
        // The pty can exit between a resize being sent and handled.
      }
    }
  });

  ws.on("close", () => {
    clearInterval(refreshTicket);
    // Kill the tmux *client*, never the server. The session keeps running with
    // whatever is in it — that is the entire reason for putting tmux in the
    // path rather than spawning a bare shell.
    try {
      pty.kill();
    } catch {
      /* already gone */
    }
    console.log(`[${SERVICE}] detached session="${session}"`);
  });
}

server.listen(PORT, BIND, () => {
  console.log(`[${SERVICE}] ${VERSION} listening on http://${BIND}:${PORT} (host=${os.hostname()})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[${SERVICE}] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
