/**
 * The crew on the desk: Cobra, each project's Foreman by name, and the Workers on its crew, as
 * pixel sprites. A port of the desk's crew.py, itself a port of packages/contracts/src/crew.ts
 * (change all together): the same seed draws the same face here as on the phone, which
 * crew.test.ts checks against the TypeScript when that file is on disk.
 *
 * The agent keeps each Foreman's name, look and hat (`crew` on a /projects entry); an agent from
 * before crews sends none, and the desk then names and draws what it did before.
 */
import { isDict, type Dict, type Json } from "./json.ts";

export { LEAD_NAME } from "./appName.ts";
import { LEAD_NAME } from "./appName.ts";
export const CREW_HATS = ["#7AA2F7", "#9ECE6A", "#BB9AF7", "#7DCFFF", "#73DACA", "#F7768E", "#FF9E64", "#E0AF68"] as const;
export const LEAD_COLOR = "#5B7CF0";
export const STAGE = 24;

/** FNV-1a over UTF-16 code units, as JavaScript's charCodeAt reads them. */
export function crewHash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h = (h ^ text.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    const a = (state = (state + 0x6d2b79f5) >>> 0);
    let t = Math.imul(a ^ (a >>> 15), 1 | a) >>> 0;
    t = ((((t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0) ^ t) >>> 0);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(nxt: () => number, items: readonly T[]): T {
  return items[Math.floor(nxt() * items.length)];
}

/** Python's int() of a number or numeric string (truncates); NaN reads as 0. */
function pyInt(v: Json): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
}

export function hatColor(hat: number): string {
  const n = CREW_HATS.length;
  return CREW_HATS[((hat % n) + n) % n];
}

export type SpriteRole = "lead" | "foreman" | "worker";

export interface Spec {
  readonly role: SpriteRole | string;
  readonly hat: string;
  readonly head: string;
  readonly skin: string;
  readonly hair: string;
  readonly hairStyle: string;
  readonly eyes: string;
  readonly mouth: string;
  readonly beard: boolean;
  readonly blush: boolean;
  readonly shirt: string;
}

const SKINS = ["#F6D5B8", "#EDB892", "#D49B6C", "#B37A50", "#8C5B3A", "#5F3C27"] as const;
const HAIR = ["#2A2230", "#563823", "#9C5E2B", "#D8B067", "#B2463A", "#8D90A8", "#ECE5D6"] as const;
const SHIRTS = ["#4E5A86", "#5C7A4E", "#7A4E6E", "#3F6E78", "#8A5A3C", "#5A5470"] as const;
const INK = "#1A1824", WHITE = "#F7F5FF", MOUTH = "#6B2F3A", VEST = "#F2B33D", STRIPE = "#F4F4F4",
  BLUSH = "#F09A9A", HEADSET = "#3A3850";

export const COBRA: Spec = Object.freeze({
  role: "lead", hat: LEAD_COLOR, head: "round", skin: "#EDB892", hair: "#2A2230", hairStyle: "bob",
  eyes: "wide", mouth: "smile", beard: false, blush: true, shirt: "#3558C0",
});

export function specFromSeed(seed: string, role: string, hat: string): Spec {
  const nxt = random(crewHash(seed));
  const head = pick(nxt, ["round", "round", "square", "narrow"]);
  const skin = pick(nxt, SKINS);
  const hair = pick(nxt, HAIR);
  const hairStyle = pick(nxt, ["none", "short", "short", "long", "curly"]);
  const eyes = pick(nxt, ["dot", "dot", "tall", "wide", "glasses"]);
  const mouth = pick(nxt, ["smile", "smile", "grin", "flat", "o"]);
  const beard = nxt() < 0.22;
  const blush = nxt() < 0.35;
  const shirt = pick(nxt, SHIRTS);
  return { role, hat, head, skin, hair, hairStyle, eyes, mouth, beard, blush, shirt };
}

export function foremanSpec(projectId: string, crew: Dict): Spec {
  return specFromSeed(`${projectId}#${pyInt(crew.look || 0)}`, "foreman", hatColor(pyInt(crew.hat || 0)));
}

export function workerSpec(workerId: string, crew: Dict | null | undefined): Spec {
  return specFromSeed(workerId, "worker", crew && Object.keys(crew).length ? hatColor(pyInt(crew.hat || 0)) : LEAD_COLOR);
}

function rgb(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

function hex(r: number, g: number, b: number): string {
  // Math.round: halves go up.
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.floor(v + 0.5))).toString(16).padStart(2, "0")).join("");
}

function shade(c: string, f: number): string {
  const [r, g, b] = rgb(c);
  return hex(r * f, g * f, b * f);
}

function lighten(c: string, f: number): string {
  const [r, g, b] = rgb(c);
  return hex(r + (255 - r) * f, g + (255 - g) * f, b + (255 - b) * f);
}

function grey(c: string): string {
  const [r, g, b] = rgb(c);
  const y = 0.3 * r + 0.59 * g + 0.11 * b;
  return hex(y * 0.8 + 30, y * 0.8 + 30, y * 0.8 + 40);
}

const HEAD: Record<string, readonly number[]> = {
  round: [5, 5, 5, 5, 5, 5, 4, 3], square: [5, 5, 5, 5, 5, 5, 5, 4], narrow: [4, 4, 4, 4, 4, 4, 4, 3],
};

/** A frame: colours by "x,y" (the phone's spriteFrame keys). */
export type Frame = Map<string, string>;

const key = (x: number, y: number) => `${x},${y}`;
const unkey = (k: string): [number, number] => {
  const [x, y] = k.split(",");
  return [Number(x), Number(y)];
};

interface Pose { blink?: boolean; sleep?: boolean; happy?: boolean; arm?: number }

function figure(s: Spec, { blink = false, sleep = false, happy = false, arm = 0 }: Pose = {}): Frame {
  const g: Frame = new Map();
  const put = (x: number, y: number, c: string) => void g.set(key(x, y), c);
  const sym = (x: number, y: number, c: string) => {
    put(x, y, c);
    put(15 - x, y, c);
  };
  const span = (y: number, hw: number, c: string) => {
    for (let x = 8 - hw; x < 8 + hw; x++) put(x, y, c);
  };
  const hw = HEAD[s.head];
  const width = (y: number) => hw[y - 6];

  const skinShade = shade(s.skin, 0.86);
  hw.forEach((w, i) => {
    span(6 + i, w, s.skin);
    put(7 + w, 6 + i, skinShade);
  });
  span(14, 2, skinShade);
  span(15, 5, s.shirt);
  span(16, 6, s.shirt);
  span(17, 6, s.shirt);
  for (let y = 15; y < 18; y++) put(y === 15 ? 12 : 13, y, shade(s.shirt, 0.8));
  if (s.role === "foreman") {
    for (let y = 15; y < 18; y++)
      for (let x = 2; x < 14; x++)
        if ((x <= 5 || x >= 10) && g.has(key(x, y))) put(x, y, y === 16 ? STRIPE : VEST);
  } else if (s.role === "worker") {
    const strap = shade(s.shirt, 0.6);
    for (let y = 15; y < 18; y++) sym(5, y, strap);
    sym(6, 17, strap);
    sym(7, 17, strap);
  } else {
    for (let y = 15; y < 18; y++) sym(7, y, WHITE);
    sym(6, 15, lighten(s.shirt, 0.3));
  }

  const hair = s.hair, hairShade = shade(s.hair, 0.8);
  if (s.role === "lead") {
    span(3, 3, hair);
    span(4, 5, hair);
    span(5, 6, hair);
    for (let x = 3; x < 13; x++) if (x % 3 !== 1) put(x, 6, hair);
    for (let y = 6; y < 13; y++) {
      put(2, y, hair);
      put(13, y, hairShade);
      if (y <= 11) {
        put(3, y, hair);
        put(12, y, hairShade);
      }
    }
    put(5, 4, lighten(hair, 0.25));
    put(6, 3, lighten(hair, 0.25));
  } else {
    const edges = (y: number) => {
      put(8 - width(y), y, hair);
      put(7 + width(y), y, hairShade);
    };
    if (s.hairStyle === "short") for (const y of [6, 7]) edges(y);
    if (s.hairStyle === "long") {
      for (let y = 6; y < 13; y++) edges(y);
      for (const y of [6, 7]) {
        put(2, y, hair);
        put(13, y, hairShade);
      }
    }
    if (s.hairStyle === "curly") {
      for (let y = 6; y < 10; y++) {
        edges(y);
        if (y % 2 === 0) {
          put(7 - width(y), y, hair);
          put(8 + width(y), y, hairShade);
        }
      }
    }
    const hatShade = shade(s.hat, 0.72), hatLight = lighten(s.hat, 0.4);
    span(2, 3, s.hat);
    span(3, 4, s.hat);
    span(4, 5, s.hat);
    span(5, 6, hatShade);
    for (const [x, y] of [[7, 2], [8, 2], [5, 3], [4, 4]]) put(x, y, hatLight);
    const front = s.role === "foreman" ? WHITE : hatShade;
    for (const [x, y] of [[7, 3], [8, 3], [7, 4], [8, 4]]) put(x, y, front);
  }
  if (s.beard) {
    for (let y = 11; y < 14; y++)
      for (let x = 8 - width(y); x < 8 + width(y); x++)
        if (y > 11 || x <= 5 || x >= 10) put(x, y, y === 13 ? hairShade : hair);
  }

  if (blink || sleep) {
    sym(4, 9, INK);
    sym(5, 9, INK);
  } else if (s.eyes === "dot") {
    sym(5, 9, INK);
  } else if (s.eyes === "tall") {
    sym(5, 9, INK);
    sym(5, 10, INK);
  } else if (s.eyes === "wide") {
    sym(4, 9, WHITE);
    sym(5, 9, INK);
    sym(4, 8, shade(s.skin, 0.7));
    sym(5, 8, shade(s.skin, 0.7));
  } else {
    for (let x = 4; x < 7; x++) {
      sym(x, 8, INK);
      sym(x, 10, INK);
    }
    sym(4, 9, INK);
    sym(6, 9, INK);
    sym(5, 9, INK);
    sym(7, 9, INK);
  }
  if (s.blush && !s.beard) sym(4, 11, BLUSH);

  const mouth = happy ? "grin" : sleep ? "flat" : s.mouth;
  if (mouth === "smile") {
    sym(6, 11, MOUTH);
    sym(7, 12, MOUTH);
  } else if (mouth === "grin") {
    sym(6, 11, MOUTH);
    sym(7, 11, MOUTH);
    sym(7, 12, WHITE);
  } else if (mouth === "flat") {
    sym(6, 12, MOUTH);
    sym(7, 12, MOUTH);
  } else {
    sym(7, 11, MOUTH);
    sym(7, 12, MOUTH);
  }

  if (s.role === "lead") {
    put(14, 8, INK);
    put(14, 9, HEADSET);
    put(14, 10, HEADSET);
    put(13, 11, HEADSET);
    put(12, 12, INK);
    put(11, 12, "#5A5872");
  }
  if (arm) {
    const x = arm === 1 ? 1 : 0;
    put(x, 11, s.skin);
    put(x, 12, s.shirt);
    put(x, 13, s.shirt);
    put(1, 14, s.shirt);
    put(2, 14, s.shirt);
  }
  return g;
}

/** One frame on the 24×24 stage: colours by "x,y". `still` is the state's resting frame. */
export function frame(s: Spec, state: string, tick = 0, still = false): Frame {
  const k = still ? 0 : tick;
  const pose: Pose = {};
  let dy = 0;
  const extra: [number, number, string][] = [];
  let bubble: [string, number] | null = null;
  if (state === "idle") pose.blink = !still && k % 26 === 0;
  if (state === "working") {
    const up = Math.floor(k / 2) % 2 === 0;
    dy = up ? 0 : 1;
    const wood = "#8B5A2B", iron = "#9AA0B4";
    extra.push([18, 19 - dy, s.skin]);
    if (up) {
      extra.push([19, 18, wood], [20, 17, wood], [21, 16, wood], [20, 15, iron], [21, 15, iron], [22, 15, iron], [22, 16, iron]);
    } else {
      extra.push([19, 19, wood], [20, 19, wood], [21, 19, wood], [22, 18, iron], [22, 19, iron], [22, 20, iron], [23, 19, iron]);
      if (!still) extra.push([21, 21, "#FFD166"], [23, 21, "#FFD166"]);
    }
  }
  if (state === "needs") {
    pose.arm = Math.floor(k / 3) % 2 ? 2 : 1;
    bubble = ["!", Math.floor(k / 3) % 2];
  }
  if (state === "done") {
    pose.happy = true;
    dy = [0, -1, -2, -1, 0, 0, 0, 0, 0, 0][k % 10];
    bubble = ["check", 0];
  }
  if (state === "away") {
    pose.sleep = true;
    bubble = ["z", k % 12];
  }

  const stage: Frame = new Map();
  for (const [kk, c] of figure(s, pose)) {
    const [x, y] = unkey(kk);
    stage.set(key(x + 4, y + 5 + dy), c);
  }
  for (const [x, y, c] of extra) stage.set(key(x, y), c);
  let out: Frame = new Map(stage);
  for (const kk of stage.keys()) {
    const [x, y] = unkey(kk);
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + a, ny = y + b;
      if (nx >= 0 && nx < STAGE && ny >= 0 && ny < STAGE && !stage.has(key(nx, ny))) out.set(key(nx, ny), INK);
    }
  }
  if (state === "away") out = new Map([...out].map(([kk, c]) => [kk, grey(c)]));
  if (bubble) drawBubble(out, bubble[0], bubble[1]);
  return out;
}

function drawBubble(m: Frame, kind: string, dy: number): void {
  const put = (x: number, y: number, c: string) => {
    if (x >= 0 && x < STAGE && y >= 0 && y < STAGE) m.set(key(x, y), c);
  };
  if (kind === "z") {
    const top = 3 - Math.floor(dy / 3);
    ["###", "..#", ".#.", "###"].forEach((row, j) => {
      [...row].forEach((ch, i) => {
        if (ch === "#") put(19 + i, top + j, "#9A98AE");
      });
    });
    return;
  }
  const x0 = 17, y0 = dy;
  const fill = kind === "!" ? "#FF9500" : "#4FB36A";
  for (let y = 0; y < 7; y++)
    for (let x = 0; x < 7; x++) {
      const xe = x === 0 || x === 6, ye = y === 0 || y === 6;
      if (xe && ye) continue;
      put(x0 + x, y0 + y, xe || ye ? INK : fill);
    }
  put(x0 + 1, y0 + 7, INK);
  put(x0 + 2, y0 + 7, INK);
  put(x0 + 1, y0 + 6, fill);
  if (kind === "!") {
    for (const y of [1, 2, 3, 5]) put(x0 + 3, y0 + y, WHITE);
  } else {
    for (const [x, y] of [[1, 3], [2, 4], [3, 3], [4, 2], [5, 1]]) put(x0 + x, y0 + y, WHITE);
  }
}

// -- who wears what (the phone's crewRules.ts) -----------------------------------------------------

/** A /projects entry's sprite and colour: Cobra, a Foreman, a Worker on a crew; else null. */
export function lookOf(project: Dict | null | undefined): readonly [Spec, string] | null {
  const p: Dict = project || {};
  const crew = isDict(p.crew) && Object.keys(p.crew).length ? (p.crew as Dict) : null;
  if (p.lead === true) return [COBRA, LEAD_COLOR];
  if (p.foreman === true) {
    return crew ? [foremanSpec(String(p.parent || p.id), crew), hatColor(pyInt(crew.hat || 0))] : null;
  }
  const worker = isDict(p.worker) ? p.worker : null;
  if (worker && Object.keys(worker).length) {
    if (worker.owner === "lead") return [workerSpec(String(p.id), null), LEAD_COLOR];
    return crew ? [workerSpec(String(p.id), crew), hatColor(pyInt(crew.hat || 0))] : null;
  }
  return null;
}

/** Whose crew a Worker is on: "Juno's crew", or Cobra's for the Lead's own. */
export function crewLabel(project: Dict | null | undefined): string | null {
  const p: Dict = project || {};
  const worker = isDict(p.worker) ? p.worker : null;
  if (!worker || !Object.keys(worker).length) return null;
  if (worker.owner === "lead") return `${LEAD_NAME}'s crew`;
  const crew = isDict(p.crew) ? p.crew : null;
  return crew && Object.keys(crew).length && crew.name ? `${crew.name}'s crew` : null;
}

/** A board row's state as the sprite acts it. */
export function spriteState(rowState: string, active = true): string {
  if (!active) return "away";
  return rowState === "needs" || rowState === "working" ? rowState : "idle";
}
