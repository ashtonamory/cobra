import { createHash } from "node:crypto";
import { accessSync, constants, createReadStream, createWriteStream, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { crc32, createInflateRaw } from "node:zlib";

import type { Fetch } from "./mcp.ts";
import { DATA_DIR } from "./paths.ts";

/**
 * The browser that prints Cobra's PDFs: Chrome for Testing's
 * chrome-headless-shell, which the agent downloads itself on the first render
 * into its share folder, so a computer with no browser installed still prints
 * pay stubs, and the page is always printed by the same build. The system
 * browser is never looked for.
 *
 * One version, and the size and SHA-256 of each platform's zip, written here
 * in the agent's own code. Google publishes no hashes for these downloads, so
 * these were taken from Google's own zips when the version was chosen; an
 * install refuses a download that does not match them before anything in it
 * is unpacked, so a changed file, a swapped asset or a man in the middle never
 * gets installed. Moving to a newer browser is a new agent release with new
 * lines (the current Stable is in
 * https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json).
 */
export const HEADLESS_SHELL = {
  version: "156.0.8078.47",
  /** By `<process.platform>-<process.arch>`; `name` is Chrome for Testing's name for the platform. */
  platforms: {
    "linux-x64": { name: "linux64", bytes: 125_799_226, sha256: "0d5acc62c3e213f8c87d3c298d66ffcf9a236d12ea4b9f85318bf85dbc279daa" },
    "darwin-arm64": { name: "mac-arm64", bytes: 103_927_850, sha256: "2fd1c09a3e1ebde9e69e6aba92f1dd3f21ad247b55d9bf66e39213ff4205436d" },
    "darwin-x64": { name: "mac-x64", bytes: 109_256_749, sha256: "5e230044c6ac989597f4a4e301a0a710d257e07d6f7754754da2bf62ea3d272c" },
    "win32-x64": { name: "win64", bytes: 126_051_683, sha256: "e0af9b23f8051cca4f37ca49cd425e8055701bfc0383c198d67f8d5cc5884249" },
  } as Record<string, { name: string; bytes: number; sha256: string } | undefined>,
};

export type HeadlessShellRelease = typeof HEADLESS_SHELL;

const DOWNLOADS = "https://storage.googleapis.com/chrome-for-testing-public";

/** Where the browser lives: `<this>/<version>/chrome-headless-shell`, beside the agent's builds (the installer prunes only numbered build folders). */
export const BROWSERS_DIR = join(DATA_DIR, "browsers", "chrome-headless-shell");

/** The download's deadline. The first render waits for it; its own 60 s print deadline starts after. */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** A work folder older than this was left by an agent that stopped mid-install, and is removed. */
const STALE_WORK_MS = 60 * 60_000;

export type BrowserDeps = {
  fetch: Fetch;
  /** `process.platform` and `process.arch`. */
  platform: string;
  arch: string;
  /** The folder of versions, BROWSERS_DIR unless a test gives its own. */
  dir: string;
  release: HeadlessShellRelease;
  now: () => Date;
  log: (line: string) => void;
  timeoutMs: number;
};

const browserDeps: BrowserDeps = {
  fetch: (url, init) => fetch(url, { ...init, redirect: "follow" }),
  platform: process.platform,
  arch: process.arch,
  dir: BROWSERS_DIR,
  release: HEADLESS_SHELL,
  now: () => new Date(),
  log: (line) => console.log(line),
  timeoutMs: DOWNLOAD_TIMEOUT_MS,
};

type Target = { key: string; name: string; bytes: number; sha256: string; folder: string; executable: string };

/** This computer's zip, install folder and program, or why there is none. */
function target(d: BrowserDeps): Target | { why: string } {
  const key = `${d.platform}-${d.arch}`;
  const zip = d.release.platforms[key];
  if (!zip) {
    return {
      why: `Cobra has no browser to print PDFs with on this computer (${key}): it downloads one for Linux x64, macOS (Apple silicon or Intel) and Windows x64 only. Set COBRA_CHROMIUM to a Chromium on this computer to print here.`,
    };
  }
  const folder = join(d.dir, d.release.version);
  const program = d.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  return { key, ...zip, folder, executable: join(folder, program) };
}

function isProgram(path: string, platform: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** A download this file refused on purpose: its words are passed on as they are. */
class Refused extends Error {}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

// --- what is going on -------------------------------------------------------------

type Run = {
  promise: Promise<string> | null;
  progress: { receivedBytes: number; totalBytes: number; startedAt: string } | null;
  lastError: { message: string; at: string } | null;
};

/** One run per install folder, so concurrent renders share one download. */
const runs = new Map<string, Run>();

function runFor(folder: string): Run {
  let run = runs.get(folder);
  if (!run) {
    run = { promise: null, progress: null, lastError: null };
    runs.set(folder, run);
  }
  return run;
}

export type BrowserStatus = {
  version: string;
  /** Chrome for Testing's platform name, or null when there is no browser for this computer. */
  platform: string | null;
  /** The program, when this version is installed. */
  installed: { path: string } | null;
  downloading: { receivedBytes: number; totalBytes: number; startedAt: string } | null;
  /** Why the last install failed; cleared by the next one that works. */
  lastError: { message: string; at: string } | null;
};

/** What the browser is doing, for a CLI line or a route. Never downloads. */
export function browserStatus(deps: Partial<BrowserDeps> = {}): BrowserStatus {
  const d = { ...browserDeps, ...deps };
  const t = target(d);
  if ("why" in t) return { version: d.release.version, platform: null, installed: null, downloading: null, lastError: { message: t.why, at: d.now().toISOString() } };
  const run = runs.get(t.folder);
  return {
    version: d.release.version,
    platform: t.name,
    installed: isProgram(t.executable, d.platform) ? { path: t.executable } : null,
    downloading: run?.promise && run.progress ? { ...run.progress } : null,
    lastError: run?.lastError ? { ...run.lastError } : null,
  };
}

// --- ensureBrowser ----------------------------------------------------------------

/**
 * The program that prints, downloading and installing it first when this
 * version is not installed yet. Concurrent callers share one download. Throws
 * with words to show when anything fails; a failed or refused download leaves
 * nothing behind but the older version, if any.
 */
export async function ensureBrowser(deps: Partial<BrowserDeps> = {}): Promise<string> {
  const d = { ...browserDeps, ...deps };
  const t = target(d);
  if ("why" in t) throw new Error(t.why);
  const run = runFor(t.folder);
  if (run.promise) return run.promise;
  // Nothing below awaits before run.promise is set, so a second caller always finds it.
  if (isProgram(t.executable, d.platform)) return t.executable;
  run.progress = { receivedBytes: 0, totalBytes: t.bytes, startedAt: d.now().toISOString() };
  run.promise = (async () => {
    try {
      const path = await install(d, t, run);
      run.lastError = null;
      return path;
    } catch (caught) {
      run.lastError = { message: message(caught), at: d.now().toISOString() };
      d.log(`[cobra-agent] browser: installing chrome-headless-shell ${d.release.version} failed: ${run.lastError.message}`);
      throw caught;
    } finally {
      run.promise = null;
      run.progress = null;
    }
  })();
  return run.promise;
}

async function install(d: BrowserDeps, t: Target, run: Run): Promise<string> {
  const { version } = d.release;
  // The work folder sits beside the final one, so the last step is a rename on one filesystem.
  await mkdir(d.dir, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(d.dir, ".install-"));
  const started = d.now();
  try {
    const zipPath = join(work, "download.zip");
    d.log(`[cobra-agent] browser: downloading chrome-headless-shell ${version} for ${t.name} (${megabytes(t.bytes)})`);
    const sha256 = await download(d, `${DOWNLOADS}/${version}/${t.name}/chrome-headless-shell-${t.name}.zip`, zipPath, t.bytes, (received) => {
      if (run.progress) run.progress.receivedBytes = received;
    });
    if (sha256 !== t.sha256) {
      throw new Error(`the chrome-headless-shell ${version} download is not the one this agent expects (its SHA-256 differs), so it was not installed`);
    }
    const out = join(work, "out");
    await mkdir(out);
    try {
      await unzip(zipPath, out);
    } catch (caught) {
      throw new Error(`the chrome-headless-shell ${version} zip could not be unpacked: ${message(caught)}`);
    }
    await rm(zipPath, { force: true });
    // Every file is under one folder named for the platform; that folder becomes the version's.
    const unpacked = join(out, `chrome-headless-shell-${t.name}`);
    const program = join(unpacked, relative(t.folder, t.executable));
    if (!(await stat(program).then((info) => info.isFile(), () => false))) throw new Error("the chrome-headless-shell zip did not hold the program");
    if (d.platform !== "win32") await chmod(program, 0o755);
    // A folder left by an install that was cut short, without its program, is replaced.
    await rm(t.folder, { recursive: true, force: true });
    // Into place by rename, so a render never sees half a browser.
    await rename(unpacked, t.folder);
    await removeOthers(d, version, work);
    const seconds = Math.round((d.now().getTime() - started.getTime()) / 1000);
    d.log(`[cobra-agent] browser: chrome-headless-shell ${version} installed at ${t.executable} (${seconds} s)`);
    return t.executable;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Older versions, and work folders an agent left when it stopped mid-install an hour or more ago. */
async function removeOthers(d: BrowserDeps, version: string, work: string): Promise<void> {
  const entries = await readdir(d.dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === version) continue;
    const path = join(d.dir, entry.name);
    if (path === work) continue;
    if (entry.name.startsWith(".install-")) {
      const info = await stat(path).catch(() => null);
      if (!info || d.now().getTime() - info.mtimeMs < STALE_WORK_MS) continue;
    } else if (entry.name.startsWith(".")) {
      continue;
    }
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    d.log(`[cobra-agent] browser: removed ${entry.name.startsWith(".") ? "an unfinished install" : `chrome-headless-shell ${entry.name}`}`);
  }
}

/**
 * Downloads `url` to `path` (a new file) and returns its SHA-256, refusing
 * anything but exactly `bytes` long. Logs at each quarter. Under the
 * download deadline, which a stalled connection also runs into.
 */
async function download(d: BrowserDeps, url: string, path: string, bytes: number, onProgress: (received: number) => void): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), d.timeoutMs);
  const minutes = Math.round(d.timeoutMs / 60_000);
  const within = minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(d.timeoutMs / 1000)} s`;
  let received = 0;
  const late = () => new Refused(`the chrome-headless-shell download did not finish within ${within} (${megabytes(received)} of ${megabytes(bytes)} arrived), so it was not installed`);
  try {
    let response: Response;
    try {
      response = await d.fetch(url, { signal: controller.signal, headers: { "User-Agent": "cobra-agent" } });
    } catch (caught) {
      if (controller.signal.aborted) throw late();
      throw new Error(`could not reach Google's download server for chrome-headless-shell: ${message(caught)}`);
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Google's download server answered ${response.status} for chrome-headless-shell ${d.release.version}`);
    }
    const announced = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(announced) && announced !== bytes) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`the chrome-headless-shell download is ${megabytes(announced)}, not the ${megabytes(bytes)} this agent expects, so it was not installed`);
    }
    const hash = createHash("sha256");
    const file = await open(path, "wx", 0o600);
    let quarter = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (controller.signal.aborted) throw late();
        received += chunk.byteLength;
        if (received > bytes) throw new Refused(`the chrome-headless-shell download is larger than the ${megabytes(bytes)} this agent expects, so it was not installed`);
        hash.update(chunk);
        await file.write(chunk);
        onProgress(received);
        const reached = Math.floor((received / bytes) * 4);
        if (reached > quarter && reached < 4) {
          quarter = reached;
          d.log(`[cobra-agent] browser: ${reached * 25}% of ${megabytes(bytes)}`);
        }
      }
    } catch (caught) {
      if (caught instanceof Refused) throw caught;
      if (controller.signal.aborted) throw late();
      throw new Error(`the chrome-headless-shell download broke off after ${megabytes(received)}: ${message(caught)}`);
    } finally {
      await file.close();
    }
    if (received !== bytes) throw new Error(`the chrome-headless-shell download stopped at ${megabytes(received)} of ${megabytes(bytes)}, so it was not installed`);
    return hash.digest("hex");
  } finally {
    clearTimeout(timer);
  }
}

// --- unzip --------------------------------------------------------------------------

/** More files or bytes than any browser zip holds: Chrome for Testing's have about 300 files and 300 MB. */
const MAX_ENTRIES = 10_000;
const MAX_UNPACKED = 2 * 1024 * 1024 * 1024;

type Entry = { name: string; method: number; crc: number; packed: number; size: number; mode: number; offset: number };

/** Why an entry's name may not be written: absolute, `..`, a backslash or a drive letter. Null when it is fine. */
export function entryNameWhy(name: string): string | null {
  if (!name || name.includes("\0")) return "an entry with no usable name";
  if (name.includes("\\")) return `an entry named with a backslash (${name})`;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || isAbsolute(name)) return `an entry with an absolute path (${name})`;
  if (name.split("/").includes("..")) return `an entry that climbs out with .. (${name})`;
  return null;
}

/** The central directory's entries, read from its end record. Zip64 is refused: no browser zip needs it. */
async function readEntries(zipPath: string): Promise<Entry[]> {
  const file = await open(zipPath, "r");
  try {
    const { size } = await file.stat();
    // The end record is 22 bytes plus a comment of at most 65,535.
    const tailLength = Math.min(size, 22 + 65_535);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, size - tailLength);
    let end = -1;
    for (let at = tailLength - 22; at >= 0; at--) {
      if (tail.readUInt32LE(at) === 0x06054b50) {
        end = at;
        break;
      }
    }
    if (end < 0) throw new Error("it is not a zip (no end record)");
    if (end >= 20 && tail.readUInt32LE(end - 20) === 0x07064b50) throw new Error("it is a zip64 archive, which Cobra does not unpack");
    const disk = tail.readUInt16LE(end + 4);
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error("it is a zip64 archive, which Cobra does not unpack");
    if (disk !== 0) throw new Error("it is split across several files");
    if (count > MAX_ENTRIES) throw new Error(`it holds ${count} files, more than a browser has`);
    if (directoryOffset + directorySize > size) throw new Error("its directory runs past the end of the file");
    const directory = Buffer.alloc(directorySize);
    await file.read(directory, 0, directorySize, directoryOffset);
    const entries: Entry[] = [];
    let at = 0;
    let total = 0;
    for (let index = 0; index < count; index++) {
      if (at + 46 > directorySize || directory.readUInt32LE(at) !== 0x02014b50) throw new Error("its directory is damaged");
      const madeBy = directory.readUInt16LE(at + 4);
      const flags = directory.readUInt16LE(at + 8);
      const method = directory.readUInt16LE(at + 10);
      const crc = directory.readUInt32LE(at + 16);
      const packed = directory.readUInt32LE(at + 20);
      const unpacked = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const external = directory.readUInt32LE(at + 38);
      const offset = directory.readUInt32LE(at + 42);
      if (at + 46 + nameLength > directorySize) throw new Error("its directory is damaged");
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;
      if (packed === 0xffffffff || unpacked === 0xffffffff || offset === 0xffffffff) throw new Error("it is a zip64 archive, which Cobra does not unpack");
      if (flags & 1) throw new Error(`it holds an encrypted entry (${name})`);
      const why = entryNameWhy(name);
      if (why) throw new Error(`it holds ${why}`);
      // Unix permission bits, when a Unix zip wrote them (the upper half of the external attributes).
      const mode = madeBy >> 8 === 3 ? external >>> 16 : 0;
      if ((mode & 0o170000) === 0o120000) throw new Error(`it holds a link (${name})`);
      if (!name.endsWith("/") && method !== 0 && method !== 8) throw new Error(`it holds an entry packed a way Cobra does not unpack (${name}, method ${method})`);
      total += unpacked;
      if (total > MAX_UNPACKED) throw new Error("it unpacks to more than a browser takes");
      entries.push({ name, method, crc, packed, size: unpacked, mode, offset });
    }
    return entries;
  } finally {
    await file.close();
  }
}

/**
 * Unpacks a zip into `outDir` (an empty folder) with node alone, since Windows
 * and a minimal Linux may have no unzip. Stored and deflated entries only;
 * nothing absolute, no `..`, no links, and a name written twice is refused.
 * Each file's executable bits come from the zip's Unix permissions (never
 * set-id or writable by others), and its size and CRC-32 must match the
 * directory's.
 */
export async function unzip(zipPath: string, outDir: string): Promise<void> {
  const entries = await readEntries(zipPath);
  const header = Buffer.alloc(30);
  for (const entry of entries) {
    const dest = join(outDir, ...entry.name.split("/").filter((part) => part && part !== "."));
    const inside = relative(outDir, dest);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
      if (entry.name.endsWith("/")) continue;
      throw new Error(`it holds an entry outside its folder (${entry.name})`);
    }
    if (entry.name.endsWith("/")) {
      await mkdir(dest, { recursive: true, mode: 0o755 });
      continue;
    }
    await mkdir(join(dest, ".."), { recursive: true, mode: 0o755 });
    const file = await open(zipPath, "r");
    let start: number;
    try {
      await file.read(header, 0, 30, entry.offset);
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`its entry ${entry.name} is damaged`);
      start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    } finally {
      await file.close();
    }
    const perm = entry.mode & 0o111 ? 0o755 : 0o644;
    let size = 0;
    let crc = 0;
    async function* count(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
      for await (const chunk of chunks) {
        size += chunk.byteLength;
        if (size > entry.size) throw new Error(`its entry ${entry.name} unpacks larger than it says`);
        crc = crc32(chunk, crc);
        yield chunk;
      }
    }
    const output = createWriteStream(dest, { flags: "wx", mode: perm });
    try {
      if (entry.packed === 0) {
        await pipeline(async function* () {}, output);
      } else {
        const input = createReadStream(zipPath, { start, end: start + entry.packed - 1 });
        await (entry.method === 8 ? pipeline(input, createInflateRaw(), count, output) : pipeline(input, count, output));
      }
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`it holds ${entry.name} twice`);
      throw caught;
    }
    if (size !== entry.size) throw new Error(`its entry ${entry.name} is ${size} bytes, not the ${entry.size} it says`);
    if (crc !== entry.crc) throw new Error(`its entry ${entry.name} is damaged (its CRC-32 differs)`);
    await chmod(dest, perm);
  }
}
