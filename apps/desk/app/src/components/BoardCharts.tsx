/**
 * A trade's board on the desk: its
 * chart views above the dashboard's tabs, drawn in SVG, with one range switch
 * and Compare for the whole board. A tap on a bar, part or bucket opens the
 * list its chart names (`drill`) with that value as `key`. What the numbers
 * mean is contracts charts.ts, shared with the phone; where the marks go is
 * lib/chartGeometry.ts. Colours are the --chart-* tokens (styles/app.css), and
 * every value is also written out (legend, tooltip, labels), so no colour
 * stands alone. A board with a view that follows the month (`monthly`, a
 * personal budget's) gets one month switch, "‹ November 2026 ›", sent with
 * every read and drill; its lists on the board (`onBoard`) are drawn by
 * `other`, in the order the trade gives them, after the KPIs. The phone's
 * components/BoardCharts.tsx draws the same: change both together.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { buckets, chartData, chartEmpty, compactValue, donutParts, funnelSteps, kpiCards, meters, monthOf, monthTitle, niceScale, RANGE_BEFORE, RANGE_LABELS, shiftMonth, type ChartData } from "../../../../../packages/contracts/src/charts.ts";
import { isEmptyRead, parseViewResult, formatCell } from "../../../../../packages/contracts/src/viewsRead.ts";
import { DEFAULT_RANGE, RANGE_KEYS, type ChartSpec, type PublicView, type RangeKey, type ViewResult } from "../../../../../packages/contracts/src/views.ts";
import { arcPath, bands, barPath, donutAngles, groupBars, hbarPath, sparkPoints, yOf } from "../lib/chartGeometry.ts";
import { cls } from "./ui.tsx";

export type Drill = { view: string; key: string; title: string; range: RangeKey; month?: string };
export type Read = ViewResult | { error: string };
export type Draw = { currency: string; today: string; compare: boolean; drill: (key: string, label: string) => void };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const slot = (i: number): string => (i < 0 || i > 4 ? "ch-other" : `ch-s${i}`);

/**
 * A board: its widgets read for the board's range through `read` (a trade's `/view`, a Cobra
 * board's `/board/view`); `round` changes after a write so it reads again. KPIs run across the top,
 * then a card per chart, then a card per other widget (a Cobra board's tiles or list), drawn by `other`.
 */
export function Board({ views, currency, read, round, today, onDrill, other }: {
  views: readonly PublicView[]; currency: string; read: (view: PublicView, range: RangeKey | null, month: string | null) => Promise<unknown>;
  round: number; today: string; onDrill: (drill: Drill) => void; other?: (view: PublicView, read: Read | undefined) => ReactNode;
}) {
  const shown = views.filter((v) => !v.fromChart && (v.kind === "chart" || other !== undefined));
  const charts = shown.filter((v) => v.kind === "chart");
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);
  const [month, setMonth] = useState(() => monthOf(today));
  const [compare, setCompare] = useState(false);
  const [reads, setReads] = useState<Record<string, Read>>({});
  const ids = shown.map((v) => v.id).join(",");

  useEffect(() => {
    let live = true;
    for (const view of shown) {
      read(view, view.chart?.ranged ? range : null, view.monthly ? month : null).then(
        (raw) => live && setReads((r) => ({ ...r, [view.id]: parseViewResult(raw) })),
        (e) => live && setReads((r) => ({ ...r, [view.id]: { error: msg(e) } })),
      );
    }
    return () => void (live = false);
    // The widgets are read through `ids`: a new list with the same widgets reads nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, range, month, round]);

  if (!shown.length) return null;
  const ranged = charts.some((v) => v.chart?.ranged);
  const monthly = shown.some((v) => v.monthly);
  const latest = month >= monthOf(today);
  const comparable = range !== "all" && charts.some((v) => v.chart?.compare && v.chart.type !== "kpi");
  const draw = (view: PublicView): Draw => ({
    currency, today, compare: compare && comparable,
    drill: (key, label) => view.chart?.drill && onDrill({ view: view.chart.drill, key, title: label, range, ...(view.monthly ? { month } : {}) }),
  });
  // A view that asks to be left off while empty (a CRM with no deals) shows only once its read has something in it.
  const there = (v: PublicView): boolean => {
    if (!v.hideEmpty) return true;
    const r = reads[v.id];
    return r !== undefined && ("error" in r || !isEmptyRead(r));
  };
  const kpis = charts.filter((v) => v.chart?.type === "kpi" && there(v));
  const rest = shown.filter((v) => v.chart?.type !== "kpi" && there(v));
  const when = (view: PublicView): string => (view.monthly ? monthTitle(month) : view.chart?.ranged ? RANGE_LABELS[range] : view.kind === "chart" ? "Today" : "");

  return (
    <div className="chart-board">
      {monthly && (
        <div className="chart-months">
          <button className="chart-month-step" aria-label={`Back to ${monthTitle(shiftMonth(month, -1))}`} onClick={() => setMonth((m) => shiftMonth(m, -1))}>‹</button>
          <b className="chart-month">{monthTitle(month)}</b>
          <button className="chart-month-step" aria-label={`On to ${monthTitle(shiftMonth(month, 1))}`} disabled={latest} onClick={() => setMonth((m) => shiftMonth(m, 1))}>›</button>
        </div>
      )}
      {ranged && (
        <div className="chart-controls">
          <div className="dash-tabs" role="radiogroup" aria-label="Range">
            {RANGE_KEYS.map((key) => (
              <button key={key} role="radio" aria-checked={key === range} className={cls("dash-tab", key === range && "on")} onClick={() => setRange(key)}>{RANGE_LABELS[key]}</button>
            ))}
          </div>
          {comparable && (
            <label className="chart-compare">
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare with the period before
            </label>
          )}
        </div>
      )}
      {kpis.map((view) => <Kpis key={view.id} read={reads[view.id]} draw={draw(view)} />)}
      {rest.length > 0 && (
        <div className="chart-grid">
          {rest.map((view) => (
            <div key={view.id} className="chart-card">
              <div className="chart-card-head">
                <b>{view.title}</b>
                {when(view) && <span className="dim">{when(view)}</span>}
              </div>
              {view.kind === "chart" ? <ChartBody read={reads[view.id]} draw={draw(view)} /> : other!(view, reads[view.id])}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChartBody({ read, draw }: { read: Read | undefined; draw: Draw }): ReactNode {
  if (!read) return <div className="dim chart-empty">Reading…</div>;
  if ("error" in read) return <div className="dim chart-empty">Could not read it: {read.error}</div>;
  const chart = read.chart;
  if (!chart) return <div className="dim chart-empty">This chart is not one this desk draws yet.</div>;
  if (chart.type === "donut") return <Donut result={read} chart={chart} draw={draw} />;
  if (chart.type === "buckets") return <Buckets result={read} chart={chart} draw={draw} />;
  if (chart.type === "funnel") return <Funnel result={read} chart={chart} draw={draw} />;
  if (chart.type === "meter") return <Meters result={read} chart={chart} draw={draw} />;
  if (chart.type === "hero") return <Hero result={read} chart={chart} draw={draw} />;
  const data = chartData(read);
  if (chartEmpty(data)) return <div className="dim chart-empty">{chart.empty ?? "Nothing in this range yet."}</div>;
  return <Plot data={data} chart={chart} draw={draw} />;
}

/** The width an SVG really has, so its text is drawn at its own size; until it is measured the drawing scales to fit (`ch-fit`). */
function useWidth(fallback: number): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(([entry]) => entry && entry.contentRect.width > 0 && setWidth(Math.round(entry.contentRect.width)));
    watch.observe(node);
    return () => watch.disconnect();
  }, []);
  return [ref, width];
}

function full(value: number, chart: Pick<ChartSpec, "format">, draw: Draw): string {
  return formatCell(value, chart.format, draw.currency, draw.today) || "0";
}

// --- KPI ---------------------------------------------------------------------------

export function Kpis({ read, draw }: { read: Read | undefined; draw: Draw }) {
  if (!read || "error" in read || !read.chart) return <div className="kpi-row"><div className="kpi dim">{read && "error" in read ? `Could not read it: ${read.error}` : "Reading…"}</div></div>;
  const since = read.range ? RANGE_BEFORE[read.range.key] : "";
  return (
    <div className="kpi-row">
      {kpiCards(read).map((card) => (
        <div key={card.column} className="kpi">
          <div className="kpi-top">
            <span className="kpi-label">{card.label}</span>
            {card.spark.length > 1 && (
              <svg className="kpi-spark" width="72" height="24" viewBox="0 0 72 24" aria-hidden="true">
                <polyline points={sparkPoints(card.spark, 72, 24)} />
              </svg>
            )}
          </div>
          <span className="kpi-value" title={full(card.value, card, draw)}>{compactValue(card.value, card.format, draw.currency)}</span>
          <span className="kpi-foot">
            {card.change && <span className={cls("kpi-change", card.change.good === true && "good", card.change.good === false && "bad")}>{card.change.text}</span>}
            {card.change && since && <span className="dim">{since}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// --- bars and lines ----------------------------------------------------------------------

const PAD = { left: 48, right: 10, top: 12, bottom: 26 };
const HEIGHT = 210;

function Plot({ data, chart, draw }: { data: ChartData; chart: ChartSpec; draw: Draw }) {
  const [ref, width] = useWidth(520);
  const [hover, setHover] = useState<number | null>(null);
  const lines = chart.type === "line";
  const barSeries = lines ? [] : data.series.filter((s) => !s.line);
  const lineSeries = lines ? data.series : data.series.filter((s) => s.line);
  const values: number[] = [];
  for (const s of data.series) {
    values.push(...s.values);
    if (draw.compare && s.previous) values.push(...s.previous);
  }
  if (chart.stack && barSeries.length) values.push(...data.keys.map((_, i) => barSeries.reduce((sum, s) => sum + Math.max(0, s.values[i] ?? 0), 0)));
  const scale = niceScale(Math.min(...values), Math.max(...values));
  const bottom = HEIGHT - PAD.bottom;
  const y = (v: number) => yOf(v, scale.min, scale.max, PAD.top, bottom);
  const base = y(0);
  const cols = bands(data.keys.length, PAD.left, width - PAD.right, barSeries.length > 1 && !chart.stack ? 0.72 : 0.5);
  const every = Math.max(1, Math.ceil(data.keys.length / Math.max(1, Math.floor((width - PAD.left) / 44))));
  const at = hover === null ? null : cols[hover];

  return (
    <div className="chart-plot" ref={ref}>
      <svg className="ch-fit" viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={`${data.series.map((s) => s.label).join(", ")} by ${chart.xKind === "month" ? "month" : "group"}`}>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? "ch-base" : "ch-grid"} x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="ch-tick" x={PAD.left - 6} y={y(t) + 3.5} textAnchor="end">{compactValue(t, chart.format, draw.currency)}</text>
          </g>
        ))}
        {at && <rect className="ch-band" x={at.start} y={PAD.top} width={at.size} height={bottom - PAD.top} rx={6} />}
        {cols.map((col, i) => {
          if (chart.stack) {
            let top = 0;
            return (
              <g key={i}>
                {barSeries.map((s, si) => {
                  const v = Math.max(0, s.values[i] ?? 0);
                  const last = barSeries.slice(si + 1).every((o) => (o.values[i] ?? 0) <= 0);
                  // Each segment sits 2px above the one below; only the top one is rounded.
                  const lo = y(top) - (top > 0 ? 2 : 0);
                  top += v;
                  const d = last ? barPath(col.center - col.width / 2, col.width, lo, y(top)) : `M${col.center - col.width / 2} ${lo}V${y(top)}H${col.center + col.width / 2}V${lo}Z`;
                  return v > 0 ? <path key={s.column} className={slot(data.series.indexOf(s))} d={d} /> : null;
                })}
              </g>
            );
          }
          const group = groupBars(barSeries.length, col.center, col.width);
          return (
            <g key={i}>
              {barSeries.map((s, si) => {
                const g = group[si]!;
                const prev = draw.compare ? s.previous?.[i] ?? 0 : 0;
                const inset = draw.compare ? g.width * 0.22 : 0;
                return (
                  <g key={s.column} className={slot(data.series.indexOf(s))}>
                    {draw.compare && <path className="ch-ghost" d={barPath(g.x, g.width, base, y(prev))} />}
                    <path d={barPath(g.x + inset, g.width - inset * 2, base, y(s.values[i] ?? 0))} />
                  </g>
                );
              })}
            </g>
          );
        })}
        {lineSeries.map((s) => {
          const k = slot(data.series.indexOf(s));
          const pts = (vals: number[]) => cols.map((c, i) => `${c.center},${y(vals[i] ?? 0)}`).join(" ");
          return (
            <g key={s.column} className={k}>
              {draw.compare && s.previous && <polyline className="ch-line ch-line-ghost" points={pts(s.previous)} />}
              <polyline className="ch-line" points={pts(s.values)} />
              {cols.map((c, i) => <circle key={i} className="ch-dot" cx={c.center} cy={y(s.values[i] ?? 0)} r={hover === i ? 5 : 4} />)}
            </g>
          );
        })}
        {cols.map((col, i) => (i % every === 0 || i === cols.length - 1) && (i % every === 0 || cols.length - 1 - i >= every) ? (
          <text key={i} className="ch-tick" x={col.center} y={HEIGHT - 8} textAnchor="middle">{data.labels[i]}</text>
        ) : null)}
        {cols.map((col, i) => (
          <rect key={i} className={cls("ch-hit", chart.drill && "click")} x={col.start} y={PAD.top} width={col.size} height={bottom - PAD.top}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))}
            onClick={() => chart.drill && draw.drill(data.keys[i]!, data.labels[i]!)} />
        ))}
      </svg>
      {at && hover !== null && (
        <div className={cls("chart-tip", at.center > width * 0.6 && "left")} style={at.center > width * 0.6 ? { right: width - at.start + 6 } : { left: at.start + at.size + 6 }}>
          <b>{chart.xKind === "month" ? monthName(data.keys[hover]!) : data.labels[hover]}</b>
          {data.series.map((s) => (
            <div key={s.column} className="chart-tip-row">
              <span className={cls("ch-swatch", slot(data.series.indexOf(s)), s.line && "line")} />
              <span className="grow">{s.label}</span>
              <b>{full(s.values[hover] ?? 0, chart, draw)}</b>
              {draw.compare && s.previous && <span className="dim">was {compactValue(s.previous[hover] ?? 0, chart.format, draw.currency)}</span>}
            </div>
          ))}
        </div>
      )}
      <Legend items={data.series.map((s, i) => ({ label: s.label, slot: i, line: s.line || lines, value: compactValue(s.values.reduce((a, b) => a + b, 0), chart.format, draw.currency) }))} ghost={draw.compare} />
    </div>
  );
}

const monthName = (key: string): string => {
  const d = new Date(`${key}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? key : d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};

/** Each series named, with its total over the range written out: a value never rests on its colour alone. */
function Legend({ items, ghost }: { items: { label: string; slot: number; line?: boolean; value: string }[]; ghost: boolean }) {
  return (
    <div className="chart-legend">
      {items.map((item) => (
        <span key={item.label} className="chart-legend-item">
          <span className={cls("ch-swatch", slot(item.slot), item.line && "line")} />{item.label}<b className="chart-legend-value">{item.value}</b>
        </span>
      ))}
      {ghost && <span className="chart-legend-item"><span className="ch-swatch ghost" />The period before</span>}
    </div>
  );
}

// --- donut --------------------------------------------------------------------------

// --- meters: spent (and bills still to come) against a limit ---------------------------

/** A bar of spent, then committed (fainter), against the limit, in the tone of how full it is. */
function MeterBar({ spent, committed, tone, thick }: { spent: number; committed: number; tone: "good" | "warn" | "bad"; thick?: boolean }) {
  const pct = (share: number) => `${Math.round(share * 1000) / 10}%`;
  return (
    <div className={cls("meter-track", thick && "thick")} aria-hidden="true">
      <span className={`meter-fill tone-${tone}`} style={{ width: pct(spent) }} />
      {committed > 0 && <span className={`meter-fill tone-${tone} later`} style={{ width: pct(committed) }} />}
    </div>
  );
}

/**
 * Meters: a chart that `reads: "left"` is one hero (what is
 * left, large, with its bar and caption); any other is a list of rows (a budget's categories), each
 * name, spent of limit, bar and caption, a click opening its list (`drill`).
 */
/** A hero: the month's one number from the last row, its caption and the other series as figures. The phone adds six months of bars. */
function Hero({ result, chart, draw }: { result: ViewResult; chart: ChartSpec; draw: Draw }) {
  const last = (result.rows ?? []).at(-1);
  if (!last || !chart.hero) return <div className="dim chart-empty">{chart.empty ?? "Nothing this month yet."}</div>;
  const num = (column: string): number | null => (typeof last[column] === "number" ? (last[column] as number) : null);
  const value = num(chart.hero.column) ?? 0;
  const caption = chart.caption ? String(last[chart.caption] ?? "") : "";
  const bad = chart.tone ? last[chart.tone] === "bad" : false;
  return (
    <div className="meter-hero">
      <div className="dim meter-caption">{chart.hero.label}</div>
      <div className={cls("meter-hero-value", bad && "tone-bad-text")}>{full(value, chart, draw)}</div>
      {caption && <div className="dim meter-line">{caption}</div>}
      <div className="dim meter-line">
        {chart.series.filter((s) => num(s.column) !== null).map((s) => `${s.label} ${compactValue(num(s.column) ?? 0, chart.format, draw.currency)}`).join(" · ")}
      </div>
    </div>
  );
}

function Meters({ result, chart, draw }: { result: ViewResult; chart: ChartSpec; draw: Draw }) {
  const bars = meters(result);
  if (!bars.length) return <div className="dim chart-empty">{chart.empty ?? "Nothing this month yet."}</div>;
  const money = (cents: number) => compactValue(cents, chart.format, draw.currency);
  if (chart.reads === "left") {
    const m = bars[0]!;
    return (
      <div className="meter-hero">
        <div className={cls("meter-hero-value", m.over && "tone-bad-text")}>{m.limit > 0 ? `${full(Math.abs(m.left), chart, draw)}${m.left < 0 ? " over" : ""}` : `${full(m.spent, chart, draw)} spent`}</div>
        {m.limit > 0 && <MeterBar spent={m.spentShare} committed={m.committedShare} tone={m.tone} thick />}
        {m.limit > 0 && (
          <div className="dim meter-line">
            {money(m.spent)} spent{m.committed > 0 ? ` · ${money(m.committed)} ${chart.series[1]?.label.toLowerCase() ?? "to come"}` : ""} · of {money(m.limit)}
          </div>
        )}
        {m.caption && <div className="dim meter-caption">{m.caption}</div>}
      </div>
    );
  }
  return (
    <div className="meter-list">
      {bars.map((m) => (
        <button key={m.key} className="meter-row" onClick={() => draw.drill(m.key, m.key)}
          aria-label={`${m.key}: ${full(m.spent, chart, draw)}${m.limit > 0 ? ` of ${full(m.limit, chart, draw)}` : ""}. ${m.caption}`}>
          <span className="meter-head">
            <span className="meter-name">{m.key}</span>
            <span className="meter-amount">{money(m.spent)}{m.limit > 0 && <span className="dim"> / {money(m.limit)}</span>}</span>
          </span>
          {m.limit > 0 && <MeterBar spent={m.spentShare} committed={m.committedShare} tone={m.tone} />}
          {m.caption && <span className={cls("meter-caption", m.over ? "tone-bad-text" : "dim")}>{m.caption}</span>}
        </button>
      ))}
    </div>
  );
}

function Donut({ result, chart, draw }: { result: ViewResult; chart: ChartSpec; draw: Draw }) {
  const parts = donutParts(result);
  const [hover, setHover] = useState<number | null>(null);
  if (!parts.length) return <div className="dim chart-empty">{chart.empty ?? "Nothing in this range yet."}</div>;
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  const angles = donutAngles(parts.map((p) => p.share));
  const shown = hover === null ? null : parts[hover];
  return (
    <div className="chart-donut">
      <svg width="164" height="164" viewBox="0 0 164 164" role="img" aria-label={`${chart.series[0]?.label ?? "Total"} by part`}>
        {parts.map((p, i) => (
          <path key={p.label} className={cls(p.other ? "ch-other" : slot(p.slot), hover !== null && hover !== i && "ch-faded", chart.drill && !p.other && "click")}
            d={arcPath(82, 82, hover === i ? 78 : 74, 50, angles[i]!.a0, angles[i]!.a1)}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            onClick={() => chart.drill && !p.other && draw.drill(p.key, p.label)} />
        ))}
        <text className="ch-center" x="82" y="82" textAnchor="middle">{compactValue(shown ? shown.value : total, chart.format, draw.currency)}</text>
        <text className="ch-center-sub" x="82" y="100" textAnchor="middle">{shown ? `${Math.round(shown.share * 100)}%` : "in all"}</text>
      </svg>
      <div className="chart-parts">
        {parts.map((p, i) => {
          const was = draw.compare && p.previous !== null ? p.previous : null;
          return (
            <button key={p.label} className={cls("chart-part", hover === i && "on")} disabled={!chart.drill || p.other}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => draw.drill(p.key, p.label)}>
              <span className={cls("ch-swatch", p.other ? "ch-other" : slot(p.slot))} />
              <span className="grow chart-part-label">{p.label}</span>
              <b>{compactValue(p.value, chart.format, draw.currency)}</b>
              <span className="dim chart-part-share">{Math.round(p.share * 100)}%</span>
              {was !== null && <span className="dim chart-part-was">was {compactValue(was, chart.format, draw.currency)}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- buckets ------------------------------------------------------------------------

function Buckets({ result, chart, draw }: { result: ViewResult; chart: ChartSpec; draw: Draw }) {
  const [ref, width] = useWidth(420);
  const rows = buckets(result);
  if (rows.every((b) => b.value === 0)) return <div className="dim chart-empty">{chart.empty ?? "Nothing here yet."}</div>;
  const max = Math.max(...rows.map((b) => b.value));
  const label = Math.min(150, width * 0.36);
  const valueW = 76;
  const track = Math.max(40, width - label - valueW - 12);
  const rowH = 30;
  return (
    <div className="chart-plot" ref={ref}>
      <svg className="ch-fit" viewBox={`0 0 ${width} ${rows.length * rowH}`} role="img" aria-label={`${chart.series[0]?.label ?? "Value"} by bucket`}>
        {rows.map((b, i) => {
          const y = i * rowH;
          const end = label + (max ? (b.value / max) * track : 0);
          const press = chart.drill && b.value > 0;
          return (
            <g key={b.key} className={cls(press && "click")} onClick={() => press && draw.drill(b.key, b.key)}>
              <rect className="ch-hit" x={0} y={y} width={width} height={rowH} />
              <text className="ch-label" x={0} y={y + rowH / 2 + 4}>{b.key}</text>
              <rect className="ch-track" x={label} y={y + 8} width={track} height={rowH - 16} rx={4} />
              <path className={`ch-l${b.level}`} d={hbarPath(label, end, y + 8, rowH - 16)} />
              <text className={cls("ch-value", b.value === 0 && "zero")} x={width} y={y + rowH / 2 + 4} textAnchor="end">{full(b.value, chart, draw)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// --- funnel -------------------------------------------------------------------------

/** The stages in order, each bar's length its worth, with its count and the share that went on to the next stage written beside it. */
function Funnel({ result, chart, draw }: { result: ViewResult; chart: ChartSpec; draw: Draw }) {
  const [ref, width] = useWidth(420);
  const steps = funnelSteps(result);
  if (steps.every((s) => s.value === 0 && s.count === 0)) return <div className="dim chart-empty">{chart.empty ?? "Nothing here yet."}</div>;
  const max = Math.max(1, ...steps.map((s) => s.value));
  const label = Math.min(130, width * 0.3);
  const valueW = 110;
  const track = Math.max(40, width - label - valueW - 12);
  const rowH = 40;
  return (
    <div className="chart-plot" ref={ref}>
      <svg className="ch-fit" viewBox={`0 0 ${width} ${steps.length * rowH}`} role="img" aria-label={`${chart.series[0]?.label ?? "Worth"} by stage`}>
        {steps.map((step, i) => {
          const y = i * rowH;
          const length = (step.value / max) * track;
          // Centred, so the stages read as a funnel.
          const left = label + (track - length) / 2;
          const press = Boolean(chart.drill) && step.count > 0;
          return (
            <g key={step.key} className={cls(press && "click")} onClick={() => press && draw.drill(step.key, step.key)}>
              <rect className="ch-hit" x={0} y={y} width={width} height={rowH} />
              <text className="ch-label" x={0} y={y + 16}>{step.key}</text>
              {step.onward !== null && <text className="ch-tick" x={0} y={y + 31}>{step.onward}% went on</text>}
              <rect className="ch-track" x={label} y={y + 8} width={track} height={rowH - 18} rx={4} />
              {length >= 1 && <rect className="ch-s0" x={left} y={y + 8} width={length} height={rowH - 18} rx={4} />}
              <text className={cls("ch-value", step.value === 0 && "zero")} x={width} y={y + 16} textAnchor="end">{full(step.value, chart, draw)}</text>
              <text className="ch-tick" x={width} y={y + 31} textAnchor="end">{step.count} {step.count === 1 ? "deal" : "deals"}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
