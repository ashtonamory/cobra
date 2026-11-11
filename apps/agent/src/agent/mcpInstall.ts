import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { McpPin } from "@cobra/contracts";

import { download, GITHUB, GITHUB_MCP_BIN, GITHUB_MCP_RELEASES, MCP_REGISTRY, pinWhy, readRegistry, setGithubPin, sha256File, type Fetch } from "./mcp.ts";
import { DATA_DIR } from "./paths.ts";
import { publicFetch } from "./publicFetch.ts";

const run = promisify(execFile);

/**
 * The github-mcp-server this agent installs itself, so a person who just downloaded Cobra never runs mise or reads
 * a SHA-256.
 *
 * One version, and the SHA-256 of each platform's archive as GitHub's
 * `github-mcp-server_<version>_checksums.txt` lists them, written here in the
 * agent's own code. An install downloads the archive from GitHub's release
 * page and refuses it unless it hashes to this value, so a changed release, a
 * swapped asset or a man in the middle never gets installed. Checking against
 * a checksums file downloaded from the same place (`verifyGithubMcp`) would not
 * catch that. Moving to a newer server is a new agent release with new lines.
 */
export const GITHUB_MCP_RELEASE = {
  version: "2.0.2",
  archives: {
    "linux-x64": { name: "github-mcp-server_Linux_x86_64.tar.gz", sha256: "815e27d931c796af0c97f24fd211e14f8a4607d4528377719a5ad2352086b0b0" },
    "linux-arm64": { name: "github-mcp-server_Linux_arm64.tar.gz", sha256: "73f5e76c6a3b5e0d731e1134a7c38575df6ec96c646192095a3be2d4d0d6c1fc" },
    "darwin-x64": { name: "github-mcp-server_Darwin_x86_64.tar.gz", sha256: "7ac4d549e0bf37ad9efee7be7913cae4ad50cea8d9d5be1afa9a6dbcee9d1f2c" },
    "darwin-arm64": { name: "github-mcp-server_Darwin_arm64.tar.gz", sha256: "5d9b38511bffc84d2272eb6189129eb721c8900e45784d8ea7eaf25f8d3dd835" },
  } as Record<string, { name: string; sha256: string } | undefined>,
};

/** Where managed binaries live: `<this>/<version>/github-mcp-server`, beside the agent's builds (the installer prunes only numbered build folders). */
export const MANAGED_DIR = join(DATA_DIR, "mcp", GITHUB_MCP_BIN);

/** The largest archive an install downloads; v2.0.2's Linux archive is about 9 MB. */
const MAX_ARCHIVE = 100 * 1024 * 1024;

export type InstallDeps = {
  fetch: Fetch;
  /** `<platform>-<arch>`, a key of GITHUB_MCP_RELEASE.archives. */
  platform: string;
  dir: string;
  release: typeof GITHUB_MCP_RELEASE;
  /** Runs tar with only PATH; a test passes its own. */
  tar: (args: string[]) => Promise<void>;
  now: () => Date;
};

const installDeps: InstallDeps = {
  // GitHub's release download redirects to its asset host: each hop checked public and pinned (publicFetch.ts).
  fetch: (url, init) => publicFetch(url, init),
  platform: `${process.platform}-${process.arch}`,
  dir: MANAGED_DIR,
  release: GITHUB_MCP_RELEASE,
  tar: async (args) => {
    await run("tar", args, { env: { PATH: "/usr/bin:/bin" }, timeout: 60_000 });
  },
  now: () => new Date(),
};

/** Whether this computer has an archive in the agent's release lines. */
export function canInstall(deps: Partial<InstallDeps> = {}): boolean {
  const d = { ...installDeps, ...deps };
  return d.release.archives[d.platform] !== undefined;
}

/**
 * Downloads, checks and unpacks the release's github-mcp-server, and returns
 * the pin to keep (`managed: true`). Throws with words to show when anything
 * fails; nothing half-written is left at the final path. Writes no registry:
 * the caller pins it.
 */
export async function installGithubMcp(deps: Partial<InstallDeps> = {}): Promise<McpPin> {
  const d = { ...installDeps, ...deps };
  const { version } = d.release;
  const archive = d.release.archives[d.platform];
  if (!archive) throw new Error(`github-mcp-server has no build for this computer (${d.platform})`);
  // The work folder sits beside the final one, so the last step is a rename on one filesystem.
  await mkdir(d.dir, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(d.dir, ".install-"));
  try {
    const archivePath = join(work, "archive.tar.gz");
    let fetched: boolean;
    try {
      fetched = await download(d, `${GITHUB_MCP_RELEASES}/v${version}/${archive.name}`, archivePath, MAX_ARCHIVE, 180_000);
    } catch {
      fetched = false;
    }
    if (!fetched) throw new Error("could not download github-mcp-server from GitHub");
    if ((await sha256File(archivePath)) !== archive.sha256) {
      throw new Error(`the github-mcp-server ${version} download is not the one this agent expects, so it was not installed`);
    }
    // The one member, into a folder of its own: nothing else in the archive is written.
    const out = join(work, "out");
    await mkdir(out);
    await d.tar(["-xzf", archivePath, "-C", out, "--no-same-owner", GITHUB_MCP_BIN]);
    const unpacked = join(out, GITHUB_MCP_BIN);
    if (!(await lstat(unpacked)).isFile()) throw new Error("the github-mcp-server archive did not hold the program");
    await chmod(unpacked, 0o755);
    const sha256 = await sha256File(unpacked);
    // Into place by rename, so a launch never sees half a file.
    const folder = join(d.dir, version);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    // A pin is a real path: pinWhy refuses one that resolves anywhere else.
    const path = join(await realpath(folder), GITHUB_MCP_BIN);
    await rename(unpacked, path);
    return { path, sha256, version, release: `v${version}`, verifiedAt: d.now().toISOString(), managed: true };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Whether Connect should install: no pin yet, or a managed pin that is missing,
 * changed, or older than the release this agent names. A binary you verified
 * yourself is never replaced.
 */
export async function needsInstall(pin: McpPin | undefined, release = GITHUB_MCP_RELEASE): Promise<boolean> {
  if (!pin) return true;
  if (!pin.managed) return false;
  return pin.version !== release.version || (await pinWhy(pin)) !== null;
}

export type InstallView = { state: "idle" } | { state: "running" } | { state: "failed"; why: string };

export type InstallRunner = {
  view: () => InstallView;
  /** Starts an install unless one is running. Returns at once; view() follows it. */
  ensure: () => void;
  /** Resolves when the running install (if any) ends. For tests and the route that waits a moment. */
  settled: () => Promise<void>;
};

/** One install at a time, pinned when it succeeds unless a binary you verified yourself was pinned meanwhile. */
export function installRunner(install: () => Promise<McpPin> = () => installGithubMcp(), registryPath = MCP_REGISTRY, log: (line: string) => void = (line) => console.log(line)): InstallRunner {
  let view: InstallView = { state: "idle" };
  let running: Promise<void> | null = null;
  return {
    view: () => view,
    ensure: () => {
      if (running) return;
      view = { state: "running" };
      running = (async () => {
        try {
          const pin = await install();
          const current = readRegistry(registryPath).entries.find((entry) => entry.name === GITHUB)?.pin;
          if (current && !current.managed && (await pinWhy(current)) === null) {
            log(`[cobra-agent] github-mcp-server ${pin.version} installed but not pinned: you pinned your own`);
          } else {
            setGithubPin(pin, registryPath);
            log(`[cobra-agent] github-mcp-server ${pin.version} installed at ${pin.path}`);
          }
          view = { state: "idle" };
        } catch (caught) {
          const why = caught instanceof Error ? caught.message : String(caught);
          view = { state: "failed", why: `Installing github-mcp-server failed: ${why}` };
          log(`[cobra-agent] ${view.why}`);
        } finally {
          running = null;
        }
      })();
    },
    settled: async () => {
      await running;
    },
  };
}
