import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ForemanWait, OrchForeman, OrchWorker, WorkerWait } from "@cobra/contracts";

// Before the agent's modules load: paths.ts reads these once.
const STATE = mkdtempSync(join(tmpdir(), "cobra-delivery-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");
process.env.COBRA_AGENT_DATA_DIR = join(STATE, "data");

const { audienceOf, createFinishes } = await import("./finishes.ts");
const { screenOf } = await import("./dispatch.ts");
const { readPane } = await import("./collect/pane.ts");
const { hookStateFor, liveState } = await import("./hooks.ts");
const { foremanSettled } = await import("./foreman.ts");
const { settledKind } = await import("./workers.ts");
const { foremanWaitText, waitText } = await import("./orchMcp.ts");
const { IDLE_TYPED, PERMISSION_UP, QUESTION_UP, REAL_IDLE, WORKING_EMPTY, WORKING_TYPED, typedInto } = await import("./collect/fixtures/screens.ts");
type FinishTickDeps = import("./finishes.ts").FinishTickDeps;
type Extra = import("./extras.ts").Extra;
type HookRecord = import("./hooks.ts").HookRecord;

/**
 * Finish notices end to end, from Claude Code 2.1.293 screens (the real and
 * derived ones in collect/fixtures/screens.ts): a Worker's or a Foreman's
 * screen and hooks read the way describeWorker and describeForeman read them
 * (hookStateFor, readPane, liveState), and its owner's screen the way the
 * live tick's inspect reads it (readPane, screenOf). Only tmux is simulated:
 * which screen each session shows, what send-keys types into its box, and
 * that Enter starts a turn.
 */

const NOW = 1_800_000_000_000;
const TICK = 5000;
const STALE = 31_000;

const WORKER_PATH = "/p/cobra.worktrees/cobra_3";
const FOREMAN_HOME = join(STATE, "foremen", "cobra");

/** The idle Foreman's reply that worker_wait / foreman_wait should hand back whole. */
const WORKER_SAYS = "Done: the badge renders. PR: https://github.com/o/r/pull/12. Blocked: nothing.";
const FOREMAN_SAYS = "Report for the Lead. Done: #12 merged. PRs: #12. Blocked: nothing.";

/** One computer: tmux sessions showing screens, the hooks' latest records, and what was typed. */
function computer(options: { swallowFirstEnter?: boolean; briefedPath?: string } = {}) {
  let now = NOW;
  const panes = new Map<string, string[]>([
    ["cobra_lead", REAL_IDLE],
    ["cobra_fm", REAL_IDLE],
  ]);
  const hooks: HookRecord[] = [];
  const typed: Array<[string, string]> = [];
  const enters: string[] = [];
  let workerOwner = "cobra";
  let workerPhase: "running" | "failed" = "running";
  let swallow = options.swallowFirstEnter === true;

  const hook = (cwd: string, event: HookRecord["event"], message?: string) => {
    hooks.unshift({ agent: "claude", session: cwd, cwd, event, at: now, ...(message ? { message } : {}) });
  };

  /** As describeWorker: alive when its tmux session is, and its state from its hooks and its screen. */
  const describeWorker = (): { worker: OrchWorker; stopAt: number | null } => {
    const raw = panes.get("cobra_3");
    const alive = raw !== undefined;
    const pane = raw ? readPane(raw) : null;
    const state = alive ? liveState(hookStateFor(hooks, WORKER_PATH, now), pane, now) : null;
    const record = alive ? hookStateFor(hooks, WORKER_PATH, now) : null;
    return {
      worker: {
        id: "cobra_3",
        machine: "laptop",
        parent: "cobra",
        parentName: "cobra",
        branch: "feat/badge",
        path: WORKER_PATH,
        session: "cobra_3",
        owner: workerOwner,
        task: "a task",
        model: "claude",
        createdAt: "2026-10-10T12:00:00Z",
        phase: workerPhase === "failed" ? "failed" : alive ? "running" : "stopped",
        activity: state?.activity ?? null,
        needsInput: state?.needsInput ?? false,
        dialog: state?.dialog ?? null,
        tail: pane?.tail ?? [],
      },
      // As liveFinishTickDeps: a Stop hook's time tells one turn from the next.
      stopAt: record?.event === "Stop" ? record.at : null,
    };
  };

  /** As describeForeman: only a session in its own folder speaks for it. */
  const describeForeman = (): { foreman: OrchForeman; stopAt: number | null } => {
    const raw = panes.get("cobra_fm");
    const alive = raw !== undefined;
    const pane = raw ? readPane(raw) : null;
    const record = alive ? hookStateFor(hooks, FOREMAN_HOME, now, { exact: true }) : null;
    const state = alive ? liveState(record, pane, now) : null;
    return {
      foreman: {
        project: "cobra",
        name: "cobra",
        session: "cobra_fm",
        running: alive,
        activity: state?.activity ?? null,
        needsInput: state?.needsInput ?? false,
        dialog: state?.dialog ?? null,
        tail: pane?.tail ?? [],
      },
      stopAt: record?.event === "Stop" ? record.at : null,
    };
  };

  const deps: FinishTickDeps = {
    workers: async () => [{ extra: { id: "cobra_3", session: "cobra_3", path: WORKER_PATH } as Extra, ...describeWorker() }],
    turn: async () => ({ offset: 4096, lastMessage: WORKER_SAYS }),
    // As liveFinishTickDeps: a listing with no session at all is a failed one.
    foremen: async () => [{ ...describeForeman(), listed: panes.size > 0 }],
    foremanTurn: async () => ({ offset: 8123, lastMessage: FOREMAN_SAYS }),
    target: async (owner) => (owner === "lead" ? "cobra_lead" : owner === "cobra" ? "cobra_fm" : null),
    sessionExists: async (session) => panes.has(session),
    // liveDeps().inspect, with the capture handed over instead of read from tmux.
    inspect: async (session) => {
      const raw = panes.get(session);
      return raw ? screenOf(readPane(raw)) : null;
    },
    // send-keys -l: the words land in the box.
    type: async (session, text) => {
      typed.push([session, text]);
      panes.set(session, typedInto(panes.get(session) ?? [], text));
    },
    // Enter: with words in the box, a turn starts and the box empties.
    submit: async (session) => {
      enters.push(session);
      if (swallow) {
        swallow = false;
        return;
      }
      const raw = panes.get(session);
      if (raw && readPane(raw).box === "text") panes.set(session, WORKING_EMPTY);
    },
    wait: async () => undefined,
    log: () => undefined,
    now: () => now,
  };

  const open = () => createFinishes(options.briefedPath ? { path: options.briefedPath, log: () => undefined } : {});
  let finishes = open();
  return {
    get finishes() {
      return finishes;
    },
    /** The agent restarts: a new tracker, on the same file; tmux and the hooks stay as they are. */
    restart() {
      finishes = open();
    },
    deps,
    panes,
    typed,
    enters,
    /** Five seconds on, then the agent's tick. */
    async tick(times = 1) {
      for (let i = 0; i < times; i += 1) {
        now += TICK;
        await finishes.tick(deps);
      }
    },
    /** Time passing with no tick, as while a turn runs. */
    later(ms: number) {
      now += ms;
    },
    worker: {
      show: (screen: string[] | null) => (screen ? panes.set("cobra_3", screen) : panes.delete("cobra_3")),
      hook: (event: HookRecord["event"], message?: string) => hook(WORKER_PATH, event, message),
      owner: (owner: string) => void (workerOwner = owner),
      fail: () => void (workerPhase = "failed"),
      describe: describeWorker,
    },
    foreman: {
      show: (screen: string[] | null) => (screen ? panes.set("cobra_fm", screen) : panes.delete("cobra_fm")),
      hook: (event: HookRecord["event"], message?: string) => hook(FOREMAN_HOME, event, message),
      describe: describeForeman,
    },
    lead: { show: (screen: string[]) => panes.set("cobra_lead", screen) },
  };
}

/** The Worker works a turn (a prompt went in), then rests on `screen` with `event`'s hook. */
async function workerTurn(c: ReturnType<typeof computer>, screen: string[], event: HookRecord["event"] = "Stop", message?: string) {
  c.worker.show(WORKING_EMPTY);
  c.worker.hook("UserPromptSubmit");
  await c.tick();
  c.worker.show(screen);
  c.worker.hook(event, message);
}

async function foremanTurn(c: ReturnType<typeof computer>, screen: string[], event: HookRecord["event"] = "Stop", message?: string) {
  c.foreman.show(WORKING_EMPTY);
  c.foreman.hook("UserPromptSubmit");
  await c.tick();
  c.foreman.show(screen);
  c.foreman.hook(event, message);
}

const IDLE_LINE = "[cobra] Worker cobra_3 finished its turn (idle). worker_read cobra_3 after=4096";
const FOREMAN_IDLE_LINE = "[cobra] Foreman for cobra finished its turn (idle). foreman_read cobra after=8123";

// --- what the screens say ------------------------------------------------------------------

test("the owner's screen: only the idle one with a suggestion in its box takes a line", () => {
  const takes = (raw: string[]) => {
    const screen = screenOf(readPane(raw));
    return screen.accepting && !screen.working && screen.dialog === null && screen.box === "empty";
  };
  assert.equal(takes(REAL_IDLE), true, "the dim suggestion is not typing");
  assert.equal(takes(WORKING_TYPED), false);
  assert.equal(takes(WORKING_EMPTY), false, "a live spinner and an empty box: still working");
  assert.equal(takes(PERMISSION_UP), false);
  assert.equal(takes(QUESTION_UP), false);
  assert.equal(takes(IDLE_TYPED), false, "the person is typing");
  assert.equal(takes(typedInto(REAL_IDLE, IDLE_LINE)), false, "a notice typed and not yet sent");
});

test("mergeState, through liveState: idle and working read right from the real screens", () => {
  const at = (event: HookRecord["event"], age: number, message?: string) =>
    hookStateFor([{ agent: "claude", session: "s", cwd: "/w", event, at: NOW - age, ...(message ? { message } : {}) }], "/w", NOW);
  const read = (hook: ReturnType<typeof at>, raw: string[]) => liveState(hook, readPane(raw), NOW);

  // No hooks installed: the screen alone.
  assert.deepEqual(read(null, REAL_IDLE), { activity: "agent-idle", needsInput: false, dialog: null });
  assert.equal(read(null, IDLE_TYPED).activity, "agent-idle");
  assert.equal(read(null, WORKING_TYPED).activity, "agent-working");
  assert.equal(read(null, WORKING_EMPTY).activity, "agent-working");
  assert.deepEqual(read(null, PERMISSION_UP), { activity: "agent-idle", needsInput: true, dialog: "permission" });
  assert.deepEqual(read(null, QUESTION_UP), { activity: "agent-idle", needsInput: true, dialog: "question" });

  // A Stop hook under an idle screen, a suggestion in its box or words typed in it.
  assert.equal(read(at("Stop", 1000), REAL_IDLE).activity, "agent-idle");
  assert.equal(read(at("Stop", 1000), IDLE_TYPED).activity, "agent-idle");

  // A prompt went in: working while the screen works, and while the screen may not have caught up.
  assert.equal(read(at("UserPromptSubmit", 1000), WORKING_EMPTY).activity, "agent-working");
  assert.equal(read(at("PostToolUse", 1000), WORKING_TYPED).activity, "agent-working");
  assert.equal(read(at("UserPromptSubmit", 1000), REAL_IDLE).activity, "agent-working");
  // An interrupted turn fires no Stop: once stale, the idle screen settles it, the suggestion in its box read as empty.
  assert.equal(read(at("UserPromptSubmit", STALE), REAL_IDLE).activity, "agent-idle");
  // Words typed in the box keep the hook's word.
  assert.equal(read(at("UserPromptSubmit", STALE), IDLE_TYPED).activity, "agent-working");

  // A permission prompt, then the same after it was answered and the tool runs.
  const asks = at("Notification", 1000, "Claude needs your permission to use Bash");
  assert.deepEqual(read(asks, PERMISSION_UP), { activity: "agent-idle", needsInput: true, dialog: "permission" });
  assert.deepEqual(read(asks, WORKING_EMPTY), { activity: "agent-working", needsInput: false, dialog: null });
  // A question with only a working hook behind it: the screen says it waits, and it is not working.
  assert.deepEqual(read(at("PostToolUse", 1000), QUESTION_UP), { activity: "agent-idle", needsInput: true, dialog: "question" });

  // The kinds finishes.ts follows, from those.
  const worker = (state: ReturnType<typeof read>) => settledKind({ phase: "running", ...state } as OrchWorker);
  assert.equal(worker(read(at("Stop", 1000), REAL_IDLE)), "idle");
  assert.equal(worker(read(at("UserPromptSubmit", 1000), WORKING_EMPTY)), null);
  assert.equal(worker(read(asks, PERMISSION_UP)), "needs-input");
  const foreman = (state: ReturnType<typeof read>) => foremanSettled({ running: true, ...state } as OrchForeman);
  assert.equal(foreman(read(at("Stop", 1000), REAL_IDLE)), "idle");
  assert.equal(foreman(read(at("PostToolUse", 1000), QUESTION_UP)), "needs-input");
  assert.equal(foreman(read(at("UserPromptSubmit", 1000), WORKING_TYPED)), null);
});

test("a turn no prompt started (a background task's result came in) reads as working under a Stop hook", () => {
  const stop = hookStateFor([{ agent: "claude", session: "s", cwd: "/w", event: "Stop", at: NOW - 1000 }], "/w", NOW);
  // Claude Code starts a turn by itself when an MCP task or a background command ends ("MCP task … completed",
  // as in the real idle capture): a queued task notification, not a typed prompt, so the hook's last word is
  // still the earlier Stop.
  assert.equal(liveState(stop, readPane(WORKING_EMPTY), NOW).activity, "agent-working");
  assert.equal(liveState(stop, readPane(WORKING_TYPED), NOW).activity, "agent-working");
  const idle = hookStateFor([{ agent: "claude", session: "s", cwd: "/w", event: "Notification", at: NOW - 1000, message: "Claude is waiting for your input" }], "/w", NOW);
  assert.equal(liveState(idle, readPane(WORKING_EMPTY), NOW).activity, "agent-working");
  // The screen at rest leaves the Stop standing.
  assert.equal(liveState(stop, readPane(REAL_IDLE), NOW).activity, "agent-idle");
});

test("(a) a Worker a task result set going again is not told as finished until that turn ends", async () => {
  const c = computer();
  await workerTurn(c, REAL_IDLE);
  // Within the settle window, the result of a background task starts a turn: no hook fires.
  c.worker.show(WORKING_EMPTY);
  await c.tick(3);
  assert.deepEqual(c.typed, [], "working, whatever the Stop hook last said");
  c.worker.show(REAL_IDLE);
  c.worker.hook("Stop");
  await c.tick(2);
  assert.deepEqual(c.typed, [["cobra_fm", IDLE_LINE]]);
});

// --- (a) Worker → Foreman ------------------------------------------------------------------

test("(a) a Worker's finish is typed into its Foreman's idle box, the suggestion in it read as empty, exactly once", async () => {
  const c = computer();
  await workerTurn(c, REAL_IDLE);
  await c.tick();
  assert.deepEqual(c.typed, [], "one idle tick: maybe a pause between two tools");
  await c.tick();
  assert.deepEqual(c.typed, [["cobra_fm", IDLE_LINE]]);
  assert.equal(readPane(c.panes.get("cobra_fm") ?? []).working, true, "Enter went through: the Foreman works on it");
  assert.deepEqual(c.enters, ["cobra_fm"]);
  // The Foreman's turn ends; the Worker is still idle.
  c.foreman.show(REAL_IDLE);
  await c.tick(4);
  assert.equal(c.typed.length, 1, "told once");
  assert.equal(c.finishes.queued().length, 0);
});

test("(a) an Enter the box swallowed is pressed again; the line is still typed once", async () => {
  const c = computer({ swallowFirstEnter: true });
  await workerTurn(c, REAL_IDLE);
  await c.tick(2);
  assert.deepEqual(c.typed, [["cobra_fm", IDLE_LINE]]);
  assert.deepEqual(c.enters, ["cobra_fm", "cobra_fm"]);
  assert.equal(readPane(c.panes.get("cobra_fm") ?? []).working, true);
});

test("(a) a working, asking or typed-into Foreman holds the notice; it goes once the Foreman is idle", async () => {
  const c = computer();
  c.foreman.show(WORKING_TYPED);
  await workerTurn(c, REAL_IDLE);
  await c.tick(2);
  for (const [name, screen] of [
    ["working, words typed", WORKING_TYPED],
    ["working, box empty", WORKING_EMPTY],
    ["a permission prompt up", PERMISSION_UP],
    ["a question up", QUESTION_UP],
    ["idle, the person typing", IDLE_TYPED],
  ] as const) {
    c.foreman.show(screen);
    await c.tick();
    assert.deepEqual(c.typed, [], name);
    assert.equal(c.finishes.queued().length, 1, name);
  }
  c.foreman.show(REAL_IDLE);
  await c.tick();
  assert.deepEqual(c.typed, [["cobra_fm", IDLE_LINE]]);
  c.foreman.show(REAL_IDLE);
  await c.tick(3);
  assert.equal(c.typed.length, 1);
});

test("(a) waiting for the person, stopping and failing are each told once, in their words", async () => {
  const c = computer();
  await workerTurn(c, PERMISSION_UP, "Notification", "Claude needs your permission to use Bash");
  await c.tick(2);
  assert.deepEqual(c.typed, [["cobra_fm", "[cobra] Worker cobra_3 waits for the person (permission). worker_read cobra_3 after=4096"]]);
  c.foreman.show(REAL_IDLE);
  await c.tick(3);
  assert.equal(c.typed.length, 1, "the same prompt still up: not again");

  // The person answers on their phone; it works, then its session ends.
  c.worker.show(WORKING_EMPTY);
  c.worker.hook("PostToolUse");
  await c.tick();
  c.worker.show(null);
  await c.tick(2);
  assert.equal(c.typed[1]?.[1], "[cobra] Worker cobra_3 stopped. worker_read cobra_3 after=4096");

  c.foreman.show(REAL_IDLE);
  c.worker.fail();
  await c.tick(2);
  assert.equal(c.typed[2]?.[1], "[cobra] Worker cobra_3 failed. worker_read cobra_3 after=4096");
  c.foreman.show(REAL_IDLE);
  await c.tick(3);
  assert.equal(c.typed.length, 3);
});

test("(a) worker_wait returns the finish with the last message; the held notice is then never typed", async () => {
  const c = computer();
  // The Foreman sits in worker_wait: a turn runs on its screen.
  c.foreman.show(WORKING_EMPTY);
  await workerTurn(c, REAL_IDLE);
  await c.tick(2);
  assert.equal(c.finishes.queued().length, 1);

  // /orch/worker/wait for the Foreman's key, then the cobra-orch tool's text.
  const audience = audienceOf({ id: "foreman_cobra", kind: "lead", project: "cobra" });
  const fresh = c.finishes.claim(["cobra_3"], audience);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]?.kind, "idle");
  assert.equal(fresh[0]?.lastMessage, WORKER_SAYS);
  const reply = JSON.parse(
    JSON.stringify({ timedOut: false, workers: [c.worker.describe().worker], finishes: fresh, cursor: fresh[0]?.at }),
  ) as WorkerWait;
  const text = waitText(reply);
  assert.match(text, /worker_read cobra_3 after=4096/);
  assert.ok(text.includes(WORKER_SAYS), "the last message, whole");

  // worker_wait returns; the Foreman's turn ends.
  c.foreman.show(REAL_IDLE);
  await c.tick(3);
  assert.deepEqual(c.typed, [], "already told by worker_wait");
  assert.equal(c.finishes.queued().length, 0);
  assert.deepEqual(c.finishes.claim(["cobra_3"], audience), [], "and worker_wait does not return it twice");
});

test("(a) after the line was typed, worker_wait does not return the same finish", async () => {
  const c = computer();
  await workerTurn(c, REAL_IDLE);
  await c.tick(2);
  assert.equal(c.typed.length, 1);
  assert.deepEqual(c.finishes.claim(["cobra_3"], "cobra"), []);
  assert.equal(c.finishes.claim(["cobra_3"], "cobra", 0).length, 1, "since 0 asks for it again");
});

test("(a) a Worker the Lead owns tells the Lead, not the Foreman", async () => {
  const c = computer();
  c.worker.owner("lead");
  await workerTurn(c, REAL_IDLE);
  await c.tick(2);
  assert.deepEqual(c.typed, [["cobra_lead", IDLE_LINE]]);
});

// --- (b) Foreman → Lead -------------------------------------------------------------------

test("(b) a briefed Foreman's finish is typed into the Lead's idle box exactly once", async () => {
  const c = computer();
  c.finishes.briefed("cobra");
  await foremanTurn(c, REAL_IDLE);
  await c.tick();
  assert.deepEqual(c.typed, []);
  await c.tick();
  assert.deepEqual(c.typed, [["cobra_lead", FOREMAN_IDLE_LINE]]);
  assert.equal(readPane(c.panes.get("cobra_lead") ?? []).working, true);
  c.lead.show(REAL_IDLE);
  await c.tick(4);
  assert.equal(c.typed.length, 1, "told once");
});

test("(b) a working, asking or typed-into Lead holds the notice; it goes once the Lead is idle", async () => {
  const c = computer();
  c.finishes.briefed("cobra");
  c.lead.show(WORKING_TYPED);
  await foremanTurn(c, REAL_IDLE);
  await c.tick(2);
  for (const [name, screen] of [
    ["working, words typed", WORKING_TYPED],
    ["working, box empty", WORKING_EMPTY],
    ["a permission prompt up", PERMISSION_UP],
    ["a question up", QUESTION_UP],
    ["idle, the person typing", IDLE_TYPED],
  ] as const) {
    c.lead.show(screen);
    await c.tick();
    assert.deepEqual(c.typed, [], name);
    assert.equal(c.finishes.queued().length, 1, name);
  }
  c.lead.show(REAL_IDLE);
  await c.tick();
  assert.deepEqual(c.typed, [["cobra_lead", FOREMAN_IDLE_LINE]]);
  c.lead.show(REAL_IDLE);
  await c.tick(3);
  assert.equal(c.typed.length, 1);
});

test("(b) a Foreman waiting for the person, then stopped, is told once each", async () => {
  const c = computer();
  c.finishes.briefed("cobra");
  // AskUserQuestion fires no Notification: the last hook says working, the screen says it asks.
  c.foreman.show(WORKING_EMPTY);
  c.foreman.hook("UserPromptSubmit");
  await c.tick();
  c.foreman.show(QUESTION_UP);
  c.foreman.hook("PostToolUse");
  await c.tick(2);
  assert.deepEqual(c.typed, [["cobra_lead", "[cobra] Foreman for cobra waits for the person (question). foreman_read cobra after=8123"]]);
  c.lead.show(REAL_IDLE);
  await c.tick(3);
  assert.equal(c.typed.length, 1);

  c.foreman.show(null);
  await c.tick(2);
  assert.equal(c.typed[1]?.[1], "[cobra] Foreman for cobra stopped. foreman_read cobra", "gone: no transcript to point at");
  c.lead.show(REAL_IDLE);
  await c.tick(3);
  assert.equal(c.typed.length, 2);
});

test("(b) foreman_wait returns the finish with the report; the held notice is then never typed", async () => {
  const c = computer();
  c.finishes.briefed("cobra");
  c.lead.show(WORKING_EMPTY);
  await foremanTurn(c, REAL_IDLE);
  await c.tick(2);
  assert.equal(c.finishes.queued().length, 1);

  const audience = audienceOf({ id: "lead_laptop", kind: "lead" });
  const fresh = c.finishes.claimForemen(["cobra"], audience);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]?.foreman, true);
  assert.equal(fresh[0]?.lastMessage, FOREMAN_SAYS);
  const reply = JSON.parse(
    JSON.stringify({ timedOut: false, foremen: [c.foreman.describe().foreman], finishes: fresh, cursor: fresh[0]?.at }),
  ) as ForemanWait;
  const text = foremanWaitText(reply);
  assert.match(text, /foreman_read cobra after=8123/);
  assert.ok(text.includes(FOREMAN_SAYS), "the report, whole");

  c.lead.show(REAL_IDLE);
  await c.tick(3);
  assert.deepEqual(c.typed, [], "already told by foreman_wait");
  assert.equal(c.finishes.queued().length, 0);
  assert.deepEqual(c.finishes.claimForemen(["cobra"], audience), []);
});

test("(b) a Foreman nobody briefed never wakes the Lead, and is kept for foreman_wait", async () => {
  const c = computer();
  await foremanTurn(c, REAL_IDLE);
  await c.tick(4);
  assert.deepEqual(c.typed, []);
  assert.equal(c.finishes.claimForemen(["cobra"], "lead")[0]?.lastMessage, FOREMAN_SAYS);
});

test("(a) and (b) together: the Worker tells the Foreman, whose turn then tells the Lead", async () => {
  const c = computer();
  c.finishes.briefed("cobra");
  await workerTurn(c, REAL_IDLE);
  await c.tick(2);
  assert.deepEqual(c.typed, [["cobra_fm", IDLE_LINE]]);
  // The notice started the Foreman's turn (UserPromptSubmit); it reviews, then rests.
  c.foreman.hook("UserPromptSubmit");
  await c.tick();
  c.foreman.show(REAL_IDLE);
  c.foreman.hook("Stop");
  await c.tick(2);
  assert.deepEqual(c.typed, [
    ["cobra_fm", IDLE_LINE],
    ["cobra_lead", FOREMAN_IDLE_LINE],
  ]);
  c.lead.show(REAL_IDLE);
  await c.tick(4);
  assert.equal(c.typed.length, 2);
});

// --- (b) across a restart of the agent -----------------------------------------------------

test("(b) after a restart the Lead still hears a briefed Foreman's next finish, exactly once, and not the last one again", async () => {
  const c = computer({ briefedPath: join(STATE, "briefed-restart.json") });
  c.finishes.briefed("cobra");
  await foremanTurn(c, REAL_IDLE);
  await c.tick(2);
  assert.deepEqual(c.typed, [["cobra_lead", FOREMAN_IDLE_LINE]]);
  c.lead.show(REAL_IDLE);

  // systemctl --user restart cobra-agent: the Foreman and the Lead live on in tmux.
  c.restart();
  await c.tick(4);
  assert.equal(c.typed.length, 1, "the turn it was told of is not told again");
  assert.deepEqual(c.finishes.claimForemen(["cobra"], "lead"), [], "nor returned by foreman_wait");

  await foremanTurn(c, REAL_IDLE);
  await c.tick(2);
  assert.deepEqual(c.typed, [
    ["cobra_lead", FOREMAN_IDLE_LINE],
    ["cobra_lead", FOREMAN_IDLE_LINE],
  ]);
  c.lead.show(REAL_IDLE);
  await c.tick(4);
  assert.equal(c.typed.length, 2, "told once");
});

test("(b) a restart in the middle of a briefed Foreman's turn: its finish reaches the Lead once", async () => {
  const c = computer({ briefedPath: join(STATE, "briefed-midturn.json") });
  c.finishes.briefed("cobra");
  c.foreman.show(WORKING_EMPTY);
  c.foreman.hook("UserPromptSubmit");
  await c.tick();
  c.restart();
  await c.tick();
  c.foreman.show(REAL_IDLE);
  c.foreman.hook("Stop");
  await c.tick(2);
  assert.deepEqual(c.typed, [["cobra_lead", FOREMAN_IDLE_LINE]]);
  c.lead.show(REAL_IDLE);
  await c.tick(4);
  assert.equal(c.typed.length, 1);
});

test("(b) a briefed Foreman's turn that ended while the agent was down is told once after it starts", async () => {
  const c = computer({ briefedPath: join(STATE, "briefed-down.json") });
  c.finishes.briefed("cobra");
  c.foreman.show(WORKING_EMPTY);
  c.foreman.hook("UserPromptSubmit");
  await c.tick();
  // The agent stops; the Foreman ends its turn; the agent starts again.
  c.later(20_000);
  c.foreman.show(REAL_IDLE);
  c.foreman.hook("Stop");
  c.restart();
  await c.tick();
  assert.deepEqual(c.typed, [["cobra_lead", FOREMAN_IDLE_LINE]]);
  c.lead.show(REAL_IDLE);
  await c.tick(4);
  assert.equal(c.typed.length, 1);
  // And once more across a second restart: still the turn it was told of.
  c.restart();
  await c.tick(3);
  assert.equal(c.typed.length, 1);
});

test("(b) a briefed Foreman whose session ended while the agent was down: the Lead hears it stopped, once", async () => {
  const path = join(STATE, "briefed-gone.json");
  const c = computer({ briefedPath: path });
  c.finishes.briefed("cobra");
  await foremanTurn(c, REAL_IDLE);
  await c.tick(2);
  assert.deepEqual(c.typed, [["cobra_lead", FOREMAN_IDLE_LINE]]);
  c.lead.show(REAL_IDLE);

  c.foreman.show(null);
  c.restart();
  await c.tick(2);
  assert.deepEqual(c.typed[1], ["cobra_lead", "[cobra] Foreman for cobra stopped. foreman_read cobra"]);
  c.lead.show(REAL_IDLE);
  await c.tick(4);
  assert.equal(c.typed.length, 2, "told once");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { foremen: [] }, "then forgotten");
});

test("(b) tmux down when the agent starts: no kept Foreman is dropped", async () => {
  const path = join(STATE, "briefed-tmux-down.json");
  const c = computer({ briefedPath: path });
  c.finishes.briefed("cobra");
  await foremanTurn(c, REAL_IDLE);
  await c.tick(2);
  c.lead.show(REAL_IDLE);
  const saved = readFileSync(path, "utf8");

  // list-sessions fails: collectTmux reads that as no sessions at all.
  const panes = new Map(c.panes);
  c.panes.clear();
  c.restart();
  await c.tick(4);
  assert.equal(readFileSync(path, "utf8"), saved);
  for (const [name, screen] of panes) c.panes.set(name, screen);
  await c.tick(3);
  assert.equal(c.typed.length, 1, "back up, on the turn it was told of: nothing new");
  await foremanTurn(c, REAL_IDLE);
  await c.tick(2);
  assert.equal(c.typed.length, 2, "and the next finish still reaches the Lead");
});
