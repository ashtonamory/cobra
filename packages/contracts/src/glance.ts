import { z } from "zod";

/** A fraction in [0,1], as everywhere else — the UI decides formatting. */
const Fraction = z.number().min(0).max(1);

/**
 * `/glance`: everything the iPhone widgets show about one computer, in one
 * small response. A widget extension has a few seconds and a few megabytes, so
 * it asks once per computer rather than for projects, system and usage in
 * turn. A widget key (keys.ts, scope "glance") can read this route and nothing
 * else; a phone's own key reads it too.
 *
 * Strings rather than enums wherever a value may grow (gotcha 18): a widget
 * that meets a state it does not know draws it plainly instead of failing.
 */
export const GlanceSession = z.object({
  /** The project's id, as in ProjectState. */
  id: z.string(),
  name: z.string(),
  /** tmux session name and path, which the app's chat route opens. */
  session: z.string(),
  path: z.string(),
  /** "attention" | "working" | "done" (sessionState) or "busy" for a dev server, build or test run. */
  state: z.string(),
  /** Which dialog, while "attention". */
  dialog: z.string().nullable(),
  /**
   * When the current state began: the wait for an "attention", the turn for
   * "working", the last output for "done", the session for "busy". Null when
   * the agent cannot tell.
   */
  since: z.string().datetime().nullable(),
  /** Local main has commits origin/main lacks: Today's "diverged" heads-up. */
  diverged: z.boolean(),
});

export const GlanceAlert = z.object({
  id: z.string(),
  /** "warn" | "critical". */
  level: z.string(),
  title: z.string(),
});

/** One allowance window of one agent subscription, as measured on this machine. */
export const GlanceLimit = z.object({
  /** "claude", "codex", … */
  agent: z.string(),
  agentName: z.string(),
  label: z.string(),
  percent: Fraction,
  /** ISO, or "" when unknown. */
  resetsAt: z.string(),
  /** This machine's sign-in worked, so the reading is live (usage.ts). */
  authOk: z.boolean(),
  /** When the collector wrote it; the freshest live reading wins across machines. */
  updatedAt: z.string(),
});

export const Glance = z.object({
  machine: z.string(),
  capturedAt: z.string().datetime(),
  /** Machine uptime, seconds. */
  uptimeSeconds: z.number(),
  cpu: Fraction,
  memory: Fraction,
  /** The fullest disk, or null without one. */
  disk: Fraction.nullable(),
  /** The hottest sensor, °C, or null without one. */
  celsius: z.number().nullable(),
  /** Battery fraction on a laptop; null elsewhere. */
  battery: Fraction.nullable(),
  /** Agent sessions and running processes; plain shells and stopped projects are left out. */
  sessions: z.array(GlanceSession),
  alerts: z.array(GlanceAlert),
  limits: z.array(GlanceLimit),
  /** What the Lead asked and only you may allow (agent approvals.ts), for Needs you. Optional: older agents have none. */
  approvals: z.array(z.object({ id: z.string(), title: z.string(), createdAt: z.string() })).optional(),
  /** Workers waiting in the queue for a place or the budget (agent queue.ts), for the Usage widget. */
  queued: z.number().int().optional(),
});

/** The widget key a phone registers for one computer: only its hash travels. */
export const WidgetKeyRequest = z.object({
  /** SHA-256 of the key, lowercase hex. */
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export type GlanceSession = z.infer<typeof GlanceSession>;
export type GlanceAlert = z.infer<typeof GlanceAlert>;
export type GlanceLimit = z.infer<typeof GlanceLimit>;
export type Glance = z.infer<typeof Glance>;
export type WidgetKeyRequest = z.infer<typeof WidgetKeyRequest>;
