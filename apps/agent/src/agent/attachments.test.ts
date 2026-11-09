import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import { ATTACHMENTS_DIR, imageKind, pruneAttachments, refuseName, saveAttachment, sniff } from "./attachments.ts";
import { scopeFor } from "./auth.ts";
import { decide, realPath, sandboxDenyRead, type WorkerScope } from "./policy.ts";
import { SessionError } from "./sessions.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32, 3)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(32)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(32)]);

/** The body in small pieces, so the type check has to put the head together. */
function body(bytes: Buffer, chunk = 5): Readable {
  const parts: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += chunk) parts.push(bytes.subarray(at, at + chunk));
  return Readable.from(parts);
}

function folder(): { root: string; done: () => void } {
  const base = mkdtempSync(join(tmpdir(), "attach-"));
  const root = join(base, "project");
  mkdirSync(root);
  return { root, done: () => rmSync(base, { recursive: true, force: true }) };
}

async function refusal(promise: Promise<unknown>): Promise<SessionError> {
  try {
    await promise;
  } catch (caught) {
    assert.ok(caught instanceof SessionError, String(caught));
    return caught;
  }
  assert.fail("expected a refusal");
}

const save = (root: string, bytes: Buffer, name = "shot.png", maxBytes = 1024) =>
  saveAttachment({ root, name, body: body(bytes), maxBytes, retainDays: 7 });

test("imageKind reads the first bytes, never the name", () => {
  assert.equal(imageKind(PNG), ".png");
  assert.equal(imageKind(JPEG), ".jpg");
  assert.equal(imageKind(GIF), ".gif");
  assert.equal(imageKind(WEBP), ".webp");
  assert.equal(imageKind(HEIC), null);
  assert.equal(imageKind(Buffer.from("%PDF-1.7 hello")), null);
  assert.equal(imageKind(Buffer.alloc(0)), null);
});

test("refuseName takes the four image types and names HEIC", () => {
  for (const name of ["a.png", "B.JPG", "c.jpeg", "d.gif", "e.webp"]) assert.equal(refuseName(name), null, name);
  assert.match(refuseName("IMG_0001.HEIC") ?? "", /HEIC/);
  assert.match(refuseName("photo.heif") ?? "", /HEIC/);
  assert.match(refuseName("notes.txt") ?? "", /only PNG, JPEG, GIF and WebP/);
  assert.match(refuseName("") ?? "", /only PNG/);
});

test("sniff hands back every byte after reading the head", async () => {
  const { kind, bytes } = await sniff(body(JPEG, 3));
  assert.equal(kind, ".jpg");
  const chunks: Buffer[] = [];
  for await (const chunk of bytes) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), JPEG);
});

test("an image lands in the session's folder, under a name of its own type, and git ignores it", async () => {
  const { root, done } = folder();
  try {
    execFileSync("git", ["init", "-q", root]);
    const saved = await save(root, WEBP, "screenshot.png");
    const dir = join(realpathSync(root), ATTACHMENTS_DIR);
    assert.equal(dirname(saved.path), dir);
    assert.match(saved.path, /\/\d{8}-\d{6}-[0-9a-f]{8}\.webp$/);
    assert.equal(saved.size, WEBP.length);
    assert.deepEqual(readFileSync(saved.path), WEBP);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8").trim().split("\n").at(-1), "*");
    assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }), "");
    // No unfinished copy is left beside it.
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".part")), []);
  } finally {
    done();
  }
});

test("a Worker may read the image without a prompt, and its sandbox does not hide it", async () => {
  const { root, done } = folder();
  try {
    const saved = await save(root, PNG);
    const worktree = realpathSync(root);
    const scope: WorkerScope = { id: "w", worktree, gitCommon: join(worktree, ".git"), gitPrivate: join(worktree, ".git"), branch: "feat/x" };
    const verdict = decide({ tool_name: "Read", tool_input: { file_path: saved.path }, cwd: worktree }, scope, {
      real: realPath,
      home: dirname(dirname(worktree)),
    });
    assert.equal(verdict.decision, "allow", verdict.reason);
    assert.ok(!sandboxDenyRead().some((pattern) => pattern.includes(ATTACHMENTS_DIR)));
  } finally {
    done();
  }
});

test("bytes that are not an image are refused with 415, and nothing is kept", async () => {
  const { root, done } = folder();
  try {
    const caught = await refusal(save(root, Buffer.from("#!/bin/sh\necho hi\n"), "evil.png"));
    assert.equal(caught.status, 415);
    assert.equal(existsSync(join(root, ATTACHMENTS_DIR)), false);
  } finally {
    done();
  }
});

test("HEIC is refused by name and by content", async () => {
  const { root, done } = folder();
  try {
    assert.match((await refusal(save(root, HEIC, "IMG_0001.heic"))).message, /HEIC/);
    const disguised = await refusal(save(root, HEIC, "IMG_0001.jpg"));
    assert.equal(disguised.status, 415);
    assert.match(disguised.message, /HEIC/);
  } finally {
    done();
  }
});

test("a name that is not an image is refused before a byte is read", async () => {
  const { root, done } = folder();
  try {
    const caught = await refusal(save(root, PNG, "notes.txt"));
    assert.equal(caught.status, 415);
  } finally {
    done();
  }
});

test("an image over the limit is refused with 413, and the partial copy removed", async () => {
  const { root, done } = folder();
  try {
    const big = Buffer.concat([PNG, Buffer.alloc(4096)]);
    const caught = await refusal(save(root, big, "big.png", 1024));
    assert.equal(caught.status, 413);
    assert.match(caught.message, /over the 1 KB limit/);
    assert.deepEqual(readdirSync(join(root, ATTACHMENTS_DIR)).filter((name) => name !== ".gitignore"), []);
  } finally {
    done();
  }
});

test("an attachments folder that is a link elsewhere is refused", async () => {
  const { root, done } = folder();
  try {
    const elsewhere = join(dirname(root), "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, ATTACHMENTS_DIR));
    const caught = await refusal(save(root, PNG));
    assert.equal(caught.status, 409);
    assert.deepEqual(readdirSync(elsewhere), []);
  } finally {
    done();
  }
});

test("a session whose folder is gone is refused", async () => {
  const caught = await refusal(save("/nonexistent/cobra-attach-test", PNG));
  assert.equal(caught.status, 409);
});

test("pruning removes only this module's old files", async () => {
  const { root, done } = folder();
  try {
    const now = new Date("2026-10-09T12:00:00Z");
    const fresh = await saveAttachment({ root, name: "a.png", body: body(PNG), maxBytes: 1024, retainDays: 7, now });
    const dir = dirname(fresh.path);
    const old = join(dir, "20260901-101010-0123abcd.png");
    const oldPart = join(dir, ".20260901-101010-0123abcd.jpg.89abcdef.part");
    const theirs = join(dir, "keep-me.png");
    for (const path of [old, oldPart, theirs]) writeFileSync(path, "x");
    const longAgo = new Date("2026-09-01T00:00:00Z");
    for (const path of [old, oldPart, theirs]) utimesSync(path, longAgo, longAgo);

    const removed = await pruneAttachments(dir, 7, now);
    assert.deepEqual(removed.sort(), [".20260901-101010-0123abcd.jpg.89abcdef.part", "20260901-101010-0123abcd.png"]);
    assert.ok(existsSync(fresh.path));
    assert.ok(existsSync(theirs));
    assert.ok(existsSync(join(dir, ".gitignore")));
  } finally {
    done();
  }
});

test("/session/attach needs the act scope", () => {
  assert.equal(scopeFor("/session/attach", "POST"), "act");
});
