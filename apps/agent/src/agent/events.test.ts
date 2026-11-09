import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readEvents, recordEvents } from "./events.ts";

const DAY = 24 * 60 * 60_000;

test("events are kept a week, read since a time, oldest first, private", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-events-"));
  try {
    const path = join(dir, "events.jsonl");
    const start = Date.parse("2026-10-01T22:00:00Z");
    recordEvents([{ kind: "finished", projectId: "web-app", projectName: "web-app" }], start, path);
    recordEvents([{ kind: "needs-input", projectId: "api", projectName: "api", detail: "Run the migration?" }], start + 3_600_000, path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readEvents(start + 1, path).map((event) => event.kind), ["needs-input"]);
    assert.deepEqual(readEvents(0, path).map((event) => event.projectId), ["web-app", "api"]);
    // A week later the first ones are pruned on the next write.
    recordEvents([{ kind: "finished", projectId: "blog", projectName: "blog" }], start + 8 * DAY, path);
    assert.deepEqual(readEvents(0, path).map((event) => event.projectId), ["blog"]);
    // A torn line does not lose the rest.
    appendFileSync(path, '{"at":"2026-10-0');
    assert.equal(readEvents(0, path).length, 1);
    assert.ok(readFileSync(path, "utf8").length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
