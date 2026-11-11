import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { loadFilesConfig, safeName, streamToFile, TooLarge, uniqueName } from "./files.ts";

const body = (text: string) => Readable.from([Buffer.from(text)]);

test("safeName strips directories, control characters and a leading dot", () => {
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("C:\\Users\\a\\invoice.pdf"), "invoice.pdf");
  assert.equal(safeName(".env"), "env");
  assert.equal(safeName("a\u0000b\nc.txt"), "abc.txt");
  assert.equal(safeName("WhatsApp Image 2026-09-30 at 10.12.pdf"), "WhatsApp Image 2026-09-30 at 10.12.pdf");
  assert.equal(safeName("..."), null);
  assert.equal(safeName(""), null);
  const long = safeName(`${"x".repeat(400)}.pdf`)!;
  assert.ok(Buffer.byteLength(long) <= 180);
  assert.ok(long.endsWith(".pdf"));
});

test("uniqueName numbers a clash before the extension", () => {
  assert.equal(uniqueName("a.pdf", new Set()), "a.pdf");
  assert.equal(uniqueName("a.pdf", new Set(["a.pdf"])), "a (2).pdf");
  assert.equal(uniqueName("a.pdf", new Set(["a.pdf", "a (2).pdf"])), "a (3).pdf");
  assert.equal(uniqueName("README", new Set(["README"])), "README (2)");
});

test("streamToFile writes the whole body, and leaves nothing behind when it is over the limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-files-stream-"));
  try {
    const written = await streamToFile(body("hello"), join(dir, "a.txt"), 10);
    assert.equal(written.size, 5);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "hello");
    await assert.rejects(streamToFile(body("x".repeat(20)), join(dir, "b.txt"), 10), TooLarge);
    assert.deepEqual(readdirSync(dir), ["a.txt"], "no half-written file stays");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("files.json: limits fall back to the defaults, and an unreadable file gives them too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-files-config-"));
  try {
    const path = join(dir, "files.json");
    assert.deepEqual(await loadFilesConfig(path), { maxBytes: 50 * 1024 * 1024, retainDays: 30, exports: {} });
    writeFileSync(path, JSON.stringify({ maxBytes: 1024, retainDays: 7, hub: "old", devices: { x: { url: "https://x.example" } } }), { mode: 0o600 });
    // A files.json from before, naming a hub and other machines: those are ignored.
    assert.deepEqual(await loadFilesConfig(path), { maxBytes: 1024, retainDays: 7, exports: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("files.json: export folders need a slug key and an absolute path; the label falls back to the key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-files-exports-"));
  try {
    const path = join(dir, "files.json");
    assert.deepEqual((await loadFilesConfig(path)).exports, {});
    writeFileSync(
      path,
      JSON.stringify({
        exports: {
          drive: { label: "Drive", path: "/home/me/Drive/Payroll/" },
          "pay-stubs": { path: "/home/me/Drive/Stubs" },
          "Bad Key": { label: "x", path: "/home/me/x" },
          relative: { label: "x", path: "Drive/x" },
          dots: { label: "x", path: "/home/me/../root" },
          nopath: { label: "x" },
          "a-key-longer-than-forty-characters-is-dropped": { label: "x", path: "/x" },
        },
      }),
      { mode: 0o600 },
    );
    const config = await loadFilesConfig(path);
    assert.deepEqual(config.exports, { drive: { label: "Drive", path: "/home/me/Drive/Payroll" }, "pay-stubs": { label: "pay-stubs", path: "/home/me/Drive/Stubs" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
