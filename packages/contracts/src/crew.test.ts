import { test } from "node:test";
import assert from "node:assert/strict";

import {
  autoForemanName,
  autoHat,
  cleanCrewName,
  crewLetter,
  CREW_HATS,
  foremanSpec,
  HEAD_CROP,
  COBRA_SPEC,
  spriteFrame,
  spriteRuns,
  SPRITE_STAGE,
  workerSpec,
} from "./crew.ts";

test("a Foreman's name starts with its project's letter, past a leading 'the'", () => {
  assert.equal(crewLetter("plant-shop"), "p");
  assert.equal(crewLetter("The Book"), "b");
  assert.equal(autoForemanName("plant-shop", "plant-shop").charAt(0), "P");
  assert.equal(autoForemanName("corner-bakery", "corner-bakery").charAt(0), "C");
});

test("the same project always gets the same name, and never the Lead's", () => {
  assert.equal(autoForemanName("cobra", "cobra"), autoForemanName("cobra", "cobra"));
  assert.ok(!/^jack/i.test(autoForemanName("cobra", "cobra")));
});

test("a taken name is passed over, and a full letter numbers the first", () => {
  const first = autoForemanName("sportsbook", "sportsbook");
  const second = autoForemanName("sportsbook", "sportsbook", [first]);
  assert.notEqual(first, second);
  assert.equal(second.charAt(0), "S");
  const all = ["Stan", "Sal", "Suki", "Sid"];
  assert.match(autoForemanName("sportsbook", "sportsbook", all), /^S\w+ 2$/);
});

test("a project with no letter still gets a name", () => {
  assert.ok(autoForemanName("2048", "2048").length > 0);
});

test("a hat already worn here is passed over", () => {
  const hat = autoHat("cobra");
  assert.ok(hat >= 0 && hat < CREW_HATS.length);
  assert.notEqual(autoHat("cobra", [hat]), hat);
  assert.equal(autoHat("cobra", [0, 1, 2, 3, 4, 5, 6, 7]), hat);
});

test("a typed name is tidied, and an unusable one refused", () => {
  assert.equal(cleanCrewName("  Big   Al "), "Big Al");
  assert.equal(cleanCrewName("O'Neil"), "O'Neil");
  assert.equal(cleanCrewName(""), null);
  assert.equal(cleanCrewName("cobra"), null);
  assert.equal(cleanCrewName("a".repeat(21)), null);
  assert.equal(cleanCrewName("<b>hi</b>"), null);
});

test("a look is the same each time and a reroll changes it", () => {
  const a = foremanSpec("cobra", { look: 0, hat: 2 });
  assert.deepEqual(foremanSpec("cobra", { look: 0, hat: 2 }), a);
  assert.equal(a.hat, CREW_HATS[2]);
  const looks = new Set([0, 1, 2, 3, 4].map((look) => JSON.stringify({ ...foremanSpec("cobra", { look, hat: 2 }), hat: "" })));
  assert.ok(looks.size > 1);
});

test("a Worker wears its Foreman's hat, or Cobra's colour for the Lead's own", () => {
  assert.equal(workerSpec("cobra_7", { hat: 5 }).hat, CREW_HATS[5]);
  assert.equal(workerSpec("cobra_7", undefined).hat, COBRA_SPEC.hat);
  assert.equal(workerSpec("cobra_7", { hat: 5 }).role, "worker");
});

test("every frame stays on the stage, in every state", () => {
  for (const spec of [COBRA_SPEC, foremanSpec("plant-shop", { look: 3, hat: 1 }), workerSpec("w_2", { hat: 4 })]) {
    for (const state of ["idle", "working", "needs", "done", "away"] as const) {
      for (let tick = 0; tick < 30; tick++) {
        for (const key of spriteFrame(spec, state, tick).keys()) {
          const [x, y] = key.split(",").map(Number) as [number, number];
          assert.ok(x >= 0 && y >= 0 && x < SPRITE_STAGE && y < SPRITE_STAGE, `${state} ${tick}: ${key}`);
        }
      }
    }
  }
});

test("needs you shows a bubble that idle does not, and a still frame does not move", () => {
  const spec = foremanSpec("cobra", { look: 0, hat: 0 });
  const bubble = (frame: Map<string, string>) => frame.get("20,2");
  assert.equal(bubble(spriteFrame(spec, "needs", 0, true)), "#F7F5FF");
  assert.notEqual(bubble(spriteFrame(spec, "idle", 0, true)), "#F7F5FF");
  assert.deepEqual(spriteFrame(spec, "working", 0, true), spriteFrame(spec, "working", 7, true));
});

test("runs cover the frame exactly, within the crop", () => {
  const spec = workerSpec("cobra_8", { hat: 3 });
  const frame = spriteFrame(spec, "idle", 0, true);
  const runs = spriteRuns(spec, "idle", 0, true);
  const covered = runs.reduce((sum, [, , length]) => sum + length, 0);
  assert.equal(covered, frame.size);
  for (const [x, y, length, colour] of runs) for (let i = 0; i < length; i++) assert.equal(frame.get(`${x + i},${y}`), colour);
  for (const [x, y, length] of spriteRuns(spec, "idle", 0, true, HEAD_CROP)) {
    assert.ok(x >= 0 && y >= 0 && x + length <= HEAD_CROP.w && y < HEAD_CROP.h);
  }
});
