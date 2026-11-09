/**
 * A crew sprite (lib/crew.ts) drawn as SVG squares on a round wash of its colour, as the phone's
 * Avatar draws one. Still unless asked to move: it then steps about six frames a second while it is
 * on screen, and not at all when the system asks for reduced motion.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as crew from "../lib/crew.ts";
import type { Dict } from "../lib/json.ts";

const HEAD = [3, 5, 18, 16] as const; // x, y, w, h on the stage: head and shoulders, for small sizes

function rgb(c: string): string {
  const n = parseInt(c.slice(1), 16);
  return `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}`;
}

export function Sprite({ spec, colour, state = "idle", size = 40, animate = false }: {
  spec: crew.Spec; colour: string; state?: string; size?: number; animate?: boolean;
}) {
  const [tick, setTick] = useState(0);
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!animate) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!timer) timer = setInterval(() => setTick((t) => t + 1), 160);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    // Only while on screen, as GTK's map/unmap had it.
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      start();
      return stop;
    }
    const seen = new IntersectionObserver((items) => (items.some((i) => i.isIntersecting) ? start() : stop()));
    seen.observe(el);
    return () => {
      seen.disconnect();
      stop();
    };
  }, [animate]);

  const small = size < 40;
  const [cx, cy, cw, ch] = small ? HEAD : [0, 0, crew.STAGE, crew.STAGE];
  const unit = (size * (small ? 0.92 : 1)) / cw;
  const ox = (size - cw * unit) / 2;
  const oy = small ? (size - ch * unit) / 2 : size - ch * unit;
  const pixels = crew.frame(spec, state, tick, !animate);
  const rects: ReactNode[] = [];
  for (const [k, c] of pixels) {
    const [x, y] = k.split(",").map(Number);
    if (!(cx <= x && x < cx + cw && cy <= y && y < cy + ch)) continue;
    // A hair over a pixel, so neighbours meet with no seam at fractional scales.
    rects.push(<rect key={k} x={ox + (x - cx) * unit} y={oy + (y - cy) * unit} width={unit + 0.4} height={unit + 0.4} fill={c} />);
  }
  return (
    <svg ref={ref} className="sprite" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={size / 2} fill={`rgba(${rgb(colour)}, 0.22)`} />
      {rects}
    </svg>
  );
}

/** The crew member a /projects entry is, as a sprite; nothing for anyone else. */
export function SpriteFor({ project, state, size = 40, animate = false }: {
  project: Dict | null | undefined; state: string; size?: number; animate?: boolean;
}) {
  const look = crew.lookOf(project);
  return look ? <Sprite spec={look[0]} colour={look[1]} state={state} size={size} animate={animate} /> : null;
}
