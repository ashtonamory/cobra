// The bills card's words, shared by the
// agent (billsCard.ts writes the card's body), the phone and the desk (which
// draw each bill as a row to tick). Plain functions, no zod, so the agent
// imports it by path.
import type { ApprovalBills } from "./approvals.ts";
import { formatMoneyIn } from "./viewsRead.ts";

type Item = ApprovalBills["items"][number];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

/** When a bill is due, in words: "monthly on the 1st", or "every year on 3 Mar". */
export function dueWords(every: string, nextOn: string): string {
  const day = Number(nextOn.slice(8, 10));
  return every === "year" ? `every year on ${day} ${MONTHS[Number(nextOn.slice(5, 7)) - 1] ?? ""}` : `monthly on the ${ordinal(day)}`;
}

/** A bill's row: its name, then "EC$1,500.00 monthly on the 1st · Housing · paid 3 times lately". */
export function billRow(item: Item, home: string): { name: string; detail: string } {
  const seen = item.seen && item.seen > 1 ? ` · paid ${item.seen} times lately` : "";
  return { name: item.name, detail: `${formatMoneyIn(item.amountCents, item.currency, home)} ${dueWords(item.every, item.nextOn)}${item.category ? ` · ${item.category}` : ""}${seen}` };
}

/** The `skip` sent with Allow: the bills the person unticked; none when every bill stays ticked. */
export function skipAnswer(card: ApprovalBills, unticked: ReadonlySet<number>): number[] | undefined {
  const skip = card.items.filter((i) => unticked.has(i.bill)).map((i) => i.bill);
  return skip.length ? skip : undefined;
}

/** What Allow does, under the rows: "Allow keeps 2 of 3", or that it keeps none. */
export function keepWords(card: ApprovalBills, unticked: ReadonlySet<number>): string {
  const kept = card.items.filter((i) => !unticked.has(i.bill)).length;
  if (kept === 0) return "None ticked: Allow keeps none of them.";
  return kept === card.items.length ? `About ${formatMoneyIn(card.monthlyCents, card.currency, card.currency)} a month. Untick any that are not yours.` : `Allow keeps ${kept} of ${card.items.length}.`;
}
