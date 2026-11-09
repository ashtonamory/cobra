import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { CONFIG_DIR } from "./paths.ts";
import { createPrivateFileOnce, readPrivateFile } from "./private.ts";

/**
 * The key terminal tickets are signed with: the agent mints a ticket, the
 * terminal gateway verifies it. It is its own file and shares nothing with
 * any caller's key, so no phone or peer key can ever sign a ticket, and
 * rotating it (delete the file, restart both units) ends every open ticket
 * without unlinking anyone.
 *
 * Whichever of the two services starts first makes it; createPrivateFileOnce
 * makes the race safe.
 */
export const TICKET_KEY_PATH = join(CONFIG_DIR, "ticket.key");

export function loadTicketKey(path = TICKET_KEY_PATH): { key: string | null; refused: string | null } {
  let read = readPrivateFile(path);
  if (!read.refused && read.text === null) {
    createPrivateFileOnce(path, `${randomBytes(32).toString("base64url")}\n`);
    read = readPrivateFile(path);
  }
  if (read.refused) return { key: null, refused: read.refused };
  const key = read.text?.trim() ?? "";
  return key.length >= 32 ? { key, refused: null } : { key: null, refused: "it holds no usable key" };
}
