import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { pinnedLookup, privateAddress, publicFetch, REDIRECTS, vetHost, type Address, type PublicDeps } from "./publicFetch.ts";

/**
 * Two servers on one port: 127.0.0.1 plays the public site, 127.0.0.2 the
 * private address a rebinding name turns to (the metadata service, the
 * agent's own ports). Null where 127.0.0.2 cannot be bound (not Linux).
 */
async function twoServers(answer: (req: { url?: string }, port: number) => { status: number; headers?: Record<string, string>; body?: string }): Promise<{ port: number; publicHits: string[]; privateHits: string[]; close: () => void } | null> {
  const publicHits: string[] = [];
  const privateHits: string[] = [];
  const serve = (hits: string[]): Server =>
    createServer((req, res) => {
      hits.push(req.url ?? "");
      const reply = answer(req, (publicServer.address() as AddressInfo).port);
      res.writeHead(reply.status, reply.headers ?? { "content-type": "text/plain" }).end(reply.body ?? "");
    });
  const publicServer = serve(publicHits);
  await new Promise<void>((done) => publicServer.listen(0, "127.0.0.1", () => done()));
  const port = (publicServer.address() as AddressInfo).port;
  const privateServer = serve(privateHits);
  const bound = await new Promise<boolean>((done) => {
    privateServer.once("error", () => done(false));
    privateServer.listen(port, "127.0.0.2", () => done(true));
  });
  if (!bound) {
    publicServer.close();
    return null;
  }
  return {
    port,
    publicHits,
    privateHits,
    close: () => {
      publicServer.close();
      privateServer.close();
    },
  };
}

/** A resolver that answers public the first time it is asked about a name and private every time after: a rebinding name. */
function rebinding(names: Record<string, "rebind" | "private" | "public">): { deps: PublicDeps; asked: string[] } {
  const asked: string[] = [];
  const deps: PublicDeps = {
    resolve: async (host) => {
      const kind = names[host];
      if (!kind) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      const first = !asked.includes(host);
      asked.push(host);
      const address = kind === "public" || (kind === "rebind" && first) ? "127.0.0.1" : "127.0.0.2";
      return [{ address, family: 4 }];
    },
    // In these tests 127.0.0.1 is the public site; 127.0.0.2 stands for every private address.
    isPrivate: (address) => address === "127.0.0.2" || (address !== "127.0.0.1" && privateAddress(address)),
  };
  return { deps, asked };
}

test("the socket's lookup answers only with the checked addresses, and only for the checked name", async () => {
  const checked: Address[] = [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }];
  const lookup = pinnedLookup("Example.COM", checked);
  const ask = (host: string, options: { all?: boolean }) =>
    new Promise<unknown[]>((done) => (lookup as unknown as (h: string, o: object, cb: (...args: unknown[]) => void) => void)(host, options, (...args) => done(args)));
  assert.deepEqual(await ask("example.com", { all: true }), [null, checked]);
  assert.deepEqual(await ask("example.com", {}), [null, "93.184.216.34", 4]);
  const [error] = await ask("metadata.google.internal", {});
  assert.equal((error as { code?: string }).code, "ENOTFOUND");
});

test("a name is resolved once and must be public; the metadata service and private names are refused before any connection", async () => {
  const deps: PublicDeps = { resolve: async () => [{ address: "169.254.169.254", family: 4 }], isPrivate: privateAddress };
  assert.deepEqual(await vetHost("metadata.example", deps), { error: "metadata.example points at a private address, which is never part of the web" });
  const mixed: PublicDeps = { resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }], isPrivate: privateAddress };
  assert.match((await vetHost("two.example", mixed) as { error: string }).error, /private address/);
  assert.match((await vetHost("169.254.169.254") as { error: string }).error, /private address/);
  assert.match((await vetHost("[::1]") as { error: string }).error, /private address/);
  const missing: PublicDeps = { resolve: async () => Promise.reject(Object.assign(new Error("nope"), { code: "ENOTFOUND" })), isPrivate: privateAddress };
  assert.deepEqual(await vetHost("gone.example", missing), { error: "gone.example could not be found (ENOTFOUND)" });
  await assert.rejects(publicFetch("http://metadata.example/latest/user-data", {}, deps), /private address/);
});

test("a name that turns private on its second lookup is never connected to there (F8)", async (t) => {
  const servers = await twoServers(() => ({ status: 200, body: "the public page" }));
  if (!servers) return t.skip("127.0.0.2 cannot be bound here");
  try {
    const { deps, asked } = rebinding({ "rebind.example": "rebind" });
    const response = await publicFetch(`http://rebind.example:${servers.port}/page`, {}, deps);
    assert.equal(await response.text(), "the public page");
    assert.deepEqual(asked, ["rebind.example"], "resolved once: the connection used the checked address");
    assert.deepEqual(servers.publicHits, ["/page"]);
    assert.deepEqual(servers.privateHits, [], "nothing reached the private address");
    // The same name asked again now resolves private, and is refused before any connection.
    await assert.rejects(publicFetch(`http://rebind.example:${servers.port}/again`, {}, deps), /private address/);
    assert.deepEqual(servers.privateHits, []);
  } finally {
    servers.close();
  }
});

test("each redirect hop is checked again: a hop to a private name is refused, a public one followed, at most five", async (t) => {
  const servers = await twoServers((req, port) => {
    if (req.url === "/to-private") return { status: 302, headers: { location: `http://inside.example:${port}/latest/meta-data` } };
    if (req.url === "/to-public") return { status: 301, headers: { location: `http://other.example:${port}/landed` } };
    if (req.url?.startsWith("/loop")) return { status: 302, headers: { location: `/loop${Number(req.url.slice(5) || 0) + 1}` } };
    return { status: 200, body: `at ${req.url}` };
  });
  if (!servers) return t.skip("127.0.0.2 cannot be bound here");
  try {
    const { deps, asked } = rebinding({ "site.example": "public", "inside.example": "private", "other.example": "public" });
    await assert.rejects(publicFetch(`http://site.example:${servers.port}/to-private`, {}, deps), /inside\.example points at a private address/);
    assert.deepEqual(servers.privateHits, [], "the private hop was never connected to");
    const followed = await publicFetch(`http://site.example:${servers.port}/to-public`, {}, deps);
    assert.equal(await followed.text(), "at /landed");
    assert.deepEqual(asked.slice(-2), ["site.example", "other.example"], "each hop's name resolved for that hop");
    // "manual" hands the redirect back for the caller to check (webReader.ts does, with its own rules).
    const manual = await publicFetch(`http://site.example:${servers.port}/to-private`, { redirect: "manual" }, deps);
    assert.equal(manual.status, 302);
    await assert.rejects(publicFetch(`http://site.example:${servers.port}/loop`, {}, deps), new RegExp(`more than ${REDIRECTS} times`));
    assert.equal(servers.publicHits.filter((path) => path.startsWith("/loop")).length, REDIRECTS + 1);
  } finally {
    servers.close();
  }
});
