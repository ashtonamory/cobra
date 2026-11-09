/**
 * Boards Cobra made for a Space. `CobraBoard` is one as a tab of the Space's screen: its widgets drawn as a
 * trade's board is (BoardCharts.tsx's charts, Dashboard.tsx's tiles and rows), read through
 * `/board/view`, a chart's drill opening its list below; edits are chat only, so its ⋯ menu offers
 * Change it with Cobra… (her box with the Space's chip set) and Remove board. `BoardPreview` is her
 * card's live preview: each widget with the rows it had when she made it.
 */
import { useState } from "react";
import { useApp } from "../app/context.ts";
import * as api from "../lib/api.ts";
import { askCobraWith } from "../lib/cobraDraft.ts";
import { boardPreview, type BoardInfo } from "../../../../../packages/contracts/src/boards.ts";
import { localToday, parseViewResult } from "../../../../../packages/contracts/src/viewsRead.ts";
import type { ApprovalBoard } from "../../../../../packages/contracts/src/approvals.ts";
import type { ViewResult } from "../../../../../packages/contracts/src/views.ts";
import { Board, ChartBody, Kpis, type Draw, type Drill, type Read } from "./BoardCharts.tsx";
import { Body, plainCtx } from "./Dashboard.tsx";
import { Confirm } from "./Verbs.tsx";
import { useMenu } from "./ui.tsx";
import { LEAD_NAME } from "../lib/appName.ts";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Widget({ read, currency }: { read: Read | undefined; currency: string }) {
  if (!read) return <div className="dim chart-empty">Reading…</div>;
  if ("error" in read) return <div className="dim chart-empty">Could not read it: {read.error}</div>;
  return <Body result={read} ctx={plainCtx(currency)} canOpen={false} />;
}

export function CobraBoard({ machine, project, board, currency, space, onRemoved }: {
  machine: string; project: string; board: BoardInfo; currency: string; space: string | null; onRemoved: () => void;
}) {
  const app = useApp();
  const [drill, setDrill] = useState<(Drill & { read?: Read }) | null>(null);
  const [menu, openMenu] = useMenu();
  const [removing, setRemoving] = useState(false);
  const read = (view: { id: string }, input: { range?: string; key?: string }) => api.boardView(machine, project, board.id, view.id, input);
  const change = () => {
    askCobraWith(`Change the ${board.title} board: `, space ?? undefined);
    app.show("ops");
  };
  const openDrill = (d: Drill) => {
    setDrill(d);
    read({ id: d.view }, { key: d.key, range: d.range }).then(
      (raw) => setDrill((cur) => (cur?.key === d.key && cur.view === d.view ? { ...cur, read: parseViewResult(raw) } : cur)),
      (e) => setDrill((cur) => (cur?.key === d.key && cur.view === d.view ? { ...cur, read: { error: msg(e) } } : cur)),
    );
  };
  const drillTitle = drill ? `${board.views.find((v) => v.id === drill.view)?.title ?? "Details"}: ${drill.title}` : "";

  return (
    <div className="cobra-board">
      <div className="cobra-board-head">
        <span className="space-tab-dot" title={`Made by ${LEAD_NAME}`} />
        <span className="dim grow">{board.describe || `Made by ${LEAD_NAME}.`}</span>
        <button className="linkish cobra-board-more" aria-label="Board menu" onClick={(e) => openMenu(e.clientX, e.clientY, [
          { label: `Change it with ${LEAD_NAME}…`, onClick: change },
          { label: "Remove board", danger: true, onClick: () => setRemoving(true) },
        ])}>⋯</button>
      </div>
      <Board views={board.views} currency={currency} round={0} today={localToday()} onDrill={openDrill}
        read={(view, range) => read(view, range ? { range } : {})}
        other={(_view, r) => <Widget read={r} currency={currency} />} />
      {drill && (
        <div className="chart-card cobra-board-drill">
          <div className="chart-card-head">
            <b>{drillTitle}</b>
            <button className="linkish" onClick={() => setDrill(null)}>Close</button>
          </div>
          <Widget read={drill.read} currency={currency} />
        </div>
      )}
      {menu}
      {removing && (
        <Confirm title={`Remove the ${board.title} board?`} body={`It leaves this Space's tabs. Nothing it reads changes, and ${LEAD_NAME} can make it again.`} yes="Remove" danger
          onClose={() => setRemoving(false)}
          onYes={() => {
            setRemoving(false);
            void api.boardRemove(machine, project, board.id).then(onRemoved, (e) => app.toast(`Could not remove it: ${msg(e)}`));
          }} />
      )}
    </div>
  );
}

/** Cobra's card's preview: each widget as it read when she made it (no drill, no range switch). */
export function BoardPreview({ board }: { board: ApprovalBoard }) {
  const parts = boardPreview(board).filter((p) => !p.view.fromChart);
  if (!parts.length) return null;
  const draw: Draw = { currency: board.currency, today: localToday(), compare: false, drill: () => {} };
  const one = (result: ViewResult) => (result.chart?.type === "kpi" ? <Kpis read={result} draw={draw} /> : result.chart ? <ChartBody read={result} draw={draw} /> : <Widget read={result} currency={board.currency} />);
  return (
    <div className="board-preview">
      {parts.map(({ view, result }) => (
        <div key={view.id} className="chart-card">
          <div className="chart-card-head"><b>{view.title}</b></div>
          {one(result)}
        </div>
      ))}
    </div>
  );
}
