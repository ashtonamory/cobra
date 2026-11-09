import { z } from "zod";

/**
 * A project's records and the account's Google connection, as the phone and
 * the desk read them from each computer (agent personRoutes.ts):
 * Settings → Integrations → Google, and a project's Records section with
 * Undo and Open sheet.
 *
 * Strings where a list of values would be tempting (problem, by, mutation):
 * an enum here could never grow while an older app is in the field. Every
 * field the app does not strictly need is optional, so a newer agent may
 * drop or rename one without breaking an older app.
 */

/**
 * GET /integrations/google: whether THIS computer's agent can use the
 * account's Google connection, through a token broker when one is plugged in
 * (otherwise Google comes through MCP connectors). Never a token.
 */
export const GoogleIntegration = z.object({
  /** A Google token broker is plugged in and took this computer. False out of the box. */
  cloudLinked: z.boolean(),
  /** The agent holds, or was just handed, an access token for the account's Google. */
  connected: z.boolean(),
  /** The Google account it acts as. */
  email: z.string().nullable().optional(),
  /** What the person allowed on Google's page (drive.file, gmail.send, …), as Google's scope URLs. */
  scopes: z.array(z.string()).optional(),
  /**
   * Why it is not connected, null when it is: "no_cloud_link" (no token broker
   * here), "google_no_client" (set up your own Google client), "google_not_connected" (connect Google in the app),
   * "google_reconnect" (connect again: revoked, or a test sign-in older than
   * 7 days), "google_unavailable" (the broker did not answer; try later). A
   * string, so a value from a newer agent reads as an unknown problem.
   */
  problem: z.string().nullable().optional(),
  /** When the agent last asked Google, ms since the epoch; null before it ever did. */
  checkedAt: z.number().nullable().optional(),
  /** A Google OAuth client of the person's own is saved on this computer (googleLocal.ts). */
  clientSet: z.boolean().optional(),
  /** Its client ID (not a secret); null when none. */
  clientId: z.string().nullable().optional(),
  /** The return address Google sends the browser to, on loopback. */
  redirect: z.string().optional(),
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
  /** The trade's named write ("add_employee"), "import:<table>" for a sheet import, "undo:<mutation>" for an undo. */
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

/** GET /db/mirror?project=: the project's sheet in the person's Drive and how its last push went. */
export const MirrorStatus = z.object({
  project: z.string(),
  /** Null until the first write creates the sheet (or the person picks one). */
  spreadsheetId: z.string().nullable().optional(),
  /** The sheet's page, for Open sheet. */
  url: z.string().nullable().optional(),
  /** The Google account the agent created the sheet as, when it did. */
  createdBy: z.string().nullable().optional(),
  /** ISO time of the last push that went through. */
  lastSync: z.string().nullable().optional(),
  /** What the last push met, in words; null once one goes through. */
  lastError: z.string().nullable().optional(),
  /** A push is owed and will run soon. */
  pending: z.boolean().optional(),
});
export type MirrorStatus = z.infer<typeof MirrorStatus>;
