import { describe, expect, it } from "vitest";
import type { AllMoney, SpaceMoney } from "../../../../../packages/contracts/src/allMoney.ts";
import { chosenCurrency, placed, stack, toAskAgain } from "./allMoney.ts";

const space = (over: Partial<SpaceMoney>): SpaceMoney => ({
  space: "s", name: "S", kind: "own", project: "s-money", home: "USD", setUp: true, in: 0, out: 0, kept: 0, owed: 0, netWorth: 0, waiting: 0, months: [], ...over,
});
const reply = (machine: string, currency: string, spaces: SpaceMoney[]): AllMoney => ({ machine, month: "2026-11", currency, spaces });

describe("All money on the desk", () => {
  it("shows everything in the household's currency and asks again the computers that answered in another", () => {
    const replies = [
      reply("laptop", "USD", [space({ space: "paws", name: "Happy Tails" })]),
      reply("office", "XCD", [space({ space: "personal", name: "Personal", kind: "family", home: "XCD" })]),
      reply("pi", "CAD", []),
    ];
    expect(chosenCurrency(replies)).toBe("XCD");
    expect(toAskAgain(replies, "XCD")).toEqual(["laptop"]);
  });

  it("lists households first, then businesses set up, then the ones to set up, each with its computer", () => {
    const rows = placed([
      reply("laptop", "XCD", [space({ space: "skn", name: "SKN Villa", setUp: false }), space({ space: "paws", name: "Happy Tails" })]),
      reply("office", "XCD", [space({ space: "personal", name: "Personal", kind: "family" }), space({ space: "acme", name: "Acme.dev" })]),
    ]);
    expect(rows.map((r) => [r.name, r.machine])).toEqual([["Personal", "office"], ["Acme.dev", "office"], ["Happy Tails", "laptop"], ["SKN Villa", "laptop"]]);
  });

  it("stacks gains up from zero and losses down from it", () => {
    expect(stack([300, -100, null, 200, -50, 0])).toEqual([{ from: 0, to: 300 }, { from: 0, to: -100 }, null, { from: 300, to: 500 }, { from: -100, to: -150 }, null]);
  });
});
