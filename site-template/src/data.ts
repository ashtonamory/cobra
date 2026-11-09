// What build.mjs checked and staged for this build (COBRA_SITE_BUILD): the
// site, the posts' front matter (drafts already left out), the theme and the
// logo's path. Pages read only this, never the Space folder.
import { readFileSync } from "node:fs";

import type { Post, SiteDoc } from "../../packages/contracts/src/website.ts";

export type Theme = {
  headingFont: string;
  bodyFont: string;
  headingWeight: number;
};

export type BuildData = {
  site: SiteDoc;
  posts: Omit<Post, "body">[];
  theme: Theme;
  /** The logo's path on the site ("/brand/logo.png"), when the brand kit has one. */
  logo?: string;
  /** The site's address, when known: canonical links and the sitemap. */
  url?: string;
  /** The Turnstile sitekey, when the site has the spam check (Phase 4b): the contact form shows it. */
  turnstile?: string;
};

export const data: BuildData = JSON.parse(readFileSync(process.env.COBRA_SITE_BUILD!, "utf8"));

const DAY_NAMES: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
export const dayName = (day: string) => DAY_NAMES[day] ?? day;

/** "09:00" → "9:00 AM". */
export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "2026-10-31" → "October 31, 2026", read as a calendar date (no time zone shift). */
export function longDate(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** Posts newest first. */
export const postsByDate = () => [...data.posts].sort((a, b) => (a.date === b.date ? a.slug.localeCompare(b.slug) : b.date.localeCompare(a.date)));

export const absolute = (path: string) => (data.url ? new URL(path, data.url).toString() : undefined);
