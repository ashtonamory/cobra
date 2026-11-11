import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SpaceError, baselineFolders, isSpaceFolder, listSpaces, openSpace, readProfile, readProfileText, readSpace, seatDir, spaceDir, writeProfile } from "./spaces.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "spaces-"));
const input = { id: "maya-s-soccer", name: "Maya's Soccer", kind: "team" as const, home: "omarchy", sensitive: true };
const at = (iso: string) => () => new Date(iso);

test("a Space's folder and a seat's folder stay inside the root", () => {
  const root = "/spaces";
  assert.equal(spaceDir("happy-tails", root), "/spaces/happy-tails");
  assert.equal(seatDir("happy-tails", "crm", root), "/spaces/happy-tails/crm");
  for (const bad of ["..", "a/b", "A", "", "-x", "a".repeat(41)]) assert.throws(() => spaceDir(bad, root), SpaceError, bad);
  for (const bad of ["..", "a/b", "CRM", "", "x".repeat(33)]) assert.throws(() => seatDir("happy-tails", bad, root), SpaceError, bad);
});

test("the baseline folders follow the kind, in the order the intake starts them", () => {
  assert.deepEqual(baselineFolders("maya-s-soccer", "team", "/s").map((f) => [f.name, f.path]), [
    ["Announcements", "/s/maya-s-soccer/announcements"],
    ["Roster", "/s/maya-s-soccer/roster"],
    ["Dues", "/s/maya-s-soccer/dues"],
  ]);
  assert.deepEqual(baselineFolders("happy-tails", "client", "/s").map((f) => f.role), ["outreach", "people", "money"]);
});

test("opening a Space makes its folder and space.json, and says what it is", () => {
  const root = fresh();
  try {
    const record = openSpace(input, "omarchy", root, at("2026-10-27T10:00:00.000Z"));
    assert.deepEqual(record, { version: 1, id: "maya-s-soccer", name: "Maya's Soccer", kind: "team", home: "omarchy", sensitive: true, opened: "2026-10-27T10:00:00.000Z" });
    assert.equal(statSync(join(root, "maya-s-soccer", "space.json")).mode & 0o777, 0o600, "space.json is private");
    assert.deepEqual(readSpace("maya-s-soccer", root), record);
    assert.equal(isSpaceFolder(join(root, "maya-s-soccer")), true);
    assert.equal(isSpaceFolder(root), false);
    assert.equal(readSpace("nobody", root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opening again keeps the first opened time and takes the new name and Sensitive switch", () => {
  const root = fresh();
  try {
    openSpace(input, "omarchy", root, at("2026-10-27T10:00:00.000Z"));
    const again = openSpace({ ...input, name: "Maya's Soccer Club", sensitive: false }, "omarchy", root, at("2026-11-01T09:00:00.000Z"));
    assert.equal(again.opened, "2026-10-27T10:00:00.000Z");
    assert.equal(again.name, "Maya's Soccer Club");
    assert.equal(again.sensitive, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Space is opened only on its home computer and never moved", () => {
  const root = fresh();
  try {
    assert.throws(() => openSpace(input, "office", root), (e: unknown) => e instanceof SpaceError && e.status === 409 && /runs on omarchy, not on office/.test(e.message));
    assert.equal(existsSync(join(root, "maya-s-soccer")), false, "nothing was made on the wrong computer");
    openSpace(input, "omarchy", root);
    assert.throws(() => openSpace({ ...input, home: "office" }, "office", root), (e: unknown) => e instanceof SpaceError && e.status === 409 && /pinned to omarchy/.test(e.message));
    assert.throws(() => openSpace({ ...input, kind: "nope" as never }, "omarchy", root), (e: unknown) => e instanceof SpaceError && e.status === 400);
    assert.throws(() => openSpace({ ...input, name: "   " }, "omarchy", root), (e: unknown) => e instanceof SpaceError && e.status === 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listSpaces lists the opened ones by id and skips folders that are not Spaces", () => {
  const root = fresh();
  try {
    assert.deepEqual(listSpaces(join(root, "missing")), []);
    openSpace({ ...input, id: "zeta", name: "Zeta", kind: "own" }, "omarchy", root);
    openSpace(input, "omarchy", root);
    openSpace({ ...input, id: "alpha", name: "Alpha", kind: "client", sensitive: false }, "omarchy", root);
    assert.deepEqual(listSpaces(root).map((s) => s.id), ["alpha", "maya-s-soccer", "zeta"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a profile is kept as json for the agent and markdown for a Foreman", () => {
  const root = fresh();
  try {
    openSpace(input, "omarchy", root);
    assert.equal(readProfile("maya-s-soccer", root), null);
    assert.equal(readProfileText("maya-s-soccer", root), null);
    const { profile, text } = writeProfile("maya-s-soccer", { purpose: "Schedule and messages", people: "12 families", tools: "Google", ignored: 1 }, root, at("2026-10-27T11:00:00.000Z"));
    assert.deepEqual(profile, { version: 1, purpose: "Schedule and messages", people: "12 families", tools: "Google", updated: "2026-10-27T11:00:00.000Z" });
    assert.deepEqual(readProfile("maya-s-soccer", root), profile);
    assert.equal(readProfileText("maya-s-soccer", root), text);
    assert.match(readFileSync(join(root, "maya-s-soccer", "profile.md"), "utf8"), /^# Maya's Soccer\n[\s\S]*## What it is for\n\nSchedule and messages/);
    assert.equal(statSync(join(root, "maya-s-soccer", "profile.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a profile needs an open Space and an answer to what it is for and who it serves", () => {
  const root = fresh();
  try {
    assert.throws(() => writeProfile("maya-s-soccer", { purpose: "x", people: "y" }, root), (e: unknown) => e instanceof SpaceError && e.status === 404);
    openSpace(input, "omarchy", root);
    assert.throws(() => writeProfile("maya-s-soccer", { purpose: "x" }, root), (e: unknown) => e instanceof SpaceError && e.status === 400);
    assert.throws(() => writeProfile("maya-s-soccer", null, root), (e: unknown) => e instanceof SpaceError && e.status === 400);
    assert.equal(readProfile("maya-s-soccer", root), null, "a refused profile leaves nothing behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
