import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  backoffMs,
  branchName,
  commitToRepo,
  createHub,
  deliveryTimeoutMs,
  effectiveFilesConfig,
  type FilesConfig,
  GhError,
  ghStatus,
  httpDeliver,
  loadFilesConfig,
  type Push,
  readSendRequest,
  receiveFile,
  safeName,
  slug,
  uniqueName,
} from "./files.ts";
import { SessionError } from "./sessions.ts";

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

test("branch names are dated, slugged and numbered on retry", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  assert.equal(branchName("Invoice #42 (final).PDF", now), "chore/inbox-2026-09-30-invoice-42-final");
  assert.equal(branchName("é.png", now, 3), "chore/inbox-2026-09-30-e-3");
  assert.equal(slug("🙂.jpg"), "file");
});

test("backoff grows to five minutes and stops", () => {
  assert.equal(backoffMs(0), 0);
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 60_000);
  assert.equal(backoffMs(10), 300_000);
});

test("ghStatus reads the HTTP status out of gh's message", () => {
  assert.equal(ghStatus("gh: Not Found (HTTP 404)"), 404);
  assert.equal(ghStatus("error connecting to api.github.com"), null);
});

test("a send needs a repo or a device, and a repo must be owner/name", () => {
  assert.equal(typeof readSendRequest({ files: [] }), "string");
  assert.equal(typeof readSendRequest({ files: ["a"] }), "string");
  assert.equal(typeof readSendRequest({ files: ["a"], repo: "no-owner" }), "string");
  assert.equal(typeof readSendRequest({ files: ["a"], repo: "o/r; rm -rf /" }), "string");
  assert.deepEqual(readSendRequest({ files: ["a"], repo: "o/r" }), { files: ["a"], repo: "o/r", devices: undefined });
  assert.deepEqual(readSendRequest({ files: ["a"], devices: ["x", "x"] }), { files: ["a"], repo: undefined, devices: ["x"] });
});

test("receiveFile writes under a fresh name and never leaves a .part behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-recv-"));
  try {
    const first = await receiveFile(body("one"), "note.txt", dir, 100);
    const second = await receiveFile(body("two"), "note.txt", dir, 100);
    assert.equal(first.path, join(dir, "note.txt"));
    assert.equal(second.path, join(dir, "note (2).txt"));
    assert.equal(readFileSync(second.path, "utf8"), "two");
    await assert.rejects(receiveFile(body("x".repeat(200)), "big.bin", dir, 100), (error: unknown) =>
      error instanceof SessionError && error.status === 413,
    );
    assert.deepEqual(readdirSync(dir).sort(), ["note (2).txt", "note.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A stand-in for `gh api` that answers by path and records what was posted. */
function fakeGh(options: { inbox?: string[]; takenBranches?: string[]; emptyRepo?: boolean } = {}) {
  const posted: { path: string; body: unknown }[] = [];
  const taken = new Set(options.takenBranches ?? []);
  const gh = async (args: string[]): Promise<string> => {
    assert.equal(args[0], "api");
    const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
    const path = args.find((arg, index) => index > 0 && arg.startsWith("repos/"))!;
    const inputAt = args.indexOf("--input");
    const payload = inputAt === -1 ? undefined : JSON.parse(readFileSync(args[inputAt + 1]!, "utf8"));
    if (method === "GET") {
      if (path === "repos/o/r") return JSON.stringify({ default_branch: "main" });
      if (path === "repos/o/r/git/ref/heads/main") {
        if (options.emptyRepo) throw new GhError("Git Repository is empty.", 409);
        return JSON.stringify({ object: { sha: "base" } });
      }
      if (path === "repos/o/r/git/commits/base") return JSON.stringify({ tree: { sha: "basetree" } });
      if (path.startsWith("repos/o/r/contents/inbox")) {
        if (!options.inbox) throw new GhError("Not Found", 404);
        return JSON.stringify(options.inbox.map((name) => ({ name })));
      }
    }
    posted.push({ path, body: payload });
    if (path.endsWith("/git/blobs")) return JSON.stringify({ sha: `blob${posted.length}` });
    if (path.endsWith("/git/trees")) return JSON.stringify({ sha: "tree" });
    if (path.endsWith("/git/commits")) return JSON.stringify({ sha: "commit" });
    if (path.endsWith("/git/refs")) {
      const ref = (payload as { ref: string }).ref.replace("refs/heads/", "");
      if (taken.has(ref)) throw new GhError("Reference already exists", 422);
      return JSON.stringify({ ref });
    }
    if (path.endsWith("/pulls")) return JSON.stringify({ number: 7, html_url: "https://github.com/o/r/pull/7" });
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { gh, posted };
}

test("commitToRepo builds blob → tree → commit → branch → PR off the default branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-commit-"));
  try {
    writeFileSync(join(dir, "blob"), "hello");
    const { gh, posted } = fakeGh({ inbox: ["invoice.pdf"], takenBranches: ["chore/inbox-2026-09-30-invoice"] });
    const outcome = await commitToRepo(gh, {
      repo: "o/r",
      inbox: "inbox",
      files: [{ name: "invoice.pdf", size: 5, blobPath: join(dir, "blob") }],
      now: new Date("2026-09-30T12:00:00Z"),
      tmpDir: join(dir, "tmp"),
    });
    // The inbox already had an invoice.pdf, and today's branch was taken.
    assert.deepEqual(outcome.paths, ["inbox/invoice (2).pdf"]);
    assert.equal(outcome.branch, "chore/inbox-2026-09-30-invoice-2");
    assert.deepEqual(outcome.pr, { number: 7, url: "https://github.com/o/r/pull/7" });

    const blob = posted.find((entry) => entry.path.endsWith("/git/blobs"))!.body as { content: string; encoding: string };
    assert.equal(Buffer.from(blob.content, "base64").toString(), "hello");
    const tree = posted.find((entry) => entry.path.endsWith("/git/trees"))!.body as { base_tree: string };
    assert.equal(tree.base_tree, "basetree");
    const commit = posted.find((entry) => entry.path.endsWith("/git/commits"))!.body as { parents: string[]; message: string };
    assert.deepEqual(commit.parents, ["base"]);
    assert.equal(commit.message, "Add invoice (2).pdf to inbox/");
    const pr = posted.find((entry) => entry.path.endsWith("/pulls"))!.body as { base: string; head: string };
    assert.equal(pr.base, "main");
    assert.equal(pr.head, "chore/inbox-2026-09-30-invoice-2");
    // Temporary request bodies are cleaned up.
    assert.deepEqual(readdirSync(join(dir, "tmp")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CONFIG: FilesConfig = {
  hub: "hub",
  inbox: "inbox",
  maxBytes: 1000,
  retainDays: 30,
  devices: {
    hub: { label: "Mini", url: "https://hub.example" },
    laptop: { label: "Legion", url: "https://laptop.example" },
  },
  exports: {},
};

function hubFixture(options: { gh?: ReturnType<typeof fakeGh>["gh"]; online?: () => boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cp-hub-"));
  const drop = join(root, "drop");
  let clock = Date.parse("2026-09-30T12:00:00Z");
  const pushes: Push[] = [];
  const delivered: string[] = [];
  const hub = createHub({
    root: join(root, "state"),
    dropDir: drop,
    hostname: "hub",
    config: async () => CONFIG,
    gh: options.gh ?? fakeGh().gh,
    deliver: async (target, blobPath, name) => {
      if (options.online && !options.online()) throw new Error(`${target.label} is not reachable`);
      delivered.push(`${target.label}:${name}:${readFileSync(blobPath, "utf8")}`);
      return { path: `/home/x/Downloads/cp/${name}`, size: 1 };
    },
    push: async (message) => {
      pushes.push(message);
    },
    now: () => clock,
  });
  return {
    hub,
    root,
    drop,
    pushes,
    delivered,
    advance: (ms: number) => {
      clock += ms;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a send to a repo and two machines: PR pushed, hub copy local, laptop copy remote", async () => {
  const fx = hubFixture();
  try {
    const upload = await fx.hub.upload(body("pdf bytes"), "invoice.pdf", null);
    await fx.hub.send({ files: [upload.id], repo: "o/r", devices: ["hub", "laptop"] });
    await fx.hub.pump();
    const [record] = (await fx.hub.list()).sends;
    assert.equal(record!.repo!.status, "done");
    assert.equal(record!.repo!.pr!.number, 7);
    assert.deepEqual(record!.devices.map((d) => d.status), ["delivered", "delivered"]);
    assert.equal(readFileSync(join(fx.drop, "invoice.pdf"), "utf8"), "pdf bytes");
    assert.deepEqual(fx.delivered, ["Legion:invoice.pdf:pdf bytes"]);
    // Only the PR is news; immediate deliveries were what the sheet promised.
    assert.deepEqual(fx.pushes.map((p) => p.data.kind), ["pr-opened"]);
  } finally {
    fx.cleanup();
  }
});

test("an offline machine is queued, retried with backoff, and announced when it lands", async () => {
  let online = false;
  const fx = hubFixture({ online: () => online });
  try {
    const upload = await fx.hub.upload(body("x"), "photo.jpg", null);
    await fx.hub.send({ files: [upload.id], devices: ["laptop"] });
    await fx.hub.pump();
    let delivery = (await fx.hub.list()).sends[0]!.devices[0]!;
    assert.equal(delivery.status, "queued");
    assert.equal(delivery.attempts, 1);
    assert.match(delivery.lastError!, /not reachable/);

    online = true;
    await fx.hub.pump(); // still inside the 30 s backoff: not tried
    assert.equal((await fx.hub.list()).sends[0]!.devices[0]!.attempts, 1);

    fx.advance(31_000);
    await fx.hub.pump();
    delivery = (await fx.hub.list()).sends[0]!.devices[0]!;
    assert.equal(delivery.status, "delivered");
    assert.deepEqual(fx.pushes.map((p) => [p.data.kind, p.title]), [["delivered", "Delivered to Legion"]]);
  } finally {
    fx.cleanup();
  }
});

test("a repo GitHub refuses fails once, with a push, and can be retried", async () => {
  const fx = hubFixture({ gh: fakeGh({ emptyRepo: true }).gh });
  try {
    const upload = await fx.hub.upload(body("x"), "a.txt", null);
    const sent = await fx.hub.send({ files: [upload.id], repo: "o/r" });
    await fx.hub.pump();
    const repo = (await fx.hub.list()).sends[0]!.repo!;
    assert.equal(repo.status, "failed");
    assert.match(repo.error!, /empty/);
    assert.deepEqual(fx.pushes.map((p) => p.data.kind), ["failed"]);
    await fx.hub.retry(sent.id);
    await fx.hub.pump();
    assert.equal((await fx.hub.list()).sends[0]!.repo!.status, "failed");
  } finally {
    fx.cleanup();
  }
});

test("uploads are capped, refused off the hub, and pruned with their send", async () => {
  const fx = hubFixture();
  try {
    await assert.rejects(fx.hub.upload(body("x".repeat(2000)), "big.bin", null), (error: unknown) =>
      error instanceof SessionError && error.status === 413,
    );
    await assert.rejects(fx.hub.upload(body("x"), "big.bin", 5000), (error: unknown) =>
      error instanceof SessionError && error.status === 413,
    );
    await assert.rejects(fx.hub.send({ files: ["0".repeat(24)], devices: ["laptop"] }), (error: unknown) =>
      error instanceof SessionError && error.status === 404,
    );
    await assert.rejects(fx.hub.send({ files: [(await fx.hub.upload(body("x"), "a", null)).id], devices: ["toaster"] }), (error: unknown) =>
      error instanceof SessionError && error.status === 400,
    );

    const upload = await fx.hub.upload(body("x"), "a.txt", null);
    // The upload's age is its file's time: put it on the fixture's clock, not the real one, or the test breaks once the real date nears the fixture's.
    const uploads = join(fx.root, "state", "uploads");
    const written = Date.parse("2026-09-30T12:00:00Z") / 1000;
    for (const name of readdirSync(uploads).filter((n) => n.startsWith(upload.id))) utimesSync(join(uploads, name), written, written);
    await fx.hub.send({ files: [upload.id], devices: ["hub"] });
    await fx.hub.pump();
    assert.equal((await fx.hub.list()).sends.length, 1);
    fx.advance(31 * 86_400_000);
    await fx.hub.pump();
    assert.equal((await fx.hub.list()).sends.length, 0);
    assert.deepEqual(readdirSync(join(fx.root, "state", "uploads")).filter((name) => name.startsWith(upload.id)), []);
  } finally {
    fx.cleanup();
  }

  const off = createHub({
    root: mkdtempSync(join(tmpdir(), "cp-off-")),
    dropDir: "/nonexistent",
    hostname: "laptop",
    config: async () => CONFIG,
    gh: null,
    deliver: async () => ({ path: "", size: 0 }),
    push: async () => {},
  });
  await assert.rejects(off.upload(body("x"), "a", null), (error: unknown) =>
    error instanceof SessionError && error.status === 409,
  );
});

test("the delivery timeout is whole milliseconds for any size", () => {
  assert.equal(deliveryTimeoutMs(10), 30_000);
  // The real 14 MB manual that failed as "not reachable": 287762.68 before.
  assert.equal(deliveryTimeoutMs(14_388_134), 287_763);
  for (const bytes of [1_500_001, 14_388_134, 52_428_799]) {
    assert.ok(Number.isInteger(deliveryTimeoutMs(bytes)));
    AbortSignal.timeout(deliveryTimeoutMs(bytes)); // throws on a fraction
  }
});

test("cancel stops queued copies and a pending PR; retry brings them back", async () => {
  let online = false;
  const fx = hubFixture({ online: () => online });
  try {
    const upload = await fx.hub.upload(body("x"), "manual.pdf", null);
    const sent = await fx.hub.send({ files: [upload.id], devices: ["laptop", "hub"] });
    await fx.hub.pump();
    // The hub's own copy landed; the laptop's is queued.
    assert.deepEqual((await fx.hub.list()).sends[0]!.devices.map((d) => d.status), ["queued", "delivered"]);

    const cancelled = await fx.hub.cancel(sent.id);
    assert.deepEqual(cancelled.devices.map((d) => d.status), ["cancelled", "delivered"]);
    online = true;
    fx.advance(10 * 60_000);
    await fx.hub.pump();
    assert.equal((await fx.hub.list()).sends[0]!.devices[0]!.status, "cancelled");
    assert.deepEqual(fx.delivered, []);
    await assert.rejects(fx.hub.cancel(sent.id), (error: unknown) => error instanceof SessionError && error.status === 409);

    await fx.hub.retry(sent.id);
    await fx.hub.pump();
    assert.equal((await fx.hub.list()).sends[0]!.devices[0]!.status, "delivered");
  } finally {
    fx.cleanup();
  }
});

test("files.json: each target carries its own peer key, and no file means no hub", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-files-config-"));
  try {
    const path = join(dir, "files.json");
    assert.equal((await loadFilesConfig(path)).hub, "");
    writeFileSync(
      path,
      JSON.stringify({
        hub: "mini",
        devices: {
          omarchy: { label: "Legion", url: "https://omarchy.example.ts.net/", key: "k".repeat(43) },
          macbook: { label: "MacBook", url: "https://macbook.example.ts.net" },
          plain: { label: "Plain", url: "http://insecure.example" },
        },
      }),
      { mode: 0o600 },
    );
    const config = await loadFilesConfig(path);
    assert.equal(config.hub, "mini");
    assert.deepEqual(config.devices.omarchy, { label: "Legion", url: "https://omarchy.example.ts.net", key: "k".repeat(43) });
    assert.equal(config.devices.macbook?.key, undefined);
    assert.equal(config.devices.plain, undefined);
    // Peer keys live here: a file other accounts can read is not trusted.
    chmodSync(path, 0o644);
    assert.equal((await loadFilesConfig(path)).hub, "");
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
    // The computer that is not the hub still keeps its own export folders: they are local, not fleet-wide.
    assert.deepEqual(effectiveFilesConfig(config, "laptop", "Legion").exports, config.exports);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delivery without a peer key is refused before any bytes move", async () => {
  await assert.rejects(httpDeliver()({ label: "Legion", url: "https://omarchy.example.ts.net" }, "/nonexistent", "a.txt", "send-1"), /no delivery key/);
});

test("this computer is its own hub and only device, whatever files.json names", () => {
  const direct = effectiveFilesConfig(CONFIG, "laptop", "Legion");
  assert.equal(direct.hub, "laptop");
  assert.deepEqual(Object.keys(direct.devices), ["laptop"]);
  assert.equal(direct.maxBytes, CONFIG.maxBytes);
  // A files.json that names this computer as a hub of other devices still delivers only here.
  assert.deepEqual(Object.keys(effectiveFilesConfig(CONFIG, "hub", "Mini").devices), ["hub"]);
  const bare = effectiveFilesConfig({ ...CONFIG, devices: {} }, "hub", "Mini");
  assert.deepEqual(Object.keys(bare.devices), ["hub"]);
  // No files.json at all: still takes its own files.
  const none = effectiveFilesConfig({ ...CONFIG, hub: "", devices: {} }, "laptop", "Legion");
  assert.equal(none.hub, "laptop");
});

test("a file sent straight to a computer that is not the hub lands in its drop folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "cp-direct-"));
  const drop = join(root, "Downloads", "Cobra");
  const delivered: string[] = [];
  try {
    const direct = createHub({
      root: join(root, "state"),
      dropDir: drop,
      hostname: "laptop",
      config: async () => effectiveFilesConfig(CONFIG, "laptop", "Legion"),
      gh: null,
      deliver: async (target) => {
        delivered.push(target.label);
        return { path: "", size: 0 };
      },
      push: async () => {},
    });
    const upload = await direct.upload(body("hello"), "note.txt", null);
    await direct.send({ files: [upload.id], devices: ["laptop"] });
    await direct.pump();
    assert.equal(readFileSync(join(drop, "note.txt"), "utf8"), "hello");
    assert.deepEqual(delivered, [], "written locally, never forwarded");
    assert.equal((await direct.list()).sends[0]?.devices[0]?.status, "delivered");
    // It forwards nothing: another computer is not one of its devices.
    await assert.rejects(direct.send({ files: [upload.id], devices: ["hub"] }), (error: unknown) =>
      error instanceof SessionError && error.status === 400,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
