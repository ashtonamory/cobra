import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Cobra's sandbox on macOS: the bubblewrap arguments the Linux sandbox is
 * built from (contain.ts containArgs, checks.ts sandboxArgs, installJail.ts
 * installArgs, orchFence.ts fenceArgs), read as a description of what a
 * process may see, and turned into a `sandbox-exec` profile (Seatbelt).
 * One description for both systems, so they cannot drift apart.
 *
 * What maps, in bubblewrap's order (a later bind covers an earlier one, as a
 * later Seatbelt rule wins over an earlier one):
 *
 *   --ro-bind / /          every file readable, none writable
 *   --tmpfs P              P gone: neither read nor written (home, /tmp)
 *   --ro-bind P P          P readable again, not writable
 *   --bind P P             P readable and writable
 *   --ro-bind /dev/null P  P gone (a secret by name)
 *   --ro-bind E P          P not writable (a cover for a name not there yet)
 *   --ro-bind R /run/cobra the Worker's socket folder R: its one way out
 *   --overlay-src P        a build cache: readable only (writes fail here,
 *                          where Linux throws them away)
 *   --unshare-all          no network, but the Worker's socket and its
 *                          bridge port on loopback; --share-net: network
 *   --clearenv, --setenv   the environment, through env -i
 *   --chdir                where it starts
 *
 * What does not map: macOS has no second /etc to lay over the first, so a
 * Codex Worker (its managed requirements in /etc/codex) is refused here;
 * Linux's namespaces and capability drop have no counterpart and are left
 * out. macOS cannot start a sandbox inside another either, so whatever runs
 * inside must not start its own (Codex runs with danger-full-access).
 *
 * Paths are written as macOS resolves them (/tmp is /private/tmp, /var is
 * /private/var): Seatbelt matches the real path.
 */

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Where Linux shows a Worker's socket folder (contain.ts INSIDE_RUN). */
const INSIDE_RUN = "/run/cobra";

export type SeatbeltNetwork =
  /** None: only unix sockets in the socket folder, and the bridge port on loopback. */
  | "none"
  /** The web: HTTPS anywhere, loopback, DNS. A Codex Lead's or Foreman's fence (its GitHub MCP server). */
  | "web"
  /** All of it: a dependency install. */
  | "full";

export type SeatbeltOptions = {
  /** A private, writable folder that becomes TMPDIR: /tmp is the computer's own here. */
  tmp: string;
  /** The Worker's bridge port on loopback (bridgePort): its proxy and its model. */
  bridge?: number;
  /** Overrides what the arguments say about the network. */
  network?: SeatbeltNetwork;
  /** Folders whose unix sockets it may connect to, beside the one bound at /run/cobra (an orchestrator's line). */
  sockets?: readonly string[];
  /** A path's real form; a path not there yet keeps its name under its folder's real path. */
  real?: (path: string) => string;
  exists?: (path: string) => boolean;
  /** This user's temp folder (os.tmpdir()): private like /tmp when the arguments make /tmp private. */
  userTmp?: string;
};

/**
 * What a private /tmp hides on macOS: /tmp, and this user's own temp folder
 * (/var/folders/…/T, with its cache folder C beside it), where the agent and
 * every Worker keep their temp files. Each Worker's own comes back after it.
 */
export function privateTemps(userTmp: string): string[] {
  return basename(userTmp) === "T" ? ["/tmp", dirname(userTmp)] : ["/tmp", userTmp];
}

export type SeatbeltPlan = {
  profile: string;
  /** The environment it starts with, or null to inherit the caller's. */
  env: Record<string, string> | null;
  /** TMPDIR, real path: given to an inherited environment too. */
  tmp: string;
  cwd: string | null;
  command: string[];
};

export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

/** A string in Seatbelt's profile language. */
export function sbString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * A Worker's bridge port. On Linux every Worker has a loopback of its own and
 * uses 8899; on macOS they share the computer's, so each gets its own port,
 * from the same hash as its socket folder (contain.ts containLayout `run`).
 */
export function bridgePort(run: string): number {
  return 40_000 + (Number.parseInt(createHash("sha256").update(basename(run)).digest("hex").slice(0, 8), 16) % 20_000);
}

/** The mach services a shell, git, node and the harnesses look up. Never the keychain's (com.apple.SecurityServer, securityd). */
const MACH_SERVICES = [
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.notification_center",
  "com.apple.system.logger",
  "com.apple.logd",
  "com.apple.diagnosticd",
  "com.apple.trustd",
  "com.apple.trustd.agent",
  "com.apple.cfprefsd.daemon",
  "com.apple.cfprefsd.agent",
  "com.apple.FSEvents",
  "com.apple.CoreServices.coreservicesd",
  "com.apple.lsd.mapdb",
  "com.apple.SystemConfiguration.configd",
];

/** Name resolution, for a profile with a network. */
const DNS_SERVICES = ["com.apple.dnssd.service", "com.apple.SystemConfiguration.DNSConfiguration", "com.apple.networkd"];

const BASE = [
  "(version 1)",
  "(deny default)",
  // Children keep the profile: everything it starts is held by it too.
  "(allow process-exec)",
  "(allow process-fork)",
  "(allow signal (target same-sandbox))",
  "(allow process-info* (target same-sandbox))",
  "(allow sysctl-read)",
  "(allow user-preference-read)",
  "(allow ipc-posix-shm)",
  "(allow ipc-posix-sem)",
  "(allow iokit-open (iokit-registry-entry-class \"RootDomainUserClient\"))",
  // Its own terminal and the ones it opens; never another terminal of yours.
  "(allow pseudo-tty)",
  '(allow file-read* file-write* file-ioctl (literal "/dev/ptmx") (literal "/dev/tty"))',
  '(allow file-read* file-write* file-ioctl (require-all (regex #"^/dev/ttys[0-9]+$") (extension "com.apple.sandbox.pty")))',
  '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))',
];

type Rule = { op: "read" | "write" | "rw" | "deny" | "denyWrite"; path: string };

/** The profile and the launch that bubblewrap's arguments describe. Throws on a bind macOS cannot make. */
export function seatbeltPlan(args: readonly string[], options: SeatbeltOptions): SeatbeltPlan {
  const real = options.real ?? realPath;
  const exists = options.exists ?? existsSync;
  const rules: Rule[] = [];
  const sockets: string[] = [...(options.sockets ?? [])];
  let readAll = false;
  let network: SeatbeltNetwork = "full";
  let env: Record<string, string> | null = null;
  let cwd: string | null = null;
  let command: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = () => {
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--": {
        command = args.slice(i + 1);
        i = args.length;
        break;
      }
      case "--ro-bind":
      case "--ro-bind-try": {
        const from = next();
        const to = next();
        if (arg === "--ro-bind-try" && !exists(from)) break;
        if (from === "/" && to === "/") readAll = true;
        else if (from === "/dev/null") rules.push({ op: "deny", path: to });
        else if (to === INSIDE_RUN) {
          rules.push({ op: "read", path: from });
          sockets.push(from);
        } else if (from === to) rules.push({ op: "read", path: to }, { op: "denyWrite", path: to });
        else if (to.startsWith("/etc/")) throw new Error(`macOS cannot show ${from} at ${to}`);
        // An empty folder over a name that is not there yet: the name cannot be made.
        else rules.push({ op: "denyWrite", path: to });
        break;
      }
      case "--bind": {
        const from = next();
        const to = next();
        if (from !== to) throw new Error(`macOS cannot show ${from} at ${to}`);
        rules.push({ op: "rw", path: to });
        break;
      }
      case "--tmpfs": {
        const path = next();
        // A private /etc (a Codex Worker's) cannot be made here.
        if (path === "/etc") throw new Error("macOS cannot give a sandbox its own /etc");
        if (path === "/tmp") for (const temp of privateTemps(options.userTmp ?? tmpdir())) rules.push({ op: "deny", path: temp });
        else if (exists(path)) rules.push({ op: "deny", path });
        break;
      }
      case "--overlay-src": {
        rules.push({ op: "read", path: next() });
        break;
      }
      case "--tmp-overlay":
      case "--dir":
      case "--dev":
      case "--proc":
      case "--cap-drop":
        next();
        break;
      case "--unshare-all":
      case "--unshare-net":
        network = "none";
        break;
      case "--share-net":
        network = "full";
        break;
      case "--clearenv":
        env = {};
        break;
      case "--setenv": {
        const key = next();
        const value = next();
        env = { ...(env ?? {}), [key]: value };
        break;
      }
      case "--chdir":
        cwd = next();
        break;
      default:
        // The namespaces, the hardening and --die-with-parent: Linux's own.
        if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    }
  }
  if (!readAll) throw new Error("the arguments do not start from the system read-only");
  if (command.length === 0) throw new Error("no command");
  const tmp = real(options.tmp);
  if (env) env.TMPDIR = tmp;
  const net = options.network ?? network;

  const path = (p: string) => `(subpath ${sbString(real(p))})`;
  const lines = [...BASE, `(allow mach-lookup ${MACH_SERVICES.map((name) => `(global-name ${sbString(name)})`).join(" ")})`, "(allow file-read*)"];
  for (const rule of rules) {
    if (rule.op === "read") lines.push(`(allow file-read* ${path(rule.path)})`);
    else if (rule.op === "rw") lines.push(`(allow file-read* file-write* ${path(rule.path)})`);
    else if (rule.op === "deny") lines.push(`(deny file-read* file-write* ${path(rule.path)})`);
    else lines.push(`(deny file-write* ${path(rule.path)})`);
  }
  lines.push(`(allow file-read* file-write* ${path(tmp)})`);
  // Names and sizes, never contents: realpath and stat walk through folders the rules above hide.
  lines.push("(allow file-read-metadata)");
  if (net === "full") {
    lines.push("(allow network*)", "(allow system-socket)", `(allow mach-lookup ${DNS_SERVICES.map((name) => `(global-name ${sbString(name)})`).join(" ")})`);
  } else {
    lines.push("(allow system-socket)");
    // A dev server or a test's own server may listen on loopback; it reaches only the bridge.
    lines.push('(allow network-bind network-inbound (local ip "localhost:*"))');
    if (options.bridge) lines.push(`(allow network-outbound (remote ip "localhost:${options.bridge}"))`);
    for (const dir of sockets) lines.push(`(allow network-outbound ${path(dir)})`);
    if (net === "web") {
      lines.push(
        '(allow network-outbound (remote ip "localhost:*") (remote ip "*:443"))',
        '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
        `(allow mach-lookup ${DNS_SERVICES.map((name) => `(global-name ${sbString(name)})`).join(" ")})`,
      );
    }
  }
  return { profile: `${lines.join("\n")}\n`, env, tmp, cwd, command };
}

/**
 * The argv that runs a plan: sandbox-exec, the environment (cleared when the
 * plan clears it), then a shell that moves to its folder and becomes the
 * command. `keep` names variables taken from the shell that starts it (the
 * tmux pane's TMUX and TMUX_PANE), which only exist once the pane does.
 */
export function seatbeltArgv(plan: SeatbeltPlan, keep: readonly string[] = []): string[] {
  const enter = plan.cwd ? ["/bin/sh", "-c", 'cd "$1" || exit 1; shift; exec "$@"', "cobra-sandbox", plan.cwd] : [];
  if (!plan.env) return [SANDBOX_EXEC, "-p", plan.profile, "/usr/bin/env", `TMPDIR=${plan.tmp}`, ...enter, ...plan.command];
  const pairs = Object.entries(plan.env).map(([key, value]) => `${key}=${value}`);
  if (keep.length === 0) return [SANDBOX_EXEC, "-p", plan.profile, "/usr/bin/env", "-i", ...pairs, ...enter, ...plan.command];
  // The outer shell is outside the sandbox only long enough to read the pane's variables.
  const kept = keep.map((name) => `${name}="\${${name}:-}"`).join(" ");
  const line = `p=$1; shift; exec ${SANDBOX_EXEC} -p "$p" /usr/bin/env -i ${kept} "$@"`;
  return ["/bin/sh", "-c", line, "cobra-sandbox", plan.profile, ...pairs, ...enter, ...plan.command];
}

/** Whether sandbox-exec starts a profile shaped like a Worker's here. */
export function probeSeatbelt(run: typeof spawnSync = spawnSync): boolean {
  try {
    const plan = seatbeltPlan(["--ro-bind", "/", "/", "--tmpfs", "/tmp", "--unshare-all", "--clearenv", "--", "/usr/bin/true"], { tmp: "/private/var/empty" });
    const probe = run(SANDBOX_EXEC, seatbeltArgv(plan).slice(1), { timeout: 10_000 });
    return probe.status === 0;
  } catch {
    return false;
  }
}
