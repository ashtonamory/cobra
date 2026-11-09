/**
 * All routines of a Space (design docs/cobra-space-screen.tessel.json frame 03), over its screen:
 * each routine with its skill, its rule in words (`when`), its state line, and Run now, Pause or Resume,
 * and Remove behind a confirm, as on the project page (lib/routines.ts; `POST /routines/run|pause|remove`
 * on the routine's own computer). Nothing here writes a schedule: "Ask Cobra to add or change a routine"
 * puts the words in Cobra's box (lib/cobraDraft.ts), and she sends a new one back as a card to allow.
 */
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../app/context.ts";
import * as api from "../lib/api.ts";
import * as config from "../lib/config.ts";
import type { Dict } from "../lib/json.ts";
import { askCobraWith } from "../lib/cobraDraft.ts";
import {
  ROUTINE_ASK, ROUTINE_NOTE, removeAsk, routineCards, routineDraft, routineToast, routinesSubtitle, type RoutineCard,
} from "../lib/spaceScreen.ts";
import type { MachineRoutine, SpaceSeat, SpaceTimeline } from "../../../../../packages/contracts/src/spaceScreen.ts";
import { Button, cls } from "./ui.tsx";
import { Confirm } from "./Verbs.tsx";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Action = "run" | "pause" | "resume" | "remove";

export function AllRoutines({ space, seats, routines, raw, timeline, now, showCrew, machines, onReload, onClose }: {
  space: { id: string; name: string };
  seats: readonly SpaceSeat[];
  routines: readonly MachineRoutine[];
  /** Each routine as its computer sent it, by `<machine>:<id>`, for the project's name in Remove's confirm. */
  raw: ReadonlyMap<string, Dict>;
  timeline: SpaceTimeline;
  now: Date;
  showCrew: boolean;
  machines: readonly string[];
  onReload: () => void;
  onClose: () => void;
}) {
  const app = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<RoutineCard | null>(null);
  const cards = useMemo(() => routineCards(routines, seats, timeline, now), [routines, seats, timeline, now]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !asking && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, asking]);

  const act = (card: RoutineCard, action: Action) => {
    setBusy(`${card.key}:${action}`);
    const sent = action === "run" ? api.routineRun(card.machine, card.id)
      : action === "remove" ? api.routineRemove(card.machine, card.id)
      : api.routinePause(card.machine, card.id, action === "resume");
    sent.then(
      () => app.toast(routineToast(action, card.name, showCrew)),
      (e) => app.toast(`Couldn't ${action} ${card.name}: ${msg(e)}`),
    ).finally(() => {
      setBusy(null);
      onReload();
    });
  };
  const ask = () => {
    const draft = routineDraft(space, showCrew);
    askCobraWith(draft.text, draft.space);
    onClose();
    app.show("ops");
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog routines-dialog" role="dialog" aria-label="Routines" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <div className="grow">
            <h2>Routines</h2>
            <div className="dim">{routinesSubtitle(space.name, cards.length, machines.map((m) => config.label(m)))}</div>
          </div>
          <button className="linkish routines-done" onClick={onClose}>Done</button>
        </div>
        {cards.length === 0 && <p className="dim">No routines in {space.name} yet.</p>}
        {cards.map((card) => {
          const doing = (a: Action) => busy === `${card.key}:${a}`;
          return (
            <div key={card.key} className={cls("routine-card", card.paused && "paused")}>
              <div className="row">
                <b className="grow routine-name">{card.name}</b>
                <span className="dim">{card.skill}</span>
              </div>
              {card.when && <div className="routine-when">{card.when}</div>}
              <div className={cls("routine-state", `rs-${card.tone}`)}>{card.tone === "live" && <span className="routine-live" />}{card.state}</div>
              <div className="row routine-buttons">
                <Button small disabled={busy !== null || card.running} onClick={() => act(card, "run")}>{doing("run") ? "Running…" : "Run now"}</Button>
                <Button kind={card.paused ? "primary" : undefined} small disabled={busy !== null} onClick={() => act(card, card.paused ? "resume" : "pause")}>{card.toggle}</Button>
                <span className="grow" />
                <button className="linkish routine-remove" disabled={busy !== null} onClick={() => setAsking(card)}>{doing("remove") ? "Removing…" : "Remove"}</button>
              </div>
            </div>
          );
        })}
        <button className="routines-ask" onClick={ask}>{ROUTINE_ASK}</button>
        <div className="dim routines-note">{ROUTINE_NOTE}</div>
        {asking && (() => {
          const r = raw.get(asking.key);
          const projectName = (typeof r?.projectName === "string" && r.projectName) || asking.skill;
          const words = removeAsk(asking.name, space.name, showCrew, projectName);
          return <Confirm title={words.title} body={words.body} yes={words.yes} danger onYes={() => act(asking, "remove")} onClose={() => setAsking(null)} />;
        })()}
      </div>
    </div>
  );
}
