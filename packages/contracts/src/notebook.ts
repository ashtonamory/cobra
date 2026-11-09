import { z } from "zod";

/**
 * Cobra's Notebook: the Executive Assistant's notes read as an
 * executive assistant's daybook, one notebook per memory day (4 AM to 4 AM). Page 1 is the
 * day (the daily fold's summary, Open threads, Contents), then one page per active hour;
 * weekly and monthly reviews are bound volumes, company brains a ring binder.
 *
 * Memory stays on each computer, so each computer's agent
 * serves its own notes (agent notebook.ts, GET /notebook/*) and the phone and the desk ask
 * every computer and merge here (`mergeDay`, `mergeShelf`, `mergeHits`). A Sensitive
 * company's notes are only ever read from the computer that holds them, straight to the
 * person's own app; nothing here keeps them.
 *
 * The markdown the EA writes is parsed once, here (`noteParts`), so the agent hands the apps
 * sections and lines, never raw markdown. The desk keeps a port in lib/notebook.ts: change
 * them together.
 */

// --- what an agent serves -----------------------------------------------------------------

export const NotebookCompany = z.object({ id: z.string(), name: z.string() });
export type NotebookCompany = z.infer<typeof NotebookCompany>;

/** One line of a note: a bullet (depth 0 or more) or a plain line of a paragraph. */
export const NotebookLine = z.object({
  text: z.string(),
  bullet: z.boolean(),
  depth: z.number().int().min(0).max(4),
});
export type NotebookLine = z.infer<typeof NotebookLine>;

/** One `### ` section of a note: a project's (key), the Fleet's (key "fleet"), with its company when the org knows it. */
export const NotebookSection = z.object({
  key: z.string(),
  title: z.string(),
  company: NotebookCompany.nullable(),
  /** The computer that wrote it (its memory folder name), for the stamp and for a tick. */
  computer: z.string(),
  lines: z.array(NotebookLine),
});
export type NotebookSection = z.infer<typeof NotebookSection>;

export const NotebookThread = z.object({
  text: z.string(),
  done: z.boolean(),
  company: NotebookCompany.nullable(),
  computer: z.string(),
});
export type NotebookThread = z.infer<typeof NotebookThread>;

/** The day page: the daily fold, written at 4 AM after the day ends. */
export const NotebookDaily = z.object({
  summary: z.array(z.string()),
  sections: z.array(NotebookSection),
  threads: z.array(NotebookThread),
});
export type NotebookDaily = z.infer<typeof NotebookDaily>;

/** One hour page from one computer: "10" is 10:00 to 11:00. */
export const NotebookHour = z.object({ hour: z.string(), sections: z.array(NotebookSection) });
export type NotebookHour = z.infer<typeof NotebookHour>;

/** GET /notebook/day?day=: one computer's part of a day's notebook. */
export const NotebookDayPart = z.object({
  computer: z.string(),
  day: z.string(),
  daily: NotebookDaily.nullable(),
  hours: z.array(NotebookHour),
  /** False when the day is older than the EA keeps hourlies (7 days): only the day page is left. */
  hoursKept: z.boolean(),
});
export type NotebookDayPart = z.infer<typeof NotebookDayPart>;

/** One day on the shelf from one computer: how many hours it wrote, and whether its day page is in. */
export const NotebookSpine = z.object({ day: z.string(), hours: z.number().int(), daily: z.boolean() });
export type NotebookSpine = z.infer<typeof NotebookSpine>;

/** GET /notebook/shelf?month=YYYY-MM: one computer's shelf for a month, its volumes and its newest note. */
export const NotebookShelfPart = z.object({
  computer: z.string(),
  today: z.string(),
  keepHourlyDays: z.number().int(),
  days: z.array(NotebookSpine),
  weeks: z.array(z.string()),
  months: z.array(z.string()),
  companies: z.array(NotebookCompany),
  /** The newest hour page's first line, for Today's card; null when nothing is written today. */
  latest: z.object({ day: z.string(), hour: z.string(), line: z.string(), company: NotebookCompany.nullable() }).nullable(),
});
export type NotebookShelfPart = z.infer<typeof NotebookShelfPart>;

/** GET /notebook/volume?id=2026-W44 or 2026-10: one computer's weekly or monthly review. */
export const NotebookVolumePart = z.object({
  computer: z.string(),
  id: z.string(),
  kind: z.enum(["week", "month"]),
  summary: z.array(z.string()),
  sections: z.array(NotebookSection),
});
export type NotebookVolumePart = z.infer<typeof NotebookVolumePart>;

/** GET /notebook/brains: the company brains this computer holds. */
export const NotebookBrain = z.object({
  company: NotebookCompany,
  computer: z.string(),
  day: z.string(),
  sections: z.array(z.object({ title: z.string(), lines: z.array(NotebookLine) })),
});
export type NotebookBrain = z.infer<typeof NotebookBrain>;
export const NotebookBrains = z.object({ computer: z.string(), brains: z.array(NotebookBrain) });
export type NotebookBrains = z.infer<typeof NotebookBrains>;

/** Where a search hit is: a day page, an hour page, or a volume. */
export const NotebookPlace = z.object({
  kind: z.enum(["day", "hour", "week", "month"]),
  /** The memory day for day and hour, the volume id for week and month. */
  id: z.string(),
  hour: z.string().optional(),
});
export type NotebookPlace = z.infer<typeof NotebookPlace>;

export const NotebookHit = z.object({
  place: NotebookPlace,
  computer: z.string(),
  company: NotebookCompany.nullable(),
  line: z.string(),
});
export type NotebookHit = z.infer<typeof NotebookHit>;

/** GET /notebook/search?q=: one computer's matching lines, newest first. */
export const NotebookHits = z.object({ computer: z.string(), hits: z.array(NotebookHit), more: z.boolean() });
export type NotebookHits = z.infer<typeof NotebookHits>;

/** POST /notebook/tick: the person ticked (or unticked) an Open thread; the next daily fold leaves it out. */
export const NotebookTick = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), text: z.string().min(1).max(600), done: z.boolean() });
export type NotebookTick = z.infer<typeof NotebookTick>;

export * from "./notebookRules.ts";
