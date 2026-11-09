import type { ApprovalImport } from "@cobra/contracts";

import type { StoredApproval } from "./approvals.ts";
import type { JudgeInput, JudgeMode, JudgeVerdict } from "./judge.ts";
import type { JudgeConfig, ResolvedPolicy } from "./permissions.ts";

/**
 * A card nobody answered: under Instinct,
 * one that can be undone goes to the judge once it has waited a while, rather
 * than lapsing with its work parked. One that cannot be undone keeps waiting
 * for you, and the morning brief names any that lapsed overnight
 * (morning.ts `lapsed`).
 *
 * Only these kinds, each after its wait:
 *
 *   import   files a Foreman asked to copy into its Worker's worktree. It is
 *            a read outside the worktree, which Instinct's judge already
 *            decides for a Worker's own reads, and the files are copied in,
 *            never over anything: Undo deletes each one still as copied.
 *
 * The judge's allow is Cobra's Allow (What Cobra did, with its Undo); its
 * refusal is Cobra's Deny, and the Foreman hears why; an escalation, or a
 * judge that cannot answer, leaves the card for you, never judged again.
 */
export const JUDGE_UNANSWERED_AFTER: Readonly<Record<string, number>> = {
  import: 20 * 60_000,
};

/** Pending cards past their wait and before their lapse that no judge has seen. */
export function dueForJudge(list: readonly StoredApproval[], now: number): StoredApproval[] {
  return list.filter((approval) => {
    const wait = JUDGE_UNANSWERED_AFTER[approval.kind];
    // A card made in a tainted turn waits for the person, never the judge (taint.ts).
    if (wait === undefined || approval.state !== "pending" || approval.judged || approval.taint || approval.byTaintedWorker) return false;
    if (approval.kind === "import" && !approval.imports?.files.length) return false;
    return Date.parse(approval.createdAt) + wait <= now && Date.parse(approval.expiresAt) > now;
  });
}

/** The action the judge reads for an import: each file, from where, to where, how big. Never its contents. */
export function importAction(imports: ApprovalImport): string {
  return [
    `Copy ${imports.files.length === 1 ? "this file" : `these ${imports.files.length} files`} into the Worker's own folder, where its sandbox can read them:`,
    ...imports.files.map((file) => `${file.from} -> ${file.to} (${file.bytes} bytes)`),
  ].join("\n");
}

export type UnansweredDeps = {
  /** The Worker's task as it was spawned with; null when it has ended. */
  taskOf: (worker: string) => Promise<string | null>;
  /** The policy in force for the card's project; null when it cannot be read. */
  policy: (approval: StoredApproval) => Promise<ResolvedPolicy | null>;
  judge: (input: JudgeInput, config: JudgeConfig, mode: JudgeMode) => Promise<JudgeVerdict>;
};

/**
 * The judge's verdict on one card, or null when it is not Cobra's to put to
 * the judge (no Instinct where it works, its Worker gone). A judge that fails
 * is an escalation: the card stays yours.
 */
export async function judgeUnanswered(approval: StoredApproval, deps: UnansweredDeps): Promise<JudgeVerdict | null> {
  if (approval.kind !== "import" || !approval.imports) return null;
  const policy = await deps.policy(approval).catch(() => null);
  if (!policy?.escalate) return null;
  const task = await deps.taskOf(approval.imports.worker).catch(() => null);
  if (!task) return null;
  return deps
    .judge(
      { task, capability: "outside-read", rule: "unanswered:import", reason: "the Foreman asked for these files and nobody answered the card", action: importAction(approval.imports) },
      policy.judge,
      { escalate: true, rules: policy.rules },
    )
    .catch((): JudgeVerdict => ({ verdict: "escalate", reason: "the judge failed, so it waits for you", by: "none" }));
}

/** What the Foreman hears when the judge refused its import, in place of the person's Deny. */
export function refusedImportNews(approvalId: string, imports: ApprovalImport, reason: string): string {
  return `[cobra] Nobody answered, and Cobra's judge did not allow copying files into Worker ${imports.worker} (approval ${approvalId}): ${reason} Work without them, or ask the person.`;
}
