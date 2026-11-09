import type { ApprovalAction } from "@cobra/contracts";

import { BY_AGENT } from "./dbTypes.ts";
import type { ProjectDb, TradeSchema } from "./dbTypes.ts";

export { BY_AGENT };

/**
 * Marking what went out. When an email the person allowed has gone out
 * with rendered files attached, the agent itself runs the trade's `sent`
 * mutation with each file's path and sha256, so an invoice or a pay stub reads
 * as sent in the database and the sheet without the Foreman remembering to
 * say so. Only email counts: a note stays on the person's phone, and a file
 * saved to their Drive has not reached anyone.
 */

/** The refusal a `sent` mutation gives when none of the files is one it recorded: nothing to mark, not a failure. */
const NOTHING_MATCHES = /no recorded document matches|no recorded stub matches/;

export type SentFile = { path: string; sha256: string };

/** The files an action sent to someone: an email's attachments, else none. */
export function sentFiles(action: ApprovalAction | undefined): SentFile[] {
  if (!action || action.channel !== "email") return [];
  return (action.email?.attachments ?? []).map((file) => ({ path: file.path, sha256: file.sha256 }));
}

export type MarkSentDeps = {
  schemaFor: (trade: string | undefined) => TradeSchema | null;
  open: (project: string, schema: TradeSchema) => ProjectDb;
  scheduleMirror: (project: string, schema: TradeSchema) => void;
};

/**
 * Runs the project's trade `sent` mutation for an email that went out, and
 * pushes the sheet. Returns the journal's summary, or null when the trade
 * marks nothing, the email carried no files, or none was one the trade
 * recorded. Any other refusal is thrown for the caller to log; what was sent
 * stays sent either way.
 */
export function markDocumentsSent(
  deps: MarkSentDeps,
  project: { id: string; foremanTemplate?: string | undefined },
  sent: { action: ApprovalAction | undefined; cardId: string; at: string },
): string | null {
  const files = sentFiles(sent.action);
  if (files.length === 0) return null;
  const schema = deps.schemaFor(project.foremanTemplate);
  if (!schema?.sent) return null;
  const db = deps.open(project.id, schema);
  try {
    const result = db.write(schema.sent, { files, sent_at: sent.at, card_id: sent.cardId }, BY_AGENT);
    deps.scheduleMirror(project.id, schema);
    return result.summary;
  } catch (caught) {
    if (caught instanceof Error && NOTHING_MATCHES.test(caught.message)) return null;
    throw caught;
  } finally {
    db.close();
  }
}
