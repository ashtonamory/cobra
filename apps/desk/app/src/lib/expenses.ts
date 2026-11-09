/**
 * "Paid from" on a receipts card (agent receipts.ts): which of the Space's accounts paid each receipt, Cobra's
 * guess until the person picks another, and what Allow sends. The phone's `expensesRules.ts` is the same:
 * change both together.
 */
import type { ApprovalExpenses } from "../../../../../packages/contracts/src/approvals.ts";

/** The person's picks on one card: expense id to account id. */
export type AccountPicks = Readonly<Record<number, number>>;

/** What a receipt's choice shows: the account picked or guessed, else null with the Space's accounts to choose from; no choice when it keeps none. */
export function paidFrom(expenses: ApprovalExpenses, picks: AccountPicks, expense: number): number | null {
  const id = picks[expense] ?? expenses.items.find((i) => i.expense === expense)?.account;
  return id !== undefined && expenses.accounts?.some((a) => a.id === id) ? id : null;
}

/** The accounts sent with Allow: only the receipts the person changed; none when nothing changed. */
export function accountsAnswer(expenses: ApprovalExpenses, picks: AccountPicks): Record<string, number> | undefined {
  const changed = expenses.items.filter((i) => picks[i.expense] !== undefined && picks[i.expense] !== i.account);
  return changed.length ? Object.fromEntries(changed.map((i) => [String(i.expense), picks[i.expense]!])) : undefined;
}

// The picks of this window's cards, by approval id: Home's card sets them, Allow reads them (actions.ts).
let picks: Readonly<Record<string, AccountPicks>> = {};
const listeners = new Set<() => void>();
const NONE: AccountPicks = {};

export function accountPicks(approval: string): AccountPicks {
  return picks[approval] ?? NONE;
}

export function pickAccount(approval: string, expense: number, account: number): void {
  picks = { ...picks, [approval]: { ...accountPicks(approval), [expense]: account } };
  for (const listener of listeners) listener();
}

export function subscribePicks(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
