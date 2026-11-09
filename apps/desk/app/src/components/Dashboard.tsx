/**
 * A trade's dashboards on the project page: the phone's DashboardScreen on the desk. The views as tabs, a
 * search box where a view has one, a row that opens a page, buttons that run
 * the trade's named writes (a dialog for what the view does not fill in), and
 * Show on a hidden value (back to dots after 30 s or when you leave the page).
 * Everything comes from the agent's views (agent views.ts); nothing here knows
 * a trade. Drawn only when the trade ships views, so a project without them
 * looks as it did. The shapes and words are contracts viewsRead.ts. A trade's
 * charts are its board above the tabs (BoardCharts.tsx); a tap on one opens
 * the list it names, with the value tapped as `key`. A Money seat's views name rail pages
 * (`page`, asked for with `surface=desk`): those draw as the Finance rail (FinanceRail.tsx) in
 * place of the board and tabs, and what a press there opens comes back here with ‹ Back.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "../lib/api.ts";
import {
  boardColumns, groupHeading, rowButtons, buildArgs, chartViews, fieldHint, fieldLabel, fieldRows, formatCell, formFields, localToday, pageTitle, parseViewList, parseViewResult,
  kanbanView, pageActions, pageFacts, rowParts, summaryView, tabViews,
} from "../../../../../packages/contracts/src/viewsRead.ts";
import type { Cell, PublicView, ViewAction, ViewList, ViewResult, ViewRow } from "../../../../../packages/contracts/src/views.ts";
import { useApp } from "../app/context.ts";
import { Board } from "./BoardCharts.tsx";
import { CrmBoard } from "./CrmBoard.tsx";
import { FinanceRail } from "./FinanceRail.tsx";
import { MarketingBoard } from "./MarketingBoard.tsx";
import { openingMonth, railPages } from "../lib/finance.ts";
import { Button, Dialog, Section, cls } from "./ui.tsx";
import { Confirm } from "./Verbs.tsx";
import { usePasscodeAsk } from "./PasscodeAsk.tsx";
import "../styles/dashboard.css";

/** One screen over the tabs: a page a row opened (`id`), or the list a chart opened (`key`, read over the board's `range`). */
type Step = { view: string; id?: string; key?: string; range?: string; month?: string; title: string };
type Form = { action: ViewAction; id: string | null; page: string | null };

const SHOW_MS = 30_000;
const MULTILINE = new Set(["body", "summary", "why", "notes", "note"]);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const revealKey = (field: string, block?: number, row?: string) => `${block ?? "-"}:${row ?? "-"}:${field}`;

/** `space`: the Space the project is seated in, for Ask Cobra on the CRM board's cards. */
export function Dashboard({ machine, project, space }: { machine: string; project: string; space?: string }) {
  const app = useApp();
  const [list, setList] = useState<ViewList | null>(null);
  const [summary, setSummary] = useState<ViewResult | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [stack, setStack] = useState<Step[]>([]);
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [result, setResult] = useState<ViewResult | { error: string } | null>(null);
  const [shown, setShown] = useState<Record<string, Cell>>({});
  const [form, setForm] = useState<Form | null>(null);
  const [asking, setAsking] = useState<{ action: ViewAction; args: Record<string, unknown> } | null>(null);
  const [busy, setBusy] = useState(false);
  // A Money seat's Finance rail (FinanceRail.tsx): its page and month, kept here so a row's page and Back return to them.
  const [railPage, setRailPage] = useState<string | null>(null);
  const [railMonth, setRailMonth] = useState(() => localToday().slice(0, 7));
  // Bumped after a write, so the board reads its charts again.
  const [written, setWritten] = useState(0);
  const round = useRef(0);
  // The passcode stands where the phone asks for Face ID: before Show, and before a write that is the person's alone.
  const { ask: askPasscode, node: passcodeNode } = usePasscodeAsk();

  useEffect(() => {
    let live = true;
    setList(null);
    setSummary(null);
    setStack([]);
    api.views(machine, project).then(async (raw) => {
      const parsed = parseViewList(raw);
      if (!live || (tabViews(parsed).length === 0 && chartViews(parsed).length === 0)) return;
      setList(parsed);
      const pages = railPages(parsed);
      if (pages.length) {
        setRailPage((cur) => (cur && pages.includes(cur) ? cur : pages[0]!));
        setRailMonth(openingMonth(parsed, localToday()));
        return;
      }
      setTab((cur) => cur ?? deskTabs(parsed)[0]?.id ?? null);
      const tiles = summaryView(parsed);
      if (tiles) {
        const raw2 = await api.view(machine, project, tiles.id).catch(() => null);
        if (live && raw2) setSummary(parseViewResult(raw2));
      }
    }, () => {});
    return () => void (live = false);
  }, [machine, project]);

  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const top = stack[stack.length - 1] ?? null;
  const pages = useMemo(() => railPages(list), [list]);
  const rail = pages.length > 0;
  // A trade with a kanban draws it as the whole dashboard; its other views open from its More.
  const crm = list ? kanbanView(list) : null;
  // On the rail each card reads its own view, as does the kanban; the one below reads only what a press opened.
  const viewId = top ? top.view : rail || crm ? null : tab;
  // A list opened from the board's More keeps its search.
  const listStep = top !== null && top.id === undefined && top.key === undefined;
  const spec = list?.views.find((v) => v.id === viewId) ?? null;

  const load = useCallback(async () => {
    if (!viewId) return;
    const mine = ++round.current;
    try {
      const raw = await api.view(machine, project, viewId, {
        ...(top?.id ? { id: top.id } : {}), ...(top?.key !== undefined ? { key: top.key, range: top.range, ...(top.month ? { month: top.month } : {}) } : {}), ...(q && (!top || listStep) ? { q } : {}),
      });
      if (mine === round.current) setResult(parseViewResult(raw));
    } catch (e) {
      if (mine === round.current) setResult({ error: msg(e) });
    }
  }, [machine, project, viewId, top?.id, top?.key, top?.range, top?.month, q, listStep]);

  useEffect(() => {
    setResult(null);
    void load();
  }, [load]);

  useEffect(() => setShown({}), [viewId, top?.id, top?.key]);
  useEffect(() => {
    if (Object.keys(shown).length === 0) return;
    const timer = setTimeout(() => setShown({}), SHOW_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  const run = useCallback(async (action: ViewAction, args: Record<string, unknown>): Promise<boolean> => {
    const ownerOnly = list?.mutations[action.mutation]?.personOnly === true;
    if (ownerOnly && !(await askPasscode(`${action.label}: this is yours to allow`))) return false;
    setBusy(true);
    try {
      const done = (await api.viewWrite(machine, project, action.mutation, args, ownerOnly)) as { summary?: string } | null;
      app.toast(`${action.label} · ${done?.summary || "Done. Records has Undo."}`);
      setWritten((n) => n + 1);
      if (action.after === "back") setStack((s) => s.slice(0, -1));
      else void load();
      return true;
    } catch (e) {
      app.toast(`Not done: ${msg(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }, [machine, project, load, app, list, askPasscode]);

  const allowAll = useCallback((batch: { mutation: string; label: string }, ids: string, label: string) => {
    if (ids) void run({ mutation: batch.mutation, label, on: "view" }, { ids });
  }, [run]);

  const onAction = useCallback((action: ViewAction, id: string | null) => {
    const mutation = list?.mutations[action.mutation];
    const page = top?.id ?? null;
    if (formFields(action, mutation).length > 0) return setForm({ action, id, page });
    const built = buildArgs(action, mutation, id, {}, localToday(), page);
    if ("error" in built) return app.toast(built.error);
    if (action.confirm) return setAsking({ action, args: built.args });
    void run(action, built.args);
  }, [list, run, app, top?.id]);

  const reveal = useCallback(async (where: { field: string; block?: number; row?: string }) => {
    if (!viewId) return;
    if (!(await askPasscode("Show a hidden value"))) return;
    try {
      const out = (await api.viewReveal(machine, project, { view: viewId, ...where, ...(top?.id ? { id: top.id } : {}) })) as { value?: Cell } | null;
      setShown((s) => ({ ...s, [revealKey(where.field, where.block, where.row)]: out?.value ?? null }));
    } catch (e) {
      app.toast(`Could not show it: ${msg(e)}`);
    }
  }, [machine, project, viewId, top?.id, app, askPasscode]);

  const ctx = useMemo<Ctx>(() => ({
    currency: list?.currency ?? "USD", today: localToday(), shown,
    open: (id, title, own) => { const page = own || spec?.opens; if (page) setStack((s) => [...s, { view: page, id, title }]); },
    act: onAction, reveal: (where) => void reveal(where),
  }), [list, shown, spec?.opens, onAction, reveal]);

  if (!list) return null;
  const dialogs = (<>
    {passcodeNode}
    {asking && <Confirm title={`${asking.action.label}?`} body="It stays in Records, and Undo is there for a week." yes={asking.action.label}
      onYes={() => void run(asking.action, asking.args)} onClose={() => setAsking(null)} />}
    {form && <FormDialog form={form} list={list} busy={busy} onClose={() => setForm(null)}
      onSend={async (args) => { if (await run(form.action, args)) setForm(null); }} />}
  </>);
  if (rail && railPage && !top) {
    return (
      <Section title="Dashboard">
        <FinanceRail machine={machine} project={project} list={list} pages={pages} ctx={ctx} round={written}
          page={railPage} onPage={setRailPage} month={railMonth} onMonth={setRailMonth}
          onDrill={(d) => setStack([{ view: d.view, key: d.key, range: d.range, ...(d.month ? { month: d.month } : {}), title: `${list.views.find((v) => v.id === d.view)?.title ?? "Details"}: ${d.title}` }])}
          onSeeAll={(v, month) => setStack([{ view: v.id, key: "", ...(month ? { month } : {}), title: v.title }])}
          allowAll={allowAll} onChanged={() => setWritten((n) => n + 1)} />
        {dialogs}
      </Section>
    );
  }
  const tabs = deskTabs(list);
  const ready = result && !("error" in result) ? result : null;
  const title = top ? (ready && top.key === undefined && !listStep ? pageTitle(ready) : top.title) : spec?.title ?? "";
  // A Marketing seat (the Outreach trade) draws its own board from GET /marketing; its writes come back here.
  if (list.trade === "outreach" && !top) {
    return (
      <Section title="Marketing">
        <MarketingBoard machine={machine} project={project} space={space} written={written} act={onAction} />
        {dialogs}
      </Section>
    );
  }
  if (crm && !top) {
    return (
      <Section title="CRM">
        <CrmBoard machine={machine} project={project} list={list} view={crm} written={written} space={space} act={onAction} askPasscode={askPasscode}
          open={(view, id, stepTitle) => { setTyped(""); setQ(""); setStack([{ view, ...(id !== undefined ? { id } : {}), title: stepTitle }]); }} />
        {dialogs}
      </Section>
    );
  }

  return (
    <Section title="Dashboard">
      <div className="dash">
        {summary?.tiles && !top && <Tiles result={summary} ctx={ctx} />}
        {!top && (
          <Board views={deskBoard(list)} currency={list.currency} round={written} today={ctx.today}
            read={(view, range, month) => api.view(machine, project, view.id, { ...(range ? { range } : {}), ...(month ? { month } : {}) })}
            onDrill={(d) => setStack([{ view: d.view, key: d.key, range: d.range, ...(d.month ? { month: d.month } : {}), title: `${list.views.find((v) => v.id === d.view)?.title ?? "Details"}: ${d.title}` }])}
            other={(_view, read) => !read ? <div className="dim chart-empty">Reading…</div>
              : "error" in read ? <div className="dim chart-empty">Could not read it: {read.error}</div>
              : <Body result={read} ctx={ctx} canOpen={false} actions={_view.actions} />} />
        )}
        {top ? (
          <button className="dash-back" onClick={() => setStack((s) => s.slice(0, -1))}>{crm && stack.length === 1 ? "‹ CRM" : "‹ Back"}</button>
        ) : tabs.length > 1 ? (
          <div className="dash-tabs" role="tablist">
            {tabs.map((v) => (
              <button key={v.id} role="tab" aria-selected={v.id === tab} className={cls("dash-tab", v.id === tab && "on")}
                onClick={() => { setTab(v.id); setTyped(""); setQ(""); }}>{v.title}</button>
            ))}
          </div>
        ) : null}
        <div className="dash-head">
          <h3 className="dash-title">{title}</h3>
          {(!top || listStep) && spec?.searchable && (
            <input className="entry dash-search" placeholder="Search" aria-label="Search" value={typed} onChange={(e) => setTyped(e.target.value)} />
          )}
          <ActionBar actions={top && !listStep ? pageActions(spec?.actions, pageFacts(ready)) : spec?.actions ?? []} id={top?.id ?? null} ctx={ctx} />
        </div>
        {!result && <div className="dim">Reading…</div>}
        {result && "error" in result && <div className="dim">Could not read it: {result.error}</div>}
        {ready && <Body result={ready} ctx={ctx} canOpen={Boolean(spec?.opens)} actions={spec?.actions} />}
      </div>
      {dialogs}
    </Section>
  );
}

/** What Tiles needs where nothing can be pressed (a Space page's tiles). */
export function plainCtx(currency: string): Ctx {
  return { currency, today: localToday(), shown: {}, open: () => {}, act: () => {}, reveal: () => {} };
}

export type Ctx = {
  currency: string; today: string; shown: Readonly<Record<string, Cell>>;
  /** `page` when the row names its own (Activity: an expense or an income), else the view's `opens`. */
  open: (id: string, title: string, page?: string) => void;
  act: (action: ViewAction, id: string | null) => void;
  reveal: (where: { field: string; block?: number; row?: string }) => void;
};

function ActionBar({ actions, id, ctx }: { actions: ViewAction[]; id: string | null; ctx: Ctx }) {
  const mine = actions.filter((a) => a.on === "view");
  return <>{mine.map((a, i) => <Button key={a.mutation} kind={i === 0 ? "primary" : undefined} small onClick={() => ctx.act(a, id)}>{a.label}</Button>)}</>;
}

/** One view's result drawn as the dashboard draws it: tiles, a board, a page or rows. */
/** `actions` are the view's own (from /views): a list's row buttons, such as To allow's Allow, are there and never in the reply. */
export function Body({ result, ctx, canOpen, actions }: { result: ViewResult; ctx: Ctx; canOpen: boolean; actions?: ViewAction[] }): ReactNode {
  if (result.kind === "tiles") return <Tiles result={result} ctx={ctx} />;
  if (result.kind === "board") return <BoardView result={result} ctx={ctx} canOpen={canOpen} />;
  if (result.kind === "page") return <PageView result={result} ctx={ctx} />;
  return <Rows rows={result.rows ?? []} map={result.row} formats={result.formats} ctx={ctx} canOpen={canOpen} empty="Nothing here yet." more={result.more} actions={actions} timeline={result.kind === "timeline"} />;
}

/**
 * The tabs under a trade's board: its lists, less the ones the board draws among its charts (`onBoard`, a budget's accounts and bills).
 * A board list that opens a page (the CRM's Next up and People) stays a tab on the desk, where a row opens
 * its page in place; the phone draws those on the Space's board.
 */
function deskTabs(list: ViewList): PublicView[] {
  return tabViews(list).filter((view) => view.onBoard !== true || view.opens !== undefined);
}

/** What the desk's board draws: the charts and the board lists that open nothing; the summary has its own tiles above. */
function deskBoard(list: ViewList): PublicView[] {
  return chartViews(list).filter((view) => !(view.onBoard && view.opens) && view.summary !== true);
}

export function Tiles({ result, ctx }: { result: ViewResult; ctx: Ctx }) {
  return (
    <div className="dash-tiles">
      {(result.tiles ?? []).map((t) => (
        <div key={t.label} className="dash-tile">
          <span className="dash-tile-label">{t.label}</span>
          <span className="dash-tile-value">
            {t.tone && <span className={cls("dash-dot", `t-${t.tone}`)} />}
            {formatCell(t.value, t.format, ctx.currency, ctx.today) || "0"}
          </span>
          {t.caption && <span className="dim">{t.caption}</span>}
        </div>
      ))}
    </div>
  );
}

function Rows({ rows, map, formats, ctx, canOpen, empty, more, actions, timeline }: {
  rows: ViewRow[]; map: ViewResult["row"]; formats: ViewResult["formats"]; ctx: Ctx; canOpen: boolean; empty: string;
  more?: boolean; actions?: ViewAction[]; timeline?: boolean;
}) {
  if (!map) return null;
  if (!rows.length) return <div className="dim dash-empty">{empty}</div>;
  return (
    <div className="dash-rows">
      {rows.map((row, i) => {
        const p = rowParts(row, map, formats, ctx.currency, ctx.today);
        const press = (canOpen || p.opens) && p.id !== null ? () => ctx.open(p.id!, p.title, p.opens || undefined) : undefined;
        // A list in groups (a budget's accounts: Everyday, Savings, …) gets a heading with its total where a group starts.
        const head = groupHeading(rows, i, map);
        return (
          <Fragment key={`${p.id ?? "row"}:${i}`}>
          {head && <div className="dash-group" role="heading" aria-level={4}>{head.title}{head.trailing && <span>{head.trailing}</span>}</div>}
          <div className={cls("dash-row", p.tone && `t-${p.tone}`)}>
            <div className={cls("dash-row-main", press && "click")} onClick={press}>
              <div className="grow">
                {timeline && (p.when || p.badge) && <div className="dim dash-when">{[p.when, p.badge].filter(Boolean).join(" · ")}</div>}
                <div className="dash-row-title">{p.title}</div>
                {p.subtitle && <div className="dim">{p.subtitle}</div>}
              </div>
              {!timeline && p.badge && <span className="dash-badge">{p.badge}</span>}
              {!timeline && p.trailing && <span className="dim">{p.trailing}</span>}
            </div>
            {rowButtons(actions, row).map((a) => (
              <Button key={a.label} small onClick={() => ctx.act(a, p.id)} title={`${a.label}: ${p.title}`}>{a.label}</Button>
            ))}
          </div>
          </Fragment>
        );
      })}
      {more && <div className="dim dash-empty">Showing the first 200. Search to narrow it.</div>}
    </div>
  );
}

function BoardView({ result, ctx, canOpen }: { result: ViewResult; ctx: Ctx; canOpen: boolean }) {
  const columns = boardColumns(result);
  const map = result.row;
  if (!map || !columns.length) return <div className="dim dash-empty">No stages yet. Add one to start a board.</div>;
  return (
    <div className="dash-board">
      {columns.map((c) => (
        <div key={c.name} className="dash-lane">
          <div className="dash-lane-head"><b>{c.name}</b><span className="dim">{c.cards.length}</span></div>
          {c.closed && <div className="dim dash-when">End stage</div>}
          {c.cards.length === 0 && <div className="dim">Empty</div>}
          {c.cards.map((card, i) => {
            const p = rowParts(card, map, result.formats, ctx.currency, ctx.today);
            return (
              <div key={`${p.id ?? "card"}:${i}`} className={cls("dash-card", canOpen && p.id !== null && "click")} onClick={canOpen && p.id !== null ? () => ctx.open(p.id!, p.title) : undefined}>
                <div className="dash-row-title">{p.title}</div>
                {p.subtitle && <div className="dim">{p.subtitle}</div>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function PageView({ result, ctx }: { result: ViewResult; ctx: Ctx }) {
  return (
    <div>
      {(result.blocks ?? []).map((block, index) => (
        <div key={`${block.kind}:${index}`} className="dash-block">
          {block.title && <div className="caps dash-block-title">{block.title}</div>}
          {block.kind === "fields" ? (
            block.rows[0] ? fieldRows(block.rows[0], block.masked).map((f) => {
              const key = revealKey(f.name, index);
              const known = key in ctx.shown;
              const text = formatCell(known ? ctx.shown[key] : f.value, block.formats?.[f.name], ctx.currency, ctx.today);
              return (
                <div key={f.name} className="dash-field">
                  <span className="dim dash-field-label">{f.label}</span>
                  <span className="grow selectable">{text || "—"}</span>
                  {f.hidden && !known && <Button kind="flat" small onClick={() => ctx.reveal({ field: f.name, block: index })} title={`Show ${f.label}`}>Show</Button>}
                </div>
              );
            }) : <div className="dim dash-empty">This one is no longer here.</div>
          ) : (
            <Rows rows={block.rows} map={block.row} formats={block.formats} ctx={ctx} canOpen={false}
              empty={block.empty ?? (block.kind === "timeline" ? "Nothing yet." : "Nothing to do.")} actions={block.actions} timeline={block.kind === "timeline"} />
          )}
        </div>
      ))}
    </div>
  );
}

function FormDialog({ form, list, busy, onClose, onSend }: { form: Form; list: ViewList; busy: boolean; onClose: () => void; onSend: (args: Record<string, unknown>) => Promise<void> }) {
  const mutation = list.mutations[form.action.mutation];
  const fields = formFields(form.action, mutation);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const send = () => {
    const built = buildArgs(form.action, mutation, form.id, typed, localToday(), form.page);
    if ("error" in built) return setError(built.error);
    setError(null);
    void onSend(built.args);
  };
  return (
    <Dialog title={form.action.label} onClose={onClose} buttons={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" onClick={send} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
    </>}>
      {mutation?.describe && <p className="dim">{mutation.describe}</p>}
      {fields.map((f) => (
        <label key={f.name} className="dash-form-field">
          <span className="dim">{fieldLabel(f.name)}{f.required ? "" : " (optional)"}</span>
          {f.kind === "text" && MULTILINE.has(f.name) ? (
            <textarea className="entry" rows={3} value={typed[f.name] ?? ""} placeholder={fieldHint(f)} onChange={(e) => setTyped((t) => ({ ...t, [f.name]: e.target.value }))} />
          ) : (
            <input className="entry" value={typed[f.name] ?? ""} placeholder={fieldHint(f)} onChange={(e) => setTyped((t) => ({ ...t, [f.name]: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && send()} />
          )}
        </label>
      ))}
      {error && <div className="dash-error" role="alert">{error}</div>}
    </Dialog>
  );
}
