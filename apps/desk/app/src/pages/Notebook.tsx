/**
 * Notebook: Cobra's
 * memory notes read as an executive assistant's daybook. A rail (search, company filter, the
 * month's spines, bound volumes, the company binder, this book's flags) beside the open
 * two-page spread on cream ruled paper. Every computer serves its own notes (agent
 * notebook.ts); they are merged here (lib/notebook.ts, a port of contracts notebook.ts).
 * ← → turn the pages, Esc closes a search. Flags stay on this desk (v1).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api.ts";
import * as config from "../lib/config.ts";
import { useApp } from "../app/context.ts";
import { askCobraWith } from "../lib/cobraDraft.ts";
import { cls } from "../components/ui.tsx";
import {
  dayShort,
  dayTitle,
  hourTitle,
  matchParts,
  mergeBrains,
  mergeDay,
  mergeHits,
  mergeShelf,
  mergeVolume,
  pagesText,
  placeTitle,
  roughMeasure,
  sheetFor,
  threadKey,
  volumeTitle,
  SEARCH_MIN_CHARS,
  type NotebookBrain,
  type NotebookBrains,
  type NotebookCompany,
  type NotebookDayPart,
  type NotebookHit,
  type NotebookHits,
  type NotebookPage,
  type NotebookShelfPart,
  type NotebookThread,
  type NotebookVolumePart,
  type PageRow,
  type Sheet,
  type Shelf,
} from "../lib/notebook.ts";
import {
  brainPage,
  companyTone,
  FIRST_RULE,
  loadFlags,
  paginateBook,
  monthGrid,
  monthTitle,
  RULE,
  rowsFor,
  saveFlags,
  sheetAnchor,
  sheetLabel,
  shiftMonth,
  spineWidth,
  TEXT_LEFT,
  TEXT_RIGHT,
  toggleFlag,
  volumePage,
  type Flags,
  type TabColour,
} from "../lib/notebookDesk.ts";
import "../styles/notebook.css";
import { LEAD_NAME } from "../lib/appName.ts";

type Book = { kind: "day"; day: string } | { kind: "volume"; id: string } | { kind: "binder"; company: string | null };
type Loaded = { pages: NotebookPage[]; hoursKept: boolean; brains?: NotebookBrain[]; missing?: boolean };
type Menu = { x: number; y: number; text: string; anchor: string; where: string };

const TURN_MS = 520;
const BODY_FONT = "15px Lora";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Asks every computer that is awake; a refusal or a computer with nothing (404) is left out. */
async function everyComputer<T>(awake: (m: config.Machine) => boolean, ask: (m: config.Machine) => Promise<unknown>): Promise<T[]> {
  const settled = await Promise.allSettled(config.MACHINES.filter(awake).map((m) => ask(m)));
  return settled.flatMap((r) => (r.status === "fulfilled" && r.value && typeof r.value === "object" ? [r.value as T] : []));
}

/** The real Lora's widths once it has loaded (a canvas measure); the rough one until then. */
function useMeasure(): (s: string) => number {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    document.fonts?.load(BODY_FONT).then(() => live && setReady(true), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  return useMemo(() => {
    const ctx = ready ? document.createElement("canvas").getContext("2d") : null;
    if (!ctx) return roughMeasure(15);
    ctx.font = BODY_FONT;
    // A pixel to spare per line, so a line the canvas says fits never wraps in the page.
    return (s: string) => ctx.measureText(s).width + 1;
  }, [ready]);
}

function useSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 900, h: 760 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export function NotebookPage() {
  const app = useApp();
  // The agent on this computer, on loopback: always asked.
  const awake = useCallback((m: config.Machine) => m.local, []);
  const awakeKey = config.MACHINES.filter(awake).map((m) => m.machine).join(",");

  const [month, setMonth] = useState<string | null>(null);
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [company, setCompany] = useState<string | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [index, setIndex] = useState(0);
  const [turn, setTurn] = useState<{ dir: 1 | -1; from: number } | null>(null);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [flags, setFlags] = useState<Flags>(() => loadFlags(storage()));
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ hits: NotebookHit[]; more: boolean } | null>(null);
  const [highlight, setHighlight] = useState("");
  const [menu, setMenu] = useState<Menu | null>(null);
  const wantHour = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // The shelf: the month shown (the newest month with notes at first), its spines, the volumes and companies.
  useEffect(() => {
    let live = true;
    const asked = month ?? new Date().toISOString().slice(0, 7);
    void everyComputer<NotebookShelfPart>(awake, (m) => api.notebookShelf(m, asked)).then((parts) => {
      if (!live) return;
      const merged = mergeShelf(parts);
      setShelf(merged);
      if (month === null && merged.today) setMonth(merged.today.slice(0, 7));
      setBook((b) => b ?? (merged.today ? { kind: "day", day: merged.today } : null));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, awakeKey]);

  // The open book: a day's notebook, a volume or the binder.
  useEffect(() => {
    if (!book) return;
    let live = true;
    setLoaded(null);
    const done = (l: Loaded) => {
      if (!live) return;
      setLoaded(l);
      setTurn(null);
    };
    if (book.kind === "day") {
      void everyComputer<NotebookDayPart>(awake, (m) => api.notebookDay(m, book.day)).then((parts) => {
        const merged = mergeDay(parts, company);
        done({ pages: merged.pages, hoursKept: parts.length === 0 || merged.hoursKept, missing: parts.length === 0 });
      });
    } else if (book.kind === "volume") {
      void everyComputer<NotebookVolumePart>(awake, (m) => api.notebookVolume(m, book.id)).then((parts) => {
        const v = mergeVolume(parts, company);
        done({ pages: v ? [volumePage(v)] : [], hoursKept: true, missing: !v });
      });
    } else {
      void everyComputer<NotebookBrains>(awake, (m) => api.notebookBrains(m)).then((parts) => {
        const brains = mergeBrains(parts);
        const brain = brains.find((b) => b.company.id === book.company) ?? brains[0];
        done({ pages: brain ? [brainPage(brain)] : [], hoursKept: true, brains, missing: !brain });
      });
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, company, awakeKey]);

  // Search every notebook, a moment after the typing stops.
  useEffect(() => {
    const q = query.trim();
    if (q.length < SEARCH_MIN_CHARS) {
      setHits(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void everyComputer<NotebookHits>(awake, (m) => api.notebookSearch(m, q)).then((parts) => live && setHits(mergeHits(parts, company)));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, company, awakeKey]);

  // The paper: two pages side by side in what room there is.
  const stage = useRef<HTMLDivElement>(null);
  const size = useSize(stage);
  // The binder's company tabs take a row above the book.
  const pageH = Math.max(520, Math.min(880, size.h - 90 - (book?.kind === "binder" ? 64 : 0)));
  // Two pages side by side when there is room for them, else one at a time.
  const twoUp = size.w >= 2 * 340 + 70;
  const n = twoUp ? 2 : 1;
  const pageW = twoUp ? Math.min(440, Math.floor((size.w - 70) / 2)) : Math.max(300, Math.min(480, size.w - 50));
  const align = useCallback((i: number) => Math.max(0, i - (i % n)), [n]);
  const perPage = rowsFor(pageH);
  const measure = useMeasure();
  const sheets = useMemo(() => (loaded ? paginateBook(loaded.pages, pageW - TEXT_LEFT - TEXT_RIGHT, perPage, measure) : []), [loaded, pageW, perPage, measure]);

  // Land on the hour a search hit or a flag asked for, else page 1.
  useEffect(() => {
    if (!loaded) return;
    const at = wantHour.current === null ? 0 : sheetFor(sheets, wantHour.current);
    wantHour.current = null;
    setIndex(align(at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  useEffect(() => {
    if (index >= sheets.length && sheets.length > 0) setIndex(align(sheets.length - 1));
    else if (index !== align(index)) setIndex(align(index));
  }, [sheets.length, index, align]);

  const go = useCallback(
    (dir: 1 | -1) => {
      if (turn) return;
      const to = index + dir * n;
      if (to < 0 || to >= sheets.length) return;
      setTurn({ dir, from: index });
      setTimeout(() => {
        setIndex(to);
        setTurn(null);
      }, TURN_MS);
    },
    [index, sheets.length, turn, n],
  );

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "Escape") {
        setMenu(null);
        if (query) {
          setQuery("");
          searchRef.current?.blur();
        }
        return;
      }
      if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowRight") {
        go(1);
        e.preventDefault();
      } else if (e.key === "ArrowLeft") {
        go(-1);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [go, query]);

  const bookDay = book?.kind === "day" ? book.day : book?.kind === "volume" ? book.id : `binder:${book?.kind === "binder" ? book.company ?? "" : ""}`;
  const companies = shelf?.companies ?? [];

  const open = (b: Book, hour: string | null = null) => {
    wantHour.current = hour;
    setMenu(null);
    setBook(b);
  };

  const tick = (thread: NotebookThread, done: boolean) => {
    if (book?.kind !== "day") return;
    const key = threadKey(thread.text);
    setTicks((t) => ({ ...t, [key]: done }));
    api.notebookTick(thread.computer, book.day, thread.text, done).catch((e: Error) => {
      setTicks((t) => ({ ...t, [key]: !done }));
      app.toast(`The tick didn't reach ${config.label(thread.computer)}: ${e.message}`);
    });
  };

  const flag = (anchor: string) => {
    const next = toggleFlag(flags, bookDay, anchor);
    setFlags(next);
    saveFlags(storage(), next);
  };
  const ownFlags = flags[bookDay] ?? {};
  const flagged = sheets.filter((s) => ownFlags[sheetAnchor(s)]);

  const headerOf = (sheet: Sheet): { date: string; title: string } => {
    const more = sheet.part > 0 ? ", continued" : "";
    if (!book) return { date: "", title: "" };
    if (book.kind === "volume") return { date: volumeTitle(book.id), title: `${book.id.includes("W") ? "The week" : "The month"}${more}` };
    if (book.kind === "binder") {
      const brain = loaded?.brains?.find((b) => b.company.id === book.company) ?? loaded?.brains?.[0];
      return { date: `Company brain${brain?.day ? ` · updated ${dayShort(brain.day)}` : ""}`, title: `${brain?.company.name ?? ""}${more}` };
    }
    return { date: dayTitle(book.day), title: sheet.page.kind === "hour" ? `${hourTitle(sheet.page.hour)}${more}` : `The day${more}` };
  };

  const paper = (sheet: Sheet | undefined, side: "left" | "right", extra?: string) =>
    sheet ? (
      <Paper
        key={`${side}-${sheet.number}`}
        sheet={sheet}
        side={side}
        className={extra}
        header={headerOf(sheet)}
        perPage={perPage}
        width={pageW}
        height={pageH}
        companies={companies}
        ticks={ticks}
        highlight={highlight}
        flag={ownFlags[sheetAnchor(sheet)] ?? null}
        empty={emptyWords(book, loaded)}
        dayOnly={book?.kind === "day" && loaded?.hoursKept === false && sheet.page.kind === "day"}
        onTick={tick}
        onMenu={(e, text) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, text, anchor: sheetAnchor(sheet), where: `${headerOf(sheet).date} · ${headerOf(sheet).title}` });
        }}
      />
    ) : (
      <div className={cls("nb-paper", side, "blank", extra)} style={{ width: pageW, height: pageH }} />
    );

  // What each side shows while a leaf turns: the pages under it are already the next spread's. One
  // page at a time, the leaf turned forward is the page that was showing, and back, the page coming in.
  const base = twoUp
    ? turn ? (turn.dir === 1 ? [turn.from, turn.from + 3] : [turn.from - 2, turn.from + 1]) : [index, index + 1]
    : turn ? [turn.dir === 1 ? turn.from + 1 : turn.from] : [index];
  const leaf = !turn ? null : twoUp ? (turn.dir === 1 ? [turn.from + 1, turn.from + 2] : [turn.from, turn.from - 1]) : [turn.dir === 1 ? turn.from : turn.from - 1, -1];
  const pp = (i: number) => (twoUp && sheets[i + 1] ? `pp. ${i + 1}–${i + 2}` : `p. ${i + 1}`);

  return (
    <div className="page nb-page" onClick={() => setMenu(null)}>
      <aside className="nb-rail">
        <div className="nb-title">Notebook</div>
        <div className="nb-sub">{LEAD_NAME}'s notes, written every hour</div>
        <div className="nb-search">
          <span className="nb-search-icon">⌕</span>
          <input ref={searchRef} value={query} placeholder="Search every notebook" onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button className="nb-clear" onClick={() => setQuery("")} title="Clear (Esc)">
              ✕
            </button>
          )}
        </div>
        <div className="nb-chips">
          <button className={cls("nb-chip", company === null && "on")} onClick={() => setCompany(null)}>
            All
          </button>
          {companies.map((c) => (
            <button key={c.id} className={cls("nb-chip", company === c.id && "on")} onClick={() => setCompany(company === c.id ? null : c.id)}>
              <span className={cls("nb-tabmark", `tab-${companyTone(c, companies)}`)} />
              {c.name}
            </button>
          ))}
        </div>

        {hits ? (
          <SearchResults
            hits={hits}
            query={query.trim()}
            companies={companies}
            onOpen={(h) => {
              setHighlight(h.line);
              if (h.place.kind === "week" || h.place.kind === "month") open({ kind: "volume", id: h.place.id });
              else open({ kind: "day", day: h.place.id }, h.place.kind === "hour" ? h.place.hour ?? null : null);
            }}
          />
        ) : (
          <>
            {shelf && month && (
              <Month
                month={month}
                shelf={shelf}
                open={book?.kind === "day" ? book.day : null}
                onMonth={(n) => setMonth(shiftMonth(month, n))}
                onDay={(day) => {
                  setHighlight("");
                  open({ kind: "day", day });
                }}
              />
            )}
            {shelf && shelf.days.length > 0 && (
              <div className="nb-hint">Thick spines were busy days. Hour pages are kept {shelf.keepHourlyDays} days; older notebooks keep the day page.</div>
            )}
            {shelf && (shelf.weeks.length > 0 || shelf.months.length > 0) && (
              <>
                <div className="nb-label">Bound volumes</div>
                <div className="nb-volumes">
                  {[...shelf.weeks.slice(-3), ...shelf.months.slice(-2)].map((id) => (
                    <button key={id} className={cls("nb-volume", book?.kind === "volume" && book.id === id && "on")} onClick={() => open({ kind: "volume", id })}>
                      <span className="nb-gilt" />
                      <span className="nb-volume-kind">{id.includes("W") ? "WEEK" : "MONTH"}</span>
                      <span className="nb-volume-name">{id.includes("W") ? String(Number(id.slice(6))) : volumeTitle(id).slice(0, 3)}</span>
                      <span className="nb-gilt low" />
                    </button>
                  ))}
                </div>
              </>
            )}
            {companies.length > 0 && (
              <>
                <div className="nb-label">Companies</div>
                <div className="nb-binder-row">
                  <button className="nb-binder" onClick={() => open({ kind: "binder", company })}>
                    <span className="nb-rings">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="nb-binder-name">Companies</span>
                    <span className="nb-binder-sub">brains &amp; lessons</span>
                  </button>
                  <div className="nb-binder-tabs">
                    {companies.slice(0, 6).map((c) => (
                      <button key={c.id} className={cls("nb-binder-tab", `tab-${companyTone(c, companies)}`)} onClick={() => open({ kind: "binder", company: c.id })}>
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
            {flagged.length > 0 && (
              <>
                <div className="nb-label">Flagged in this book</div>
                {flagged.map((s) => (
                  <button key={sheetAnchor(s)} className="nb-flagged" onClick={() => setIndex(align(s.number - 1))}>
                    <span className={cls("nb-tabmark", `tab-${ownFlags[sheetAnchor(s)]}`)} />
                    {sheetLabel(s)}
                  </button>
                ))}
              </>
            )}
          </>
        )}
      </aside>

      <section className="nb-stage" ref={stage}>
        {!shelf ? (
          <div className="nb-empty">Opening the notebook…</div>
        ) : !book ? (
          <div className="nb-empty">
            <div className="nb-empty-title">No notes yet</div>
            {LEAD_NAME} writes a page every hour it works.
          </div>
        ) : !loaded ? (
          <div className="nb-empty">Turning to {book.kind === "day" ? dayShort(book.day) : book.kind === "volume" ? volumeTitle(book.id) : "the binder"}…</div>
        ) : (
          <>
            {book.kind === "binder" && loaded.brains && (
              <div className="nb-binder-switch" style={{ maxWidth: pageW * n }}>
                {loaded.brains.map((b) => (
                  <button
                    key={b.company.id}
                    className={cls("nb-binder-tab top", `tab-${companyTone(b.company, companies)}`, (book.company ?? loaded.brains![0]!.company.id) === b.company.id && "on")}
                    onClick={() => open({ kind: "binder", company: b.company.id })}
                  >
                    {b.company.name}
                  </button>
                ))}
              </div>
            )}
            <div className={cls("nb-book", book.kind, !twoUp && "single")} style={{ width: pageW * n, height: pageH }}>
              <div className="nb-cover" />
              <div className="nb-stack left" />
              <div className="nb-stack right" />
              {paper(sheets[base[0]!], "left")}
              {twoUp && paper(sheets[base[1]!], "right")}
              {leaf && (
                <div
                  className={cls("nb-leaf", twoUp ? (turn!.dir === 1 ? "next" : "prev") : turn!.dir === 1 ? "next" : "in")}
                  style={{ width: pageW, height: pageH, left: twoUp && turn!.dir === 1 ? pageW : 0 }}
                >
                  <div className="nb-leaf-face front">{paper(sheets[leaf[0]!], turn!.dir === 1 ? "right" : "left")}</div>
                  <div className="nb-leaf-face back">{paper(sheets[leaf[1]!], turn!.dir === 1 ? "left" : "right")}</div>
                </div>
              )}
              <div className="nb-gutter" />
              <div className="nb-ribbon" />
              <div className="nb-band" />
              <div className="nb-flags">
                {flagged.map((s, i) => (
                  <button
                    key={sheetAnchor(s)}
                    className={cls("nb-flag", `tab-${ownFlags[sheetAnchor(s)]}`)}
                    style={{ top: 120 + i * 58 }}
                    title={sheetLabel(s)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setIndex(align(s.number - 1));
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="nb-foot" style={{ width: pageW * n }}>
              <button className="nb-turn" disabled={index === 0} onClick={() => go(-1)}>
                {index === 0 ? "" : `‹ ${pp(index - n)}`}
              </button>
              <span className="nb-foot-mid">
                {book.kind === "day" ? dayShort(book.day) : book.kind === "volume" ? volumeTitle(book.id) : "Companies"} · {sheets.length === 0 ? "no pages" : `${twoUp && sheets[index + 1] ? `pages ${index + 1}–${index + 2}` : `page ${index + 1}`} of ${sheets.length}`} · ← → to turn
              </span>
              <button className="nb-turn right" disabled={index + n >= sheets.length} onClick={() => go(1)}>
                {index + n >= sheets.length ? "" : `${pp(index + n)} ›`}
              </button>
            </div>
          </>
        )}
      </section>

      {menu && (
        <div className="nb-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <div className="nb-menu-quote">“{menu.text.length > 140 ? `${menu.text.slice(0, 139)}…` : menu.text}”</div>
          <button
            className="nb-menu-item ask"
            onClick={() => {
              askCobraWith(`About this from my notebook (${menu.where}): “${menu.text}” — `);
              setMenu(null);
              app.show("ops");
            }}
          >
            Ask {LEAD_NAME} about this
          </button>
          <button
            className="nb-menu-item"
            onClick={() => {
              flag(menu.anchor);
              setMenu(null);
            }}
          >
            {ownFlags[menu.anchor] ? "Take the flag off this page" : "Flag this page"}
          </button>
          <button
            className="nb-menu-item"
            onClick={() => {
              void navigator.clipboard?.writeText(menu.text).catch(() => undefined);
              setMenu(null);
            }}
          >
            Copy
          </button>
        </div>
      )}
    </div>
  );
}

function emptyWords(book: Book | null, loaded: Loaded | null): string {
  if (!book || !loaded) return "";
  if (book.kind === "binder") return "No company brains on these computers yet.";
  if (book.kind === "volume") return "Nothing in this volume.";
  if (loaded.missing) return "Nothing was written that day.";
  return loaded.pages.length > 1 ? `${LEAD_NAME} writes the day page at 4 AM, when the day is over.` : "";
}

// --- one sheet of paper ---------------------------------------------------------------------

type PaperProps = {
  sheet: Sheet;
  side: "left" | "right";
  className?: string;
  header: { date: string; title: string };
  perPage: number;
  width: number;
  height: number;
  companies: readonly NotebookCompany[];
  ticks: Record<string, boolean>;
  highlight: string;
  flag: TabColour | null;
  empty: string;
  dayOnly: boolean;
  onTick: (thread: NotebookThread, done: boolean) => void;
  onMenu: (e: React.MouseEvent, text: string) => void;
};

function Paper(p: PaperProps) {
  const rows = p.sheet.rows;
  const top = (i: number) => FIRST_RULE + i * RULE - RULE;
  // A day page with nothing written yet (the day page is written at 4 AM) says so under what it has.
  const page = p.sheet.page;
  const unwritten = p.sheet.part === 0 && (rows.length === 0 || (page.kind === "day" && page.summary.length === 0 && page.threads.length === 0 && !!p.empty));
  const noteRow = rows.length === 0 ? 0 : rows.length + 1;
  const empty = unwritten && noteRow < p.perPage - (p.sheet.continued ? 1 : 0);
  return (
    <div className={cls("nb-paper", p.side, p.className)} style={{ width: p.width, height: p.height }}>
      <div className="nb-rules" style={{ top: FIRST_RULE, height: (p.perPage - 1) * RULE + 1 }} />
      <div className="nb-margin" />
      <div className="nb-date">{p.header.date}</div>
      <div className="nb-page-title">{p.header.title}</div>
      {empty && (
        <div className="nb-row pencil italic wrap" style={{ top: top(noteRow), left: TEXT_LEFT, right: TEXT_RIGHT }}>
          {p.empty}
        </div>
      )}
      {rows.map((row, i) => (
        <Row key={i} row={row} top={top(i)} {...p} />
      ))}
      {p.sheet.continued && (
        <div className="nb-row pencil italic right" style={{ top: top(p.perPage - 1), left: TEXT_LEFT, right: TEXT_RIGHT }}>
          {p.sheet.page.kind === "day" && rows.every((r) => r.kind !== "contents") && p.sheet.page.contents.length > 0 ? "Contents overleaf ›" : "Continued overleaf ›"}
        </div>
      )}
      {p.dayOnly && !p.sheet.continued && <div className="nb-dayonly">Hour pages are kept 7 days; this notebook keeps its day page.</div>}
      <div className="nb-number">{p.sheet.number}</div>
    </div>
  );
}

function Highlighted({ text, highlight }: { text: string; highlight: string }) {
  // A whole line from a search hit is marked; a typed word inside it is not needed on paper.
  if (!highlight || !highlight.includes(text) || text.length < 3) return <>{text}</>;
  return <mark className="nb-hilite">{text}</mark>;
}

function Row({ row, top, companies, ticks, highlight, onTick, onMenu }: PaperProps & { row: PageRow; top: number }) {
  const style = { top, left: TEXT_LEFT, right: TEXT_RIGHT };
  if (row.kind === "gap") return null;
  if (row.kind === "heading") {
    return (
      <div className="nb-row heading" style={style}>
        <span className="nb-heading">{row.text}</span>
        {row.computer && row.text !== "Open threads" && row.text !== "Contents" && <span className="nb-stamp">{config.label(row.computer)}</span>}
      </div>
    );
  }
  if (row.kind === "contents") {
    const tone = companyTone(row.line.company, companies);
    return (
      <div className="nb-row contents" style={style}>
        {tone && <span className={cls("nb-tabmark", `tab-${tone}`)} />}
        <span className="nb-contents-name">{row.text}</span>
        <span className="nb-leader" />
        <span className="nb-pp">{pagesText(row.line.pages)}</span>
      </div>
    );
  }
  if (row.kind === "thread") {
    const done = ticks[threadKey(row.thread.text)] ?? row.thread.done;
    const tone = companyTone(row.thread.company, companies);
    return (
      <div className={cls("nb-row thread", done && "done")} style={{ ...style, paddingLeft: 22 }} onContextMenu={(e) => onMenu(e, row.thread.text)}>
        {row.first && (
          <button className={cls("nb-box", done && "on")} title={done ? "Not done" : `Done: ${LEAD_NAME} leaves it out tomorrow`} onClick={() => onTick(row.thread, !done)}>
            {done && <svg viewBox="0 0 14 14"><path d="M1 8 L5 13 L13 1" /></svg>}
          </button>
        )}
        <span className="nb-text"><Highlighted text={row.text} highlight={highlight} /></span>
        {row.first && tone && <span className={cls("nb-tabmark end", `tab-${tone}`)} />}
      </div>
    );
  }
  const indent = row.depth * 16 + (row.bullet ? 16 : 0);
  return (
    <div className={cls("nb-row", row.tone === "pencil" && "pencil")} style={{ ...style, paddingLeft: indent }} onContextMenu={(e) => onMenu(e, row.text)}>
      {row.bullet && row.first && <span className="nb-bullet" style={{ left: row.depth * 16 }}>{row.depth > 0 ? "–" : "•"}</span>}
      <span className="nb-text"><Highlighted text={row.text} highlight={highlight} /></span>
    </div>
  );
}

// --- the rail ---------------------------------------------------------------------------------

function Month({ month, shelf, open, onMonth, onDay }: { month: string; shelf: Shelf; open: string | null; onMonth: (n: number) => void; onDay: (day: string) => void }) {
  const weeks = monthGrid(month, shelf);
  return (
    <div className="nb-month">
      <div className="nb-month-head">
        <span className="nb-label flat">{monthTitle(month).toUpperCase()}</span>
        <span className="grow" />
        <button className="nb-arrow" onClick={() => onMonth(-1)} title="Earlier month">
          ‹
        </button>
        <button className="nb-arrow" onClick={() => onMonth(1)} disabled={!!shelf.today && month >= shelf.today.slice(0, 7)} title="Later month">
          ›
        </button>
      </div>
      <div className="nb-weekdays">
        {"MTWTFSS".split("").map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      {weeks.map((week, w) => (
        <div className="nb-shelf-row" key={w}>
          {week.map((cell) => {
            const spine = cell.inMonth ? cell.spine : null;
            return (
              <button
                key={cell.day}
                className={cls("nb-cell", !cell.inMonth && "out", cell.future && "future")}
                disabled={!spine}
                title={spine ? `${dayShort(cell.day)} · ${spine.hours ? `${spine.hours} hour${spine.hours === 1 ? "" : "s"}` : "day page"}` : undefined}
                onClick={() => spine && onDay(cell.day)}
              >
                {spine ? (
                  <span className={cls("nb-spine", !spine.kept && "kept-day", cell.day === open && "open")} style={{ width: spineWidth(spine.kept ? spine.hours : Math.min(spine.hours, 2)) }}>
                    {cell.today && <span className="nb-spine-ribbon" />}
                  </span>
                ) : cell.inMonth && cell.future ? (
                  <span className="nb-spine-slot" />
                ) : (
                  <span className="nb-spine-none" />
                )}
                <span className="nb-cell-day">{cell.inMonth ? Number(cell.day.slice(8)) : ""}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SearchResults({ hits, query, companies, onOpen }: { hits: { hits: NotebookHit[]; more: boolean }; query: string; companies: readonly NotebookCompany[]; onOpen: (hit: NotebookHit) => void }) {
  const books = new Set(hits.hits.map((h) => `${h.place.kind === "hour" ? "day" : h.place.kind}:${h.place.id}`)).size;
  return (
    <div className="nb-results">
      <div className="nb-hint">
        {hits.hits.length === 0 ? `Nothing in any notebook says “${query}”.` : `${hits.hits.length}${hits.more ? "+" : ""} line${hits.hits.length === 1 ? "" : "s"} in ${books} notebook${books === 1 ? "" : "s"}`}
      </div>
      {hits.hits.map((h, i) => {
        const tone = companyTone(h.company, companies);
        return (
          <button key={i} className="nb-slip" onClick={() => onOpen(h)}>
            {tone && <span className={cls("nb-slip-edge", `tab-${tone}`)} />}
            <span className="nb-slip-head">
              <span className="nb-slip-where">{placeTitle(h.place)}</span>
              <span className="nb-slip-co">{h.company?.name ?? ""}</span>
            </span>
            <span className="nb-slip-line">
              {matchParts(h.line, query).map((part, j) => (part.hit ? <mark key={j}>{part.text}</mark> : <span key={j}>{part.text}</span>))}
            </span>
          </button>
        );
      })}
    </div>
  );
}
