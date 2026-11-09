// The Stop hook that counts a turn's tokens (turnUsage.ts, usageLedger.ts).
//
//   node usageHook.ts --as <role>:<session> [--socket <Gate socket>]
//
// with Claude Code's Stop event on stdin. The agent writes it into the
// Lead's, each Foreman's, each Worker's and each job's settings, so it runs
// as every turn ends, on the subscription or the key, in a terminal or
// headless. It reads what the turn used from the transcript and posts it to
// the agent. Inside Cobra's sandbox (contain.ts) COBRA_AGENT_SOCKET names
// the Worker's own socket, its one way out, and the socket says who it is;
// outside, it posts to the Gate's socket with `--as`.
//
// It never gets in Claude's way: no output, and exit 0 whatever happens. A
// post that fails leaves the cursor where it was, so the next Stop sends it.
import { request } from "node:http";
import { join } from "node:path";

import { STATE_DIR } from "./paths.ts";
import { readTurn, type TurnPost } from "./turnUsage.ts";

const done = () => process.exit(0);

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

/** Posts the turn; true when the agent took it. */
function postTurn(socket: string, path: string, post: TurnPost, waitMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ socketPath: socket, method: "POST", path, timeout: waitMs, headers: { "content-type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode === 200));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end(JSON.stringify(post));
  });
}

let input = "";
const timer = setTimeout(done, 8000);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (input.length > 1_000_000) done();
});
process.stdin.on("error", done);
process.stdin.on("end", async () => {
  try {
    const event = JSON.parse(input) as { hook_event_name?: unknown; session_id?: unknown; transcript_path?: unknown };
    if (event.hook_event_name !== "Stop" || typeof event.transcript_path !== "string" || !event.transcript_path.startsWith("/")) done();
    const contained = process.env.COBRA_AGENT_SOCKET;
    const as = arg("--as");
    const socket = contained || arg("--socket");
    if (!socket || (!contained && !as)) done();
    const turn = readTurn(event.transcript_path as string, join(STATE_DIR, "usage-cursors"));
    if (turn.messages.length === 0) {
      turn.commit();
      done();
    }
    const session = String(event.session_id ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
    // In the jail who posts is the socket, never the body or an argument.
    const path = contained ? "/usage" : `/usage?as=${encodeURIComponent(as!)}`;
    if (await postTurn(socket!, path, { session, messages: turn.messages })) turn.commit();
  } catch {
    // Not counted this time; the next Stop tries again.
  }
  clearTimeout(timer);
  done();
});
