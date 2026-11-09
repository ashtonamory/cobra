// Pi spike: Pi as a Worker's harness, in tmux,
// inside Cobra's own sandbox, on a local model, with Cobra's extension (cobra-pi.ts).
// Runs this checkout's agent modules (never index.ts) and the computer's Ollama.
//
//   ~/.local/share/cobra-agent/current/bin/node spike.mts [model]     (default qwen-tuned:fast96k)
//
// It shows, or fails to show:
//   1. the Gate blocks a refused bash call (the blocklist) and Pi carries on with the reason
//   2. a call the Gate leaves to the person waits 35 s for an answer without Pi timing out
//   3. a brief reaches Pi while idle, and a second one while it is working (as a follow-up)
//   4. state events arrive in order
//   5. inside the jail Pi reaches Ollama only through the Worker's socket (/ollama, thinking off)
//   6. --session-id resumes the conversation after its tmux session is killed
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const HERE = import.meta.dirname;
const A = realpathSync(join(HERE, "../../src/agent"));
const MODEL = process.argv[2] ?? "qwen-tuned:fast96k";
const PI_HOME = realpathSync(join(homedir(), ".local/share/mise/installs/pi/1.2.0"));
const PI = join(PI_HOME, "pi/pi");
const ASK_WAIT_MS = 35_000;
const TMUX = ["-L", "pispike"];

const contain = await import(join(A, "contain.ts"));
const proxy = await import(join(A, "workerProxy.ts"));
const { loadPolicy } = await import(join(A, "permissions.ts"));
const { OLLAMA } = await import(join(A, "ollama.ts"));

// --- a throwaway repository and worktree --------------------------------------------------
const SB = mkdtempSync(join(tmpdir(), "cobra-pi-spike-"));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=spike@cobra", "-c", "user.name=spike", ...a], { cwd });
mkdirSync(join(SB, "repo"), { recursive: true });
git(join(SB, "repo"), "init", "-q", "-b", "main");
writeFileSync(join(SB, "repo", "README.md"), "# pi spike repo\n");
git(join(SB, "repo"), "add", ".");
git(join(SB, "repo"), "commit", "-qm", "init");
git(join(SB, "repo"), "worktree", "add", "-q", "-b", "feat/spike", "../repo.worktrees/spike");
console.log(`spike folder: ${SB}  model: ${MODEL}`);

const id = "spike_pi1";
const home = homedir();
const worktree = realpathSync(join(SB, "repo.worktrees/spike"));
const scope = { id, worktree, gitCommon: realpathSync(join(SB, "repo/.git")), gitPrivate: realpathSync(join(SB, "repo/.git/worktrees/spike")), branch: "feat/spike" };
const layout = contain.containLayout(id, join(SB, "workers"), join(tmpdir(), `jps-${process.getuid?.() ?? "u"}`));
contain.prepareLayout(layout);
contain.seedClaudeFolder(layout.claude, worktree, { home });
writeFileSync(layout.brief, "");
const settings = join(SB, "workers", `${id}.settings.json`);
writeFileSync(settings, "{}\n");

// --- Pi's own config, never ~/.pi ------------------------------------------------------------
const piDir = join(layout.state, "pi");
const sessions = join(layout.state, "pi-sessions");
mkdirSync(piDir, { recursive: true });
mkdirSync(sessions, { recursive: true });
const context = 98_304;
writeFileSync(
  join(piDir, "models.json"),
  JSON.stringify({
    providers: {
      ollama: {
        baseUrl: "http://127.0.0.1:8899/ollama/v1",
        api: "openai-completions",
        apiKey: "cobra",
        models: [{ id: MODEL, contextWindow: context, maxTokens: 8192, input: ["text"], reasoning: true, thinkingLevelMap: { off: "none", minimal: "none", low: "low", medium: "medium", high: "high", xhigh: null, max: null } }],
      },
    },
  }),
);
writeFileSync(join(piDir, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: MODEL, defaultThinkingLevel: "off", quietStartup: true }));

// --- the Worker's socket: the real Gate and policy, and the spike's own /permission -----------
const decisions: Array<Record<string, unknown>> = [];
const answers = { readScope: (w: string) => (w === id ? scope : null), policy: () => loadPolicy(), log: (e: Record<string, unknown>) => decisions.push(e), recordPending: () => {}, now: Date.now };
const states: Array<{ event: string; at: number }> = [];
const asks: Array<{ tool: string; input: unknown; askedAt: number; answeredAt?: number }> = [];
const inbox: string[] = [];
let waiter: ((messages: string[]) => void) | null = null;
const listeners: Array<(event: string) => void> = [];
let polled = 0;
const onPoll: Array<() => void> = [];

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (text += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(text || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}
function send(text: string): void {
  inbox.push(text);
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(inbox.splice(0));
  }
}
async function permission(_id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const kind = new URL(req.url ?? "/", "http://x").searchParams.get("pi");
  const json = await body(req);
  const reply = (value: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
  if (kind === "state") {
    states.push({ event: String(json.event), at: Date.now() });
    console.log(`  [state] ${json.event}`);
    for (const listen of listeners) listen(String(json.event));
    return reply({});
  }
  if (kind === "ask") {
    const ask = { tool: String(json.tool), input: json.input, askedAt: Date.now() } as (typeof asks)[number];
    asks.push(ask);
    console.log(`  [ask] ${ask.tool} ${JSON.stringify(json.input).slice(0, 80)} — answering Allow in ${ASK_WAIT_MS / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, ASK_WAIT_MS));
    ask.answeredAt = Date.now();
    return reply({ allow: true });
  }
  if (kind === "inbox") {
    polled++;
    for (const f of onPoll.splice(0)) f();
    if (inbox.length) return reply({ messages: inbox.splice(0) });
    const timer = setTimeout(() => {
      waiter = null;
      reply({ messages: [] });
    }, 25_000);
    waiter = (messages) => {
      clearTimeout(timer);
      reply({ messages });
    };
    return;
  }
  res.writeHead(404).end();
}

const ollamaSeen: string[] = [];
const stop = proxy.serveWorker(id, layout.socket, {
  answers,
  token: () => null,
  allow: () => [],
  limits: () => {},
  log: (l: string) => {
    ollamaSeen.push(l);
    console.log(`  [proxy] ${l}`);
  },
  anthropic: new URL("https://api.anthropic.com"),
  ollama: OLLAMA,
  permission: (w: string, req: IncomingMessage, res: ServerResponse) => void permission(w, req, res),
});

// --- Pi in the jail, in tmux -------------------------------------------------------------------
const node = realpathSync(process.execPath);
const expose = [...contain.toolchains(home), PI_HOME, join(A, ".."), A, HERE, node];
const sessionId = randomUUID();
function launch(): void {
  const command = [PI, "--no-extensions", "-e", join(HERE, "cobra-pi.ts"), "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--session-dir", sessions, "--session-id", sessionId];
  const args = [
    "--clearenv",
    ...contain.containArgs({
      scope,
      layout,
      settings,
      home,
      expose,
      caches: contain.caches(home),
      masks: contain.secretFilesUnder(worktree),
      local: false,
      env: contain.containEnv({
        home,
        path: contain.insidePath(process.env.PATH ?? "", expose, home),
        layout,
        extra: { PI_CODING_AGENT_DIR: piDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", COBRA_PI_URL: "http://127.0.0.1:8899" },
      }),
      node,
      bridge: join(A, "containBridge.ts"),
      command,
    }),
  ];
  writeFileSync(join(SB, "bwrap.json"), JSON.stringify(args));
  writeFileSync(join(SB, "launch.mjs"), `import { spawnSync } from "node:child_process"; import { readFileSync } from "node:fs";\nconst r = spawnSync("bwrap", JSON.parse(readFileSync(${JSON.stringify(join(SB, "bwrap.json"))}, "utf8")), { stdio: "inherit" });\nprocess.exit(r.status ?? 1);\n`);
  spawnSync("tmux", [...TMUX, "new-session", "-d", "-s", "pispike", "-x", "200", "-y", "50", node, join(SB, "launch.mjs")]);
}
const pane = () => spawnSync("tmux", [...TMUX, "capture-pane", "-p", "-t", "pispike"], { encoding: "utf8" }).stdout ?? "";
const killPi = () => spawnSync("tmux", [...TMUX, "kill-session", "-t", "pispike"]);
const until = (event: string, ms: number) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    listeners.push((seen) => {
      if (seen === event) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
const firstPoll = (ms: number) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    onPoll.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });

const BRIEF1 =
  "Use the bash tool to run these three commands, one at a time, in this order: `echo spike-one`, then `rm -rf ../`, then `curl -sS -m 5 https://example.com`. If a command is blocked, say why in one line and go on to the next. Finish with one line per command saying what happened.";
const BRIEF2 = "After that, reply with exactly: follow-up received";
const BRIEF3 = "What was the very first command you ran in this session? Answer in one line.";

const report: string[] = [];
let ok = true;
const mark = (name: string, pass: boolean, detail = "") => {
  ok &&= pass;
  report.push(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

try {
  launch();
  if (!(await firstPoll(60_000))) {
    console.log(pane());
    throw new Error("Pi's extension never reached the agent");
  }
  console.log(">>> brief 1 (Pi idle)");
  send(BRIEF1);
  const firstTurn = await until("turn_end", 300_000);
  console.log(">>> brief 2 (Pi working)");
  send(BRIEF2);
  // The follow-up runs after the brief's pending work; wait for Pi to go quiet.
  let settledAt = 0;
  for (let i = 0; i < 120; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const last = states.at(-1);
    if (last?.event === "agent_settled" && Date.now() - last.at > 8000 && !inbox.length) {
      settledAt = last.at;
      break;
    }
  }
  console.log("\n--- pane after the brief ---\n" + pane().trimEnd().split("\n").slice(-25).join("\n"));
  mark("Pi reached the agent through its extension and ran a turn", firstTurn);

  const refused = decisions.find((d) => String(JSON.stringify(d)).includes("rm -rf"));
  mark("1. the Gate refused the blocklisted call", refused !== undefined && String(refused.decision) === "deny", refused ? String(refused.reason ?? "").slice(0, 80) : "no decision seen");
  const ask = asks.find((a) => JSON.stringify(a.input).includes("curl"));
  mark("2. a call left to the person waited for the answer", ask !== undefined && ask.answeredAt !== undefined && ask.answeredAt - ask.askedAt >= ASK_WAIT_MS - 100, ask ? `${Math.round(((ask.answeredAt ?? 0) - ask.askedAt) / 1000)} s` : "never asked");
  mark("3. both briefs were delivered (idle, then working)", settledAt > 0, `${polled} polls`);
  const order = states.map((s) => s.event);
  const sane = order[0] === "agent_start" && order.includes("turn_end") && order.includes("agent_end") && order.lastIndexOf("agent_settled") > order.lastIndexOf("agent_end") - 1;
  mark("4. state events in order", sane, order.join(" > ").slice(0, 160));

  // The transcript, from Pi's own session file.
  const files = readdirSync(sessions, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"));
  const transcript = files.length ? readFileSync(join(sessions, files[0]!), "utf8") : "";
  const texts = transcript
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e: { type?: string; message?: { role?: string } }) => e.type === "message" && e.message?.role === "assistant")
    .map((e: { message: { content: Array<{ type: string; text?: string }> } }) => e.message.content.filter((c) => c.type === "text").map((c) => c.text).join(" "))
    .filter(Boolean);
  console.log("\n--- assistant said ---\n" + texts.map((t: string) => `• ${t.replace(/\s+/g, " ").slice(0, 300)}`).join("\n"));
  mark("1b. Pi carried on after the refusal", /spike-one/.test(transcript) && /follow-up received/i.test(texts.join(" ")), "follow-up answered after the refused call");
  // From inside the same jail, Ollama itself is out of reach: only the socket's /ollama gets there.
  const direct = JSON.parse(readFileSync(join(SB, "bwrap.json"), "utf8")) as string[];
  const at = direct.lastIndexOf("--");
  const probe = spawnSync("bwrap", [...direct.slice(0, at + 1), node, "-e", "fetch('http://127.0.0.1:11434/api/version').then(()=>console.log('REACHED'),()=>console.log('BLOCKED'))"], { encoding: "utf8", timeout: 20_000 });
  const routeRefusals = ollamaSeen.filter((l) => /ollama route: refused/.test(l));
  mark("5. Pi reached Ollama only through the Worker's socket", texts.length > 0 && /BLOCKED/.test(probe.stdout) && routeRefusals.length === 0, `direct from the jail: ${probe.stdout.trim() || probe.stderr.trim().slice(0, 80)}; route refusals: ${routeRefusals.length}`);

  // Kill it, start it again on the same session id, and ask about the first run.
  killPi();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  states.length = 0;
  launch();
  if (!(await firstPoll(60_000))) throw new Error("Pi did not come back after the kill");
  console.log(">>> brief 3 (after a kill)");
  send(BRIEF3);
  await until("agent_settled", 300_000);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const after = readFileSync(join(sessions, readdirSync(sessions, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"))[0]!), "utf8");
  const lastText = after
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e: { type?: string; message?: { role?: string } }) => e.type === "message" && e.message?.role === "assistant")
    .at(-1)
    ?.message.content.filter((c: { type: string }) => c.type === "text")
    .map((c: { text: string }) => c.text)
    .join(" ");
  console.log(`  resumed answer: ${String(lastText).slice(0, 200)}`);
  mark("6. --session-id resumed the conversation after a kill", /echo spike-one|spike-one/.test(String(lastText)));
} catch (error) {
  mark("spike ran to the end", false, error instanceof Error ? error.message : String(error));
  console.log(pane());
} finally {
  killPi();
  stop();
  console.log("\nGate decisions:");
  for (const d of decisions) console.log(`  ${d.tool ?? d.tool_name} → ${d.decision} (${d.capability ?? ""}${d.reason ? `: ${String(d.reason).slice(0, 80)}` : ""})`);
  console.log("\n" + report.join("\n") + `\n\n${ok ? "SPIKE PASSED" : "SPIKE FAILED"}  (files in ${SB})`);
  process.exit(0);
}
