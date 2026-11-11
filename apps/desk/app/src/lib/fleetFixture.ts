/**
 * The machines the desk's tests were written against (its tests/fleet_fixture.py). Cobra runs one
 * agent, but the pure logic still adds rows up by machine, so the tests keep three to prove rows
 * from different machines never mix. For tests only.
 */
import { setMachines, testMachine, type Machine } from "./config.ts";

export const FLEET: readonly Machine[] = [
  testMachine("omarchy", { label: "laptop", title: "Laptop", tmuxSocket: "default", hue: "blue" }),
  testMachine("office", { label: "office", title: "Office", hue: "cyan" }),
  testMachine("macbook", { label: "macbook", title: "Macbook", hue: "magenta" }),
];

export function installFleet(): void {
  setMachines(FLEET);
}
