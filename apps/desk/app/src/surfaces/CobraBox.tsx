/**
 * The Cobra box — a small floating window to talk to Cobra from anywhere,
 * like Spotlight with a conversation in it: SUPER+SHIFT+J on Omarchy (a
 * Hyprland bind to `cobra-desktop box`), Ctrl+Shift+J (⌘⇧J on a Mac)
 * elsewhere. Her last few messages, the dock that answers her questions, how
 * many things need you with Show (Home), and the box to message her, focused
 * each time it opens. Esc hides it; ⤢ opens Home in the main window.
 *
 * It is Home's pane (components/CobraChat.tsx) on the Lead lib/home.ts picks,
 * from the rows the main window's poller sends it (`fleet-snapshot`, as the
 * picker's); its requests go straight to the agent like any window's.
 */
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as config from "../lib/config.ts";
import * as home from "../lib/home.ts";
import * as model from "../lib/model.ts";
import type { Dict } from "../lib/json.ts";
import { bridge } from "../lib/bridge.ts";
import { onSnapshot, toMain } from "../lib/surfaces.ts";
import * as act from "../lib/windowActions.ts";
import { CobraChat, type CobraEnv } from "../components/CobraChat.tsx";
import "../styles/home.css";
import "../styles/agents.css";
import "../styles/surfaces.css";

/** Her newest rows the box draws: a few, so it stays small. */
const SHOWN = 12;

const NOBODY_AWAY: ReadonlySet<string> = new Set();

const hide = () => void getCurrentWindow().hide().catch(() => {});

export function CobraBoxSurface() {
  const [rows, setRows] = useState<model.Row[]>([]);
  const [approvals, setApprovals] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.body.classList.add("surface-cobra");
    const offs = [
      onSnapshot((snap) => {
        config.setMachines(snap.machines);
        setRows(model.buildRows(snap.polls as unknown as Record<string, Dict>, snap.now));
        setApprovals(Object.values(snap.approvals).reduce((n, list) => n + list.filter((a) => (a.state ?? "pending") === "pending").length, 0));
      }),
      // Shown again by the shortcut: the keyboard in the box.
      listen("box-opened", () => input.current?.focus()),
    ];
    // Made just now: the computers, and a fresh snapshot from the main window's poller.
    bridge.computers().then(config.setMachines).catch(() => {});
    toMain({ kind: "refresh" }).catch(() => {});
    input.current?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("keydown", esc);
      offs.forEach((p) => p.then((f) => f()));
    };
  }, []);

  const lead = home.homeLead(rows, NOBODY_AWAY);
  // What waits on you besides her own question: sessions on a dialog and approvals (Home lists them).
  const waiting = rows.filter((r) => r.state === "needs" && !(lead && r.machine === lead.machine && r.session === lead.session)).length
    + approvals;
  const words = home.alertWords(waiting);
  const openHome = () => {
    void toMain({ kind: "show", page: "ops" }).catch(() => {});
    hide();
  };
  const env: CobraEnv = {
    toast: act.toast,
    refresh: () => void toMain({ kind: "refresh" }).catch(() => {}),
    openChat: (machine, session) => {
      void toMain({ kind: "open-chat", machine, session }).catch(() => {});
      hide();
    },
    away: NOBODY_AWAY,
    rows,
  };

  return (
    <div className="cobra-box">
      <CobraChat lead={lead} env={env} shown={SHOWN} input={input}
        head={<button className="btn icon flat" title="Open Home" aria-label="Open Home" onClick={openHome}>⤢</button>}
        under={words ? (
          <div className="cobra-box-needs">
            <span className="grow">{words}</span>
            <button className="btn small" onClick={openHome}>Show</button>
          </div>
        ) : null} />
    </div>
  );
}
