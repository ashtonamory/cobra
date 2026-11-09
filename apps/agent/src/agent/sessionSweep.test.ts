import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-sweep-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const s = await import("./sessionSweep.ts");

test("the sweep ends dead panes at once and an unknown agent session only the night after it was named", () => {
  const sessions = [
    { name: "cobra_lead", dead: false, command: "claude" },
    { name: "old_fm", dead: false, command: "claude" },
    { name: "stray_3", dead: false, command: "claude" },
    { name: "gone_2", dead: true, command: "bash" },
    { name: "my-shell", dead: false, command: "zsh" },
    { name: "devserver", dead: false, command: "pnpm" },
  ];
  const plan = s.sweepPlan(sessions, new Set(["cobra_lead"]), new Set(["stray_3"]));
  assert.deepEqual(plan.remove.map((one) => one.session), ["stray_3", "gone_2"]);
  assert.deepEqual(plan.unknown, ["old_fm"], "named tonight, ended tomorrow; your shell and dev server are never touched");
  assert.match(s.sweepReport(plan, ["stray_3", "gone_2"], ["w_1"])!, /^Ended 2 sessions nothing used: stray_3, gone_2\. One session no project or Worker names: old_fm\. If nothing claims it by tomorrow night, I end it\. 1 stopped Worker older than a week still keeps a worktree \(w_1\): Tidy can remove them\.$/);
  assert.equal(s.sweepReport({ remove: [], unknown: [] }, [], []), null);
});

test("the sweep is due once a local day, after 3:30", () => {
  const at = (hours: number, minutes = 0) => new Date(2026, 10, 2, hours, minutes);
  assert.equal(s.sweepDue(at(3, 29), null), false);
  assert.equal(s.sweepDue(at(3, 30), null), true);
  assert.equal(s.sweepDue(at(9), at(3, 31).getTime()), false, "ran today");
  assert.equal(s.sweepDue(at(9), new Date(2026, 10, 1, 4).getTime()), true, "ran yesterday");
});

test("the sweep's record survives a bad file", () => {
  const path = join(STATE, "sweep.json");
  assert.deepEqual(s.loadSweep(path), { lastRun: null, reported: [] });
  s.saveSweep({ lastRun: 5, reported: ["a"] }, path);
  assert.deepEqual(s.loadSweep(path), { lastRun: 5, reported: ["a"] });
});
