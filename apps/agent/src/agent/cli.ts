import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createKeyStore, expiring, keyView, mintDesk } from "./keys.ts";
import { LEAD_SESSION, leadRunning, startLead, stopLead } from "./lead.ts";
import { SessionError } from "./sessions.ts";
import { attachCommand } from "./tmuxHost.ts";
import { CONFIG_DIR, DATA_DIR, STATE_DIR } from "./paths.ts";
import { runUninstall } from "./uninstall.ts";
import { keptEntry, linkedId, writeDeskFile } from "./deskLink.ts";
import { TMUX_SOCKET } from "./tmuxHost.ts";

/**
 * `cobra-agent`: the commands a person runs on the computer.
 *
 *   cobra-agent desk [--name <name>]       a key for the desk app on this computer (printed once)
 *   cobra-agent desk --into <file>         the same, written into the desk's computers.json (install.sh)
 *   cobra-agent keys                       the keys that can call this agent
 *   cobra-agent unlink <name or id>        revoke one
 *   cobra-agent uninstall [--purge] [--yes]   remove the agent from this computer (uninstall.ts)
 *   cobra-agent lead start | stop | status
 *   cobra-agent memory roundup | fold [day] | tidy | migrate [--dry-run] | sync | status   the Executive Assistant's memory (ea.ts)
 *   cobra-agent check [<path>] [--no-status]   check a checkout here, in the sandbox, and post cobra/local-check (checks.ts)
 *   cobra-agent audit verify | tail [n]    check the audit log's hash chain and anchors; its newest entries (auditCli.ts)
 *   cobra-agent policy-log verify          the old name of audit verify
 *   cobra-agent vault status | init | unlock | lock | seal   the vault that seals secret files (vaultCli.ts)
 *   cobra-agent models                     whether Claude, Codex and Ollama are ready here (modelSources.ts)
 *
 * Cobra runs on one computer: there is no phone to link, no relay and no
 * fleet. The agent listens on loopback only; the desk on this computer is
 * its one client.
 */

const run = promisify(execFile);
const AGENT_PORT = Number(process.env.COBRA_AGENT_PORT ?? 8787);

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function keys(): void {
  const { callers, refused } = createKeyStore().load();
  if (refused) fail(`Cannot read the key list: ${refused}`);
  if (callers.length === 0) {
    process.stdout.write("No keys yet. Run `cobra-agent desk` to make one for the desk app.\n");
    return;
  }
  for (const caller of callers) {
    const since = new Date(caller.linkedAt).toISOString().slice(0, 10);
    const view = keyView(caller, Date.now());
    const age = `, key ${view.keyAgeDays} days old`;
    const expires = view.expiresAt ? `, expires ${view.expiresAt.slice(0, 10)}` : expiring(caller) ? ", expires 90 days after its next use" : "";
    process.stdout.write(`${caller.name}  (${caller.kind}, linked ${since}${age}${expires}, ${caller.scopes.join("+")})  ${caller.id}\n`);
  }
}

function unlink(target: string | undefined): void {
  if (!target) fail("Say which: cobra-agent unlink <name or id>. `cobra-agent keys` lists them.");
  const keys = createKeyStore();
  const matches = keys.load().callers.filter((caller) => caller.id === target || caller.name === target);
  if (matches.length === 0) fail(`Nothing linked is called ${target}.`);
  if (matches.length > 1) fail(`More than one is called ${target}; use the id from \`cobra-agent keys\`.`);
  keys.remove(matches[0]!.id, "cli");
  process.stdout.write(`Unlinked ${matches[0]!.name}. Its key no longer works here.\n`);
}

/**
 * `cobra-agent uninstall [--purge] [--yes]` (uninstall.ts). It asks first,
 * unless --yes: it ends every Cobra session and Worker on this computer.
 */
async function uninstall(): Promise<void> {
  const purge = process.argv.includes("--purge");
  const here = new URL(".", import.meta.url).pathname;
  const home = homedir();
  const xdg = (variable: string, ...fallback: string[]) => {
    const value = process.env[variable];
    return value && value.startsWith("/") ? value : join(home, ...fallback);
  };
  process.stdout.write(
    [
      "This removes Cobra's agent from this computer:",
      "  - Cobra's hooks from ~/.claude/settings.json and ~/.codex/config.toml (each copied first), and the skills it installed",
      "  - stops and removes cobra-agent, which ends every Cobra session and Worker here",
      "  - the cobra-agent and ste-check commands",
      "  - the desk app, when install.sh put it there: its service, launcher entry, window rules and bar widget",
      purge
        ? `  - all of ${CONFIG_DIR}, ${STATE_DIR} and ${DATA_DIR}: keys, policy, memory, chats, and the desk app's own folders (--purge)`
        : `  - the package's builds; ${CONFIG_DIR}, ${STATE_DIR} and Cobra's data stay (--purge removes them)`,
      "Your projects and worktrees are never touched.",
      "",
    ].join("\n"),
  );
  if (!process.argv.includes("--yes")) {
    if (!process.stdin.isTTY) fail("Run it in a terminal to answer, or pass --yes.");
    const { createInterface } = await import("node:readline/promises");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await prompt.question("Type uninstall to go on: ")).trim();
    prompt.close();
    if (answer !== "uninstall") fail("Nothing was changed.");
  }
  const outcome = await runUninstall(
    {
      home,
      data: DATA_DIR,
      config: CONFIG_DIR,
      state: STATE_DIR,
      units: process.platform === "darwin" ? join(home, "Library", "LaunchAgents") : join(xdg("XDG_CONFIG_HOME", ".config"), "systemd", "user"),
      runtime: process.env.XDG_RUNTIME_DIR || null,
      codexHome: process.env.CODEX_HOME || join(home, ".codex"),
      tmuxDir: join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`),
      hooks: join(here, "..", "..", "hooks"),
      skills: join(here, "..", "..", "skills"),
      deskScript: join(here, "..", "..", "..", "desk", "scripts", "install-omarchy.sh"),
      deskFolders: [xdg("XDG_CONFIG_HOME", ".config"), xdg("XDG_DATA_HOME", ".local", "share"), xdg("XDG_CACHE_HOME", ".cache")].map((base) => join(base, "app.cobra.desktop")),
    },
    {
      purge,
      tmuxSocket: TMUX_SOCKET,
      agentPort: AGENT_PORT,
      node: process.execPath,
      stamp: new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, ""),
      ...(process.platform === "darwin" ? { launchd: { uid: process.getuid?.() ?? 0 } } : {}),
    },
    {
      run: async (command, args) => {
        try {
          const { stdout, stderr } = await run(command, [...args], { timeout: 30_000 });
          return { code: 0, stdout, stderr };
        } catch (caught) {
          const failed = caught as { code?: unknown; stdout?: string; stderr?: string; message?: string };
          return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? failed.message ?? "" };
        }
      },
      say: (line) => process.stdout.write(`${line}\n`),
      cmdline: (pid) => {
        try {
          if (process.platform === "darwin") return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
          return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
        } catch {
          return null;
        }
      },
      kill: (pid) => {
        try {
          process.kill(-pid, "SIGTERM");
          return true;
        } catch {
          return false;
        }
      },
    },
  );
  if (!outcome.ok) process.exit(1);
  process.stdout.write("Cobra's agent is uninstalled.\n");
}

/**
 * Make a key for the desk app on this computer (keys.ts mintDesk) and print
 * it once, as one JSON line the desk reads straight from the pipe. The key is
 * shown nowhere else and kept here only as a hash.
 */
async function desk(): Promise<void> {
  const keys = createKeyStore();
  const { callers, refused } = keys.load();
  if (refused) fail(`Cannot read the key list: ${refused}`);
  // --into <computers.json>: install.sh links the desk app itself (deskLink.ts). A key that
  // still works stays; the new key goes into the file only, never to the screen.
  const into = option("--into");
  const linked = into ? linkedId(into) : null;
  if (into && linked && callers.some((caller) => caller.id === linked)) {
    process.stdout.write(`The desk app is already linked (${linked}).\n`);
    return;
  }
  const { caller, key } = mintDesk(option("--name") ?? "Desktop", Date.now());
  keys.upsert(caller, "cli");
  const line = {
    machine: hostname(),
    label: process.env.COBRA_MACHINE_NAME?.trim() || hostname(),
    loopback: `http://127.0.0.1:${AGENT_PORT}`,
    tmuxSocket: TMUX_SOCKET,
    id: caller.id,
    key,
  };
  if (into) {
    writeDeskFile(into, keptEntry(line));
    process.stdout.write(`Linked the desk app (${caller.id}). \`cobra-agent unlink ${caller.id}\` revokes it.\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(line)}\n`);
  process.stderr.write(`Made a desktop key "${caller.name}" (${caller.id}). \`cobra-agent unlink ${caller.id}\` revokes it.\n`);
}

/** The Lead (lead.ts): the orchestrator, in its own tmux session. */
async function lead(action: string | undefined): Promise<void> {
  try {
    if (action === "start") {
      const started = await startLead();
      process.stdout.write(`The Lead runs in ${started.path}. Talk to it with: ${attachCommand(started.session)}\n`);
      return;
    }
    if (action === "stop") {
      await stopLead();
      process.stdout.write("The Lead stopped. Its Workers keep running.\n");
      return;
    }
    if (action === "status" || action === undefined) {
      process.stdout.write((await leadRunning()) ? `The Lead is running: ${attachCommand(LEAD_SESSION)}\n` : "The Lead is not running. Start it with: cobra-agent lead start\n");
      return;
    }
    fail("Use: cobra-agent lead start | stop | status");
  } catch (caught) {
    if (caught instanceof SessionError) fail(caught.message);
    throw caught;
  }
}

/** The Executive Assistant's memory, by hand: a round-up now, a sync, or what it did lately. */
async function memory(action: string | undefined): Promise<void> {
  const { lastEndedDay, liveFoldDeps, liveRoundupDeps, runFold, runRoundup } = await import("./ea.ts");
  const { computerName, MEMORY_DIR, readRuns } = await import("./memory.ts");
  const { DEFAULT_CONFIG_PATH } = await import("./collect/projects.ts");
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const deps = liveRoundupDeps(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH, log);
  switch (action) {
    case "roundup": {
      const result = await runRoundup(deps);
      if (result === null) fail("Another memory run holds the lock; try again in a minute.");
      process.stdout.write(`${result.outcome}${result.why ? `: ${result.why}` : ""}${result.files ? `\n${result.files.join("\n")}` : ""}\n`);
      return;
    }
    case "fold": {
      const day = process.argv[4] ?? lastEndedDay(Date.now());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail("cobra-agent memory fold [YYYY-MM-DD]   (default: the last memory day that ended at 4 AM)");
      const result = await runFold(liveFoldDeps(deps), day);
      if (result === null) fail("Another memory run holds the lock; try again in a minute.");
      process.stdout.write(`${day}: ${result.outcome}${result.why ? `: ${result.why}` : ""}${result.files ? `\n${result.files.join("\n")}` : ""}\n`);
      return;
    }
    case "tidy": {
      const { liveResolveKey, tidyMemory } = await import("./ea.ts");
      const { withMemoryLock } = await import("./memory.ts");
      const files = await withMemoryLock(async () => {
        if (deps.sync) await deps.sync.pull();
        const changed = await tidyMemory(MEMORY_DIR, computerName(), liveResolveKey, log);
        if (deps.sync && changed.length > 0) await deps.sync.push(`memory: ${computerName()} tidies its folder`);
        return changed;
      });
      if (files === null) fail("Another memory run holds the lock; try again in a minute.");
      process.stdout.write(files.length > 0 ? `${files.join("\n")}\n` : "nothing to tidy\n");
      return;
    }
    case "migrate": {
      // Once: moves memory to the layout by company.
      const dry = process.argv.includes("--dry-run");
      const { eaArgs, liveEaRun, liveResolveKey, liveSyncDeps, tidyMemory, FOLD_TIMEOUT_MS } = await import("./ea.ts");
      const { withMemoryLock, MEMORY_STATE_DIR } = await import("./memory.ts");
      const { migrate } = await import("./memoryMigrate.ts");
      const { memoryHome } = await import("./companyBrain.ts");
      const { orgForMemory } = await import("./memoryIndex.ts");
      const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const donePath = join(MEMORY_STATE_DIR, "migrate.json");
      const run = liveEaRun();
      const steps = await withMemoryLock(() =>
        migrate(
          {
            dir: MEMORY_DIR,
            computer: computerName(),
            git: liveSyncDeps(log).git,
            ask: (model, system, input) => run(eaArgs(model, system), input, FOLD_TIMEOUT_MS),
            tidy: () => tidyMemory(MEMORY_DIR, computerName(), liveResolveKey, log),
            brains: { home: () => memoryHome(), org: () => orgForMemory() },
            done: {
              load: () => {
                try {
                  return (JSON.parse(readFileSync(donePath, "utf8")) as { done?: string[] }).done ?? [];
                } catch {
                  return [];
                }
              },
              save: (done) => {
                mkdirSync(MEMORY_STATE_DIR, { recursive: true });
                writeFileSync(donePath, `${JSON.stringify({ done }, null, 2)}\n`);
              },
            },
            log,
            now: () => Date.now(),
          },
          dry,
        ),
      );
      if (steps === null) fail("Another memory run holds the lock; try again in a minute.");
      for (const step of steps) {
        process.stdout.write(`${step.step}:${step.lines.length ? "" : " nothing to do"}\n`);
        for (const line of step.lines) process.stdout.write(`  ${line}\n`);
      }
      if (dry) {
        process.stdout.write("dry run: nothing changed\n");
        return;
      }
      await deps.index?.();
      await deps.sync?.push(`memory: ${computerName()} migrates to local memory`);
      process.stdout.write(`done: ${MEMORY_DIR} is this computer's own now (the old history is tagged before-local)\n`);
      return;
    }
    case "sync":
      // Memory stays on this computer now: a sync commits what is there and rewrites the index.
      await deps.index?.();
      await deps.sync?.push(`memory: ${computerName()} by hand`);
      process.stdout.write(`committed ${MEMORY_DIR} (memory stays on this computer; nothing is pushed)\n`);
      return;
    case "status": {
      process.stdout.write(`memory: ${MEMORY_DIR}, on this computer only, as ${computerName()}\n`);
      const last = deps.cursor.load();
      process.stdout.write(`last round-up window ended: ${last ? new Date(last).toString() : "never"}\n`);
      process.stdout.write(`last day folded: ${liveFoldDeps(deps).folded.load() ?? "none yet"}\n`);
      for (const run of readRuns(15)) {
        const ms = run.ms ? ` ${Math.round(run.ms / 1000)}s` : "";
        process.stdout.write(`${run.at} ${run.kind} ${run.outcome}${run.why ? ` (${run.why})` : ""}${run.model ? ` ${run.model}` : ""}${ms}${run.input ? ` ${run.input} chars in` : ""}\n`);
      }
      return;
    }
    default:
      fail("cobra-agent memory roundup | fold [YYYY-MM-DD] | tidy | migrate [--dry-run] | sync | status");
  }
}

/**
 * The audit log (auditCli.ts, auditTrail.ts): `audit verify` checks every
 * kept file's chain and this computer's daily anchors in the memory folder,
 * and exits 1 at the first broken link; `audit tail [n]` prints the newest
 * entries in plain words. `policy-log verify` is verify's old name.
 */
async function auditLog(args: string[]): Promise<void> {
  const { auditCommand } = await import("./auditCli.ts");
  const { parseAnchors } = await import("./auditLog.ts");
  const { computerName, MEMORY_DIR, memoryPaths, readMemoryFile } = await import("./memory.ts");
  const code = auditCommand(args, {
    anchors: () => parseAnchors(readMemoryFile(MEMORY_DIR, memoryPaths.policyAnchors(computerName()))),
    write: (line) => process.stdout.write(line),
  });
  if (code !== 0) process.exit(code);
}

/**
 * Checks the checkout at <path> (default: here) the way a Worker's work is
 * checked: main's check command, in the sandbox, the result posted to GitHub
 * as the commit status cobra/local-check of HEAD. Exits 1 unless it passed.
 */
async function check(): Promise<void> {
  const { checkCheckout, liveSpawnSandbox } = await import("./checks.ts");
  const { git } = await import("./collect/git.ts");
  const { findGh, findTool } = await import("./github.ts");
  const args = process.argv.slice(3);
  const path = args.find((arg) => !arg.startsWith("--")) ?? process.cwd();
  const post = !args.includes("--no-status");
  const gh = await findGh();
  if (post && !gh) fail("gh is not installed, so the result cannot be posted: install gh, or check with --no-status");
  const computer = process.env.COBRA_MACHINE_NAME?.trim() || hostname();
  try {
    const result = await checkCheckout(
      {
        git: (cwd, gitArgs, timeoutMs) => git(cwd, gitArgs, timeoutMs ?? 20_000),
        gh: async (ghArgs) => (await run(gh!, ghArgs, { timeout: 30_000 })).stdout,
        findTool,
        spawnSandbox: liveSpawnSandbox(),
        now: () => Date.now(),
        computer,
        log: (line) => process.stderr.write(`${line}\n`),
      },
      path,
      { post },
    );
    if (result.state !== "success" && result.tail) process.stdout.write(`${result.tail}\n\n`);
    process.stdout.write(`${result.state}: ${result.description}\n`);
    process.stdout.write(`${result.sha.slice(0, 7)}${result.repo ? ` in ${result.repo}` : ""}${result.posted ? ", posted as cobra/local-check" : ", not posted"}${result.log ? `\nlog: ${result.log}` : ""}\n`);
    process.exit(result.state === "success" ? 0 : 1);
  } catch (caught) {
    fail(caught instanceof Error ? caught.message : String(caught));
  }
}

/**
 * Keeps the token `claude setup-token` prints, for Workers in Cobra's
 * sandbox (workerProxy.ts adds it to their requests; they never hold it).
 * Read from stdin so it never lands in shell history; `--clear` removes it.
 */
async function claudeToken(): Promise<void> {
  const { CLAUDE_TOKEN_PATH } = await import("./workerProxy.ts");
  const { writePrivateFile } = await import("./private.ts");
  const { rmSync } = await import("node:fs");
  if (process.argv.includes("--clear")) {
    rmSync(CLAUDE_TOKEN_PATH, { force: true });
    process.stdout.write("Removed. Contained Workers use your own Claude Code sign-in again.\n");
    return;
  }
  if (process.stdin.isTTY) process.stdout.write("Paste the token `claude setup-token` printed, then press Enter and Ctrl-D:\n");
  const input = await new Promise<string>((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
  });
  const token = input.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,400}$/.test(token)) fail("That does not look like a Claude token (sk-ant-…). Nothing was kept.");
  writePrivateFile(CLAUDE_TOKEN_PATH, `${token}\n`);
  process.stdout.write(`Kept in ${CLAUDE_TOKEN_PATH} (only you can read it). Contained Workers use it from their next request.\n`);
}

/**
 * More than one Claude and Codex account here (accounts.ts): list, add a
 * Claude one from a `claude setup-token` token (stdin), keep this computer's
 * Codex sign-in as one, switch, remove. A new Codex account signs in from the
 * desk or the phone (Settings → Accounts), which show its one-time code.
 */
async function accounts(args: string[]): Promise<void> {
  const mod = await import("./accounts.ts");
  const { rmSync } = await import("node:fs");
  const { SUBSCRIPTION_LIMITS } = await import("./limits.ts");
  const show = (view: ReturnType<typeof mod.accountsView>) => {
    for (const provider of ["claude", "codex"] as const) {
      const own = view.computer[provider];
      const ownActive = provider === "claude" ? view.computer.claude.active : !view.computer.codex.saved;
      process.stdout.write(`${provider === "claude" ? "Claude" : "Codex"}\n`);
      process.stdout.write(`  ${ownActive ? "*" : " "} computer   this computer's own sign-in${own.email ? ` (${own.email})` : ""}\n`);
      for (const a of view.accounts.filter((x) => x.provider === provider)) {
        process.stdout.write(`  ${a.active ? "*" : " "} ${a.id}  ${a.label}${a.email && a.email !== a.label ? ` (${a.email})` : ""}\n`);
      }
    }
  };
  const [verb, first, second] = args;
  try {
    if (!verb || verb === "list") return show(mod.accountsView());
    if (verb === "add" && first === "claude") {
      if (process.stdin.isTTY) process.stdout.write("Paste the token `claude setup-token` printed (signed in as that account), then press Enter and Ctrl-D:\n");
      const input = await new Promise<string>((resolve) => {
        let text = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk: string) => (text += chunk));
        process.stdin.on("end", () => resolve(text));
      });
      const account = await mod.addClaudeAccount({ token: input, label: second });
      process.stdout.write(`Kept as ${account.id} (${account.label}). Use it with: cobra-agent accounts use claude ${account.id}\n`);
      return;
    }
    if (verb === "save" && first === "codex") {
      const account = mod.saveLiveCodex(undefined, second);
      if (!account) fail("codex is not signed in on this computer.");
      process.stdout.write(`Kept this computer's Codex sign-in as ${account!.id} (${account!.label}).\n`);
      return;
    }
    if (verb === "use" && (first === "claude" || first === "codex") && second) {
      const view = await mod.useAccount(
        { provider: first, id: second === "computer" ? null : second },
        { codexRunning: mod.codexRunning, clearLimits: () => rmSync(SUBSCRIPTION_LIMITS, { force: true }) },
      );
      return show(view);
    }
    if (verb === "remove" && first) return show(mod.removeAccount({ id: first }));
  } catch (caught) {
    fail(caught instanceof Error ? caught.message : String(caught));
  }
  fail("Use: cobra-agent accounts [list] | add claude [label] | save codex [label] | use claude|codex <id|computer> | remove <id>");
}


const [command, argument] = process.argv.slice(2);
switch (command) {
  case "keys":
    keys();
    break;
  case "unlink":
    unlink(argument);
    break;
  case "uninstall":
    await uninstall();
    break;
  case "desk":
    await desk();
    break;
  case "lead":
    await lead(argument);
    break;
  case "memory":
    await memory(argument);
    break;
  case "check":
    await check();
    break;
  case "audit":
    await auditLog(process.argv.slice(3));
    break;
  case "policy-log":
    // The old name: the policy's decisions are in the audit log, so this verifies the whole of it.
    if (argument !== "verify") fail("cobra-agent policy-log verify (now cobra-agent audit verify)");
    await auditLog(["verify"]);
    break;
  case "claude-token":
    await claudeToken();
    break;
  case "vault": {
    const { vaultCommand } = await import("./vaultCli.ts");
    await vaultCommand(process.argv.slice(3), fail);
    break;
  }
  case "accounts":
    await accounts(process.argv.slice(3));
    break;
  case "api-key": {
    const { apiKeyCommand } = await import("./apiLaneCli.ts");
    await apiKeyCommand(process.argv.slice(3), fail);
    break;
  }
  case "api-lane": {
    const { apiLaneCommand } = await import("./apiLaneCli.ts");
    await apiLaneCommand(process.argv.slice(3), fail);
    break;
  }
  case "cost": {
    const { runCostCommand } = await import("./costReport.ts");
    runCostCommand(process.argv.slice(3), fail);
    break;
  }
  case "models": {
    const { liveSources, sourceLines } = await import("./modelSources.ts");
    process.stdout.write(`${sourceLines(await liveSources()).join("\n")}\n`);
    break;
  }
  case "space": {
    // How a Space's Foremen work here (spaceForemen.ts): written in its space.json, read by the agent at each spawn.
    const [{ spaceCommand }, { SpaceError }] = await Promise.all([import("./spaceForemen.ts"), import("./spaces.ts")]);
    try {
      process.stdout.write(`${spaceCommand(process.argv.slice(3))}\n`);
    } catch (caught) {
      if (caught instanceof SpaceError) fail(caught.message);
      throw caught;
    }
    break;
  }
  default:
    process.stdout.write(
      [
        "cobra-agent keys                   list the keys that can call this agent",
        "cobra-agent unlink <name or id>    remove one; its key stops working at once",
        "cobra-agent desk [--name <name>]   make a key for Cobra's desktop app (prints it once)",
        "cobra-agent lead start|stop|status the Lead: the orchestrator that starts Workers in your projects",
        "cobra-agent memory roundup|fold|tidy|migrate|sync|status  the Executive Assistant's memory: a round-up or a day's fold now, renamed repositories merged, the move to memory on this computer only (--dry-run first), a sync, what it did",
        "cobra-agent check [<path>] [--no-status]  check a checkout in the sandbox and post cobra/local-check to its commit",
        "cobra-agent audit verify|tail [n] [--all]  check the audit log's hash chain and daily anchors (names the first broken link); its newest entries in plain words",
        "cobra-agent policy-log verify      the old name of audit verify",
        "cobra-agent claude-token [--clear] keep a `claude setup-token` token (stdin) for Workers in Cobra's sandbox",
        "cobra-agent accounts [list]|add claude [label]|save codex [label]|use claude|codex <id|computer>|remove <id>  more than one Claude and Codex account here, and which one is in use",
        "cobra-agent api-key [--workspace <id>] [--clear]  keep an Anthropic API key (stdin) for the API lane, checked once with Anthropic",
        "cobra-agent api-lane status|on --cap <dollars>|off|cap <dollars>  the fleet's API lane: spend API credits when the subscription is full",
        "cobra-agent cost [--space <id>] [--since <day or time>] [--until <…>] [--lane subscription|api|all] [--unit <n>] [--csv <file>] [--json]  what work cost here on the key, and on the subscription at API prices: by lane, role, what woke each turn, session and Worker task, tokens, context's share, and per unit",
        "cobra-agent space get <space>|set <space> foremen on-call|standing  how a Space's Foremen work: standing (every task through them) or on-call (Cobra starts one Worker herself for a light task)",
        "cobra-agent models                 whether Claude, Codex and Ollama are ready here, and what to do for one that is not",
        "cobra-agent uninstall [--purge] [--yes]  remove the agent from this computer (--purge: its settings, keys and memory too)",
        "",
      ].join("\n"),
    );
    // Asked for, the usage is an answer; an unknown command is a mistake.
    process.exit(command && !["-h", "--help", "help"].includes(command) ? 1 : 0);
}
