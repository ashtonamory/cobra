import { looksRandom } from "./redact.ts";

/**
 * The research run's code rules: which web
 * calls leave a run before any model sees them. Pure.
 *
 * A run lets the searches and page reads that serve one goal go without a
 * judgement each. Some calls never belong to a run, whatever the goal says:
 *
 *   refuse  a sign-in, account, checkout or payment page, an address that is
 *           not a public name (an IP, a port, a local name), anything but
 *           http(s), or a query that looks like data being sent out. The
 *           orchestrator is told why and works without it.
 *   ask     a people-search site, a person's own social profile or a
 *           private group: public business details are fine to collect,
 *           a private person's are the person's to decide.
 *
 * Anything else is `in`, for the run's goal check to decide.
 */

export type WebCall = { tool: "WebFetch"; url: string } | { tool: "WebSearch"; query: string };

export type RuleVerdict =
  | { verdict: "in"; host?: string }
  | { verdict: "refuse"; reason: string }
  | { verdict: "ask"; reason: string };

/** The longest search a run reads as a search, not as text being carried out. */
export const QUERY_MAX = 300;
/** The longest single query value in a URL a run lets through. */
export const PARAM_MAX = 200;

/** Sites that sell or list private people's addresses, phones and records. */
export const PEOPLE_SEARCH: ReadonlySet<string> = new Set([
  "whitepages.com",
  "spokeo.com",
  "beenverified.com",
  "truepeoplesearch.com",
  "fastpeoplesearch.com",
  "intelius.com",
  "peoplefinders.com",
  "radaris.com",
  "mylife.com",
  "instantcheckmate.com",
  "truthfinder.com",
  "pipl.com",
  "zabasearch.com",
  "thatsthem.com",
  "peekyou.com",
  "familytreenow.com",
  "usphonebook.com",
  "searchpeoplefree.com",
  "clustrmaps.com",
  "nuwber.com",
  "peoplelooker.com",
  "411.com",
]);

/** Hosts whose every page is a sign-in or a payment. */
const ACCOUNT_HOSTS = [/^accounts\.google\.com$/, /^login\./, /^signin\./, /^auth\./, /^sso\./, /^id\./, /^checkout\./, /^pay\./, /^(?:www\.)?paypal\.com$/, /^checkout\.stripe\.com$/, /^billing\./];

/** A path that is a sign-in, an account, a cart or a payment. */
const ACCOUNT_PATH = /\/(?:log-?in|sign-?in|sign-?up|signup|register|auth|oauth2?|sso|account|accounts|my-?account|checkout|cart|basket|payment|payments|pay|billing|password|reset-password|wallet)(?:[/?#.]|$)/i;

/** A search for credentials or a way in, whatever the goal. */
const ACCOUNT_QUERY = /\b(?:password|passwd|login credentials|api[ _-]?key|secret key|access token|ssn|social security number|credit card number)\b/i;

/** The registrable part of a host, for the lists: `www.whitepages.com` → `whitepages.com`. */
function site(host: string): string {
  const parts = host.split(".");
  return parts.slice(-2).join(".");
}

/** A personal profile or a private group on a social site; a business's own page passes. */
function personalSocial(host: string, path: string, params: URLSearchParams): string | null {
  const name = site(host);
  if (name === "facebook.com" || name === "fb.com") {
    if (/^\/profile\.php/i.test(path) || /^\/people\//i.test(path) || (params.has("id") && /^\/profile/i.test(path))) return "a person's Facebook profile";
    if (/^\/groups\//i.test(path)) return "a Facebook group";
  }
  if (name === "linkedin.com" && /^\/in\//i.test(path)) return "a person's LinkedIn profile";
  return null;
}

/** A value in a URL that looks like data being sent out: long, or encoded. */
function carriesData(value: string): boolean {
  if (value.length > PARAM_MAX) return true;
  return value.split(/[\s,;:|]+/).some((part) => looksRandom(part));
}

/** What the run's rules say of one call, before its goal is asked. */
export function webCallRule(call: WebCall): RuleVerdict {
  if (call.tool === "WebSearch") {
    const query = call.query.trim();
    if (!query) return { verdict: "refuse", reason: "an empty search" };
    if (query.length > QUERY_MAX) return { verdict: "refuse", reason: `a search of over ${QUERY_MAX} characters reads like text being sent out, not a search` };
    if (carriesData(query)) return { verdict: "refuse", reason: "the search holds an encoded value, which reads like data being sent out" };
    if (ACCOUNT_QUERY.test(query)) return { verdict: "refuse", reason: "research never searches for passwords, keys or private numbers" };
    return { verdict: "in" };
  }
  let url: URL;
  try {
    url = new URL(call.url);
  } catch {
    return { verdict: "refuse", reason: "that is not a web address Cobra can read" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { verdict: "refuse", reason: `research reads http and https pages only, not ${url.protocol}` };
  if (url.username || url.password) return { verdict: "refuse", reason: "an address with a name or password in it" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (/^\[|^\d{1,3}(?:\.\d{1,3}){3}$|^\d+$/.test(host)) return { verdict: "refuse", reason: "research reads sites by name, not by IP address" };
  if (!host.includes(".") || /\.(?:local|internal|lan|home|localhost|ts\.net)$/.test(host)) return { verdict: "refuse", reason: "that is a local name, not a public website" };
  if (url.port && url.port !== "80" && url.port !== "443") return { verdict: "refuse", reason: "research reads public sites on their usual ports only" };
  if (ACCOUNT_HOSTS.some((pattern) => pattern.test(host)) || ACCOUNT_PATH.test(url.pathname)) return { verdict: "refuse", reason: "a sign-in, account or payment page is never part of research" };
  for (const value of [...url.searchParams.values(), decodeURIComponent(url.hash.slice(1))]) {
    if (carriesData(value)) return { verdict: "refuse", reason: "the address carries a long or encoded value, which reads like data being sent out" };
  }
  if (PEOPLE_SEARCH.has(site(host))) return { verdict: "ask", reason: `${site(host)} lists private people's details, so the person decides` };
  const social = personalSocial(host, url.pathname, url.searchParams);
  if (social) return { verdict: "ask", reason: `${social} is a private person's page, so the person decides` };
  return { verdict: "in", host };
}

/** The call a hook event names, or null for anything else. */
export function webCallOf(tool: string, input: Record<string, unknown>): WebCall | null {
  if (tool === "WebFetch" && typeof input.url === "string") return { tool, url: input.url };
  if (tool === "WebSearch" && typeof input.query === "string") return { tool, query: input.query };
  return null;
}
