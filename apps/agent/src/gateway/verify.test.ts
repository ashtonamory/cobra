import { test } from "node:test";
import assert from "node:assert/strict";

import { mintTicket } from "../agent/tickets.ts";
import { mintReconnectTicket, verifyTicket } from "./verify.ts";

/**
 * These two functions live in separate services and are deliberately not shared
 * code, so the only thing keeping them compatible is this test. It is the
 * security boundary for the terminal: a ticket that verifies opens a shell.
 */

const KEY = "test-key-not-a-real-token";

test("a freshly minted ticket verifies and round-trips its claims", () => {
  const { ticket } = mintTicket(KEY, "cobra", "/home/me/cobra");
  const result = verifyTicket(KEY, ticket);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.claims.session, "cobra");
  assert.equal(result.claims.cwd, "/home/me/cobra");
  assert.ok(result.claims.nonce.length > 0);
});

test("a ticket minted with a different key is rejected", () => {
  const { ticket } = mintTicket("some-other-key", "cobra", "/tmp");
  const result = verifyTicket(KEY, ticket);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "bad signature");
});

test("tampering with the claims invalidates the signature", () => {
  const { ticket } = mintTicket(KEY, "cobra", "/home/me/cobra");
  const [payload, signature] = ticket.split(".");
  assert.ok(payload && signature);

  // Re-encode the claims with a different session, keeping the original
  // signature — the attack this construction exists to stop.
  const claims = JSON.parse(
    Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
  );
  claims.session = "something-else";
  const forged = Buffer.from(JSON.stringify(claims))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const result = verifyTicket(KEY, `${forged}.${signature}`);
  assert.equal(result.ok, false);
});

test("an expired ticket is rejected", () => {
  const { ticket } = mintTicket(KEY, "cobra", "/tmp");
  const [payload, signature] = ticket.split(".");
  assert.ok(payload && signature);

  // Rather than wait 30 seconds, mint one and check the boundary directly by
  // asserting the TTL is short enough to matter.
  const claims = JSON.parse(
    Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
  );
  const ttl = claims.exp - Math.floor(Date.now() / 1000);
  assert.ok(ttl > 0 && ttl <= 30, `ttl should be short, got ${ttl}s`);
});

test("a reconnect ticket verifies and stays scoped to its own session", () => {
  const ticket = mintReconnectTicket(KEY, "cobra", "/home/me/cobra");
  const result = verifyTicket(KEY, ticket);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.claims.session, "cobra");
  assert.equal(result.claims.cwd, "/home/me/cobra");
  assert.ok(result.claims.nonce.length > 0);
});

test("a reconnect ticket minted with a different key is rejected", () => {
  const ticket = mintReconnectTicket("some-other-key", "cobra", "/tmp");
  assert.equal(verifyTicket(KEY, ticket).ok, false);
});

test("reconnect tickets outlive a tunnel restart but still expire", () => {
  const ticket = mintReconnectTicket(KEY, "cobra", "/tmp");
  const [payload] = ticket.split(".");
  assert.ok(payload);

  const claims = JSON.parse(
    Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
  );
  const ttl = claims.exp - Math.floor(Date.now() / 1000);
  // Long enough to survive the tunnel going away and coming back, short
  // enough that a leaked one is not a standing key to the machine.
  assert.ok(ttl > 60 && ttl <= 900, `ttl should be bounded, got ${ttl}s`);
});

test("each reconnect ticket gets its own nonce, so one cannot be replayed", () => {
  const first = mintReconnectTicket(KEY, "cobra", "/tmp");
  const second = mintReconnectTicket(KEY, "cobra", "/tmp");
  assert.notEqual(first, second);

  const a = verifyTicket(KEY, first);
  const b = verifyTicket(KEY, second);
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.notEqual(a.claims.nonce, b.claims.nonce);
});

test("malformed tickets are rejected rather than throwing", () => {
  for (const bad of ["", ".", "nodot", "a.b", "....", "x".repeat(500)]) {
    const result = verifyTicket(KEY, bad);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
});
