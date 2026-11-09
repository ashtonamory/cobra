/**
 * The bills card (agent billsCard.ts, kind `bills`): which bills the person unticked before Allow, sent as `skip`.
 * The words come from contracts billsCard.ts, shared with the phone's `BillsPreview.tsx`, which keeps the same store.
 */

// The bills unticked on this window's cards, by approval id: Home's card sets them, Allow reads them (actions.ts).
let unticked: Readonly<Record<string, ReadonlySet<number>>> = {};
const listeners = new Set<() => void>();
const NONE: ReadonlySet<number> = new Set();

export function billSkips(approval: string): ReadonlySet<number> {
  return unticked[approval] ?? NONE;
}

export function toggleBill(approval: string, bill: number): void {
  const next = new Set(billSkips(approval));
  if (next.has(bill)) next.delete(bill);
  else next.add(bill);
  unticked = { ...unticked, [approval]: next };
  for (const listener of listeners) listener();
}

export function subscribeBills(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
