import { z } from "zod";

/**
 * General chat with Claude, run by a computer's own Claude Code on its owner's
 * subscription (agent chats.ts). The conversations live on that computer; the
 * phone lists them, sends a message, and polls the thread while Claude answers.
 *
 * Strings rather than enums for `role` and `activity` (gotcha 18): a value
 * added later must not make an older app reject the whole thread.
 */

export const ChatMessage = z.object({
  /** "user" or "assistant". */
  role: z.string(),
  text: z.string(),
  at: z.string().datetime(),
  /** The turn failed or was stopped; `text` says why, after any partial answer. */
  error: z.boolean().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatSummary = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string().datetime(),
  /** The start of the last message, for the list. */
  preview: z.string(),
  /** Claude is answering in this chat now. */
  running: z.boolean(),
});
export type ChatSummary = z.infer<typeof ChatSummary>;

export const ChatList = z.object({
  machine: z.string(),
  chats: z.array(ChatSummary),
});
export type ChatList = z.infer<typeof ChatList>;

/** The answer so far, while Claude is still working on it. */
export const ChatPending = z.object({
  text: z.string(),
  /** What Claude is doing now, in a few words ("Searching the web"); null while it writes. */
  activity: z.string().nullable(),
  startedAt: z.string().datetime(),
});
export type ChatPending = z.infer<typeof ChatPending>;

export const ChatThread = z.object({
  id: z.string(),
  title: z.string(),
  machine: z.string(),
  messages: z.array(ChatMessage),
  pending: ChatPending.nullable(),
});
export type ChatThread = z.infer<typeof ChatThread>;

/** POST /chats/send. No `id` starts a new chat. */
export const ChatSendRequest = z.object({
  id: z.string().optional(),
  text: z.string().min(1),
  /**
   * What the phone knows that Claude should too: tasks, routines, this week's
   * commitments, every computer's projects. Sent with every message, so it is
   * always as fresh as the phone.
   */
  context: z.string().optional(),
});
export type ChatSendRequest = z.infer<typeof ChatSendRequest>;

export const ChatSendResponse = z.object({ id: z.string() });
export type ChatSendResponse = z.infer<typeof ChatSendResponse>;
