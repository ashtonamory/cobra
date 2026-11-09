import { existsSync } from "node:fs";

import type { PermissionRequest, ProjectActivity } from "@cobra/contracts";

import { CALL_GRANT_MS, callKey, grantCall, revokeCall } from "./grants.ts";
import { readPending, removePending, type PendingRequest } from "./pendingRequest.ts";
import { liveExplainer, templateOfPending, type Explainer } from "./permissionRequest.ts";
import { WORKER_ID, WORKERS_DIR } from "./policy.ts";
import { SessionError } from "./sessions.ts";
import { codexModeFile } from "./workerProxy.ts";

/**
 * A Codex Worker's ask, drawn as a permission prompt.
 *
 * Codex has no remote "ask": its Gate (gate.ts answerCodexHook) tells it no,
 * to wait or say it is blocked, and keeps the call marked `remote`
 * (pendingRequest.ts). No dialog of Codex's ever shows it, so once the Worker
 * stops working the agent reports it as waiting on a permission prompt, with
 * the call's template and a key naming that exact call (`codex:` and
 * grants.ts callKey), and the apps' card, Allow and Deny work unchanged. An
 * Allow bound to that key grants one retry of exactly that call
 * (grants.ts grantCall) and tells the Worker to run it again; a Deny tells
 * it to carry on without it.
 */

/** An ask older than this is no longer shown: the Worker has long moved on. */
export const REMOTE_ASK_MS = 30 * 60_000;

/** What the Worker is told after your Allow, and after your Deny. */
export const ALLOWED_LINE = "Cobra: the person allowed it. Run exactly the same call again now.";
export const DENIED_LINE = "Cobra: the person said no to that call. Do not run it; carry on without it, or say you are blocked.";

/** Whether Worker `id` runs on Codex: it was started with a Codex mode noted (workers.ts). */
export function isCodexWorker(id: string, dir = WORKERS_DIR): boolean {
  return WORKER_ID.test(id) && existsSync(codexModeFile(id, dir));
}

/** The key an Allow must send back: this exact call, whatever its keys' order. */
export function remoteKey(entry: Pick<PendingRequest, "tool" | "input">): string {
  return `codex:${callKey(entry.tool, entry.input)}`;
}

export type RemoteAsk = PendingRequest & { key: string };

export type RemoteDeps = {
  codex: (id: string) => boolean;
  pending: (id: string) => PendingRequest[];
  now: () => number;
  explainer?: Explainer;
  /** What else an Allow may cover (permissionRequest.ts templateOfPending); the live offer without it. */
  offers?: (entry: PendingRequest, worker: string) => PermissionRequest["allow"];
};

export const liveRemoteDeps: RemoteDeps = { codex: (id) => isCodexWorker(id), pending: (id) => readPending(id), now: Date.now };

/** The newest fresh ask of Codex Worker `id`, with its key, or null for none. */
export function remoteAsk(id: string, deps: RemoteDeps = liveRemoteDeps): RemoteAsk | null {
  if (!deps.codex(id)) return null;
  const now = deps.now();
  let newest: PendingRequest | null = null;
  for (const entry of deps.pending(id)) {
    if (entry.remote !== true || now - entry.at >= REMOTE_ASK_MS) continue;
    if (!newest || entry.at >= newest.at) newest = entry;
  }
  return newest ? { ...newest, key: remoteKey(newest) } : null;
}

/**
 * What a Codex Worker shows over what its screen and hooks say: waiting on
 * you, a permission prompt, and the request in plain words with its key.
 * Null when it has no ask up, while it works (it carries on, or runs the
 * retry), and when its screen has a dialog of its own up.
 */
export function remoteShown(
  id: string,
  screen: { activity: ProjectActivity | null; needsInput: boolean },
  deps: RemoteDeps = liveRemoteDeps,
): { needsInput: true; dialog: "permission"; request: PermissionRequest } | null {
  if (screen.needsInput || screen.activity === "agent-working") return null;
  const ask = remoteAsk(id, deps);
  if (!ask) return null;
  const template = templateOfPending(ask, id, deps.offers);
  const request = (deps.explainer ?? liveExplainer).describe({ ...template.request, key: ask.key }, template.warnings);
  return { needsInput: true, dialog: "permission", request };
}

export type RemoteAnswerDeps = RemoteDeps & {
  drop: (id: string, ask: RemoteAsk) => void;
  grant: (id: string, tool: string, input: Record<string, unknown>, until: number) => void;
  revoke: (id: string, tool: string, input: Record<string, unknown>) => void;
};

export const liveRemoteAnswerDeps: RemoteAnswerDeps = {
  ...liveRemoteDeps,
  drop: (id, ask) => removePending(id, (entry) => entry.remote === true && remoteKey(entry) === ask.key),
  grant: grantCall,
  revoke: revokeCall,
};

/**
 * Your Allow or Deny on a Codex Worker's ask, said to it with `send` (the
 * screen-checked sender, workers.ts sendToWorker). False when it has none up,
 * or when `dialogKey` names a dialog on its screen (the tmux path checks
 * that one). An Allow must name this call (409 otherwise); its grant is
 * taken back when the line did not reach the Worker, and the ask stays up.
 */
export async function answerRemote(
  id: string,
  action: "approve" | "deny",
  dialogKey: string | undefined,
  send: (text: string) => Promise<void>,
  deps: RemoteAnswerDeps = liveRemoteAnswerDeps,
): Promise<boolean> {
  const ask = remoteAsk(id, deps);
  if (!ask) return false;
  if (dialogKey && !dialogKey.startsWith("codex:")) return false;
  if (action === "deny") {
    await send(DENIED_LINE);
    deps.drop(id, ask);
    return true;
  }
  if (dialogKey !== ask.key) {
    throw new SessionError(dialogKey ? "the request changed since you saw it; look at it again" : "this app sent no copy of the request it showed; update the Cobra desk app", 409);
  }
  deps.grant(id, ask.tool, ask.input, deps.now() + CALL_GRANT_MS);
  try {
    await send(ALLOWED_LINE);
  } catch (failed) {
    deps.revoke(id, ask.tool, ask.input);
    throw failed;
  }
  deps.drop(id, ask);
  return true;
}
