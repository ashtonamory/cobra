import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { clearGoogleGrant, GoogleAuthError, type GoogleGrant, googleGrantFor, SCOPE_DRIVE_FILE } from "./googleAuth.ts";
import { googleRefusal } from "./gmail.ts";
import { typeForName } from "./mime.ts";
import { STATE_DIR } from "./paths.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";

/**
 * Files a Foreman puts in the person's Google Drive after they allowed it
 * (actions.ts, channel file): into a folder `Cobra` at the top of their Drive, and in it one
 * folder per project, named for the project. Drive keeps two files of one
 * name side by side, so nothing already there is ever written over.
 *
 * The access token comes from the account's Google connection (googleAuth.ts)
 * with the `drive.file` scope, which lets Cobra see only the files and
 * folders it made itself. So a `Cobra` folder the person made by hand is not
 * found: the agent makes its own once and keeps the folders' ids in
 * `drive.json` in its state folder (mode 0600), per Google account. A kept
 * folder that answers 404 or sits in the bin is made again.
 *
 * A file up to 5 MB goes up in one multipart request (metadata and bytes); a
 * bigger one through a resumable session, sent whole; one over 100 MB is
 * refused before anything goes up. A 401 means Google ended the token early,
 * so it is dropped and the request tried once more with a fresh one.
 */

export const DRIVE_STATE = join(STATE_DIR, "drive.json");
/** The folder at the top of the person's Drive that holds a folder per project. */
export const DRIVE_ROOT_NAME = "Cobra";

const MB = 1024 * 1024;
/** Up to this size a file goes up in one multipart request; above it, resumable. */
export const MULTIPART_MAX_BYTES = 5 * MB;
/** One file, at most. */
export const MAX_DRIVE_FILE_BYTES = 100 * MB;

export const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
export const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_TYPE = "application/vnd.google-apps.folder";
const FIELDS = "id,name,webViewLink";
const CALL_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export type DriveFile = { name: string; data: Uint8Array; type?: string };
export type DriveUploaded = { name: string; id: string; webViewLink: string };
/** The project the files belong to: its id keys the kept folder, its name names it. */
export type DriveProject = { id: string; name: string };

export type DriveDeps = {
  fetcher: typeof fetch;
  grant: (scope: string) => Promise<GoogleGrant>;
  clearGrant: () => void;
  /** Where the folders' ids are kept. */
  statePath: string;
};

const LIVE: DriveDeps = {
  fetcher: fetch,
  grant: googleGrantFor,
  clearGrant: clearGoogleGrant,
  statePath: DRIVE_STATE,
};

/** An upload that stopped partway: `uploaded` holds the files already in Drive, `failed` the one that did not go. */
export class DriveUploadError extends Error {
  uploaded: DriveUploaded[];
  failed: string;
  constructor(message: string, uploaded: DriveUploaded[], failed: string) {
    super(message);
    this.uploaded = uploaded;
    this.failed = failed;
  }
}

type Folder = { id: string; name: string };
type AccountState = { root?: Folder; projects: Record<string, Folder> };
type DriveState = { accounts: Record<string, AccountState> };

/** A project's folder name in Drive: its name on one line, no slashes (the card shows `Cobra/<name>`), at most 100 characters. */
export function driveFolderName(name: string): string {
  const flat = name.replace(/[/\\]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 100).trim();
  return flat || "Project";
}

function folder(value: unknown): Folder | undefined {
  const entry = value as { id?: unknown; name?: unknown } | null;
  if (!entry || typeof entry.id !== "string" || !entry.id || typeof entry.name !== "string") return undefined;
  return { id: entry.id, name: entry.name };
}

/** drive.json as kept. A missing or unreadable one is empty (the folders are made again); one refused as a private file is an Error. */
export function readDriveState(path: string): DriveState {
  const read = readPrivateFile(path);
  if (read.refused) throw new Error(`${path} was refused: ${read.refused}. It must be a regular file you own, mode 0600`);
  if (read.text === null) return { accounts: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    return { accounts: {} };
  }
  const accounts: Record<string, AccountState> = {};
  const given = (raw as { accounts?: unknown } | null)?.accounts;
  if (given && typeof given === "object" && !Array.isArray(given)) {
    for (const [email, value] of Object.entries(given as Record<string, unknown>)) {
      const entry = value as { root?: unknown; projects?: unknown } | null;
      if (!entry || typeof entry !== "object") continue;
      const projects: Record<string, Folder> = {};
      if (entry.projects && typeof entry.projects === "object") {
        for (const [id, kept] of Object.entries(entry.projects as Record<string, unknown>)) {
          const found = folder(kept);
          if (found) projects[id] = found;
        }
      }
      const root = folder(entry.root);
      accounts[email] = { ...(root ? { root } : {}), projects };
    }
  }
  return { accounts };
}

// One upload at a time on this computer, so two at once never make two Cobra folders.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Puts each file in `Cobra/<project>/` in the connected account's Drive, in
 * order, and resolves with each one's Drive id and link. A GoogleAuthError is
 * thrown as it is; a failure partway is a DriveUploadError holding the files
 * that went up before it.
 */
export function uploadToDrive(files: DriveFile[], options: { project: DriveProject; deps?: Partial<DriveDeps> }): Promise<DriveUploaded[]> {
  const deps: DriveDeps = { ...LIVE, ...options.deps };
  const run = queue.then(() => upload(files, options.project, deps));
  queue = run.catch(() => undefined);
  return run;
}

async function upload(files: DriveFile[], project: DriveProject, deps: DriveDeps): Promise<DriveUploaded[]> {
  for (const file of files) {
    if (file.data.byteLength > MAX_DRIVE_FILE_BYTES) throw new Error(`${file.name} is ${Math.round(file.data.byteLength / MB)} MB and a file goes to Drive at most ${MAX_DRIVE_FILE_BYTES / MB} MB, so nothing was uploaded`);
  }
  if (files.length === 0) return [];
  const google = new Session(deps, await deps.grant(SCOPE_DRIVE_FILE));
  const key = google.email.toLowerCase();
  const state = readDriveState(deps.statePath);
  const account: AccountState = state.accounts[key] ?? { projects: {} };
  state.accounts[key] = account;
  let changed = false;
  const keep = (): void => {
    if (changed) writePrivateFile(deps.statePath, JSON.stringify(state, null, 2) + "\n");
    changed = false;
  };

  const root = await google.ensureFolder(account.root, DRIVE_ROOT_NAME, "root");
  if (root.id !== account.root?.id) {
    account.root = root;
    // The project folders were in the old Cobra folder: they are made again under the new one.
    account.projects = {};
    changed = true;
  }
  const name = driveFolderName(project.name);
  const kept = account.projects[project.id];
  const place = await google.ensureFolder(kept?.name === name ? kept : undefined, name, root.id);
  if (place.id !== kept?.id) {
    account.projects[project.id] = place;
    changed = true;
  }
  keep();

  const uploaded: DriveUploaded[] = [];
  for (const file of files) {
    try {
      uploaded.push(await google.uploadFile(file, place.id));
    } catch (caught) {
      if (caught instanceof GoogleAuthError && uploaded.length === 0) throw caught;
      throw new DriveUploadError(caught instanceof Error ? caught.message : String(caught), uploaded, file.name);
    }
  }
  return uploaded;
}

/** Requests with the token, one retry after a 401 with a fresh grant. */
class Session {
  deps: DriveDeps;
  grant: GoogleGrant;
  email: string;

  constructor(deps: DriveDeps, grant: GoogleGrant) {
    this.deps = deps;
    this.grant = grant;
    this.email = grant.email;
  }

  async send(what: string, request: (token: string) => Promise<Response>): Promise<Response> {
    let response = await this.attempt(what, request);
    if (response.status !== 401) return response;
    this.deps.clearGrant();
    this.grant = await this.deps.grant(SCOPE_DRIVE_FILE);
    // The kept folders belong to one account: a sign-in that is now another account starts over.
    if (this.grant.email.toLowerCase() !== this.email.toLowerCase()) throw new Error("the connected Google account changed during the upload; propose it again");
    response = await this.attempt(what, request);
    if (response.status === 401) {
      this.deps.clearGrant();
      throw new GoogleAuthError("google_reconnect", "Google Drive refused a fresh sign-in too");
    }
    return response;
  }

  async attempt(what: string, request: (token: string) => Promise<Response>): Promise<Response> {
    try {
      return await request(this.grant.accessToken);
    } catch (caught) {
      throw new Error(`Google Drive could not be reached while ${what} (${caught instanceof Error ? caught.message : String(caught)})`);
    }
  }

  /** The kept folder when Drive still has it outside the bin, else a new one of that name in `parent`. */
  async ensureFolder(kept: Folder | undefined, name: string, parent: string): Promise<Folder> {
    if (kept) {
      const url = `${DRIVE_FILES_URL}/${encodeURIComponent(kept.id)}?fields=id,trashed`;
      const response = await this.send(`checking the ${kept.name} folder`, (token) => this.deps.fetcher(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }));
      const text = await response.text().catch(() => "");
      if (response.ok) {
        const body = parseJson(text) as { trashed?: unknown };
        if (body.trashed !== true) return kept;
      } else if (response.status !== 404) {
        throw new Error(googleRefusal("Google Drive", response.status, text));
      }
    }
    const response = await this.send(`making the ${name} folder`, (token) =>
      this.deps.fetcher(`${DRIVE_FILES_URL}?fields=id,name`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name, mimeType: FOLDER_TYPE, parents: [parent] }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      }),
    );
    const text = await response.text().catch(() => "");
    if (!response.ok) throw new Error(googleRefusal("Google Drive", response.status, text));
    const made = parseJson(text) as { id?: unknown };
    if (typeof made.id !== "string" || !made.id) throw new Error(`Google Drive made the ${name} folder but answered without its id`);
    return { id: made.id, name };
  }

  /** One file into the folder: multipart up to 5 MB, else a resumable session sent whole. */
  async uploadFile(file: DriveFile, parent: string): Promise<DriveUploaded> {
    const type = file.type && /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : typeForName(file.name);
    const metadata = JSON.stringify({ name: file.name, parents: [parent] });
    const what = `uploading ${file.name}`;
    let response: Response;
    if (file.data.byteLength <= MULTIPART_MAX_BYTES) {
      const boundary = `cobra_${randomBytes(12).toString("hex")}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`, "utf8"),
        Buffer.from(file.data),
        Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
      ]);
      response = await this.send(what, (token) =>
        this.deps.fetcher(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=${FIELDS}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        }),
      );
    } else {
      response = await this.send(what, async (token) => {
        const start = await this.deps.fetcher(`${DRIVE_UPLOAD_URL}?uploadType=resumable&fields=${FIELDS}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=UTF-8",
            "x-upload-content-type": type,
            "x-upload-content-length": String(file.data.byteLength),
          },
          body: metadata,
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        if (!start.ok) return start;
        const session = start.headers.get("location");
        if (!session) throw new Error("Google Drive opened no upload session");
        return this.deps.fetcher(session, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-type": type },
          body: new Uint8Array(file.data),
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
      });
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) throw new Error(googleRefusal("Google Drive", response.status, text));
    const made = parseJson(text) as { id?: unknown; name?: unknown; webViewLink?: unknown };
    if (typeof made.id !== "string" || !made.id) throw new Error(`Google Drive took ${file.name} but answered without its id`);
    const link = typeof made.webViewLink === "string" ? made.webViewLink : `https://drive.google.com/file/d/${made.id}/view`;
    return { name: typeof made.name === "string" ? made.name : file.name, id: made.id, webViewLink: link };
  }
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
