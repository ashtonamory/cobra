import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { awayFromLive } from "./paths.ts";

test("under node --test a default folder in the real home moves to a scratch folder; one the test names stays", () => {
  const home = userInfo().homedir;
  const live = join(home, ".local", "share", "cobra-agent");
  const moved = awayFromLive(live);
  assert.ok(!moved.startsWith(`${home}/`), `${moved} is not inside the real home`);
  assert.ok(moved.startsWith(tmpdir()), `${moved} is in the temp folder`);
  assert.ok(moved.endsWith(join(".local", "share", "cobra-agent")), "the same path inside the scratch folder");
  assert.equal(awayFromLive(join(home, "Spaces")).slice(0, -"Spaces".length), moved.slice(0, -join(".local", "share", "cobra-agent").length), "one scratch home per process");
  const named = join(tmpdir(), "cobra-x", "data");
  assert.equal(awayFromLive(named), named);
});
