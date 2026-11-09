/**
 * The product's name wherever a person reads it: headings, buttons, toasts, notifications.
 * One place, so a build under another name changes this line (and APP_NAME in
 * src-tauri/src/lib.rs, which names the windows, the tray and the Rust side's messages).
 * Never an identifier: config folders, the bundle id, commands and API paths keep their own names.
 */
export const APP_NAME = "Cobra";

/**
 * The assistant's name (the Lead) wherever a person reads it: "Message Cobra", the popup's
 * speaker, the chat's heading. Cobra will let the person name the Lead; until then it is the
 * product's name, and UI copy that names the assistant goes through `leadName()` (or this
 * constant) so that change is one place. LEAD_NAME in src-tauri/src/lib.rs is the Rust side's.
 */
export const LEAD_NAME = APP_NAME;

/** The Lead's name now: LEAD_NAME until a name the person picked is kept. */
export function leadName(): string {
  return LEAD_NAME;
}
