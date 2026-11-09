// The bills card: a proposal of bills
// (trades/bills.ts bills_propose, written by Cobra's finder or Money's
// Foreman) becomes one card of kind `bills`, each bill on it ticked. The
// person unticks the ones that are not theirs (the answer's `skip`, the bill
// ids), and Allow makes the rest active (`bills_allow`, as the person); Deny
// drops them all (`bills_drop`). A newer proposal replaces an older card still
// waiting, as bills_propose drops its rows. Money's Foreman hears the answer.
import type { ApprovalBills } from "@cobra/contracts";

import { makeApproval, settle, type StoredApproval } from "./approvals.ts";
import type { BudgetCardDeps } from "./budgetCard.ts";
import { BY_PERSON } from "./dbTypes.ts";
import type { ProjectDb } from "./dbTypes.ts";
import { formatMoneyIn } from "../../../../packages/contracts/src/viewsRead.ts";
import { billRow } from "../../../../packages/contracts/src/billsCard.ts";
import { BILL_CURRENCY_SQL, BILL_HOME_SQL } from "./trades/bills.ts";
import { HOME_SQL } from "./trades/currency.ts";

export type BillsCardDeps = BudgetCardDeps;

const num = (value: unknown): number => Number(value ?? 0);
const opt = (value: unknown): string | undefined => (value === null || value === undefined || value === "" ? undefined : String(value));

/** What a proposal holds, read from the store: each bill with its currency, and what they come to a month in home cents. */
export function readBills(db: ProjectDb, batch: number, today: string): Omit<ApprovalBills, "space" | "spaceName" | "project"> | null {
  const rows = db.queryRaw(
    `SELECT b.id AS id, b.name AS name, b.amount_cents AS amount, ${BILL_CURRENCY_SQL("b")} AS currency, b.every AS every, b.next_on AS next_on,
            b.seen AS seen, b.source AS source, c.name AS category, a.name AS account, ${BILL_HOME_SQL("b", "?")} AS home
       FROM bills b LEFT JOIN categories c ON c.id = b.category_id LEFT JOIN accounts a ON a.id = b.account_id
      WHERE b.batch = ? AND b.status = 'proposed' ORDER BY b.amount_cents DESC, b.name`,
    [today, batch],
  ).rows;
  if (!rows.length) return null;
  const currency = String(db.queryRaw(`SELECT ${HOME_SQL} AS c`, []).rows[0]?.c ?? "USD");
  const monthly = rows.reduce((sum, r) => sum + (r.every === "year" ? num(r.home) / 12 : num(r.home)), 0);
  return {
    batch,
    currency,
    source: String(rows[0]!.source ?? "said"),
    monthlyCents: Math.round(monthly),
    items: rows.map((r) => ({
      bill: num(r.id),
      name: String(r.name),
      amountCents: num(r.amount),
      currency: String(r.currency),
      every: String(r.every),
      nextOn: String(r.next_on),
      ...(opt(r.category) ? { category: opt(r.category)! } : {}),
      ...(opt(r.account) ? { account: opt(r.account)! } : {}),
      ...(r.seen !== null && r.seen !== undefined ? { seen: num(r.seen) } : {}),
    })),
  };
}

/** The card's words: one line per bill (name · amount · when · seen), what they come to a month, and how Allow works. */
export function billsBody(card: ApprovalBills): { title: string; body: string } {
  const count = card.items.length;
  const title = card.source === "found" ? `Cobra spotted ${count} bill${count === 1 ? "" : "s"} in ${card.spaceName}. Keep ${count === 1 ? "it" : "them"}?` : `Keep ${count === 1 ? "this bill" : `these ${count} bills`} for ${card.spaceName}?`;
  const body = [
    ...card.items.map((item) => {
      const row = billRow(item, card.currency);
      return `${item.skipped ? "✗" : "✓"} ${row.name} · ${row.detail}`;
    }),
    `About ${formatMoneyIn(card.monthlyCents, card.currency, card.currency)} a month, set aside from Left to spend until each is paid.`,
    "Untick any that are not yours; Allow keeps the rest.",
  ].join("\n");
  return { title, body };
}

const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A proposal just written becomes its card; an older bills card for the Space still waiting is closed, since its rows were dropped. */
export async function proposeBillsCard(deps: BillsCardDeps, project: string, db: ProjectDb, batch: number, by: string): Promise<StoredApproval | null> {
  const space = deps.space(project);
  if (!space) return null;
  const now = deps.now();
  const proposal = readBills(db, batch, localDay(now));
  if (!proposal) return null;
  const card: ApprovalBills = { space: space.id, spaceName: space.name, project, ...proposal };
  const { title, body } = billsBody(card);
  const approval = makeApproval({ kind: "bills", title, body, requestedBy: by, bills: card }, now);
  const current = settle(deps.approvals.load(), now).map((a) =>
    a.kind === "bills" && a.state === "pending" && a.bills?.space === space.id ? { ...a, state: "expired" as const, results: [{ ok: false, message: "A newer list of bills replaced it" }] } : a,
  );
  deps.approvals.save([...current, approval]);
  deps.log(`bills ${approval.id}: proposal ${batch} for ${space.id}, ${card.items.length} bill(s)`);
  await deps.notify(approval);
  return approval;
}

/** The bills the person unticked (`skip`, a list of bill ids), checked against the card; the card with them marked. */
export function chooseSkips(card: ApprovalBills, raw: unknown): ApprovalBills | { error: string } {
  if (raw === undefined || raw === null) return card;
  if (!Array.isArray(raw)) return { error: "skip is a list of the bills' ids to leave off" };
  const skip = new Set<number>();
  for (const value of raw) {
    const id = typeof value === "string" ? Number(value) : value;
    if (typeof id !== "number" || !card.items.some((i) => i.bill === id)) return { error: `bill ${String(value)} is not on this card` };
    skip.add(id);
  }
  return { ...card, items: card.items.map((i) => (skip.has(i.bill) ? { ...i, skipped: true } : i)) };
}

/** The person's answer: Allow makes the ticked bills active, Deny drops them all; Money's Foreman hears which. */
export function settleBillsApproval(deps: Pick<BillsCardDeps, "open" | "stored" | "tell">, approval: StoredApproval): StoredApproval {
  const card = approval.bills;
  if (approval.kind !== "bills" || !card) return approval;
  const allowed = approval.state === "allowed";
  const skipped = card.items.filter((i) => i.skipped);
  const kept = card.items.length - skipped.length;
  const db = deps.open(card.space);
  let result: { ok: boolean; message: string };
  try {
    // Every bill unticked is a No to the whole card.
    if (allowed && kept > 0) db.write("bills_allow", { batch: card.batch, skip: skipped.map((i) => ({ id: i.bill })) }, BY_PERSON);
    else db.write("bills_drop", { batch: card.batch }, BY_PERSON);
    result = { ok: true, message: allowed && kept > 0 ? `Keeping ${kept} bill${kept === 1 ? "" : "s"}${skipped.length ? `, left off ${skipped.length}` : ""}` : "Dropped the bills" };
  } catch (caught) {
    result = { ok: false, message: caught instanceof Error ? caught.message : String(caught) };
  } finally {
    db.close();
  }
  deps.stored(card.space);
  const names = (items: ApprovalBills["items"]) => items.map((i) => i.name).join(", ");
  const told = !allowed || kept === 0
    ? `The person said no to the bills in proposal ${card.batch} (${names(card.items)}); none count. Do not propose them again unless the person says so.`
    : result.ok
      ? `The person kept ${kept} bill${kept === 1 ? "" : "s"} (proposal ${card.batch}): ${names(card.items.filter((i) => !i.skipped))}.${skipped.length ? ` Not theirs: ${names(skipped)}.` : ""} They come off Left to spend until each is paid.`
      : `The person allowed the bills (proposal ${card.batch}), but they could not be kept: ${result.message}`;
  deps.tell(card.project, told, allowed && kept > 0 && result.ok ? "info" : "decision");
  return allowed ? { ...approval, state: result.ok ? "done" : "failed", results: [result] } : { ...approval, results: [result] };
}
