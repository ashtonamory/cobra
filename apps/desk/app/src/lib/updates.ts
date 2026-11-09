/**
 * The desk's own updates (tauri-plugin-updater): the release feed is read
 * when you ask, and an update installs only when you click. The plugin
 * checks each download against the public key built into the app
 * (tauri.conf.json) and refuses one that does not match. The feed's address
 * is added by the release build (release.yml); a copy built here has none,
 * and says so when it checks.
 */

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "ready"; version: string; notes: string | null }
  | { kind: "installing"; version: string; done: number; total: number | null }
  | { kind: "failed"; why: string };

/** The line under "Updates" for a state, beside this copy's version. */
export function updateLine(state: UpdateState, current: string | null): string {
  const here = current ? `This is version ${current}.` : "";
  switch (state.kind) {
    case "idle":
      return here;
    case "checking":
      return `${here} Checking…`.trim();
    case "current":
      return `${here} It is the newest.`.trim();
    case "ready":
      return `Version ${state.version} is ready. ${here}`.trim();
    case "installing": {
      const part = state.total ? ` ${Math.min(100, Math.round((state.done / state.total) * 100))}%` : "";
      return `Installing version ${state.version}…${part}`;
    }
    case "failed":
      return `Could not update: ${state.why}`;
  }
}

/** The first lines of a release's notes, short enough to read in Settings. */
export function shortNotes(notes: string | null | undefined, max = 280): string | null {
  const text = (notes ?? "").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
