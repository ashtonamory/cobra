/**
 * A Space's email theme: the brand kit made
 * into what an email can draw. Colours, two font stacks with fallbacks every
 * client has, the logo, the button's shape and the footer's business name
 * and postal address. Pure: the agent reads brand.json and space.json and
 * keeps the result in `email/theme.json`; a brand kit change makes a new
 * theme, and every template takes it at its next send.
 *
 * Email clients load no web fonts we can rely on (Gmail never does), so a
 * family is named first and followed by the closest system faces.
 */

import { createHash } from "node:crypto";

export const EMAIL_THEME_VERSION = 1;

export type EmailColors = {
  /** The brand colour: buttons, the header's words, links. */
  brand: string;
  accent: string;
  /** Body text. */
  ink: string;
  /** The email's own background. */
  paper: string;
  /** Around the email. */
  page: string;
  /** Small print and labels. */
  muted: string;
  /** Dividers and table rules. */
  line: string;
  /** Words on a button. */
  onBrand: string;
};

export type EmailTheme = {
  version: 1;
  business: string;
  /** The postal address campaigns must carry (phase 3); optional for transactional mail. */
  address?: string;
  colors: EmailColors;
  /**
   * Dark mode for clients that ask (Apple Mail, iOS Mail, Outlook.com). A
   * brand colour too dark to read on the dark paper gives way to the accent,
   * else to the dark ink: `brand` fills the button, `brandText` colours words.
   */
  dark: Pick<EmailColors, "ink" | "paper" | "page" | "muted" | "line" | "brand" | "onBrand"> & { brandText: string };
  fonts: { heading: string; body: string; headingStack: string; bodyStack: string };
  /** The logo as a file in the Space's folder, relative to it (brand/logo.png), with its size. */
  logo?: { file: string; width: number; height: number };
  /** Button corners, px. */
  radius: number;
  /** The brand kit's allowedAt, so a theme is known to follow its kit. */
  brandAt?: string;
};

export type BrandInput = {
  colors: { brand: string; accent: string; ink: string; paper: string };
  fonts: { heading: string; body: string };
  logo?: string;
  allowedAt?: string;
};

const SERIF = new Set(["Playfair Display", "Lora", "DM Serif Display", "Instrument Serif", "Bodoni Moda", "Cormorant Garamond", "Fraunces"]);
const MONO = new Set(["Geist Mono", "JetBrains Mono"]);
const CONDENSED = new Set(["Bebas Neue", "Oswald"]);

export const FALLBACK_STACKS = {
  serif: "Georgia, 'Times New Roman', Times, serif",
  sans: "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
  mono: "Menlo, Consolas, 'Courier New', monospace",
  condensed: "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif",
} as const;

/** A font family followed by the system faces closest to it. */
export function fontStack(family: string): string {
  const name = family.replace(/['";\\<>{}]/g, "").trim() || "Inter";
  const rest = SERIF.has(name) ? FALLBACK_STACKS.serif : MONO.has(name) ? FALLBACK_STACKS.mono : CONDENSED.has(name) ? FALLBACK_STACKS.condensed : FALLBACK_STACKS.sans;
  return `'${name}', ${rest}`;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (c: [number, number, number]): string => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` moved toward `b` by `t` (0 to 1). */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * t) as [number, number, number]);
}

export type ThemeInput = {
  brand: BrandInput | null;
  business: string;
  address?: string;
  /** The logo file's path relative to the Space's folder and its size, when the kit has one and it reads. */
  logo?: { file: string; width: number; height: number };
};

/** Neutral colours for a Space with no brand kit yet. */
export const PLAIN_BRAND: BrandInput = {
  colors: { brand: "#1f2937", accent: "#2563eb", ink: "#111827", paper: "#ffffff" },
  fonts: { heading: "Inter", body: "Inter" },
};

/**
 * The theme a brand kit makes. A colour that is not #rrggbb takes the plain
 * one. When the kit's paper is dark, the email is drawn on white anyway with
 * the kit's paper as the page around it, since most mail is read light and
 * dark-mode clients get their own colours below.
 */
export function themeFromBrand(input: ThemeInput): EmailTheme {
  const kit = input.brand ?? PLAIN_BRAND;
  const pick = (value: string, fallback: string) => (HEX.test(value) ? value.toLowerCase() : fallback);
  const brand = pick(kit.colors.brand, PLAIN_BRAND.colors.brand);
  const accent = pick(kit.colors.accent, PLAIN_BRAND.colors.accent);
  let ink = pick(kit.colors.ink, PLAIN_BRAND.colors.ink);
  let paper = pick(kit.colors.paper, PLAIN_BRAND.colors.paper);
  let page = mix(paper, "#000000", 0.05);
  if (luminance(paper) < 0.4) {
    page = paper;
    paper = "#ffffff";
  }
  if (contrast(ink, paper) < 4.5) ink = luminance(paper) > 0.5 ? "#111111" : "#f5f5f5";
  const onBrand = contrast("#ffffff", brand) >= contrast("#111111", brand) ? "#ffffff" : "#111111";
  const theme: EmailTheme = {
    version: 1,
    business: input.business.trim() || "Your business",
    ...(input.address?.trim() ? { address: input.address.trim() } : {}),
    colors: {
      brand,
      accent,
      ink,
      paper,
      page,
      muted: mix(ink, paper, 0.4),
      line: mix(ink, paper, 0.85),
      onBrand,
    },
    dark: darkColors(brand, accent),
    fonts: { heading: kit.fonts.heading, body: kit.fonts.body, headingStack: fontStack(kit.fonts.heading), bodyStack: fontStack(kit.fonts.body) },
    ...(input.logo ? { logo: input.logo } : {}),
    radius: 6,
    ...(kit.allowedAt ? { brandAt: kit.allowedAt } : {}),
  };
  return theme;
}

const DARK = { ink: "#f2f2f2", paper: "#1c1c1e", page: "#111111", muted: "#a1a1a6", line: "#3a3a3c" } as const;

function darkColors(brand: string, accent: string): EmailTheme["dark"] {
  const readable = (colour: string) => contrast(colour, DARK.paper) >= 3;
  const lead = readable(brand) ? brand : readable(accent) ? accent : DARK.ink;
  return { ...DARK, brand: lead, onBrand: contrast("#ffffff", lead) >= contrast("#111111", lead) ? "#ffffff" : "#111111", brandText: lead };
}

/** A theme's hash, kept on each ledger row as its theme version. */
export function themeHash(theme: EmailTheme): string {
  return createHash("sha256").update(JSON.stringify(theme)).digest("hex");
}

/** A theme read back from disk, or null when it is not one this build draws. */
export function parseTheme(value: unknown): EmailTheme | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as Partial<EmailTheme>;
  if (t.version !== EMAIL_THEME_VERSION || typeof t.business !== "string" || typeof t.colors !== "object" || typeof t.fonts !== "object" || typeof t.dark !== "object") return null;
  const colours = [...Object.values(t.colors ?? {}), ...Object.values(t.dark ?? {})];
  if (!colours.every((c) => typeof c === "string" && HEX.test(c))) return null;
  return t as EmailTheme;
}

/** The width and height of a PNG, JPEG, GIF or WebP file, or null. */
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" && bytes.subarray(12, 16).toString("ascii") === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes.subarray(0, 3).toString("ascii") === "GIF") return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = bytes.subarray(12, 16).toString("ascii");
    if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const b = bytes.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker === 0xd9 || marker === 0xda) return null;
      const length = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
      }
      at += 2 + length;
    }
  }
  return null;
}
