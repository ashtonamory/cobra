import assert from "node:assert/strict";
import { test } from "node:test";

import { switchTestMode, type OrchMode, type SwitchDeps } from "./testSwitch.ts";

function fake(on: boolean | null, lead: OrchMode | null, foremen: Array<{ project: string; mode: OrchMode }>, fail?: string) {
  const did: string[] = [];
  const deps: SwitchDeps = {
    on: () => on,
    note: (value) => void did.push(`note ${value}`),
    lead: async () => lead,
    restartLead: async () => void did.push("lead"),
    foremen: async () => foremen,
    async restartForeman(project) {
      if (project === fail) throw new Error("no key");
      did.push(project);
    },
    log: (line) => void did.push(`log ${line}`),
  };
  return { deps, did };
}

test("turning test mode on restarts a tmux Lead and Foremen; a headless one, and a stopped one, are left", async () => {
  const { deps, did } = fake(true, "tmux", [{ project: "cobra", mode: "tmux" }, { project: "stable", mode: "headless" }]);
  assert.equal(await switchTestMode(deps), 2);
  assert.deepEqual(did.filter((line) => !line.startsWith("log")), ["note true", "lead", "cobra"]);
  const stopped = fake(true, null, []);
  assert.equal(await switchTestMode(stopped.deps), 0);
});

test("turning it off brings them back to tmux; a failed restart is logged and the rest still move", async () => {
  const { deps, did } = fake(false, "headless", [{ project: "cobra", mode: "headless" }, { project: "stable", mode: "headless" }], "cobra");
  assert.equal(await switchTestMode(deps), 2);
  assert.ok(did.includes("stable"));
  assert.ok(did.some((line) => /could not restart the Foreman for cobra: no key/.test(line)));
});

test("before the gateway's first read nothing moves, so an agent restart never restarts them", async () => {
  const { deps, did } = fake(null, "headless", [{ project: "cobra", mode: "headless" }]);
  assert.equal(await switchTestMode(deps), 0);
  assert.deepEqual(did, []);
});
