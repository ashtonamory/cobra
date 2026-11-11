import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keptEntry, linkedId, writeDeskFile } from "./deskLink.ts";

const LINE = { machine: "omarchy", label: "laptop", loopback: "http://127.0.0.1:8787", tmuxSocket: "cobra", id: "desk_1", key: "k1", extra: "dropped" };

test("computers.json keeps the desk line's own keys, 0600 in a 0700 folder, and names the key it holds", () => {
  const home = mkdtempSync(join(tmpdir(), "desk-link-"));
  try {
    const file = join(home, "app.cobra.desktop", "computers.json");
    assert.equal(linkedId(file), null);
    writeDeskFile(file, keptEntry(LINE));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      agent: { machine: "omarchy", label: "laptop", loopback: "http://127.0.0.1:8787", tmuxSocket: "cobra", id: "desk_1", key: "k1" },
    });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, "app.cobra.desktop")).mode & 0o777, 0o700);
    assert.equal(linkedId(file), "desk_1");

    // A second link replaces the first in place.
    writeDeskFile(file, keptEntry({ ...LINE, id: "desk_2", key: "k2" }));
    assert.equal(linkedId(file), "desk_2");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a computers.json with no usable key names none", () => {
  const home = mkdtempSync(join(tmpdir(), "desk-link-"));
  try {
    const file = join(home, "computers.json");
    for (const body of ["not json", "{}", '{"agent":{"id":"desk_1"}}', '{"agent":{"id":"","key":"k"}}']) {
      writeFileSync(file, body);
      assert.equal(linkedId(file), null, body);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
