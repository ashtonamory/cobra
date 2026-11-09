/**
 * Settings' small words that are not an agent's: which desktop this is, the picker's shortcut as
 * that desktop writes it, and a change's time as the desk wrote it
 * (GLib's "%b %-d %H:%M"). Pure, so a test can pin each one.
 */

export type Os = "macos" | "linux";

/** The desktop from the webview's user agent: Tauri's webviews say Mac like a browser. */
export function osOf(userAgent: string): Os {
  if (/Mac/i.test(userAgent) && !/iPhone|iPad/i.test(userAgent)) return "macos";
  return "linux";
}

/**
 * The picker's shortcut, as each desktop writes keys: registered on the Rust
 * side on macOS; on Linux a Hyprland bind (apps/desk/omarchy/hypr), since
 * Wayland lets no app take a global key.
 */
export function pickerShortcut(os: Os): string {
  return os === "macos" ? "⌘⇧Space" : "Super+P";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 9 14:05", local time, from milliseconds (the agent's `at`). */
export function shortWhen(atMs: number): string {
  const d = new Date(atMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
