/**
 * Home's charts, drawn as inline SVG (the desk's ui/charts.py drew them with cairo): today's
 * projects, the budget and the throughput. The data is lib/ops.ts's and the words lib/charts.ts's;
 * the look is the phone's (apps/mobile/src/components/OpsCharts.tsx): hairlines, ink for what
 * works, orange only for what waits on you.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import * as charts from "../lib/charts.ts";
import * as config from "../lib/config.ts";
import type { Dict } from "../lib/json.ts";
import * as ops from "../lib/ops.ts";
import { cls } from "./ui.tsx";

// The desk's Palette: the theme's foreground at a few strengths, orange for what waits on you.
const P = {
  ink: "var(--fg)",
  muted: "rgb(var(--ink) / 0.45)",
  line: "rgb(var(--ink) / 0.22)",
  faint: "rgb(var(--ink) / 0.08)",
  signal: "var(--signal)",
  surface: "var(--bg)",
};
// Pango's 8pt and 7.5pt, in CSS pixels.
const SMALL = 10.5;
const SMALLER = 10;

/** An element's width, kept current as the window changes size: the charts draw to it. */
function useWidth<T extends Element>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** A node's dot: working filled, waiting filled orange, idle an outline, queued a dashed outline. */
function HourScale({ span }: { span: [number, number] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  return (
    <div ref={ref} className="hour-scale">
      <svg width={width} height={16} aria-hidden>
        {charts.hourTicks(span).map((t) => (
          <text key={t.at} x={t.at * width} y={11} fontSize={SMALL} style={{ fill: P.muted, fontFamily: "var(--sans)", fontFeatureSettings: "'tnum'" }}>
            {t.label}
          </text>
        ))}
      </svg>
    </div>
  );
}

const BAR_H = 14;

/** A project's day as one full-width rounded bar: work in ink, a wait for you in orange, the queue
 * dashed, idle a thin line, the wait drawn on top where agents overlap. */
function LaneBar({ lane, span }: { lane: Dict; span: [number, number] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const h = BAR_H;
  return (
    <div ref={ref} className="lane-bar">
      <svg width={width} height={h} aria-hidden>
        <rect x={0} y={0} width={width} height={h} rx={h / 2} style={{ fill: P.faint }} />
        {width > 0 && charts.laneMarks(lane, span).map((m, i) => {
          const x = m.left * width;
          const w = Math.max(width * 0.008, m.width * width, 2);
          if (m.state === "idle") return <rect key={i} x={x} y={h / 2 - 1} width={w} height={2} rx={1} style={{ fill: P.line }} />;
          if (m.state === "queue") {
            return <rect key={i} x={x + 0.5} y={2.5} width={Math.max(0, w - 1)} height={h - 5} rx={(h - 5) / 2}
              strokeWidth={1} strokeDasharray="3 2" style={{ fill: "none", stroke: P.muted }} />;
          }
          return <rect key={i} x={x} y={0} width={w} height={h} rx={Math.min(h / 2, w / 2)}
            style={{ fill: m.state === "wait" ? P.signal : P.ink }} />;
        })}
      </svg>
    </div>
  );
}

/** A key chip drawn as Today's bars draw that state. */
function Swatch({ state }: { state: string }) {
  return (
    <svg width={14} height={8} aria-hidden>
      {state === "queue" ? (
        <rect x={0.5} y={0.5} width={13} height={7} rx={3.5} strokeWidth={1} strokeDasharray="3 2" style={{ fill: "none", stroke: P.muted }} />
      ) : (
        <rect x={0} y={0} width={14} height={8} rx={4} style={{ fill: state === "wait" ? P.signal : P.ink }} />
      )}
    </svg>
  );
}

/** Today: one row per project (ops.projectLanes), not per agent: its name and what it is doing in
 * words, over its day as a full-width bar, under the hours, with a key below. The phone's Today.
 * A click on a row opens the project. */
export function Timeline({ lanes, more, now, onOpen, name }: {
  lanes: Dict[]; more: number; now: number; onOpen: (lane: Dict) => void; name: (lane: Dict) => string;
}) {
  const span = ops.window(lanes, now);
  return (
    <div className="timeline">
      {lanes.length > 0 && <HourScale span={span} />}
      <div className="col" style={{ gap: 0 }}>
        {!lanes.length && <span className="dim">No project has run today.</span>}
        {lanes.map((lane) => {
          const summary = ops.laneSummary(lane, now);
          const title = name(lane);
          const where = config.label(lane.machine);
          const agents = lane.agents > 1 ? `, ${lane.agents} agents today` : "";
          return (
            <button key={`${lane.machine}/${lane.id}`} className="today-row"
              title={`${summary}${agents.replace(", ", " · ")} · on ${where}. Click to open the project.`}
              aria-label={`${title} on ${where}: ${summary}${agents}`} onClick={() => onOpen(lane)}>
              <div className="row" style={{ gap: 10 }}>
                <span className="today-name grow ellipsis">{title}</span>
                <span className={cls("today-summary", summary.startsWith("Waiting") && "today-waiting")}>{summary}</span>
              </div>
              <LaneBar lane={lane} span={span} />
            </button>
          );
        })}
      </div>
      <div className="row today-key">
        {([["work", "working"], ["wait", "waiting for you"], ["queue", "queued"]] as const).map(([state, words]) => (
          <span key={state} className="row" style={{ gap: 6 }}>
            <Swatch state={state} />
            <span className="caps">{words}</span>
          </span>
        ))}
      </div>
      {more > 0 && <span className="dim">+{more} more {more === 1 ? "project" : "projects"} today</span>}
    </div>
  );
}

// -- budget and throughput ----------------------------------------------------------

/** A usage bar with the two lines that matter: 80% (prefer smaller models) and 95% (new Workers wait). */
function GaugeBar({ percent, hold }: { percent: number; hold: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const h = 10;
  return (
    <div ref={ref} className="gauge-bar">
      <svg width={width} height={h} aria-hidden>
        <rect x={0} y={2} width={width} height={h - 4} style={{ fill: P.faint }} />
        <rect x={0} y={2} width={width * Math.min(1, Math.max(0, percent))} height={h - 4} style={{ fill: hold ? P.signal : P.ink }} />
        {[0.8, 0.95].map((mark) => <rect key={mark} x={width * mark} y={0} width={1} height={h} style={{ fill: P.muted }} />)}
      </svg>
    </div>
  );
}

export function Budget({ gauges, now }: { gauges: Dict[]; now: number }) {
  if (!gauges.length) return <span className="dim">No usage reading yet.</span>;
  return (
    <div className="col" style={{ gap: 12 }}>
      {gauges.map((g, i) => {
        const [value, note] = ops.gaugeWords(g, now, gauges);
        const name = ops.gaugeName(g.id);
        return (
          <div key={`${g.id}/${g.account ?? ""}/${i}`} className="col" style={{ gap: 4 }}>
            <div className="row">
              <span className="mono grow ellipsis">{`${name} · ${g.label ?? ""}`}</span>
              <span className={cls("mono", g.state !== "ok" && "gauge-hot")}>{value}</span>
            </div>
            <GaugeBar percent={Number(g.percent || 0)} hold={g.state === "hold"} />
            {(note || g.account) && (
              <span className="dim mono ellipsis">{[note, g.account].filter((w) => w).join(" · ")}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const THROUGHPUT_H = 86;

/** Two weeks: Workers started (outline) and PRs merged (filled), one pair of bars a day. */
export function Throughput({ days }: { days: Dict[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<string | null>(null);
  useEffect(() => setTip(null), [days.length]);
  const height = THROUGHPUT_H;
  const chartH = height - 18;
  const text: CSSProperties = { fill: P.muted, fontFamily: "var(--sans)", fontFeatureSettings: "'tnum'", whiteSpace: "pre" };
  if (!days.length) {
    return <div ref={ref} className="throughput"><span className="dim" style={{ fontSize: SMALL + 1 }}>No history yet.</span></div>;
  }
  const bars = charts.throughputBars(days, width, chartH);
  const slot = width / days.length;
  return (
    <div ref={ref} className="throughput" title={tip ?? undefined}
      onMouseMove={(e) => {
        const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
        const i = Math.min(days.length - 1, Math.max(0, Math.floor(x / slot)));
        setTip(charts.dayTip(days[i]));
      }}>
      <svg width={width} height={height} aria-hidden>
        {bars.map((b) => (
          <g key={b.date}>
            {b.started > 0 && (
              <rect x={b.x + 0.5} y={chartH - b.started + 0.5} width={Math.max(0, b.bar - 1)} height={Math.max(0, b.started - 1)}
                strokeWidth={1} style={{ fill: "none", stroke: P.ink }} />
            )}
            <rect x={b.x + b.bar} y={chartH - b.merged} width={b.bar} height={b.merged} style={{ fill: P.ink }} />
          </g>
        ))}
        <rect x={0} y={chartH} width={width} height={1} style={{ fill: P.line }} />
        <text x={0} y={chartH + 13} fontSize={SMALLER} style={text}>{days[0].date.slice(5)}</text>
        <text x={width / 2} y={chartH + 13} fontSize={SMALLER} textAnchor="middle" style={text}>□ started  ■ merged</text>
        <text x={width} y={chartH + 13} fontSize={SMALLER} textAnchor="end" style={text}>{days[days.length - 1].date.slice(5)}</text>
      </svg>
    </div>
  );
}
