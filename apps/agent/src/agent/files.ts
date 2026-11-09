import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

import type {
  DeviceDelivery,
  FileUpload,
  FilesPushData,
  ReceivedFile,
  SendList,
  SendRecord,
  SendRequest,
} from "@cobra/contracts";

import { REPO_NAME } from "./github.ts";
import { SessionError } from "./sessions.ts";
import { CONFIG_DIR, DATA_DIR, DROP_DIR } from "./paths.ts";
import { readPrivateFile } from "./private.ts";

/**
 * Sending a file to a repository and/or machines in the fleet.
 *
 * The hub (the Mini, always on) takes each upload once, then a send naming
 * where the files go. The repository half is done through the GitHub API —
 * blob, tree, commit, branch, PR — never through a checkout: that way any repo
 * on the account works, checked out or not, on a sleeping machine or not, and
 * no working tree a Claude session is editing is ever touched. The device half
 * is a POST of the bytes to that machine's own agent (`/files/receive`), which
 * writes into ~/Downloads/cp; a machine that does not answer keeps its copy
 * queued here and is retried until it does.
 *
 * Everything the hub keeps lives in ~/.local/share/cp-files, outside the repo
 * for gotcha 24's reason, and is pruned after `retainDays`.
 */

/**
 * A machine the hub delivers to. `key` is the peer key the phone made for
 * this hub and that machine (keys.ts): the receiving agent accepts it for
 * /files/receive and nothing else. files.json therefore holds secrets, and is
 * read and written as a private file.
 */
export type DeviceTarget = { label: string; url: string; key?: string };

/** A local folder the owner chose to receive files a Foreman exports (actions.ts, channel file); the person's Google Drive needs none (key `drive` is reserved for it). */
export type ExportFolder = { label: string; path: string };

export type FilesConfig = {
  /** The hostname of the hub, or "" when the fleet has none (the phone sends direct). */
  hub: string;
  inbox: string;
  maxBytes: number;
  retainDays: number;
  devices: Record<string, DeviceTarget>;
  /** Export folders by a short slug, the key a Foreman names in action_propose. */
  exports: Record<string, ExportFolder>;
};

export const DEFAULT_FILES_CONFIG = join(CONFIG_DIR, "files.json");
export const DEFAULT_FILES_ROOT = join(DATA_DIR, "files");
export const DEFAULT_DROP_DIR = DROP_DIR;

const FALLBACK: FilesConfig = {
  hub: "",
  inbox: "inbox",
  maxBytes: 50 * 1024 * 1024,
  retainDays: 30,
  devices: {},
  exports: {},
};

/** An export folder's key: short, lowercase, safe to show and to type. */
const EXPORT_KEY = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * The files config this computer acts on. Cobra runs on one computer, so it
 * is always its own hub and its only device: a file is delivered by writing
 * it into the drop folder here, with no peer key and nothing to forward. Any
 * other device a files.json names is ignored.
 *
 * The self entry's url is never fetched: delivery to this computer's own
 * hostname writes locally (runDevice).
 */
export function effectiveFilesConfig(config: FilesConfig, hostname: string, label: string): FilesConfig {
  const self: DeviceTarget = { label, url: "https://localhost" };
  return { ...config, hub: hostname, devices: { [hostname]: self } };
}

export async function loadFilesConfig(path = DEFAULT_FILES_CONFIG): Promise<FilesConfig> {
  let raw: Record<string, unknown>;
  const read = readPrivateFile(path);
  if (read.refused) {
    // Peer keys live here: a file others could change is not one to deliver from.
    console.error(`[cobra-agent] refusing to read ${path}: ${read.refused}; sending files is off`);
    return FALLBACK;
  }
  try {
    raw = JSON.parse(read.text ?? "") as Record<string, unknown>;
  } catch {
    return FALLBACK;
  }
  const devices: Record<string, DeviceTarget> = {};
  const rawDevices = raw.devices;
  if (typeof rawDevices === "object" && rawDevices !== null) {
    for (const [host, value] of Object.entries(rawDevices as Record<string, unknown>)) {
      const entry = value as { label?: unknown; url?: unknown; key?: unknown };
      if (typeof entry?.url === "string" && entry.url.startsWith("https://")) {
        const target: DeviceTarget = { label: typeof entry.label === "string" ? entry.label : host, url: entry.url.replace(/\/+$/, "") };
        if (typeof entry.key === "string" && entry.key.length >= 32) target.key = entry.key;
        devices[host] = target;
      }
    }
  }
  const inbox = typeof raw.inbox === "string" && /^[A-Za-z0-9._/-]+$/.test(raw.inbox) && !raw.inbox.includes("..")
    ? raw.inbox.replace(/^\/+|\/+$/g, "")
    : FALLBACK.inbox;
  // Export folders: the agent copies files into these after an Allow, so only an absolute path with no ".." counts; anything else is dropped rather than guessed.
  const exports: Record<string, ExportFolder> = {};
  const rawExports = raw.exports;
  if (typeof rawExports === "object" && rawExports !== null) {
    for (const [key, value] of Object.entries(rawExports as Record<string, unknown>)) {
      const entry = value as { label?: unknown; path?: unknown };
      if (!EXPORT_KEY.test(key) || typeof entry?.path !== "string") continue;
      const path = entry.path.replace(/\/+$/, "") || entry.path;
      if (!path.startsWith("/") || path.split("/").includes("..")) continue;
      const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : key;
      exports[key] = { label, path };
    }
  }
  return {
    hub: typeof raw.hub === "string" ? raw.hub : FALLBACK.hub,
    inbox,
    maxBytes: typeof raw.maxBytes === "number" && raw.maxBytes > 0 ? raw.maxBytes : FALLBACK.maxBytes,
    retainDays: typeof raw.retainDays === "number" && raw.retainDays > 0 ? raw.retainDays : FALLBACK.retainDays,
    devices,
    exports,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers

/**
 * A file name that is safe as the last component of a path on disk and in a
 * repository: no directory parts, no control characters, no leading dot (a
 * WhatsApp file called ".env" should not become a dotfile anywhere), and a
 * length a filesystem accepts. Null when nothing usable is left.
 */
export function safeName(raw: string): string | null {
  let name = basename(raw.replace(/\\/g, "/"))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .replace(/^\.+/, "");
  if (name.length === 0 || name === "." || name === "..") return null;
  if (Buffer.byteLength(name) > 180) {
    const ext = extname(name).slice(0, 16);
    let stem = name.slice(0, name.length - extname(name).length);
    while (Buffer.byteLength(stem + ext) > 180) stem = stem.slice(0, -1);
    name = stem + ext;
  }
  return name;
}

/** "a.pdf" → "a (2).pdf" → "a (3).pdf", until it is not in `taken`. */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const ext = extname(name);
  const stem = ext.length > 0 ? name.slice(0, -ext.length) : name;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A lowercase slug of the first file's stem, for the branch name. */
export function slug(name: string): string {
  const stem = name.slice(0, name.length - extname(name).length);
  const cleaned = stem
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40)
    .replace(/-+$/, "");
  return cleaned.length > 0 ? cleaned : "file";
}

/** chore/inbox-2026-09-30-invoice, with -2, -3… for a retry that found it taken. */
export function branchName(firstFile: string, now: Date, attempt = 1): string {
  const date = now.toISOString().slice(0, 10);
  const base = `chore/inbox-${date}-${slug(firstFile)}`;
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

/**
 * How long to wait after `attempts` failed deliveries: 30 s, 1 min, 2 min, then
 * every 5 min. A sleeping Legion costs one refused connection per tick, so
 * there is no reason to back off further than that.
 */
export function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(30_000 * 2 ** (attempts - 1), 5 * 60_000);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The PR's body: what arrived, and where. */
export function prBody(files: { name: string; size: number; path: string }[]): string {
  const rows = files.map((file) => `- \`${file.path}\` (${formatBytes(file.size)})`);
  return [
    `Sent from Control Plane.`,
    ``,
    ...rows,
    ``,
    `Files land in the inbox as they arrived. Move them where they belong before or after merging.`,
  ].join("\n");
}

export function commitMessage(paths: string[], inbox: string): string {
  if (paths.length === 1) return `Add ${basename(paths[0]!)} to ${inbox}/`;
  return `Add ${paths.length} files to ${inbox}/`;
}

/** Hand-rolled because the agent has no zod at runtime (gotcha 16). */
export function readSendRequest(body: unknown): SendRequest | string {
  if (typeof body !== "object" || body === null) return "body must be an object";
  const raw = body as { files?: unknown; repo?: unknown; devices?: unknown };
  if (!Array.isArray(raw.files) || raw.files.length === 0 || raw.files.some((id) => typeof id !== "string")) {
    return "files must be a non-empty array of upload ids";
  }
  if (raw.files.length > 20) return "at most 20 files per send";
  let repo: string | undefined;
  if (raw.repo !== undefined && raw.repo !== null && raw.repo !== "") {
    if (typeof raw.repo !== "string" || !REPO_NAME.test(raw.repo)) return "repo must be owner/name";
    repo = raw.repo;
  }
  let devices: string[] | undefined;
  if (raw.devices !== undefined && raw.devices !== null) {
    if (!Array.isArray(raw.devices) || raw.devices.some((host) => typeof host !== "string")) {
      return "devices must be an array of hostnames";
    }
    devices = [...new Set(raw.devices as string[])];
  }
  if (!repo && (!devices || devices.length === 0)) return "a send needs a repo, a device, or both";
  return { files: raw.files as string[], repo, devices };
}

// ---------------------------------------------------------------------------
// Writing a stream to disk

const UPLOAD_ID = /^[a-f0-9]{24}$/;
const SEND_ID = /^s[a-f0-9]{16}$/;

export class TooLarge extends Error {}

/**
 * Stream a request body into `destination`, never holding it in memory,
 * hashing as it goes. The body is written to a hidden `.part` file and renamed
 * only when complete, so nothing watching the directory (cp-desk) ever sees a
 * half-written file.
 */
export async function streamToFile(
  body: AsyncIterable<Buffer | Uint8Array | string>,
  destination: string,
  maxBytes: number,
  mode = 0o600,
): Promise<{ size: number; sha256: string }> {
  const part = join(destination, "..", `.${basename(destination)}.${randomBytes(4).toString("hex")}.part`);
  const hash = createHash("sha256");
  const out = createWriteStream(part, { mode });
  let size = 0;
  try {
    for await (const chunk of body) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new TooLarge(`over the ${formatBytes(maxBytes)} limit`);
      hash.update(buffer);
      if (!out.write(buffer)) await new Promise<void>((resolve) => out.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    await rename(part, destination);
  } catch (caught) {
    // The stream opens its file in the background: wait until it is closed,
    // or a refusal on the first chunk removes the .part before it exists and
    // the open makes it afterwards.
    await new Promise<void>((resolve) => {
      if (out.closed) return resolve();
      out.once("close", () => resolve());
      out.destroy();
    });
    await rm(part, { force: true });
    throw caught;
  }
  return { size, sha256: hash.digest("hex") };
}

/**
 * The receiving half, on every machine: write into the drop directory under a
 * name nothing else there already has.
 */
export async function receiveFile(
  body: AsyncIterable<Buffer | Uint8Array | string>,
  rawName: string,
  dropDir: string,
  maxBytes: number,
): Promise<ReceivedFile> {
  const name = safeName(rawName);
  if (!name) throw new SessionError("name is not a usable file name", 400);
  await mkdir(dropDir, { recursive: true });
  const taken = new Set(await readdir(dropDir).catch(() => [] as string[]));
  const final = uniqueName(name, taken);
  const path = join(dropDir, final);
  try {
    // An ordinary file in ~/Downloads, unlike the hub's private copy.
    const { size } = await streamToFile(body, path, maxBytes, 0o644);
    return { path, size };
  } catch (caught) {
    if (caught instanceof TooLarge) throw new SessionError(`file is ${caught.message}`, 413);
    throw caught;
  }
}

// ---------------------------------------------------------------------------
// GitHub, through gh api

/** Runs `gh <args>`, optionally feeding a file as --input. Rejects with stderr. */
export type GhApi = (args: string[]) => Promise<string>;

export class GhError extends Error {
  status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

/** "gh: Not Found (HTTP 404)" → 404. */
export function ghStatus(stderr: string): number | null {
  const matched = /\(HTTP (\d{3})\)/.exec(stderr);
  return matched ? Number(matched[1]) : null;
}

type CommitInput = {
  repo: string;
  inbox: string;
  files: { name: string; size: number; blobPath: string }[];
  now: Date;
  tmpDir: string;
};

export type CommitOutcome = {
  branch: string;
  paths: string[];
  pr: { number: number; url: string };
};

async function ghJson<T>(gh: GhApi, args: string[]): Promise<T> {
  return JSON.parse(await gh(["api", ...args])) as T;
}

/**
 * Branch + commit + PR, entirely remote. Each blob is uploaded from a JSON file
 * on disk (`--input`) so a 50 MB file never becomes a 67 MB command line.
 */
export async function commitToRepo(gh: GhApi, input: CommitInput): Promise<CommitOutcome> {
  const { repo, inbox } = input;
  const meta = await ghJson<{ default_branch?: string }>(gh, [`repos/${repo}`]);
  const base = meta.default_branch ?? "main";

  let baseSha: string;
  try {
    const ref = await ghJson<{ object: { sha: string } }>(gh, [`repos/${repo}/git/ref/heads/${base}`]);
    baseSha = ref.object.sha;
  } catch (caught) {
    if (caught instanceof GhError && (caught.status === 409 || caught.status === 404)) {
      throw new GhError(`${repo} has no ${base} branch to add to (is it empty?)`, caught.status);
    }
    throw caught;
  }
  const baseCommit = await ghJson<{ tree: { sha: string } }>(gh, [`repos/${repo}/git/commits/${baseSha}`]);

  // What is already in the inbox, so a second invoice.pdf becomes invoice (2).pdf
  // rather than silently replacing the first.
  const taken = new Set<string>();
  try {
    const listing = await ghJson<{ name?: string }[] | { name?: string }>(gh, [
      `repos/${repo}/contents/${inbox}?ref=${encodeURIComponent(base)}`,
    ]);
    if (Array.isArray(listing)) for (const entry of listing) if (entry.name) taken.add(entry.name);
  } catch (caught) {
    if (!(caught instanceof GhError && caught.status === 404)) throw caught;
  }

  const entries: { path: string; mode: string; type: string; sha: string }[] = [];
  const placed: { name: string; size: number; path: string }[] = [];
  await mkdir(input.tmpDir, { recursive: true });
  for (const file of input.files) {
    const name = uniqueName(file.name, taken);
    taken.add(name);
    const payload = join(input.tmpDir, `blob-${randomBytes(6).toString("hex")}.json`);
    const content = await readFile(file.blobPath);
    await writeFile(payload, `{"encoding":"base64","content":"${content.toString("base64")}"}`, { mode: 0o600 });
    try {
      const blob = await ghJson<{ sha: string }>(gh, ["-X", "POST", `repos/${repo}/git/blobs`, "--input", payload]);
      const path = `${inbox}/${name}`;
      entries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
      placed.push({ name, size: file.size, path });
    } finally {
      await rm(payload, { force: true });
    }
  }

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const payload = join(input.tmpDir, `req-${randomBytes(6).toString("hex")}.json`);
    await writeFile(payload, JSON.stringify(body), { mode: 0o600 });
    try {
      return await ghJson<T>(gh, ["-X", "POST", path, "--input", payload]);
    } finally {
      await rm(payload, { force: true });
    }
  };

  const tree = await post<{ sha: string }>(`repos/${repo}/git/trees`, { base_tree: baseCommit.tree.sha, tree: entries });
  const paths = placed.map((file) => file.path);
  const commit = await post<{ sha: string }>(`repos/${repo}/git/commits`, {
    message: commitMessage(paths, inbox),
    tree: tree.sha,
    parents: [baseSha],
  });

  let branch = "";
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const candidate = branchName(input.files[0]!.name, input.now, attempt);
    try {
      await post(`repos/${repo}/git/refs`, { ref: `refs/heads/${candidate}`, sha: commit.sha });
      branch = candidate;
      break;
    } catch (caught) {
      // 422 "Reference already exists": two sends of the same file on one day.
      if (caught instanceof GhError && caught.status === 422) continue;
      throw caught;
    }
  }
  if (!branch) throw new GhError("could not find a free branch name", 422);

  const title = placed.length === 1 ? `Add ${placed[0]!.name}` : `Add ${placed.length} files to ${inbox}/`;
  const pr = await post<{ number: number; html_url: string }>(`repos/${repo}/pulls`, {
    title,
    head: branch,
    base,
    body: prBody(placed),
  });
  return { branch, paths, pr: { number: pr.number, url: pr.html_url } };
}

// ---------------------------------------------------------------------------
// The hub

export type Push = { title: string; body: string; data: FilesPushData };

export type HubDeps = {
  root: string;
  dropDir: string;
  hostname: string;
  config: () => Promise<FilesConfig>;
  gh: GhApi | null;
  /** POST the bytes at `blobPath` to another machine's /files/receive. */
  deliver: (target: DeviceTarget, blobPath: string, name: string, sendId: string) => Promise<ReceivedFile>;
  push: (message: Push) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
};

type Upload = FileUpload;

type StoredSend = SendRecord & {
  /** When each queued device (by host) may next be tried. Not sent to the phone. */
  nextAt?: Record<string, number>;
  repoAttempts?: number;
  repoNextAt?: number;
};

export type Hub = {
  isHub: () => Promise<boolean>;
  upload: (body: AsyncIterable<Buffer | Uint8Array | string>, name: string, declared: number | null) => Promise<FileUpload>;
  send: (request: SendRequest) => Promise<SendRecord>;
  list: () => Promise<SendList>;
  retry: (id: string) => Promise<SendRecord>;
  cancel: (id: string) => Promise<SendRecord>;
  pump: () => Promise<void>;
  start: (intervalMs?: number) => () => void;
};

export function createHub(deps: HubDeps): Hub {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const uploadsDir = join(deps.root, "uploads");
  const sendsPath = join(deps.root, "sends.json");
  let sends: StoredSend[] | null = null;
  let pumping: Promise<void> | null = null;
  let again = false;

  async function load(): Promise<StoredSend[]> {
    if (sends) return sends;
    try {
      const parsed = JSON.parse(await readFile(sendsPath, "utf8")) as unknown;
      sends = Array.isArray(parsed) ? (parsed as StoredSend[]) : [];
    } catch {
      sends = [];
    }
    return sends;
  }

  async function save(): Promise<void> {
    await mkdir(deps.root, { recursive: true, mode: 0o700 });
    const tmp = `${sendsPath}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(sends ?? [], null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, sendsPath);
  }

  async function readUpload(id: string): Promise<Upload | null> {
    if (!UPLOAD_ID.test(id)) return null;
    try {
      return JSON.parse(await readFile(join(uploadsDir, `${id}.json`), "utf8")) as Upload;
    } catch {
      return null;
    }
  }

  const blobPath = (id: string) => join(uploadsDir, id);

  async function requireHub(): Promise<FilesConfig> {
    const config = await deps.config();
    if (config.hub !== deps.hostname) {
      throw new SessionError(`files are sent through ${config.hub}, not ${deps.hostname}`, 409);
    }
    return config;
  }

  function label(config: FilesConfig, host: string): string {
    return config.devices[host]?.label ?? host;
  }

  async function notify(message: Push): Promise<void> {
    try {
      await deps.push(message);
    } catch (caught) {
      log(`files push failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }

  async function runRepo(config: FilesConfig, record: StoredSend): Promise<void> {
    const repo = record.repo;
    if (!repo || repo.status !== "pending") return;
    if ((record.repoNextAt ?? 0) > now()) return;
    if (!deps.gh) {
      repo.status = "failed";
      repo.error = "gh is not installed or not logged in on the hub";
      return;
    }
    const files: CommitInput["files"] = [];
    for (const file of record.files) files.push({ name: file.name, size: file.size, blobPath: blobPath(file.id) });
    try {
      const outcome = await commitToRepo(deps.gh, {
        repo: repo.repo,
        inbox: config.inbox,
        files,
        now: new Date(now()),
        tmpDir: join(deps.root, "tmp"),
      });
      repo.status = "done";
      repo.branch = outcome.branch;
      repo.paths = outcome.paths;
      repo.pr = outcome.pr;
      delete repo.error;
      log(`files ${record.id}: ${repo.repo} PR #${outcome.pr.number}`);
      const repoName = repo.repo.split("/")[1] ?? repo.repo;
      await notify({
        title: `PR #${outcome.pr.number} opened · ${repoName}`,
        body: `${outcome.paths.join(", ")} — merge when you're ready`,
        data: { machine: deps.hostname, files: record.id, kind: "pr-opened", url: outcome.pr.url },
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      record.repoAttempts = (record.repoAttempts ?? 0) + 1;
      repo.error = message;
      // A 4xx is GitHub saying no (no access, empty repo): retrying cannot
      // change it. Anything else — the network, a 5xx — gets two more tries.
      const permanent = caught instanceof GhError && caught.status !== null && caught.status >= 400 && caught.status < 500;
      if (permanent || record.repoAttempts >= 3) {
        repo.status = "failed";
        log(`files ${record.id}: ${repo.repo} failed: ${message}`);
        await notify({
          title: `Couldn't add to ${repo.repo.split("/")[1] ?? repo.repo}`,
          body: message.slice(0, 180),
          data: { machine: deps.hostname, files: record.id, kind: "failed" },
        });
      } else {
        record.repoNextAt = now() + backoffMs(record.repoAttempts);
      }
    }
  }

  async function runDevice(config: FilesConfig, record: StoredSend, delivery: DeviceDelivery): Promise<void> {
    if (delivery.status !== "queued") return;
    const due = record.nextAt?.[delivery.host] ?? 0;
    if (due > now()) return;
    const retainMs = config.retainDays * 86_400_000;
    if (now() - Date.parse(record.createdAt) > retainMs) {
      delivery.status = "expired";
      return;
    }
    const target = config.devices[delivery.host];
    if (!target) {
      delivery.status = "failed";
      delivery.lastError = "not a machine in config/files.json";
      return;
    }
    try {
      const paths: string[] = [];
      for (const file of record.files) {
        const received =
          delivery.host === deps.hostname
            ? await receiveFile(
                createReadStream(blobPath(file.id)),
                file.name,
                deps.dropDir,
                config.maxBytes,
              )
            : await deps.deliver(target, blobPath(file.id), file.name, record.id);
        paths.push(received.path);
      }
      const wasQueued = delivery.attempts > 0;
      delivery.attempts += 1;
      delivery.status = "delivered";
      delivery.deliveredAt = new Date(now()).toISOString();
      delivery.paths = paths;
      delete delivery.lastError;
      log(`files ${record.id}: delivered to ${delivery.host}`);
      // Only a delivery that had to wait is news; an immediate one is what
      // the send sheet already said would happen.
      if (wasQueued) {
        await notify({
          title: `Delivered to ${label(config, delivery.host)}`,
          body: `${record.files.map((file) => file.name).join(", ")} → ~/Downloads/Cobra`,
          data: { machine: deps.hostname, files: record.id, kind: "delivered" },
        });
      }
    } catch (caught) {
      delivery.attempts += 1;
      delivery.lastError = caught instanceof Error ? caught.message : String(caught);
      record.nextAt = { ...(record.nextAt ?? {}), [delivery.host]: now() + backoffMs(delivery.attempts) };
      if (caught instanceof SessionError && caught.status >= 400 && caught.status < 500 && caught.status !== 408) {
        delivery.status = "failed";
        await notify({
          title: `Couldn't deliver to ${label(config, delivery.host)}`,
          body: delivery.lastError.slice(0, 180),
          data: { machine: deps.hostname, files: record.id, kind: "failed" },
        });
      }
    }
  }

  async function prune(config: FilesConfig): Promise<boolean> {
    const list = await load();
    const cutoff = now() - config.retainDays * 86_400_000;
    const keep = list.filter((record) => Date.parse(record.createdAt) >= cutoff);
    const changed = keep.length !== list.length;
    sends = keep;
    const referenced = new Set(keep.flatMap((record) => record.files.map((file) => file.id)));
    let names: string[] = [];
    try {
      names = await readdir(uploadsDir);
    } catch {
      return changed;
    }
    for (const name of names) {
      const id = name.replace(/\.json$/, "");
      if (!UPLOAD_ID.test(id) || referenced.has(id)) continue;
      // An upload no send has claimed yet gets a day: the phone uploads, then
      // sends, and a send that never came leaves an orphan behind.
      const info = await stat(join(uploadsDir, name)).catch(() => null);
      if (info && now() - info.mtimeMs > 86_400_000) await rm(join(uploadsDir, name), { force: true });
    }
    return changed;
  }

  async function pumpOnce(): Promise<void> {
    const config = await deps.config();
    if (config.hub !== deps.hostname) return;
    let changed = await prune(config);
    for (const record of await load()) {
      const before = JSON.stringify(record);
      await runRepo(config, record);
      await Promise.all(record.devices.map((delivery) => runDevice(config, record, delivery)));
      if (JSON.stringify(record) !== before) changed = true;
    }
    if (changed) await save();
  }

  /** One pump at a time; a request during a pump runs another right after. */
  async function pump(): Promise<void> {
    if (pumping) {
      again = true;
      return pumping;
    }
    pumping = (async () => {
      try {
        do {
          again = false;
          await pumpOnce();
        } while (again);
      } catch (caught) {
        log(`files pump failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      } finally {
        pumping = null;
      }
    })();
    return pumping;
  }

  function publicView(record: StoredSend): SendRecord {
    const { nextAt: _n, repoAttempts: _a, repoNextAt: _r, ...rest } = record;
    return rest;
  }

  return {
    async isHub() {
      return (await deps.config()).hub === deps.hostname;
    },

    async upload(body, rawName, declared) {
      const config = await requireHub();
      const name = safeName(rawName);
      if (!name) throw new SessionError("name is not a usable file name", 400);
      if (declared !== null && declared > config.maxBytes) {
        throw new SessionError(`file is over the ${formatBytes(config.maxBytes)} limit`, 413);
      }
      await mkdir(uploadsDir, { recursive: true, mode: 0o700 });
      const id = randomBytes(12).toString("hex");
      let written: { size: number; sha256: string };
      try {
        written = await streamToFile(body, blobPath(id), config.maxBytes);
      } catch (caught) {
        if (caught instanceof TooLarge) throw new SessionError(`file is ${caught.message}`, 413);
        throw caught;
      }
      if (written.size === 0) {
        await rm(blobPath(id), { force: true });
        throw new SessionError("file is empty", 400);
      }
      const upload: Upload = { id, name, size: written.size, sha256: written.sha256, uploadedAt: new Date(now()).toISOString() };
      await writeFile(join(uploadsDir, `${id}.json`), JSON.stringify(upload), { mode: 0o600 });
      log(`files upload ${id}: ${name} (${formatBytes(written.size)})`);
      return upload;
    },

    async send(request) {
      const config = await requireHub();
      const files = [];
      for (const id of request.files) {
        const upload = await readUpload(id);
        if (!upload) throw new SessionError(`no upload ${id}`, 404);
        files.push({ id: upload.id, name: upload.name, size: upload.size });
      }
      for (const host of request.devices ?? []) {
        if (!config.devices[host]) throw new SessionError(`unknown device ${host}`, 400);
      }
      const record: StoredSend = {
        id: `s${randomBytes(8).toString("hex")}`,
        createdAt: new Date(now()).toISOString(),
        files,
        devices: (request.devices ?? []).map((host) => ({ host, status: "queued", attempts: 0 })),
      };
      if (request.repo) record.repo = { repo: request.repo, status: "pending" };
      const list = await load();
      list.unshift(record);
      await save();
      log(`files send ${record.id}: ${files.length} file(s) → ${[request.repo, ...(request.devices ?? [])].filter(Boolean).join(", ")}`);
      void pump();
      return publicView(record);
    },

    async list() {
      const config = await requireHub();
      const list = await load();
      return {
        sends: list.map(publicView),
        devices: Object.keys(config.devices),
        maxBytes: config.maxBytes,
      };
    },

    async retry(id) {
      await requireHub();
      if (!SEND_ID.test(id)) throw new SessionError("id is not a send id", 400);
      const record = (await load()).find((entry) => entry.id === id);
      if (!record) throw new SessionError(`no send ${id}`, 404);
      if (record.repo && (record.repo.status === "failed" || record.repo.status === "cancelled")) {
        record.repo.status = "pending";
        record.repoAttempts = 0;
        record.repoNextAt = 0;
      }
      for (const delivery of record.devices) {
        if (delivery.status === "failed" || delivery.status === "queued" || delivery.status === "cancelled") {
          delivery.status = "queued";
          record.nextAt = { ...(record.nextAt ?? {}), [delivery.host]: 0 };
        }
      }
      await save();
      void pump();
      return publicView(record);
    },

    /**
     * Stop whatever has not happened yet: a PR not yet opened, copies still
     * queued. What already landed stays landed. Retry undoes it.
     */
    async cancel(id) {
      await requireHub();
      if (!SEND_ID.test(id)) throw new SessionError("id is not a send id", 400);
      const record = (await load()).find((entry) => entry.id === id);
      if (!record) throw new SessionError(`no send ${id}`, 404);
      let stopped = 0;
      if (record.repo && record.repo.status === "pending") {
        record.repo.status = "cancelled";
        stopped += 1;
      }
      for (const delivery of record.devices) {
        if (delivery.status === "queued") {
          delivery.status = "cancelled";
          stopped += 1;
        }
      }
      if (stopped === 0) throw new SessionError("nothing left to cancel on that send", 409);
      await save();
      log(`files ${record.id}: cancelled ${stopped}`);
      return publicView(record);
    },

    pump,

    start(intervalMs = 20_000) {
      const timer = setInterval(() => void pump(), intervalMs);
      timer.unref?.();
      void pump();
      return () => clearInterval(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// Live dependencies

/**
 * How long one machine may take to accept a file: 30 s, or 50 KB/s for a big
 * one. Whole milliseconds — AbortSignal.timeout throws on a fraction, which is
 * how every file over ~1.5 MB once failed as "not reachable".
 */
export function deliveryTimeoutMs(bytes: number): number {
  return Math.ceil(Math.max(30_000, bytes / 50));
}

/** POST a file's bytes to another machine's agent, with that pair's peer key. Offline is an ordinary rejection. */
export function httpDeliver() {
  return async (target: DeviceTarget, blob: string, name: string, sendId: string): Promise<ReceivedFile> => {
    if (!target.key) {
      throw new SessionError(`${target.label} has no delivery key yet. Set the hub again from the phone.`, 409);
    }
    const content = await readFile(blob);
    const url = `${target.url}/files/receive?name=${encodeURIComponent(name)}&send=${encodeURIComponent(sendId)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${target.key}`,
          "content-type": "application/octet-stream",
        },
        body: content,
        signal: AbortSignal.timeout(deliveryTimeoutMs(content.length)),
      });
    } catch (caught) {
      throw new Error(`${target.label} is not reachable (${caught instanceof Error ? caught.message : String(caught)})`);
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        detail = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // Not JSON — a proxy's error page. The status is the useful part.
      }
      // A 404 is an agent too old to know /files/receive: worth retrying after
      // the next deploy, so it is not treated as a refusal.
      if (response.status >= 400 && response.status < 500 && response.status !== 404 && response.status !== 408) {
        throw new SessionError(`${target.label}: ${detail}`.slice(0, 200), response.status);
      }
      throw new Error(`${target.label}: HTTP ${response.status}`);
    }
    return JSON.parse(text) as ReceivedFile;
  };
}

/** gh api through the resolved binary; a failure carries the HTTP status gh reports. */
export function ghRunner(ghPath: string): GhApi {
  return async (args) => {
    return await new Promise<string>((resolve, reject) => {
      execFile(ghPath, args, { timeout: 300_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const text = `${stderr}`.trim();
        const line = text.split("\n").find((entry) => entry.trim().length > 0) ?? error.message;
        reject(new GhError(line.replace(/^gh: /, ""), ghStatus(text)));
      });
    });
  };
}
