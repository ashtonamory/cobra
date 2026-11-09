import type { ScreenQuestion } from "@cobra/contracts";

import { overlayAsk, pendingAsk } from "./asks.ts";
import { capturePane, readPane } from "./collect/pane.ts";
import type { Extra } from "./extras.ts";
import { headlessView, isHeadless } from "./headlessWorkers.ts";
import { readHookRecords } from "./hooks.ts";
import { isPi, piView } from "./pi.ts";

/**
 * Cobra answers a Worker's question:
 * a Worker under a Foreman she briefed asks its questions up the chain as the
 * Foreman does, and she reads them with request_read and answers them with
 * request_answer, as she does a Foreman's with foreman_answer. Only a
 * question: a Worker's permission prompt is the person's, a card in her
 * thread (notifyPolicy.ts).
 */

/** Why Cobra may not answer this Worker, or null when she may: it is under a Foreman she briefed, or one she started herself. */
export function requestRefusal(extra: Pick<Extra, "id" | "worker">, briefed: (project: string) => boolean): string | null {
  const owner = extra.worker?.owner;
  if (!owner) return `${extra.id} is not a Worker`;
  if (owner === "you") return `Worker ${extra.id} is the person's own session: its questions are theirs`;
  // One she started herself (directWorkers.ts) asks her, as a Foreman's Worker asks its Foreman.
  if (extra.worker?.startedBy === "lead") return null;
  if (owner === "lead" || !briefed(owner)) return `Worker ${extra.id} is not under a Foreman you briefed: its questions are the person's`;
  return null;
}

/**
 * The question a Worker waits on now (its AskUserQuestion, or an ask_person
 * ask), or null. A headless or Pi Worker has no pane to read: its waiting call
 * says it, as describeWorker reads it (workers.ts).
 */
export async function workerQuestion(
  extra: Pick<Extra, "id" | "session" | "path">,
  capture: (session: string) => Promise<string[] | null> = (name) => capturePane(name, undefined, false),
): Promise<ScreenQuestion | null> {
  if (isHeadless(extra.id)) return headlessView(extra.id)?.question ?? null;
  if (isPi(extra.id)) return piView(extra.id, extra.path, readHookRecords()).question;
  const raw = await capture(extra.session).catch(() => null);
  const pane = overlayAsk(raw ? readPane(raw) : null, pendingAsk(extra.session));
  return pane?.needsInput && pane.dialog === "question" && pane.question ? pane.question : null;
}
