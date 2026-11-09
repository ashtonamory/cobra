import { test } from "node:test";
import assert from "node:assert/strict";

import type { ApprovalBills } from "./approvals.ts";
import { billRow, dueWords, keepWords, skipAnswer } from "./billsCard.ts";

const card: ApprovalBills = {
  space: "personal", spaceName: "Personal", project: "personal-money", batch: 2, currency: "XCD", source: "found", monthlyCents: 152967,
  items: [
    { bill: 3, name: "Rent", amountCents: 150000, currency: "XCD", every: "month", nextOn: "2026-12-01", category: "Housing" },
    { bill: 4, name: "Spotify", amountCents: 1099, currency: "USD", every: "month", nextOn: "2026-11-14", seen: 3 },
  ],
};

test("a bill's due day in words", () => {
  assert.equal(dueWords("month", "2026-12-01"), "monthly on the 1st");
  assert.equal(dueWords("month", "2026-11-22"), "monthly on the 22nd");
  assert.equal(dueWords("month", "2026-11-13"), "monthly on the 13th");
  assert.equal(dueWords("year", "2027-03-01"), "every year on 1 Mar");
});

test("a bill's row and what Allow keeps", () => {
  assert.deepEqual(billRow(card.items[1]!, "XCD"), { name: "Spotify", detail: "US$10.99 monthly on the 14th · paid 3 times lately" });
  assert.equal(skipAnswer(card, new Set()), undefined);
  assert.deepEqual(skipAnswer(card, new Set([4, 99])), [4]);
  assert.equal(keepWords(card, new Set()), "About EC$1,529.67 a month. Untick any that are not yours.");
  assert.equal(keepWords(card, new Set([4])), "Allow keeps 1 of 2.");
  assert.equal(keepWords(card, new Set([3, 4])), "None ticked: Allow keeps none of them.");
});
