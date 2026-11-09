import { describe, expect, it } from "vitest";
import type { ApprovalExpenses } from "../../../../../packages/contracts/src/approvals.ts";
import { accountsAnswer, paidFrom } from "./expenses.ts";

const item = (expense: number, account?: number) => ({ expense, vendor: `V${expense}`, date: "2026-11-01", totalCents: 100, taxCents: null, category: "Groceries", file: `/r/${expense}.jpg`, bytes: 1, ...(account !== undefined ? { account } : {}) });
const card: ApprovalExpenses = {
  space: "personal", spaceName: "Personal", project: "personal-money", currency: "XCD", unread: [],
  items: [item(1, 10), item(2)],
  accounts: [{ id: 10, name: "Cash", kind: "cash" }, { id: 11, name: "Bank", kind: "bank" }],
};

describe("Paid from on a receipts card", () => {
  it("is Cobra's guess until the person picks, and none when nobody knows", () => {
    expect(paidFrom(card, {}, 1)).toBe(10);
    expect(paidFrom(card, {}, 2)).toBeNull();
    expect(paidFrom(card, { 1: 11 }, 1)).toBe(11);
  });
  it("sends only what the person changed", () => {
    expect(accountsAnswer(card, {})).toBeUndefined();
    expect(accountsAnswer(card, { 1: 10 })).toBeUndefined();
    expect(accountsAnswer(card, { 1: 11, 2: 10 })).toEqual({ 1: 11, 2: 10 });
  });
});
