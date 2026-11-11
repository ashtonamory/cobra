// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_ORG, applyOrg, type Org } from "../../../../../packages/contracts/src/org.ts";
import type { Seat, Town } from "./org.ts";
import { chartOf } from "./orgChart.ts";
import {
  SHOW_CREW_KEY, activityLine, emptySpaceWords, andList, chipWords, isCrew, parseShowCrew, pickedSpace, placeOf, readShowCrew, rowProject,
  saveShowCrew, skillTiles, skillWord, spaceChoices, spaceSkillsLine, spacesSummary, visibleChart, visibleGroups, whoWords,
  withSpace, workingPlaces,
} from "./crewVisibility.ts";

const seat = (key: string, name: string, over: Partial<Seat> = {}): Seat => ({
  key, machine: "laptop", project: key.split("/")[1]!, name, projectName: name, repo: {}, label: "Code", company: null, retired: false, state: "idle", needing: null, foreman: null, ...over,
});
const town = (seats: Seat[]): Town => ({ data: {} as never, seats: new Map(seats.map((s) => [s.key, s])), proposal: null });
const org = (): Org => {
  let o = applyOrg(EMPTY_ORG, { op: "company", name: "Happy Tails", kind: "client", home: "laptop" }).org;
  return applyOrg(o, { op: "company", name: "Fern & Field" }).org;
};

afterEach(() => localStorage.clear());

describe("the crew switch", () => {
  it("is off unless kept as on", () => {
    expect(parseShowCrew("on")).toBe(true);
    for (const odd of [null, undefined, "", "off", "true", "ON"]) expect(parseShowCrew(odd)).toBe(false);
    expect(readShowCrew()).toBe(false);
  });

  it("saving keeps it for the next start, and off clears it", () => {
    saveShowCrew(true);
    expect(localStorage.getItem(SHOW_CREW_KEY)).toBe("on");
    expect(readShowCrew()).toBe(true);
    saveShowCrew(false);
    expect(localStorage.getItem(SHOW_CREW_KEY)).toBeNull();
    expect(readShowCrew()).toBe(false);
  });
});

describe("skills, not crew", () => {
  it("a trade reads as one plain word", () => {
    expect(skillWord({ trade: "people", label: "People" })).toBe("People");
    expect(skillWord({ trade: "website-builder", label: "Website Builder" })).toBe("Website");
    expect(skillWord({ trade: "designer", label: "Designer" })).toBe("Designer");
    expect(skillWord({ label: "Website Builder" })).toBe("Website");
    expect(skillWord({ label: "website-builder" })).toBe("Website");
    expect(skillWord({ trade: "social-media", label: "Social Media Manager" })).toBe("Social Media");
    expect(skillWord({ label: "social-media" })).toBe("Social media");
    expect(skillWord({ label: "Manager" })).toBe("Manager");
  });

  it("one tile per seat; a second of a skill is numbered", () => {
    const tiles = skillTiles([
      seat("l/a", "Pia", { trade: "people", label: "People" }),
      seat("l/b", "Wes", { trade: "website-builder", label: "Website Builder" }),
      seat("l/c", "Wyn", { trade: "website-builder", label: "Website Builder" }),
    ]);
    expect(tiles.map((t) => t.skill)).toEqual(["People", "Website", "Website 2"]);
    expect(tiles.map((t) => t.seat.name)).toEqual(["Pia", "Wes", "Wyn"]);
  });

  it("words in a list and under a Space", () => {
    expect(andList([])).toBe("");
    expect(andList(["People"])).toBe("People");
    expect(andList(["People", "Money"])).toBe("People and Money");
    expect(andList(["People", "Outreach", "Money"])).toBe("People, Outreach and Money");
    expect(andList(["A", "B", "C", "D", "E"])).toBe("A, B, C and 2 more");
    const seats = [seat("l/a", "Pia", { trade: "people" }), seat("l/b", "Mo", { trade: "money" })];
    expect(spaceSkillsLine({ seats, needs: 0 })).toBe("People and Money");
    expect(spaceSkillsLine({ seats, needs: 1 })).toBe("People and Money · 1 needs you");
    expect(spaceSkillsLine({ seats: [], needs: 0 })).toBe("Nothing set up yet");
  });
});

describe("the chart with the crew hidden", () => {
  const seats = [
    seat("l/crm", "Pia", { company: "happy-tails", trade: "people", state: "needs" }),
    seat("l/cobra", "Juno"),
    seat("l/old", "Old", { company: "happy-tails", retired: true }),
  ];
  const chart = chartOf(town(seats), org());

  it("is Spaces only: no New arrivals, no Outskirts", () => {
    expect(chart.spaces.map((s) => s.name)).toEqual(["Happy Tails", "Fern & Field", "New arrivals"]);
    const hidden = visibleChart(chart, false);
    expect(hidden.spaces.map((s) => s.name)).toEqual(["Happy Tails", "Fern & Field"]);
    expect(hidden.outskirts).toEqual([]);
    expect(visibleChart(chart, true)).toBe(chart);
  });

  it("counts Spaces and what needs you, never Foremen", () => {
    expect(spacesSummary(visibleChart(chart, false))).toBe("2 Spaces · 1 needs you");
    expect(spacesSummary({ spaces: [], outskirts: [] })).toBe("No Spaces yet");
  });

  it("a Space with nobody yet asks you to ask Cobra, never to hire", () => {
    expect(emptySpaceWords("Happy Tails")).toBe("Nothing here yet. Ask Cobra for something in Happy Tails.");
  });
});

describe("where work happens", () => {
  const seats = [
    seat("l/crm", "Pia", { company: "happy-tails", trade: "people", state: "working" }),
    seat("l/site", "Wes", { company: "happy-tails", trade: "website-builder", state: "working" }),
    seat("l/books", "Mo", { company: "fern-field", trade: "money" }),
    seat("l/cobra", "Juno", { state: "working" }),
    seat("l/gone", "Gus", { company: "happy-tails", retired: true, state: "working" }),
  ];
  const t = town(seats);

  it("a project's place is its Space and skill; a code project or a retired one has none", () => {
    expect(placeOf(t, org(), "laptop", "crm")).toEqual({ space: "Happy Tails", skill: "People" });
    expect(placeOf(t, org(), "laptop", "books")).toEqual({ space: "Fern & Field", skill: "Money" });
    expect(placeOf(t, org(), "laptop", "cobra")).toBeNull();
    expect(placeOf(t, org(), "laptop", "gone")).toBeNull();
    expect(placeOf(t, org(), "office", "crm")).toBeNull();
    expect(rowProject({ id: "crm_fm", parent: "crm" })).toBe("crm");
    expect(rowProject({ id: "crm", parent: null })).toBe("crm");
  });

  it("who asks: the Space and skill, else Cobra", () => {
    expect(whoWords({ space: "Happy Tails", skill: "People" })).toBe("Happy Tails · People");
    expect(whoWords(null)).toBe("Cobra");
  });

  it("one activity line names Spaces and skills, never crew", () => {
    expect(activityLine(workingPlaces(t, org()))).toBe("Working on People and Website in Happy Tails");
    expect(activityLine([{ space: "Happy Tails", skill: "People" }, { space: "Fern & Field", skill: "Money" }, null]))
      .toBe("Working on Happy Tails and Fern & Field");
    expect(activityLine([null])).toBe("Working in the background");
    expect(activityLine([])).toBeNull();
    const line = activityLine(workingPlaces(t, org()))!;
    for (const name of ["Pia", "Wes", "Juno", "Gus", "Foreman", "Worker"]) expect(line).not.toContain(name);
  });
});

describe("the Space chip", () => {
  it("offers the Spaces and says which is picked", () => {
    expect(spaceChoices(org())).toEqual([{ id: "happy-tails", name: "Happy Tails" }, { id: "fern-field", name: "Fern & Field" }]);
    expect(chipWords(null)).toBe("Space: All ▾");
    expect(chipWords("Happy Tails")).toBe("Space: Happy Tails ▾");
    expect(pickedSpace(org(), "fern-field")).toEqual({ id: "fern-field", name: "Fern & Field" });
    expect(pickedSpace(org(), "closed")).toBeNull();
    expect(pickedSpace(org(), null)).toBeNull();
  });

  it("prefixes the message exactly as the phone does", () => {
    expect(withSpace("Send the invoices", "Happy Tails")).toBe("[Space: Happy Tails] Send the invoices");
    expect(withSpace("Send the invoices", null)).toBe("Send the invoices");
  });
});

describe("lists", () => {
  it("the Agents list keeps Cobra only while the crew is hidden", () => {
    const groups: Array<readonly [string, number[]]> = [["LEAD", [1]], ["FOREMEN", [2]], ["WORKERS", [3]], ["SESSIONS", [4]]];
    expect(visibleGroups(groups, false)).toEqual([["LEAD", [1]]]);
    expect(visibleGroups(groups, true)).toEqual(groups);
  });

  it("a Foreman or a Worker is crew; the Lead and your sessions are not", () => {
    expect(isCrew({ foreman: true, worker: null })).toBe(true);
    expect(isCrew({ foreman: false, worker: { id: "w1" } })).toBe(true);
    expect(isCrew({ foreman: false, worker: null })).toBe(false);
  });
});
