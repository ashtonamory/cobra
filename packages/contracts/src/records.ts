import { z } from "zod";

/**
 * A project's records and Google's connectors, as the desk reads them from
 * the agent (personRoutes.ts): Settings → Integrations → Google, and a
 * project's Records section with Undo.
 *
 * Strings where a list of values would be tempting (by, mutation): an enum
 * here could never grow while an older app is in the field. Every field the
 * app does not strictly need is optional, so a newer agent may drop or
 * rename one without breaking an older app.
 */

/**
 * GET /integrations/google: Google as this computer's agents reach it.
 * Cobra has no Google connection of its own, so this is only the Claude
 * account's connectors. Never a token.
 */
export const GoogleIntegration = z.object({
  /**
   * Gmail, Google Calendar and Google Drive as the Claude account on this
   * computer has them (claude.ai → Settings → Connectors), each signed in or
   * not; absent before the agent first looked. The Lead and the Foremen use
   * the signed-in ones when they run on Claude.
   */
  connectors: z.array(z.object({ name: z.string(), connected: z.boolean() })).optional(),
});
export type GoogleIntegration = z.infer<typeof GoogleIntegration>;

/** One change to a project's database, newest first in a JournalReply. Sensitive values in `args` are masked. */
export const JournalEntry = z.object({
  /** What POST /db/undo takes as `journal`. */
  id: z.number(),
  /** ISO time. */
  at: z.string(),
  /** Who made it: "foreman", "person", "import", "routine". */
  by: z.string(),
  /** The trade's named write ("add_employee"), "import:<table>" for a file import, "undo:<mutation>" for an undo. */
  mutation: z.string(),
  /** One line about what it did. */
  summary: z.string().optional(),
  /** The arguments it ran with, sensitive values as their last four characters. */
  args: z.record(z.string(), z.unknown()).optional(),
  /** How many rows it touched. */
  changes: z.number().optional(),
  /** It was undone. */
  undone: z.boolean(),
  /** Undo may be offered: not undone, not itself an undo, and within the 7 days. The undo can still be refused when a row changed since. */
  undoable: z.boolean(),
  /** When it was undone, ISO. */
  undoneAt: z.string().nullable().optional(),
  /** When this entry is itself an undo: the entry it reversed. */
  undoOf: z.number().nullable().optional(),
});
export type JournalEntry = z.infer<typeof JournalEntry>;

/** GET /db/journal?project=&limit=: empty for a project whose trade keeps no database. */
export const JournalReply = z.object({
  project: z.string(),
  entries: z.array(JournalEntry),
  /** The project's trade keeps records (a database), written to yet or not: the apps draw Records from the start. */
  records: z.boolean().optional(),
});
export type JournalReply = z.infer<typeof JournalReply>;

