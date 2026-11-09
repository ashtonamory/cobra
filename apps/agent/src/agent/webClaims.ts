import { readFileSync } from "node:fs";
import { join } from "node:path";

import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";

/**
 * Pages that are not what their address claims (2026-10-29: a Pilates
 * studio's old domain served a betting page, and yoga.gd answered with
 * another business's certificate). Checked after each page read, from what
 * came back, by fixed rules and no model:
 *
 *   off-topic    the page is about betting, adult content, scam loans or
 *                pills, and its address does not name that; or its address
 *                names a kind of business (yoga, a salon) that the page
 *                never mentions (the page's own text, the Pi reader's) or
 *                that the read says it is not (Claude Code's summary)
 *   parked       a parked or for-sale domain page, not a working site
 *   certificate  its security certificate is another site's, or not valid
 *   gone         the address does not exist
 *
 * The agent that read it is told at once (the hook's additionalContext, or
 * the Pi reader's answer) to treat the site and anything from it as
 * unverified and say so in its report; the read is marked "Not what it
 * claims" in its research run (webRuns.ts markRead); and the site stays out
 * of research for FLAG_MS (checkInRun refuses it).
 *
 * A shared platform (a social site, a directory, an encyclopedia, a search
 * engine) holds pages about anything, so its pages are never checked.
 */

export type ClaimKind = "off-topic" | "parked" | "certificate" | "gone";
export type Claim = { kind: ClaimKind; why: string };

export type SiteFlag = { site: string; url: string; at: string; kind: ClaimKind; why: string; who: string };

export const WEB_FLAGS_PATH = join(STATE_DIR, "web-flags.json");
/** How long a flagged site stays out of research. */
export const FLAG_MS = 30 * 24 * 60 * 60_000;
const FLAGS_MAX = 500;

type Topic = { name: string; words: RegExp; strong: RegExp; host: RegExp };

/** What a business's page is never about. Two different words of one, or one telling phrase, make the page about it. */
const TOPICS: readonly Topic[] = [
  {
    name: "betting or gambling",
    words: /\b(?:casinos?|betting|bets|sportsbooks?|bookmakers?|gambling|slots?|poker|roulette|jackpots?|baccarat|blackjack|togel|judi|gacor|wagering)\b/gi,
    strong: /\b(?:online casino|sports betting|slot online|online slots?|judi online|betting site|gambling site|casino site)\b/i,
    host: /casino|bet|gambl|slot|poker|lotto|lotter|wager/,
  },
  {
    name: "adult content",
    words: /\b(?:porn|pornography|xxx|escorts?|camgirls?|webcams? sex|nude|nsfw|onlyfans)\b/gi,
    strong: /\b(?:adult (?:videos?|content|site)|sex cams?|porn site)\b/i,
    host: /porn|xxx|sex|adult|escort|cam/,
  },
  {
    name: "loans or investment schemes",
    words: /\b(?:payday|loans?|forex|binary options|crypto(?:currency)? investment|guaranteed returns|cash advance)\b/gi,
    strong: /\b(?:payday loans?|binary options|crypto(?:currency)? investment|guaranteed returns)\b/i,
    host: /loan|cash|credit|forex|crypto|coin|invest|finance|bank/,
  },
  {
    name: "pills",
    words: /\b(?:viagra|cialis|levitra|tramadol|online pharmacy|no prescription)\b/gi,
    strong: /\b(?:online pharmacy|without (?:a )?prescription|no prescription)\b/i,
    host: /pharm|rx|pill|med|drug/,
  },
];

/**
 * Kinds of business an address can name, by the start of the word: a page
 * on such an address that never says it is a stranger's. Long enough not to
 * hide inside other words of a host.
 */
const CLAIMS: readonly string[] = ["yoga", "pilates", "fitness", "wellness", "massage", "salon", "barber", "beauty", "dental", "dentist", "chiro", "physio", "landscap", "lawncare", "plumb", "roofing", "bakery", "restaurant", "hotel", "resort", "villa", "rentals", "realty", "church", "academy", "studio"];
/** The least page text that is a page, not a placeholder or a challenge. */
const TEXT_MIN = 300;

const PARKED = /\b(?:(?:this |the )?domain (?:name )?(?:is |may be |might be )?(?:for sale|available for purchase|parked)|buy this domain|parked (?:domain|page|free|by)|domain parking|(?:is|has been) parked|this (?:page|site) is parked|default (?:web )?page (?:of|for) (?:the )?(?:hosting|server)|account (?:has been )?suspended)\b/i;

const CERTIFICATE = /altnames|certificate|CERT_|self[- ]signed|UNABLE_TO_VERIFY|ERR_SSL|SSL routines/i;
const GONE = /ENOTFOUND|NXDOMAIN|getaddrinfo ENOTFOUND|no such host|could not resolve host/i;

/** Hosts many businesses share: one page of them never keeps the whole site out. */
const SHARED = /(?:^|\.)(?:google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.com|facebook\.com|fb\.com|instagram\.com|linkedin\.com|x\.com|twitter\.com|tiktok\.com|youtube\.com|pinterest\.[a-z.]+|reddit\.com|yelp\.[a-z.]+|tripadvisor\.[a-z.]+|wikipedia\.org|medium\.com|substack\.com|wordpress\.com|blogspot\.com|wixsite\.com|squarespace\.com|godaddysites\.com|linktr\.ee|mindbodyonline\.com|classpass\.com|eventbrite\.[a-z.]+|github\.com|amazon\.[a-z.]+|apple\.com)$/;

/** The site a flag keeps out: the host, without www. */
export function siteOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return host ? host.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

export function sharedSite(site: string): boolean {
  return SHARED.test(site);
}

function distinct(text: string, words: RegExp): number {
  return new Set([...text.matchAll(words)].map((match) => match[0].toLowerCase().replace(/s$/, ""))).size;
}

/**
 * What a read says of its page, or null when it is what it claims. `text`
 * is what came back (Claude Code's summary of the page, or the Pi reader's
 * visible text); `error` is why it did not load.
 */
export function pageClaim(url: string, read: { text?: string; error?: string; raw?: boolean }): Claim | null {
  const site = siteOf(url);
  if (!site || sharedSite(site)) return null;
  if (read.error !== undefined) {
    const error = read.error;
    if (CERTIFICATE.test(error)) {
      const other = /DNS:([A-Za-z0-9.*-]+)/.exec(error)?.[1];
      return { kind: "certificate", why: other ? `its security certificate is for another site (${other}), not ${site}` : `its security certificate is not valid for ${site}` };
    }
    if (GONE.test(error)) return { kind: "gone", why: `the address ${site} does not exist` };
    return null;
  }
  const text = (read.text ?? "").slice(0, 200_000);
  if (!text.trim()) return null;
  if (PARKED.test(text)) return { kind: "parked", why: `${site} is a parked or for-sale domain page, not a working site` };
  const bare = site.replace(/[^a-z0-9]/g, "");
  for (const topic of TOPICS) {
    if (topic.host.test(bare)) continue;
    if (topic.strong.test(text) || distinct(text, topic.words) >= 2) return { kind: "off-topic", why: `${site} shows a ${topic.name} page, not the business its address names` };
  }
  const named = CLAIMS.filter((word) => bare.includes(word));
  if (named.length === 0) return null;
  const words = named.join(" or ");
  if (read.raw) {
    // The page itself: one that is long enough to be a page and never says what its address names.
    if (text.length >= TEXT_MIN && !named.some((word) => new RegExp(`\\b${word}`, "i").test(text))) return { kind: "off-topic", why: `${site} names ${words}, but its page never mentions it` };
    return null;
  }
  // A summary: it says so ("not a yoga studio", "nothing to do with pilates").
  const denies = named.some((word) => new RegExp(`\\b(?:not|isn't|no longer) (?:an? |the )(?:[\\w'-]+ ){0,2}${word}|\\b(?:unrelated to|nothing to do with) (?:an? |the )?(?:[\\w'-]+ ){0,2}${word}`, "i").test(text));
  return denies ? { kind: "off-topic", why: `${site} names ${words}, but its page is about something else` } : null;
}

// --- the flags ----------------------------------------------------------------------------------------

export function parseFlags(text: string): SiteFlag[] {
  try {
    const raw = JSON.parse(text) as { flags?: unknown };
    return Array.isArray(raw.flags) ? (raw.flags as SiteFlag[]).filter((flag) => typeof flag?.site === "string" && typeof flag.at === "string" && typeof flag.why === "string") : [];
  } catch {
    return [];
  }
}

export function loadFlags(path = WEB_FLAGS_PATH): SiteFlag[] {
  try {
    return parseFlags(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

export function saveFlags(list: readonly SiteFlag[], now = Date.now(), path = WEB_FLAGS_PATH): void {
  const kept = list.filter((flag) => now - Date.parse(flag.at) < FLAG_MS).slice(-FLAGS_MAX);
  writePrivateFile(path, `${JSON.stringify({ flags: kept }, null, 2)}\n`);
}

/** The flag that keeps this address out of research now, if any. */
export function flaggedSite(list: readonly SiteFlag[], url: string, now: number): SiteFlag | undefined {
  const site = siteOf(url);
  if (!site) return undefined;
  return list.findLast((flag) => flag.site === site && now - Date.parse(flag.at) < FLAG_MS);
}

/** Why a flagged site is refused, for the run's read and the agent. */
export function flagReason(flag: SiteFlag): string {
  const until = new Date(Date.parse(flag.at) + FLAG_MS).toISOString().slice(0, 10);
  return `Cobra found on ${flag.at.slice(0, 10)} that ${flag.why}, so it stays out of research until ${until}; treat anything it lists as unverified`;
}

// --- after a read ---------------------------------------------------------------------------------------

export type AfterOutput = { hookSpecificOutput: { hookEventName: "PostToolUse" | "PostToolUseFailure"; additionalContext: string } };

export type ClaimDeps = {
  load: () => SiteFlag[];
  save: (list: readonly SiteFlag[]) => void;
  /** Marks the read in the reader's research run (webRuns.ts markRead). */
  mark: (who: string, url: string, why: string) => void;
  /** Passes the flag up the chain (index.ts: a briefed Foreman's read to Cobra); none when absent. */
  tell?: (who: string, site: string, why: string) => void;
  log: (line: string) => void;
  now: () => number;
};

/** What the reader is told of a page that is not what it claims. */
export function claimNote(url: string, claim: Claim): string {
  return `Cobra: ${url} is not what its address claims: ${claim.why}. Treat this site and anything taken from it (a name, an email, a phone number, an owner) as unverified: do not use it as a source, and say so in your report, so nothing from it is added or marked as checked.`;
}

/**
 * One page read seen: the flag, the run's mark and the note for the reader,
 * or nothing when the page is what it claims. `who` is lead,
 * foreman:<project> or worker:<id>.
 */
export function noteClaim(deps: ClaimDeps, who: string, url: string, claim: Claim): string {
  const site = siteOf(url)!;
  const now = deps.now();
  if (!flaggedSite(deps.load(), url, now)) {
    deps.save([...deps.load(), { site, url: url.slice(0, 300), at: new Date(now).toISOString(), kind: claim.kind, why: claim.why, who }]);
  }
  try {
    deps.mark(who, url, claim.why);
  } catch {
    // The flag and the note stand without the run's mark.
  }
  try {
    deps.tell?.(who, site, claim.why);
  } catch {
    // The reader is told all the same.
  }
  deps.log(`web: ${who} read ${site}, not what it claims (${claim.kind}): ${claim.why}`);
  return claimNote(url, claim);
}

/** Whether a hook event is a page read's after-event (PostToolUse or PostToolUseFailure). */
export function isAfterEvent(event: unknown): boolean {
  const name = (event as { hook_event_name?: unknown } | null)?.hook_event_name;
  return name === "PostToolUse" || name === "PostToolUseFailure";
}

/** A WebFetch's after-event (Claude Code's hook JSON) answered: a note for the reader, or null. */
export function answerAfter(deps: ClaimDeps, who: string, event: unknown): AfterOutput | null {
  if (!isAfterEvent(event)) return null;
  const raw = event as { hook_event_name: "PostToolUse" | "PostToolUseFailure"; tool_name?: unknown; tool_input?: { url?: unknown }; tool_response?: unknown; error?: unknown };
  if (raw.tool_name !== "WebFetch" || typeof raw.tool_input?.url !== "string") return null;
  const url = raw.tool_input.url;
  const response = raw.tool_response as { result?: unknown } | string | undefined;
  const read =
    raw.hook_event_name === "PostToolUseFailure"
      ? { error: typeof raw.error === "string" ? raw.error : JSON.stringify(raw.error ?? "") }
      : { text: typeof response === "string" ? response : typeof response?.result === "string" ? response.result : "" };
  const claim = pageClaim(url, read);
  if (!claim) return null;
  return { hookSpecificOutput: { hookEventName: raw.hook_event_name, additionalContext: noteClaim(deps, who, url, claim) } };
}

/**
 * The after-read hooks for a Claude Code session's settings: the same
 * command as its PreToolUse policy hook, which sends the event to the Gate.
 */
export function afterReadHooks(command: string): Record<string, unknown[]> {
  const entry = { matcher: "WebFetch", hooks: [{ type: "command", command, timeout: 15 }] };
  return { PostToolUse: [entry], PostToolUseFailure: [entry] };
}

export function liveClaimDeps(log: (line: string) => void): ClaimDeps {
  return {
    load: () => loadFlags(),
    save: (list) => saveFlags(list),
    mark: (who, url, why) => {
      void import("./webRuns.ts").then(({ markRead, liveRunStore }) => markRead(liveRunStore(), who, url, why));
    },
    log,
    now: () => Date.now(),
  };
}
