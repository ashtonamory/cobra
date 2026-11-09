import { z } from "zod";

/**
 * What Cobra did: what
 * was decided without you on one computer, newest first, each with its
 * Undo. `kind` and the undo's `kind` are free strings, so a newer agent's
 * kinds never fail an older app's parse.
 */
export const DecidedEntry = z.object({
  id: z.string(),
  at: z.string(),
  /** plan, routine, org, trade, connection, merge or action. */
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  approval: z.string().optional(),
  /** The project's id on that computer, for opening it. */
  project: z.string().optional(),
  /** The words on Undo, or null when it has none. */
  undoLabel: z.string().nullable().optional(),
  /** Why there is no Undo, when there is none. */
  noUndo: z.string().optional(),
  /** When it was undone, and how that went. */
  undone: z.string().optional(),
  undoNote: z.string().optional(),
  /** A research run's id (kind web-run), to find its reads in GET /web/runs. */
  run: z.string().optional(),
});
export type DecidedEntry = z.infer<typeof DecidedEntry>;

const Cap = z.object({ used: z.number().int(), cap: z.number().int() });

/** GET /decided?days=: the entries, and how much of each daily cap the last 24 hours used. */
export const DecidedList = z.object({
  decided: z.array(DecidedEntry),
  caps: z.object({ merge: Cap, cards: Cap }).partial().optional(),
});
export type DecidedList = z.infer<typeof DecidedList>;

/** POST /decided/undo {id}: the entry, undone. */
export const DecidedUndone = z.object({ decided: DecidedEntry });
export type DecidedUndone = z.infer<typeof DecidedUndone>;

/**
 * A receipt's push (categories receipt and receipt-stop): the entry its
 * lock-screen Undo or Stop posts to POST /decided/undo on that computer.
 */
export const ReceiptPushData = z.object({ machine: z.string(), decided: z.string() });
export type ReceiptPushData = z.infer<typeof ReceiptPushData>;
