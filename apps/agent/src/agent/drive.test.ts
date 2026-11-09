import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DRIVE_FILES_URL, DRIVE_UPLOAD_URL, DriveUploadError, driveFolderName, MAX_DRIVE_FILE_BYTES, MULTIPART_MAX_BYTES, readDriveState, uploadToDrive, type DriveDeps } from "./drive.ts";
import { GoogleAuthError, type GoogleGrant, SCOPE_DRIVE_FILE } from "./googleAuth.ts";

const ROOT = mkdtempSync(join(tmpdir(), "cobra-drive-"));
const GRANT: GoogleGrant = { accessToken: "ya29.drive-token", expiresAt: Date.now() + 3_600_000, email: "Penny@Gmail.com", scopes: [SCOPE_DRIVE_FILE] };
const PROJECT = { id: "payroll", name: "Paws & Paths Payroll" };

type Call = { method: string; url: string; auth: string | null; type: string | null; body: Buffer; headers: Headers };
type Item = { id: string; name: string; parents: string[]; folder: boolean; trashed?: boolean; bytes?: Buffer };

/** A small Drive: folders and files by id, created through the same URLs the real one answers. */
function drive(grants: GoogleGrant[] = [GRANT]) {
  const items = new Map<string, Item>();
  const calls: Call[] = [];
  const sessions = new Map<string, { name: string; parents: string[] }>();
  let next = 0;
  /** Answers queued ahead of Drive's own, as a status for the next request: a 401 to test the retry. */
  const before: number[] = [];
  let cleared = 0;
  let asked = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const make = (name: string, parents: string[], folder: boolean, bytes?: Buffer): Item => {
    next += 1;
    const item: Item = { id: `id${next}`, name, parents, folder, ...(bytes ? { bytes } : {}) };
    items.set(item.id, item);
    return item;
  };
  const view = (item: Item) => ({ id: item.id, name: item.name, webViewLink: `https://drive.google.com/file/d/${item.id}/view?usp=drivesdk` });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined ? Buffer.alloc(0) : Buffer.from(init.body as string | Uint8Array);
    calls.push({ method, url, auth: headers.get("authorization"), type: headers.get("content-type"), body, headers });
    const forced = before.shift();
    if (forced) return json(forced, { error: { code: forced, message: "forced" } });
    if (method === "GET" && url.startsWith(`${DRIVE_FILES_URL}/`)) {
      const item = items.get(decodeURIComponent(url.slice(DRIVE_FILES_URL.length + 1).split("?")[0]!));
      return item ? json(200, { id: item.id, trashed: item.trashed ?? false }) : json(404, { error: { code: 404, message: "File not found." } });
    }
    if (method === "POST" && url.startsWith(`${DRIVE_FILES_URL}?`)) {
      const meta = JSON.parse(body.toString("utf8")) as { name: string; mimeType: string; parents: string[] };
      assert.equal(meta.mimeType, "application/vnd.google-apps.folder");
      return json(200, { id: make(meta.name, meta.parents, true).id, name: meta.name });
    }
    if (method === "POST" && url.startsWith(`${DRIVE_UPLOAD_URL}?uploadType=multipart`)) {
      const boundary = /boundary=(\S+)/.exec(headers.get("content-type") ?? "")![1]!;
      const text = body.toString("latin1");
      const [, metaPart, mediaPart] = text.split(`--${boundary}`);
      const meta = JSON.parse(metaPart!.split("\r\n\r\n")[1]!.trim()) as { name: string; parents: string[] };
      const media = mediaPart!.slice(mediaPart!.indexOf("\r\n\r\n") + 4, -2);
      return json(200, view(make(meta.name, meta.parents, false, Buffer.from(media, "latin1"))));
    }
    if (method === "POST" && url.startsWith(`${DRIVE_UPLOAD_URL}?uploadType=resumable`)) {
      const meta = JSON.parse(body.toString("utf8")) as { name: string; parents: string[] };
      const session = `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s${sessions.size + 1}`;
      sessions.set(session, meta);
      return new Response(null, { status: 200, headers: { location: session } });
    }
    if (method === "PUT" && sessions.has(url)) {
      const meta = sessions.get(url)!;
      return json(200, view(make(meta.name, meta.parents, false, body)));
    }
    return json(400, { error: { code: 400, message: `unexpected ${method} ${url}` } });
  }) as typeof fetch;
  const deps = (statePath: string): Partial<DriveDeps> => ({
    fetcher,
    grant: async () => {
      asked += 1;
      return grants[Math.min(asked - 1, grants.length - 1)]!;
    },
    clearGrant: () => {
      cleared += 1;
    },
    statePath,
  });
  return { items, calls, before, deps, cleared: () => cleared };
}

const statePath = () => join(mkdtempSync(join(ROOT, "state-")), "drive.json");
const stub = (name: string, text: string) => ({ name, data: Buffer.from(text) });

test("the Cobra folder and the project's folder are made once, kept by account in drive.json, and used again", async () => {
  const fake = drive();
  const path = statePath();
  const first = await uploadToDrive([stub("stub-ana.pdf", "pdf bytes"), stub("stub-ben.pdf", "more pdf bytes")], { project: PROJECT, deps: fake.deps(path) });
  assert.deepEqual(first, [
    { name: "stub-ana.pdf", id: "id3", webViewLink: "https://drive.google.com/file/d/id3/view?usp=drivesdk" },
    { name: "stub-ben.pdf", id: "id4", webViewLink: "https://drive.google.com/file/d/id4/view?usp=drivesdk" },
  ]);
  const cobra = fake.items.get("id1")!;
  const project = fake.items.get("id2")!;
  assert.deepEqual([cobra.name, cobra.parents, cobra.folder], ["Cobra", ["root"], true]);
  assert.deepEqual([project.name, project.parents, project.folder], ["Paws & Paths Payroll", ["id1"], true]);
  assert.deepEqual(fake.items.get("id3")!.parents, ["id2"]);
  assert.equal(fake.items.get("id3")!.bytes!.toString(), "pdf bytes", "the bytes as they are");
  assert.ok(fake.calls.every((call) => call.auth === "Bearer ya29.drive-token"));
  // Kept private, per account (by its address in lower case), project by id.
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { accounts: { "penny@gmail.com": { root: { id: "id1", name: "Cobra" }, projects: { payroll: { id: "id2", name: "Paws & Paths Payroll" } } } } });

  // The next upload checks the kept folders and makes none.
  fake.calls.length = 0;
  const again = await uploadToDrive([stub("stub-ana.pdf", "november")], { project: PROJECT, deps: fake.deps(path) });
  assert.equal(again[0]!.id, "id5");
  assert.deepEqual(fake.items.get("id5")!.parents, ["id2"]);
  assert.deepEqual(fake.calls.map((call) => `${call.method} ${call.url.split("?")[0]}`), [`GET ${DRIVE_FILES_URL}/id1`, `GET ${DRIVE_FILES_URL}/id2`, `POST ${DRIVE_UPLOAD_URL}`]);
  // Two of one name sit side by side in Drive: October's stub is still there.
  assert.equal(fake.items.get("id3")!.bytes!.toString(), "pdf bytes");
});

test("a kept folder that answers 404 or sits in the bin is made again, and drive.json follows", async () => {
  const fake = drive();
  const path = statePath();
  await uploadToDrive([stub("a.txt", "a")], { project: PROJECT, deps: fake.deps(path) });
  // The person deleted the project's folder for good.
  fake.items.delete("id2");
  await uploadToDrive([stub("b.txt", "b")], { project: PROJECT, deps: fake.deps(path) });
  const remade = fake.items.get("id4")!;
  assert.deepEqual([remade.name, remade.parents], ["Paws & Paths Payroll", ["id1"]]);
  assert.deepEqual(fake.items.get("id5")!.parents, ["id4"]);
  assert.deepEqual(readDriveState(path).accounts["penny@gmail.com"]!.projects.payroll, { id: "id4", name: "Paws & Paths Payroll" });

  // The Cobra folder went to the bin: a new one, and the project's folder made again inside it.
  fake.items.get("id1")!.trashed = true;
  await uploadToDrive([stub("c.txt", "c")], { project: PROJECT, deps: fake.deps(path) });
  assert.deepEqual(readDriveState(path).accounts["penny@gmail.com"], { root: { id: "id6", name: "Cobra" }, projects: { payroll: { id: "id7", name: "Paws & Paths Payroll" } } });
  assert.deepEqual(fake.items.get("id7")!.parents, ["id6"]);

  // A renamed project gets a folder of its new name, as the card says.
  await uploadToDrive([stub("d.txt", "d")], { project: { id: "payroll", name: "Payroll 2027" }, deps: fake.deps(path) });
  assert.equal(fake.items.get("id9")!.name, "Payroll 2027");
});

test("up to 5 MB goes up multipart; above, a resumable session; over 100 MB is refused before anything goes up", async () => {
  const fake = drive();
  const path = statePath();
  const small = { name: "small.pdf", data: new Uint8Array(MULTIPART_MAX_BYTES).fill(1) };
  const large = { name: "large.pdf", data: new Uint8Array(MULTIPART_MAX_BYTES + 1).fill(2) };
  const done = await uploadToDrive([small, large], { project: PROJECT, deps: fake.deps(path) });
  assert.deepEqual(done.map((file) => file.name), ["small.pdf", "large.pdf"]);
  const uploads = fake.calls.filter((call) => call.url.includes("/upload/") || call.method === "PUT");
  assert.equal(uploads.length, 3);
  assert.match(uploads[0]!.url, /uploadType=multipart&fields=id,name,webViewLink$/);
  assert.match(uploads[0]!.type ?? "", /^multipart\/related; boundary=cobra_[0-9a-f]+$/);
  assert.ok(uploads[0]!.body.toString("latin1").includes("Content-Type: application/pdf\r\n\r\n"), "the type from the name");
  assert.match(uploads[1]!.url, /uploadType=resumable&fields=id,name,webViewLink$/);
  assert.equal(uploads[1]!.headers.get("x-upload-content-type"), "application/pdf");
  assert.equal(uploads[1]!.headers.get("x-upload-content-length"), String(MULTIPART_MAX_BYTES + 1));
  assert.equal(uploads[2]!.method, "PUT");
  assert.equal(uploads[2]!.body.length, MULTIPART_MAX_BYTES + 1);
  assert.equal(fake.items.get("id4")!.bytes!.length, MULTIPART_MAX_BYTES + 1);

  const before = fake.calls.length;
  await assert.rejects(uploadToDrive([stub("ok.txt", "x"), { name: "huge.bin", data: new Uint8Array(MAX_DRIVE_FILE_BYTES + 1) }], { project: PROJECT, deps: fake.deps(path) }), /huge\.bin is 100 MB and a file goes to Drive at most 100 MB, so nothing was uploaded/);
  assert.equal(fake.calls.length, before);
});

test("a 401 drops the grant and tries once more; a second one says connect again", async () => {
  const fresh = { ...GRANT, accessToken: "ya29.fresh-token" };
  const fake = drive([GRANT, fresh]);
  const path = statePath();
  fake.before.push(401);
  const done = await uploadToDrive([stub("a.txt", "a")], { project: PROJECT, deps: fake.deps(path) });
  assert.equal(done.length, 1);
  assert.equal(fake.cleared(), 1);
  assert.equal(fake.calls[0]!.auth, "Bearer ya29.drive-token");
  assert.ok(fake.calls.slice(1).every((call) => call.auth === "Bearer ya29.fresh-token"));

  const twice = drive([GRANT, fresh]);
  twice.before.push(401, 401);
  await assert.rejects(uploadToDrive([stub("a.txt", "a")], { project: PROJECT, deps: twice.deps(statePath()) }), (error: unknown) => error instanceof GoogleAuthError && error.problem === "google_reconnect");
  assert.equal(twice.calls.length, 2);
});

test("a refusal partway is a DriveUploadError holding what went up; Google's words, never the token", async () => {
  const fake = drive();
  const path = statePath();
  await uploadToDrive([stub("a.txt", "a")], { project: PROJECT, deps: fake.deps(path) });
  // Two folder checks pass, the first file goes up, the second is refused.
  fake.before.push(0, 0, 0, 403);
  await assert.rejects(uploadToDrive([stub("b.txt", "b"), stub("c.txt", "c")], { project: PROJECT, deps: fake.deps(path) }), (error: unknown) => {
    assert.ok(error instanceof DriveUploadError);
    assert.deepEqual(error.uploaded.map((file) => file.name), ["b.txt"]);
    assert.equal(error.failed, "c.txt");
    assert.match(error.message, /^Google Drive refused this Google account \(Google said: 403 forced\)$/);
    assert.ok(!error.message.includes("ya29"));
    return true;
  });
});

test("drive.json refused as a private file is said, and a garbled one starts over; folder names are one tidy line", async () => {
  const path = statePath();
  writeFileSync(path, "{}", { mode: 0o644 });
  chmodSync(path, 0o644);
  await assert.rejects(uploadToDrive([stub("a.txt", "a")], { project: PROJECT, deps: drive().deps(path) }), /drive\.json was refused: it is mode 644/);
  chmodSync(path, 0o600);
  writeFileSync(path, "not json");
  assert.deepEqual(readDriveState(path), { accounts: {} });
  assert.equal(driveFolderName("  Payroll / Q4\n2026 "), "Payroll - Q4 2026");
  assert.equal(driveFolderName("   "), "Project");
});
