import { test } from "node:test";
import assert from "node:assert/strict";

import { parseViewList, parseViewResult } from "./viewsRead.ts";
import { PER_VIEW, SHOWN, todayItems, type TodayPart } from "./spaceToday.ts";

const followups = parseViewList({ views: [{ id: "followups", title: "Follow-ups", kind: "list", today: true, row: { id: "person_id", title: "name", subtitle: "why", trailing: "due_on", tone: "tone" }, formats: { due_on: "date" } }] }).views[0]!;
const waiting = parseViewList({ views: [{ id: "waiting", title: "To allow", kind: "list", today: true, row: { id: "id", title: "title", badge: "badge", trailing: "amount_cents" }, formats: { amount_cents: "money" } }] }).views[0]!;
const part = (view: typeof followups, role: string, rows: object[], project = role.toLowerCase()): TodayPart => ({
  machine: "legion", project, role, view, currency: "USD",
  result: parseViewResult({ view: view.id, kind: "list", title: view.title, masked: [], more: false, rows, row: view.row, formats: view.formats }),
});

test("brings each Foreman's flagged rows together, the late first, then the due, then the rest in the order they came", () => {
    const { items, more } = todayItems([
      part(followups, "CRM", [
        { person_id: 1, name: "Pete's Pet Supply", why: "Call back", due_on: "2026-10-30", tone: null },
        { person_id: 2, name: "Dana Ruiz", why: "Send the quote", due_on: "2026-10-28", tone: "warn" },
        { person_id: 3, name: "Ava Reed", why: "Reply", due_on: "2026-10-20", tone: "bad" },
      ]),
      part(waiting, "Finance", [{ id: 9, title: "Hardware store", badge: "Expense", amount_cents: 4250 }]),
    ], "2026-10-28");
    assert.deepEqual(items.map((i) => [i.role, i.title, i.tone]), [
      ["CRM", "Ava Reed", "bad"], ["CRM", "Dana Ruiz", "warn"], ["CRM", "Pete's Pet Supply", null], ["Finance", "Hardware store", null],
    ]);
    assert.deepEqual({ ...items[0]! }, { machine: "legion", project: "crm", role: "CRM", view: "followups", viewTitle: "Follow-ups", title: "Ava Reed", subtitle: "Reply", trailing: "Oct 20", badge: "", tone: "bad" });
    assert.equal(items[3]!.badge, "Expense");
    assert.deepEqual([items[3]!.view, items[3]!.viewTitle], ["waiting", "To allow"], "a tap opens To allow itself, where Allow is");
  assert.equal(items[3]!.trailing, "$42.50");
    assert.equal(more, 0);
  });

test("a busy list shows its first few, the whole page is capped and the rest counted", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ person_id: i + 1, name: `P${i}`, why: "x", due_on: "2026-11-01", tone: null }));
    assert.equal(todayItems([part(followups, "CRM", many)], "2026-10-28").items.length, PER_VIEW);
    const parts = ["A", "B", "C", "D"].map((role) => part(followups, role, many));
    const all = todayItems(parts, "2026-10-28");
    assert.equal(all.items.length, SHOWN);
    assert.equal(all.more, 4 * PER_VIEW - SHOWN);
  });

test("nothing flagged, or no rows, is an empty list; a row with no title is left out", () => {
    assert.deepEqual(todayItems([], "2026-10-28"), { items: [], more: 0 });
    assert.deepEqual(todayItems([part(followups, "CRM", [{ person_id: 1, name: "", why: "x" }])], "2026-10-28").items, []);
  });

test("Next up's row says why in its detail line and opens the person, not the tab", () => {
  const next = parseViewList({ views: [{ id: "next-up", title: "Next up", kind: "list", today: true, opens: "person", row: { id: "id", title: "name", subtitle: "organization", detail: "line", tone: "tone", cta: "cta" } }] }).views[0]!;
  const { items } = todayItems([part(next, "CRM", [{ id: 4, name: "Luis Andrade", organization: "Andrade Studio", line: 'No reply to "Hi" · due 8 Nov', tone: "warn", cta: "Follow up" }])], "2026-11-08");
  assert.deepEqual([items[0]!.subtitle, items[0]!.id, items[0]!.opens], ['No reply to "Hi" · due 8 Nov', "4", "person"]);
});
