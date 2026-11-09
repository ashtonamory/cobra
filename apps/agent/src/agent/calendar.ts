import { clearGoogleGrant, GoogleAuthError, type GoogleGrant, googleGrant, SCOPE_CALENDAR_READONLY, SCOPE_GMAIL_MODIFY, SCOPE_GMAIL_READONLY } from "./googleAuth.ts";
import { googleRefusal } from "./gmail.ts";
import { scrubSecrets } from "./redact.ts";

/**
 * The person's calendar, read for a Foreman. It runs on
 * the account's Google connection (googleAuth.ts) with the
 * `calendar.readonly` scope, which the person turns on as its own step
 * ("Let Cobra read your calendar"), never in the first Connect. Without it
 * the read is a GoogleReadOffError that says where to turn it on.
 *
 * It reads the calendars the person shows in Google Calendar (the calendar
 * list's `selected`), the events in a span of at most 31 days, at most 100,
 * each trimmed to what a plan for the day needs. Free text (the title, the
 * place, the description) passes `scrubSecrets` before a model reads it; the
 * addresses stay, since a proposed reply needs them.
 *
 * This file also holds what gmailRead.ts shares: the deps, one GET with a 401
 * retried once on a fresh grant, the read-off error and the request error.
 */

export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
/** One API call must answer in this long. */
export const READ_TIMEOUT_MS = 30_000;
/** The widest span read at once. */
export const MAX_SPAN_DAYS = 31;
/** The most events returned, across every calendar. */
export const MAX_EVENTS = 100;
/** The most attendees kept on one event. */
export const MAX_ATTENDEES = 20;
/** A description is cut to this many characters. */
export const DESCRIPTION_MAX = 2000;
/** A search's text, at most. */
export const QUERY_MAX = 200;

const DAY_MS = 86_400_000;

// --- shared with gmailRead.ts -------------------------------------------------------

/** What a read needs; tests give fakes. */
export type GoogleReadDeps = {
  fetcher: typeof fetch;
  /** The connection's grant, scopes and all; the read checks its own scope. */
  grant: () => Promise<GoogleGrant>;
  /** Drops the grant held, after Google answered 401 with it. */
  clearGrant: () => void;
};

export const LIVE_READ_DEPS: GoogleReadDeps = { fetcher: fetch, grant: googleGrant, clearGrant: clearGoogleGrant };

/** The two reads a person turns on, each its own step in Settings → Integrations → Google. */
export type GoogleRead = "calendar" | "mail";

export const READ_SCOPES: Readonly<Record<GoogleRead, string>> = { calendar: SCOPE_CALENDAR_READONLY, mail: SCOPE_GMAIL_READONLY };

const TURN_ON: Readonly<Record<GoogleRead, string>> = {
  calendar: "Cobra cannot read the person's calendar yet: the person turns on Calendar in the app, Settings → Integrations → Google (\"Let Cobra read your calendar\")",
  mail: "Cobra cannot read the person's mail yet: the person turns on Mail in the app, Settings → Integrations → Google (\"Let Cobra read your mail\")",
};

/**
 * The account's Google connection works but does not carry this read's scope:
 * a 409 whose message is the step to take. A GoogleAuthError, so whatever
 * already passes those on as they are does so with this one too.
 */
export class GoogleReadOffError extends GoogleAuthError {
  read: GoogleRead;
  constructor(read: GoogleRead) {
    super("google_reconnect");
    this.message = TURN_ON[read];
    this.read = read;
  }
}

/** A request the read refuses before anything reaches Google: a 400, its message the one thing wrong. */
export class ReadRequestError extends Error {
  status = 400;
}

/** A broader scope that also reads: organizing mail (gmail.modify) reads everything the Mail read does. */
const ALSO_READS: Readonly<Partial<Record<GoogleRead, string>>> = { mail: SCOPE_GMAIL_MODIFY };

/** The grant, when it carries the read's scope (or one that reads as much); else the read-off error. A GoogleAuthError from the connection itself passes as it is. */
export async function grantForRead(deps: GoogleReadDeps, read: GoogleRead): Promise<GoogleGrant> {
  const grant = await deps.grant();
  const broader = ALSO_READS[read];
  if (!grant.scopes.includes(READ_SCOPES[read]) && !(broader && grant.scopes.includes(broader))) throw new GoogleReadOffError(read);
  return grant;
}

const SCOPE_REFUSED = /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i;

/**
 * One GET as JSON, on a grant for the read: a 401 drops the grant and asks
 * once more with a fresh one, a second 401 says connect again. Google's other
 * refusals are Errors in googleRefusal's words, never the token.
 */
export async function readJson(deps: GoogleReadDeps, read: GoogleRead, service: string, url: string): Promise<unknown> {
  let grant = await grantForRead(deps, read);
  let response = await get(deps, service, url, grant);
  if (response.status === 401) {
    await response.text().catch(() => "");
    deps.clearGrant();
    grant = await grantForRead(deps, read);
    response = await get(deps, service, url, grant);
    if (response.status === 401) {
      await response.text().catch(() => "");
      deps.clearGrant();
      throw new GoogleAuthError("google_reconnect", `${service} refused a fresh sign-in too`);
    }
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    // The grant listed the scope but Google says otherwise: the read is off for Google, whatever the cloud said.
    if (response.status === 403 && SCOPE_REFUSED.test(text)) throw new GoogleReadOffError(read);
    throw new Error(googleRefusal(service, response.status, text));
  }
  try {
    return text.trim() === "" ? {} : (JSON.parse(text) as unknown);
  } catch {
    throw new Error(`${service} answered with something that is not JSON`);
  }
}

async function get(deps: GoogleReadDeps, service: string, url: string, grant: GoogleGrant): Promise<Response> {
  try {
    return await deps.fetcher(url, {
      method: "GET",
      headers: { authorization: `Bearer ${grant.accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (caught) {
    const why = caught instanceof Error ? (caught.name === "TimeoutError" ? `no answer in ${READ_TIMEOUT_MS / 1000} s` : caught.message) : String(caught);
    throw new Error(`${service} could not be reached: ${why}`);
  }
}

/** Text as a model may read it: secrets out, cut to `max` characters with the cut said. */
export function readable(text: string, max: number): string {
  const scrubbed = scrubSecrets(text);
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}… [cut at ${max} characters]` : scrubbed;
}

/** A search's text: optional, one line, at most `max` characters. */
export function queryText(raw: unknown, max: number, required: boolean): string | undefined {
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw new ReadRequestError("query is needed");
    return undefined;
  }
  if (typeof raw !== "string") throw new ReadRequestError("query is text");
  const query = raw.replace(/\s+/g, " ").trim();
  if (!query) {
    if (required) throw new ReadRequestError("query is needed");
    return undefined;
  }
  if (query.length > max) throw new ReadRequestError(`query is at most ${max} characters`);
  return query;
}

/** A whole number in 1..most, or `fallback` when left out. */
export function countOf(raw: unknown, most: number, fallback: number, name = "max"): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > most) throw new ReadRequestError(`${name} is a whole number from 1 to ${most}`);
  return raw;
}

// --- the calendar ---------------------------------------------------------------------

export type CalendarRequest = { from: string; to: string; query?: string; max?: number };

export type CalendarAttendee = { email: string; answer: string };

export type CalendarEvent = {
  /** The calendar's name, as the person sees it. */
  calendar: string;
  title: string;
  /** RFC 3339 with an offset, or YYYY-MM-DD for an all-day event. */
  start: string;
  /** As start; an all-day event's end is the day after its last, as Google gives it. */
  end: string;
  allDay: boolean;
  location?: string;
  organizer?: string;
  /** At most MAX_ATTENDEES; `moreAttendees` counts the rest. */
  attendees: CalendarAttendee[];
  moreAttendees?: number;
  /** confirmed, tentative or cancelled. */
  status: string;
  meetingLink?: string;
  /** Cut to DESCRIPTION_MAX characters. */
  description?: string;
};

export type CalendarResult = {
  /** The span read, as RFC 3339 instants. */
  from: string;
  to: string;
  /** The calendars read: the ones the person shows. */
  calendars: string[];
  events: CalendarEvent[];
  /** Events beyond `max` were left out. */
  more: boolean;
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * An ISO date or date-time as a time. A date is the start of that day in this
 * computer's time zone, or, for `to`, the start of the day after, so
 * `{from: "2026-10-24", to: "2026-10-24"}` is all of the 24th. A date-time
 * with no offset is local time.
 */
export function parseWhen(raw: unknown, name: "from" | "to"): number {
  if (typeof raw !== "string" || !raw.trim()) throw new ReadRequestError(`${name} is needed: an ISO date (2026-10-24) or date-time (2026-10-24T09:00:00+01:00)`);
  const text = raw.trim();
  const date = DATE.exec(text);
  if (date) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const check = new Date(year, month - 1, day);
    if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day) throw new ReadRequestError(`${name} is not a real date: ${text}`);
    return new Date(year, month - 1, day + (name === "to" ? 1 : 0)).getTime();
  }
  const time = DATETIME.exec(text);
  if (time) {
    // With no offset, Date.parse reads a date-time as local time, which is what the Foreman means.
    const at = Date.parse(text);
    const [month, day, hour, minute] = [Number(time[2]), Number(time[3]), Number(time[4]), Number(time[5])];
    const real = new Date(Number(time[1]), month - 1, day);
    if (!Number.isFinite(at) || real.getMonth() !== month - 1 || real.getDate() !== day || hour > 23 || minute > 59) throw new ReadRequestError(`${name} is not a real time: ${text}`);
    return at;
  }
  throw new ReadRequestError(`${name} is an ISO date (2026-10-24) or date-time (2026-10-24T09:00:00+01:00), not ${text.slice(0, 40)}`);
}

/** A request as the read takes it, or a ReadRequestError: from before to, at most 31 days apart, an optional query, max 1..100. */
export function calendarRequest(body: Record<string, unknown>): { from: number; to: number; query?: string; max: number } {
  const from = parseWhen(body.from, "from");
  const to = parseWhen(body.to, "to");
  if (to <= from) throw new ReadRequestError("to is after from");
  if (to - from > MAX_SPAN_DAYS * DAY_MS) throw new ReadRequestError(`the span is at most ${MAX_SPAN_DAYS} days: read a wider one in parts`);
  const query = queryText(body.query, QUERY_MAX, false);
  return { from, to, ...(query ? { query } : {}), max: countOf(body.max, MAX_EVENTS, MAX_EVENTS) };
}

type RawCalendar = { id?: unknown; summary?: unknown; summaryOverride?: unknown; selected?: unknown };
type RawWhen = { date?: unknown; dateTime?: unknown };
type RawEvent = {
  summary?: unknown;
  start?: RawWhen;
  end?: RawWhen;
  location?: unknown;
  organizer?: { email?: unknown; displayName?: unknown };
  attendees?: Array<{ email?: unknown; responseStatus?: unknown; resource?: unknown }>;
  status?: unknown;
  hangoutLink?: unknown;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: unknown; uri?: unknown }> };
  description?: unknown;
};

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

/** Google's answer for an attendee, in words. */
const ANSWERS: Readonly<Record<string, string>> = { accepted: "accepted", declined: "declined", tentative: "maybe", needsAction: "no answer" };

/** One event as a model reads it, or null for one with no start. */
export function trimEvent(raw: RawEvent, calendar: string): CalendarEvent | null {
  const start = str(raw.start?.dateTime) ?? str(raw.start?.date);
  if (!start) return null;
  const allDay = str(raw.start?.dateTime) === undefined;
  const end = str(raw.end?.dateTime) ?? str(raw.end?.date) ?? start;
  const attendees = (Array.isArray(raw.attendees) ? raw.attendees : [])
    .filter((attendee) => attendee && typeof attendee.email === "string" && attendee.resource !== true)
    .map((attendee) => ({ email: attendee.email as string, answer: ANSWERS[String(attendee.responseStatus)] ?? "no answer" }));
  const video = (raw.conferenceData?.entryPoints ?? []).find((point) => point?.entryPointType === "video" && typeof point.uri === "string");
  const meetingLink = str(raw.hangoutLink) ?? str(video?.uri);
  const location = str(raw.location);
  const organizer = str(raw.organizer?.email);
  const description = str(raw.description);
  return {
    calendar,
    title: readable(str(raw.summary) ?? "(no title)", 300),
    start,
    end,
    allDay,
    ...(location ? { location: readable(location, 300) } : {}),
    ...(organizer ? { organizer } : {}),
    attendees: attendees.slice(0, MAX_ATTENDEES),
    ...(attendees.length > MAX_ATTENDEES ? { moreAttendees: attendees.length - MAX_ATTENDEES } : {}),
    status: str(raw.status) ?? "confirmed",
    ...(meetingLink ? { meetingLink } : {}),
    ...(description ? { description: readable(description, DESCRIPTION_MAX) } : {}),
  };
}

/** When an event starts, for sorting: an all-day date is the start of that day here. */
function startsAt(event: CalendarEvent): number {
  const date = DATE.exec(event.start);
  return date ? new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime() : Date.parse(event.start);
}

/**
 * The events from `from` to `to` on every calendar the person shows, merged
 * and in order of start, at most `max` (100). A GoogleReadOffError when the
 * person has not turned the calendar on; a ReadRequestError for a request it
 * refuses (a span over 31 days, to before from); an Error in Google's words
 * for anything Google refused.
 */
export async function calendarEvents(deps: Partial<GoogleReadDeps>, request: CalendarRequest): Promise<CalendarResult> {
  const live: GoogleReadDeps = { ...LIVE_READ_DEPS, ...deps };
  const { from, to, query, max } = calendarRequest(request as unknown as Record<string, unknown>);
  const service = "Google Calendar";

  const calendars: Array<{ id: string; name: string }> = [];
  let page: string | undefined;
  for (let pages = 0; pages < 10; pages += 1) {
    const params = new URLSearchParams({ minAccessRole: "reader", maxResults: "250" });
    if (page) params.set("pageToken", page);
    const reply = (await readJson(live, "calendar", service, `${CALENDAR_API}/users/me/calendarList?${params}`)) as { items?: RawCalendar[]; nextPageToken?: unknown };
    for (const item of Array.isArray(reply.items) ? reply.items : []) {
      // Only the calendars the person shows in Google Calendar: a subscribed holiday or a colleague's calendar left unticked is not their day.
      if (!item || item.selected !== true || typeof item.id !== "string" || !item.id) continue;
      calendars.push({ id: item.id, name: readable(str(item.summaryOverride) ?? str(item.summary) ?? item.id, 120) });
    }
    page = str(reply.nextPageToken);
    if (!page) break;
  }

  const events: CalendarEvent[] = [];
  let more = false;
  for (const calendar of calendars) {
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      // One page per calendar: more than max on one calendar is more than the answer holds anyway.
      maxResults: String(max),
    });
    if (query) params.set("q", query);
    const reply = (await readJson(live, "calendar", service, `${CALENDAR_API}/calendars/${encodeURIComponent(calendar.id)}/events?${params}`)) as { items?: RawEvent[]; nextPageToken?: unknown };
    if (str(reply.nextPageToken)) more = true;
    for (const item of Array.isArray(reply.items) ? reply.items : []) {
      const event = item ? trimEvent(item, calendar.name) : null;
      if (event) events.push(event);
    }
  }
  events.sort((a, b) => startsAt(a) - startsAt(b) || a.calendar.localeCompare(b.calendar));
  if (events.length > max) more = true;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), calendars: calendars.map((calendar) => calendar.name), events: events.slice(0, max), more };
}
