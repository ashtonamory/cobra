/**
 * Every computer's All money for a month (agent `/money/all`, contracts allMoney.ts, rules lib/allMoney.ts):
 * asked of each linked computer at once, then again in the chosen currency of any that answered in another.
 * Read again every five minutes while shown, and whenever `month` changes.
 */
import { useEffect, useState } from "react";
import { useApp } from "../app/context.ts";
import * as api from "../lib/api.ts";
import * as config from "../lib/config.ts";
import { chosenCurrency, placed, toAskAgain, type Placed } from "../lib/allMoney.ts";
import { parseAllMoney, type AllMoney } from "../../../../../packages/contracts/src/allMoney.ts";

const REFRESH_MS = 5 * 60_000;

export type AllMoneyRead = { loaded: boolean; currency: string; spaces: Placed[]; away: string[] };

export function useAllMoney(month: string): AllMoneyRead {
  const app = useApp();
  const [read, setRead] = useState<AllMoneyRead>({ loaded: false, currency: "USD", spaces: [], away: [] });
  useEffect(() => {
    let live = true;
    const ask = async (machine: string, to?: string): Promise<AllMoney | null> => {
      try {
        return parseAllMoney(await api.allMoney(machine, month, to));
      } catch {
        return null;
      }
    };
    const load = async () => {
      const names = config.MACHINES.map((m) => m.machine);
      const first = await Promise.all(names.map((m) => ask(m)));
      const replies = first.map((r, i) => (r ? { ...r, machine: r.machine || names[i]! } : null));
      const answered = replies.filter((r): r is AllMoney => r !== null);
      const currency = chosenCurrency(answered);
      const again = toAskAgain(answered, currency);
      const redone = await Promise.all(again.map((m) => ask(m, currency)));
      const final = answered.map((r) => {
        const i = again.indexOf(r.machine);
        const fresh = i >= 0 ? redone[i] : null;
        // A computer that will not answer in the chosen currency is left out rather than mixed in.
        return i < 0 ? r : fresh && fresh.currency === currency ? { ...fresh, machine: r.machine } : null;
      }).filter((r): r is AllMoney => r !== null);
      if (!live) return;
      setRead({ loaded: true, currency, spaces: placed(final), away: names.filter((_, i) => replies[i] === null) });
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [month, app.machinesVersion]);
  return read;
}
