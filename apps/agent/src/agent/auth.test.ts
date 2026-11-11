import { test } from "node:test";
import assert from "node:assert/strict";

import { authorize, bearer, scopeFor, tokenMatches } from "./auth.ts";
import { findCaller, hashKey, mintDesk, mintLead, parseCallers, PEER_SCOPES, PHONE_SCOPES, type Caller } from "./keys.ts";

const PHONE_KEY = "phone-key-made-for-this-computer-0123456789";
const PEER_KEY = "peer-key-for-the-hub-0123456789abcdefghijk";

const phone: Caller = {
  id: "iphone_1234567890abcdef",
  name: "Sam's iPhone",
  kind: "phone",
  keyHash: hashKey(PHONE_KEY),
  scopes: [...PHONE_SCOPES],
  linkedAt: 1,
};
const peer: Caller = {
  id: "omarchy_HUB1234567890ab",
  name: "Mac Mini",
  kind: "peer",
  keyHash: hashKey(PEER_KEY),
  scopes: [...PEER_SCOPES],
  linkedAt: 1,
};

function keys(callers: Caller[]) {
  return { authenticate: (presented: string) => findCaller(callers, presented) };
}

test("an agent nobody has linked admits nobody", () => {
  // The lesson of the old token gate: having nothing to check against is a
  // reason to refuse, never a reason to stop checking.
  for (const header of [`Bearer ${PHONE_KEY}`, undefined, "Bearer ", ""]) {
    assert.deepEqual(authorize(header, "/system", "GET", keys([])), { ok: false, status: 401 });
  }
});

test("a phone's key reads, acts and opens terminals", () => {
  const store = keys([phone, peer]);
  for (const [route, method] of [["/system", "GET"], ["/session", "POST"], ["/ticket", "POST"]] as const) {
    const result = authorize(`Bearer ${PHONE_KEY}`, route, method, store);
    assert.equal(result.ok, true, route);
    assert.equal(result.ok && result.caller.id, phone.id);
  }
});

test("a phone may not pose as a peer dropping files", () => {
  assert.deepEqual(authorize(`Bearer ${PHONE_KEY}`, "/files/receive", "POST", keys([phone])), { ok: false, status: 403 });
});

test("a peer's key only drops files", () => {
  const store = keys([phone, peer]);
  assert.equal(authorize(`Bearer ${PEER_KEY}`, "/files/receive", "POST", store).ok, true);
  for (const [route, method] of [["/system", "GET"], ["/session", "POST"], ["/ticket", "POST"], ["/power", "POST"]] as const) {
    assert.deepEqual(authorize(`Bearer ${PEER_KEY}`, route, method, store), { ok: false, status: 403 }, route);
  }
});

test("a prefix, a longer key, or a key of the same length is not enough", () => {
  const store = keys([phone]);
  for (const wrong of [PHONE_KEY.slice(0, -1), `${PHONE_KEY}x`, "x".repeat(PHONE_KEY.length)]) {
    assert.deepEqual(authorize(`Bearer ${wrong}`, "/system", "GET", store), { ok: false, status: 401 });
  }
});

test("the scheme is exact: case-sensitive, one space, Bearer only", () => {
  const store = keys([phone]);
  for (const header of [`bearer ${PHONE_KEY}`, `Bearer  ${PHONE_KEY}`, `Basic ${PHONE_KEY}`, PHONE_KEY]) {
    assert.deepEqual(authorize(header, "/system", "GET", store), { ok: false, status: 401 }, header);
  }
});

test("the stored file holds a hash that cannot be presented as a key", () => {
  assert.deepEqual(authorize(`Bearer ${phone.keyHash}`, "/system", "GET", keys([phone])), { ok: false, status: 401 });
});

test("scopes by route and method", () => {
  assert.equal(scopeFor("/ticket", "POST"), "terminal");
  assert.equal(scopeFor("/files/receive", "POST"), "receive");
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

const WIDGET_KEY = "widget-key-kept-in-the-app-group-0123456789";
// A widget key as a Cobra phone registered it: Cobra mints none, but an old keys.json may hold one.
const widget: Caller = { id: `widget_${phone.id}`, name: `${phone.name} widgets`, kind: "widget", keyHash: hashKey(WIDGET_KEY), scopes: ["glance"], linkedAt: 2 };

test("a widget's key glances and does nothing else", () => {
  const store = keys([phone, widget]);
  const ok = authorize(`Bearer ${WIDGET_KEY}`, "/glance", "GET", store);
  assert.equal(ok.ok && ok.caller.kind, "widget");
  for (const [route, method] of [
    ["/projects", "GET"],
    ["/system", "GET"],
    ["/transcript", "GET"],
    ["/glance", "POST"],
    ["/session", "POST"],
    ["/ticket", "POST"],
    ["/link", "DELETE"],
    ["/widget-key", "POST"],
    ["/files/receive", "POST"],
  ] as const) {
    assert.deepEqual(authorize(`Bearer ${WIDGET_KEY}`, route, method, store), { ok: false, status: 403 }, `${method} ${route}`);
  }
});

test("a phone's own key glances too", () => {
  assert.equal(authorize(`Bearer ${PHONE_KEY}`, "/glance", "GET", keys([phone])).ok, true);
  assert.deepEqual(authorize(`Bearer ${PEER_KEY}`, "/glance", "GET", keys([peer])), { ok: false, status: 403 });
});

test("a Lead key reaches /orch/* and nothing else; a phone reaches /orch/* with read and act", () => {
  // Minted now: a Lead key expires 30 days after it is made (keys.ts ORCH_KEY_LIFETIME_MS).
  const { caller: lead, key } = mintLead("legion", Date.now(), (size) => new Uint8Array(size).fill(7));
  assert.equal(lead.kind, "lead");
  assert.deepEqual(lead.scopes, ["orch"]);
  // It survives the round trip through keys.json.
  assert.deepEqual(parseCallers(JSON.stringify([lead])), [lead]);
  const store = keys([phone, lead]);
  for (const [route, method] of [["/orch/status", "GET"], ["/orch/worker/spawn", "POST"], ["/orch/worker/finish", "POST"]] as const) {
    assert.equal(authorize(`Bearer ${key}`, route, method, store).ok, true, route);
    assert.equal(authorize(`Bearer ${PHONE_KEY}`, route, method, store).ok, true, route);
  }
  for (const [route, method] of [["/projects", "GET"], ["/ticket", "POST"], ["/fs/list", "GET"], ["/session", "POST"], ["/chats/send", "POST"], ["/git", "POST"]] as const) {
    assert.deepEqual(authorize(`Bearer ${key}`, route, method, store), { ok: false, status: 403 }, route);
  }
  // A peer has neither orch nor read.
  assert.deepEqual(authorize(`Bearer ${PEER_KEY}`, "/orch/status", "GET", keys([peer])), { ok: false, status: 403 });
});

test("/prs is read like /git/repo: a phone's or desk's key, never a Lead's, a widget's or a peer's", () => {
  const { caller: lead, key } = mintLead("legion", Date.now(), (size) => new Uint8Array(size).fill(5));
  const store = keys([phone, peer, widget, lead]);
  for (const route of ["/prs", "/git/repo"]) {
    assert.equal(authorize(`Bearer ${PHONE_KEY}`, route, "GET", store).ok, true, route);
    for (const other of [key, WIDGET_KEY, PEER_KEY]) {
      assert.deepEqual(authorize(`Bearer ${other}`, route, "GET", store), { ok: false, status: 403 }, route);
    }
    assert.deepEqual(authorize(undefined, route, "GET", store), { ok: false, status: 401 }, route);
  }
});

test("a key made for another computer no longer loads: it stops working, and never becomes a local key", () => {
  const { caller } = mintLead("legion", 1, (size) => new Uint8Array(size).fill(9));
  assert.deepEqual(parseCallers(JSON.stringify([caller])), [caller]);
  // As keys.json kept a Lead or a desk on another computer, from before Cobra ran on one only.
  assert.deepEqual(parseCallers(JSON.stringify([{ ...caller, id: "lead_from_legion", remote: true }])), []);
  assert.deepEqual(parseCallers(JSON.stringify([{ ...mintDesk("Desk", 1).caller, remote: true }, caller])), [caller]);
});

test("an expired key is told to link again, not just refused", () => {
  const now = 1_800_000_000_000;
  const expired = authorize(`Bearer ${PHONE_KEY}`, "/system", "GET", keys([{ ...phone, expiresAt: now }]), now);
  assert.equal(expired.ok, false);
  assert.equal(!expired.ok && expired.status, 401);
  assert.equal(!expired.ok && expired.expired, true);
  assert.match((!expired.ok && expired.error) || "", /expired on 2027-01-15\. Link the desk app again: Settings → This computer → Link the agent/);
  assert.equal(authorize(`Bearer ${PHONE_KEY}`, "/system", "GET", keys([{ ...phone, expiresAt: now + 1 }]), now).ok, true);
  const { caller: desk, key } = mintDesk("Desk", 0);
  const deskExpired = authorize(`Bearer ${key}`, "/system", "GET", keys([desk]), desk.expiresAt!);
  assert.match((!deskExpired.ok && deskExpired.error) || "", /Settings → This computer → Link the agent/);
});

test("a desktop key acts, but opens no terminal and writes no file into a folder", () => {
  const { caller: desk, key } = mintDesk("Desk", 0);
  const store = keys([desk]);
  for (const [route, method] of [["/projects", "GET"], ["/session", "POST"], ["/git", "POST"], ["/approvals/answer", "POST"], ["/keys/rotate", "POST"]] as const) {
    assert.equal(authorize(`Bearer ${key}`, route, method, store, 1).ok, true, route);
  }
  for (const [route, method] of [["/ticket", "POST"], ["/fs/put", "POST"]] as const) {
    assert.deepEqual(authorize(`Bearer ${key}`, route, method, store, 1), { ok: false, status: 403 }, route);
  }
  // A phone still writes files.
  assert.equal(authorize(`Bearer ${PHONE_KEY}`, "/fs/put", "POST", keys([phone])).ok, true);
});

test("an expired Lead or Foreman key is told to start it again (OV-SEC-VPS-001 F23b)", () => {
  const { caller: lead, key } = mintLead("legion", 0, (size) => new Uint8Array(size).fill(3));
  const refused = authorize(`Bearer ${key}`, "/orch/status", "GET", keys([lead]), lead.expiresAt!);
  assert.equal(!refused.ok && refused.status, 401);
  assert.match((!refused.ok && refused.error) || "", /Lead's key .* expired.*start/);
  const foreman = { ...lead, project: "site", name: "Foreman for site" };
  const gone = authorize(`Bearer ${key}`, "/orch/status", "GET", keys([foreman]), lead.expiresAt!);
  assert.match((!gone.ok && gone.error) || "", /Foreman's key .* expired.*start/);
});
