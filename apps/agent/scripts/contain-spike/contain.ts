// Contain spike: run a command (an agent harness) inside a Cobra sandbox.
//
//   node contain.ts --worktree <dir> --config <dir> --proxy <socket>
//                   [--expose <dir>]... [--protect <file>]... [--model-route anthropic|ollama] -- <command...>
//
// Unlike Claude Code's sandbox, this holds the whole process, harness
// included, so it holds any harness:
//
//   - the system read-only, a private /tmp and /run, no network at all
//     (a network namespace of its own: abstract sockets are out of reach too);
//   - home is an empty tmpfs: nothing in it is visible unless it is exposed,
//     read-only (toolchains), or the worktree and the harness's own config
//     folder, which are the only writable places;
//   - the one way out is the proxy's Unix socket, bound in at
//     /run/cobra/proxy.sock and turned into 127.0.0.1:<port> by a bridge
//     inside, so HTTPS_PROXY and ANTHROPIC_BASE_URL work as usual;
//   - a cleared environment: no display, bus, key agent or tokens leak in.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { PLACEHOLDER } from "./proxy.ts";

export const BRIDGE_PORT = 8899;
export const INSIDE_SOCKET = "/run/cobra/proxy.sock";

export type ContainOptions = {
  worktree: string;
  /** The harness's own config folder (CLAUDE_CONFIG_DIR): writable, never the user's own ~/.claude. */
  config: string;
  proxySocket: string;
  /** Read-only folders under home the harness needs (its binary, node, browsers). */
  expose: readonly string[];
  /** Files inside a writable bind that must stay read-only (the harness's own settings). */
  protect?: readonly string[];
  modelRoute: "anthropic" | "ollama";
  /** For a local model: the model every slot uses. */
  localModel?: string;
  home?: string;
  path?: string;
  term?: string;
};

export function containEnv(options: ContainOptions): Record<string, string> {
  const home = options.home ?? homedir();
  const proxy = `http://127.0.0.1:${BRIDGE_PORT}`;
  const env: Record<string, string> = {
    HOME: home,
    PATH: options.path ?? "/usr/local/bin:/usr/bin:/bin",
    TERM: options.term ?? "xterm-256color",
    LANG: "C.UTF-8",
    CLAUDE_CONFIG_DIR: options.config,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  if (options.modelRoute === "anthropic") {
    env.ANTHROPIC_BASE_URL = `${proxy}/anthropic`;
    env.CLAUDE_CODE_OAUTH_TOKEN = PLACEHOLDER;
  } else {
    env.ANTHROPIC_BASE_URL = `${proxy}/ollama`;
    env.ANTHROPIC_AUTH_TOKEN = "ollama";
    env.ANTHROPIC_API_KEY = "";
    if (options.localModel) {
      for (const slot of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
        env[slot] = options.localModel;
      }
    }
  }
  return env;
}

export function containArgs(options: ContainOptions, command: readonly string[]): string[] {
  const home = options.home ?? homedir();
  const env = containEnv(options);
  const bridge = `socat TCP-LISTEN:${BRIDGE_PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${INSIDE_SOCKET} & `;
  return [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    "--tmpfs", home,
    "--unshare-all",
    "--die-with-parent",
    ...options.expose.flatMap((path) => ["--ro-bind", path, path]),
    "--bind", options.worktree, options.worktree,
    "--bind", options.config, options.config,
    ...(options.protect ?? []).flatMap((path) => ["--ro-bind", path, path]),
    "--dir", dirname(INSIDE_SOCKET),
    "--bind", options.proxySocket, INSIDE_SOCKET,
    "--clearenv",
    ...Object.entries(env).flatMap(([key, value]) => ["--setenv", key, value]),
    "--chdir", options.worktree,
    "--",
    "sh", "-c", `${bridge}sleep 0.2; exec "$@"`, "contain",
    ...command,
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const split = argv.indexOf("--");
  const flags = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  const one = (name: string): string | undefined => {
    const at = flags.indexOf(name);
    return at === -1 ? undefined : flags[at + 1];
  };
  const many = (name: string): string[] => flags.flatMap((flag, at) => (flag === name && flags[at + 1] ? [flags[at + 1] as string] : []));
  const worktree = one("--worktree");
  const config = one("--config");
  const proxySocket = one("--proxy");
  if (!worktree || !config || !proxySocket || command.length === 0) {
    console.error("usage: node contain.ts --worktree <dir> --config <dir> --proxy <socket> [--expose <dir>]... [--protect <file>]... [--model-route anthropic|ollama] [--local-model m] [--path PATH] -- <command...>");
    process.exit(2);
  }
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const expose = many("--expose").map((path) => resolve(path)).filter((path) => existsSync(path));
  const route = one("--model-route") === "ollama" ? "ollama" : "anthropic";
  const localModel = one("--local-model");
  const path = one("--path");
  const args = containArgs(
    {
      worktree: resolve(worktree),
      config: resolve(config),
      proxySocket: resolve(proxySocket),
      expose,
      protect: many("--protect").map((path) => resolve(path)).filter((path) => existsSync(path)),
      modelRoute: route,
      ...(localModel ? { localModel } : {}),
      ...(path ? { path } : {}),
      ...(process.env.TERM ? { term: process.env.TERM } : {}),
    },
    command,
  );
  const child = spawn("bwrap", args, { stdio: "inherit" });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
}
