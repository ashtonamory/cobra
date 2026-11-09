/**
 * A Space's own screen on the desk (design docs/cobra-space-screen.tessel.json, desk frame 05; a quiet
 * Space, frame 04): a header with the Space's mark, what it is, Ask Cobra about it and Manage… (rename,
 * Sensitive, close), then three columns. The first is what needs you in the Space (`NeedsCard` as a card,
 * Allow and Deny on a permission prompt, Answer for the rest), then Today, its routines' runs on a
 * timeline with All routines (components/AllRoutines.tsx); the second each skill's first dashboard tile,
 * which opens its dashboard, then the trades' rows to do (contracts views.ts `today`, merged by
 * spaceToday.ts); the third Activity, today's history and What Cobra did there, with See all on Today.
 * What the timeline, the card lines and Activity are is shared with the phone (contracts
 * spaceScreen.ts); how the desk words and draws them is lib/spaceScreen.ts. With Show the crew on, a Crew
 * section follows with each Foreman (name, sprite, computer, its tiles, Open, its card on a right-click)
 * and Hire. Opened from the Org chart (pages/Org.tsx) with one click on a Space.
 *
 * Board tabs: Overview is all of the above; each trade that draws charts
 * gets its own tab named by the Space's kind (CRM, Finance), which is that seat's whole dashboard
 * with its charts; then the boards Cobra made (components/CobraBoard.tsx, a blue dot), read from
 * any one seat since they read the Space's one store; + puts "Make a board…" in Cobra's box with the
 * Space's chip set.
 */
import { useEffect, useMemo, useState } from "react";
import { useApp, useFleet } from "../app/context.ts";
import * as api from "../lib/api.ts";
import * as config from "../lib/config.ts";
import * as crewLib from "../lib/crew.ts";
import type { Seat } from "../lib/org.ts";
import { seatRole, spaceLine, statusWords, type ChartSpace } from "../lib/orgChart.ts";
import { emptySpaceWords, skillTiles } from "../lib/crewVisibility.ts";
import {
  askWords, dashTiles, foremenLine, headLine, historyDone, needsContext, quietToday, routinesIn, seatMachines, spaceLetter, spaceSeats, timelineView, todayFoot,
} from "../lib/spaceScreen.ts";
import { todayItems, type TodayPart } from "../../../../../packages/contracts/src/spaceToday.ts";
import { MAX_SPACE_FOREMEN } from "../../../../../packages/contracts/src/spaces.ts";
import { spaceActivity, spaceTimeline } from "../../../../../packages/contracts/src/spaceScreen.ts";
import { chartViews, formatCell, localToday, parseViewList, parseViewResult, summaryView, tabViews, todayViews } from "../../../../../packages/contracts/src/viewsRead.ts";
import { BOARD_DRAFT, boardTabs, kindOfWords, parseBoardList, type BoardList } from "../../../../../packages/contracts/src/boards.ts";
import { CobraBoard } from "./CobraBoard.tsx";
import { EmailEditorDialog } from "./EmailEditor.tsx";
import { askCobraWith } from "../lib/cobraDraft.ts";
import type { Cell, ColumnFormat, ViewList, ViewResult } from "../../../../../packages/contracts/src/views.ts";
import { Button, cls } from "./ui.tsx";
import { NeedsCard } from "./NeedsCard.tsx";
import { SpriteFor } from "./Sprite.tsx";
import { Dashboard, Tiles, plainCtx } from "./Dashboard.tsx";
import { AllRoutines } from "./AllRoutines.tsx";
import { useDecidedOn, useNow, useRoutines } from "./useSpaceData.ts";
import "../styles/dashboard.css";
import { LEAD_NAME } from "../lib/appName.ts";

/** How often a Space's views are read again while its page is shown. */
const REFRESH_MS = 30_000;

type Read = { list: ViewList; tiles: ViewResult | null; today: Array<{ view: ViewList["views"][number]; result: ViewResult }> };

/** What each of the Space's Foremen's trades shows, by seat; a Foreman with no views is simply absent. */
function useSpaceViews(seats: readonly Seat[]): Map<string, Read> {
  const [reads, setReads] = useState<Map<string, Read>>(new Map());
  const signature = seats.map((s) => `${s.key}:${s.state === "away" ? "away" : "up"}`).join("|");
  useEffect(() => {
    let live = true;
    const read = async () => {
      const next = new Map<string, Read>();
      // A seat's dashboards belong to its trade's records, so they are there whether or not its Foreman is running.
      await Promise.all(seats.filter((s) => s.state !== "away").map(async (seat) => {
        try {
          const list = parseViewList(await api.views(seat.machine, seat.project));
          if (tabViews(list).length === 0 && chartViews(list).length === 0) return;
          const tilesView = summaryView(list);
          const tiles = tilesView ? parseViewResult(await api.view(seat.machine, seat.project, tilesView.id).catch(() => null)) : null;
          const today = (await Promise.all(todayViews(list).map(async (view) => {
            const raw = await api.view(seat.machine, seat.project, view.id).catch(() => null);
            return raw ? { view, result: parseViewResult(raw) } : null;
          }))).filter((x): x is { view: ViewList["views"][number]; result: ViewResult } => x !== null);
          next.set(seat.key, { list, tiles, today });
        } catch {
          // A Foreman whose agent does not answer shows its card and nothing more.
        }
      }));
      if (live) setReads(next);
    };
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  return reads;
}

/** The boards Cobra made for the Space, read from one of its seats (they share the Space's store), again after one is removed. */
function useCobraBoards(seat: Seat | null): { list: BoardList | null; reload: () => void } {
  const [list, setList] = useState<BoardList | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!seat) return setList(null);
    let live = true;
    const read = () => api.boards(seat.machine, seat.project).then((raw) => live && setList(parseBoardList(raw)), () => {});
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [seat?.key, round]); // eslint-disable-line react-hooks/exhaustive-deps
  return { list, reload: () => setRound((n) => n + 1) };
}

const STATE_WORDS: Record<string, string> = { needs: "Needs you", working: "Working", away: "Away", idle: "Idle" };

/**
 * How the Space's Foremen work (agent spaceForemen.ts, onCall.ts), read once from its computers in turn:
 * only the one that runs the Space has it open, the others answer 404. Read only while the crew shows.
 */
function useForemenLine(space: string | null, machines: readonly string[], on: boolean): string | null {
  const [line, setLine] = useState<string | null>(null);
  const key = machines.join("|");
  useEffect(() => {
    if (!on || !space) return;
    let live = true;
    void (async () => {
      for (const machine of machines) {
        const found = foremenLine(await api.get(machine, `/spaces/${api.q(space)}/foremen`).catch(() => null));
        if (found) return void (live && setLine(found));
      }
    })();
    return () => {
      live = false;
    };
  }, [space, key, on]); // eslint-disable-line react-hooks/exhaustive-deps
  return line;
}

/** `showCrew` off (lib/crewVisibility.ts): skills only, with no Foreman's name, sprite or computer, and no Hire;
 * a Space with nothing in it asks you to ask Cobra (`onAsk`, her box with the Space chip set). */
export function SpaceScreen({ space, showCrew = true, onBack, onManage, onHire, onPeek, onAsk }: {
  space: ChartSpace; showCrew?: boolean; onBack: () => void; onManage: () => void; onHire: () => void; onPeek: (seat: Seat) => void; onAsk?: () => void;
}) {
  const app = useApp();
  const fleet = useFleet();
  const now = useNow();
  // The branded email editor (phase 6) opens on one of the Space's seats that is up: they share the Space's email folder.
  const [emailOpen, setEmailOpen] = useState(false);
  const emailSeat = space.id ? (space.seats.find((seat) => seat.state !== "away") ?? null) : null;
  const reads = useSpaceViews(space.seats);
  const tiles = useMemo(() => skillTiles(space.seats), [space.seats]);
  const skillOf = (seat: Seat) => tiles.find((t) => t.seat.key === seat.key)?.skill ?? seatRole(seat, space.name);
  const roleOf = (seat: Seat) => (showCrew ? seatRole(seat, space.name) : skillOf(seat));
  const seats = useMemo(() => spaceSeats(space.seats), [space.seats]);
  const machines = useMemo(() => seatMachines([space]), [space]);
  const routines = useRoutines(machines);
  const foremen = useForemenLine(space.id, machines, showCrew);
  const decided = useDecidedOn(machines);
  const mine = useMemo(() => routinesIn(routines.routines, seats), [routines.routines, seats]);
  const timeline = useMemo(() => spaceTimeline(mine, seats, now), [mine, seats, now]);
  const activity = useMemo(() => spaceActivity(historyDone(fleet.orchHistory), decided, seats, now), [fleet.orchHistory, decided, seats, now]);
  const [allRoutines, setAllRoutines] = useState(false);
  const [tabId, setTabId] = useState("overview");
  const storeSeat = space.seats.find((seat) => reads.has(seat.key)) ?? null;
  const cobra = useCobraBoards(storeSeat);
  const tabs = useMemo(() => boardTabs(
    kindOfWords(space.kindWords),
    space.seats.flatMap((seat) => {
      const read = reads.get(seat.key);
      return read ? [{ key: seat.key, trade: seat.trade, skill: skillOf(seat), charts: chartViews(read.list).length > 0 }] : [];
    }),
    cobra.list?.boards ?? [],
  ), [reads, space.seats, space.kindWords, tiles, cobra.list]); // eslint-disable-line react-hooks/exhaustive-deps
  // A tab whose seat went away falls back to Overview.
  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0]!;
  const boardSeat = tab.by === "trade" ? space.seats.find((seat) => seat.key === tab.seat) ?? null : null;
  const madeBoard = tab.by === "cobra" ? cobra.list?.boards.find((b) => b.id === tab.board) ?? null : null;
  const askBoard = () => {
    askCobraWith(BOARD_DRAFT, space.id ?? undefined);
    app.show("ops");
  };

  const todo = useMemo(() => {
    const parts: TodayPart[] = [];
    for (const seat of space.seats) {
      const read = reads.get(seat.key);
      if (!read) continue;
      for (const { view, result } of read.today) parts.push({ machine: seat.machine, project: seat.project, role: roleOf(seat), view, result, currency: read.list.currency });
    }
    return todayItems(parts, localToday());
  }, [reads, space.seats, space.name, showCrew, tiles]); // eslint-disable-line react-hooks/exhaustive-deps
  const dashboards = useMemo(() => {
    const summaries = new Map(space.seats.map((seat) => [seat.key, reads.get(seat.key)?.tiles ?? null]));
    return dashTiles(space.seats, summaries, (seat) => STATE_WORDS[seat.state] ?? "");
  }, [reads, space.seats]);
  const currencyOf = (key: string) => reads.get(key)?.list.currency ?? "USD";

  const isSpace = space.kindWords !== null;
  const needing = space.seats.filter((seat) => seat.state === "needs" && seat.needing);
  const quiet = quietToday(timeline, now);
  const foot = todayFoot(timeline, now);
  const today = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="space-screen">
      <div className="space-head" style={{ ["--space" as string]: space.color }}>
        <button className="linkish space-back" onClick={onBack}>‹ Org</button>
        <span className="space-mark" aria-hidden>{spaceLetter(space.name)}</span>
        <h2 className="space-title">{space.name}</h2>
        <span className="dim grow space-headline">{showCrew ? [headLine(space, config.label), spaceLine(space)].join(" · ") : headLine(space, config.label)}</span>
        {onAsk && <button className="space-ask" onClick={onAsk}>{askWords(space.name)}</button>}
        {emailSeat && <button className="linkish space-manage" onClick={() => setEmailOpen(true)}>Email…</button>}
        <button className="linkish space-manage" onClick={onManage}>Manage…</button>
      </div>
      {emailOpen && emailSeat && <EmailEditorDialog machine={emailSeat.machine} project={emailSeat.project} onClose={() => setEmailOpen(false)} />}

      {space.id ? (
        <div className="space-tabs" role="tablist" aria-label="Boards">
          {tabs.map((t) => (t.by === "add"
            ? <button key={t.id} className="space-tab add" onClick={askBoard} title={`Ask ${LEAD_NAME} for a board`} aria-label={`Ask ${LEAD_NAME} for a board`}>+</button>
            : (
              <button key={t.id} role="tab" aria-selected={t.id === tab.id} className={cls("space-tab", t.id === tab.id && "on")} onClick={() => setTabId(t.id)}>
                {t.label}
                {t.by === "cobra" && <span className="space-tab-dot" title={`Made by ${LEAD_NAME}`} />}
              </button>
            )))}
        </div>
      ) : null}

      {boardSeat ? (
        <div className="space-board">
          <Dashboard key={boardSeat.key} machine={boardSeat.machine} project={boardSeat.project} space={space.id ?? undefined} />
        </div>
      ) : madeBoard && storeSeat && cobra.list ? (
        <div className="space-board">
          <CobraBoard key={madeBoard.id} machine={storeSeat.machine} project={storeSeat.project} board={madeBoard} currency={cobra.list.currency}
            space={space.id} onRemoved={() => { setTabId("overview"); cobra.reload(); }} />
        </div>
      ) : (<>
      <div className="space-cols">
        <section className="space-col">
          {needing.length > 0 && (
            <>
              <div className="caps space-label signal">Needs you · {needing.length}</div>
              {needing.map((seat) => (
                <NeedsCard key={`needs-${seat.key}`} seat={seat} role={seatRole(seat, space.name)}
                  context={needsContext(showCrew ? `${seat.name} · ${seatRole(seat, space.name)}` : skillOf(seat), seat, timeline)} />
              ))}
            </>
          )}
          <div className="space-label row"><span className="caps grow">Today</span><span className="dim">{today}</span></div>
          <div className="space-card">
            {timeline.rows.length === 0 ? (
              <div className="tl-quiet">
                <div className="tl-quiet-title">{quiet.title}</div>
                {quiet.next && <div className="dim">{quiet.next}</div>}
              </div>
            ) : (
              <ol className="tl">
                {timeline.rows.map((row) => {
                  const v = timelineView(row);
                  return (
                    <li key={v.key} className={cls("tl-row", `tl-${v.dot}`)}>
                      <span className="tl-dot" />
                      <span className="tl-time mono">{v.time}</span>
                      <span className="tl-main">
                        <span className="tl-name">{v.name}</span>
                        <span className={cls("tl-sub", v.subSignal && "signal")}>{v.sub}</span>
                      </span>
                      <span className="tl-result">{v.result}</span>
                    </li>
                  );
                })}
              </ol>
            )}
            <div className="space-card-foot">
              <span className="dim grow">{foot}</span>
              <button className="linkish" onClick={() => setAllRoutines(true)}>All routines ▸</button>
            </div>
          </div>
        </section>

        <section className="space-col">
          <div className="caps space-label">Dashboards</div>
          {space.seats.length === 0 ? (showCrew
            ? <p className="dim">Nobody works in {space.name} yet. Hire a Foreman, or ask {LEAD_NAME} to.</p>
            : (
              <div className="space-card space-empty">
                <p className="dim">{emptySpaceWords(space.name)}</p>
                {onAsk && <Button kind="primary" small onClick={onAsk}>Ask {LEAD_NAME}</Button>}
              </div>
            )) : (
            <div className="space-dashes">
              {dashboards.map((d) => (
                <button key={d.key} className="space-dash" onClick={() => app.openProject(d.machine, d.project)} aria-label={`${d.title}: open its dashboard`}>
                  <span className="space-dash-title"><span className="grow">{d.title}</span><span className="dim">›</span></span>
                  {d.value && <span className="space-dash-value">{formatCell(d.value.value as Cell, (d.value.format ?? undefined) as ColumnFormat | undefined, currencyOf(d.key), localToday()) || "0"}</span>}
                  {(d.caption || d.alert) && (
                    <span className="space-dash-caption">
                      {d.caption}
                      {d.caption && d.alert && " · "}
                      {d.alert && <span className={cls(d.alertTone === "bad" ? "bad" : "signal")}>{d.alert}</span>}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          {todo.items.length > 0 && (
            <>
              <div className="caps space-label">To do</div>
              <div className="dash-rows">
                {todo.items.map((item, i) => (
                  <div key={`${item.project}:${i}`} className={cls("dash-row", item.tone && `t-${item.tone}`)}>
                    <div className="dash-row-main click" onClick={() => app.openProject(item.machine, item.project)} title={`Open ${item.role}`}>
                      <div className="grow">
                        <div className="dash-row-title">{item.title}</div>
                        {item.subtitle && <div className="dim">{item.subtitle}</div>}
                      </div>
                      <span className="dash-badge">{item.badge || item.role}</span>
                      {item.trailing && <span className="dim">{item.trailing}</span>}
                    </div>
                  </div>
                ))}
                {todo.more > 0 && <div className="dim dash-empty">+{todo.more} more</div>}
              </div>
            </>
          )}
        </section>

        <section className="space-col">
          <div className="caps space-label">Activity</div>
          <div className="space-card">
            {activity.items.length === 0 ? <p className="dim space-act-empty">Nothing happened here yet today.</p> : (
              <ul className="space-acts">
                {activity.items.map((item, i) => (
                  <li key={`${item.at}:${i}`} className={cls("space-act", `t-${item.tone}`)}>
                    <span className="space-act-dot" />
                    <span className="grow">
                      <span className="space-act-title">{item.title}</span>
                      <span className="dim">{item.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="space-card-foot">
              <span className="dim grow">{activity.more > 0 ? `${activity.more} more today` : ""}</span>
              <button className="linkish" onClick={() => app.show("ops")}>See all on Today ▸</button>
            </div>
          </div>
        </section>
      </div>

      {showCrew && (
        <section className="space-crew">
          <div className="space-label row">
            <span className="caps grow">Crew</span>
            <Button kind="primary" small onClick={onHire}>Hire a Foreman</Button>
          </div>
          {isSpace && (
            <p className="dim space-cap">
              {space.seats.length} of {MAX_SPACE_FOREMEN} Foremen. {LEAD_NAME} hires without asking up to {MAX_SPACE_FOREMEN}, then asks you first.
            </p>
          )}
          {isSpace && foremen && <p className="dim space-cap">{foremen}</p>}
          <div className="space-foremen">
            {space.seats.map((seat) => {
              const read = reads.get(seat.key);
              return (
                <div key={seat.key} className={cls("space-foreman", seat.state === "needs" && "needs")} onContextMenu={(e) => { e.preventDefault(); onPeek(seat); }}>
                  <div className="space-foreman-head">
                    <SpriteFor project={seat.repo} state={crewLib.spriteState(seat.state === "away" ? "idle" : seat.state, seat.state !== "away")} size={34} animate={seat.state === "needs"} />
                    <div className="grow">
                      <b>{seatRole(seat, space.name)}</b>
                      <div className="dim"><span className={cls("org-state", `st-${seat.state}`)} /> {seat.name} · {statusWords(seat)} · {config.label(seat.machine)}</div>
                    </div>
                    <Button small onClick={() => app.openProject(seat.machine, seat.project)}>Open</Button>
                  </div>
                  {read?.tiles?.tiles && <Tiles result={read.tiles} ctx={plainCtx(read.list.currency)} />}
                </div>
              );
            })}
          </div>
        </section>
      )}
      </>)}

      {allRoutines && space.id && (
        <AllRoutines space={{ id: space.id, name: space.name }} seats={seats} routines={mine} raw={routines.raw} timeline={timeline} now={now}
          showCrew={showCrew} machines={machines} onReload={routines.reload} onClose={() => setAllRoutines(false)} />
      )}
    </div>
  );
}
