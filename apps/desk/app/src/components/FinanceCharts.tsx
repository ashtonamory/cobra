/**
 * The Finance rail's own charts: drawn in SVG and HTML with the --fin tokens
 * (styles/finance.css), every number also written out so no colour stands alone. Where things go is
 * lib/finance.ts; the other chart types are BoardCharts.tsx's.
 */
import type { ReactNode } from "react";
import { formatCell } from "../../../../../packages/contracts/src/viewsRead.ts";
import type { ChartSpec, TableColumn, ViewResult, ViewRow } from "../../../../../packages/contracts/src/views.ts";
import { calendarWeeks, riverLayout, ringScore, spreadLabels, RIVER_NODE_WIDTH } from "../lib/finance.ts";
import type { Draw } from "./BoardCharts.tsx";
import { cls } from "./ui.tsx";

const toneOf = (value: unknown): string | null => (value === "good" || value === "warn" || value === "bad" ? value : null);

/** A ring chart: its score as a ring with the label under it, its rows the checks beside it. */
export function Ring({ result, chart }: { result: ViewResult; chart: ChartSpec }) {
  const spec = chart.ring;
  if (!spec) return null;
  const score = ringScore(result.rows, spec.value);
  const R = 46;
  const C = 2 * Math.PI * R;
  return (
    <div className="fin-ring">
      <svg viewBox="0 0 120 120" className="fin-ring-svg" role="img" aria-label={`${spec.label}: ${score}%`}>
        <circle cx="60" cy="60" r={R} className="fin-ring-track" />
        <circle cx="60" cy="60" r={R} className="fin-ring-lit" strokeDasharray={`${(C * score) / 100} ${C}`} transform="rotate(-90 60 60)" />
        <text x="60" y="58" textAnchor="middle" className="fin-ring-value">{score}%</text>
        <text x="60" y="76" textAnchor="middle" className="fin-ring-label">{spec.label}</text>
      </svg>
      <ul className="fin-checks">
        {(result.rows ?? []).map((row, i) => {
          const tone = toneOf(chart.tone ? row[chart.tone] : null);
          return (
            <li key={`${String(row[chart.x])}:${i}`} className={cls("fin-check", tone && `t-${tone}`)}>
              <span className="fin-check-mark" aria-hidden>{tone === "good" ? "✓" : tone === "bad" ? "!" : "•"}</span>
              <span className="grow">
                <span className="fin-check-title">{String(row[chart.x] ?? "")}</span>
                {chart.caption && row[chart.caption] !== null && <span className="dim">{String(row[chart.caption] ?? "")}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const RIVER_W = 860;
const RIVER_H = 240;
const LABEL_W = 160;
/** Two lines of label, name and amount. */
const LABEL_GAP = 32;

/** A river: money in on the left, through the middle, out on the right; each band its row, each node named with its amount. */
export function River({ result, chart, draw }: { result: ViewResult; chart: ChartSpec; draw: Draw }) {
  const spec = chart.river;
  const value = chart.series[0]?.column;
  if (!spec || !value) return null;
  const layout = riverLayout(result.rows ?? [], spec.from, spec.to, value, RIVER_W - 2 * LABEL_W, RIVER_H);
  if (!layout.nodes.length) return <div className="dim chart-empty">{chart.empty ?? "Nothing flowed this month."}</div>;
  const money = (n: number) => formatCell(n, chart.format ?? "money", draw.currency, draw.today);
  const last = layout.columns - 1;
  // Each end column's labels, spread so a thin band's name never sits on its neighbour's.
  const labelY = new Map<string, number>();
  for (const depth of new Set([0, last])) {
    const col = layout.nodes.filter((n) => n.depth === depth);
    spreadLabels(col.map((n) => n.y + n.h / 2), LABEL_GAP, RIVER_H - LABEL_GAP / 2).forEach((y, i) => labelY.set(col[i]!.name, y));
  }
  // The kept or saved band is the hero; the rest are grey.
  const hero = (name: string) => /^(Kept|Saved)$/.test(name);
  return (
    <svg viewBox={`0 -14 ${RIVER_W} ${RIVER_H + 28}`} className="fin-river" role="img" aria-label="Where the money went">
      <g transform={`translate(${LABEL_W},0)`}>
        {layout.bands.map((band) => (
          <path key={`${band.from}>${band.to}`} d={band.path} className={cls("fin-band", hero(band.to) && "hero")}>
            <title>{`${band.from} → ${band.to}: ${money(band.value)}`}</title>
          </path>
        ))}
        {layout.nodes.map((node) => (
          <g key={node.name}>
            <rect x={node.x} y={node.y} width={RIVER_NODE_WIDTH} height={Math.max(1, node.h)} rx={3} className={cls("fin-node", hero(node.name) && "hero")} />
            {(node.depth === 0 || node.depth === last) && (
              <text x={node.depth === 0 ? node.x - 8 : node.x + RIVER_NODE_WIDTH + 8} y={labelY.get(node.name) ?? node.y + node.h / 2} dy="-0.15em"
                textAnchor={node.depth === 0 ? "end" : "start"} className={cls("fin-node-name", hero(node.name) && "hero")}>
                {node.name}
                <tspan x={node.depth === 0 ? node.x - 8 : node.x + RIVER_NODE_WIDTH + 8} dy="1.15em" className="fin-node-value">{money(node.value)}</tspan>
              </text>
            )}
            {node.depth !== 0 && node.depth !== last && (
              <text x={node.x + RIVER_NODE_WIDTH / 2} y={Math.max(12, node.y - 6)} textAnchor="middle" className="fin-node-name">{node.name} · {money(node.value)}</text>
            )}
          </g>
        ))}
      </g>
    </svg>
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A calendar: the board's month as a grid, each bill on its day with its amount. */
export function Calendar({ result, chart, draw, month }: { result: ViewResult; chart: ChartSpec; draw: Draw; month: string }) {
  const amount = chart.series[0]?.column ?? "";
  const weeks = calendarWeeks(month, result.rows ?? [], chart.x, amount, chart.caption, draw.today);
  const total = (result.rows ?? []).reduce((sum, row) => sum + (typeof row[amount] === "number" ? (row[amount] as number) : 0), 0);
  return (
    <div className="fin-cal">
      <div className="fin-cal-grid" role="grid" aria-label="Due this month">
        {WEEKDAYS.map((d) => <div key={d} className="fin-cal-head" role="columnheader">{d}</div>)}
        {weeks.flat().map((day, i) => (
          <div key={day?.day ?? `blank-${i}`} role="gridcell" className={cls("fin-cal-day", !day && "blank", day?.today && "today", (day?.items.length ?? 0) > 0 && "due")}>
            {day && <span className="fin-cal-date">{day.date}</span>}
            {day?.items.map((item, j) => (
              <span key={`${item.name}:${j}`} className="fin-cal-item" title={`${item.name}: ${item.amount === null ? "" : formatCell(item.amount, chart.format, draw.currency, draw.today)}`}>
                <span className="fin-cal-name">{item.name}</span>
                {item.amount !== null && <span className="fin-cal-amount">{formatCell(item.amount, chart.format, draw.currency, draw.today)}</span>}
              </span>
            ))}
          </div>
        ))}
      </div>
      {(result.rows ?? []).length === 0
        ? <div className="dim chart-empty">{chart.empty ?? "Nothing due this month."}</div>
        : <div className="dim">{(result.rows ?? []).length} due · {formatCell(total, chart.format, draw.currency, draw.today)} in all</div>}
    </div>
  );
}

/** A table with the columns its view names, each cell in its format and its tone column's colour; a row opens when `onOpen` is given. */
export function FinTable({ rows, columns, currency, today, idColumn, onOpen }: {
  rows: readonly ViewRow[]; columns: readonly TableColumn[]; currency: string; today: string; idColumn?: string; onOpen?: (id: string, title: string) => void;
}): ReactNode {
  if (!rows.length) return <div className="dim dash-empty">Nothing here yet.</div>;
  return (
    <table className="fin-table">
      <thead>
        <tr>{columns.map((c, i) => <th key={c.column} className={i === 0 ? "left" : undefined}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, r) => {
          const id = idColumn && row[idColumn] !== null && row[idColumn] !== undefined ? String(row[idColumn]) : null;
          const title = String(row[columns[0]?.column ?? ""] ?? "");
          return (
            <tr key={id ?? r} className={cls(onOpen && id && "click", toneOf(row.tone) && `t-${toneOf(row.tone)}`)} onClick={onOpen && id ? () => onOpen(id, title) : undefined}>
              {columns.map((c, i) => {
                const tone = c.tone ? toneOf(row[c.tone]) : null;
                const value = row[c.column];
                const text = c.format === "percent" && typeof value === "number" ? `${value > 0 ? "+" : ""}${value}%` : formatCell(value ?? null, c.format, currency, today);
                return <td key={c.column} className={cls(i === 0 && "left", tone && `t-${tone}`)}>{text}</td>;
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
