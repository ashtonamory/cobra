/**
 * An image sent with a message into a Claude Code or Codex session (the + in a conversation's
 * composer), as the phone's attachRules.ts has it. A port of the desk's attach.py. Pure.
 *
 * The image goes to the computer first (the agent's `POST /session/attach`, which keeps it in the
 * session's own folder), and the message then says where it is: "<text> [Image: <path>]".
 */
import { APP_NAME } from "./appName.ts";

/** The agent cuts a message at this many characters (sessions.ts MAX_SAY). */
export const MAX_SAY = 2000;

/** What the agent accepts; HEIC is refused there, since Claude cannot read it. */
export const MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const PATTERNS = ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp"] as const;

// Python's `$` also matches before a final newline.
const ACCEPTED = /\.(png|jpe?g|gif|webp)\n?$/i;
const HEIC = /\.(heic|heif)\n?$/i;

/** Why an image cannot be sent, before it is uploaded; null when it can. */
export function problem(name: string): string | null {
  if (HEIC.test(name)) return `HEIC images cannot be read by ${APP_NAME}. Choose a JPEG or PNG.`;
  if (!ACCEPTED.test(name)) return "Only PNG, JPEG, GIF and WebP images can be attached.";
  return null;
}

/** The text, then the image's path, on one line (a newline is the submit key). The text is
 * shortened rather than the path, so the agent's cut never loses the image. Lengths are counted
 * in characters (code points), as Python's len() does. */
export function withImage(text: string, path: string): string {
  const tag = `[Image: ${path}]`;
  const line = text.split(/\s+/).filter(Boolean).join(" ");
  if (!line) return tag;
  const room = MAX_SAY - Array.from(tag).length - 1;
  if (room <= 0) return tag;
  const chars = Array.from(line);
  if (chars.length > room) return `${chars.slice(0, Math.max(0, room - 1)).join("").trimEnd()}… ${tag}`;
  return `${line} ${tag}`;
}
