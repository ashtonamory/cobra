/** Home's rules (lib/home.ts): the phone's homeRules.test.ts, on the desk's rows. */
import { beforeEach, describe, expect, it } from "vitest";
import { installFleet } from "./fleetFixture.ts";
import * as home from "./home.ts";
import type { Dict } from "./json.ts";
import * as model from "./model.ts";
import type { Blocker } from "./ops.ts";

beforeEach(installFleet);

const NOW = model.parseIso("2026-10-24T15:00:00Z")!;
const lead = (machine: string, extra: Dict = {}) => model.rowForProject({
  id: "cobra_lead", name: "Lead", session: "cobra_lead", path: "/p", lead: true, activity: "agent-idle",
  lastActivityAt: "2026-10-24T14:00:00Z", ...extra,
}, machine, NOW);
const worker = model.rowForProject({ id: "w1", name: "w1", session: "w1", path: "/w", activity: "agent-working" }, "omarchy", NOW);

describe("Home", () => {
  it("talks to a Lead that answers, then one that waits on you, then the latest", () => {
    const office = lead("office", { lastActivityAt: "2026-10-24T14:50:00Z" });
    const laptop = lead("omarchy");
    expect(home.homeLead([worker, laptop, office], new Set())).toBe(office);
    expect(home.homeLead([laptop, office], new Set(["office"]))).toBe(laptop);
    const asking = lead("omarchy", { needsInput: true });
    expect(home.homeLead([office, asking], new Set())).toBe(asking);
    expect(home.homeLead([worker], new Set())).toBeNull();
  });

  it("leaves Cobra's own question out of her alerts", () => {
    const l = lead("omarchy", { needsInput: true });
    const other = model.rowForProject({ id: "w2", name: "w2", session: "w2", path: "/w", needsInput: true }, "omarchy", NOW);
    const b = (row: model.Row): Blocker => ({ key: row.id, time: "", title: "", word: "", kind: "claude", machine: row.machine, approval: null, row, alert: null });
    expect(home.cobraAlerts([b(l), b(other)], l).map((x) => x.key)).toEqual(["w2"]);
    expect(home.cobraAlerts([b(l)], null)).toHaveLength(1);
  });

  it("says what waits in her voice and how she is", () => {
    expect(home.alertWords(0)).toBeNull();
    expect(home.alertWords(1)).toBe("This needs you.");
    expect(home.alertWords(3)).toBe("These 3 need you.");
    const l = lead("omarchy");
    expect(home.leadStatus(null, 0, new Set(), false)).toBe("Link a computer to talk to Cobra");
    expect(home.leadStatus(null, 2, new Set(), false)).toBe("Not running");
    expect(home.leadStatus(l, 2, new Set(["laptop"]), false)).toBe("laptop is not answering");
    expect(home.leadStatus(lead("omarchy", { needsInput: true }), 2, new Set(), false)).toBe("Asks you something");
    expect(home.leadStatus(l, 2, new Set(), true)).toBe("Working");
    expect(home.leadStatus(l, 2, new Set(), false)).toBe("Here");
  });

  it("shows today's brief from the computer that sends it until it is dismissed", () => {
    const now = new Date(2026, 9, 24, 9).getTime();
    const brief = { day: "2026-10-24", text: "Two PRs landed.", at: "2026-10-24T08:00:00", by: "model" };
    const reads: Array<[string, Dict]> = [
      ["office", { sends: false, latest: null }],
      ["omarchy", { sends: true, latest: brief }],
    ];
    expect(home.todaysBrief(reads, now)).toEqual({ machine: "omarchy", brief });
    expect(home.todaysBrief(reads, new Date(2026, 9, 25, 9).getTime()), "yesterday's is not today's").toBeNull();
    expect(home.briefDismissed(brief, null)).toBe(false);
    expect(home.briefDismissed(brief, brief.at)).toBe(true);
    expect(home.briefDismissed({ ...brief, at: "2026-10-25T08:00:00" }, brief.at), "tomorrow's comes back").toBe(false);
  });
});
