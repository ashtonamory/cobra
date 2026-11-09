import { describe, expect, it } from "vitest";

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
  }
}

// The desk's own page policy (src-tauri/tauri.conf.json app.security.csp). Phase 2 step 5. Read as text by Vite.
const files = import.meta.glob("../../src-tauri/{tauri.conf.json,capabilities/default.json}", { query: "?raw", import: "default", eager: true });
const read = (name: string) => JSON.parse(files[`../../src-tauri/${name}`]);
const conf = read("tauri.conf.json");
const csp: string = conf.app.security.csp;
const policy = new Map<string, string[]>(csp.split(";").map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([name, ...values]) => [name, values]));

describe("the desk's Content Security Policy", () => {
  it("has no eval and no inline or remote script", () => {
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("wasm-unsafe-eval");
    const scripts = policy.get("script-src") ?? policy.get("default-src")!;
    expect(scripts).toEqual(["'self'"]);
    expect(policy.get("default-src")).toEqual(["'self'"]);
  });

  it("no directive names a remote origin", () => {
    const local = /^('self'|'none'|'unsafe-inline'|data:|asset:|ipc:|http:\/\/(asset|ipc)\.localhost)$/;
    for (const [name, values] of policy) for (const v of values) expect(v, `${name} ${v}`).toMatch(local);
  });

  it("talks only to the Rust side, frames nothing and has nowhere to post", () => {
    expect(policy.get("connect-src")).toEqual(["ipc:", "http://ipc.localhost"]);
    expect(policy.get("frame-src")).toEqual(["'none'"]);
    expect(policy.get("child-src")).toEqual(["'none'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(policy.get("form-action")).toEqual(["'none'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("Tauri keeps it as written", () => {
    expect(conf.app.security.dangerousDisableAssetCspModification).toBeUndefined();
    expect(conf.app.security.devCsp).toBeUndefined();
    expect(conf.app.withGlobalTauri).toBeFalsy();
  });

  it("only Cobra's own windows get the IPC, never a terminal or a remote page", () => {
    const caps = read("capabilities/default.json");
    expect(caps.windows).toEqual(["main", "picker", "popup", "box"]);
    expect(caps.remote).toBeUndefined();
    expect(caps.webviews).toBeUndefined();
  });
});
