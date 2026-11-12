// /orch/mail/*: a Foreman's reads of the mailbox the person linked for its
// Space (Settings → Mailboxes). orch.ts checks the key (a Foreman's, for its
// own project; the Lead's key and anything else are refused there, and
// Workers and jobs hold no key at all) and finds the project; this file checks
// that the project's trade reads mail (trades.ts tradeReads), checks the body,
// and asks boxMail.ts.
//
//   POST /orch/mail/search  {query, max?}  messages matching the search, metadata only
//   POST /orch/mail/read    {id}           one message: headers, text, attachments by name
//
// Cobra has no Google connection of its own, so nothing here reads Gmail or a
// calendar: those come through the connectors the person adds, with the
// connectors' own tools.
//
// Replies: 200 with MailSearchResult or MailMessage; 400 for a body the read
// refuses, with the one thing wrong; 403 for a trade that does not read mail;
// 409 when the Space has no mailbox linked (the message is the step:
// Settings → Mailboxes); the mailbox's own status when its login is refused
// or its server is away; 502 for anything else, in its words. The log says
// what was read and how much, never an address or a word of mail.
import type { Project } from "@cobra/contracts";

import { NO_MAILBOX } from "./actions.ts";
import { boxName, boxRead, boxSearch } from "./boxMail.ts";
import { boxOfProject } from "./emailLive.ts";
import { MailboxError, type Mailbox } from "./mailboxes.ts";
import { mailSearchRequest, messageId, type MailMessage, type MailSearchResult, ReadRequestError } from "./mailShapes.ts";
import { tradeReads } from "./trades.ts";

export const MAIL_SEARCH_ROUTE = "/orch/mail/search";
export const MAIL_READ_ROUTE = "/orch/mail/read";

/** All POSTs, all a Foreman's. */
export const READ_ROUTES: ReadonlySet<string> = new Set([MAIL_SEARCH_ROUTE, MAIL_READ_ROUTE]);

/** The largest body a read takes: a query and an id. */
export const READ_BODY_LIMIT = 10_000;

export type Reply = { status: number; body: unknown };

/** The reads as this file uses them; tests give fakes. */
export type ReadDeps = {
  /** The Space's own mailbox (Settings → Mailboxes) a project's mail reads go to, or null when it has none. */
  boxOf: (project: Project) => Mailbox | null;
  boxSearch: (box: Mailbox, request: { query: string; max?: number }) => Promise<MailSearchResult>;
  boxRead: (box: Mailbox, id: string) => Promise<MailMessage>;
};

export function liveReadDeps(): ReadDeps {
  return {
    boxOf: boxOfProject,
    boxSearch: (box, request) => boxSearch(box, request),
    boxRead: (box, id) => boxRead(box, id),
  };
}

/** The trade's name for the refusal. */
const tradeName = (project: Project): string => project.foremanTemplate ?? "none";

/**
 * One /orch/mail/* request for a project the caller's key is held to.
 * `body` is the parsed JSON body.
 */
export async function handleRead(route: string, body: Record<string, unknown>, project: Project, deps: ReadDeps, log: (line: string) => void): Promise<Reply> {
  if (!READ_ROUTES.has(route)) return { status: 404, body: { error: `no read at ${route}` } };
  if (!tradeReads(project.foremanTemplate).includes("mail")) {
    return { status: 403, body: { error: `${project.name}'s trade (${tradeName(project)}) does not read mail, so this Foreman has no mail read` } };
  }
  const box = deps.boxOf(project);
  // No mailbox linked: the message is the step, said before the body is looked at.
  if (!box) {
    log(`mailbox read: ${project.id} refused: its Space has no mailbox`);
    return { status: 409, body: { error: NO_MAILBOX, problem: "mailbox" } };
  }
  try {
    if (route === MAIL_SEARCH_ROUTE) {
      const { query, max } = mailSearchRequest(body);
      const result = await deps.boxSearch(box, { query, max });
      log(`mailbox read: search of ${box.id} for ${project.id}, ${result.messages.length} messages`);
      return { status: 200, body: { ...result, mailbox: boxName(box) } };
    }
    const message = await deps.boxRead(box, messageId(body.id));
    log(`mailbox read: one message of ${box.id} for ${project.id}, ${message.text.length} characters, ${message.attachments.length} attachments`);
    return { status: 200, body: { ...message, mailbox: boxName(box) } };
  } catch (caught) {
    if (caught instanceof ReadRequestError) return { status: 400, body: { error: caught.message } };
    // A mailbox's own problem (its login refused, its server away): the message says the step, never the password.
    if (caught instanceof MailboxError) {
      log(`mailbox read: ${project.id} refused (${caught.status})`);
      return { status: caught.status, body: { error: caught.message, problem: "mailbox" } };
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    log(`mailbox read: ${project.id} failed`);
    return { status: 502, body: { error: message } };
  }
}
