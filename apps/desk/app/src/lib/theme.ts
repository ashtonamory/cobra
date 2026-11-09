/**
 * The desk's appearance: System (the default: light or dark as the system says, through CSS's
 * prefers-color-scheme), Light or Dark, as the phone's one appearance setting (apps/mobile src/scheme.ts).
 * The choice is kept in this webview's storage and put on <html> as `data-theme`, which styles/app.css
 * reads; every window of the app (main, picker, popup, box) applies it at start and follows a change made in
 * another (the `storage` event). System leaves no attribute, so a browser's own setting decides.
 */

export type ThemePref = "system" | "light" | "dark";

export const THEME_KEY = "cobra.theme";

export const THEME_CHOICES: Array<[ThemePref, string]> = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];

/** A stored word as a choice; anything else is System. */
export function parsePref(raw: string | null | undefined): ThemePref {
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function readPref(): ThemePref {
  try {
    return parsePref(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

/** Puts the choice on the page: `data-theme` for Light and Dark, none for System. */
export function applyPref(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

export function savePref(pref: ThemePref): void {
  applyPref(pref);
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    // A private window keeps the choice for this window only.
  }
}

/** At start, in every window: apply the stored choice, and follow a change made in another window. */
export function initTheme(): void {
  applyPref(readPref());
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_KEY || e.key === null) applyPref(readPref());
  });
}
