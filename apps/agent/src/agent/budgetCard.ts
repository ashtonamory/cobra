// The budget card: when Money's
// Foreman proposes a budget's limits (`db_write limits_propose`, trades/
// budget.ts), dbRoutes.ts hands the new proposal here and it becomes one card
// of kind `budget`: each category with what it averaged and its limit, the
// total, and what that leaves of the usual pay, in the Space's home currency.
// Allow makes the proposal count (`limits_allow`, as the person); Deny drops it
// (`limits_drop`). A newer proposal replaces an older card still waiting, as
// limits_propose drops its rows. The Foreman hears either answer. Until the
// apps draw it (frame 04 of the plan), it is the plain card: title and body.
import type { ApprovalBudget } from "@cobra/contracts";

import { makeApproval, settle, type StoredApproval } from "./approvals.ts";
import { BY_PERSON } from "./dbRoutes.ts";
import type { ProjectDb } from "./dbTypes.ts";
import { formatMoneyIn } from "../../../../packages/contracts/src/viewsRead.ts";
import { HOME_SQL } from "./trades/currency.ts";
import type { Needs } from "./onCall.ts";

export type BudgetCardDeps = {
  approvals: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };
  notify: (approval: StoredApproval) => Promise<void>;
  /** The Space a project is seated in, with its name; null for a project in no Space. */
  space: (project: string) => { id: string; name: string } | null;
  open: (space: string) => ProjectDb;
  stored: (space: string) => void;
  /** finishes.ts tell; `needs` "decision" for a refusal or a failure (onCall.ts). */
  tell: (project: string, text: string, needs?: Needs) => void;
  log: (line: string) => void;
  now: () => number;
};

const num = (value: unknown): number => Number(value ?? 0);

/** What a proposal holds, read from the store: its lines (fullest category first), its month, the home currency and the usual pay. */
export function readProposal(db: ProjectDb, batch: number): Omit<ApprovalBudget, "space" | "spaceName" | "project"> | null {
  const rows = db.queryRaw(
    `SELECT c.name AS category, l.avg_cents AS avg, l.limit_cents AS lim, l.from_month AS month
       FROM budget_limits l JOIN categories c ON c.id = l.category_id
      WHERE l.batch = ? AND l.status = 'proposed' ORDER BY l.limit_cents DESC, c.name`,
    [batch],
  ).rows;
  if (!rows.length) return null;
  const fromMonth = String(rows[0]!.month);
  const currency = String(db.queryRaw(`SELECT ${HOME_SQL} AS c`, []).rows[0]?.c ?? "USD");
  // Money in over the same three full months, in home cents at each day's rate, averaged over three.
  const [year, month] = fromMonth.split("-").map(Number) as [number, number];
  const start = new Date(Date.UTC(year, month - 4, 1)).toISOString().slice(0, 10);
  const pay = num(
    db.queryRaw(
      `SELECT SUM(COALESCE(fx(m.amount_cents, COALESCE((SELECT currency FROM accounts WHERE id = m.account_id), ?), ?, m.moved_on), m.amount_cents)) AS total
         FROM money_moves m WHERE m.kind = 'income' AND m.status = 'recorded' AND m.moved_on >= ? AND m.moved_on < ?`,
      [currency, currency, start, `${fromMonth}-01`],
    ).rows[0]?.total,
  );
  const lines = rows.map((r) => ({ category: String(r.category), avgCents: num(r.avg), limitCents: num(r.lim) }));
  return {
    batch,
    fromMonth,
    currency,
    lines,
    totalCents: lines.reduce((sum, l) => sum + l.limitCents, 0),
    ...(pay > 0 ? { payCents: Math.round(pay / 3) } : {}),
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthWords = (month: string): string => `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;

/** The card's words: one line per category (category · averaged · limit), the total, and what it leaves of the usual pay. */
export function budgetBody(card: ApprovalBudget): { title: string; body: string } {
  const money = (cents: number) => formatMoneyIn(cents, card.currency, card.currency);
  const title = `Set ${card.spaceName}'s budget from ${monthWords(card.fromMonth)}?`;
  const body = [
    ...card.lines.map((l) => (l.limitCents === 0 ? `${l.category} · no limit` : `${l.category} · usually ${money(l.avgCents)} · limit ${money(l.limitCents)}`)),
    `Total ${money(card.totalCents)} a month.`,
    ...(card.payCents !== undefined ? [card.payCents >= card.totalCents ? `That leaves ${money(card.payCents - card.totalCents)} of the usual ${money(card.payCents)} coming in.` : `That is ${money(card.totalCents - card.payCents)} more than the usual ${money(card.payCents)} coming in.`] : []),
    "Allow sets these limits; you can change one any time by asking Cobra.",
  ].join("\n");
  return { title, body };
}

/** A proposal just written becomes its card; an older budget card for the Space still waiting is closed, since its rows were dropped. */
export async function proposeBudgetCard(deps: BudgetCardDeps, project: string, db: ProjectDb, batch: number, by: string): Promise<StoredApproval | null> {
  const space = deps.space(project);
  if (!space) return null;
  const proposal = readProposal(db, batch);
  if (!proposal) return null;
  const card: ApprovalBudget = { space: space.id, spaceName: space.name, project, ...proposal };
  const { title, body } = budgetBody(card);
  const now = deps.now();
  const approval = makeApproval({ kind: "budget", title, body, requestedBy: by, budget: card }, now);
  const current = settle(deps.approvals.load(), now).map((a) =>
    a.kind === "budget" && a.state === "pending" && a.budget?.space === space.id ? { ...a, state: "expired" as const, results: [{ ok: false, message: "A newer budget replaced it" }] } : a,
  );
  deps.approvals.save([...current, approval]);
  deps.log(`budget ${approval.id}: proposal ${batch} for ${space.id}, ${card.lines.length} limit(s)`);
  await deps.notify(approval);
  return approval;
}

/** The person's answer: Allow makes the proposal count, Deny drops it; the Foreman hears which. */
export function settleBudgetApproval(deps: Pick<BudgetCardDeps, "open" | "stored" | "tell">, approval: StoredApproval): StoredApproval {
  const card = approval.budget;
  if (approval.kind !== "budget" || !card) return approval;
  const allowed = approval.state === "allowed";
  const db = deps.open(card.space);
  let result: { ok: boolean; message: string };
  try {
    db.write(allowed ? "limits_allow" : "limits_drop", { batch: card.batch }, BY_PERSON);
    result = { ok: true, message: allowed ? `Set ${card.lines.length} limit${card.lines.length === 1 ? "" : "s"} from ${monthWords(card.fromMonth)}` : "Dropped the proposal" };
  } catch (caught) {
    result = { ok: false, message: caught instanceof Error ? caught.message : String(caught) };
  } finally {
    db.close();
  }
  deps.stored(card.space);
  deps.tell(card.project, allowed ? (result.ok ? `The person allowed the budget (proposal ${card.batch}): its limits count from ${card.fromMonth}.` : `The person allowed the budget (proposal ${card.batch}), but it could not be set: ${result.message}`) : `The person said no to the budget (proposal ${card.batch}); ask what they would change.`, allowed && result.ok ? "info" : "decision");
  return allowed ? { ...approval, state: result.ok ? "done" : "failed", results: [result] } : { ...approval, results: [result] };
}
