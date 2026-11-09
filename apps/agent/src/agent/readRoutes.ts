// /orch/google/*: a Foreman's reads of the person's own Google account. orch.ts checks the key (a Foreman's, for its own
// project; the Lead's key, a phone's and anything else are refused there, and
// Workers and jobs hold no key at all) and finds the project; this file checks
// that the project's trade reads that source (trades.ts tradeReads), checks
// the body, and asks calendar.ts or gmailRead.ts.
//
//   POST /orch/google/calendar     {from, to, query?, max?}  the events on the calendars the person shows
//   POST /orch/google/mail/search  {query, max?}             messages matching a Gmail search, metadata only
//   POST /orch/google/mail/read    {id}                      one message: headers, text, attachments by name
//
// Replies: 200 with CalendarResult, MailSearchResult or MailMessage; 400 for
// a body the read refuses, with the one thing wrong; 403 for a trade that
// does not read this source; 409 when the person has not turned the read on
// (the message is the step: Settings → Integrations → Google) or the Google
// connection needs them (link, connect, reconnect); 503 when the token broker
// could not hand out a token; 502 when Google refused, in its words. The log
// says what was read and how much, never a title, an address or a word of
// mail.
import type { Project } from "@cobra/contracts";

import { calendarEvents, calendarRequest, type CalendarRequest, type CalendarResult, type GoogleRead, GoogleReadOffError, ReadRequestError } from "./calendar.ts";
import { boxName, boxRead, boxSearch } from "./boxMail.ts";
import { boxOfProject } from "./emailLive.ts";
import { mailRead, mailSearch, mailSearchRequest, messageId, type MailMessage, type MailSearchResult } from "./gmailRead.ts";
import { MailboxError, type Mailbox } from "./mailboxes.ts";
import { GoogleAuthError } from "./googleAuth.ts";
import { tradeReads } from "./trades.ts";

export const CALENDAR_ROUTE = "/orch/google/calendar";
export const MAIL_SEARCH_ROUTE = "/orch/google/mail/search";
export const MAIL_READ_ROUTE = "/orch/google/mail/read";

/** Which read each route is. */
export const ROUTE_READS: Readonly<Record<string, GoogleRead>> = {
  [CALENDAR_ROUTE]: "calendar",
  [MAIL_SEARCH_ROUTE]: "mail",
  [MAIL_READ_ROUTE]: "mail",
};

/** All POSTs, all a Foreman's. */
export const READ_ROUTES: ReadonlySet<string> = new Set(Object.keys(ROUTE_READS));

/** The largest body a read takes: dates, a query and an id. */
export const READ_BODY_LIMIT = 10_000;

export type Reply = { status: number; body: unknown };

/** The reads as this file uses them; tests give fakes. */
export type ReadDeps = {
  calendar: (request: CalendarRequest) => Promise<CalendarResult>;
  mailSearch: (request: { query: string; max?: number }) => Promise<MailSearchResult>;
  mailRead: (id: string) => Promise<MailMessage>;
  /** The Space's own mailbox (Settings → Mailboxes) a project's mail reads go to instead of Gmail, or null. */
  boxOf: (project: Project) => Mailbox | null;
  boxSearch: (box: Mailbox, request: { query: string; max?: number }) => Promise<MailSearchResult>;
  boxRead: (box: Mailbox, id: string) => Promise<MailMessage>;
};

export function liveReadDeps(): ReadDeps {
  return {
    calendar: (request) => calendarEvents({}, request),
    mailSearch: (request) => mailSearch({}, request),
    mailRead: (id) => mailRead({}, id),
    boxOf: boxOfProject,
    boxSearch: (box, request) => boxSearch(box, request),
    boxRead: (box, id) => boxRead(box, id),
  };
}

const WORDS: Readonly<Record<GoogleRead, string>> = { calendar: "the person's calendar", mail: "the person's mail" };

/** The trade's name for the refusal. */
const tradeName = (project: Project): string => project.foremanTemplate ?? "none";

/**
 * One /orch/google/* request for a project the caller's key is held to.
 * `body` is the parsed JSON body.
 */
export async function handleRead(route: string, body: Record<string, unknown>, project: Project, deps: ReadDeps, log: (line: string) => void): Promise<Reply> {
  const read = ROUTE_READS[route];
  if (!read) return { status: 404, body: { error: `no read at ${route}` } };
  if (!tradeReads(project.foremanTemplate).includes(read)) {
    return { status: 403, body: { error: `${project.name}'s trade (${tradeName(project)}) does not read ${WORDS[read]}, so this Foreman has no ${read} read` } };
  }
  try {
    if (route === CALENDAR_ROUTE) {
      calendarRequest(body);
      const request: CalendarRequest = { from: body.from as string, to: body.to as string };
      if (typeof body.query === "string") request.query = body.query;
      if (typeof body.max === "number") request.max = body.max;
      const result = await deps.calendar(request);
      log(`google read: calendar for ${project.id}, ${result.events.length} events from ${result.calendars.length} calendars`);
      return { status: 200, body: result };
    }
    // A Space with its own mailbox reads that box, on as soon as the person linked it (Sam, 2026-11-05); Gmail otherwise.
    const box = deps.boxOf(project);
    if (box) {
      if (route === MAIL_SEARCH_ROUTE) {
        const { query, max } = mailSearchRequest(body);
        const result = await deps.boxSearch(box, { query, max });
        log(`mailbox read: search of ${box.id} for ${project.id}, ${result.messages.length} messages`);
        return { status: 200, body: { ...result, mailbox: boxName(box) } };
      }
      const message = await deps.boxRead(box, messageId(body.id));
      log(`mailbox read: one message of ${box.id} for ${project.id}, ${message.text.length} characters, ${message.attachments.length} attachments`);
      return { status: 200, body: { ...message, mailbox: boxName(box) } };
    }
    if (route === MAIL_SEARCH_ROUTE) {
      const { query, max } = mailSearchRequest(body);
      const result = await deps.mailSearch({ query, max });
      log(`google read: mail search for ${project.id}, ${result.messages.length} messages`);
      return { status: 200, body: result };
    }
    const id = messageId(body.id);
    const message = await deps.mailRead(id);
    log(`google read: one message for ${project.id}, ${message.text.length} characters, ${message.attachments.length} attachments`);
    return { status: 200, body: message };
  } catch (caught) {
    if (caught instanceof ReadRequestError) return { status: 400, body: { error: caught.message } };
    // A mailbox's own problem (its login refused, its server away): the message says the step, never the password.
    if (caught instanceof MailboxError) {
      log(`mailbox read: ${read} for ${project.id} refused (${caught.status})`);
      return { status: caught.status, body: { error: caught.message, problem: "mailbox" } };
    }
    // A read the person has not turned on: the message is the step, and `read` says which.
    if (caught instanceof GoogleReadOffError) {
      log(`google read: ${read} for ${project.id} refused: not turned on`);
      return { status: 409, body: { error: caught.message, problem: "read_off", read: caught.read } };
    }
    // The connection itself (not linked, not connected, connect again, the cloud away): its message is the step too.
    if (caught instanceof GoogleAuthError) {
      log(`google read: ${read} for ${project.id} refused: ${caught.problem}`);
      return { status: caught.status, body: { error: caught.message, problem: caught.problem } };
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    log(`google read: ${read} for ${project.id} failed`);
    return { status: 502, body: { error: message } };
  }
}
