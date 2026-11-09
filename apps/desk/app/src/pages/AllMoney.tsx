/**
 * All money: every Space's money on one page, in
 * one currency (the household's), read from every computer (components/useAllMoney.ts). Kept across the
 * businesses, owed to you, your net worth and what waits; a row per business (one with empty books says
 * so, with Ask Cobra to set it up); kept by business by month, stacked, a loss below zero; and a card per
 * household. A row opens that Space's Finance rail. The month switch is the rail's.
 */
import { useState, type ReactNode } from "react";
import { useApp } from "../app/context.ts";
import { monthOf, monthTitle, shiftMonth } from "../../../../../packages/contracts/src/charts.ts";
import { allMoneyTotals, keptByMonth } from "../../../../../packages/contracts/src/allMoney.ts";
import { formatCell, localToday } from "../../../../../packages/contracts/src/viewsRead.ts";
import { askCobraWith } from "../lib/cobraDraft.ts";
import { stack, type Placed } from "../lib/allMoney.ts";
import { useAllMoney } from "../components/useAllMoney.ts";
import { Button, cls } from "../components/ui.tsx";
import "../styles/dashboard.css";
import "../styles/finance.css";
import { LEAD_NAME } from "../lib/appName.ts";

const SLOTS = ["var(--fin)", "var(--chart-1)", "var(--chart-4)", "var(--chart-5)", "var(--chart-2)", "var(--chart-other)"];

export function AllMoneyPage() {
  const app = useApp();
  const today = localToday();
  const [month, setMonth] = useState(monthOf(today));
  const read = useAllMoney(month);
  const money = (n: number | null) => (n === null ? "no rate" : formatCell(n, "money", read.currency, today));
  const totals = allMoneyTotals(read.spaces);
  const businesses = read.spaces.filter((s) => s.kind !== "family");
  const households = read.spaces.filter((s) => s.kind === "family");
  const setUp = businesses.filter((s) => s.setUp);
  const open = (s: Placed) => app.openProject(s.machine, s.project);
  const askSetUp = (s: Placed) => {
    askCobraWith(`Set up ${s.name}'s money: its accounts, and where its bank emails and statements come from. `, s.space);
    app.show("ops");
  };

  return (
    <div className="page all-money fin-page">
      <div className="fin-page-head">
        <h2 className="fin-page-title">All money</h2>
        <div className="chart-months fin-months">
          <button className="chart-month-step" aria-label={`Back to ${monthTitle(shiftMonth(month, -1))}`} onClick={() => setMonth((m) => shiftMonth(m, -1))}>‹</button>
          <b className="chart-month">{monthTitle(month)}</b>
          <button className="chart-month-step" aria-label={`On to ${monthTitle(shiftMonth(month, 1))}`} disabled={month >= monthOf(today)} onClick={() => setMonth((m) => shiftMonth(m, 1))}>›</button>
        </div>
      </div>
      {!read.loaded ? <div className="dim">Asking your computers…</div> : read.spaces.length === 0 ? (
        <div className="fin-card"><b>No Space keeps money yet.</b><span className="dim">A Space's Money skill keeps its books; ask {LEAD_NAME} to add one.</span></div>
      ) : (<>
        <div className="dash-tiles">
          <Tile label={`Kept across ${setUp.length === 1 ? "1 business" : `${setUp.length} businesses`}`} value={money(totals.kept)} tone={totals.kept < 0 ? "bad" : null} caption={monthTitle(month)} />
          <Tile label="Owed to you" value={money(totals.owed)} caption="open invoices, now" />
          <Tile label={households.length > 1 ? "Households' net worth" : "Your net worth"} value={money(totals.netWorth)} caption="every account, less what is owed" />
          <Tile label="Waiting for you" value={String(totals.waiting)} tone={totals.waiting > 0 ? "warn" : null} caption="to allow, in every Space" />
        </div>
        <p className="dim">In {read.currency}, each amount at its day's rate.{totals.unconverted ? ` ${totals.unconverted} with no rate to ${read.currency} left out.` : ""}{read.away.length ? ` Not answering: ${read.away.join(", ")}.` : ""}</p>

        {businesses.length > 0 && (
          <section className="fin-card" aria-label="Businesses">
            <div className="fin-card-head"><b className="grow">Businesses</b></div>
            <table className="fin-table">
              <thead><tr><th className="left">Business</th><th>In</th><th>Out</th><th>Kept</th><th>Owed to you</th><th>Waiting</th></tr></thead>
              <tbody>
                {businesses.map((s) => s.setUp ? (
                  <tr key={`${s.machine}:${s.space}`} className="click" onClick={() => open(s)}>
                    <td className="left"><b>{s.name}</b>{s.home !== read.currency && <span className="dim"> · keeps {s.home}</span>}</td>
                    <td>{money(s.in)}</td><td>{money(s.out)}</td>
                    <td className={cls(s.kept !== null && (s.kept < 0 ? "t-bad" : "t-good"))}>{money(s.kept)}</td>
                    <td>{money(s.owed)}</td><td>{s.waiting || ""}</td>
                  </tr>
                ) : (
                  <tr key={`${s.machine}:${s.space}`}>
                    <td className="left"><b>{s.name}</b> <span className="dim">· nothing in its books yet</span></td>
                    <td colSpan={5}><Button small onClick={() => askSetUp(s)}>Ask {LEAD_NAME} to set up</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {setUp.length > 0 && (
          <section className="fin-card" aria-label="Kept by business">
            <div className="fin-card-head"><b className="grow">Kept by business</b><span className="dim">six months to {monthTitle(month)}</span></div>
            <KeptChart spaces={setUp} money={money} />
          </section>
        )}

        {households.map((s) => (
          <section key={`${s.machine}:${s.space}`} className="fin-card fin-household" aria-label={s.name}>
            <div className="fin-card-head">
              <b className="grow">{s.name}</b>
              <Button small kind="primary" onClick={() => open(s)}>Open Finance</Button>
            </div>
            <div className="dash-tiles">
              <Tile label="Net worth" value={money(s.netWorth)} />
              <Tile label="In" value={money(s.in)} />
              <Tile label="Spent" value={money(s.out)} />
              <Tile label="Saved" value={money(s.kept)} tone={s.kept !== null && s.kept < 0 ? "bad" : null}
                caption={s.in && s.kept !== null ? `${Math.round((s.kept * 100) / s.in)}% of what came in` : undefined} />
            </div>
          </section>
        ))}
      </>)}
    </div>
  );
}

function Tile({ label, value, caption, tone }: { label: string; value: string; caption?: string; tone?: "good" | "warn" | "bad" | null }) {
  return (
    <div className="dash-tile">
      <span className="dash-tile-label">{label}</span>
      <span className="dash-tile-value">{tone && <span className={cls("dash-dot", `t-${tone}`)} />}{value}</span>
      {caption && <span className="dim">{caption}</span>}
    </div>
  );
}

const W = 640;
const H = 200;
const PAD = { left: 12, right: 12, top: 10, bottom: 24 };

/** Kept by business by month: a stacked bar per month, a loss below the zero line; each business's colour named in the legend with its total. */
function KeptChart({ spaces, money }: { spaces: Placed[]; money: (n: number | null) => string }) {
  const rows = keptByMonth(spaces);
  const parts = rows.map((row) => stack(spaces.map((s) => (typeof row[s.space] === "number" ? (row[s.space] as number) : null))));
  const top = Math.max(1, ...parts.flat().map((p) => (p ? Math.max(p.from, p.to) : 0)));
  const bottom = Math.min(0, ...parts.flat().map((p) => (p ? Math.min(p.from, p.to) : 0)));
  const y = (v: number) => PAD.top + ((top - v) / (top - bottom)) * (H - PAD.top - PAD.bottom);
  const band = (W - PAD.left - PAD.right) / Math.max(1, rows.length);
  const bw = Math.min(44, band * 0.6);
  return (
    <div className="fin-kept">
      <svg viewBox={`0 0 ${W} ${H}`} className="fin-river" role="img" aria-label="Kept by business by month">
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} className="fin-zero" />
        {rows.map((row, i) => {
          const x = PAD.left + band * i + (band - bw) / 2;
          const month = String(row.month);
          return (
            <g key={month}>
              {parts[i]!.map((p, j) => p && (
                <rect key={spaces[j]!.space} x={x} width={bw} y={Math.min(y(p.from), y(p.to))} height={Math.max(1, Math.abs(y(p.to) - y(p.from)))} rx={2} style={{ fill: SLOTS[j % SLOTS.length] }}>
                  <title>{`${spaces[j]!.name}, ${monthTitle(month)}: ${money(p.to - p.from)}`}</title>
                </rect>
              ))}
              <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="fin-node-value">{monthTitle(month).slice(0, 3)}</text>
            </g>
          );
        })}
      </svg>
      <div className="fin-legend">
        {spaces.map((s, j) => (
          <span key={s.space} className="fin-legend-item">
            <span className="fin-legend-dot" style={{ background: SLOTS[j % SLOTS.length] }} />
            {s.name} <span className="dim">{money(s.months.reduce((n, m) => n + (m.kept ?? 0), 0))}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Home's Money card: this month across every Space, and the way to All money. */
export function MoneyTodayCard({ frame }: { frame: (body: ReactNode) => ReactNode }) {
  const app = useApp();
  const today = localToday();
  const read = useAllMoney(monthOf(today));
  if (!read.loaded || read.spaces.length === 0) return null;
  const totals = allMoneyTotals(read.spaces);
  const money = (n: number) => formatCell(n, "money", read.currency, today);
  return frame(
    <div className="money-today">
      <div className="money-today-row">
        {totals.businesses > 0 && <span><span className="dim">Kept</span> <b className={cls(totals.kept < 0 && "bad")}>{money(totals.kept)}</b></span>}
        {totals.owed > 0 && <span><span className="dim">Owed</span> <b>{money(totals.owed)}</b></span>}
        {read.spaces.some((s) => s.kind === "family") && <span><span className="dim">Net worth</span> <b>{money(totals.netWorth)}</b></span>}
      </div>
      <span className="dim clickable" onClick={() => app.show("money")}>
        {totals.waiting ? `${totals.waiting} waiting to allow · ` : ""}All money ›
      </span>
    </div>
  );
}
