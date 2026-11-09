/**
 * The pieces every page shares (the desk's ui/common.py): the board — a time,
 * a name with its machine's dot, one status word — and the small things
 * around it. A row's buttons show while the pointer is on it, so a list at
 * rest is only words.
 */
import { useEffect, useRef, useState, type ReactNode, type MouseEvent } from "react";
import * as config from "../lib/config.ts";
import { toHtml } from "../lib/markdown.ts";
import type { Dict } from "../lib/json.ts";

export function cls(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

export function Status({ word, tone }: { word: string; tone: string }) {
  return <span className={cls("status", `s-${tone}`)}>{word}</span>;
}

export function Pill({ text, tone }: { text: string; tone: string }) {
  return <span className={cls("pill", `p-${tone}`)}>{text}</span>;
}

export function MachineDot({ machine }: { machine: string }) {
  return <span className={cls("mdot", `hb-${config.hue(machine)}`)} title={config.label(machine)} />;
}

export function Chip({ machine }: { machine: string }) {
  return <span className={cls("chip", `h-${config.hue(machine)}`)}>{config.label(machine)}</span>;
}

export function Button({
  children, onClick, kind, small, disabled, title, type,
}: {
  children: ReactNode; onClick?: () => void; kind?: "primary" | "danger" | "flat"; small?: boolean;
  disabled?: boolean; title?: string; type?: "button" | "submit";
}) {
  return (
    <button
      type={type ?? "button"}
      className={cls("btn", kind, small && "small")}
      disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      {children}
    </button>
  );
}

export function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <span className="caps grow">{title}</span>
        {extra}
      </div>
      {children}
    </section>
  );
}

export function Board({ head, children, className }: { head?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cls("board", className)}>
      {head !== undefined && <BoardHead item={head} />}
      {children}
    </div>
  );
}

export function BoardHead({ item = "ITEM" }: { item?: string }) {
  return (
    <div className="board-head">
      <span className="caps" style={{ width: "6ch" }}>TIME</span>
      <span className="caps grow">{item}</span>
      <span className="caps">STATUS</span>
    </div>
  );
}

export interface BoardRowProps {
  /** null: no time column at all (Settings' cards). */
  time?: string | null;
  title: ReactNode;
  word: string;
  tone: string;
  machine?: string | null;
  actions?: ReactNode;
  /** What waits on you keeps its answers in view. */
  keepActions?: boolean;
  onClick?: () => void;
  onMenu?: (x: number, y: number) => void;
  indent?: boolean;
  detail?: ReactNode;
  extra?: ReactNode;
  tooltip?: string;
  lead?: ReactNode;
}

/** One board row (the desk's board_row). */
export function BoardRow(p: BoardRowProps) {
  const dim = p.tone === "dim";
  return (
    <div
      className={cls("brow", p.onClick && "clickable")}
      title={p.tooltip}
      onClick={p.onClick}
      onContextMenu={
        p.onMenu
          ? (e: MouseEvent) => {
              e.preventDefault();
              p.onMenu!(e.clientX, e.clientY);
            }
          : undefined
      }
    >
      {p.time !== null && p.time !== undefined && <span className={cls("btime", dim && "dim")}>{p.time || "—"}</span>}
      {p.lead}
      <div className={cls("col grow", p.indent && "indent")} style={{ gap: 2 }}>
        <div className="row">
          <span className={cls("btitle", dim && "dim")}>{p.title}</span>
          {p.machine && <MachineDot machine={p.machine} />}
        </div>
        {p.detail ? <div className="bdetail">{p.detail}</div> : null}
        {p.extra}
      </div>
      {p.actions ? <div className={cls("row-actions", p.keepActions && "keep")}>{p.actions}</div> : null}
      <Status word={p.word} tone={p.tone} />
    </div>
  );
}

export function Meter({ name, fraction, hotAt = 0.6 }: { name: string; fraction: number | null | undefined; hotAt?: number }) {
  const f = Math.max(0, Math.min(1, fraction ?? 0));
  return (
    <div className="meter">
      <span className="dim" style={{ width: 44 }}>{name}</span>
      <div className={cls("bar", f >= hotAt && "hot")}>
        <div style={{ width: `${f * 100}%` }} />
      </div>
      <span className="dim" style={{ width: 40, textAlign: "right" }}>
        {fraction === null || fraction === undefined ? "—" : `${Math.round(f * 100)}%`}
      </span>
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="card">{children}</div>;
}

export function GroupTitle({ children }: { children: ReactNode }) {
  return <div className="group-title">{children}</div>;
}

/** Claude's markdown, made safe (lib/markdown.ts escapes everything first). */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={cls("md selectable", className)} dangerouslySetInnerHTML={{ __html: toHtml(text) }} />;
}

/**
 * A permission prompt whole and in plain words (the desk's request_view): the
 * headline, what will happen, and "Show the exact request", which reveals the
 * command or edit as asked, in monospace, in a box that scrolls.
 */
export function RequestView({ request, full = true, exactHeight = 200 }: { request: Dict; full?: boolean; exactHeight?: number }) {
  const [shown, setShown] = useState(false);
  const why = request.why || "";
  const exact = request.exact || "";
  return (
    <div className="request" onClick={(e) => e.stopPropagation()}>
      {request.headline && <div className="req-headline selectable">{request.headline}</div>}
      {request.plain && <div className="selectable">{request.plain}</div>}
      {why && (full || !exact) && <div className="bdetail">{why}</div>}
      {exact && (
        <>
          <button className="linkish" style={{ alignSelf: "flex-start" }} onClick={() => setShown(!shown)}>
            {shown ? "▾ Hide" : "▸ Show"} the exact request
          </button>
          {shown && (
            <>
              {why && !full && <div className="bdetail">{why}</div>}
              <pre className="req-exact" style={{ maxHeight: exactHeight }}>{exact}</pre>
            </>
          )}
        </>
      )}
    </div>
  );
}

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
}

/** A right-click or ⋯ menu at a point; closes on any outside click or Escape. */
export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
    }
    const close = () => onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // After the click that opened it; cancelled if the menu goes (or is drawn again) first, or the
    // listener would be added after its removal and outlive the menu.
    const armed = setTimeout(() => window.addEventListener("click", close), 0);
    window.addEventListener("keydown", key);
    return () => {
      clearTimeout(armed);
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", key);
    };
  }, [x, y, onClose]);
  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onClick={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it.separator ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            disabled={it.disabled}
            style={it.danger ? { color: "var(--red)" } : undefined}
            onClick={() => {
              onClose();
              it.onClick?.();
            }}
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

/** Opens a Menu from a ⋯ button or a right-click: `const [menu, open] = useMenu()`. */
export function useMenu(): [ReactNode, (x: number, y: number, items: MenuItem[]) => void] {
  const [state, setState] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const node = state ? <Menu {...state} onClose={() => setState(null)} /> : null;
  return [node, (x, y, items) => setState({ x, y, items })];
}

export function Dialog({ title, children, onClose, buttons }: { title: string; children: ReactNode; onClose: () => void; buttons?: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
        {buttons && <div className="buttons">{buttons}</div>}
      </div>
    </div>
  );
}

export function Switch({ checked, onChange, disabled, title }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; title?: string }) {
  return (
    <input
      type="checkbox"
      className="switch"
      checked={checked}
      disabled={disabled}
      title={title}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
