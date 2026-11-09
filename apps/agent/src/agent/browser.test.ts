import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import { browserStatus, ensureBrowser, entryNameWhy, HEADLESS_SHELL, unzip, type BrowserDeps, type HeadlessShellRelease } from "./browser.ts";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

type ZipEntry = { name: string; data?: string; method?: 0 | 8; mode?: number };

/** A zip as Chrome for Testing writes one: a Unix zip with permission bits, stored and deflated entries. */
function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data ?? "", "utf8");
    const method = entry.method ?? 8;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((((entry.mode ?? 0o100644) & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const ROOT = "chrome-headless-shell-linux64";
const PROGRAM = "#!/bin/sh\necho headless\n";
const PAK = "resources ".repeat(500);

/** The browser's zip in small: the program stored and executable, a helper deflated and executable, data deflated. */
function browserZip(extra: ZipEntry[] = []): Buffer {
  return zip([
    { name: `${ROOT}/ABOUT`, data: "Chrome for Testing", method: 8 },
    { name: `${ROOT}/chrome-headless-shell`, data: PROGRAM, method: 0, mode: 0o100755 },
    { name: `${ROOT}/libEGL.so`, data: "elf ".repeat(100), method: 8, mode: 0o100755 },
    { name: `${ROOT}/locales/`, method: 0, mode: 0o040755 },
    { name: `${ROOT}/locales/en-US.pak`, data: PAK, method: 8, mode: 0o100644 },
    ...extra,
  ]);
}

function releaseFor(bytes: Buffer, over: Partial<{ sha256: string; bytes: number }> = {}): HeadlessShellRelease {
  return { version: "156.0.1.2", platforms: { "linux-x64": { name: "linux64", bytes: over.bytes ?? bytes.length, sha256: over.sha256 ?? sha(bytes) } } };
}

type Server = { urls: string[]; fetch: BrowserDeps["fetch"] };

/** A fetch that serves `bytes` in a few chunks, like a real body, honouring the abort signal. */
function serve(bytes: Buffer, over: { status?: number; length?: number; gate?: Promise<void>; stall?: boolean } = {}): Server {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url, init) => {
      urls.push(url);
      await over.gate;
      const step = Math.max(1, Math.ceil(bytes.length / 4));
      let at = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal.addEventListener("abort", () => controller.error(init.signal.reason));
        },
        pull(controller) {
          if (over.stall && at > 0) return new Promise<void>(() => undefined);
          if (at >= bytes.length) return controller.close();
          controller.enqueue(new Uint8Array(bytes.subarray(at, at + step)));
          at += step;
        },
      });
      return new Response(body, { status: over.status ?? 200, headers: { "content-length": String(over.length ?? bytes.length) } });
    },
  };
}

function world(server: Server, release: HeadlessShellRelease, over: Partial<BrowserDeps> = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), "cobra-browser-")), "browsers", "chrome-headless-shell");
  const lines: string[] = [];
  const deps: Partial<BrowserDeps> = { fetch: server.fetch, platform: "linux", arch: "x64", dir, release, now: () => new Date(2026, 9, 23, 10, 0, 0), log: (line) => lines.push(line), timeoutMs: 5_000, ...over };
  return { dir, deps, lines };
}

// --- the pinned release -----------------------------------------------------------------

test("the pinned release names Chrome for Testing's four platforms, each with a size and a SHA-256", () => {
  assert.match(HEADLESS_SHELL.version, /^\d+\.\d+\.\d+\.\d+$/);
  assert.deepEqual(
    Object.entries(HEADLESS_SHELL.platforms).map(([key, zip]) => [key, zip!.name]),
    [["linux-x64", "linux64"], ["darwin-arm64", "mac-arm64"], ["darwin-x64", "mac-x64"], ["win32-x64", "win64"]],
  );
  for (const zip of Object.values(HEADLESS_SHELL.platforms)) {
    assert.match(zip!.sha256, /^[0-9a-f]{64}$/);
    assert.ok(zip!.bytes > 50_000_000 && zip!.bytes < 300_000_000);
  }
});

// --- ensureBrowser ----------------------------------------------------------------------

test("a good zip installs, keeps the executable bits, removes older versions, and a second call does not download", async () => {
  const bytes = browserZip();
  const server = serve(bytes);
  const w = world(server, releaseFor(bytes));
  mkdirSync(join(w.dir, "155.0.0.1"), { recursive: true });
  writeFileSync(join(w.dir, "155.0.0.1", "chrome-headless-shell"), "old");
  mkdirSync(join(w.dir, ".install-other"));

  const path = await ensureBrowser(w.deps);
  assert.equal(path, join(w.dir, "156.0.1.2", "chrome-headless-shell"));
  assert.deepEqual(server.urls, ["https://storage.googleapis.com/chrome-for-testing-public/156.0.1.2/linux64/chrome-headless-shell-linux64.zip"]);
  assert.equal(readFileSync(path, "utf8"), PROGRAM);
  assert.equal(statSync(path).mode & 0o777, 0o755);
  assert.equal(statSync(join(w.dir, "156.0.1.2", "libEGL.so")).mode & 0o777, 0o755);
  assert.equal(statSync(join(w.dir, "156.0.1.2", "ABOUT")).mode & 0o777, 0o644);
  assert.equal(readFileSync(join(w.dir, "156.0.1.2", "locales", "en-US.pak"), "utf8"), PAK);
  // The older version goes; a work folder from another install that is not stale stays.
  assert.deepEqual(readdirSync(w.dir).sort(), [".install-other", "156.0.1.2"]);
  assert.ok(w.lines.some((line) => /^\[cobra-agent\] browser: downloading chrome-headless-shell 156\.0\.1\.2 for linux64 \(0 MB\)$/.test(line)));
  assert.ok(w.lines.some((line) => /browser: 50% of/.test(line)));
  assert.ok(w.lines.some((line) => /browser: chrome-headless-shell 156\.0\.1\.2 installed at .*chrome-headless-shell \(0 s\)$/.test(line)));
  assert.deepEqual(browserStatus(w.deps), { version: "156.0.1.2", platform: "linux64", installed: { path }, downloading: null, lastError: null });

  assert.equal(await ensureBrowser(w.deps), path);
  assert.equal(server.urls.length, 1);
});

test("a folder left without its program is replaced", async () => {
  const bytes = browserZip();
  const server = serve(bytes);
  const w = world(server, releaseFor(bytes));
  mkdirSync(join(w.dir, "156.0.1.2"), { recursive: true });
  writeFileSync(join(w.dir, "156.0.1.2", "ABOUT"), "half");
  const path = await ensureBrowser(w.deps);
  assert.equal(readFileSync(path, "utf8"), PROGRAM);
  assert.equal(readFileSync(join(w.dir, "156.0.1.2", "ABOUT"), "utf8"), "Chrome for Testing");
  assert.equal(server.urls.length, 1);
});

test("a checksum mismatch is refused and leaves nothing", async () => {
  const bytes = browserZip();
  const w = world(serve(bytes), releaseFor(bytes, { sha256: "0".repeat(64) }));
  await assert.rejects(ensureBrowser(w.deps), /^Error: the chrome-headless-shell 156\.0\.1\.2 download is not the one this agent expects \(its SHA-256 differs\), so it was not installed$/);
  assert.deepEqual(readdirSync(w.dir), []);
  const status = browserStatus(w.deps);
  assert.equal(status.installed, null);
  assert.match(status.lastError!.message, /SHA-256 differs/);
  assert.ok(w.lines.some((line) => /browser: installing chrome-headless-shell 156\.0\.1\.2 failed: .*SHA-256 differs/.test(line)));
});

test("a download of the wrong size, a refused one and a stalled one are refused and leave nothing", async () => {
  const bytes = browserZip();
  const announced = world(serve(bytes, { length: bytes.length + 10 }), releaseFor(bytes));
  await assert.rejects(ensureBrowser(announced.deps), /download is 0 MB, not the 0 MB this agent expects, so it was not installed/);
  assert.deepEqual(readdirSync(announced.dir), []);

  const longer = world(serve(Buffer.concat([bytes, Buffer.from("more")]), { length: bytes.length }), releaseFor(bytes));
  await assert.rejects(ensureBrowser(longer.deps), /larger than the 0 MB this agent expects/);
  assert.deepEqual(readdirSync(longer.dir), []);

  const shorter = world(serve(bytes.subarray(0, 100), { length: bytes.length }), releaseFor(bytes));
  await assert.rejects(ensureBrowser(shorter.deps), /stopped at 0 MB of 0 MB, so it was not installed/);

  const missing = world(serve(bytes, { status: 404 }), releaseFor(bytes));
  await assert.rejects(ensureBrowser(missing.deps), /Google's download server answered 404 for chrome-headless-shell 156\.0\.1\.2/);

  const offline = world({ urls: [], fetch: async () => { throw new TypeError("fetch failed"); } }, releaseFor(bytes));
  await assert.rejects(ensureBrowser(offline.deps), /could not reach Google's download server for chrome-headless-shell: fetch failed/);

  const stalled = world(serve(bytes, { stall: true }), releaseFor(bytes), { timeoutMs: 50 });
  await assert.rejects(ensureBrowser(stalled.deps), /did not finish within 0 s \(0 MB of 0 MB arrived\), so it was not installed/);
  assert.deepEqual(readdirSync(stalled.dir), []);
});

test("concurrent callers share one download", async () => {
  const bytes = browserZip();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const server = serve(bytes, { gate });
  const w = world(server, releaseFor(bytes));
  const first = ensureBrowser(w.deps);
  const second = ensureBrowser(w.deps);
  const status = browserStatus(w.deps);
  assert.equal(status.installed, null);
  assert.equal(status.downloading?.totalBytes, bytes.length);
  open();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(server.urls.length, 1);
  assert.equal(browserStatus(w.deps).downloading, null);
});

test("a failed install is tried afresh by the next caller, which clears the error", async () => {
  const bytes = browserZip();
  let fail = true;
  const good = serve(bytes);
  const w = world({ urls: [], fetch: async (url, init) => { if (fail) throw new TypeError("fetch failed"); return good.fetch(url, init); } }, releaseFor(bytes));
  await assert.rejects(ensureBrowser(w.deps), /fetch failed/);
  assert.ok(browserStatus(w.deps).lastError);
  fail = false;
  await ensureBrowser(w.deps);
  assert.equal(browserStatus(w.deps).lastError, null);
});

test("a zip with a .. entry is refused, and nothing is written outside or installed", async () => {
  const bytes = browserZip([{ name: `${ROOT}/../../escaped`, data: "x", method: 0 }]);
  const w = world(serve(bytes), releaseFor(bytes));
  await assert.rejects(ensureBrowser(w.deps), /zip could not be unpacked: it holds an entry that climbs out with \.\. \(chrome-headless-shell-linux64\/\.\.\/\.\.\/escaped\)/);
  assert.deepEqual(readdirSync(w.dir), []);
  assert.equal(existsSync(join(w.dir, "..", "escaped")), false);
  assert.equal(existsSync(join(w.dir, "escaped")), false);
});

test("an unsupported platform is refused in plain words", async () => {
  const bytes = browserZip();
  const server = serve(bytes);
  const w = world(server, releaseFor(bytes), { platform: "linux", arch: "arm64" });
  await assert.rejects(ensureBrowser(w.deps), /Cobra has no browser to print PDFs with on this computer \(linux-arm64\).*Set COBRA_CHROMIUM/);
  assert.equal(server.urls.length, 0);
  assert.equal(browserStatus(w.deps).platform, null);
  assert.equal(existsSync(w.dir), false);
});

test("Windows gets chrome-headless-shell.exe from the win64 zip", async () => {
  const root = "chrome-headless-shell-win64";
  const bytes = zip([{ name: `${root}/chrome-headless-shell.exe`, data: "MZ", method: 8 }]);
  const server = serve(bytes);
  const w = world(server, { version: "156.0.1.2", platforms: { "win32-x64": { name: "win64", bytes: bytes.length, sha256: sha(bytes) } } }, { platform: "win32", arch: "x64" });
  assert.equal(await ensureBrowser(w.deps), join(w.dir, "156.0.1.2", "chrome-headless-shell.exe"));
  assert.match(server.urls[0]!, /\/156\.0\.1\.2\/win64\/chrome-headless-shell-win64\.zip$/);
});

// --- unzip ------------------------------------------------------------------------------

test("entry names: nothing absolute, no .., no backslash", () => {
  assert.equal(entryNameWhy("a/b/c.pak"), null);
  assert.equal(entryNameWhy("a/b/"), null);
  assert.match(entryNameWhy("/etc/passwd")!, /absolute path/);
  assert.match(entryNameWhy("C:/Windows/x")!, /absolute path/);
  assert.match(entryNameWhy("a/../../b")!, /climbs out/);
  assert.match(entryNameWhy("..")!, /climbs out/);
  assert.match(entryNameWhy("a\\..\\b")!, /backslash/);
  assert.match(entryNameWhy("")!, /no usable name/);
});

function unzipped(entries: ZipEntry[] | Buffer): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "cobra-unzip-"));
  writeFileSync(join(dir, "a.zip"), Buffer.isBuffer(entries) ? entries : zip(entries));
  mkdirSync(join(dir, "out"));
  return unzip(join(dir, "a.zip"), join(dir, "out")).then(() => join(dir, "out"));
}

test("unzip refuses links, a name twice, damaged data and what is not a zip", async () => {
  await assert.rejects(unzipped([{ name: "link", data: "/etc/passwd", method: 0, mode: 0o120777 }]), /it holds a link \(link\)/);
  await assert.rejects(unzipped([{ name: "a", data: "1" }, { name: "a", data: "2" }]), /it holds a twice/);
  await assert.rejects(unzipped([{ name: "/abs", data: "1" }]), /absolute path/);
  const bytes = zip([{ name: "a.txt", data: "hello world", method: 0 }]);
  bytes[30 + "a.txt".length] = "j".charCodeAt(0);
  await assert.rejects(unzipped(bytes), /its entry a\.txt is damaged \(its CRC-32 differs\)/);
  await assert.rejects(unzipped(Buffer.from("not a zip at all")), /not a zip/);
  // An entry whose permission bits ask for set-id or others' write gets 0755 at most.
  const out = await unzipped([{ name: "tool", data: "x", method: 0, mode: 0o106777 }, { name: "empty", method: 0 }]);
  assert.equal(statSync(join(out, "tool")).mode & 0o7777, 0o755);
  assert.equal(statSync(join(out, "empty")).size, 0);
});
