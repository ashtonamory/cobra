/**
 * Receipts Cobra read for a Space (agent receipts.ts, card kind `expenses`): each photo, fetched from the
 * Space's computer as a shown design is (Rust `design_image`), with what she read off it, so the person checks
 * before Allow, and which account paid it ("Paid from", lib/expenses.ts). The phone's `ExpensesPreview.tsx` draws
 * the same: change both together.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { bridge } from "../lib/bridge.ts";
import { accountPicks, paidFrom, pickAccount, subscribePicks } from "../lib/expenses.ts";
import { receiptAmounts } from "../../../../../packages/contracts/src/viewsRead.ts";
import type { ApprovalExpenses } from "../../../../../packages/contracts/src/approvals.ts";

const photos = new Map<string, Promise<string>>();

function photoUrl(machine: string, path: string): Promise<string> {
  const key = `${machine}:${path}`;
  let found = photos.get(key);
  if (!found) {
    found = bridge.designImage(machine, path);
    found.catch(() => photos.delete(key));
    photos.set(key, found);
  }
  return found;
}

type Account = NonNullable<ApprovalExpenses["accounts"]>[number];

function Receipt({ machine, item, currency, accounts, paid, onPaid }: { machine: string; item: ApprovalExpenses["items"][number]; currency: string; accounts: readonly Account[]; paid: number | null; onPaid: (account: number) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    photoUrl(machine, item.file).then((got) => current && setUrl(got), () => undefined);
    return () => { current = false; };
  }, [machine, item.file]);
  const amount = receiptAmounts(item, currency);
  return (
    <div className="receipt" title={`${item.vendor} · ${item.date} · ${item.category}${item.match ? ` · matches "${item.match.description}"` : ""}`}>
      <div className="receipt-photo">{url ? <img src={url} alt={`Receipt from ${item.vendor}`} /> : null}</div>
      <div className="receipt-amount">{amount.own}</div>
      {amount.home ? <div className="receipt-vendor">{amount.home}</div> : null}
      <div className="receipt-vendor">{item.vendor}</div>
      {accounts.length ? (
        <select className={`receipt-paid${paid === null ? " ask" : ""}`} aria-label={`Paid from, ${item.vendor}`} value={paid ?? ""} onChange={(e) => onPaid(Number(e.target.value))}>
          {paid === null ? <option value="" disabled>Paid from?</option> : null}
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      ) : null}
    </div>
  );
}

export function ExpensesPreview({ machine, approval, expenses }: { machine: string; approval: string; expenses: ApprovalExpenses }) {
  const picks = useSyncExternalStore(subscribePicks, () => accountPicks(approval));
  if (expenses.items.length === 0) return null;
  return (
    <div className="receipts">
      {expenses.items.map((item) => (
        <Receipt key={item.expense} machine={machine} item={item} currency={expenses.currency} accounts={expenses.accounts ?? []}
          paid={paidFrom(expenses, picks, item.expense)} onPaid={(account) => pickAccount(approval, item.expense, account)} />
      ))}
    </div>
  );
}
