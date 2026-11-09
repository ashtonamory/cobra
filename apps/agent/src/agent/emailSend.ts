/**
 * Sending a Space's due email jobs, one at a time, and drawing a sent email again from
 * its ledger row.
 *
 * A job names an allowed template version and its hash. Right before each
 * send the agent reads that version, checks its hash, makes the theme from
 * today's brand kit (kept by its hash), renders, attaches the images the
 * email draws as parts of the message (cid:), and sends through the mail
 * adapter. A row goes in the ledger and on the person's People timeline.
 * Images are content ids made from their bytes, so the same inputs always
 * render the same HTML and the same hash.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { EmailTemplate, EmailValues } from "../../../../packages/contracts/src/emailTemplate.ts";
import { currentTheme, HOSTED_PATH, hostedName, keepTheme, readImage, readTheme, readVersion, type EmailFolders, type ImageFile, type ThemePlace } from "./emailFiles.ts";
import { audit, recipients } from "./auditTrail.ts";
import { clickUrl, unsubscribeUrl } from "./emailLinks.ts";
import type { EmailJob, EmailQueue, SendRow, SentLinks } from "./emailQueue.ts";
import { render, RENDERER_VERSION, type RenderImage, type Rendered } from "./emailRender.ts";
import type { EmailTheme } from "./emailTheme.ts";
import { MailSendError, type MailAdapter } from "./mailAdapter.ts";
import type { MailHeader, MailInline } from "./mime.ts";
import type { EmailSite } from "./site.ts";

export type PeopleLink = {
  /** The person with this email in the Space's People, or null. */
  personByEmail: (email: string) => number | null;
  /** One line on their timeline, as the agent. */
  timeline: (person: number, entry: { summary: string; on: string; ref: string; /** outreach, marketing or transactional: an outreach send also makes the CRM's follow-up. */ kind?: string; subject?: string }) => void;
};

export type SendDeps = {
  folders: EmailFolders;
  queue: EmailQueue;
  adapter: MailAdapter;
  place: () => ThemePlace;
  people: PeopleLink | null;
  now: () => Date;
  log: (line: string) => void;
  /**
   * Right before the send (emailAudience.ts): why this address may not get it,
   * or null. A bounce stops every kind; an unsubscribe, a left topic or a
   * person gone stops anything but transactional mail. Absent, nothing stops it.
   */
  stopped?: (to: string, kind: string, topic: string | undefined) => string | null;
  /**
   * The Space's live website with email links (site.ts emailSite), read right
   * before each send: links go through its click redirect and images from it;
   * marketing email needs it for its unsubscribe page. Absent or null, links
   * go as written, images as parts of the message, and marketing cannot go.
   */
  site?: () => EmailSite | null;
  /** The topics this address is in, for the unsubscribe page (the email's own is always offered). */
  topicsOf?: (to: string) => string[];
};

/** How one send's links and images go: the website's, or the ones a ledger row kept. */
export type SendWith = {
  unsubscribe?: string;
  link?: (href: string, index: number) => string;
  hosted?: (file: string, image: ImageFile) => string | null;
};

/** The Space website's links for one job: click redirects for https links, its hosted images, and for marketing the unsubscribe page. */
export function siteLinks(site: EmailSite, job: { id: number; to: string }, marketing: { topic?: string; topics: string[] } | null): SendWith {
  const base = site.address.endsWith("/") ? site.address : `${site.address}/`;
  return {
    ...(marketing
      ? { unsubscribe: unsubscribeUrl(base, site.key, { job: job.id, email: job.to, topics: [...new Set([...(marketing.topic ? [marketing.topic] : []), ...marketing.topics])], ...(marketing.topic ? { topic: marketing.topic } : {}) }) }
      : {}),
    link: (href, index) => clickUrl(base, site.key, { job: job.id, link: index, href }),
    hosted: (_file, image) => {
      const name = hostedName(image);
      return site.images.includes(name) ? `${base}${HOSTED_PATH}/${name}` : null;
    },
  };
}

/** The same links again, from a ledger row. */
export function keptLinks(kept: SentLinks): SendWith {
  return {
    ...(kept.unsubscribe ? { unsubscribe: kept.unsubscribe } : {}),
    link: (href, index) => kept.links[index] ?? href,
    hosted: (file) => kept.images[file] ?? null,
  };
}

/** The headers a mail app's own unsubscribe button reads (RFC 2369 and RFC 8058). */
export function unsubscribeHeaders(address: string): MailHeader[] {
  return [
    { name: "List-Unsubscribe", value: `<${address}>` },
    { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
  ];
}

export type SendOutcome =
  | { sent: SendRow }
  | { failed: EmailJob; error: string; state: string }
  | { wait: "none" | "gap" | "cap" | "account"; until?: string; why?: string };

/** A file's content id: its bytes' hash, so it never changes while the file does not. */
export function contentId(bytes: Buffer): string {
  return `${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}@cobra.email`;
}

/**
 * Renders a template for sending: an image the website hosts by its address,
 * any other a part of the message; links as `how` sends them. `links` is what
 * the ledger keeps (null when everything went as written).
 */
export function renderForSend(folders: EmailFolders, theme: EmailTheme, template: EmailTemplate, values: EmailValues, how: SendWith = {}): { rendered: Rendered; inline: MailInline[]; links: SentLinks | null } {
  const parts = new Map<string, MailInline>();
  const kept: SentLinks = { links: [], images: {}, ...(how.unsubscribe ? { unsubscribe: how.unsubscribe } : {}) };
  const rendered = render(theme, template, values, {
    image: (file) => {
      const image = readImage(folders, file);
      if (!image) return null;
      const hosted = how.hosted?.(file, image);
      if (hosted) {
        kept.images[file] = hosted;
        return { src: hosted, width: image.width, height: image.height };
      }
      const cid = contentId(image.bytes);
      parts.set(file, { cid, name: file.split("/").pop()!, data: image.bytes, type: image.type });
      return { src: `cid:${cid}`, width: image.width, height: image.height };
    },
    ...(how.link
      ? {
          link: (href: string, index: number) => {
            const out = how.link!(href, index);
            kept.links[index] = out;
            return out;
          },
        }
      : {}),
    ...(how.unsubscribe ? { unsubscribe: how.unsubscribe } : {}),
  });
  const changed = kept.unsubscribe !== undefined || kept.links.length > 0 || Object.keys(kept.images).length > 0;
  return { rendered, inline: rendered.images.map((file) => parts.get(file)!).filter(Boolean), links: changed ? { ...kept, links: Array.from(kept.links, (l) => l ?? null) } : null };
}

/** Renders a template to look at (a card, a phone preview): images inline as data: addresses. */
export function renderForView(folders: EmailFolders, theme: EmailTheme, template: EmailTemplate, values: EmailValues): Rendered {
  return render(theme, template, values, {
    image: (file): RenderImage | null => {
      const image = readImage(folders, file);
      return image ? { src: `data:${image.type};base64,${image.bytes.toString("base64")}`, width: image.width, height: image.height } : null;
    },
    preview: true,
  });
}

/** Sends the next due job, if one may go now. Never more than one per call. */
export async function sendNext(deps: SendDeps): Promise<SendOutcome> {
  let account: string;
  try {
    account = await deps.adapter.account();
  } catch (caught) {
    return { wait: "account", why: caught instanceof Error ? caught.message : String(caught) };
  }
  const now = deps.now();
  const picked = deps.queue.next(account, now, deps.adapter.dailyCap);
  if ("wait" in picked) return picked;
  const job = picked.job;
  const fail = (error: string, how: "retry" | "hard" | "unsure"): SendOutcome => {
    const state = deps.queue.failed(job, error, how, deps.now());
    deps.log(`email job ${job.id} (${job.template} v${job.version}): ${state}: ${error}`);
    return { failed: job, error, state };
  };

  const version = readVersion(deps.folders, job.template, job.version);
  if (!version || version.sha256 !== job.templateSha) return fail(`template ${job.template} v${job.version} is gone or changed since it was allowed`, "hard");
  // By the template's kind (a sequence step of a transactional template is still transactional), except an outreach copy: never topics, only a bounce or an unsubscribe.
  // A test (the Marketing board's Send me a test) goes to the owner's own address: like outreach, only a bounce stops it.
  const stop = deps.stopped?.(job.to, job.kind === "outreach" || job.kind === "test" ? "outreach" : version.template.kind, version.template.topic);
  if (stop) return fail(`not sent: ${stop}`, "hard");
  const marketing = version.template.kind === "marketing";
  const site = deps.site?.() ?? null;
  if (marketing && !site) return fail("not sent: marketing email needs the Space website live with its unsubscribe page (publish the website again)", "hard");
  const how = site ? siteLinks(site, job, marketing ? { ...(version.template.topic ? { topic: version.template.topic } : {}), topics: deps.topicsOf?.(job.to) ?? [] } : null) : {};
  const theme = currentTheme(deps.folders, deps.place());
  const themeSha = keepTheme(deps.folders, theme);
  const { rendered, inline, links } = renderForSend(deps.folders, theme, version.template, job.values as EmailValues, how);
  if (rendered.errors.length) return fail(rendered.errors.join("; "), "hard");

  if (!deps.queue.start(job.id)) return { wait: "none" };
  let sent;
  try {
    sent = await deps.adapter.send({ to: [job.to], subject: rendered.subject, text: rendered.text, html: rendered.html, inline, fromName: theme.business, ...(how.unsubscribe ? { headers: unsubscribeHeaders(how.unsubscribe) } : {}) });
  } catch (caught) {
    const how = caught instanceof MailSendError ? caught.how : "hard";
    return fail(caught instanceof Error ? caught.message : String(caught), how);
  }
  const sentAt = deps.now().toISOString();
  const sendId = deps.queue.sent(job, {
    themeSha,
    renderer: RENDERER_VERSION,
    provider: deps.adapter.provider,
    account: sent.account,
    messageId: sent.messageId,
    providerId: sent.providerId,
    threadId: sent.threadId ?? null,
    sha256: rendered.sha256,
    subject: rendered.subject,
    sentAt,
    links,
  });
  const row = deps.queue.send(sendId)!;
  deps.log(`email ${sendId} sent: ${job.template} v${job.version} to ${job.to}`);
  // One record per email that went (auditTrail.ts): the domain and the hash of what was sent, never its words.
  audit("email.sent", {
    actor: job.kind === "test" ? "person" : "agent",
    subject: { project: basename(deps.folders.space), ...(job.approval ? { card: job.approval } : {}), target: `email ${sendId}` },
    detail: { ...recipients([job.to]), kind: job.kind, template: `${job.template} v${job.version}`, sha256: rendered.sha256, provider: deps.adapter.provider },
  });
  if (deps.people && job.kind !== "test") {
    try {
      const person = job.personId ?? deps.people.personByEmail(job.to);
      if (person !== null) deps.people.timeline(person, { summary: `Email sent: ${rendered.subject} (${version.template.name})`, on: sentAt.slice(0, 10), ref: `email:${sendId}`, kind: job.kind === "outreach" ? "outreach" : version.template.kind, subject: rendered.subject });
    } catch (caught) {
      deps.log(`email ${sendId}: the People timeline was not written (${caught instanceof Error ? caught.message : String(caught)})`);
    }
  }
  return { sent: row };
}

export type SentView = { row: SendRow; html: string; text: string; subject: string; matches: boolean; note?: string };

/**
 * A sent email drawn again from its ledger row: the version, the theme it
 * went with and the values, rendered as it was sent and checked against the
 * row's hash. When the renderer changed since, or a file is gone, the drawing
 * may differ, and the note says the exact email is in the Sent folder.
 */
export function showSent(folders: EmailFolders, row: SendRow): SentView | { error: string } {
  const version = readVersion(folders, row.template, row.version);
  const theme = readTheme(folders, row.themeSha);
  if (!version || version.sha256 !== row.templateSha) return { error: `template ${row.template} v${row.version} is no longer here; the exact email is in the Sent folder (Message-ID ${row.messageId})` };
  if (!theme) return { error: `the theme it went with is no longer here; the exact email is in the Sent folder (Message-ID ${row.messageId})` };
  const { rendered } = renderForSend(folders, theme, version.template, row.values as EmailValues, row.links ? keptLinks(row.links) : {});
  const matches = rendered.sha256 === row.sha256;
  const view = renderForView(folders, theme, version.template, row.values as EmailValues);
  const note = matches
    ? undefined
    : row.renderer !== RENDERER_VERSION
      ? `drawn by a newer renderer (${RENDERER_VERSION}, it went with ${row.renderer}); the exact email is in the Sent folder (Message-ID ${row.messageId})`
      : `this drawing differs from what went (an image changed?); the exact email is in the Sent folder (Message-ID ${row.messageId})`;
  return { row, html: view.html, text: rendered.text, subject: rendered.subject, matches, ...(note ? { note } : {}) };
}
