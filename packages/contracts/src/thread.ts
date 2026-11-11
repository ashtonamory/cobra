import { z } from "zod";

import { Question } from "./transcript.ts";

/**
 * One image in a `designs` entry: where it is on the hub (an app fetches it
 * with GET /fs/get?path=), its file name, size in bytes and pixels.
 */
export const DesignFile = z.object({
  path: z.string(),
  name: z.string(),
  bytes: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
});
export type DesignFile = z.infer<typeof DesignFile>;

/**
 * Cobra's thread: the conversation between the
 * person and Cobra, kept by the hub (agent thread.ts) apart from her Claude
 * session, so it outlives a new conversation. `GET /thread` pages through it.
 *
 * `kind` is a string, not an enum, so a kind added later does not make an
 * older app reject the page: an app draws the kinds it knows and skips the
 * rest. Known kinds:
 * - `you`: what the person typed.
 * - `cobra`: her reply.
 * - `question`: what she asked with options (`questions`).
 * - `answer`: the person's answer to one (`answers`, by question text).
 * - `session`: a new conversation of hers began (`reason`: start, new-conversation, idle).
 * - `morning`: the day's morning brief.
 * - `digest`: what happened while the person was away.
 * - `designs`: images a Designer made for the person to look at and save
 *   (`files`; `text` is its caption). Apps before 2026-11 skip it.
 *
 * `via: "voice"` marks a turn that was spoken (Talk or Call, contracts
 * voiceCall.ts): the person's words with the `[voice] ` prefix taken off, or
 * a reply the voice front spoke. `quick` marks a reply of the voice front, a
 * lighter Cobra that answers fast; the apps tag it QUICK_TAG. Apps before
 * 2026-11 ignore both.
 */
export const ThreadEntry = z.object({
  /** Increasing from 1 on the hub; `before` and `after` page by it. */
  id: z.number().int().positive(),
  at: z.string(),
  kind: z.string(),
  /** Her Claude (or Codex) session the entry belongs to: the app fades the ones before `current`. */
  conversation: z.string(),
  text: z.string(),
  questions: z.array(Question).optional(),
  answers: z.record(z.string(), z.string()).optional(),
  reason: z.string().optional(),
  files: z.array(DesignFile).optional(),
  via: z.literal("voice").optional(),
  quick: z.boolean().optional(),
});
export type ThreadEntry = z.infer<typeof ThreadEntry>;


/** GET /thread?before=<id>|after=<id>&limit=: entries oldest first. 404 on a computer that keeps no thread (not the hub). */
export const ThreadPage = z.object({
  machine: z.string(),
  entries: z.array(ThreadEntry),
  /** The conversation running now, or null when Cobra is not running. */
  current: z.string().nullable(),
  /** Older entries exist before the first one returned. */
  more: z.boolean(),
});
export type ThreadPage = z.infer<typeof ThreadPage>;

/**
 * GET /thread/wait?after=<id>&timeout=<s> (agent threadWait.ts): holds until
 * an entry after `after` comes and Cobra is not in the middle of a turn, or
 * the time runs out (at most 25 s; then `entries` may be empty). Talk reads
 * her reply with it. `working`: she is still in a turn, so more can come.
 */
export const ThreadWaitPage = ThreadPage.extend({ working: z.boolean() });
export type ThreadWaitPage = z.infer<typeof ThreadWaitPage>;

/**
 * GET and POST /settings/hub (agent hub.ts): which computer is the hub, the
 * only one Cobra runs on. The phone tells every computer when the person
 * marks one (POST `{ hub: "<hostname>" | null }`, the desk's key).
 * Null: no hub told, and Cobra may start anywhere, as before. Missing from
 * agents before 2026-10-26 (404).
 */
export const HubView = z.object({
  machine: z.string(),
  hub: z.string().nullable(),
  /** This computer is the hub (or none is set). */
  here: z.boolean(),
});
export type HubView = z.infer<typeof HubView>;
