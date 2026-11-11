import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-orch-ask-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { handleOrch, ORCH_ROUTES } = await import("./orch.ts");
const asks = await import("./asks.ts");

const registry = join(ROOT, "projects.json");
writeFileSync(registry, JSON.stringify({ projects: [] }));

/** One request through handleOrch, the way index.ts routes it. */
async function call(route: string, query: string, method: "GET" | "POST", caller: { kind: string; project?: string }, body = "") {
  let reply: { status: number; body: unknown } | null = null;
  const request = { method, on: () => undefined } as unknown as http.IncomingMessage;
  await handleOrch(route, new URL(`http://agent${route}${query}`), request, {} as http.ServerResponse, {
    send: (_response, status, sent) => void (reply = { status, body: sent }),
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

const question = JSON.stringify({ question: "Start the plan?", options: [{ label: "Approve" }, { label: "Change" }] });

test("index.ts dispatches the ask and brain routes (a route left out of ORCH_ROUTES is a 404 there)", () => {
  for (const route of ["/orch/ask", "/orch/ask/wait", "/orch/brain/route"]) assert.ok(ORCH_ROUTES.has(route), route);
});

test("ask_person: the Lead asks, ask_wait reads nothing yet, your answer is then read back", async () => {
  const asked = await call("/orch/ask", "", "POST", { kind: "lead" }, question);
  assert.equal(asked.status, 200);
  const id = (asked.body as { id: string }).id;
  // A GET with no body: the wait must not need one.
  assert.deepEqual((await call("/orch/ask/wait", `?id=${id}&timeout=0`, "GET", { kind: "lead" })).body, { answered: false });
  assert.ok(asks.answerAsk("cobra_lead", [{ question: "Start the plan?", option: 1 }]));
  assert.deepEqual((await call("/orch/ask/wait", `?id=${id}&timeout=0`, "GET", { kind: "lead" })).body, { answered: true, answer: 'The person chose "Approve".' });
});

test("ask_person is refused to a phone's key, and a question needs options", async () => {
  assert.equal((await call("/orch/ask", "", "POST", { kind: "phone" }, question)).status, 403);
  assert.equal((await call("/orch/ask", "", "POST", { kind: "lead" }, JSON.stringify({ question: "q", options: [] }))).status, 400);
  assert.equal((await call("/orch/ask/wait", "?id=ask-nope&timeout=0", "GET", { kind: "lead" })).status, 404);
});

test("brain_route needs a project here and a task", async () => {
  assert.equal((await call("/orch/brain/route", "", "POST", { kind: "lead" }, JSON.stringify({ project: "nope", task: "x", kind: "docs" }))).status, 404);
});

test("plan_propose is a Foreman's: the Lead's own key is refused, and the route is dispatched", async () => {
  assert.ok(ORCH_ROUTES.has("/orch/plan"));
  assert.equal((await call("/orch/plan", "", "POST", { kind: "lead" }, JSON.stringify({ tasks: [] }))).status, 403);
  assert.equal((await call("/orch/plan", "", "POST", { kind: "lead", project: "nope" }, JSON.stringify({ tasks: [] }))).status, 404);
});
