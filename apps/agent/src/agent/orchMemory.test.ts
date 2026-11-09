import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts and memory.ts read these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-orch-memory-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");
process.env.COBRA_MEMORY_DIR = join(ROOT, "memory");

const { handleOrch } = await import("./orch.ts");
const memory = await import("./memory.ts");

memory.writeMemoryFile(join(ROOT, "memory"), "computers/legion/daily/2026-10-11.md", "# legion · daily\nShipped.");
const registry = join(ROOT, "projects.json");
writeFileSync(registry, JSON.stringify({ projects: [] }));

/** One request through handleOrch, the way index.ts routes it. */
async function call(route: string, query: string, method: "GET" | "POST", caller: { kind: string; project?: string }, body = "") {
  let reply: { status: number; body: unknown } | null = null;
  const request = { method, on: () => undefined } as unknown as http.IncomingMessage;
  await handleOrch(route, new URL(`http://agent${route}${query}`), request, {} as http.ServerResponse, {
    send: (_response, status, sent) => void (reply = { status, body: sent }),
    // A GET has no body: reading one fails, as a real empty body fails JSON.parse.
    readBody: async () => body,
    configPath: registry,
    log: () => undefined,
    caller: { id: "k1", name: "test", ...caller },
    notify: async () => undefined,
    machineLabel: "legion",
    port: 8797,
  });
  return reply!;
}

test("memory_read is a GET with no body: the Lead reads a file and a folder (the route ran after the body parse once)", async () => {
  const file = await call("/orch/memory/file", "?path=computers/legion/daily/2026-10-11.md", "GET", { kind: "lead" });
  assert.equal(file.status, 200);
  assert.deepEqual(file.body, { kind: "file", path: "computers/legion/daily/2026-10-11.md", text: "# legion · daily\nShipped.\n" });
  const folder = await call("/orch/memory/file", "?path=computers/legion", "GET", { kind: "lead" });
  assert.deepEqual(folder.body, { kind: "folder", path: "computers/legion", entries: ["daily/"] });
});

test("memory_read refuses a path out of memory, and a POST", async () => {
  assert.equal((await call("/orch/memory/file", "?path=../config", "GET", { kind: "lead" })).status, 400);
  assert.equal((await call("/orch/memory/file", "", "POST", { kind: "lead" }, "{}")).status, 405);
});

test("memory_remember: a phone's key may not hand lessons in, and a Foreman only for its own project", async () => {
  assert.equal((await call("/orch/memory/remember", "", "POST", { kind: "phone" }, JSON.stringify({ project: "cobra", kind: "gotcha", text: "something long enough" }))).status, 403);
  const foreman = await call("/orch/memory/remember", "", "POST", { kind: "lead", project: "cobra" }, JSON.stringify({ project: "other", kind: "gotcha", text: "something long enough" }));
  assert.equal(foreman.status, 404);
  const lead = await call("/orch/memory/remember", "", "POST", { kind: "lead" }, JSON.stringify({ project: "octocat/cobra", kind: "gotcha", text: "OTA only after the merge" }));
  assert.equal(lead.status, 200);
  assert.deepEqual(lead.body, { key: "octocat/cobra", added: true, path: `computers/${memory.computerName()}/projects/octocat/cobra/lessons.md` });
  const replaced = await call(
    "/orch/memory/remember",
    "",
    "POST",
    { kind: "lead" },
    JSON.stringify({ project: "octocat/cobra", kind: "decision", text: "An OTA may go out before the merge for hotfixes", replaces: "OTA only after the merge" }),
  );
  assert.equal(replaced.status, 200);
  assert.match((replaced.body as { replaced: string }).replaced, /OTA only after the merge/);
});
