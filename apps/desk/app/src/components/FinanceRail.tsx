/**
 * A Money seat's Finance tab on the desk:
 * a left rail of pages (a household's Overview, Transactions, Budget, Recurring and Investments; a
 * business's Overview, Transactions, Invoices and Tax & costs), one month switch for the page, and each
 * of the page's views as a card in the teal finance accent. The pages and their views are the agent's
 * (viewSpecs/finance.ts, read with `/views?surface=desk`); Dashboard.tsx keeps what a press opens (a
 * row's page, a chart's list, See all) and runs the buttons, so the rail draws and reads only. Lists show
 * their Allow all (one passcode for the rows shown) and their row buttons, Trust among them; the
 * Transactions page takes a bank statement, dropped or chosen (CSV or PDF), and asks which account
 * when the agent cannot tell. Under it, receipts: photos dropped or chosen, which the agent reads and
 * puts to the person on one card before any is recorded (lib/receipts.ts).
 */
import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { monthOf, monthTitle, shiftMonth } from "../../../../../packages/contracts/src/charts.ts";
import { batchIds, batchTotal, formatCell, isEmptyRead, parseViewResult } from "../../../../../packages/contracts/src/viewsRead.ts";
import type { PublicView, ViewList, ViewResult } from "../../../../../packages/contracts/src/views.ts";
import * as api from "../lib/api.ts";
import { isStatementFile, pageIsMonthly, pageViews } from "../lib/finance.ts";
import * as receipts from "../lib/receipts.ts";
import { APP_NAME } from "../lib/appName.ts";
import { useApp } from "../app/context.ts";
import { ChartBody, type Drill, type Draw, type Read } from "./BoardCharts.tsx";
import { Body, Tiles, type Ctx } from "./Dashboard.tsx";
import { Calendar, FinTable, Ring, River } from "./FinanceCharts.tsx";
import { Button, Dialog, cls } from "./ui.tsx";
import "../styles/finance.css";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type RailProps = {
  machine: string; project: string; list: ViewList; pages: string[]; ctx: Ctx; round: number;
  page: string; onPage: (page: string) => void; month: string; onMonth: (month: string) => void;
  onDrill: (drill: Drill) => void;
  /** See all on a list cut to its peek: the whole list, in the month shown. */
  onSeeAll: (view: PublicView, month: string | null) => void;
  allowAll: (batch: NonNullable<PublicView["batch"]>, ids: string, label: string) => void;
  /** After a statement is read: read the page again. */
  onChanged: () => void;
};

/** A wide card spans the page: tiles, rivers, calendars, tables and searchable lists. */
function wide(view: PublicView): boolean {
  return view.kind === "tiles" || view.kind === "table" || view.searchable === true || ["river", "calendar", "hero", "line", "bars"].includes(view.chart?.type ?? "");
}

export function FinanceRail(props: RailProps) {
  const { machine, project, list, pages, ctx, round, page, onPage, month, onMonth } = props;
  const views = pageViews(list, page).filter((v) => !v.fromChart);
  const monthly = pageIsMonthly(list, page);
  const [reads, setReads] = useState<Record<string, Read>>({});
  const [q, setQ] = useState<Record<string, string>>({});
  const ids = views.map((v) => v.id).join(",");
  const query = JSON.stringify(q);

  useEffect(() => {
    let live = true;
    setReads({});
    for (const view of views) {
      const typed = q[view.id]?.trim();
      api.view(machine, project, view.id, { ...(view.monthly ? { month } : {}), ...(typed ? { q: typed } : {}) }).then(
        (raw) => live && setReads((r) => ({ ...r, [view.id]: parseViewResult(raw) })),
        (e) => live && setReads((r) => ({ ...r, [view.id]: { error: msg(e) } })),
      );
    }
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, project, ids, month, round, query]);

  const latest = month >= monthOf(ctx.today);
  const there = (v: PublicView): boolean => {
    if (!v.hideEmpty) return true;
    const r = reads[v.id];
    return r !== undefined && ("error" in r || !isEmptyRead(r));
  };

  return (
    <div className="fin">
      <nav className="fin-rail" aria-label="Finance pages">
        <div className="caps fin-rail-title">Finance</div>
        {pages.map((p) => (
          <button key={p} className={cls("fin-rail-item", p === page && "on")} aria-current={p === page ? "page" : undefined} onClick={() => onPage(p)}>{p}</button>
        ))}
      </nav>
      <div className="fin-page">
        <div className="fin-page-head">
          <h3 className="fin-page-title">{page}</h3>
          {monthly && (
            <div className="chart-months fin-months">
              <button className="chart-month-step" aria-label={`Back to ${monthTitle(shiftMonth(month, -1))}`} onClick={() => onMonth(shiftMonth(month, -1))}>‹</button>
              <b className="chart-month">{monthTitle(month)}</b>
              <button className="chart-month-step" aria-label={`On to ${monthTitle(shiftMonth(month, 1))}`} disabled={latest} onClick={() => onMonth(shiftMonth(month, 1))}>›</button>
            </div>
          )}
        </div>
        <div className="fin-grid">
          {page === "Transactions" && <StatementDrop machine={machine} project={project} onRead={props.onChanged} />}
          {page === "Transactions" && <ReceiptDrop machine={machine} project={project} />}
          {views.filter(there).map((view) => (
            <Card key={view.id} view={view} read={reads[view.id]} props={props} wide={wide(view)}
              q={q[view.id] ?? ""} onQ={(text) => setQ((cur) => ({ ...cur, [view.id]: text }))} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Card({ view, read, props, wide: isWide, q, onQ }: { view: PublicView; read: Read | undefined; props: RailProps; wide: boolean; q: string; onQ: (q: string) => void }) {
  const { ctx, month, onDrill } = props;
  const [typed, setTyped] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => typed !== q && onQ(typed), 300);
    return () => clearTimeout(timer);
  }, [typed]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = read && !("error" in read) ? read : null;
  const rows = result?.rows ?? [];
  // A searchable list (Activity) is shown whole; the rest stop at their peek with See all.
  const peeked = view.peek !== undefined && !view.searchable && rows.length > view.peek;
  const batch = view.batch && rows.length ? view.batch : null;
  const draw: Draw = {
    currency: ctx.currency, today: ctx.today, compare: false,
    drill: (key, label) => view.chart?.drill && onDrill({ view: view.chart.drill, key, title: label, range: "30d", ...(view.monthly ? { month } : {}) }),
  };
  const viewActions = (view.actions ?? []).filter((a) => a.on === "view");
  return (
    <section className={cls("fin-card", isWide && "wide", view.kind === "tiles" && "bare")} aria-label={view.title}>
      {view.kind !== "tiles" && (
        <div className="fin-card-head">
          <b className="grow">{view.title}</b>
          {batch && result && (
            <span className="dim">{rows.length} · {formatCell(batchTotal(rows, batch.amount, result.row), "money", ctx.currency, ctx.today)}</span>
          )}
          {view.searchable && <input className="entry fin-search" placeholder="Search" aria-label={`Search ${view.title}`} value={typed} onChange={(e) => setTyped(e.target.value)} />}
          {viewActions.map((a, i) => <Button key={a.label} small kind={i === 0 ? "primary" : undefined} onClick={() => ctx.act(a, null)}>{a.label}</Button>)}
          {batch && result && (
            <Button small kind="primary" onClick={() => props.allowAll(batch, batchIds(rows, result.row), `${batch.label} ${Math.min(200, rows.length)}`)}>{batch.label}</Button>
          )}
        </div>
      )}
      {!read ? <div className="dim chart-empty">Reading…</div>
        : "error" in read ? <div className="dim chart-empty">Could not read it: {read.error}</div>
        : <CardBody view={view} result={read} draw={draw} ctx={ctx} month={month} peek={peeked ? view.peek! : null} />}
      {peeked && <button className="linkish fin-see-all" onClick={() => props.onSeeAll(view, view.monthly ? month : null)}>See all {rows.length} ›</button>}
    </section>
  );
}

function CardBody({ view, result, draw, ctx, month, peek }: { view: PublicView; result: ViewResult; draw: Draw; ctx: Ctx; month: string; peek: number | null }) {
  if (view.kind === "tiles") return <Tiles result={result} ctx={ctx} />;
  if (view.kind === "chart" && result.chart) {
    const chart = result.chart;
    if (chart.type === "ring") return <Ring result={result} chart={chart} />;
    if (chart.type === "river") return <River result={result} chart={chart} draw={draw} />;
    if (chart.type === "calendar") return <Calendar result={result} chart={chart} draw={draw} month={month} />;
    return <ChartBody read={result} draw={draw} />;
  }
  if (view.kind === "table" && view.columns) {
    return <FinTable rows={result.rows ?? []} columns={view.columns} currency={ctx.currency} today={ctx.today} idColumn={view.row?.id}
      onOpen={view.opens ? (id, title) => ctx.open(id, title) : undefined} />;
  }
  const shown = peek !== null ? { ...result, rows: (result.rows ?? []).slice(0, peek) } : result;
  // A row opens its own page (Activity) or the view's; the rail's ctx opens it through the Dashboard's stack.
  return <Body result={shown} ctx={{ ...ctx, open: (id, title, own) => ctx.open(id, title, own || view.opens) }} canOpen={Boolean(view.opens)} actions={view.actions} />;
}

type Accounts = Array<{ id: number; name: string }>;

/** A bank statement in: dropped on the page or chosen, sent to the Space, then read into Money (asking which account when the agent cannot tell). */
function StatementDrop({ machine, project, onRead }: { machine: string; project: string; onRead: () => void }) {
  const app = useApp();
  const root = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ file: string; name: string; accounts: Accounts } | null>(null);

  const read = async (file: string, name: string, account?: number) => {
    setBusy(`Reading ${name}…`);
    try {
      const done = (await api.readStatement(machine, project, { file, name, ...(account ? { account_id: account } : {}) })) as { summary?: string; note?: string } | null;
      setAsking(null);
      app.toast([done?.summary ?? "Read.", done?.note].filter(Boolean).join(" "));
      onRead();
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 409 && account === undefined) {
        const raw = await api.view(machine, project, "accounts").catch(() => null);
        const rows = raw ? parseViewResult(raw).rows ?? [] : [];
        const accounts = rows.flatMap((r) => (typeof r.id === "number" && typeof r.name === "string" ? [{ id: r.id, name: r.name }] : []));
        if (accounts.length) return setAsking({ file, name, accounts });
      }
      app.toast(`Not read: ${msg(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const take = async (path: string) => {
    if (!isStatementFile(path)) return app.toast("A statement is a CSV or a PDF.");
    const name = path.split(/[\\/]/).pop() ?? "statement";
    setBusy(`Sending ${name}…`);
    try {
      const added = (await api.addStatement(machine, project, path)) as { file?: string } | null;
      if (!added?.file) throw new Error("the computer did not keep it");
      await read(added.file, name);
    } catch (e) {
      setBusy(null);
      app.toast(`Not sent: ${msg(e)}`);
    }
  };

  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        // Only while this page is on screen.
        // A photo is a receipt: ReceiptDrop takes those.
        const dropped = e.payload.type === "drop" ? e.payload.paths.filter((p) => !receipts.isReceiptFile(p)) : [];
        if (dropped.length && root.current?.offsetParent) void take(dropped[0]!);
      })
      .then((f) => (gone ? f() : (off = f)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, [machine, project]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async () => {
    try {
      const picked = await openDialog({ title: "Add a bank statement", multiple: false, directory: false, filters: [{ name: "Statements", extensions: ["csv", "pdf", "CSV", "PDF"] }] });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (path) void take(path);
    } catch (e) {
      app.toast(msg(e));
    }
  };

  return (
    <div ref={root} className="fin-card wide fin-drop">
      <span className="fin-drop-icon" aria-hidden>↑</span>
      <span className="grow">
        <b>{busy ?? "Drop a bank statement here"}</b>
        <span className="dim">CSV or PDF. Lines already in the books are matched, the rest wait for you; trusted senders are recorded.</span>
      </span>
      <Button small kind="primary" disabled={busy !== null} onClick={() => void choose()}>Choose a file</Button>
      {asking && (
        <Dialog title="Which account is it for?" onClose={() => setAsking(null)} buttons={<Button onClick={() => setAsking(null)}>Cancel</Button>}>
          <p className="dim">{asking.name}: the statement does not say, and Money keeps more than one account.</p>
          <div className="fin-accounts">
            {asking.accounts.map((a) => <Button key={a.id} onClick={() => void read(asking.file, asking.name, a.id)}>{a.name}</Button>)}
          </div>
        </Dialog>
      )}
    </div>
  );
}

/**
 * Receipts in: photos dropped on the page or chosen, sent to the Space, then read. Nothing is
 * recorded here: the agent proposes each expense and asks the person once, on a card.
 */
function ReceiptDrop({ machine, project }: { machine: string; project: string }) {
  const app = useApp();
  const root = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // A second drop while the first is going would send two reads for one stack.
  const working = useRef(false);

  const take = async (paths: readonly string[]) => {
    if (working.current) return app.toast("The last receipts are still being sent. Add these when they are done.");
    const { send, refused } = receipts.plan(paths);
    for (const why of refused) app.toast(why);
    if (send.length === 0) return;
    working.current = true;
    const kept: string[] = [];
    try {
      for (const [i, path] of send.entries()) {
        setBusy(receipts.sendingLine(i, send.length));
        try {
          const added = (await api.addReceipt(machine, project, path)) as { file?: string } | null;
          if (!added?.file) throw new Error("the computer did not keep it");
          kept.push(added.file);
        } catch (e) {
          const status = e instanceof api.ApiError ? e.status : 0;
          app.toast(`${receipts.baseName(path)} was not sent: ${receipts.failure(status, msg(e))}`);
          // No Money here: the others would be refused the same way.
          if (status === 404) return;
        }
      }
      // The same photo chosen twice is one file on the computer.
      const files = [...new Set(kept)];
      if (files.length === 0) return;
      setBusy("Starting…");
      try {
        await api.readReceipts(machine, project, files);
        app.toast(receipts.readingLine(files.length));
      } catch (e) {
        app.toast(`The receipts were sent but not read: ${receipts.failure(e instanceof api.ApiError ? e.status : 0, msg(e))}`);
      }
    } finally {
      working.current = false;
      setBusy(null);
    }
  };

  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        // Only while this page is on screen, and only photos: a CSV or PDF is a statement.
        const dropped = e.payload.type === "drop" ? e.payload.paths.filter(receipts.isReceiptFile) : [];
        if (dropped.length && root.current?.offsetParent) void take(dropped);
      })
      .then((f) => (gone ? f() : (off = f)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, [machine, project]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async () => {
    try {
      const picked = await openDialog({ title: "Add receipts", multiple: true, directory: false, filters: [{ name: "Photos", extensions: receipts.EXTENSIONS.flatMap((x) => [x, x.toUpperCase()]) }] });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (paths.length) void take(paths);
    } catch (e) {
      app.toast(msg(e));
    }
  };

  return (
    <div ref={root} className="fin-card wide fin-drop">
      <span className="fin-drop-icon" aria-hidden>＋</span>
      <span className="grow">
        <b>{busy ?? "Drop receipts here"}</b>
        <span className="dim">Photos (PNG or JPEG), up to {receipts.READ_MAX} at a time. {APP_NAME} reads each one, then a card asks you before anything is recorded.</span>
      </span>
      <Button small kind="primary" disabled={busy !== null} onClick={() => void choose()}>Add receipts</Button>
    </div>
  );
}
