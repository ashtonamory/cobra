import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { isSecret, underHome } from "./credentials.ts";
import { seatbeltArgv, seatbeltPlan } from "./seatbelt.ts";

/**
 * A Codex Lead or Foreman in a filesystem fence. Codex's read-only sandbox
 * stops writes and the network for its shell, but reads every file the
 * person can, ~/.ssh and the agent's keys among them, and the Lead's and
 * Foremen's deny rules are Claude Code's, which Codex never reads. So the
 * whole Codex process runs under bwrap with home an empty tmpfs and only
 * what the work needs shown again: read-only its folders (for a Foreman its
 * project, its Workers' worktrees and its company's sister projects; for the
 * Lead its home and every project here; for both the trades' templates), the
 * toolchains, the agent's code and its MCP servers' files; writable only its
 * Codex home and a Foreman's own folder. The network is shared (Codex talks
 * to the agent's broker on 127.0.0.1, and its own sandbox still keeps the
 * shell offline), and Codex's sandbox runs nested inside, as it does in a
 * contained Worker. A Claude Code Lead or Foreman needs none of this: Claude
 * Code asks the person before reading outside its folders.
 *
 * On macOS the same fence is a sandbox-exec profile (fenceCommand,
 * seatbelt.ts). macOS cannot start a sandbox inside another, so Codex runs
 * there with its own sandbox off (orchSandboxMode) and the fence holds its
 * shell too: writes only where the fence allows, and the network only to
 * loopback, HTTPS and its line to the agent.
 */

export type OrchFence = {
  home: string;
  /** Shown read-only: the work's folders, toolchains, the agent's code, MCP servers' files. */
  read: string[];
  /** Shown writable on top: its Codex home, a Foreman's own folder. */
  write: string[];
  cwd: string;
  /** macOS: the folders whose sockets it may connect to (its line to the agent, orchSocket.ts). */
  sockets?: string[];
};

/** Codex's own sandbox for a Lead or Foreman: read-only inside the bubblewrap fence; off inside macOS's, which cannot nest one. */
export function orchSandboxMode(platform: NodeJS.Platform = process.platform): "read-only" | "danger-full-access" {
  return platform === "darwin" ? "danger-full-access" : "read-only";
}

/**
 * The fenced command for this computer: bubblewrap's arguments (fenceArgs),
 * or on macOS the profile they describe, with a temp folder in the first
 * writable folder (its Codex home).
 */
export function fenceCommand(fence: OrchFence, command: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const args = fenceArgs(fence, command);
  if (platform !== "darwin") return args;
  const home = fence.write[0];
  if (!home) throw new Error("a fence needs a writable folder for its temp files");
  const tmp = join(home, "tmp");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return seatbeltArgv(seatbeltPlan(args.slice(1), { tmp, network: "web", sockets: fence.sockets ?? [] }));
}

/** Paths that are there, links followed, duplicates and paths inside another dropped; never a credential. */
export function shownPaths(paths: readonly string[], home = homedir(), exists: (path: string) => boolean = existsSync): string[] {
  const inside = (root: string, path: string) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const out: string[] = [];
  for (const path of [...new Set(paths.filter((path) => isAbsolute(path) && exists(path)))].sort((a, b) => a.length - b.length)) {
    const rel = underHome(home, path);
    if (rel !== null && rel !== "" && isSecret(rel)) continue;
    if (!out.some((root) => inside(root, path))) out.push(path);
  }
  return out;
}

/** bwrap's arguments, then `command`: home empty, the read paths read-only, the write paths writable, the network kept. */
export function fenceArgs(fence: OrchFence, command: readonly string[], kind: (path: string) => "file" | "dir" | null = kindOf): string[] {
  const ro = (path: string) => (kind(path) === null ? [] : ["--ro-bind", path, path]);
  const rw = (path: string) => (kind(path) === null ? [] : ["--bind", path, path]);
  return [
    "bwrap",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    // /run holds the host's sockets (docker, the session bus, tmux, the Gate): gone, but for DNS, which /etc/resolv.conf often leads into.
    "--tmpfs", "/run",
    "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve",
    "--tmpfs", fence.home,
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    // No capability, even in its own namespace (OV-SEC-VPS-001 F19). Not the
    // rest of contain.ts JAIL_HARDENING: Codex's read-only sandbox nests a
    // user namespace of its own (bubblewrap, codex 0.167), which
    // --disable-userns refuses, and the TUI in its tmux pane needs the pane as
    // its controlling terminal for resizes, which --new-session takes away.
    "--cap-drop", "ALL",
    "--die-with-parent",
    ...fence.read.flatMap(ro),
    ...fence.write.flatMap(rw),
    "--chdir", fence.cwd,
    "--",
    ...command,
  ];
}

function kindOf(path: string): "file" | "dir" | null {
  try {
    return statSync(path).isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

/** The absolute paths an MCP server's launch names (its command, arguments and environment), which it needs inside. */
export function mcpPaths(servers: Readonly<Record<string, { command?: unknown; args?: unknown; env?: unknown }>>): string[] {
  const out: string[] = [];
  for (const server of Object.values(servers)) {
    const values = [server.command, ...(Array.isArray(server.args) ? server.args : []), ...Object.values((server.env ?? {}) as Record<string, unknown>)];
    for (const value of values) {
      if (typeof value !== "string" || !isAbsolute(value)) continue;
      // An agent script imports its neighbours: its whole package, not the one file.
      const at = value.indexOf(AGENT_SRC);
      out.push(at === -1 ? value : value.slice(0, at));
    }
  }
  return [...new Set(out)];
}

const AGENT_SRC = "/apps/agent/src/agent/";

/** A path as it is and with its links followed: a launch names `current/…`, which leads to the build. */
export function bothWays(paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    try {
      const real = realpathSync(path);
      return real === path ? [path] : [path, real];
    } catch {
      return [path];
    }
  });
}

/** The agent's own package (or checkout) holding `here`, as its launches name it and as it is: three folders up from src/agent. */
export function agentPackage(here: string): string {
  return join(here, "..", "..", "..", "..");
}
