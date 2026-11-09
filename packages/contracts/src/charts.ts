/**
 * What a chart widget means before it is drawn, in
 * one place so the phone, the desk and the agent agree: the days a range
 * covers, the months a chart's x runs over, a scale's ticks, a KPI's total and
 * change, a donut's parts. Pure, no zod: the agent imports `rangeSpan` by path
 * and `package.sh` ships this file.
 */
import type { BandRange, Cell, ColumnFormat, RangeKey, RangeSpan, ViewResult, ViewRow } from "./views.ts";
import { BAND_RANGES, DEFAULT_RANGE, RANGE_KEYS } from "./views.ts";
import { currencySymbol } from "./viewsRead.ts";

export const RANGE_LABELS: Readonly<Record<RangeKey, string>> = { "30d": "30 d", quarter: "Quarter", "6mo": "6 mo", year: "Year", all: "All" };
/** What a change is weighed against, under a KPI: "vs the 30 days before". Empty for All, which has nothing before it. */
export const RANGE_BEFORE: Readonly<Record<RangeKey, string>> = { "30d": "vs the 30 days before", quarter: "vs the quarter before", "6mo": "vs the 6 months before", year: "vs the year before", all: "" };

/** A range as sent, read: anything not one of the keys is the default. */
export function readRange(value: unknown): RangeKey {
  return typeof value === "string" && (RANGE_KEYS as readonly string[]).includes(value) ? (value as RangeKey) : DEFAULT_RANGE;
}

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const parse = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const monthStart = (year: number, month: number): number => Date.UTC(year, month, 1);

/** A band's range as sent, read: anything else is this week. */
export function readBandRange(value: unknown): BandRange {
  return typeof value === "string" && (BAND_RANGES as readonly string[]).includes(value) ? (value as BandRange) : "week";
}

/** The days a band covers: this week Monday to Sunday (today inside it), or the last 30 or 90 days ending today. */
export function bandSpan(key: BandRange, today: string): { range: BandRange; start: string; end: string } {
  const now = Date.parse(`${today}T00:00:00Z`);
  if (key === "week") {
    const monday = now - ((new Date(now).getUTCDay() + 6) % 7) * 86_400_000;
    return { range: key, start: new Date(monday).toISOString().slice(0, 10), end: new Date(monday + 6 * 86_400_000).toISOString().slice(0, 10) };
  }
  const days = key === "30d" ? 30 : 90;
  return { range: key, start: new Date(now - (days - 1) * 86_400_000).toISOString().slice(0, 10), end: today };
}

/** The first and last day a range covers, ending on `today` (YYYY-MM-DD), and the period just before it, as long. */
export function rangeSpan(key: RangeKey, today: string): RangeSpan {
  const now = parse(today);
  if (key === "all") return { key, start: "0000-01-01", end: today };
  if (key === "30d") {
    const start = now - 29 * DAY;
    return { key, start: iso(start), end: today, prevStart: iso(start - 30 * DAY), prevEnd: iso(start - DAY) };
  }
  // Whole months, this one included: a quarter is this month and the two before it.
  const months = key === "quarter" ? 3 : key === "6mo" ? 6 : 12;
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const start = monthStart(year, month - months + 1);
  const prevStart = monthStart(year, month - 2 * months + 1);
  // The period before runs as far into its last month as today is into this one (its last day when shorter), so a half month is weighed against a half month.
  const prevEnd = Math.min(Date.UTC(year, month - months, date.getUTCDate()), Date.UTC(year, month - months + 1, 0));
  return { key, start: iso(start), end: today, prevStart: iso(prevStart), prevEnd: iso(prevEnd) };
}

/** Every month from the one `start` is in to the one `end` is in, as YYYY-MM. */
export function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7)) - 1;
  const last = end.slice(0, 7);
  for (let guard = 0; guard < 240; guard++) {
    const key = `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;
    out.push(key);
    if (key >= last) break;
    month += 1;
    if (month === 12) [year, month] = [year + 1, 0];
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10" as "Oct", or "Oct 2025" when `withYear`; anything else as it came. */
export function monthLabel(value: string, withYear = false): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  const name = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !name) return value;
  return withYear ? `${name} ${match[1]}` : name;
}

const num = (value: Cell | undefined): number => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : 0);
const key = (row: ViewRow, column: string): string => String(row[column] ?? "");

export type SeriesData = { column: string; label: string; line: boolean; values: number[]; previous?: number[] };
export type ChartData = { keys: string[]; labels: string[]; series: SeriesData[] };

/**
 * A chart's rows as series over its x values. Months run over the whole range
 * (from the first month with data for `all`), a missing month as zero; words
 * keep the rows' order. The previous period's rows line up with these by
 * position for months (its first month under this one's first) and by x value
 * for words.
 */
export function chartData(result: Pick<ViewResult, "rows" | "previous" | "range" | "chart">): ChartData {
  const chart = result.chart;
  if (!chart) return { keys: [], labels: [], series: [] };
  const rows = result.rows ?? [];
  const byKey = new Map(rows.map((row) => [key(row, chart.x), row]));
  let keys: string[];
  let prevKeys: string[] | null = null;
  if (chart.xKind === "month") {
    const seen = rows.map((row) => key(row, chart.x)).filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
    const range = result.range;
    const first = range && range.key !== "all" ? range.start.slice(0, 7) : seen[0];
    const last = range ? range.end.slice(0, 7) : seen.at(-1);
    keys = first && last && first <= last ? monthsBetween(first, last) : seen;
    if (range?.prevStart && range.prevEnd) prevKeys = monthsBetween(range.prevStart, range.prevEnd);
  } else {
    keys = rows.map((row) => key(row, chart.x));
  }
  const previous = result.previous;
  const prevBy = new Map((previous ?? []).map((row) => [key(row, chart.x), row]));
  const withYear = keys.length > 0 && keys[0]!.slice(0, 4) !== keys.at(-1)!.slice(0, 4);
  return {
    keys,
    labels: chart.xKind === "month" ? keys.map((m, i) => monthLabel(m, withYear && (i === 0 || m.endsWith("-01")))) : keys,
    series: chart.series.map((s) => ({
      column: s.column,
      label: s.label,
      line: s.line === true,
      values: keys.map((k) => num(byKey.get(k)?.[s.column])),
      ...(previous
        ? { previous: keys.map((k, i) => num((prevKeys ? prevBy.get(prevKeys[i] ?? "") : prevBy.get(k))?.[s.column])) }
        : {}),
    })),
  };
}

/** Whether every value of every series is zero: the chart shows its `empty` words instead. */
export function chartEmpty(data: ChartData): boolean {
  return data.series.every((s) => s.values.every((v) => v === 0));
}

/** A change in words and whether it is good: "▲ 12%", "▼ 3%", "New" from nothing, null with nothing either side. */
export function changeOf(current: number, previous: number, downGood = false): { text: string; good: boolean | null } | null {
  if (previous === 0) return current === 0 ? null : { text: "New", good: null };
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (pct === 0) return { text: "Same", good: null };
  const up = pct > 0;
  return { text: `${up ? "▲" : "▼"} ${Math.abs(pct)}%`, good: up !== downGood };
}

export type KpiCard = { column: string; label: string; value: number; previous: number | null; change: { text: string; good: boolean | null } | null; spark: number[]; format: ColumnFormat | undefined };

/** A KPI widget's cards: each series' total (or last value) over the range, its change against the period before and its rows as a sparkline. */
export function kpiCards(result: Pick<ViewResult, "rows" | "previous" | "range" | "chart">): KpiCard[] {
  const chart = result.chart;
  if (!chart) return [];
  const data = chartData(result);
  const total = (values: number[]): number => (chart.total === "last" ? values.at(-1) ?? 0 : values.reduce((a, b) => a + b, 0));
  return data.series.map((s) => {
    const previous = s.previous ? total(s.previous) : null;
    const value = total(s.values);
    return {
      column: s.column,
      label: s.label,
      value,
      previous,
      change: previous === null ? null : changeOf(value, previous, chart.downGood?.includes(s.column) === true),
      spark: s.values,
      format: chart.series.find((one) => one.column === s.column)?.format ?? chart.format,
    };
  });
}

export type DonutPart = { key: string; label: string; value: number; share: number; previous: number | null; slot: number; other: boolean };

/** A donut's parts: the biggest `max` in the order the SQL gave them, the rest folded into Other, each with its share and the previous period's value. A part keeps its colour slot by position, never by rank after a filter. */
export function donutParts(result: Pick<ViewResult, "rows" | "previous" | "range" | "chart">, max = 5): DonutPart[] {
  const data = chartData(result);
  const s = data.series[0];
  if (!s) return [];
  const all = data.keys.map((k, i) => ({ key: k, value: s.values[i] ?? 0, previous: s.previous ? s.previous[i] ?? 0 : null })).filter((p) => p.value > 0);
  const total = all.reduce((sum, p) => sum + p.value, 0);
  const kept = all.length > max + 1 ? all.slice(0, max) : all;
  const rest = all.slice(kept.length);
  const parts: DonutPart[] = kept.map((p, i) => ({ key: p.key, label: p.key, value: p.value, share: total ? p.value / total : 0, previous: p.previous, slot: i, other: false }));
  if (rest.length) {
    const value = rest.reduce((sum, p) => sum + p.value, 0);
    const previous = s.previous ? rest.reduce((sum, p) => sum + (p.previous ?? 0), 0) : null;
    parts.push({ key: "", label: `Other (${rest.length})`, value, share: total ? value / total : 0, previous, slot: -1, other: true });
  }
  return parts;
}

export type Bucket = { key: string; value: number; level: number };

/** A buckets widget's bars, in the rows' order, each with its level (0 fine to 3 worst). */
export function buckets(result: Pick<ViewResult, "rows" | "chart">): Bucket[] {
  const chart = result.chart;
  const s = chart?.series[0];
  if (!chart || !s) return [];
  return (result.rows ?? []).map((row) => ({ key: key(row, chart.x), value: num(row[s.column]), level: Math.max(0, Math.min(3, Math.round(num(chart.level ? row[chart.level] : 0)))) }));
}

export type FunnelStep = { key: string; value: number; count: number; reached: number; onward: number | null };

/** A funnel's stages in order: each bar's value and count, and the share of those who reached it that reached the next (null for the last, or with none reaching it). */
export function funnelSteps(result: Pick<ViewResult, "rows" | "chart">): FunnelStep[] {
  const chart = result.chart;
  const s = chart?.series[0];
  if (!chart || !s) return [];
  const steps = (result.rows ?? []).map((row) => ({
    key: key(row, chart.x),
    value: num(row[s.column]),
    count: chart.count ? num(row[chart.count]) : 0,
    reached: chart.reached ? num(row[chart.reached]) : 0,
    onward: null as number | null,
  }));
  if (chart.reached) for (let i = 0; i < steps.length - 1; i++) steps[i]!.onward = steps[i]!.reached > 0 ? Math.round((steps[i + 1]!.reached / steps[i]!.reached) * 100) : null;
  return steps;
}

export type Meter = {
  key: string;
  /** Spent and still to go (bills not paid yet), and the limit, as the row gives them. */
  spent: number;
  committed: number;
  limit: number;
  /** The limit less spent and committed: below zero when over. */
  left: number;
  /** How much of the bar each fills, 0 to 1 of the larger of the limit and what is used. */
  spentShare: number;
  committedShare: number;
  over: boolean;
  /** good under 85% of the limit used, warn to 100%, bad over (or anything against no limit). */
  tone: "good" | "warn" | "bad";
  caption: string;
};

/** A meter's bars: each row's spent and committed against its limit, in the rows' order. */
export function meters(result: Pick<ViewResult, "rows" | "chart">): Meter[] {
  const chart = result.chart;
  const spentCol = chart?.series[0]?.column;
  if (!chart || !spentCol) return [];
  const committedCol = chart.series[1]?.column;
  return (result.rows ?? []).map((row) => {
    const spent = num(row[spentCol]);
    const committed = committedCol ? num(row[committedCol]) : 0;
    const limit = chart.limit ? num(row[chart.limit]) : 0;
    const used = Math.max(0, spent) + Math.max(0, committed);
    const whole = Math.max(limit, used, 1);
    // No limit is not a limit of nothing: such a row is never over, and reads plain.
    const ratio = limit > 0 ? used / limit : 0;
    // A meter toward a goal (savings, a loan paid down) says its own tone and is never over.
    const own = chart.tone ? String(row[chart.tone] ?? "") : null;
    const toward = own === null ? null : own === "warn" || own === "bad" ? own : "good";
    return {
      key: key(row, chart.x),
      spent,
      committed,
      limit,
      left: limit - spent - committed,
      spentShare: Math.max(0, spent) / whole,
      committedShare: Math.max(0, committed) / whole,
      over: toward ? false : ratio > 1,
      tone: toward ?? (ratio > 1 ? "bad" : ratio >= 0.85 ? "warn" : "good"),
      caption: chart.caption ? String(row[chart.caption] ?? "") : "",
    };
  });
}

/** This month of a day (YYYY-MM-DD) as YYYY-MM. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** A month (YYYY-MM) moved by `by` months. */
export function shiftMonth(month: string, by: number): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + by;
  const y = year + Math.floor(index / 12);
  const m = ((index % 12) + 12) % 12;
  return `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}`;
}

const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-11" as "November 2026", for the month switch; anything else as it came. */
export function monthTitle(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? FULL_MONTHS[Number(match[2]) - 1] : undefined;
  return match && name ? `${name} ${match[1]}` : month;
}

/** A month as sent, read: YYYY-MM between 2000 and 2100, else null. */
export function readMonth(value: unknown): string | null {
  return typeof value === "string" && /^(20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(value) ? value : null;
}

export type Scale = { min: number; max: number; ticks: number[] };

/** A value axis that starts at zero (or below it, for a negative net) and ends on a round number, with about `count` ticks. */
export function niceScale(low: number, high: number, count = 4): Scale {
  const min = Math.min(0, low);
  const max = Math.max(0, high);
  if (max === min) return { min: 0, max: 1, ticks: [0, 1] };
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  // 2.5 only where it stays whole: an axis of counts never ticks at 2.5 and 7.5 (shown rounded as 3 and 8).
  const steps = power >= 10 || power < 1 ? [1, 2, 2.5, 5, 10] : [1, 2, 5, 10];
  const step = (steps.find((m) => m * power >= raw) ?? 10) * power;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return { min: lo, max: hi, ticks };
}

/** A value short enough for an axis or a card: money (whole cents) as "$12.4k", "-$950", a count as "1.2k". */
export function compactValue(value: number, format: ColumnFormat | undefined, currency: string): string {
  if (format === "percent") return `${Math.round(value)}%`;
  const money = format === "money";
  const amount = money ? value / 100 : value;
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  const short = abs >= 1e6 ? `${trim(abs / 1e6)}M` : abs >= 1e4 ? `${Math.round(abs / 1e3)}k` : abs >= 1e3 ? `${trim(abs / 1e3)}k` : String(Math.round(abs));
  if (!money) return `${sign}${short}`;
  return `${sign}${symbolOf(currency)}${short}`;
}

const trim = (n: number): string => (Math.round(n * 10) / 10).toString();

const symbolOf = currencySymbol;
