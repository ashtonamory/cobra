// A website card (the agent's site.ts, kind `site`): the version's own address,
// for the person to look at before Allow puts it live. Only an https address on
// workers.dev is opened, whatever the card says. A domain card (Phase 5)
// carries the site's workers.dev address there instead: the link then opens
// the website as it is now. The phone's siteRules.ts is the same rule.
import { isDict } from "./json.ts";

export function sitePreview(approval: unknown): string | null {
  if (!isDict(approval) || !isDict(approval.site)) return null;
  const url = approval.site.previewUrl;
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.endsWith(".workers.dev") ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Where Allow also saves the site's source (Phase 3b: the computer's GitHub,
 * when it is connected), in the agent's words (site.ts sourceLine); null when
 * the card saves nothing. The phone's siteRules.ts says the same.
 */
export function siteSource(approval: unknown): string | null {
  if (!isDict(approval) || !isDict(approval.site) || !isDict(approval.site.github)) return null;
  const { repo, newRepo } = approval.site.github;
  if (typeof repo !== "string" || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(repo)) return null;
  return `Saves the source to GitHub: ${repo} (${newRepo === true ? "new private repo" : "private"})`;
}

/** The link's words: a version's preview, or on a domain card the website as it is now. */
export function sitePreviewLabel(approval: unknown): string {
  return isDict(approval) && isDict(approval.site) && isDict(approval.site.domains) ? "Open site" : "Open preview";
}

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * A domain card (Phase 5): the names its Allow attaches, or takes off, in one
 * line; null on a version's card or a card whose names are not plain
 * hostnames. The phone's siteRules.ts says the same.
 */
export function siteDomains(approval: unknown): string | null {
  if (!isDict(approval) || !isDict(approval.site) || !isDict(approval.site.domains)) return null;
  const { hosts, remove, replaceRecords } = approval.site.domains;
  if (!Array.isArray(hosts) || hosts.length === 0 || !hosts.every((host) => typeof host === "string" && HOST.test(host))) return null;
  if (remove === true) return `Takes off: ${hosts.join(", ")}`;
  return `Attaches: ${hosts.join(", ")}${replaceRecords === true ? " (replaces their DNS records)" : ""}`;
}

/** One screenshot on a website card: where it is on the computer, its name, size in bytes and pixels. */
export type SiteShot = { path: string; name: string; bytes: number; width: number; height: number };

/**
 * The site check's screenshots of a version's home page on its card (Phase 2), desktop then phone: only absolute paths to
 * a JPEG or PNG with whole sizes, at most two; none on a domain card or from an
 * agent before the check. The phone's siteRules.ts is the same rule.
 */
export function siteShots(approval: unknown): SiteShot[] {
  if (!isDict(approval) || !isDict(approval.site) || approval.site.domains || !Array.isArray(approval.site.shots)) return [];
  const whole = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0;
  return approval.site.shots
    .filter((shot): shot is SiteShot => isDict(shot) && typeof shot.path === "string" && shot.path.startsWith("/") && !shot.path.includes("/../") && /\.(?:jpe?g|png)$/i.test(shot.path) && typeof shot.name === "string" && whole(shot.bytes) && whole(shot.width) && whole(shot.height))
    .slice(0, 2);
}
