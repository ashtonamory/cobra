/**
 * Bills Cobra found or Money proposed for a Space (agent billsCard.ts, card kind `bills`): each bill ticked, a
 * click unticks one that is not the person's, and Allow keeps the ticked ones (lib/bills.ts). The phone's
 * `BillsPreview.tsx` draws the same: change both together.
 */
import { useSyncExternalStore } from "react";
import { billSkips, subscribeBills, toggleBill } from "../lib/bills.ts";
import { billRow, keepWords } from "../../../../../packages/contracts/src/billsCard.ts";
import type { ApprovalBills } from "../../../../../packages/contracts/src/approvals.ts";

export function BillsPreview({ approval, bills }: { approval: string; bills: ApprovalBills }) {
  const skipped = useSyncExternalStore(subscribeBills, () => billSkips(approval));
  return (
    <div className="bills">
      {bills.items.map((item) => {
        const row = billRow(item, bills.currency);
        const ticked = !skipped.has(item.bill);
        return (
          <label key={item.bill} className={`bill${ticked ? "" : " off"}`}>
            <input type="checkbox" checked={ticked} onChange={() => toggleBill(approval, item.bill)} />
            <span className="bill-name">{row.name}</span>
            <span className="bill-detail">{row.detail}</span>
          </label>
        );
      })}
      <div className="bill-detail">{keepWords(bills, skipped)}</div>
    </div>
  );
}
