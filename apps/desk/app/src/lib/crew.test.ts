/**
 * The desk's crew (crew.ts) against the phone's (packages/contracts/src/crew.ts): the same seed must
 * draw the same face, pixel for pixel. A port of the desk's tests/test_crew.py; the parity half runs
 * only where the contracts file is on disk (COBRA_CONTRACTS_CREW, else a checkout of the agent repo beside this one).
 */
import * as crew from "./crew.ts";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CREW_TS = env.COBRA_CONTRACTS_CREW ?? new URL("../../../../../cobra/packages/contracts/src/crew.ts", import.meta.url).pathname;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const phone: any = await import(/* @vite-ignore */ CREW_TS).catch(() => null);

const CASES: [string, number, number][] = [["cobra", 0, 3], ["plant-shop", 2, 0], ["corner-bakery", 5, 7], ["web-app", 1, 6], ["ünïcode", 0, 1]];
const WORKERS: [string, number | null][] = [["cobra_7", 3], ["corner-bakery_12", 7], ["lead-owned", null]];
const STATES = ["idle", "working", "needs", "done", "away"];
const TICKS = [0, 1, 2, 3, 5, 9, 13, 26];

function* specs(): Generator<[string, crew.Spec, unknown]> {
  yield ["cobra-lead", crew.COBRA, phone?.COBRA_SPEC];
  for (const [pid, look, hat] of CASES) yield [`fm:${pid}:${look}`, crew.foremanSpec(pid, { look, hat }), phone?.foremanSpec(pid, { look, hat })];
  for (const [wid, hat] of WORKERS) {
    yield [`w:${wid}`, crew.workerSpec(wid, hat === null ? null : { hat }), phone?.workerSpec(wid, hat === null ? undefined : { hat })];
  }
}

const sortedPairs = (m: Map<string, string>) => [...m].sort();

describe.skipIf(!phone)("SameAsThePhone", () => {
  it("test_hash", () => {
    for (const [pid] of CASES) expect(crew.crewHash(pid), pid).toBe(phone.crewHash(pid));
  });

  it("test_every_frame", () => {
    let checked = 0;
    for (const [key, mine, theirs] of specs()) {
      for (const state of STATES) {
        for (const tick of TICKS) {
          const a = sortedPairs(crew.frame(mine, state, tick)), b = sortedPairs(phone.spriteFrame(theirs, state, tick));
          // Compared as text first: 360 deep comparisons of ~500 pairs each is slow.
          if (JSON.stringify(a) !== JSON.stringify(b)) expect(a, `${key} ${state} ${tick}`).toEqual(b);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(9 * STATES.length * TICKS.length);
  }, 30000);
});

describe("WhoWearsWhat", () => {
  const CREW = { name: "Juno", look: 0, hat: 3 };

  it("test_lead_foreman_worker", () => {
    expect(crew.lookOf({ lead: true })).toEqual([crew.COBRA, crew.LEAD_COLOR]);
    const [spec, colour] = crew.lookOf({ id: "cobra_fm", parent: "cobra", foreman: true, crew: CREW })!;
    expect([spec.role, colour]).toEqual(["foreman", crew.CREW_HATS[3]]);
    const worker = { id: "cobra_7", parent: "cobra", worker: { owner: "cobra" }, crew: CREW };
    expect(crew.lookOf(worker)![0].hat).toBe(crew.CREW_HATS[3]);
    expect(crew.crewLabel(worker)).toBe("Juno's crew");
    expect(crew.crewLabel({ ...worker, worker: { owner: "lead" } })).toBe("Cobra's crew");
  });

  it("test_an_agent_without_crews_draws_as_before", () => {
    expect(crew.lookOf({ id: "cobra_fm", parent: "cobra", foreman: true })).toBeNull();
    expect(crew.lookOf({ id: "cobra", name: "cobra" })).toBeNull();
  });

  it("test_state", () => {
    expect(crew.spriteState("needs")).toBe("needs");
    expect(crew.spriteState("working")).toBe("working");
    expect(crew.spriteState("agent")).toBe("idle");
    expect(crew.spriteState("agent", false)).toBe("away");
  });
});
