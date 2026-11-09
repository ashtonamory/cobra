// The rates feed's tick (fx.ts): once an hour it
// reads which currencies the Spaces here keep money in, and refreshRates reads
// the ECB's rates once a day when one of them is neither the dollar nor pegged
// to it. Off with COBRA_RATES=off (the last rates kept still convert).
import { openProjectDb } from "./db.ts";
import { currencyCode, refreshRates } from "./fx.ts";
import { listSpaces, SPACES_DIR } from "./spaces.ts";
import { SPACE_SCHEMA } from "./trades/space.ts";

/** Every currency a Space store here names: its home one, its accounts' and its receipts'. */
export function spaceCurrencies(spacesRoot: string = SPACES_DIR, log: (line: string) => void = () => {}): string[] {
  const found = new Set<string>();
  for (const space of listSpaces(spacesRoot)) {
    try {
      const db = openProjectDb(`space-${space.id}`, SPACE_SCHEMA);
      try {
        const sql = `SELECT currency AS c FROM business UNION SELECT currency FROM accounts UNION SELECT paid_currency FROM expenses`;
        for (const row of db.query(sql, [], 200).rows) {
          const code = currencyCode(row.c);
          if (code) found.add(code);
        }
      } finally {
        db.close();
      }
    } catch (caught) {
      log(`fx: ${space.id}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  return [...found].sort();
}

const localDay = (at: Date): string => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

export function startRates(log: (line: string) => void): () => void {
  if (process.env.COBRA_RATES === "off") return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await refreshRates({ fetch: (url) => fetch(url, { signal: AbortSignal.timeout(15_000) }), today: localDay(new Date()), currencies: spaceCurrencies(SPACES_DIR, log), log });
    } catch (caught) {
      log(`fx: ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 45_000);
  const timer = setInterval(() => void tick(), 60 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
