import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trustPath } from "./trust.ts";

async function config(contents: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cp-trust-"));
  const path = join(dir, ".claude.json");
  if (contents !== null) await writeFile(path, contents, { mode: 0o600 });
  return path;
}

test("the one key is set and everything else is preserved", async () => {
  // Claude keeps real settings in this file. Losing them to a trust write would
  // be a far worse bug than the dialog this avoids.
  const path = await config(
    JSON.stringify({
      numStartups: 42,
      oauthAccount: { emailAddress: "someone@example.com" },
      projects: {
        "/home/me/cobra": { hasTrustDialogAccepted: true, history: ["a", "b"] },
      },
    }),
  );

  const result = await trustPath("/home/me/Projects/new-thing", path);
  assert.deepEqual(result, { trusted: true });

  const after = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.equal(after.numStartups, 42);
  assert.deepEqual(after.oauthAccount, { emailAddress: "someone@example.com" });
  const projects = after.projects as Record<string, Record<string, unknown>>;
  assert.deepEqual(projects["/home/me/cobra"], {
    hasTrustDialogAccepted: true,
    history: ["a", "b"],
  });
  assert.deepEqual(projects["/home/me/Projects/new-thing"], { hasTrustDialogAccepted: true });
});

test("an existing project keeps its other keys", async () => {
  const path = await config(
    JSON.stringify({ projects: { "/home/me/x": { history: ["kept"] } } }),
  );
  await trustPath("/home/me/x", path);
  const after = JSON.parse(await readFile(path, "utf8")) as {
    projects: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(after.projects["/home/me/x"], {
    history: ["kept"],
    hasTrustDialogAccepted: true,
  });
});

test("an already-trusted path is not rewritten at all", async () => {
  // Not writing is strictly better than a no-op rewrite that could still lose a
  // race with a running session.
  const path = await config(
    JSON.stringify({ projects: { "/home/me/x": { hasTrustDialogAccepted: true } } }),
  );
  const before = (await stat(path)).mtimeMs;
  const result = await trustPath("/home/me/x", path);
  assert.deepEqual(result, { trusted: true });
  assert.equal((await stat(path)).mtimeMs, before);
});

test("an unparseable config is refused, never replaced", async () => {
  const path = await config('{"projects": {"/x": {} ');
  const result = await trustPath("/home/me/x", path);
  assert.equal(result.trusted, false);
  assert.match(result.reason ?? "", /could not be parsed/);
  // The damaged file is left exactly as it was: it is someone else's mid-write.
  assert.equal(await readFile(path, "utf8"), '{"projects": {"/x": {} ');
});

test("a config that is not an object is refused", async () => {
  const path = await config("[1, 2, 3]");
  const result = await trustPath("/home/me/x", path);
  assert.equal(result.trusted, false);
  assert.match(result.reason ?? "", /not an object/);
});

test("no config yet means Claude has never run; one is created", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cp-trust-"));
  const path = join(dir, ".claude.json");
  assert.deepEqual(await trustPath("/home/me/x", path), { trusted: true });
  const after = JSON.parse(await readFile(path, "utf8")) as {
    projects: Record<string, unknown>;
  };
  assert.deepEqual(after.projects["/home/me/x"], { hasTrustDialogAccepted: true });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("the existing mode is preserved, not assumed", async () => {
  const path = await config(JSON.stringify({ projects: {} }));
  await chmod(path, 0o640);
  await trustPath("/home/me/x", path);
  assert.equal((await stat(path)).mode & 0o777, 0o640);
});
