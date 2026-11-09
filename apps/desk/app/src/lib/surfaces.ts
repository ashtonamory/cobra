/**
 * How the windows talk. The main window owns the poller; the Lead's popup, the
 * picker and the Lead box are their own windows, sent what they show as events and
 * sending back what you pressed.
 */
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Dict } from "./json.ts";
import type { Snapshot } from "./fleet.ts";

/** One card in the popup column (the desk's ui/popup.py). */
export interface PopupCard {
  key: string;
  kind: "needs" | "approval";
  machine: string;
  /** needs: the project as /projects gave it, so the popup can rebuild its Row. */
  project?: Dict;
  approval?: Dict;
  alert?: Dict;
  /** needs: who asks with the crew hidden, the Space and skill or Cobra (lib/crewVisibility.ts whoWords). */
  who?: string;
  /** When it first came (seconds). */
  at: number;
}

export type ToMain =
  | { kind: "refresh" }
  | { kind: "open-chat"; machine: string; session: string }
  | { kind: "show"; page: string }
  | { kind: "toast"; text: string };

export const toPopup = {
  add: (card: PopupCard) => emitTo("popup", "popup-add", card),
  remove: (key: string) => emitTo("popup", "popup-remove", key),
};

export const sendSnapshot = (snap: Snapshot) =>
  Promise.all(["picker", "popup", "box"].map((w) => emitTo(w, "fleet-snapshot", snap)));

export const toMain = (m: ToMain) => emitTo("main", "to-main", m);

export function onToMain(fn: (m: ToMain) => void): Promise<UnlistenFn> {
  return listen<ToMain>("to-main", (e) => fn(e.payload));
}

export function onSnapshot(fn: (s: Snapshot) => void): Promise<UnlistenFn> {
  return listen<Snapshot>("fleet-snapshot", (e) => fn(e.payload));
}
