import { z } from "zod";

/**
 * A trade Cobra defined, as its card shows it (kind `trade`). Allow installs
 * exactly the definition whose hash is `sha256`. Strings where a list of
 * values would be tempting, so a new one never fails an older app.
 */
export const ApprovalTrade = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  brief: z.string(),
  /** calendar, mail: what it reads once the person turns those on. */
  reads: z.array(z.string()),
  tables: z.array(z.object({ name: z.string(), describe: z.string(), columns: z.array(z.string()), added: z.boolean() })),
  mutations: z.array(z.object({ name: z.string(), describe: z.string() })),
  templates: z.array(z.string()),
  /** Services it would use that have no connection yet, and what it does instead. */
  needs: z.array(z.object({ service: z.string(), purpose: z.string(), fallback: z.string() })),
  /** It updates a trade already installed here (it only ever adds tables and columns). */
  replaces: z.boolean(),
  sha256: z.string(),
});
export type ApprovalTrade = z.infer<typeof ApprovalTrade>;

/** GET /trades: the trades this computer knows, shipped and defined. */
export const TradeList = z.object({
  trades: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      summary: z.string(),
      /** "shipped" or "defined". */
      source: z.string(),
      /** Its Foreman keeps records (a database): the project page shows Records before the first write. */
      records: z.boolean().optional(),
      installedAt: z.string().optional(),
    }),
  ),
});
export type TradeList = z.infer<typeof TradeList>;
