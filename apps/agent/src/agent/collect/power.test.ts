import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLidState, summariseSupplies } from "./power.ts";

test("lid state reads the last word of the acpi line", () => {
  assert.equal(parseLidState("state:      open"), "open");
  assert.equal(parseLidState("state:      closed"), "closed");
  assert.equal(parseLidState(null), null);
  assert.equal(parseLidState("state: weird"), null);
});

test("the Laptop's supplies: AC online, one battery", () => {
  // Verbatim shape of /sys/class/power_supply on the Laptop, 2026-09-26.
  assert.deepEqual(
    summariseSupplies([
      { type: "Mains", online: "1", capacity: null },
      { type: "Battery", online: null, capacity: "79" },
      { type: "USB", online: "0", capacity: null },
      { type: "USB", online: "0", capacity: null },
    ]),
    { ac: true, battery: 79 },
  );
});

test("unplugged is ac false, and a desktop with no supplies is null", () => {
  assert.deepEqual(
    summariseSupplies([
      { type: "Mains", online: "0", capacity: null },
      { type: "Battery", online: null, capacity: "18" },
    ]),
    { ac: false, battery: 18 },
  );
  assert.deepEqual(summariseSupplies([]), { ac: null, battery: null });
});
