/**
 * Bounces from Mail: the
 * agent searches the sending account's mail for failure notices from the
 * mail system and marks each failed address bounced in the Space that sent
 * to it, which stops every email to it until the owner lets it back.
 *
 * Only an address the Space's ledger sent to in the last 14 days counts, so
 * a forged notice naming someone else cannot stop their mail. Delay and
 * warning notices are passed over: only a final failure is a bounce.
 */

export const BOUNCE_QUERY = "from:(mailer-daemon OR postmaster) newer_than:3d";
/** How far back a send makes a notice about its address believable. */
export const BOUNCE_SENT_MS = 14 * 24 * 60 * 60_000;
/** Message ids remembered as read, so each notice is read once. */
export const BOUNCE_SEEN_MAX = 500;

export type BounceNotice = { id: string; subject: string; text: string };

export type BounceDeps = {
  /** The notices' ids and subjects (mailboxes.ts boxInbox). */
  search: (query: string) => Promise<{ id: string; subject: string }[]>;
  /** One notice: its subject, and as text only the addresses it named, read before scrubbing (mailboxes.ts boxInbox). */
  read: (id: string) => Promise<BounceNotice>;
  seen: () => string[];
  saveSeen: (ids: string[]) => void;
  /** The Spaces here whose ledger sent to this address since `since`. */
  sentTo: (email: string, since: Date) => string[];
  markBounced: (space: string, email: string, reason: string) => void;
  /** The address the mail goes from: never marked. */
  account: string;
  now: () => Date;
  log: (line: string) => void;
};

const FAILED = /fail|undeliver|not delivered|could not be delivered|returned mail|rejected|address not found/i;
const NOT_YET = /delay|delayed|warning|will retry|still trying|temporar/i;
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SYSTEM = /^(mailer-daemon|postmaster|no-?reply|noreply)@/i;

/** Every address a text names, as written, in order, once each (a notice's own, for the bounce check, before scrubbing takes them out). */
export function mailAddresses(text: string): string[] {
  return [...new Set([...text.matchAll(ADDRESS)].map((match) => match[0]))].slice(0, 100);
}

/** The addresses a final failure notice names (not the mail system's own); none for a delay or warning. */
export function failedAddresses(notice: Pick<BounceNotice, "subject" | "text">, account: string): string[] {
  if (!FAILED.test(notice.subject) || NOT_YET.test(notice.subject)) return [];
  const found = new Set<string>();
  for (const match of notice.text.matchAll(ADDRESS)) {
    const email = match[0].replace(/\.+$/, "").toLowerCase();
    if (SYSTEM.test(email) || email === account.toLowerCase()) continue;
    found.add(email);
  }
  return [...found].slice(0, 20);
}

/** One look at the account's recent failure notices; returns how many addresses it marked bounced. */
export async function checkBounces(deps: BounceDeps): Promise<number> {
  const seen = new Set(deps.seen());
  const notices = (await deps.search(BOUNCE_QUERY)).filter((n) => !seen.has(n.id));
  if (notices.length === 0) return 0;
  const since = new Date(deps.now().getTime() - BOUNCE_SENT_MS);
  let marked = 0;
  for (const summary of notices) {
    seen.add(summary.id);
    if (!FAILED.test(summary.subject) || NOT_YET.test(summary.subject)) continue;
    const notice = await deps.read(summary.id);
    for (const email of failedAddresses(notice, deps.account)) {
      for (const space of deps.sentTo(email, since)) {
        try {
          deps.markBounced(space, email, `Bounced: ${notice.subject}`.slice(0, 200));
          marked += 1;
          deps.log(`email bounce: ${email} marked bounced in ${space}`);
        } catch (caught) {
          deps.log(`email bounce: ${email} in ${space} not marked: ${caught instanceof Error ? caught.message : String(caught)}`);
        }
      }
    }
  }
  deps.saveSeen([...seen].slice(-BOUNCE_SEEN_MAX));
  return marked;
}
