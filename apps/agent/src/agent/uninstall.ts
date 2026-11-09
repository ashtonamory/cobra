import { copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * `cobra-agent uninstall [--purge] [--yes]` (issue #404): what docs/install.md
 * section 7.3 used to have a person do by hand, in the same order.
 *
 *   1. Cobra's entries out of the files it shares with other tools
 *      (~/.claude/settings.json's hooks, ~/.codex/config.toml's notify line,
 *      the skills it copied), each file copied first to
 *      `<file>.bak.cobra-<time>`, and only Cobra's own lines touched.
 *   2. Everything Cobra started stopped: both units killed (every process in
 *      their cgroups: tmux servers they forked, headless Workers) and
 *      disabled, the agent's own tmux server, and any headless session whose
 *      shell is still there.
 *   3. The units and the commands removed (only links into the package).
 *   3b. The desk app, when the package installed it (install.sh): its
 *      service, ~/.local/bin/cobra-desktop, the launcher entry, and on
 *      Omarchy the Hyprland rules and the bar widget (install-omarchy.sh
 *      --uninstall, which backs up each file it edits).
 *   4. The package's builds removed. With --purge also Cobra's config,
 *      state and data folders (keys, policy, memory, chats) and its runtime
 *      sockets; without it they stay, so a reinstall picks up where it was.
 *
 * Never removed: projects, worktrees, Claude Code's and Codex's own files
 * beyond Cobra's lines, linger. The end of the run lists them. On macOS the
 * launchd user agents stand in for the systemd units.
 *
 * Every command goes through `deps.run` and every message through
 * `deps.say`, so the test drives it in a throwaway home.
 */

export type UninstallPaths = {
  home: string;
  /** ~/.local/share/cobra-agent: the package builds (install.sh's PREFIX), and the agent's data. */
  data: string;
  config: string;
  state: string;
  /** ~/.config/systemd/user, or ~/Library/LaunchAgents on macOS. */
  units: string;
  /** $XDG_RUNTIME_DIR, for contained Workers' sockets (cobra-w). */
  runtime: string | null;
  /** ~/.codex (CODEX_HOME). */
  codexHome: string;
  /** Where tmux keeps its sockets: ${TMUX_TMPDIR:-/tmp}/tmux-<uid>. */
  tmuxDir: string;
  /** The package's hook helpers and skills (apps/agent/hooks, apps/agent/skills). */
  hooks: string;
  skills: string;
  /** The package's desk installer (apps/desk/scripts/install-omarchy.sh), when the package carries the desk; it takes the desk out with --uninstall. */
  deskScript?: string | null;
  /** The desk app's own folders (app.cobra.desktop under config, data and cache: its link to the agent, its web view); --purge removes them. */
  deskFolders?: string[];
};

export type UninstallOptions = {
  purge: boolean;
  tmuxSocket: string;
  agentPort: number;
  termPort: number;
  /** The package's node, which runs the hook helpers. */
  node: string;
  /** For the backups' names. */
  stamp: string;
  /** macOS: launchd user agents (launchd/*.plist) in place of systemd units; `uid` names their domain. */
  launchd?: { uid: number };
};

export type RunResult = { code: number; stdout: string; stderr: string };

export type UninstallDeps = {
  run: (command: string, args: readonly string[]) => Promise<RunResult>;
  say: (line: string) => void;
  /** /proc/<pid>/cmdline, or null when the process is gone. */
  cmdline: (pid: number) => string | null;
  kill: (pid: number) => boolean;
};

export const UNITS = ["cobra-agent.service", "cobra-term.service"] as const;
export const LAUNCHD_LABELS = ["app.cobra.agent", "app.cobra.term"] as const;

function backup(path: string, stamp: string): string {
  const copy = `${path}.bak.cobra-${stamp}`;
  copyFileSync(path, copy);
  return copy;
}

function isLinkInto(path: string, folder: string): boolean {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    return resolve(join(path, ".."), readlinkSync(path)).startsWith(`${folder}/`);
  } catch {
    return false;
  }
}

function sameTree(a: string, b: string): boolean {
  try {
    const left = readdirSync(a, { withFileTypes: true }).map((entry) => entry.name).sort();
    const right = readdirSync(b, { withFileTypes: true }).map((entry) => entry.name).sort();
    if (left.join("\0") !== right.join("\0")) return false;
    return left.every((name) => {
      const one = join(a, name);
      const two = join(b, name);
      if (lstatSync(one).isDirectory()) return lstatSync(two).isDirectory() && sameTree(one, two);
      return !lstatSync(two).isDirectory() && readFileSync(one).equals(readFileSync(two));
    });
  } catch {
    return false;
  }
}

/** Headless sessions' records: workers/<id>.d/headless.json and headless-orch/<session>.d/headless.json. */
function headlessRecords(state: string): Array<{ dir: string; pid: number }> {
  const found: Array<{ dir: string; pid: number }> = [];
  for (const parent of [join(state, "workers"), join(state, "headless-orch")]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(parent);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".d")) continue;
      const dir = join(parent, entry);
      try {
        const pid = (JSON.parse(readFileSync(join(dir, "headless.json"), "utf8")) as { pid?: unknown }).pid;
        if (typeof pid === "number" && Number.isInteger(pid) && pid > 1) found.push({ dir, pid });
      } catch {
        // No record, or not one of ours.
      }
    }
  }
  return found;
}

export type UninstallOutcome = { ok: boolean; left: string[] };

export async function runUninstall(paths: UninstallPaths, options: UninstallOptions, deps: UninstallDeps): Promise<UninstallOutcome> {
  const { say, run } = deps;
  const left: string[] = [];

  // 1. Cobra's lines out of the files it shares with other tools.
  say("Files Cobra shares with other tools");
  const claudeSettings = join(paths.home, ".claude", "settings.json");
  if (existsSync(claudeSettings) && readFileSync(claudeSettings, "utf8").includes("claude-hook.mjs")) {
    const copy = backup(claudeSettings, options.stamp);
    const done = await run(options.node, [join(paths.hooks, "claude-settings.mjs"), "remove", claudeSettings]);
    say(done.code === 0 ? `  ✓ Cobra's hooks taken out of ${claudeSettings} (copy: ${copy})` : `  ! ${claudeSettings} was left as it is: ${done.stderr.trim() || `exit ${done.code}`}`);
  } else {
    say(`  ✓ ${claudeSettings}: no Cobra hooks`);
  }
  if (existsSync(`${claudeSettings}.before-cobra`)) left.push(`${claudeSettings}.before-cobra (your settings from before the first --claude-hooks; delete it when you are happy)`);
  const codexConfig = join(paths.codexHome, "config.toml");
  if (existsSync(codexConfig) && readFileSync(codexConfig, "utf8").includes("codex-notify.mjs")) {
    const copy = backup(codexConfig, options.stamp);
    const done = await run(options.node, [join(paths.hooks, "codex-config.mjs"), "remove", codexConfig]);
    say(done.code === 0 ? `  ✓ Cobra's notify line taken out of ${codexConfig} (copy: ${copy})` : `  ! ${codexConfig} was left as it is: ${done.stderr.trim() || `exit ${done.code}`}`);
  } else {
    say(`  ✓ ${codexConfig}: no Cobra notify line`);
  }
  let skills: string[] = [];
  try {
    skills = readdirSync(paths.skills);
  } catch {
    // A package with no skills.
  }
  for (const skill of skills) {
    const installed = join(paths.home, ".claude", "skills", skill);
    if (!existsSync(installed)) continue;
    if (sameTree(join(paths.skills, skill), installed)) {
      rmSync(installed, { recursive: true, force: true });
      say(`  ✓ removed the ${skill} skill from ~/.claude/skills`);
    } else {
      say(`  ! ~/.claude/skills/${skill} differs from the one Cobra installed, so it was kept`);
      left.push(installed);
    }
  }
  if (existsSync(join(paths.codexHome, "auth.json"))) {
    left.push(`${join(paths.codexHome, "auth.json")}: Codex's sign-in, as Cobra last switched it (\`codex login\` to change it)`);
  }

  // 2. Stop everything Cobra started. kill first: KillMode=process stops only node, and
  //    tmux servers and headless Workers live on in the units' cgroups.
  say("Stopping Cobra (this ends every Cobra session and Worker)");
  if (options.launchd) {
    // bootout stops each agent and unloads it; its tmux server lives on (AbandonProcessGroup) and is stopped below.
    let stopped = 0;
    for (const label of LAUNCHD_LABELS) {
      const out = await run("launchctl", ["bootout", `gui/${options.launchd.uid}/${label}`]);
      if (out.code === 0) stopped += 1;
    }
    say(stopped ? "  ✓ cobra-agent and cobra-term stopped and unloaded" : "  ✓ cobra-agent and cobra-term were not loaded");
  } else {
    await run("systemctl", ["--user", "kill", ...UNITS]);
    const disabled = await run("systemctl", ["--user", "disable", "--now", ...UNITS]);
    say(disabled.code === 0 ? "  ✓ cobra-agent and cobra-term stopped and disabled" : `  ! systemctl: ${disabled.stderr.trim() || `exit ${disabled.code}`}`);
  }
  if (options.tmuxSocket === "default") {
    say("  ! Cobra's sessions ran on your own tmux server (--tmux-socket default), which was left running: close cobra_lead, the *_fm sessions and the Workers' sessions yourself");
  } else {
    const killed = await run("tmux", ["-L", options.tmuxSocket, "kill-server"]);
    say(killed.code === 0 ? `  ✓ Cobra's tmux server (-L ${options.tmuxSocket}) stopped` : `  ✓ no tmux server on -L ${options.tmuxSocket}`);
  }
  for (const record of headlessRecords(paths.state)) {
    // A kept pid may belong to another program by now: only a shell still naming the session's folder is Cobra's.
    if (!(deps.cmdline(record.pid) ?? "").includes(record.dir)) continue;
    if (deps.kill(record.pid)) say(`  ✓ stopped the headless session in ${record.dir}`);
  }

  // 3. Units and commands.
  say("Units and commands");
  for (const unit of options.launchd ? LAUNCHD_LABELS.map((label) => `${label}.plist`) : UNITS) {
    const path = join(paths.units, unit);
    if (existsSync(path)) {
      unlinkSync(path);
      say(`  ✓ removed ${path}`);
    }
  }
  if (!options.launchd) {
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "reset-failed", ...UNITS]);
  }
  for (const command of ["cobra-agent", "ste-check"]) {
    const path = join(paths.home, ".local", "bin", command);
    if (isLinkInto(path, paths.data)) {
      unlinkSync(path);
      say(`  ✓ removed ${path}`);
    } else if (existsSync(path)) {
      say(`  ! ${path} is not a link into Cobra's package, so it was kept`);
      left.push(path);
    }
  }

  // 3b. The desk app, when this package put it on the desktop.
  const deskBin = join(paths.home, ".local", "bin", "cobra-desktop");
  const deskUnit = join(paths.units, "cobra-desktop.service");
  const deskThere = existsSync(deskBin) || existsSync(deskUnit);
  const deskOurs = Boolean(paths.deskScript && existsSync(paths.deskScript));
  if (deskThere && deskOurs) {
    say("The desk app");
    const done = await run("bash", [paths.deskScript!, "--uninstall"]);
    say(done.code === 0 ? "  ✓ the desk app, its service, launcher entry, window rules and bar widget removed" : `  ! the desk app was not removed: ${done.stderr.trim() || `exit ${done.code}`}`);
    if (done.code !== 0) left.push(`The desk app: ${deskBin} and ${deskUnit}`);
  } else if (deskThere) {
    left.push(`The desk app (${deskBin}): this package did not install it; remove it as you installed it`);
  }

  // 4. The package, and with --purge everything Cobra keeps.
  say(options.purge ? "Cobra's folders (--purge)" : "The package");
  if (options.purge) {
    const folders = [paths.config, paths.state, paths.data, ...(paths.runtime ? [join(paths.runtime, "cobra-w")] : []), ...(paths.deskFolders ?? [])];
    for (const folder of folders) {
      if (!existsSync(folder)) continue;
      rmSync(folder, { recursive: true, force: true });
      say(`  ✓ removed ${folder}`);
    }
    if (options.tmuxSocket !== "default") rmSync(join(paths.tmuxDir, options.tmuxSocket), { force: true });
  } else {
    let entries: string[] = [];
    try {
      entries = readdirSync(paths.data);
    } catch {
      // Nothing installed.
    }
    let builds = 0;
    for (const entry of entries) {
      if (entry === "current" || entry === ".current.tmp" || /^\.?\d[^/]*?(\.tmp)?$/.test(entry)) {
        rmSync(join(paths.data, entry), { recursive: true, force: true });
        if (entry !== "current" && !entry.startsWith(".")) builds += 1;
      }
    }
    say(`  ✓ removed ${builds} ${builds === 1 ? "build" : "builds"} from ${paths.data}`);
    left.push(`${paths.config}, ${paths.state} and the rest of ${paths.data}: Cobra's settings, keys, memory and chats, kept for a reinstall (\`cobra-agent uninstall --purge\` removes them; with the package gone, delete them by hand: rm -rf the three)`);
  }

  left.push(
    "Your projects, their <repo>.worktrees folders and .cobra-attachments, and ~/Downloads/Cobra: yours, never touched",
    ...(options.launchd ? [] : ["Linger: `sudo loginctl disable-linger $USER`, only if nothing else of yours needs it"]),
  );
  say("Left as it was");
  for (const line of left) say(`  - ${line}`);
  return { ok: true, left };
}
