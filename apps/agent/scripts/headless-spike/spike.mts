// Headless Worker spike: a Claude Code Worker run
// headless (`claude -p`, stream-json in and out) inside Cobra's own sandbox, on the API
// key, with the real policy hook, the real Gate (its log kept here, no judge, nothing
// pushed) and a permission tool for what the policy leaves to a prompt. Spends a few
// cents of API credit. Built from the installed agent's modules; never imports index.ts.
//
//   ~/.local/share/cobra-agent/current/bin/node spike.mts            four turns
//   RESUME=<session id> .../node spike.mts <same dir>                  resume after a kill
//
// It makes a throwaway repository and worktree in a temp folder (or the folder given).
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync, existsSync, readdirSync, mkdtempSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

const BUILD = realpathSync(join(homedir(), ".local/share/cobra-agent/current"));
const A = join(BUILD, "apps/agent/src/agent");
const SB = process.argv[2] ?? mkdtempSync(join(tmpdir(), "cobra-headless-spike-"));
if (!existsSync(join(SB, "repo"))) {
  const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=spike@cobra", "-c", "user.name=spike", ...a], { cwd });
  mkdirSync(join(SB, "repo"), { recursive: true });
  mkdirSync(join(SB, "tools"), { recursive: true });
  git(join(SB, "repo"), "init", "-q", "-b", "main");
  writeFileSync(join(SB, "repo", "README.md"), "# spike repo\n");
  git(join(SB, "repo"), "add", ".");
  git(join(SB, "repo"), "commit", "-qm", "init");
  git(join(SB, "repo"), "worktree", "add", "-q", "-b", "feat/spike", "../repo.worktrees/spike");
  copyFileSync(join(import.meta.dirname, "perm.mjs"), join(SB, "tools", "perm.mjs"));
}
console.log(`spike folder: ${SB}`);
const contain = await import(join(A, "contain.ts"));
const proxy = await import(join(A, "workerProxy.ts"));
const { gate: _g, ...gateMod } = await import(join(A, "gate.ts"));
const { LaneRouter } = await import(join(A, "apiLane.ts"));
const { loadPolicy } = await import(join(A, "permissions.ts"));

const id = "spike_hl1";
const home = homedir();
const worktree = realpathSync(join(SB, "repo.worktrees/spike"));
const scope = { id, worktree, gitCommon: realpathSync(join(SB, "repo/.git")), gitPrivate: realpathSync(join(SB, "repo/.git/worktrees/spike")), branch: "feat/spike" };
const layout = contain.containLayout(id, join(SB, "workers"), join(tmpdir(), `jhs-${process.getuid?.() ?? "u"}`));
contain.prepareLayout(layout);
contain.seedClaudeFolder(layout.claude, worktree, { home });
writeFileSync(layout.brief, "");

const node = realpathSync(join(BUILD, "bin/node"));
const paths = { node, policyHook: join(A, "policyHook.ts"), stateHook: join(BUILD, "apps/agent/hooks/claude-hook.mjs"), brief: layout.brief };
const settings = join(SB, "workers", `${id}.settings.json`);
writeFileSync(settings, JSON.stringify(contain.containedSettings(paths, id), null, 2));
const permLog = join(layout.state, "permission.log");
const mcp = join(SB, "tools", "mcp.json");
writeFileSync(mcp, JSON.stringify({ mcpServers: { cobra: { command: node, args: [join(SB, "tools", "perm.mjs"), permLog] } } }));

// The Gate, as the agent runs it, with its side effects kept here.
const decisions: unknown[] = [];
const answers = { readScope: (w: string) => (w === id ? scope : null), policy: () => loadPolicy(), log: (e: unknown) => decisions.push(e), recordPending: () => {}, now: Date.now };
let spent = 0;
const key = readFileSync(join(home, ".config/cobra-agent/anthropic-api-key"), "utf8").trim();
const route = {
  router: new LaneRouter(() => true), token: () => "unused", key: () => key, workspace: () => null,
  upstream: new URL("https://api.anthropic.com"),
  record: (e: { model: string; dollars: number }) => { spent += e.dollars; console.log(`  [meter] ${e.model} $${e.dollars.toFixed(4)}`); },
  noteLimits: () => {}, noteLane: () => {},
  noteError: (s: number, m: string) => console.log(`  [KEY ERROR] ${s} ${m.slice(0, 200)}`),
  log: (l: string) => console.log(`  [gateway] ${l}`), now: Date.now,
};
const stop = proxy.serveWorker(id, layout.socket, {
  answers, token: () => "unused", allow: () => [], limits: () => {}, log: (l: string) => console.log(`  [proxy] ${l}`),
  anthropic: new URL("https://api.anthropic.com"), ollama: new URL("http://127.0.0.1:11434"), route, explicit: () => true,
});

const command = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--settings", settings, "--mcp-config", mcp, "--strict-mcp-config", "--permission-mode", "default",
  "--permission-prompt-tool", "mcp__cobra__permission", "--model", "haiku", ...(process.env.RESUME ? ["--resume", process.env.RESUME] : []),
  "--append-system-prompt", "You are a Cobra Worker in a sandbox with no network. Keep replies to one line."];
const expose = [...contain.toolchains(home), ...contain.harnessPaths(), join(BUILD, "apps/agent"), node, join(SB, "tools")];
const { TMPDIR: _t, ...extra } = { TMPDIR: "", CI: "1" };
const args = ["--clearenv", ...contain.containArgs({
  scope, layout, settings, home, expose, caches: contain.caches(home), masks: contain.secretFilesUnder(worktree), local: false,
  env: contain.containEnv({ home, path: contain.insidePath(process.env.PATH ?? "", expose, home), layout, extra }),
  node, bridge: join(A, "containBridge.ts"), command,
})];

const child = spawn("bwrap", args, { stdio: ["pipe", "pipe", "pipe"] });
let err = "";
child.stderr.on("data", (d) => (err += d));
const say = (text: string) => child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
const turns = process.env.RESUME ? ["What file did you create earlier in this session, and which color did I choose? One line."] : [
  "Do these in order: 1) Use the Write tool to create hello.txt containing 'hi from a headless worker'. 2) Run `git status --short` with Bash. 3) Run `rm README.md` with Bash (it may be refused; carry on). 4) Use AskUserQuestion to ask me which color I prefer, options Red and Blue. Then reply in one line: the git status output, whether rm was refused and why, and the color I chose.",
  "Run `curl -sS -m 5 https://example.com` with Bash and tell me in one line what happened.",
  "Write the numbers from 1 to 400 as words, one per line, in your reply. Do not use tools.",
  "Reply with exactly: still here",
];
let turn = 0;
let buffer = "";
const results: string[] = [];
const next = () => {
  if (turn >= turns.length) return child.stdin.end();
  console.log(`\n>>> turn ${turn + 1}`);
  say(turns[turn]);
  if (turn === 2) setTimeout(() => { console.log("  [interrupt sent]"); child.stdin.write(JSON.stringify({ type: "control_request", request_id: "int1", request: { subtype: "interrupt" } }) + "\n"); }, 4000);
  turn++;
};
child.stdout.on("data", (d) => {
  buffer += d;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === "system" && j.subtype === "init") console.log(`  [init] session ${j.session_id}, model ${j.model}, permission mode ${j.permissionMode}, mcp ${JSON.stringify(j.mcp_servers)}`);
    if (j.type === "assistant") for (const c of j.message.content) if (c.type === "tool_use") console.log(`  [tool] ${c.name} ${JSON.stringify(c.input).slice(0, 100)}`);
    if (j.type === "control_response") console.log(`  [control] ${JSON.stringify(j.response).slice(0, 120)}`);
    if (j.type === "result") { results.push(`${j.subtype} ${String(j.result ?? "").slice(0, 160).replace(/\s+/g, " ")}`); console.log(`  [result] ${j.subtype} | ${String(j.result ?? "").slice(0, 200).replace(/\s+/g, " ")}`); next(); }
  }
});
child.on("exit", (code) => {
  console.log(`\nexit ${code}; key spend $${spent.toFixed(4)}`);
  if (err.trim()) console.log("stderr:", err.trim().slice(0, 600));
  console.log("\nGate decisions:");
  for (const d of decisions as Array<Record<string, unknown>>) console.log(`  ${d.tool ?? d.tool_name} → ${d.decision} (${d.capability ?? ""}${d.reason ? ": " + String(d.reason).slice(0, 80) : ""})`);
  console.log("\nPermission tool saw:");
  if (existsSync(permLog)) for (const l of readFileSync(permLog, "utf8").trim().split("\n")) { const p = JSON.parse(l); console.log(`  ${p.tool} ${JSON.stringify(p.input).slice(0, 80)} → ${p.decision}`); }
  const hooks = join(layout.state, "hooks");
  console.log("\nState hook records:", existsSync(hooks) ? readdirSync(hooks).join(", ") || "(none)" : "(no folder)");
  console.log("hello.txt in worktree:", existsSync(join(worktree, "hello.txt")) ? readFileSync(join(worktree, "hello.txt"), "utf8").trim() : "MISSING");
  console.log("README.md still there:", existsSync(join(worktree, "README.md")));
  stop();
  process.exit(0);
});
setTimeout(() => { console.log("TIMEOUT"); child.kill(); }, 240_000);
next();
