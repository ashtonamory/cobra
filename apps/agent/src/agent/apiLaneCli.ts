import { rmSync } from "node:fs";
import os from "node:os";

import { API_KEY_PATH, API_WORKSPACE_PATH, apiKey, apiWorkspace, CAP_MAX_USD, DEFAULT_API_LANE, dollars, laneState, monthOf, nextMonthStart, type ApiLanePolicy } from "./apiLane.ts";
import { SpendBook } from "./apiSpend.ts";
import { describeChange, readPolicyFile, writePolicy } from "./policyEdit.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";
import { CLAUDE_TOKEN_PATH } from "./workerProxy.ts";

/**
 * `cobra-agent api-key` and `cobra-agent api-lane`:
 * keep this computer's API key, and turn the fleet's lane on or off or set
 * its cap from a terminal. The phone's and the desk's Settings do the same
 * for every computer at once.
 */

/** What the key check's reply means, in words; null when the key works. */
export function keyCheckProblem(status: number, body: string): { problem: string; needsWorkspace: boolean } | null {
  if (status >= 200 && status < 300) return null;
  if (status === 400 && /not scoped to a workspace|anthropic-workspace-id/i.test(body)) {
    return {
      problem: "This key was made outside any workspace, so it must name the workspace to bill. Run `cobra-agent api-key --workspace wrkspc_…` with the ID from Console → Settings → Workspaces, or make a key inside a workspace (which also lets you give it a spend limit).",
      needsWorkspace: true,
    };
  }
  if (status === 401 || status === 403) return { problem: `Anthropic refused this key (${status}). Check it in the Console.`, needsWorkspace: false };
  const message = (() => {
    try {
      return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
    } catch {
      return body;
    }
  })();
  return { problem: `Anthropic answered ${status}: ${message.slice(0, 300)}`, needsWorkspace: false };
}

/** One free request (count_tokens) that proves the key and its workspace work. */
async function checkKey(key: string, workspace: string | null): Promise<{ status: number; body: string }> {
  const response = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      ...(workspace ? { "anthropic-workspace-id": workspace } : {}),
    },
    body: JSON.stringify({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.text() };
}

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
  });
}

const say = (line: string) => process.stdout.write(`${line}\n`);

export async function apiKeyCommand(args: readonly string[], fail: (message: string) => never): Promise<void> {
  if (args.includes("--clear")) {
    rmSync(API_KEY_PATH, { force: true });
    rmSync(API_WORKSPACE_PATH, { force: true });
    say("Removed. Nothing on this computer spends API credits now; sessions use the subscription only.");
    return;
  }
  const workspace = option(args, "--workspace");
  if (workspace !== undefined && !/^wrkspc_[A-Za-z0-9]{4,80}$/.test(workspace)) fail("A workspace ID looks like wrkspc_…: copy it from Console → Settings → Workspaces.");
  // At a terminal, --workspace with a key already kept only names its workspace; otherwise the key comes on stdin.
  let key = apiKey();
  const addWorkspaceOnly = workspace !== undefined && key !== null && process.stdin.isTTY;
  if (!addWorkspaceOnly) {
    if (process.stdin.isTTY) say("Paste the API key (sk-ant-api…), then press Enter and Ctrl-D:");
    key = (await readStdin()).trim() || null;
  }
  if (!key) fail("No key was given. Nothing was kept.");
  if (!/^sk-ant-[A-Za-z0-9_-]{20,400}$/.test(key)) fail("That does not look like an Anthropic API key (sk-ant-…). Nothing was kept.");
  const keptWorkspace = workspace ?? apiWorkspace();
  let check: { status: number; body: string };
  try {
    check = await checkKey(key, keptWorkspace);
  } catch (caught) {
    fail(`Could not reach Anthropic to check the key (${caught instanceof Error ? caught.message : String(caught)}). Nothing was kept.`);
  }
  const problem = keyCheckProblem(check.status, check.body);
  if (problem && !problem.needsWorkspace) fail(`${problem.problem} Nothing was kept.`);
  writePrivateFile(API_KEY_PATH, `${key}\n`);
  if (workspace) writePrivateFile(API_WORKSPACE_PATH, `${workspace}\n`);
  if (problem) {
    say(`Kept in ${API_KEY_PATH}, but it cannot be used yet.`);
    say(problem.problem);
    process.exitCode = 1;
    return;
  }
  say(`Kept in ${API_KEY_PATH} (only you can read it). Anthropic accepted it${keptWorkspace ? ` for workspace ${keptWorkspace}` : ""}.`);
  if (!readPrivateFile(CLAUDE_TOKEN_PATH).text?.trim()) {
    say("Note: no long-lived Claude token is kept here, so the Lead and Foremen keep your own sign-in and do not use the key. Keep one with `claude setup-token` and `cobra-agent claude-token`.");
  }
  const lane = readPolicyFile().policy.apiLane ?? DEFAULT_API_LANE;
  if (!lane.enabled || lane.monthlyCapUsd <= 0) say("The API lane is not on yet: `cobra-agent api-lane on --cap 50`, or Settings → Claude in the desk app.");
}

/** The policy with a new lane, as the next revision, and what changed in words. */
export function laneChange(current: ReturnType<typeof readPolicyFile>["policy"], lane: ApiLanePolicy) {
  const next = { ...current, revision: current.revision + 1, apiLane: lane };
  return { next, lines: describeChange(current, next) };
}

export async function apiLaneCommand(args: readonly string[], fail: (message: string) => never): Promise<void> {
  const verb = args[0] ?? "status";
  const read = readPolicyFile();
  if (read.refused) fail(`policy.json was refused (${read.refused}); fix it before changing the API lane.`);
  const current = read.policy.apiLane ?? DEFAULT_API_LANE;
  if (verb === "status") {
    const book = new SpendBook();
    const month = book.month();
    const facts = { policy: current, key: apiKey() !== null, spentUsd: book.fleetEstimate(), month: monthOf(Date.now()) };
    const state = laneState(facts);
    say(`API lane: ${current.enabled ? "on" : "off"}, cap ${current.monthlyCapUsd > 0 ? `${dollars(current.monthlyCapUsd)} a month` : "not set"}${current.enabled && current.testMode ? "; API test mode on" : ""}`);
    say(`Key here: ${facts.key ? `kept${apiWorkspace() ? ", with a workspace ID" : ""}` : "none (cobra-agent api-key)"}`);
    say(`Spent in ${month.month}: ${dollars(month.dollars)} here in ${month.requests} requests${Object.keys(month.byRole).length ? ` (${Object.entries(month.byRole).map(([role, value]) => `${role} ${dollars(value)}`).join(", ")})` : ""}`);
    const heard = book.fleetHeard();
    say(`The fleet: ${dollars(facts.spentUsd)}${heard ? ` (others ${dollars(heard.others)} as ${heard.from} said at ${new Date(heard.at).toLocaleString()})` : " (no word from the Lead's computer this month)"}`);
    say(state.open ? `Open: helpers and jobs (claude -p) move to the key when the subscription is full; Workers, Foremen, the Lead and your sessions stay on the subscription, since the key's included credits refuse interactive Claude Code. The cap resets ${new Date(nextMonthStart(Date.now())).toLocaleDateString()}.` : `Closed: ${state.why}.`);
    return;
  }
  let lane: ApiLanePolicy;
  if (verb === "on") {
    const capText = option(args, "--cap");
    const cap = capText !== undefined ? Number(capText) : current.monthlyCapUsd;
    if (!Number.isFinite(cap) || cap <= 0 || cap > CAP_MAX_USD) fail(`Give a monthly cap in dollars: cobra-agent api-lane on --cap 50 (at most ${CAP_MAX_USD}).`);
    lane = { enabled: true, monthlyCapUsd: Math.round(cap * 100) / 100 };
  } else if (verb === "off") {
    // Off ends a test too, so turning the lane on again never restarts one.
    const { testMode: _test, ...rest } = current;
    lane = { ...rest, enabled: false };
  } else if (verb === "test") {
    // API test mode (apiTest.ts): the whole workforce on the key for a test, the Lead and Foremen restarted headless.
    const on = args[1];
    if (on !== "on" && on !== "off") fail("cobra-agent api-lane test on | off");
    if (on === "on" && (!current.enabled || current.monthlyCapUsd <= 0)) fail("Turn the API lane on with a cap first: cobra-agent api-lane on --cap 50");
    const { testMode: _test, ...rest } = current;
    lane = on === "on" ? { ...rest, testMode: true } : rest;
  } else if (verb === "cap") {
    const cap = Number(args[1]);
    if (!Number.isFinite(cap) || cap < 0 || cap > CAP_MAX_USD) fail(`cobra-agent api-lane cap <dollars> (0 to ${CAP_MAX_USD})`);
    lane = { ...current, monthlyCapUsd: Math.round(cap * 100) / 100 };
  } else {
    fail("cobra-agent api-lane status | on --cap <dollars> | off | cap <dollars> | test on|off");
  }
  const { next, lines } = laneChange(read.policy, lane);
  if (lines.length === 0) {
    say("Nothing to change.");
    return;
  }
  writePolicy(next, { at: Date.now(), revision: next.revision, by: `cobra-agent on ${os.hostname()}`, lines });
  for (const line of lines) say(line.text);
  say(`policy.json revision ${next.revision} on this computer. The desk app shows it under Settings → Claude.`);
}
