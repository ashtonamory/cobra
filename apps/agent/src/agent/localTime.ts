// Times for the Lead and the Foremen to repeat to the person: the computer's local
// time with its offset, never UTC. Stored data, files and API fields stay ISO/UTC;
// only text meant for the model or the person goes through here.

export type When = Date | string | number;

/** The computer's IANA time zone, or the one given (the tests fix it). */
export function localZone(timeZone?: string): string {
  return timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function toMs(when: When): number {
  return when instanceof Date ? when.getTime() : typeof when === "number" ? when : Date.parse(when);
}

function parts(ms: number, timeZone: string): Record<string, string> {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(ms);
  return Object.fromEntries(formatted.map((part) => [part.type, part.value]));
}

/** "in 3h 12m", "12m ago", "just now"; days once it is more than 48 hours away. */
export function relative(whenMs: number, nowMs: number): string {
  const diff = whenMs - nowMs;
  const minutes = Math.round(Math.abs(diff) / 60_000);
  if (minutes < 1) return "just now";
  let text: string;
  if (minutes < 60) text = `${minutes}m`;
  else if (minutes < 48 * 60) text = minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes / 60}h`;
  else {
    const days = Math.floor(minutes / 1440);
    const hours = Math.round((minutes % 1440) / 60);
    text = hours ? `${days}d ${hours}h` : `${days}d`;
  }
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

/**
 * "Sat 10 Oct 01:00 BST (in 3h 12m)". The year is added when it is not the current
 * one. Returns the input unchanged when it is not a time.
 */
export function formatLocal(when: When, now: When = Date.now(), timeZone?: string): string {
  const ms = toMs(when);
  if (!Number.isFinite(ms)) return String(when);
  const nowMs = toMs(now);
  const zone = localZone(timeZone);
  const p = parts(ms, zone);
  const year = p.year !== parts(nowMs, zone).year ? ` ${p.year}` : "";
  return `${p.weekday} ${p.day} ${p.month}${year} ${p.hour}:${p.minute} ${p.timeZoneName} (${relative(ms, nowMs)})`;
}

/** The anchor at the top of status: "Now: Fri 9 Oct 2026 14:05 BST, time zone Europe/London." */
export function nowLine(now: When = Date.now(), timeZone?: string): string {
  const zone = localZone(timeZone);
  const p = parts(toMs(now), zone);
  return `Now: ${p.weekday} ${p.day} ${p.month} ${p.year} ${p.hour}:${p.minute} ${p.timeZoneName}, time zone ${zone}. Give the person times in local time like this, never in UTC.`;
}

// An ISO-8601 time that says its offset ("Z" or "+00:00"), with or without seconds
// and fractions. One with no offset is left alone: it has no zone to convert from.
const ISO_WITH_OFFSET = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;

/** Every ISO time inside a line of text, written in local time. */
export function localizeText(text: string, now: When = Date.now(), timeZone?: string): string {
  return text.replace(ISO_WITH_OFFSET, (iso) => (Number.isFinite(Date.parse(iso)) ? formatLocal(iso, now, timeZone) : iso));
}
