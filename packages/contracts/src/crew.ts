/**
 * Who the agents are: names and pixel sprites for the Lead, each project's
 * Foreman and the Workers on its crew. Shared by the app (which draws them)
 * and the agent (which names a project's Foreman once and keeps it). No zod
 * here: the agent imports this file by path and runs with no node_modules.
 *
 * The Lead is always Cobra, one fixed sprite on every computer. A Foreman's
 * name starts with its project's first letter (plant-shop → Stan) and is kept
 * by the agent with its look and hat colour (`CrewIdentity`), so it stays the
 * same for the life of the project unless you rename it. A Worker has no name
 * of its own: it wears its Foreman's hat colour and is called by its task.
 *
 * Every sprite is drawn from a seed on a 24×24 stage (the figure is 16×18),
 * so the same project always draws the same Foreman and no art ships.
 *
 * The desk draws the same sprites from a Python port, apps/desktop/cobradesk/
 * crew.py, which its tests check against this file frame by frame: change both
 * together.
 */

export const LEAD_NAME = "Cobra";

/** What the agent keeps for a project's Foreman: its name, which look (a reroll count) and which hat colour. */
export type CrewIdentity = { name: string; look: number; hat: number };

export type SpriteRole = "lead" | "foreman" | "worker";
export type SpriteState = "idle" | "working" | "needs" | "done" | "away";

/** Hat colours: the app's eight computer colours (dark set), bright enough on either ground. */
export const CREW_HATS = ["#7AA2F7", "#9ECE6A", "#BB9AF7", "#7DCFFF", "#73DACA", "#F7768E", "#FF9E64", "#E0AF68"] as const;
/** Cobra's colour, which the Lead's own Workers wear. */
export const LEAD_COLOR = "#5B7CF0";

const NAMES: Record<string, readonly string[]> = {
  a: ["Ada", "Abe", "Ari", "Alma", "Amos"],
  b: ["Bonnie", "Bo", "Bea", "Bruno", "Benny"],
  c: ["Cal", "Cleo", "Cass", "Coco", "Cy"],
  d: ["Dot", "Dex", "Della", "Duke"],
  e: ["Eli", "Edie", "Ezra", "Etta"],
  f: ["Finn", "Flo", "Faye", "Fitz"],
  g: ["Gus", "Gwen", "Gil", "Gigi"],
  h: ["Hank", "Hazel", "Hugo", "Hattie"],
  i: ["Ivy", "Ike", "Iris", "Iggy"],
  // No Jack or Cobra: the Lead is Cobra.
  j: ["Juno", "Jules", "Jed", "Jojo"],
  k: ["Kit", "Kai", "Knox", "Kiki"],
  l: ["Lou", "Lena", "Lars", "Lottie"],
  m: ["Mo", "Mabel", "Milo", "Mae"],
  n: ["Ned", "Nell", "Nico", "Nora"],
  o: ["Otis", "Opal", "Oz", "Olive"],
  p: ["Pip", "Penny", "Pete", "Polly"],
  q: ["Quinn", "Queenie", "Quill"],
  r: ["Rosa", "Rex", "Rudy", "Ruth"],
  s: ["Stan", "Sal", "Suki", "Sid"],
  t: ["Ted", "Tess", "Tito", "Trixie"],
  u: ["Ursa", "Ugo"],
  v: ["Vic", "Vera", "Vito"],
  w: ["Walt", "Wren", "Wes", "Winnie"],
  x: ["Xavi", "Xena"],
  y: ["Yuri", "Yara"],
  z: ["Zeke", "Zara", "Ziggy"],
};
/** For a project whose name starts with neither a letter nor a known one. */
const ANY = ["Sam", "Max", "Ray", "Lu", "Bix", "Tam", "Ren", "Nan"];

/** FNV-1a, 32 bits: the seed for everything drawn or picked. */
export function crewHash(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

/** The letter a project's Foreman is named for: "plant-shop" → "s". */
export function crewLetter(projectName: string): string {
  return projectName.trim().toLowerCase().replace(/^the[-_ ]+/, "").charAt(0);
}

/**
 * A new Foreman's name: one that starts with the project's letter, picked by
 * the project's id and passed over while another Foreman here has it.
 */
export function autoForemanName(projectId: string, projectName: string, taken: Iterable<string> = []): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  const pool = NAMES[crewLetter(projectName)] ?? ANY;
  const start = crewHash(projectId) % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const name = pool[(start + i) % pool.length] as string;
    if (!used.has(name.toLowerCase())) return name;
  }
  // Every name for the letter is taken: number the first.
  const base = pool[start] as string;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** A new Foreman's hat: picked by the project's id, passed over while another Foreman here wears it. */
export function autoHat(projectId: string, taken: Iterable<number> = []): number {
  const used = new Set(taken);
  const start = crewHash(`${projectId}:hat`) % CREW_HATS.length;
  for (let i = 0; i < CREW_HATS.length; i++) {
    const hat = (start + i) % CREW_HATS.length;
    if (!used.has(hat)) return hat;
  }
  return start;
}

/** A name you typed, tidied, or null when it cannot be one: 1 to 20 letters, digits, spaces, ' . or -, and never the Lead's. */
export function cleanCrewName(input: string): string | null {
  const name = input.replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > 20) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '.-]*$/u.test(name)) return null;
  if (name.toLowerCase() === LEAD_NAME.toLowerCase()) return null;
  return name;
}

export function hatColor(hat: number): string {
  return CREW_HATS[((hat % CREW_HATS.length) + CREW_HATS.length) % CREW_HATS.length] as string;
}

// ---------------------------------------------------------------- sprites

export type SpriteSpec = {
  role: SpriteRole;
  /** The hard hat's colour; the Lead wears none. */
  hat: string;
  head: "round" | "square" | "narrow";
  skin: string;
  hair: string;
  hairStyle: "none" | "short" | "long" | "curly" | "bob";
  eyes: "dot" | "tall" | "wide" | "glasses";
  mouth: "smile" | "grin" | "flat" | "o";
  beard: boolean;
  blush: boolean;
  shirt: string;
};

const SKINS = ["#F6D5B8", "#EDB892", "#D49B6C", "#B37A50", "#8C5B3A", "#5F3C27"];
const HAIR = ["#2A2230", "#563823", "#9C5E2B", "#D8B067", "#B2463A", "#8D90A8", "#ECE5D6"];
const SHIRTS = ["#4E5A86", "#5C7A4E", "#7A4E6E", "#3F6E78", "#8A5A3C", "#5A5470"];
const INK = "#1A1824";
const WHITE = "#F7F5FF";
const MOUTH = "#6B2F3A";
const VEST = "#F2B33D";
const STRIPE = "#F4F4F4";
const BLUSH = "#F09A9A";
const HEADSET = "#3A3850";

export const COBRA_SPEC: SpriteSpec = {
  role: "lead",
  hat: LEAD_COLOR,
  head: "round",
  skin: "#EDB892",
  hair: "#2A2230",
  hairStyle: "bob",
  eyes: "wide",
  mouth: "smile",
  beard: false,
  blush: true,
  shirt: "#3558C0",
};

export function spriteSpec(seed: string, role: Exclude<SpriteRole, "lead">, hat: string): SpriteSpec {
  const next = random(crewHash(seed));
  return {
    role,
    hat,
    head: pick(next, ["round", "round", "square", "narrow"] as const),
    skin: pick(next, SKINS),
    hair: pick(next, HAIR),
    hairStyle: pick(next, ["none", "short", "short", "long", "curly"] as const),
    eyes: pick(next, ["dot", "dot", "tall", "wide", "glasses"] as const),
    mouth: pick(next, ["smile", "smile", "grin", "flat", "o"] as const),
    beard: next() < 0.22,
    blush: next() < 0.35,
    shirt: pick(next, SHIRTS),
  };
}

/** A project's Foreman as drawn: its look counts rerolls, so look 0 is the project's first face. */
export function foremanSpec(projectId: string, crew: Pick<CrewIdentity, "look" | "hat">): SpriteSpec {
  return spriteSpec(`${projectId}#${crew.look}`, "foreman", hatColor(crew.hat));
}

/** A Worker as drawn: its own face, its Foreman's hat (or Cobra's colour for the Lead's own Workers). */
export function workerSpec(workerId: string, crew: Pick<CrewIdentity, "hat"> | undefined): SpriteSpec {
  return spriteSpec(workerId, "worker", crew ? hatColor(crew.hat) : LEAD_COLOR);
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}
function shade(hex: string, f: number): string {
  const [r, g, b] = rgb(hex);
  return toHex(r * f, g * f, b * f);
}
function lighten(hex: string, f: number): string {
  const [r, g, b] = rgb(hex);
  return toHex(r + (255 - r) * f, g + (255 - g) * f, b + (255 - b) * f);
}
function grey(hex: string): string {
  const [r, g, b] = rgb(hex);
  const y = 0.3 * r + 0.59 * g + 0.11 * b;
  return toHex(y * 0.8 + 30, y * 0.8 + 30, y * 0.8 + 40);
}

type Pose = { blink?: boolean; sleep?: boolean; happy?: boolean; arm?: 1 | 2 };
type Pixels = Map<string, string>;

/** Head half-widths for rows 6 to 13. */
const HEAD: Record<SpriteSpec["head"], number[]> = {
  round: [5, 5, 5, 5, 5, 5, 4, 3],
  square: [5, 5, 5, 5, 5, 5, 5, 4],
  narrow: [4, 4, 4, 4, 4, 4, 4, 3],
};

/** The 16×18 figure, mirrored about its middle; asymmetric details are set after. */
function figure(s: SpriteSpec, pose: Pose): Pixels {
  const g: Pixels = new Map();
  const set = (x: number, y: number, c: string) => g.set(`${x},${y}`, c);
  const sym = (x: number, y: number, c: string) => {
    set(x, y, c);
    set(15 - x, y, c);
  };
  const span = (y: number, hw: number, c: string) => {
    for (let x = 8 - hw; x <= 7 + hw; x++) set(x, y, c);
  };
  const hw = HEAD[s.head];
  const width = (y: number) => hw[y - 6] as number;
  const skinShade = shade(s.skin, 0.86);
  hw.forEach((w, i) => {
    span(6 + i, w, s.skin);
    set(7 + w, 6 + i, skinShade);
  });
  span(14, 2, skinShade);
  span(15, 5, s.shirt);
  span(16, 6, s.shirt);
  span(17, 6, s.shirt);
  for (let y = 15; y <= 17; y++) set(y === 15 ? 12 : 13, y, shade(s.shirt, 0.8));
  if (s.role === "foreman") {
    // A hi-vis vest with its reflective stripe.
    for (let y = 15; y <= 17; y++) for (let x = 2; x <= 13; x++) if ((x <= 5 || x >= 10) && g.has(`${x},${y}`)) set(x, y, y === 16 ? STRIPE : VEST);
  } else if (s.role === "worker") {
    // Overalls.
    const strap = shade(s.shirt, 0.6);
    for (let y = 15; y <= 17; y++) sym(5, y, strap);
    sym(6, 17, strap);
    sym(7, 17, strap);
  } else {
    // A blazer over a white shirt.
    for (let y = 15; y <= 17; y++) sym(7, y, WHITE);
    sym(6, 15, lighten(s.shirt, 0.3));
  }

  const hair = s.hair;
  const hairShade = shade(s.hair, 0.8);
  if (s.role === "lead") {
    span(3, 3, hair);
    span(4, 5, hair);
    span(5, 6, hair);
    for (let x = 3; x <= 12; x++) if (x % 3 !== 1) set(x, 6, hair);
    for (let y = 6; y <= 12; y++) {
      set(2, y, hair);
      set(13, y, hairShade);
      if (y <= 11) {
        set(3, y, hair);
        set(12, y, hairShade);
      }
    }
    set(5, 4, lighten(hair, 0.25));
    set(6, 3, lighten(hair, 0.25));
  } else {
    const edges = (y: number) => {
      set(8 - width(y), y, hair);
      set(7 + width(y), y, hairShade);
    };
    if (s.hairStyle === "short") [6, 7].forEach(edges);
    if (s.hairStyle === "long") {
      for (let y = 6; y <= 12; y++) edges(y);
      for (const y of [6, 7]) {
        set(2, y, hair);
        set(13, y, hairShade);
      }
    }
    if (s.hairStyle === "curly") {
      for (let y = 6; y <= 9; y++) {
        edges(y);
        if (y % 2 === 0) {
          set(7 - width(y), y, hair);
          set(8 + width(y), y, hairShade);
        }
      }
    }
    // The hard hat: a Foreman's carries a white badge, a Worker's a plain ridge.
    const hatShade = shade(s.hat, 0.72);
    const hatLight = lighten(s.hat, 0.4);
    span(2, 3, s.hat);
    span(3, 4, s.hat);
    span(4, 5, s.hat);
    span(5, 6, hatShade);
    set(7, 2, hatLight);
    set(8, 2, hatLight);
    set(5, 3, hatLight);
    set(4, 4, hatLight);
    const front = s.role === "foreman" ? WHITE : hatShade;
    for (const [x, y] of [[7, 3], [8, 3], [7, 4], [8, 4]] as const) set(x, y, front);
  }
  if (s.beard) {
    for (let y = 11; y <= 13; y++) for (let x = 8 - width(y); x <= 7 + width(y); x++) if (y > 11 || x <= 5 || x >= 10) set(x, y, y === 13 ? hairShade : hair);
  }

  if (pose.blink || pose.sleep) {
    sym(4, 9, INK);
    sym(5, 9, INK);
  } else if (s.eyes === "dot") sym(5, 9, INK);
  else if (s.eyes === "tall") {
    sym(5, 9, INK);
    sym(5, 10, INK);
  } else if (s.eyes === "wide") {
    sym(4, 9, WHITE);
    sym(5, 9, INK);
    sym(4, 8, shade(s.skin, 0.7));
    sym(5, 8, shade(s.skin, 0.7));
  } else {
    for (let x = 4; x <= 6; x++) {
      sym(x, 8, INK);
      sym(x, 10, INK);
    }
    sym(4, 9, INK);
    sym(6, 9, INK);
    sym(5, 9, INK);
    sym(7, 9, INK);
  }
  if (s.blush && !s.beard) sym(4, 11, BLUSH);

  const mouth = pose.happy ? "grin" : pose.sleep ? "flat" : s.mouth;
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
    // Cobra's headset, on her left.
    set(14, 8, INK);
    set(14, 9, HEADSET);
    set(14, 10, HEADSET);
    set(13, 11, HEADSET);
    set(12, 12, INK);
    set(11, 12, "#5A5872");
  }
  if (pose.arm) {
    const x = pose.arm === 1 ? 1 : 0;
    set(x, 11, s.skin);
    set(x, 12, s.shirt);
    set(x, 13, s.shirt);
    set(1, 14, s.shirt);
    set(2, 14, s.shirt);
  }
  return g;
}

export const SPRITE_STAGE = 24;
/** Where the figure stands on the stage. */
const OX = 4;
const OY = 5;

/**
 * One frame of a sprite on the 24×24 stage, as colours by "x,y". `tick` moves
 * the animation (the app advances it about six times a second); `still` draws
 * the state's resting frame, for lists and reduced motion.
 */
export function spriteFrame(spec: SpriteSpec, state: SpriteState, tick = 0, still = false): Map<string, string> {
  const k = still ? 0 : tick;
  const pose: Pose = {};
  let dy = 0;
  const extra: [number, number, string][] = [];
  let bubble: { kind: "!" | "check" | "z"; dy: number } | null = null;
  if (state === "idle") pose.blink = !still && k % 26 === 0;
  if (state === "working") {
    const up = Math.floor(k / 2) % 2 === 0;
    dy = up ? 0 : 1;
    const wood = "#8B5A2B";
    const iron = "#9AA0B4";
    extra.push([18, 19 - dy, spec.skin]);
    if (up) extra.push([19, 18, wood], [20, 17, wood], [21, 16, wood], [20, 15, iron], [21, 15, iron], [22, 15, iron], [22, 16, iron]);
    else {
      extra.push([19, 19, wood], [20, 19, wood], [21, 19, wood], [22, 18, iron], [22, 19, iron], [22, 20, iron], [23, 19, iron]);
      if (!still) extra.push([21, 21, "#FFD166"], [23, 21, "#FFD166"]);
    }
  }
  if (state === "needs") {
    pose.arm = Math.floor(k / 3) % 2 ? 2 : 1;
    bubble = { kind: "!", dy: Math.floor(k / 3) % 2 };
  }
  if (state === "done") {
    pose.happy = true;
    dy = [0, -1, -2, -1, 0, 0, 0, 0, 0, 0][k % 10] as number;
    bubble = { kind: "check", dy: 0 };
  }
  if (state === "away") {
    pose.sleep = true;
    bubble = { kind: "z", dy: k % 12 };
  }

  const stage: Pixels = new Map();
  figure(spec, pose).forEach((c, key) => {
    const [x, y] = key.split(",").map(Number) as [number, number];
    stage.set(`${x + OX},${y + OY + dy}`, c);
  });
  for (const [x, y, c] of extra) stage.set(`${x},${y}`, c);
  // A one-pixel ink outline around everything drawn.
  const out: Pixels = new Map(stage);
  stage.forEach((_, key) => {
    const [x, y] = key.split(",").map(Number) as [number, number];
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + a;
      const ny = y + b;
      if (nx < 0 || ny < 0 || nx >= SPRITE_STAGE || ny >= SPRITE_STAGE) continue;
      if (!stage.has(`${nx},${ny}`)) out.set(`${nx},${ny}`, INK);
    }
  });
  if (state === "away") out.forEach((c, key) => out.set(key, grey(c)));
  if (bubble) drawBubble(out, bubble);
  return out;
}

function drawBubble(m: Pixels, b: { kind: "!" | "check" | "z"; dy: number }) {
  const set = (x: number, y: number, c: string) => {
    if (x >= 0 && y >= 0 && x < SPRITE_STAGE && y < SPRITE_STAGE) m.set(`${x},${y}`, c);
  };
  if (b.kind === "z") {
    const top = 3 - Math.floor(b.dy / 3);
    ["###", "..#", ".#.", "###"].forEach((row, j) => [...row].forEach((ch, i) => ch === "#" && set(19 + i, top + j, "#9A98AE")));
    return;
  }
  const x0 = 17;
  const y0 = b.dy;
  // The attention orange the app already uses for "needs you"; green for done.
  const fill = b.kind === "!" ? "#FF9500" : "#4FB36A";
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      if ((x === 0 || x === 6) && (y === 0 || y === 6)) continue;
      set(x0 + x, y0 + y, x === 0 || x === 6 || y === 0 || y === 6 ? INK : fill);
    }
  }
  set(x0 + 1, y0 + 7, INK);
  set(x0 + 2, y0 + 7, INK);
  set(x0 + 1, y0 + 6, fill);
  if (b.kind === "!") {
    for (const y of [1, 2, 3, 5]) set(x0 + 3, y0 + y, WHITE);
  } else {
    for (const [x, y] of [[1, 3], [2, 4], [3, 3], [4, 2], [5, 1]] as const) set(x0 + x, y0 + y, WHITE);
  }
}

/** A part of the stage to draw: all of it, or a Worker's head and shoulders. */
export type SpriteCrop = { x: number; y: number; w: number; h: number };
export const STAGE_CROP: SpriteCrop = { x: 0, y: 0, w: SPRITE_STAGE, h: SPRITE_STAGE };
export const HEAD_CROP: SpriteCrop = { x: 3, y: 5, w: 18, h: 16 };

/** A run of same-coloured pixels in one row: x, y, length, colour. */
export type SpriteRun = [number, number, number, string];

/**
 * A frame as horizontal runs within a crop, so a drawer with no canvas (the
 * app draws with Views) needs one rectangle per run rather than per pixel.
 */
export function spriteRuns(spec: SpriteSpec, state: SpriteState, tick = 0, still = false, crop: SpriteCrop = STAGE_CROP): SpriteRun[] {
  const frame = spriteFrame(spec, state, tick, still);
  const runs: SpriteRun[] = [];
  for (let y = crop.y; y < crop.y + crop.h; y++) {
    let start = -1;
    let colour = "";
    for (let x = crop.x; x <= crop.x + crop.w; x++) {
      const c = x < crop.x + crop.w ? (frame.get(`${x},${y}`) ?? "") : "";
      if (c === colour) continue;
      if (colour) runs.push([start - crop.x, y - crop.y, x - start, colour]);
      start = x;
      colour = c;
    }
  }
  return runs;
}
