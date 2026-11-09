/**
 * The desk's CRM board: a trade's `kanban` view drawn
 * as the whole CRM tab. A toolbar (search, the filter's picks as chips, Filters, ··· More, Add), the band (`band` view: emails a
 * day with replies hatched, the reply rate, and the numbers that filter the board), then a lane a stage. An empty lane is thin
 * and widens while a card is dragged over it; each lane scrolls on its own, the most pressing first. A click opens a card in
 * place (inverted, like the selected tab: where they are, how to reach them, the last of the timeline, Ask Cobra, Next step,
 * Open); a drag to another lane runs the kanban's `move` and offers Undo for five seconds (the journal's /db/undo). Everything
 * it knows of the trade comes from the views (agent viewSpecs/people.ts); the rules are lib/crmBoard.ts.
 */
import { useCallback, useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import * as api from "../lib/api.ts";
import { useApp } from "../app/context.ts";
import { askCobraWith } from "../lib/cobraDraft.ts";
import {
  BAND_RANGE_WORDS, askAbout, bandBars, bandLine, barScale, canDrop, gauge, gaugeTicks, laneCount, lanesWithCards, moveCard, pickChips, pickCount, thinLane, tileOn, tilePick, togglePick,
  type BandBar, type Card, type Lane,
} from "../lib/crmBoard.ts";
import { BAND_RANGES } from "../../../../../packages/contracts/src/views.ts";
import type { BandRange, Cell, FilterPicks, PublicView, ViewAction, ViewList, ViewResult, ViewRow } from "../../../../../packages/contracts/src/views.ts";
import { actionGroups, filterParam, formatCell, localToday, parseViewResult } from "../../../../../packages/contracts/src/viewsRead.ts";
import { cls, useMenu, type MenuItem } from "./ui.tsx";
import "../styles/crm.css";
import { LEAD_NAME } from "../lib/appName.ts";

const REFRESH_MS = 30_000;
const UNDO_MS = 5_000;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const str = (value: Cell | undefined): string => (value === null || value === undefined ? "" : String(value));

type Press = { card: Card; startX: number; startY: number; offX: number; offY: number; w: number };
type Drag = Press & { x: number; y: number };
type Undo = { journal: number | null; words: string; until: number };

export function CrmBoard({ machine, project, list, view, written, space, act, open, askPasscode }: {
  machine: string; project: string; list: ViewList; view: PublicView; written: number; space?: string;
  act: (action: ViewAction, id: string | null) => void;
  open: (view: string, id: string | undefined, title: string) => void;
  askPasscode: (why: string) => Promise<boolean>;
}) {
  const app = useApp();
  const spec = view.kanban!;
  const map = view.row;
  const bandView = spec.band ? list.views.find((v) => v.id === spec.band && v.kind === "band" && v.band) ?? null : null;
  const page = view.opens ? list.views.find((v) => v.id === view.opens) ?? null : null;

  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [picks, setPicks] = useState<FilterPicks>({});
  const [board, setBoard] = useState<ViewResult | { error: string } | null>(null);
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [range, setRange] = useState<BandRange>("week");
  const [band, setBand] = useState<ViewResult | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [press, setPress] = useState<Press | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [menu, openMenu] = useMenu();
  const boardRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<Lane[]>([]);
  lanesRef.current = lanes;
  const round = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const filter = filterParam(picks);
  const readBoard = useCallback(async () => {
    const mine = ++round.current;
    try {
      const read = parseViewResult(await api.view(machine, project, view.id, { ...(q ? { q } : {}), ...(filter ? { filter } : {}) }));
      if (mine !== round.current) return;
      setBoard(read);
      setLanes(lanesWithCards(read.kanban?.lanes ?? [], read.rows ?? [], map));
    } catch (e) {
      if (mine === round.current) setBoard({ error: msg(e) });
    }
  }, [machine, project, view.id, q, filter, map]);

  const readBand = useCallback(async () => {
    if (!bandView) return;
    try {
      setBand(parseViewResult(await api.view(machine, project, bandView.id, { range })));
    } catch {
      setBand(null);
    }
  }, [machine, project, bandView, range]);

  // Read again on a change, after a write elsewhere on the page, and every 30 s while nothing is being dragged.
  useEffect(() => void readBoard(), [readBoard, written]);
  useEffect(() => void readBand(), [readBand, written]);
  const dragging = useRef(false);
  dragging.current = press !== null;
  useEffect(() => {
    const timer = setInterval(() => {
      if (dragging.current) return;
      void readBoard();
      void readBand();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [readBoard, readBand]);

  // Undo's five seconds, counted down on the toast.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!undo) return;
    const timer = setInterval(() => {
      if (Date.now() >= undo.until) setUndo(null);
      else tick((n) => n + 1);
    }, 250);
    return () => clearInterval(timer);
  }, [undo]);

  const ready = board && !("error" in board) ? board : null;
  const narrowed = q !== "" || pickCount(picks) > 0;
  const facets = ready?.kanban?.facets ?? [];
  const chips = pickChips(picks, facets);
  const titleOf = (card: Card) => str(card.row[map?.title ?? ""]);
  const whoOf = (card: Card) => (map?.subtitle ? str(card.row[map.subtitle]) || null : null);

  const drop = useCallback(async (card: Card, to: string) => {
    const move = spec.move;
    const lane = lanesRef.current.find((l) => l.key === to);
    if (!move || !lane) return;
    const ownerOnly = list.mutations[move.mutation]?.personOnly === true;
    if (ownerOnly && !(await askPasscode(`Move ${titleOf(card)}: this is yours to allow`))) return;
    setLanes((now) => moveCard(now, card.id, to));
    try {
      const idValue = Number(card.id);
      const done = (await api.viewWrite(machine, project, move.mutation, { [move.id]: Number.isInteger(idValue) ? idValue : card.id, [move.lane]: to }, ownerOnly)) as { journal?: number } | null;
      setUndo({ journal: typeof done?.journal === "number" ? done.journal : null, words: `${titleOf(card)} moved to ${lane.label} · on the timeline`, until: Date.now() + UNDO_MS });
    } catch (e) {
      app.toast(`Not moved: ${msg(e)}`);
    }
    void readBoard();
  }, [spec.move, list.mutations, askPasscode, machine, project, app, readBoard]); // eslint-disable-line react-hooks/exhaustive-deps

  const putBack = async () => {
    if (!undo?.journal) return;
    const journal = undo.journal;
    setUndo(null);
    try {
      await api.dbUndo(machine, project, journal);
      app.toast("Put back.");
    } catch (e) {
      app.toast(`Could not put it back: ${msg(e)}. Records has Undo for a week.`);
    }
    void readBoard();
    void readBand();
  };

  // A press on a card: a click opens it in place; a drag past 6 px picks it up. The drop is read through a ref, so a
  // render mid-drag (a refresh, a new `drop`) never starts the press over.
  const dropRef = useRef(drop);
  dropRef.current = drop;
  useEffect(() => {
    if (!press) return;
    let moved = false;
    let target: string | null = null;
    const move = (e: PointerEvent) => {
      if (!moved && Math.hypot(e.clientX - press.startX, e.clientY - press.startY) < 6) return;
      moved = true;
      setDrag({ ...press, x: e.clientX, y: e.clientY });
      const key = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-lane]")?.dataset.lane ?? null;
      target = canDrop(press.card.lane, lanesRef.current.find((l) => l.key === key)) ? key : null;
      setOver(target);
      const box = boardRef.current?.getBoundingClientRect();
      if (box && boardRef.current) {
        if (e.clientX > box.right - 56) boardRef.current.scrollLeft += 16;
        else if (e.clientX < box.left + 56) boardRef.current.scrollLeft -= 16;
      }
    };
    const end = (dropIt: boolean) => {
      setPress(null);
      setDrag(null);
      setOver(null);
      if (!moved) return setOpened((cur) => (cur === press.card.id ? null : press.card.id));
      if (dropIt && target) void dropRef.current(press.card, target);
    };
    const up = () => end(true);
    const key = (e: KeyboardEvent) => e.key === "Escape" && ((moved = true), end(false));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
    };
  }, [press]);

  const startPress = (e: ReactPointerEvent<HTMLElement>, card: Card) => {
    if (e.button !== 0 || !spec.move) {
      if (e.button === 0) setOpened((cur) => (cur === card.id ? null : card.id));
      return;
    }
    const box = e.currentTarget.getBoundingClientRect();
    setPress({ card, startX: e.clientX, startY: e.clientY, offX: e.clientX - box.left, offY: e.clientY - box.top, w: box.width });
  };

  const ask = (card: Card) => {
    askCobraWith(askAbout(titleOf(card), whoOf(card)), space);
    app.show("ops");
  };
  const nextSteps = (card: Card): MenuItem[] => {
    const group = spec.next ?? "next";
    const acts = actionGroups(page?.actions)[group];
    return acts.map((a) => ({ label: a.label, onClick: () => act(a, card.id) }));
  };
  const cardMenu = (x: number, y: number, card: Card) => {
    const moves = lanesRef.current.filter((l) => canDrop(card.lane, l)).map((l) => ({ label: `Move to ${l.label}`, onClick: () => void drop(card, l.key) }));
    openMenu(x, y, [
      ...(page ? [{ label: "Open", onClick: () => open(page.id, card.id, titleOf(card)) }] : []),
      { label: `Ask ${LEAD_NAME}`, onClick: () => ask(card) },
      ...(spec.move && moves.length ? [{ label: "", separator: true }, ...moves] : []),
      ...(nextSteps(card).length ? [{ label: "", separator: true }, ...nextSteps(card)] : []),
    ]);
  };
  const moreMenu = (x: number, y: number) => {
    const views = (spec.more ?? []).flatMap((id) => list.views.filter((v) => v.id === id));
    const acts = (view.actions ?? []).filter((a) => a.on === "view");
    openMenu(x, y, [
      ...views.map((v) => ({ label: v.title, onClick: () => open(v.id, undefined, v.title) })),
      ...(acts.length ? [{ label: "", separator: true }, ...acts.map((a) => ({ label: `${a.label}…`, onClick: () => act(a, null) }))] : []),
    ]);
  };

  return (
    <div className="crm">
      <div className="crm-toolbar">
        <label className="crm-search">
          <SearchIcon />
          <input placeholder="Search people, companies, emails…" aria-label="Search people" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        {chips.map((c) => (
          <button key={`${c.facet}:${c.key}`} className="crm-pick" onClick={() => setPicks((p) => togglePick(p, c.facet, c.key))} title="Clear this filter">
            {c.label}<span aria-hidden> ✕</span>
          </button>
        ))}
        <span className="grow" />
        {facets.length > 0 && (
          <button className={cls("crm-tool", filtersOpen && "on")} onClick={(e) => { e.stopPropagation(); setFiltersOpen((o) => !o); }} aria-expanded={filtersOpen}>
            <FilterIcon /> Filters{pickCount(picks) ? ` · ${pickCount(picks)}` : ""}
          </button>
        )}
        <button className="crm-tool" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); moreMenu(r.left, r.bottom + 6); }}>··· More</button>
        {spec.add && <button className="crm-add" onClick={() => act(spec.add!, null)}>+ {spec.add.label}</button>}
        {filtersOpen && <FiltersPop facets={facets} picks={picks} onPick={(f, k) => setPicks((p) => togglePick(p, f, k))} onClear={() => setPicks({})} onClose={() => setFiltersOpen(false)} />}
      </div>

      {bandView && <Band view={bandView} read={band} range={range} onRange={setRange} picks={picks} onTile={(t) => setPicks((p) => tilePick(p, t))} />}

      {!board && <div className="dim">Reading…</div>}
      {board && "error" in board && <div className="dim">Could not read the board: {board.error}</div>}
      {ready && lanes.length === 0 && <div className="dim crm-none">No stages yet. Add one from ··· More.</div>}
      {ready && lanes.length > 0 && (
        <div className="crm-board" ref={boardRef}>
          {lanes.map((lane) => thinLane(lane, over, narrowed) ? (
            <div key={lane.key} className={cls("crm-lane thin", lane.closed && "closed")} data-lane={lane.key} title={`${lane.label}: nobody here yet`}>
              <span className="crm-thin-count">{lane.count}</span>
              <span className="crm-thin-name">{lane.label}</span>
            </div>
          ) : (
            <div key={lane.key} className={cls("crm-lane", over === lane.key && "over", lane.closed && "closed")} data-lane={lane.key}>
              <div className="crm-lane-head">
                <h3>{lane.label}</h3>
                <span className="crm-count">{laneCount(lane, narrowed)}</span>
              </div>
              <div className="crm-cards">
                {over === lane.key && drag && (
                  <div className="crm-drop">
                    <b>Drop to move to {lane.label}</b>
                    <span>A stage line goes on the timeline</span>
                  </div>
                )}
                {lane.cards.length === 0 && over !== lane.key && <div className="dim crm-none">{narrowed ? "None here" : "Nobody here yet"}</div>}
                {lane.cards.map((card) => opened === card.id && !drag ? (
                  <OpenCard key={card.id} machine={machine} project={project} peek={spec.peek} card={card} view={view} chips={spec.chips} askPasscode={askPasscode}
                    onClose={() => setOpened(null)} onAsk={() => ask(card)}
                    onNext={nextSteps(card).length ? (x, y) => openMenu(x, y, nextSteps(card)) : null}
                    onOpen={page ? () => open(page.id, card.id, titleOf(card)) : null}
                    onMenu={(x, y) => cardMenu(x, y, card)} />
                ) : (
                  <div key={card.id} className={cls("crm-card", drag?.card.id === card.id && "lifted", narrowed && pickCount(picks) > 0 && "ringed")}
                    onPointerDown={(e) => startPress(e, card)}
                    onContextMenu={(e) => { e.preventDefault(); cardMenu(e.clientX, e.clientY, card); }}
                    role="button" tabIndex={0} aria-label={titleOf(card)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpened(card.id); } }}>
                    <CardFace card={card} view={view} chips={spec.chips} onMenu={(x, y) => cardMenu(x, y, card)} />
                  </div>
                ))}
                {lane.cards.length > 0 && lane.cards.length < lane.count && !narrowed && lane.cards.length >= 100 && (
                  <div className="dim crm-none">Showing the first {lane.cards.length} of {lane.count}. Search or filter to narrow it.</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {drag && (
        <div className="crm-ghost" style={{ left: drag.x - drag.offX, top: drag.y - drag.offY, width: drag.w }} aria-hidden>
          <div className="crm-card"><CardFace card={drag.card} view={view} chips={spec.chips} /></div>
        </div>
      )}
      {undo && (
        <div className="crm-undo" role="status">
          <span className="grow">{undo.words}</span>
          {undo.journal !== null && <button onClick={() => void putBack()}>Undo</button>}
          <span className="crm-undo-count">{Math.max(1, Math.ceil((undo.until - Date.now()) / 1000))}</span>
        </div>
      )}
      {menu}
    </div>
  );
}

/** A card closed: the company, who, why they fit, then its chips. */
function CardFace({ card, view, chips, onMenu }: { card: Card; view: PublicView; chips?: PublicView["kanban"] extends infer K ? K extends { chips?: infer C } ? C : never : never; onMenu?: (x: number, y: number) => void }) {
  const map = view.row;
  return (
    <>
      <div className="crm-card-top">
        <span className="crm-card-title">{str(card.row[map?.title ?? ""])}</span>
        {onMenu && (
          <button className="crm-dots" aria-label="More for this card" onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onMenu(r.left, r.bottom + 4); }}>···</button>
        )}
      </div>
      {map?.subtitle && str(card.row[map.subtitle]) && <div className="crm-card-who">{str(card.row[map.subtitle])}</div>}
      {map?.detail && str(card.row[map.detail]) && <div className="crm-card-why">{str(card.row[map.detail])}</div>}
      <Chips row={card.row} chips={chips} />
    </>
  );
}

function Chips({ row, chips }: { row: ViewRow; chips?: Array<{ text: string; tone?: string; icon?: "date" }> }) {
  const shown = (chips ?? []).filter((c) => str(row[c.text]));
  if (!shown.length) return null;
  return (
    <div className="crm-chips">
      {shown.map((c) => {
        const tone = c.tone ? str(row[c.tone]) : "";
        return (
          <span key={c.text} className={cls("crm-chip", ["good", "warn", "bad"].includes(tone) && `t-${tone}`)}>
            {c.icon === "date" && <CalendarIcon />}{str(row[c.text])}
          </span>
        );
      })}
    </div>
  );
}

/** A card opened in place: the kanban's `peek` page read with the card's id, and its three buttons. */
function OpenCard({ machine, project, peek, card, view, chips, askPasscode, onClose, onAsk, onNext, onOpen, onMenu }: {
  machine: string; project: string; peek?: string; card: Card; view: PublicView; chips?: Array<{ text: string; tone?: string; icon?: "date" }>;
  askPasscode: (why: string) => Promise<boolean>;
  onClose: () => void; onAsk: () => void; onNext: ((x: number, y: number) => void) | null; onOpen: (() => void) | null; onMenu: (x: number, y: number) => void;
}) {
  const app = useApp();
  const map = view.row;
  const [read, setRead] = useState<ViewResult | null>(null);
  const [shown, setShown] = useState<Record<string, Cell>>({});
  useEffect(() => {
    if (!peek) return;
    let live = true;
    api.view(machine, project, peek, { id: card.id }).then((raw) => live && setRead(parseViewResult(raw)), () => {});
    return () => void (live = false);
  }, [machine, project, peek, card.id]);
  const reveal = async (field: string) => {
    if (!peek || !(await askPasscode("Show a hidden value"))) return;
    try {
      const out = (await api.viewReveal(machine, project, { view: peek, field, block: 0, id: card.id })) as { value?: Cell } | null;
      setShown((s) => ({ ...s, [field]: out?.value ?? null }));
    } catch (e) {
      app.toast(`Could not show it: ${msg(e)}`);
    }
  };
  const blocks = read?.blocks ?? [];
  const fields = blocks.find((b) => b.kind === "fields");
  const timeline = blocks.find((b) => b.kind === "timeline");
  const facts = fields?.rows[0] ?? null;
  const today = localToday();
  const ICONS: Record<string, () => ReactNode> = { place: PinIcon, email: MailIcon, phone: PhoneIcon };
  return (
    <div className="crm-card open" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="crm-card-top">
        <button className="crm-card-title crm-fold" onClick={onClose} title="Close the card">{str(card.row[map?.title ?? ""])}</button>
        <button className="crm-dots" aria-label="More for this card" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onMenu(r.left, r.bottom + 4); }}>···</button>
      </div>
      {map?.subtitle && str(card.row[map.subtitle]) && <div className="crm-card-who">{str(card.row[map.subtitle])}</div>}
      {map?.detail && str(card.row[map.detail]) && <div className="crm-card-why full">{str(card.row[map.detail])}</div>}
      {facts && (
        <div className="crm-facts">
          {Object.entries(facts).map(([name, value]) => {
            const hidden = fields!.masked.includes(name) && !(name in shown);
            const text = name in shown ? str(shown[name]) : str(value);
            if (!hidden && !text) return null;
            const Icon = ICONS[name];
            return (
              <div key={name} className="crm-fact">
                {Icon ? <Icon /> : <span className="crm-fact-name">{name}</span>}
                {hidden ? <button className="crm-show" onClick={() => void reveal(name)}>Hidden · Show</button> : <span className="selectable">{text}</span>}
              </div>
            );
          })}
        </div>
      )}
      {timeline && timeline.rows.length > 0 && (
        <div className="crm-lines">
          {timeline.rows.map((row, i) => (
            <div key={`${str(row[timeline.row?.id ?? "id"])}:${i}`} className="crm-line">
              <span className="crm-line-when">{formatCell(row[timeline.row?.when ?? ""] ?? null, "date", "USD", today)}</span>
              <span className="crm-line-what">{str(row[timeline.row?.title ?? ""])}</span>
            </div>
          ))}
        </div>
      )}
      <Chips row={card.row} chips={chips} />
      <div className="crm-open-buttons">
        <button className="crm-ask" onClick={onAsk}>Ask {LEAD_NAME}</button>
        <div className="crm-open-pair">
          {onNext && <button onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onNext(r.left, r.bottom + 4); }}>Next step</button>}
          {onOpen && <button onClick={onOpen}>Open ›</button>}
        </div>
      </div>
    </div>
  );
}

/** The band: emails a day with replies hatched, the reply rate, and the numbers that filter the board. */
function Band({ view, read, range, onRange, picks, onTile }: {
  view: PublicView; read: ViewResult | null; range: BandRange; onRange: (r: BandRange) => void; picks: FilterPicks;
  onTile: (tile: { facet?: string; key?: string }) => void;
}) {
  const spec = view.band!;
  const span = read?.band ?? null;
  const bars = span ? bandBars(read?.rows ?? [], spec, span) : [];
  const g = gauge(bars, spec.gauge?.caption ?? "");
  return (
    <div className="crm-band">
      <div className="crm-band-chart">
        <div className="crm-band-head">
          <div>
            <div className="crm-band-title">{view.title}</div>
            <div className="dim">{span ? bandLine(bars, spec.solid.label, span) : "Reading…"}</div>
          </div>
          <div className="crm-range" role="tablist" aria-label="Range">
            {BAND_RANGES.map((r) => (
              <button key={r} role="tab" aria-selected={r === range} className={cls(r === range && "on")} onClick={() => onRange(r)}>{BAND_RANGE_WORDS[r]}</button>
            ))}
          </div>
        </div>
        <div className="crm-legend">
          <span><i className="crm-key solid" />{spec.solid.label}</span>
          <span><i className="crm-key hatched" />{spec.hatched.label}</span>
        </div>
        <Bars bars={bars} />
      </div>
      {spec.gauge && (
        <div className="crm-gauge">
          <svg viewBox="-2 -2 184 94" aria-hidden>
            {gaugeTicks(g.rate).map((t, i) => <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} className={cls("crm-tick", t.lit && "lit")} />)}
          </svg>
          <div className="crm-gauge-words">
            <b>{g.rate === null ? "—" : `${Math.round(g.rate * 100)}%`}</b>
            <span>{spec.gauge.label}</span>
            <span className="dim">{g.words}</span>
          </div>
        </div>
      )}
      <div className="crm-tiles">
        {(span?.tiles ?? []).map((t) => {
          const on = tileOn(picks, t);
          const filters = Boolean(t.facet && t.key);
          return (
            <button key={t.label} className={cls("crm-tile", on && "on")} disabled={!filters} onClick={() => onTile(t)}
              title={filters ? (on ? "Show everyone again" : `Show only these on the board`) : undefined}>
              <b className="crm-tile-value">{t.value}</b>
              <span className="crm-tile-label">{t.label}{filters && <span className="crm-arrow" aria-hidden> →</span>}</span>
              {t.caption && <span className={cls("crm-tile-caption", t.tone && `t-${t.tone}`)}>{t.caption}</span>}
              {on && <span className="crm-tile-on">Showing on the board</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The bars, the second series hatched beside the first; values over them when there are few. */
function Bars({ bars }: { bars: readonly BandBar[] }) {
  const id = `hatch${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // Drawn at its own width, so its words are never stretched.
  const ref = useRef<SVGSVGElement>(null);
  const [W, setW] = useState(440);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver(([entry]) => entry && entry.contentRect.width > 0 && setW(Math.round(entry.contentRect.width)));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const H = 130, left = 26, top = 16, bottom = 18;
  const plotW = W - left, plotH = H - top - bottom;
  const { top: max, ticks } = barScale(bars);
  const n = Math.max(1, bars.length);
  const gw = plotW / n;
  const bw = Math.min(22, Math.max(2, gw * 0.36));
  const few = bars.length <= 14;
  const every = few ? 1 : bars.length > 20 ? 5 : 2;
  const y = (v: number) => top + plotH - (plotH * v) / max;
  return (
    <svg ref={ref} className="crm-bars" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Emails and replies by day">
      <defs>
        <pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" className="crm-hatch-line" />
        </pattern>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={W} y1={y(t)} y2={y(t)} className="crm-grid" />
          <text x={left - 6} y={y(t) + 3} className="crm-axis" textAnchor="end">{t}</text>
        </g>
      ))}
      {bars.map((b, i) => {
        const cx = left + gw * i + gw / 2;
        return (
          <g key={i}>
            <title>{`${b.title}: ${b.solid} sent, ${b.hatched} replied`}</title>
            {b.solid > 0 && <rect x={cx - bw - 1} y={y(b.solid)} width={bw} height={plotH + top - y(b.solid)} rx="2" className="crm-bar" />}
            {b.hatched > 0 && <rect x={cx + 1} y={y(b.hatched)} width={bw} height={plotH + top - y(b.hatched)} rx="2" fill={`url(#${id})`} className="crm-bar-hatched" />}
            {few && b.solid > 0 && <text x={cx - bw / 2 - 1} y={y(b.solid) - 4} className="crm-value" textAnchor="middle">{b.solid}</text>}
            {few && b.hatched > 0 && <text x={cx + bw / 2 + 1} y={y(b.hatched) - 4} className="crm-value good" textAnchor="middle">{b.hatched}</text>}
            {i % every === 0 && <text x={cx} y={H - 4} className="crm-axis" textAnchor="middle">{b.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}

/** Filters: each group's options with how many are in each; picks apply as they are ticked. */
function FiltersPop({ facets, picks, onPick, onClear, onClose }: {
  facets: ReadonlyArray<{ id: string; label: string; options: Array<{ key: string; label: string; count: number }> }>;
  picks: FilterPicks; onPick: (facet: string, key: string) => void; onClear: () => void; onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const armed = setTimeout(() => window.addEventListener("click", close), 0);
    window.addEventListener("keydown", key);
    return () => {
      clearTimeout(armed);
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <div className="crm-filters" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Filters">
      {facets.map((f, i) => (
        <div key={f.id} className="crm-filter-group">
          <div className="caps">{f.label}</div>
          {f.options.length === 0 && <div className="dim">Nothing to filter by yet</div>}
          {i < 2 ? f.options.map((o) => (
            <label key={o.key} className="crm-check">
              <input type="checkbox" checked={(picks[f.id] ?? []).includes(o.key)} onChange={() => onPick(f.id, o.key)} />
              <span className="grow">{o.label}</span>
              <span className="dim">{o.count}</span>
            </label>
          )) : (
            <div className="crm-pills">
              {f.options.map((o) => (
                <button key={o.key} className={cls("crm-pill", (picks[f.id] ?? []).includes(o.key) && "on")} onClick={() => onPick(f.id, o.key)}>{o.label}</button>
              ))}
            </div>
          )}
        </div>
      ))}
      <div className="crm-filter-foot">
        <button className="crm-link" onClick={onClear}>Clear all</button>
        <span className="dim">Filters apply as you tick them</span>
      </div>
    </div>
  );
}

const SearchIcon = () => <svg className="crm-icon" viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="5.5" /><path d="M11 11 L15 15" /></svg>;
const FilterIcon = () => <svg className="crm-icon" viewBox="0 0 16 14" aria-hidden><path d="M1 3 H15 M1 7 H15 M1 11 H15" /><circle cx="5" cy="3" r="1.6" /><circle cx="11" cy="7" r="1.6" /><circle cx="7" cy="11" r="1.6" /></svg>;
const CalendarIcon = () => <svg className="crm-icon small" viewBox="0 0 12 12" aria-hidden><path d="M1 3 H11 V11 H1 Z M1 5.5 H11 M4 1 V3.5 M8 1 V3.5" /></svg>;
const PinIcon = () => <svg className="crm-icon" viewBox="0 0 12 15" aria-hidden><path d="M6 1 C3.2 1 1 3.2 1 6 C1 9.5 6 14 6 14 C6 14 11 9.5 11 6 C11 3.2 8.8 1 6 1 Z" /><circle cx="6" cy="6" r="1.7" /></svg>;
const MailIcon = () => <svg className="crm-icon" viewBox="0 0 14 11" aria-hidden><path d="M1 1 H13 V10 H1 Z M1 1 L7 6 L13 1" /></svg>;
const PhoneIcon = () => <svg className="crm-icon" viewBox="0 0 10 14" aria-hidden><path d="M2.5 1 H7.5 Q9 1 9 2.5 V11.5 Q9 13 7.5 13 H2.5 Q1 13 1 11.5 V2.5 Q1 1 2.5 1 Z M4 11 H6" /></svg>;
