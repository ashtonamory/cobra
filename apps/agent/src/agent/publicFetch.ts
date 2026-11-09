import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

/**
 * The agent's own fetch of a public address: the web reader's page
 * (webReader.ts) and the github-mcp-server downloads (mcp.ts, mcpInstall.ts).
 *
 * Checking a name and then calling `fetch(url)` resolves it twice: a name
 * with a short TTL, or two A records, passes as public and then connects to
 * 127.0.0.1 or the cloud's metadata service at 169.254.169.254
 * (OV-SEC-VPS-001 F8). Here the name is resolved once, every address is
 * checked, and the connection is pinned to those addresses: the socket's own
 * lookup answers only with them, so nothing resolves the name again. A
 * redirect is a new name, checked the same way, at most REDIRECTS hops.
 *
 * node:http(s) rather than an undici Agent: undici is not a dependency of
 * the agent, and `request`'s `lookup` option is the same pin. TLS still
 * checks the certificate against the name (SNI and the check use the host,
 * never the address).
 */

export const REDIRECTS = 5;

export type Address = { address: string; family: number };
/** Every address a name resolves to (dns.lookup with all: true). */
export type Resolve = (host: string) => Promise<Address[]>;

export const liveResolve: Resolve = (host) => dnsLookup(host, { all: true });

/** An address no public site has: loopback, private, link-local (the metadata service), carrier NAT (the tailnet), unique local. */
export function privateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const v4 = mapped ? mapped[1]! : isIP(address) === 4 ? address : null;
  if (v4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = address.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

export type PublicDeps = {
  resolve: Resolve;
  /** Whether an address may never be connected to; a test marks a loopback one public to serve the page itself. */
  isPrivate: (address: string) => boolean;
};

export const liveDeps: PublicDeps = { resolve: liveResolve, isPrivate: privateAddress };

/**
 * The addresses `host` may be connected to, resolved once and every one
 * public, or why not. ENOTFOUND is named in the words: webClaims.ts reads it
 * as a name that does not exist.
 */
export async function vetHost(host: string, deps: PublicDeps = liveDeps): Promise<{ addresses: Address[] } | { error: string }> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) {
    if (deps.isPrivate(bare)) return { error: `${host} is a private address, which is never part of the web` };
    return { addresses: [{ address: bare, family: isIP(bare) }] };
  }
  let missing = "";
  const addresses = await deps.resolve(bare).catch((caught: unknown) => {
    // A lookup that failed otherwise (a timeout) may work later.
    missing = (caught as { code?: unknown } | null)?.code === "ENOTFOUND" ? " (ENOTFOUND)" : "";
    return [] as Address[];
  });
  if (addresses.length === 0) return { error: `${host} could not be found${missing}` };
  if (addresses.some((entry) => deps.isPrivate(entry.address))) return { error: `${host} points at a private address, which is never part of the web` };
  return { addresses };
}

/** A socket lookup that answers only with `addresses`, the ones vetHost checked, and only for `host`. */
export function pinnedLookup(host: string, addresses: readonly Address[]): LookupFunction {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (hostname.toLowerCase() !== name || addresses.length === 0) return callback(Object.assign(new Error(`${hostname} is not the name that was checked`), { code: "ENOTFOUND" }));
    if (options?.all) return callback(null, addresses.map((entry) => ({ ...entry })));
    callback(null, addresses[0]!.address, addresses[0]!.family);
  }) as unknown as LookupFunction;
}

export type PublicInit = {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** "follow" (the default) follows up to REDIRECTS hops, each one checked; "manual" gives a redirect back as it came. */
  redirect?: "follow" | "manual";
};

/** One GET to addresses already checked: no redirect followed, the body as a web stream. */
export function pinnedGet(url: URL, addresses: readonly Address[], init: PublicInit = {}): Promise<Response> {
  const https = url.protocol === "https:";
  if (!https && url.protocol !== "http:") return Promise.reject(new Error(`${url.protocol} is not a web address`));
  return new Promise((resolve, reject) => {
    const options = {
      method: "GET",
      headers: init.headers ?? {},
      // A socket of its own, never a pooled one opened to some other address.
      agent: false as const,
      lookup: pinnedLookup(url.hostname, addresses),
      ...(init.signal ? { signal: init.signal } : {}),
    };
    const req = (https ? httpsRequest : httpRequest)(url, options, (reply: IncomingMessage) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(reply.headers)) {
        if (Array.isArray(value)) for (const one of value) headers.append(name, one);
        else if (value !== undefined) headers.set(name, value);
      }
      const status = reply.statusCode ?? 502;
      // A Response with one of these statuses has no body.
      if (status < 200 || [204, 205, 304].includes(status)) {
        reply.resume();
        return resolve(new Response(null, { status: status < 200 ? 502 : status, headers }));
      }
      resolve(new Response(Readable.toWeb(reply) as ReadableStream<Uint8Array>, { status, headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * GET `url`, every hop's name resolved once, checked and pinned. Throws with
 * words to show when a name is private or missing, a redirect leaves https
 * for plain http, or there are more than REDIRECTS hops.
 */
export async function publicFetch(url: string, init: PublicInit = {}, deps: PublicDeps = liveDeps): Promise<Response> {
  let at = new URL(url);
  for (let hop = 0; hop <= REDIRECTS; hop += 1) {
    const vetted = await vetHost(at.hostname, deps);
    if ("error" in vetted) throw new Error(vetted.error);
    const response = await pinnedGet(at, vetted.addresses, init);
    const location = response.headers.get("location");
    if (init.redirect === "manual" || response.status < 300 || response.status >= 400 || !location) return response;
    await response.body?.cancel().catch(() => undefined);
    const next = new URL(location, at);
    if (at.protocol === "https:" && next.protocol !== "https:") throw new Error(`${at.hostname} redirected to a plain ${next.protocol} address`);
    at = next;
  }
  throw new Error(`the address redirected more than ${REDIRECTS} times`);
}
