import { test } from "node:test";
import assert from "node:assert/strict";

import { authorize, bearer, scopeFor, tokenMatches } from "./auth.ts";
import { DESK_SCOPES, findCaller, hashKey, mintDesk, mintLead, parseCallers, type Caller } from "./keys.ts";

const DESK_KEY = "desk-key-made-for-this-computer-0123456789a";

/** A desk key with no expiry yet (one made before keys expired), so `now` does not matter here. */
const desk: Caller = {
  id: "desk_1234567890abcdef",
  name: "Sam's desk",
  kind: "desk",
  keyHash: hashKey(DESK_KEY),
  scopes: [...DESK_SCOPES],
  linkedAt: 1,
};

function keys(callers: Caller[]) {
  return { authenticate: (presented: string) => findCaller(callers, presented) };
}

test("an agent nobody has linked admits nobody", () => {
  // The lesson of the old token gate: having nothing to check against is a
  // reason to refuse, never a reason to stop checking.
  for (const header of [`Bearer ${DESK_KEY}`, undefined, "Bearer ", ""]) {
    assert.deepEqual(authorize(header, "/system", "GET", keys([])), { ok: false, status: 401 });
  }
});

test("the desk's key reads and acts", () => {
  const store = keys([desk]);
  for (const [route, method] of [["/system", "GET"], ["/session", "POST"]] as const) {
    const result = authorize(`Bearer ${DESK_KEY}`, route, method, store);
    assert.equal(result.ok, true, route);
    assert.equal(result.ok && result.caller.id, desk.id);
  }
});

test("a prefix, a longer key, or a key of the same length is not enough", () => {
  const store = keys([desk]);
  for (const wrong of [DESK_KEY.slice(0, -1), `${DESK_KEY}x`, "x".repeat(DESK_KEY.length)]) {
    assert.deepEqual(authorize(`Bearer ${wrong}`, "/system", "GET", store), { ok: false, status: 401 });
  }
});

test("the scheme is exact: case-sensitive, one space, Bearer only", () => {
  const store = keys([desk]);
  for (const header of [`bearer ${DESK_KEY}`, `Bearer  ${DESK_KEY}`, `Basic ${DESK_KEY}`, DESK_KEY]) {
    assert.deepEqual(authorize(header, "/system", "GET", store), { ok: false, status: 401 }, header);
  }
});

test("the stored file holds a hash that cannot be presented as a key", () => {
  assert.deepEqual(authorize(`Bearer ${desk.keyHash}`, "/system", "GET", keys([desk])), { ok: false, status: 401 });
});

test("scopes by route and method", () => {
  assert.equal(scopeFor("/projects", "GET"), "read");
  assert.equal(scopeFor("/projects", "HEAD"), "read");
  assert.equal(scopeFor("/git", "POST"), "act");
  assert.equal(scopeFor("/link", "DELETE"), "act");
});

test("bearer extracts only what follows the scheme", () => {
  assert.equal(bearer("Bearer abc"), "abc");
  assert.equal(bearer("Bearer "), "");
  assert.equal(bearer(undefined), "");
  assert.equal(bearer("Basic abc"), "");
});

test("tokenMatches survives a length mismatch without throwing", () => {
  assert.equal(tokenMatches("short", "longer-secret"), false);
  assert.equal(tokenMatches("same", "same"), true);
});

test("a Lead key reaches /orch/* and nothing else; the desk reaches /orch/* with read and act", () => {
  // Minted now: a Lead key expires 30 days after it is made (keys.ts ORCH_KEY_LIFETIME_MS).
  const { caller: lead, key } = mintLead("laptop", Date.now(), (size) => new Uint8Array(size).fill(7));
  assert.equal(lead.kind, "lead");
  assert.deepEqual(lead.scopes, ["orch"]);
  // It survives the round trip through keys.json.
  assert.deepEqual(parseCallers(JSON.stringify([lead])), [lead]);
  const store = keys([desk, lead]);
  for (const [route, method] of [["/orch/status", "GET"], ["/orch/worker/spawn", "POST"], ["/orch/worker/finish", "POST"]] as const) {
    assert.equal(authorize(`Bearer ${key}`, route, method, store).ok, true, route);
    assert.equal(authorize(`Bearer ${DESK_KEY}`, route, method, store).ok, true, route);
  }
  for (const [route, method] of [["/projects", "GET"], ["/fs/get", "GET"], ["/session", "POST"], ["/approvals/answer", "POST"], ["/keys", "GET"], ["/git", "POST"]] as const) {
    assert.deepEqual(authorize(`Bearer ${key}`, route, method, store), { ok: false, status: 403 }, route);
  }
});

test("/prs is read like /git/repo: the desk's key, never a Lead's", () => {
  const { caller: lead, key } = mintLead("laptop", Date.now(), (size) => new Uint8Array(size).fill(5));
  const store = keys([desk, lead]);
  for (const route of ["/prs", "/git/repo"]) {
    assert.equal(authorize(`Bearer ${DESK_KEY}`, route, "GET", store).ok, true, route);
    assert.deepEqual(authorize(`Bearer ${key}`, route, "GET", store), { ok: false, status: 403 }, route);
    assert.deepEqual(authorize(undefined, route, "GET", store), { ok: false, status: 401 }, route);
  }
});

test("a key of a kind that is gone admits nobody, on any route", () => {
  // As an old keys.json held them: parseCallers is what the store reads with.
  const old = [
    { id: "iphone_1234567890abcdef", name: "iPhone", kind: "phone", keyHash: hashKey("phone-key"), scopes: ["read", "act", "terminal"], linkedAt: 1 },
    { id: "omarchy_HUB1234567890ab", name: "Hub", kind: "peer", keyHash: hashKey("peer-key"), scopes: ["receive"], linkedAt: 1 },
    { id: "widget_iphone_1234567890abcdef", name: "Widgets", kind: "widget", keyHash: hashKey("widget-key"), scopes: ["glance"], linkedAt: 1 },
    { id: "api_1234567890abcdefgh", name: "API", kind: "api", keyHash: hashKey("api-key"), scopes: ["read", "act"], linkedAt: 1 },
  ];
  const store = keys(parseCallers(JSON.stringify(old)));
  for (const key of ["phone-key", "peer-key", "widget-key", "api-key"]) {
    for (const [route, method] of [["/system", "GET"], ["/session", "POST"], ["/orch/status", "GET"]] as const) {
      assert.deepEqual(authorize(`Bearer ${key}`, route, method, store), { ok: false, status: 401 }, `${key} ${route}`);
    }
  }
});

test("a key made for another computer no longer loads: it stops working, and never becomes a local key", () => {
  const { caller } = mintLead("laptop", 1, (size) => new Uint8Array(size).fill(9));
  assert.deepEqual(parseCallers(JSON.stringify([caller])), [caller]);
  // As keys.json kept a Lead or a desk on another computer, from before Cobra ran on one only.
  assert.deepEqual(parseCallers(JSON.stringify([{ ...caller, id: "lead_from_laptop", remote: true }])), []);
  assert.deepEqual(parseCallers(JSON.stringify([{ ...mintDesk("Desk", 1).caller, remote: true }, caller])), [caller]);
});

test("an expired key is told to link again, not just refused", () => {
  const now = 1_800_000_000_000;
  const expired = authorize(`Bearer ${DESK_KEY}`, "/system", "GET", keys([{ ...desk, expiresAt: now }]), now);
  assert.equal(expired.ok, false);
  assert.equal(!expired.ok && expired.status, 401);
  assert.equal(!expired.ok && expired.expired, true);
  assert.match((!expired.ok && expired.error) || "", /expired on 2027-01-15\. Link it again: Settings → This computer → Link the agent/);
  assert.equal(authorize(`Bearer ${DESK_KEY}`, "/system", "GET", keys([{ ...desk, expiresAt: now + 1 }]), now).ok, true);
});

test("a desk key acts, and a scope Cobra no longer has is dropped when keys.json is read", () => {
  const { caller: minted, key } = mintDesk("Desk", 0);
  const store = keys([minted]);
  for (const [route, method] of [["/projects", "GET"], ["/session", "POST"], ["/git", "POST"], ["/approvals/answer", "POST"], ["/keys/rotate", "POST"]] as const) {
    assert.equal(authorize(`Bearer ${key}`, route, method, store, 1).ok, true, route);
  }
  // A key from when Cobra served a terminal still loads, without that scope.
  const [old] = parseCallers(JSON.stringify([{ ...minted, scopes: ["read", "act", "terminal"] }]));
  assert.deepEqual(old!.scopes, ["read", "act"]);
  assert.equal(authorize(`Bearer ${key}`, "/projects", "GET", keys([old!]), 1).ok, true);
});

test("an expired Lead or Foreman key is told to start it again", () => {
  const { caller: lead, key } = mintLead("laptop", 0, (size) => new Uint8Array(size).fill(3));
  const refused = authorize(`Bearer ${key}`, "/orch/status", "GET", keys([lead]), lead.expiresAt!);
  assert.equal(!refused.ok && refused.status, 401);
  assert.match((!refused.ok && refused.error) || "", /Lead's key .* expired.*start/);
  const foreman = { ...lead, project: "site", name: "Foreman for site" };
  const gone = authorize(`Bearer ${key}`, "/orch/status", "GET", keys([foreman]), lead.expiresAt!);
  assert.match((!gone.ok && gone.error) || "", /Foreman's key .* expired.*start/);
});
