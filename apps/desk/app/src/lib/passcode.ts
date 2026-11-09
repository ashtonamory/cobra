/**
 * The desk's passcode (src-tauri/src/passcode.rs), what the web side says and checks around it: Show on a
 * dashboard and a write that is the person's alone ask for it where the phone asks for Face ID. The
 * check itself, the unlock and the lockout are the Rust side's; this is only the words and the form's rules.
 * Pure, so vitest pins it.
 */

/** What `passcode_status` answers. */
export interface PasscodeStatus {
  /** A passcode has been made. */
  set: boolean;
  unlocked: boolean;
  /** Seconds of the unlock left. */
  unlockedForS: number;
  /** Seconds before another try is allowed, after too many wrong ones. */
  waitS: number;
}

/** The shortest passcode (passcode.rs MIN_LEN). */
export const MIN_LEN = 8;

export type Mode = "make" | "unlock" | "change" | "remove";

/** What a dialog for `mode` asks, in order: the field's id and its label. */
export function fields(mode: Mode): Array<[field: "current" | "code" | "next" | "again", label: string]> {
  switch (mode) {
    case "make": return [["next", "New passcode"], ["again", "Type it again"]];
    case "unlock": return [["code", "Passcode"]];
    case "change": return [["current", "Current passcode"], ["next", "New passcode"], ["again", "Type it again"]];
    case "remove": return [["code", "Passcode"]];
  }
}

/** Why the form cannot be sent yet, or null when it can. */
export function problem(mode: Mode, typed: Partial<Record<"current" | "code" | "next" | "again", string>>): string | null {
  for (const [field, label] of fields(mode)) if (!typed[field]) return `${label} is empty.`;
  if (mode === "make" || mode === "change") {
    if ([...(typed.next ?? "")].length < MIN_LEN) return `A passcode is at least ${MIN_LEN} characters.`;
    if (typed.next !== typed.again) return "The two do not match.";
  }
  return null;
}

/** What to do for the next gated act: nothing (already unlocked), make a passcode first, or unlock. */
export function askMode(status: PasscodeStatus): "open" | Mode {
  if (status.unlocked) return "open";
  return status.set ? "unlock" : "make";
}

/** The Settings line under Passcode. */
export function statusLine(status: PasscodeStatus | null): string {
  if (!status) return "Reading…";
  if (!status.set) return "None yet. Hidden values and a person-only Allow ask you to make one.";
  if (status.waitS > 0) return `Locked out for ${status.waitS} more seconds after too many wrong tries.`;
  if (status.unlocked) {
    const minutes = Math.ceil(status.unlockedForS / 60);
    return `Unlocked for ${minutes} more minute${minutes === 1 ? "" : "s"}.`;
  }
  return "Locked. Asked for before a hidden value is shown and before a person-only Allow.";
}
