/**
 * Ctrl+Shift+Space (⌘⇧Space on a Mac) — the agents first (the Lead, Foremen,
 * Workers), then every project on every machine; type to filter, Enter for its
 * chat. Its own small window over everything (the
 * desk's ui/picker.py, a layer-shell overlay there). It owns no polling: rows
 * come from the main window's Fleet as `fleet-snapshot` events, so it opens
 * with nothing to wait for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as config from "../lib/config.ts";
import * as model from "../lib/model.ts";
import type { Dict } from "../lib/json.ts";
import { bridge } from "../lib/bridge.ts";
import { onSnapshot, toMain } from "../lib/surfaces.ts";
import { countText, lineName, lineWord, nextMachine, STATE_TONE } from "../lib/pickerRows.ts";
import { isCrew, useShowCrew } from "../lib/crewVisibility.ts";
import { Chip, cls, Pill } from "../components/ui.tsx";
import "../styles/surfaces.css";

export function PickerSurface() {
  const [all, setAll] = useState<model.Row[]>([]);
  const [text, setText] = useState("");
  const [at, setAt] = useState(0);
  const entry = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // The selected row, so a new snapshot keeps it selected (render(keep=True)).
  const selected = useRef<model.Row | null>(null);

  // With the crew hidden (lib/crewVisibility.ts) no Foreman or Worker is listed by name.
  const showCrew = useShowCrew();
  const grouped = useMemo(() => model.pickerGroups(showCrew ? all : all.filter((r) => !isCrew(r)), text), [all, text, showCrew]);
  const rows = useMemo(() => grouped.map(([, r]) => r), [grouped]);

  useEffect(() => {
    document.body.classList.add("surface-picker");
    const offs = [
      onSnapshot((snap) => {
        config.setMachines(snap.machines);
        setAll(model.buildRows(snap.polls as unknown as Record<string, Dict>, snap.now));
      }),
      // Shown again by the shortcut: an empty search, the first row, the keyboard in the box.
      listen("picker-opened", () => {
        setText("");
        setAt(0);
        selected.current = null;
        entry.current?.focus();
      }),
    ];
    // Made just now: the computers, and a fresh snapshot from the main window's poller.
    bridge.computers().then(config.setMachines).catch(() => {});
    toMain({ kind: "refresh" }).catch(() => {});
    entry.current?.focus();
    return () => offs.forEach((p) => p.then((f) => f()));
  }, []);

  // New rows keep the selection on the same session; a new search starts at the top.
  useEffect(() => {
    const cur = selected.current;
    const i = cur ? rows.findIndex((r) => r.machine === cur.machine && r.session === cur.session) : -1;
    setAt(i >= 0 ? i : 0);
  }, [rows]);
  useEffect(() => {
    selected.current = rows[at] ?? null;
    list.current?.querySelector(".picker-row.sel")?.scrollIntoView({ block: "nearest" });
  }, [rows, at]);

  const launch = useCallback(async (index = at) => {
    const r = rows[index];
    if (!r) return;
    await getCurrentWindow().hide();
    await toMain({ kind: "open-chat", machine: r.machine, session: r.session });
  }, [rows, at]);

  const move = (delta: number) => {
    if (rows.length) setAt((i) => Math.max(0, Math.min(rows.length - 1, i + delta)));
  };

  const onKey = (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    let done = true;
    if (e.key === "Escape") getCurrentWindow().hide();
    else if (e.key === "ArrowDown" || (ctrl && e.key === "n")) move(1);
    else if (e.key === "ArrowUp" || (ctrl && e.key === "p")) move(-1);
    else if (e.key === "Tab") {
      if (rows[at]) setAt(nextMachine(rows, at));
    } else if (e.key === "Enter") launch();
    else done = false;
    if (done) e.preventDefault();
  };

  let group: string | null = null;
  return (
    <div className="picker" onKeyDownCapture={onKey}>
      <div className="picker-head" data-tauri-drag-region>
        <span className="dim" data-tauri-drag-region>›</span>
        <input
          ref={entry}
          className="picker-entry"
          placeholder="agent, project or machine"
          value={text}
          autoFocus
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            selected.current = null;
          }}
        />
        <span className="dim" data-tauri-drag-region>{countText(grouped, all.length, text)}</span>
      </div>
      <div className="picker-list" ref={list}>
        {grouped.map(([g, r], i) => {
          const head = g !== group;
          group = g;
          const branch = String((r.project?.git as Dict | undefined)?.branch ?? "");
          return (
            <div key={`${r.machine}:${r.id}:${i}`}>
              {head && <div className="picker-group">{g.toUpperCase()}</div>}
              <div
                className={cls("picker-row", i === at && "sel")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setAt(i);
                  launch(i);
                }}
              >
                <Chip machine={r.machine} />
                <span className="grow ellipsis">{lineName(r)}</span>
                {branch && <span className="dim ellipsis picker-branch">{branch}</span>}
                <Pill text={lineWord(r)} tone={STATE_TONE[r.state] ?? "idle"} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="picker-foot" data-tauri-drag-region>
        <span>Enter  chat</span>
        <span>Tab  next machine</span>
        <span>Esc  close</span>
      </div>
    </div>
  );
}
