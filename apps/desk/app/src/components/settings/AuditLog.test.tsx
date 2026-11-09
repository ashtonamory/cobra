// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ audit: [] as Array<{ machine: string; opts: Record<string, unknown> }> }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
vi.mock("../../app/context.ts", () => ({ useApp: () => ({ toast: () => {} }) }));
vi.mock("../../lib/api.ts", () => ({
  ApiError: class extends Error {},
  auditLog: async (machine: string, opts: Record<string, unknown> = {}) => {
    calls.audit.push({ machine, opts });
    if (opts.before === "b".repeat(16)) {
      return { entries: [{ id: "c".repeat(16), at: Date.parse("2026-11-01T09:00:00"), kind: "vault.lock", actor: "cli", outcome: "ok", text: "You, on the command line, locked the vault" }], more: false };
    }
    return {
      entries: [
        { id: "a".repeat(16), at: Date.parse("2026-11-08T10:05:00"), kind: "email.sent", actor: "agent", outcome: "ok", subject: { project: "paws", card: "ap_1" }, text: "Cobra sent an email to 2 addresses at example.com" },
        { id: "b".repeat(16), at: Date.parse("2026-11-08T10:00:00"), kind: "approval.refused", actor: "person", outcome: "refused", subject: { card: "ap_0" }, text: 'You refused "Pay the bill?"' },
      ],
      more: true,
    };
  },
}));

const config = await import("../../lib/config.ts");
const { AuditLogController, AuditLogSection } = await import("./AuditLog.tsx");
const { useController } = await import("./common.tsx");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
  calls.audit.length = 0;
});

function Page() {
  const c = useController((draw) => new AuditLogController(draw));
  if (!c.generation) c.reload();
  return <AuditLogSection c={c} only={null} />;
}

async function draw() {
  config.setMachines([config.testMachine("mini")]);
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<Page />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

describe("Settings → Audit log", () => {
  it("lists the agent's entries newest first in its own words, read only, and reads older pages after the last one", async () => {
    const el = await draw();
    const titles = [...el.querySelectorAll(".btitle")].map((t) => t.textContent);
    expect(titles).toEqual(["Cobra sent an email to 2 addresses at example.com", 'You refused "Pay the bill?"']);
    expect(el.textContent).toContain("paws · ap_1");
    expect([...el.querySelectorAll(".status")].map((s) => s.textContent)).toEqual(["email", "refused"]);
    expect(calls.audit).toEqual([{ machine: "mini", opts: { all: false } }]);
    // Nothing on a row changes the log: no buttons in the board.
    expect(el.querySelectorAll(".board button").length).toBe(0);
    await act(async () => { [...el.querySelectorAll("button")].find((b) => b.textContent === "Show older")!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls.audit.at(-1)).toEqual({ machine: "mini", opts: { before: "b".repeat(16), all: false } });
    expect(el.querySelectorAll(".btitle").length).toBe(3);
    expect(el.textContent).not.toContain("Show older");
  });

  it("Tool decisions reads the log again with the policy's lines", async () => {
    const el = await draw();
    await act(async () => { [...el.querySelectorAll("button")].find((b) => b.textContent === "Tool decisions")!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(calls.audit.at(-1)).toEqual({ machine: "mini", opts: { all: true } });
  });
});
