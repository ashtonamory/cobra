import { describe, expect, it } from "vitest";
import * as accounts from "./accounts.ts";

const VIEW = {
  accounts: [
    { id: "claude-1", provider: "claude", label: "Work", active: true, addedAt: "x" },
    { id: "claude-2", provider: "claude", label: "a@example.com", email: "a@example.com", active: false, addedAt: "x" },
    { id: "codex-1", provider: "codex", label: "b@example.org", email: "b@example.org", active: false, addedAt: "x" },
  ],
  computer: { claude: { email: "a@example.com", active: false }, codex: { email: "c@example.net", saved: false } },
};

describe("Rows", () => {
  it("claude lists the computer's own sign-in then each account", () => {
    const rows = accounts.rows(VIEW, "claude");
    expect(rows.map((r) => [r.id, r.title, r.active, r.canUse, r.canRemove])).toEqual([
      [null, "This computer's sign-in", false, true, false],
      ["claude-1", "Work", true, false, true],
      ["claude-2", "a@example.com", false, true, true],
    ]);
    expect(rows[1].detail).toBe("another account");
  });

  it("codex shows an unsaved sign-in as the one in use and offers to keep it", () => {
    const rows = accounts.rows(VIEW, "codex");
    expect(rows.map((r) => [r.id, r.title, r.detail, r.active])).toEqual([
      [null, "This computer's sign-in", "c@example.net", true],
      ["codex-1", "b@example.org", "", false],
    ]);
    expect(accounts.canSaveCodex(VIEW)).toBe(true);
  });

  it("a saved codex sign-in is listed as itself", () => {
    const view = {
      ...VIEW,
      computer: { ...VIEW.computer, codex: { email: "b@example.org", saved: true } },
      accounts: [{ ...VIEW.accounts[2], active: true }],
    };
    const rows = accounts.rows(view, "codex");
    expect(rows.map((r) => [r.id, r.active])).toEqual([["codex-1", true]]);
    expect(accounts.canSaveCodex(view)).toBe(false);
  });
});
