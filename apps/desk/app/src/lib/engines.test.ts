import { describe, expect, it } from "vitest";
import * as engines from "./engines.ts";

describe("EnginesWords", () => {
  it("roles in the chain's order", () => {
    expect(engines.ROLES.map(([role]) => role)).toEqual(["lead", "foreman", "session", "worker"]);
  });

  it("unknown engine reads as claude", () => {
    expect(engines.engineKey("codex")).toBe("codex");
    expect(engines.engineKey("gemini")).toBe("claude");
    expect(engines.engineKey(null)).toBe("claude");
  });

  it("codex needs a sign-in, and the sandbox for workers", () => {
    expect(engines.codexBlocked({ codex: false, contained: true }, "lead")).toContain("Sign in to Codex");
    expect(engines.codexBlocked({ codex: true, contained: false }, "foreman")).toBeNull();
    expect(engines.codexBlocked({ codex: true, contained: false }, "worker")).toContain("sandbox");
    expect(engines.codexBlocked({ codex: true, contained: true }, "worker")).toBeNull();
  });

  it("words match the phone", () => {
    expect(engines.codexLine({ codex: false })).toContain("not signed in");
    expect(engines.codexLine({ codex: true, contained: false })).toContain("Workers stay on Claude");
    expect(engines.changedWords("Foremen", "codex", "legion")).toBe(
      "Foremen on legion start on Codex from their next conversation");
  });
});

describe("sourceRows", () => {
  it("lists Claude, Codex and Ollama in that order, with what to do for one that is not ready", () => {
    const rows = engines.sourceRows({
      sources: {
        claude: { ready: true, detail: "Signed in." },
        codex: { ready: false, detail: "Not signed in.", fix: "Run codex login." },
        ollama: { ready: false, detail: "Ollama is not answering.", fix: "Install Ollama.", models: [] },
      },
    });
    expect(rows.map((row) => [row.name, row.ready, row.fix])).toEqual([
      ["Claude", true, null],
      ["Codex", false, "Run codex login."],
      ["Local models (Ollama)", false, "Install Ollama."],
    ]);
  });

  it("an older agent with no sources gives no rows", () => {
    expect(engines.sourceRows({})).toEqual([]);
    expect(engines.sourceRows({ sources: [] })).toEqual([]);
  });
});
