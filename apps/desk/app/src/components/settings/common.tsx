/**
 * What Settings' sections share (the desk's common.py pieces Settings leans on): a titled group as
 * cardify drew it — the title and the note it opens with above the card, rows inside, a closing
 * note under it — a row whose buttons drop below the text when narrow (flow_row), a set of toggles
 * (Adw.ToggleGroup), and a controller hook so each section keeps the Python's imperative shape.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp, type AppCtx } from "../../app/context.ts";
import { Card, GroupTitle, cls } from "../ui.tsx";

/** A section's state and acts, as the Python class held them; `draw()` asks React to draw again. */
export abstract class Controller {
  app!: AppCtx;
  constructor(readonly draw: () => void) {}
  /** The page is gone: stop timers. */
  stop(): void {}
}

/** One controller per mounted section, kept across draws, stopped when the page goes. */
export function useController<T extends Controller>(make: (draw: () => void) => T): T {
  const [, setTick] = useState(0);
  const ref = useRef<T | null>(null);
  if (ref.current === null) ref.current = make(() => setTick((t) => t + 1));
  ref.current.app = useApp();
  useEffect(() => () => ref.current?.stop(), []);
  return ref.current;
}

/** The words of an error, as `f"{e}"` gave them. */
export function why(e: unknown): string {
  return e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
}

/** An error's HTTP status, 0 when it never reached the agent. */
export function statusOf(e: unknown): number {
  return Number((e as { status?: number })?.status ?? 0);
}

/** A page in the default browser (tauri-plugin-opener's open_url, without its JS package). */
export function openUri(url: string): void {
  openUrl(url).catch(() => {});
}

/** A code on the clipboard, then the page to type it on. */
export async function openCode(code: string, url: string, toast: (t: string) => void) {
  try {
    await navigator.clipboard.writeText(code);
    toast("Code copied");
  } catch {
    // The page still opens; the code is on screen to copy by hand.
  }
  openUri(url);
}

/** A titled group: the title and its opening note above the card, the rows in it, a footnote under. */
export function Group({ title, note, footnote, children }: {
  title?: ReactNode; note?: ReactNode; footnote?: ReactNode; children?: ReactNode;
}) {
  const hasRows = Array.isArray(children) ? children.some((c) => c !== null && c !== undefined && c !== false) : !!children;
  return (
    <>
      {title && <GroupTitle>{title}</GroupTitle>}
      {note && <div className="dim settings-note">{note}</div>}
      {hasRows && <Card>{children}</Card>}
      {footnote && <div className="footnote">{footnote}</div>}
    </>
  );
}

/** Text on the left, controls on the right, until the window is too narrow for both. */
export function FlowRow({ main, trailing, lead }: { main: ReactNode; trailing?: ReactNode; lead?: ReactNode }) {
  return (
    <div className="flow-row">
      {lead}
      <div className="flow-wrap">
        <div className="flow-main">{main}</div>
        {trailing !== undefined && trailing !== null && <div className="flow-trailing">{trailing}</div>}
      </div>
    </div>
  );
}

export interface Toggle {
  key: string;
  label: string;
  disabled?: boolean;
  title?: string;
}

/** One of a few, side by side (Adw.ToggleGroup). */
export function Toggles({ options, active, onPick, className }: {
  options: Toggle[]; active: string | null; onPick: (key: string) => void; className?: string;
}) {
  return (
    <div className={cls("toggles", className)} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={o.key === active}
          className={cls("toggle", o.key === active && "active")}
          disabled={o.disabled}
          title={o.title}
          onClick={() => o.key !== active && onPick(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A flat button that stays pressed (Gtk.ToggleButton). */
export function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={cls("btn flat small chip-toggle", active && "active")} aria-pressed={active} onClick={onClick}>
      {label}
    </button>
  );
}

/** A number between `min` and `max` (Gtk.SpinButton); a change outside them, or no number, is ignored. */
export function NumberField({ value, min, max, step = 1, digits = 0, onChange, title }: {
  value: number; min: number; max: number; step?: number; digits?: number; onChange: (v: number) => void; title?: string;
}) {
  const [text, setText] = useState(digits ? value.toFixed(digits) : String(value));
  useEffect(() => setText(digits ? value.toFixed(digits) : String(value)), [value, digits]);
  return (
    <input
      className="entry number"
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      title={title}
      onChange={(e) => {
        setText(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(v) && v >= min && v <= max) onChange(v);
      }}
      onBlur={() => setText(digits ? value.toFixed(digits) : String(value))}
    />
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Working" />;
}
