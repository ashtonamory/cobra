/**
 * Words put in Cobra's box from elsewhere, for the person to finish: the Org page's New Space
 * starts the intake this way ("Set up a new Space: "), as the phone's askCobraWith does. Kept
 * outside React so the page that asks and the chat that shows it need not share a parent.
 */
import { useSyncExternalStore } from "react";

export const NEW_SPACE_DRAFT = "Set up a new Space: ";

/** `space`: the Space the box's chip is set to with it (a company id), when the ask names one (lib/crewVisibility.ts). */
export type CobraDraft = { text: string; n: number; space?: string };

let draft: CobraDraft = { text: "", n: 0 };
/** The last ask a box took, so coming back to the page does not put the words in a second time. */
let taken = 0;
const listeners = new Set<() => void>();

/** Ask for `text` in Cobra's box; each ask is a new `n`, so asking twice puts it there twice. */
export function askCobraWith(text: string, space?: string): void {
  draft = { text, n: draft.n + 1, ...(space ? { space } : {}) };
  for (const listener of listeners) listener();
}

/** The words of an ask nobody has taken yet, once: null when there are none or the last one was taken. */
export function takeDraft(): string | null {
  if (draft.n === taken) return null;
  taken = draft.n;
  return draft.text;
}

export function currentDraft(): CobraDraft {
  return draft;
}

export function useCobraDraft(): CobraDraft {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentDraft,
    currentDraft,
  );
}
