import { describe, expect, it } from "vitest";
import { EMPTY_ORG, applyOrg, type Org } from "../../../../../packages/contracts/src/org.ts";
import type { Seat, Town } from "./org.ts";
import { chartOf, defaultOpen, seatRole, spaceLine, statusWords } from "./orgChart.ts";
import { askCobraWith, currentDraft, takeDraft } from "./cobraDraft.ts";

const seat = (key: string, name: string, over: Partial<Seat> = {}): Seat => ({
  key, machine: "laptop", project: key.split("/")[1]!, name, projectName: name, repo: {}, label: "Code", company: null, retired: false, state: "idle", needing: null, foreman: null, ...over,
});
const town = (seats: Seat[]): Town => ({ data: {} as never, seats: new Map(seats.map((s) => [s.key, s])), proposal: null });
const org = (): Org => {
  let o = applyOrg(EMPTY_ORG, { op: "company", name: "Maya's Soccer", kind: "team", home: "laptop" }).org;
  o = applyOrg(o, { op: "company", name: "Happy Tails" }).org;
  return applyOrg(o, { op: "sensitive", company: "maya-s-soccer", on: true }).org;
};

describe("the desk's org chart rules", () => {
  it("a Space's role is what follows its name in the project's; any other Foreman keeps its trade", () => {
    expect(seatRole(seat("l/x", "Sal", { label: "Outreach", projectName: "Maya's Soccer Announcements" }), "Maya's Soccer")).toBe("Announcements");
    expect(seatRole(seat("l/x", "Wes", { label: "Website Builder", projectName: "Site" }), "Maya's Soccer")).toBe("Website Builder");
    expect(seatRole(seat("l/x", "Wes", { label: "Code", projectName: "Maya's Soccer" }), "Maya's Soccer")).toBe("Code");
  });

  it("a Space per company with its baseline seats first, New arrivals grey, and the retired in the Outskirts", () => {
    const seats = [
      seat("l/web", "Wes", { company: "maya-s-soccer", label: "Website Builder", projectName: "Soccer Site" }),
      seat("l/dues", "Suki", { company: "maya-s-soccer", projectName: "Maya's Soccer Dues", state: "needs" }),
      seat("l/roster", "Stan", { company: "maya-s-soccer", projectName: "Maya's Soccer Roster", state: "working" }),
      seat("l/ann", "Sal", { company: "maya-s-soccer", projectName: "Maya's Soccer Announcements" }),
      seat("l/inv", "Ina", { company: "happy-tails" }),
      seat("l/new", "Zed"),
      seat("l/old", "Old", { company: "happy-tails", retired: true }),
    ];
    const chart = chartOf(town(seats), org());
    expect(chart.spaces.map((s) => s.name)).toEqual(["Maya's Soccer", "Happy Tails", "New arrivals"]);
    const maya = chart.spaces[0]!;
    expect(maya.seats.map((s) => s.name)).toEqual(["Sal", "Stan", "Suki", "Wes"]);
    expect([maya.needs, maya.working, maya.sensitive, maya.kindWords]).toEqual([1, 1, true, "Team or group"]);
    expect(chart.spaces[1]!.kindWords).toBeNull();
    expect(chart.spaces[2]).toMatchObject({ id: null, color: "#6b7288" });
    expect(chart.outskirts.map((s) => s.name)).toEqual(["Old"]);
    expect(chartOf(town([]), EMPTY_ORG)).toEqual({ spaces: [], outskirts: [] });
  });

  it("words: the line under a Space and a Foreman's status", () => {
    const some = (n: number, needs: number) => ({ seats: Array.from({ length: n }, (_, i) => seat(`l/${i}`, `S${i}`)), needs });
    expect(spaceLine(some(0, 0))).toBe("No Foremen yet");
    expect(spaceLine(some(1, 0))).toBe("1 Foreman");
    expect(spaceLine(some(6, 2))).toBe("6 Foremen · 2 need you");
    expect(spaceLine(some(3, 1))).toBe("3 Foremen · 1 needs you");
    expect(["needs", "working", "away", "idle"].map((state) => statusWords({ state: state as Seat["state"] }))).toEqual(["needs you", "working", "away", "idle"]);
  });

  it("opens on the first Space with something waiting, else the first, else none", () => {
    expect(defaultOpen(chartOf(town([seat("l/a", "A", { company: "happy-tails", state: "needs" })]), org()))).toBe("happy-tails");
    expect(defaultOpen(chartOf(town([seat("l/a", "A", { company: "happy-tails" })]), org()))).toBe("maya-s-soccer");
    expect(defaultOpen(chartOf(town([]), EMPTY_ORG))).toBeUndefined();
    expect(defaultOpen(chartOf(town([seat("l/a", "A")]), EMPTY_ORG))).toBeNull();
  });
});

describe("words asked for in Cobra's box", () => {
  it("each ask is taken once, and asking again puts them there again", () => {
    expect(takeDraft()).toBeNull();
    askCobraWith("Set up a new Space: ");
    expect(currentDraft().text).toBe("Set up a new Space: ");
    expect(takeDraft()).toBe("Set up a new Space: ");
    expect(takeDraft()).toBeNull();
    askCobraWith("Set up a new Space: ");
    expect(takeDraft()).toBe("Set up a new Space: ");
  });
});
