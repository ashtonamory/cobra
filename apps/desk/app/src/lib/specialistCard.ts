/**
 * A card of kind `specialist` (agent specialistRoutes.ts): Cobra proposes to
 * change what one specialist is for, its standing instructions or its model.
 * Those words go into that specialist's own rules, so the person allows what
 * they read: the card is drawn whole wherever it can be allowed, and a place
 * too small to show it whole (the popup) sends the person to Home instead.
 */
import { isDict } from "./json.ts";

/** Every word of the card, or null for any other kind. */
export function specialistText(approval: unknown): string | null {
  if (!isDict(approval) || approval.kind !== "specialist") return null;
  const body = typeof approval.body === "string" ? approval.body : "";
  return body.trim() ? body : null;
}

/** What the popup says in place of Allow and Deny. */
export const READ_ON_HOME = "Read it on Home";
export const READ_ON_HOME_NOTE = "This changes how one of your specialists works. Read every word on Home before you allow it.";
