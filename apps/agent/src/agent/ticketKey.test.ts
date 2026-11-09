import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTicketKey } from "./ticketKey.ts";

test("made once with mode 600, then the same key every time", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-ticket-"));
  try {
    const path = join(dir, "ticket.key");
    const first = loadTicketKey(path);
    assert.equal(first.refused, null);
    assert.match(first.key ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(loadTicketKey(path).key, first.key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a readable or empty key file is refused, never replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-ticket-"));
  try {
    const path = join(dir, "ticket.key");
    writeFileSync(path, "short\n", { mode: 0o600 });
    assert.deepEqual(loadTicketKey(path), { key: null, refused: "it holds no usable key" });
    writeFileSync(path, `${"k".repeat(43)}\n`);
    chmodSync(path, 0o640);
    assert.match(loadTicketKey(path).refused ?? "", /mode 640/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
