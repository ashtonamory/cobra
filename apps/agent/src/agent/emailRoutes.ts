/**
 * Branded email's routes.
 *
 * A Foreman whose project lives in a Space on this computer (orch keys):
 *   GET  /orch/email/templates                     the Space's templates, versions and drafts
 *   POST /orch/email/image {from, as?}             an image into the email images folder
 *   POST /orch/email/template/save {slug, template, htmlFile?}  the draft, checked; htmlFile reads a designed email's html from the Space's folder
 *   POST /orch/email/template/get {slug, version?}  the draft (or a version) as JSON, to change it
 *   GET  /orch/email/standard                      Cobra's email design standard and its reference email
 *   POST /orch/email/design/save {slug, design, template}  a Designer's Tessel email made into email HTML
 *                                                  (emailDesign.ts), its images copied in, saved as the draft
 *   POST /orch/email/template/preview {slug, version?, values?}  the subject and plain text as drawn, with problems
 *   POST /orch/email/template/propose {slug}       202: a card of kind `email_template`; Allow saves the draft as the next version
 *   POST /orch/email/send {template, version?, to, values?}  202: a card (action, channel branded); Allow queues it
 *   GET  /orch/email/sent?limit=&to=               the Space's ledger, newest first
 *
 * The phone and the desk (person keys):
 *   GET  /email/preview?approval=<id>              a card's email as HTML for a WebView, images inline
 *
 * Templates and sends are the person's: a template version is saved only on
 * the Allow of its card, and in phase 1 every send is its own card (trust on
 * a version comes in phase 2). Marketing email goes as a campaign (phase 3):
 *   POST /orch/email/campaign {template, version?, segment?, values?, sendAt?}  202: a card (channel campaign), never trusted
 */

import { createHash } from "node:crypto";

import type { ApprovalAction, ApprovalEmailTemplate, Project } from "@cobra/contracts";

import { BLOCK_KINDS, isDesigned, PERSON_FIELDS, sampleValues, templateFields, validateTemplate, validateValues, type EmailTemplate, type EmailValues } from "../../../../packages/contracts/src/emailTemplate.ts";
import { readdirSync } from "node:fs";
import { delayWords, triggerWords, validateSequence, type SequenceTrigger } from "../../../../packages/contracts/src/emailSequence.ts";
import { brandedText, campaignText, linkHost, sequenceText } from "./actions.ts";
import { readSequenceDraft, readSequenceVersion, saveSequenceDraft, sequenceVersions, type PinnedStep } from "./emailSequences.ts";
import { BATCH_CARD_MS, BATCH_CHANNEL, BATCH_MAX, batchText, BODY_MAX, copySha, SUBJECT_MAX, type Batch, type DraftRow } from "./emailBatch.ts";
import { AUDIENCE_MAX } from "./emailAudience.ts";
import { DAILY_CAP } from "./emailQueue.ts";
import type { EmailSite } from "./site.ts";
import { makeApproval, publicView, settle, type StoredApproval } from "./approvals.ts";
import { EMAIL_STANDARD } from "../../../../packages/contracts/src/emailHtml.ts";
import { convertDesign, EMAIL_DESIGN_RULES } from "./emailDesign.ts";
import { acceptDraft, addImage, currentTheme, EmailFileError, emailFolders, listTemplates, readDesignFile, readDraft, readHtmlFile, readReference, readVersion, saveDraft, SLUG, versionsOf, type EmailFolders, type ThemePlace } from "./emailFiles.ts";
import type { EmailQueue } from "./emailQueue.ts";
import { renderForView } from "./emailSend.ts";
import { HOOK_EVENTS, HOOK_WORDS, type HookEvent } from "./emailHooks.ts";
import { STARTERS } from "./emailStarters.ts";
import { validEmail } from "./mime.ts";

export const BRANDED_CHANNEL = "branded";
export const CAMPAIGN_CHANNEL = "campaign";
export const SEQUENCE_CHANNEL = "sequence";
/** A campaign card lives 3 days, or until its send time when that is sooner; a send time is at most 30 days ahead. */
export const CAMPAIGN_CARD_MS = 3 * 24 * 60 * 60_000;
export const CAMPAIGN_AHEAD_MS = 30 * 24 * 60 * 60_000;
/** Copies drawn on the card. */
export const CAMPAIGN_SAMPLES = 3;
const DAY_MS = 24 * 60 * 60_000;

export const ORCH_EMAIL_ROUTES = new Set([
  "/orch/email/templates",
  "/orch/email/template/get",
  "/orch/email/standard",
  "/orch/email/design/save",
  "/orch/email/image",
  "/orch/email/template/save",
  "/orch/email/template/preview",
  "/orch/email/template/propose",
  "/orch/email/send",
  "/orch/email/sent",
  "/orch/email/template/start",
  "/orch/email/hook/set",
  "/orch/email/hook/remove",
  "/orch/email/campaign",
  "/orch/email/sequence/propose",
  "/orch/email/batch",
]);
export const ORCH_EMAIL_POSTS = new Set([
  "/orch/email/template/get",
  "/orch/email/design/save",
  "/orch/email/campaign",
  "/orch/email/sequence/propose",
  "/orch/email/batch",
  "/orch/email/image",
  "/orch/email/template/save",
  "/orch/email/template/preview",
  "/orch/email/template/propose",
  "/orch/email/send",
  "/orch/email/template/start",
  "/orch/email/hook/set",
  "/orch/email/hook/remove",
]);
export const PERSON_EMAIL_ROUTES = new Set(["/email/preview", "/email/batch"]);
/** The desk's block editor (phase 6): a Space's templates and images, one template to edit, a live draw, and propose. A phone's or desk's key. */
export const EDITOR_ROUTES = new Set(["/email/templates", "/email/template", "/email/template/draw", "/email/template/propose"]);
export const EDITOR_POSTS = new Set(["/email/template/draw", "/email/template/propose"]);

export type Reply = { status: number; body: unknown };
export type SpacePlace = { id: string; dir: string; name: string };
export type PersonFound = { id: number; name: string; email: string; organization: string | null };

export type EmailRouteDeps = {
  project: (id: string) => Promise<Project | undefined>;
  /** The Space a project lives in on this computer, or null. */
  space: (project: Project) => SpacePlace | null;
  /** A Space by id, when it is open on this computer. */
  spaceById: (id: string) => SpacePlace | null;
  /** The brand kit and business name the theme is made from. */
  place: (space: SpacePlace) => ThemePlace;
  queue: (space: string) => EmailQueue;
  /** The person with this email in the Space's People, or null (or null when the Space keeps no People). */
  person: (space: string, email: string) => PersonFound | null;
  approvals: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };
  notify: (approval: StoredApproval) => Promise<void>;
  log: (line: string) => void;
  now: () => number;
  /** Trust on a template version (trustRoutes.ts trustedApproval): an approval already allowed, carried out at once; absent, every send asks. */
  trust?: { approval: (action: ApprovalAction, requestedBy: string) => StoredApproval | null; carryOut: (approval: StoredApproval) => void };
  /** Whether a session (`foreman:<project>`, `worker:<id>`) read text from outside in its conversation (taint.ts): then every send asks. */
  tainted?: (who: string) => boolean;
  /** Where a new hook starts in the Space's store (emailHooks.ts startCursor); null when the Space keeps no such rows. */
  hookStart: (space: string, event: HookEvent) => number | null;
  /** Campaigns (phase 3): the Space's live website with email links (site.ts emailSite); absent or null, no campaign. */
  emailSite?: (space: SpacePlace) => EmailSite | null;
  /** Everyone a campaign on this topic (and saved segment) reaches now, or why not. */
  audience?: (space: string, topic: string, segment?: string) => { members: PersonFound[] } | { status: number; error: string };
  /** Null when the Space has a mailbox the agent reads (bounces need it), else what the person does: choose one in Settings → Mailboxes. */
  /** Null when the Space's mailbox reads mail (bounces need it), else the step to turn it on. */
  mailOn?: (space: string) => Promise<string | null>;
  /** Where the Space's email goes from (emailLive.ts senderOf): its mailbox from Settings → Mailboxes, or none yet. Absent, replies name no sender. */
  sender?: (space: string) => Promise<{ mailbox: string; address: string | null }>;
  /** The account's daily cap, what is left of it now, and the jobs already waiting (every Space). */
  capNow?: (space: string) => Promise<{ cap: number; left: number; queued: number }>;
  /** Sequences (phase 4): null when the Space's People have what the trigger names (the stage, the date field), else what is missing. */
  sequenceTrigger?: (space: string, trigger: SequenceTrigger) => string | null;
  /** The Space's sequences in People, with their state. */
  sequences?: (space: string) => { slug: string; name: string; version: number; state: string }[];
  /** Outreach batches (phase 5): these Outreach drafts with their people and email status; null when the Space keeps none here. */
  drafts?: (space: string, ids: readonly number[]) => DraftRow[] | null;
  /** The person's change to a draft's words from a batch card (as the person). */
  editDraft?: (space: string, draft: number, subject: string, body: string) => void;
};

/** The day the last copy should go: what is left today goes first, then a cap a day. A guess: the cap is a rolling 24 hours. */
export function lastSendDay(start: Date, count: number, queued: number, left: number, cap: number): string {
  const over = queued + count - left;
  const days = over <= 0 ? 0 : Math.ceil(over / Math.max(1, cap));
  return new Date(start.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

type Caller = { id: string; kind: string; project?: string; worker?: string };

const bad = (status: number, error: string): Reply => ({ status, body: { error } });

function parse(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(bodyText || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The values a send fills a template with: what the Foreman gave, then the person's People fields for any it did not. */
export function personValues(template: EmailTemplate, given: EmailValues, person: PersonFound | null, to: string): EmailValues {
  const used = new Set(templateFields(template));
  const out: EmailValues = { ...given };
  const fill = (name: string, value: string | null | undefined) => {
    if (used.has(name) && out[name] === undefined && value) out[name] = value;
  };
  fill("email", to);
  if (person) {
    fill("name", person.name);
    fill("first_name", person.name.trim().split(/\s+/)[0]);
    fill("organization", person.organization);
  }
  return out;
}

/** The Space's sender as a reply field: from {mailbox, address}, so a Foreman sees which address its email goes from before and after it asks. */
async function fromOf(space: string, deps: EmailRouteDeps): Promise<{ from?: { mailbox: string; address: string | null } }> {
  if (!deps.sender) return {};
  try {
    return { from: await deps.sender(space) };
  } catch {
    return {};
  }
}

async function withFrom(reply: Reply, space: string, deps: EmailRouteDeps): Promise<Reply> {
  if (reply.status >= 300 || !reply.body || typeof reply.body !== "object" || Array.isArray(reply.body)) return reply;
  return { ...reply, body: { ...(reply.body as Record<string, unknown>), ...(await fromOf(space, deps)) } };
}

export async function handleEmailOrch(route: string, url: URL, bodyText: string, caller: Caller, deps: EmailRouteDeps): Promise<Reply> {
  if (caller.kind !== "lead" || caller.project === undefined) return bad(403, "only a Foreman of a Space works on its email");
  const project = await deps.project(caller.project);
  if (!project) return bad(403, "only a Foreman of a Space on this computer works on its email");
  const space = deps.space(project);
  if (!space) return bad(409, "this project is not part of a Space on this computer, so it has no email templates; branded email belongs to a Space");
  const folders = emailFolders(space.dir);
  const input = ORCH_EMAIL_POSTS.has(route) ? parse(bodyText) : {};
  if (!input) return bad(400, "invalid JSON body");
  const now = new Date(deps.now());
  try {
    switch (route) {
      case "/orch/email/templates":
        return {
          status: 200,
          body: {
            space: space.name,
            templates: listTemplates(folders),
            starters: Object.entries(STARTERS).map(([id, starter]) => ({ id, name: starter.template.name, describe: starter.describe })),
            hooks: deps.queue(space.id).hooks().map((h) => ({ event: h.event, when: HOOK_WORDS[h.event as HookEvent] ?? h.event, template: h.template, project: h.project, setAt: h.setAt })),
            sequences: deps.sequences?.(space.id) ?? [],
            ...(await fromOf(space.id, deps)),
          },
        };
      case "/orch/email/template/start": {
        const starter = STARTERS[String(input.starter ?? "")];
        if (!starter) return bad(400, `starter is one of ${Object.keys(STARTERS).join(", ")}`);
        const slug = String(input.slug ?? input.starter);
        if (readDraft(folders, slug) || versionsOf(folders, slug).length) return bad(409, `there is already a template ${slug}; pick another slug, or change it with email_template_save`);
        const draft = saveDraft(folders, slug, starter.template, now);
        return { status: 200, body: { slug, sha256: draft.sha256, template: starter.template, next: "Change its words to the business's own with email_template_save, look with email_template_preview, then email_template_propose." } };
      }
      case "/orch/email/hook/set":
      case "/orch/email/hook/remove": {
        const event = String(input.event ?? "") as HookEvent;
        if (!(HOOK_EVENTS as readonly string[]).includes(event)) return bad(400, `event is one of ${HOOK_EVENTS.join(", ")}`);
        const slug = String(input.template ?? "");
        const queue = deps.queue(space.id);
        if (route === "/orch/email/hook/remove") {
          if (!queue.removeHook(event, slug)) return bad(404, `no hook sends ${slug} when ${HOOK_WORDS[event]}`);
          deps.log(`email hook removed by ${caller.id}: ${event} → ${slug} in ${space.id}`);
          return { status: 200, body: { removed: true } };
        }
        const version = readVersion(folders, slug);
        if (!version) return bad(404, `no allowed version of template ${slug}; a hook sends only an allowed template`);
        if (version.template.kind !== "transactional") return bad(409, "a hook sends transactional email only");
        const cursor = deps.hookStart(space.id, event);
        if (cursor === null) return bad(409, event === "payment" ? `${space.name} keeps no payments here (Money is not one of its skills)` : `${space.name} keeps no People here`);
        const hook = queue.setHook({ event, template: slug, project: project.id, cursor }, now);
        deps.log(`email hook set by ${caller.id}: ${event} → ${slug} in ${space.id}`);
        return {
          status: 200,
          body: { hook: { event, template: slug, setAt: hook.setAt }, next: `From now on, when ${HOOK_WORDS[event]}, the agent makes one ${version.template.name} email. Each asks the person until they trust this template version; then it goes by itself.` },
        };
      }
      case "/orch/email/image": {
        if (typeof input.from !== "string") return bad(400, "from is the image's path inside the Space's folder");
        const added = addImage(folders, input.from, typeof input.as === "string" ? input.as : undefined);
        deps.log(`email image ${added.file} added to ${space.id} by ${caller.id}`);
        return { status: 200, body: added };
      }
      case "/orch/email/template/get": {
        const slug = String(input.slug ?? "");
        const version = typeof input.version === "number" ? input.version : undefined;
        const draft = version === undefined ? readDraft(folders, slug) : null;
        const kept = draft ?? readVersion(folders, slug, version);
        if (!kept) return bad(404, `no template ${slug}${version ? ` v${version}` : ""}`);
        const which = draft ? { draft: true } : { version: (kept as { version: number }).version };
        return { status: 200, body: { slug, ...which, sha256: kept.sha256, template: kept.template } };
      }
      case "/orch/email/standard":
        return { status: 200, body: { standard: EMAIL_STANDARD, design: EMAIL_DESIGN_RULES, reference: readReference() } };
      case "/orch/email/design/save":
        return saveDesign(input, folders, caller, deps, now);
      case "/orch/email/template/save": {
        let raw = input.template;
        if (typeof input.htmlFile === "string") {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad(400, "template is the template's JSON (name, kind, subject, preheader?, fields?); htmlFile gives its html");
          raw = { ...(raw as Record<string, unknown>), html: readHtmlFile(folders, input.htmlFile) };
        }
        const draft = saveDraft(folders, input.slug, raw, now);
        const latest = readVersion(folders, String(input.slug));
        return { status: 200, body: { slug: input.slug, sha256: draft.sha256, changed: draft.sha256 !== latest?.sha256, ...(latest ? { latest: latest.version } : {}) } };
      }
      case "/orch/email/template/preview": {
        const slug = String(input.slug ?? "");
        const version = typeof input.version === "number" ? input.version : undefined;
        const kept = version === undefined ? (readDraft(folders, slug) ?? readVersion(folders, slug)) : readVersion(folders, slug, version);
        if (!kept) return bad(404, `no template ${slug}${version ? ` v${version}` : ""}`);
        let values: EmailValues;
        if (input.values === undefined) values = sampleValues(kept.template);
        else {
          const given = validateValues(kept.template, input.values);
          if (!given.ok) return bad(400, given.errors.join("; "));
          values = given.values;
        }
        const drawn = renderForView(folders, currentTheme(folders, deps.place(space)), kept.template, values);
        return { status: 200, body: { subject: drawn.subject, preheader: drawn.preheader, text: drawn.text, errors: drawn.errors, warnings: drawn.warnings, missing: drawn.missing, links: drawn.links, bytes: drawn.bytes } };
      }
      case "/orch/email/template/propose":
        return await proposeTemplate(String(input.slug ?? ""), folders, space, project, caller, deps, now);
      case "/orch/email/send":
        return await withFrom(await proposeSend(input, folders, space, project, caller, deps, now), space.id, deps);
      case "/orch/email/campaign":
        return await withFrom(await proposeCampaign(input, folders, space, project, caller, deps, now), space.id, deps);
      case "/orch/email/sequence/propose":
        return await withFrom(await proposeSequence(input, folders, space, project, caller, deps, now), space.id, deps);
      case "/orch/email/batch":
        return await withFrom(await proposeBatch(input, folders, space, project, caller, deps, now), space.id, deps);
      case "/orch/email/sent": {
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100);
        const to = url.searchParams.get("to") ?? undefined;
        const rows = deps.queue(space.id).sends({ limit, ...(to ? { to } : {}) });
        const queue = deps.queue(space.id);
        return {
          status: 200,
          body: {
            sends: rows.map((r) => {
              // Clicks (phase 3): the links clicked in it, by place, first click each; none for an email without the website's links.
              const clicks = r.jobId !== null && r.links ? queue.clicks(r.jobId) : [];
              return { id: r.id, template: r.template, version: r.version, to: r.to, subject: r.subject, sentAt: r.sentAt, messageId: r.messageId, ...(r.links ? { clicks: clicks.length } : {}) };
            }),
          },
        };
      }
    }
    return bad(404, `no route ${route}`);
  } catch (caught) {
    if (caught instanceof EmailFileError) return bad(caught.status, caught.message);
    throw caught;
  }
}

/**
 * A Designer's Tessel email saved as a template draft: the design made into
 * email HTML (emailDesign.ts), each image it shows copied into the email's
 * images as <slug>-<asset>, and the template's words (name, kind, subject,
 * preheader, fields) from `template`. Nothing is saved while the design has a
 * problem; the reply lists them, to fix in Tessel and save again.
 */
function saveDesign(input: Record<string, unknown>, folders: EmailFolders, caller: Caller, deps: EmailRouteDeps, now: Date): Reply {
  const slug = String(input.slug ?? "");
  if (!SLUG.test(slug)) return bad(400, "slug is the template's short name: lowercase letters, digits and -");
  if (typeof input.design !== "string") return bad(400, "design is the .tessel.json file of the email, in your designs folder");
  const words = input.template;
  if (!words || typeof words !== "object" || Array.isArray(words)) return bad(400, "template is {name, kind, subject, preheader?, fields?}; the design gives its html");
  const meta = words as Record<string, unknown>;
  if ("html" in meta || "blocks" in meta) return bad(400, "the design gives the html: leave html and blocks out of template");
  const design = readDesignFile(folders, input.design);
  const kind = meta.kind === "marketing" ? "marketing" : "transactional";
  const fields = meta.fields && typeof meta.fields === "object" && !Array.isArray(meta.fields) ? (meta.fields as Record<string, { list?: boolean }>) : {};
  const copied: string[] = [];
  const image = (asset: string): { file: string } | { error: string } => {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(asset)) return { error: `the image ${asset} is not one of the design's own` };
    try {
      const added = addImage(folders, `${design.assets}/${asset}`, `${slug}-${asset}`);
      copied.push(added.file);
      return { file: added.file };
    } catch (caught) {
      if (caught instanceof EmailFileError) return { error: caught.message };
      throw caught;
    }
  };
  const made = convertDesign(design.doc, { image, subject: String(meta.subject ?? ""), ...(typeof meta.preheader === "string" ? { preheader: meta.preheader } : {}), kind, fields });
  if (made.errors.length) return bad(400, `the design does not make an email yet: ${made.errors.join("; ")}`);
  const draft = saveDraft(folders, slug, { ...meta, html: made.html, design: design.relative }, now);
  const latest = readVersion(folders, slug);
  deps.log(`email design ${design.relative} saved as ${slug} in ${folders.space} by ${caller.id}`);
  return {
    status: 200,
    body: {
      slug,
      sha256: draft.sha256,
      changed: draft.sha256 !== latest?.sha256,
      ...(latest ? { latest: latest.version } : {}),
      bytes: made.bytes,
      images: copied,
      warnings: made.warnings,
      next: "Look with email_template_preview, then email_template_propose: the person allows it and the Foreman that sends uses it by its slug.",
    },
  };
}

async function proposeTemplate(slug: string, folders: EmailFolders, space: SpacePlace, project: Project, caller: Caller, deps: EmailRouteDeps, now: Date): Promise<Reply> {
  const draft = readDraft(folders, slug);
  if (!draft) return bad(404, `no draft of ${slug}; save one with email_template_save first`);
  const latest = readVersion(folders, slug);
  if (latest?.sha256 === draft.sha256) return bad(409, `${slug} v${latest.version} is already exactly this draft`);
  const current = settle(deps.approvals.load(), now.getTime());
  const waiting = current.find((a) => a.kind === "email_template" && a.state === "pending" && a.emailTemplate?.space === space.id && a.emailTemplate.slug === slug);
  if (waiting) return bad(409, `a card for ${slug} already waits for the person (approval ${waiting.id})`);
  const drawn = renderForView(folders, currentTheme(folders, deps.place(space)), draft.template, sampleValues(draft.template));
  if (drawn.errors.length) return bad(400, `the template does not draw: ${drawn.errors.join("; ")}`);
  const version = (versionsOf(folders, slug).at(-1) ?? 0) + 1;
  const fields = templateFields(draft.template);
  const emailTemplate: ApprovalEmailTemplate = {
    space: space.id,
    project: project.id,
    slug,
    name: draft.template.name,
    emailKind: draft.template.kind,
    version,
    ...(latest ? { previous: latest.version } : {}),
    sha256: draft.sha256,
    subject: draft.template.subject,
    fields: [...fields.filter((f) => (PERSON_FIELDS as readonly string[]).includes(f)), ...fields.filter((f) => !(PERSON_FIELDS as readonly string[]).includes(f))],
    links: drawn.links,
    warnings: drawn.warnings,
  };
  const title = `${latest ? "Update" : "New"} email: ${draft.template.name}`;
  const body = [
    `${space.name} · ${draft.template.kind} · ${latest ? `v${version} (replaces v${latest.version})` : "v1"}`,
    `Subject: ${draft.template.subject}`,
    fields.length ? `Fills in: ${fields.join(", ")}` : "",
    drawn.links.length ? `Links: ${drawn.links.map((l) => `${l.label} → ${hostOf(l.href)}`).join("; ")}` : "",
    "",
    drawn.text.trim(),
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
  const approval = makeApproval({ kind: "email_template", title, body, requestedBy: caller.id, emailTemplate }, now.getTime());
  deps.approvals.save([...current, approval]);
  await deps.notify(approval);
  deps.log(`approval ${approval.id}: ${title} proposed by ${caller.id}`);
  return { status: 202, body: { approval: publicView(approval) } };
}

async function proposeSend(input: Record<string, unknown>, folders: EmailFolders, space: SpacePlace, project: Project, caller: Caller, deps: EmailRouteDeps, now: Date): Promise<Reply> {
  const proposed = await proposeBranded({ template: String(input.template ?? ""), version: typeof input.version === "number" ? input.version : undefined, to: input.to, values: input.values }, { folders, space, project, requestedBy: caller.id, tainted: deps.tainted?.(caller.worker !== undefined ? `worker:${caller.worker}` : `foreman:${project.id}`) ?? false }, deps, now);
  if ("error" in proposed) return bad(proposed.status, proposed.error);
  return { status: 202, body: { approval: publicView(proposed.approval), ...(proposed.trusted ? { trusted: true } : {}) } };
}

export type BrandedAsk = { template: string; version?: number; to: unknown; values: unknown };
export type BrandedPlace = { folders: EmailFolders; space: SpacePlace; project: Project; requestedBy: string; tainted: boolean };
export type Proposed = { approval: StoredApproval; trusted: boolean } | { status: number; error: string };

/**
 * One branded email, drawn and checked, as a card for the person, or carried
 * out at once on trust (actionTrust.ts: the template version's grant, never
 * in a tainted turn, taint.ts; the card says why through the route's notify,
 * orch.ts). Shared by email_send and the hooks
 * (emailHooks.ts).
 */
export async function proposeBranded(ask: BrandedAsk, place: BrandedPlace, deps: EmailRouteDeps, now: Date): Promise<Proposed> {
  const { folders, space, project } = place;
  const version = readVersion(folders, ask.template, ask.version);
  if (!version) return { status: 404, error: `no allowed version of template ${ask.template}; propose it with email_template_propose and wait for the person's Allow` };
  if (version.template.kind !== "transactional") return { status: 409, error: "marketing email goes to a topic as a campaign (email_campaign), never to one address" };
  const to = typeof ask.to === "string" ? ask.to.trim() : "";
  if (!validEmail(to)) return { status: 400, error: "to is one email address" };
  const given = validateValues(version.template, ask.values);
  if (!given.ok) return { status: 400, error: given.errors.join("; ") };
  const person = deps.person(space.id, to);
  const values = personValues(version.template, given.values, person, to);
  const drawn = renderForView(folders, currentTheme(folders, deps.place(space)), version.template, values);
  if (drawn.errors.length) return { status: 400, error: `the email does not draw: ${drawn.errors.join("; ")}` };
  const action: ApprovalAction = {
    channel: BRANDED_CHANNEL,
    project: project.id,
    projectName: project.name,
    summary: `Email ${to}: ${drawn.subject}`.slice(0, 200),
    branded: {
      space: space.id,
      template: ask.template,
      name: version.template.name,
      version: version.version,
      templateSha: version.sha256,
      emailKind: version.template.kind,
      to,
      ...(person ? { personId: person.id, personName: person.name } : {}),
      subject: drawn.subject,
      values,
      sha256: drawn.sha256,
      links: drawn.links,
      missing: drawn.missing,
      text: drawn.text.slice(0, 20_000),
    },
  };
  const current = settle(deps.approvals.load(), now.getTime());
  const words = brandedText(action.branded!);
  const same = current.find((a) => a.kind === "action" && a.state === "pending" && a.action?.branded?.sha256 === drawn.sha256 && a.action.branded.to === to);
  if (same) return { status: 409, error: `this same email to ${to} already waits for the person (approval ${same.id})` };
  const run = !place.tainted && deps.trust ? deps.trust.approval(action, place.requestedBy) : null;
  if (run && deps.trust) {
    deps.approvals.save([...current, run]);
    deps.log(`approval ${run.id}: branded email to ${to} (${ask.template} v${version.version}) runs on trust for ${place.requestedBy}`);
    deps.trust.carryOut(run);
    return { approval: run, trusted: true };
  }
  const approval = makeApproval({ kind: "action", title: words.title, body: words.body, requestedBy: place.requestedBy, action }, now.getTime());
  deps.approvals.save([...current, approval]);
  await deps.notify(approval);
  deps.log(`approval ${approval.id}: branded email to ${to} (${ask.template} v${version.version}) proposed by ${place.requestedBy}`);
  return { approval, trusted: false };
}

/**
 * A campaign card: a marketing version to its topic (and segment), drawn for
 * the first few, counted, with when it goes and the last day under the cap.
 * Needs the Space website (the unsubscribe page) and Mail (bounces). Never
 * trusted: every campaign asks.
 */
const campaignArg = (input: Record<string, unknown>): { marketingCampaign?: number } =>
  typeof input.campaign === "number" && Number.isInteger(input.campaign) && input.campaign > 0 ? { marketingCampaign: input.campaign } : {};

async function proposeCampaign(input: Record<string, unknown>, folders: EmailFolders, space: SpacePlace, project: Project, caller: Caller, deps: EmailRouteDeps, now: Date): Promise<Reply> {
  const slug = String(input.template ?? "");
  const version = readVersion(folders, slug, typeof input.version === "number" ? input.version : undefined);
  if (!version) return bad(404, `no allowed version of template ${slug}; propose it with email_template_propose and wait for the person's Allow`);
  const topic = version.template.topic;
  if (version.template.kind !== "marketing" || !topic) return bad(409, "a campaign sends a marketing template with a topic; a transactional one goes with email_send");
  const site = deps.emailSite?.(space) ?? null;
  if (!site) return bad(409, `a campaign needs ${space.name}'s website live with its unsubscribe page, so nobody waits on the owner to stop getting email: publish the website again first (the Website Builder previews it, the person allows the publish)`);
  const mailOff = deps.mailOn ? await deps.mailOn(space.id) : "this computer cannot read mail";
  if (mailOff) return bad(409, `a campaign needs a mailbox the agent can read, so it sees bounces and stops mailing those addresses: ${mailOff}`);
  const segment = typeof input.segment === "string" && input.segment.trim() ? input.segment.trim() : undefined;
  const found = deps.audience ? deps.audience(space.id, topic, segment) : { status: 409, error: `${space.name} keeps no People here` };
  if ("error" in found) return bad(found.status, found.error);
  const members = found.members;
  if (members.length === 0) return bad(409, `nobody in ${topic}${segment ? ` and segment ${segment}` : ""} may get it yet: people join on the website's tick box or by the owner`);
  if (members.length > AUDIENCE_MAX) return bad(409, `more than ${AUDIENCE_MAX} people: narrow it with a segment`);
  const given = validateValues(version.template, input.values);
  if (!given.ok) return bad(400, given.errors.join("; "));
  let sendAt = now;
  if (input.sendAt !== undefined) {
    const parsed = typeof input.sendAt === "string" ? new Date(input.sendAt) : new Date(NaN);
    if (Number.isNaN(parsed.getTime())) return bad(400, "sendAt is a date and time, such as 2026-11-05T09:00:00Z");
    if (parsed.getTime() > now.getTime() + CAMPAIGN_AHEAD_MS) return bad(400, "sendAt is at most 30 days ahead");
    if (parsed.getTime() > now.getTime()) sendAt = parsed;
  }
  const theme = currentTheme(folders, deps.place(space));
  const samples = members.slice(0, CAMPAIGN_SAMPLES).map((m) => {
    const values = personValues(version.template, given.values, m, m.email);
    return { member: m, values, drawn: renderForView(folders, theme, version.template, values) };
  });
  const broken = samples.find((s) => s.drawn.errors.length);
  if (broken) return bad(400, `the email does not draw for ${broken.member.email}: ${broken.drawn.errors.join("; ")}`);
  const first = samples[0]!;
  const cap = deps.capNow ? await deps.capNow(space.id) : { cap: DAILY_CAP, left: DAILY_CAP, queued: 0 };
  const audienceSha = createHash("sha256").update(members.map((m) => m.email.toLowerCase()).sort().join("\n")).digest("hex");
  const campaign: NonNullable<ApprovalAction["campaign"]> = {
    space: space.id,
    template: slug,
    name: version.template.name,
    version: version.version,
    templateSha: version.sha256,
    topic,
    ...(segment ? { segment } : {}),
    values: given.values,
    sendAt: sendAt.toISOString(),
    count: members.length,
    audienceSha,
    cap: cap.cap,
    leftToday: cap.left,
    ...campaignArg(input),
    lastDay: lastSendDay(sendAt, members.length, cap.queued, sendAt.getTime() - now.getTime() >= DAY_MS ? cap.cap : cap.left, cap.cap),
    site: site.address,
    samples: samples.map((s) => ({ to: s.member.email, ...(s.member.name ? { personName: s.member.name } : {}), subject: s.drawn.subject })),
    sampleValues: first.values,
    sha256: first.drawn.sha256,
    links: first.drawn.links,
    missing: [...new Set(samples.flatMap((s) => s.drawn.missing))],
    text: first.drawn.text.slice(0, 20_000),
  };
  const action: ApprovalAction = { channel: CAMPAIGN_CHANNEL, project: project.id, projectName: project.name, summary: `Campaign ${version.template.name} to ${members.length} in ${topic}`.slice(0, 200), campaign };
  const current = settle(deps.approvals.load(), now.getTime());
  const same = current.find((a) => a.kind === "action" && a.state === "pending" && a.action?.campaign?.space === space.id && a.action.campaign.templateSha === version.sha256 && a.action.campaign.topic === topic && a.action.campaign.segment === segment);
  if (same) return bad(409, `this campaign already waits for the person (approval ${same.id})`);
  const words = campaignText(campaign);
  const made = makeApproval({ kind: "action", title: words.title, body: words.body, requestedBy: caller.id, action }, now.getTime());
  const until = Math.min(now.getTime() + CAMPAIGN_CARD_MS, sendAt.getTime() > now.getTime() ? sendAt.getTime() : Infinity);
  const approval: StoredApproval = { ...made, expiresAt: new Date(until).toISOString() };
  deps.approvals.save([...current, approval]);
  await deps.notify(approval);
  deps.log(`approval ${approval.id}: campaign ${slug} v${version.version} to ${members.length} in ${topic} proposed by ${caller.id}`);
  return { status: 202, body: { approval: publicView(approval) } };
}

/** One copy of a batch drawn from its draft's words: the values, the drawn email, and the problem if it will not draw. */
function drawCopy(folders: EmailFolders, theme: ReturnType<typeof currentTheme>, template: EmailTemplate, shared: EmailValues, row: DraftRow): { values: EmailValues; drawn: ReturnType<typeof renderForView> } {
  const values = personValues(template, { ...shared, subject: row.subject, body: row.body }, { id: row.personId ?? 0, name: row.name, email: row.to, organization: row.organization }, row.to);
  return { values, drawn: renderForView(folders, theme, template, values) };
}

/** Why an Outreach draft cannot be a copy in a batch, or null. */
function draftProblem(row: DraftRow | undefined, seen: ReadonlySet<string>): string | null {
  if (!row) return "no such draft";
  if (row.status !== "ready") return `it is ${row.status}; mark it ready first`;
  if (row.channel !== "email") return `it is a ${row.channel}, not an email`;
  if (!row.personId || !row.to.trim()) return "its person has no email address";
  if (row.emailStatus) return `${row.to} ${row.emailStatus}`;
  if (seen.has(row.to.trim().toLowerCase())) return `${row.to} has another copy in this batch`;
  if (!row.subject.trim()) return "it has no subject";
  if (row.subject.length > SUBJECT_MAX || row.body.length > BODY_MAX) return `its subject is over ${SUBJECT_MAX} or its words over ${BODY_MAX} characters`;
  return null;
}

/**
 * An outreach batch card (phase 5): 1 to 50 ready Outreach drafts, each
 * written for its person, on a marketing template with no topic that draws
 * {subject} and {body}. Needs the website (each copy's unsubscribe link).
 * A draft that cannot go is left off with why. Never trusted.
 */
async function proposeBatch(input: Record<string, unknown>, folders: EmailFolders, space: SpacePlace, project: Project, caller: Caller, deps: EmailRouteDeps, now: Date): Promise<Reply> {
  const slug = String(input.template ?? "");
  const version = readVersion(folders, slug, typeof input.version === "number" ? input.version : undefined);
  if (!version) return bad(404, `no allowed version of template ${slug}; email_template_start outreach makes one to propose`);
  const t = version.template;
  const used = templateFields(t);
  // A designed email may draw the draft's {{subject}} and {{body}}, or be the same letter for everyone with only People's fields filled.
  if (t.kind !== "marketing" || t.topic || (!isDesigned(t) && (!used.includes("subject") || !used.includes("body"))))
    return bad(409, "an outreach batch sends a marketing template with no topic: a block template whose subject is {subject} and whose text draws {body} (email_template_start outreach makes one), or a designed email (html)");
  const ids = Array.isArray(input.drafts) ? input.drafts : [];
  if (ids.length < 1 || ids.length > BATCH_MAX || !ids.every((n) => Number.isInteger(n) && (n as number) > 0)) return bad(400, `drafts is 1 to ${BATCH_MAX} Outreach draft ids`);
  if (new Set(ids).size !== ids.length) return bad(400, "drafts names each draft once");
  const site = deps.emailSite?.(space) ?? null;
  if (!site) return bad(409, `outreach needs ${space.name}'s website live with its unsubscribe page: publish the website again first`);
  const shared = validateValues(t, input.values);
  if (!shared.ok) return bad(400, shared.errors.join("; "));
  if ("subject" in shared.values || "body" in shared.values) return bad(400, "subject and body come from each draft, not values");
  const rows = deps.drafts?.(space.id, ids as number[]) ?? null;
  if (!rows) return bad(409, `${space.name} keeps no Outreach drafts here`);
  const theme = currentTheme(folders, deps.place(space));
  const copies: Batch["copies"] = [];
  const left: Batch["left"] = [];
  const links: Batch["links"] = [];
  const seen = new Set<string>();
  let first = "";
  for (const id of ids as number[]) {
    const row = rows.find((r) => r.draft === id);
    const why = draftProblem(row, seen);
    if (why || !row) {
      left.push({ draft: id, why: why ?? "no such draft" });
      continue;
    }
    const { drawn } = drawCopy(folders, theme, t, shared.values, row);
    if (drawn.errors.length) {
      left.push({ draft: id, why: `it does not draw: ${drawn.errors.join("; ")}`.slice(0, 300) });
      continue;
    }
    seen.add(row.to.trim().toLowerCase());
    copies.push({ draft: id, personId: row.personId!, to: row.to.trim(), name: row.name, subject: drawn.subject, sha256: copySha(row.subject, row.body) });
    for (const link of drawn.links) if (!links.some((l) => l.href === link.href)) links.push(link);
    if (!first) first = drawn.text;
  }
  if (!copies.length) return bad(409, `no draft can go: ${left.map((l) => `draft ${l.draft}: ${l.why}`).join("; ")}`);
  const current = settle(deps.approvals.load(), now.getTime());
  const taken = current.find((a) => a.kind === "action" && a.state === "pending" && a.action?.batch?.space === space.id && a.action.batch.copies.some((c) => copies.some((n) => n.draft === c.draft)));
  if (taken) return bad(409, `some of these drafts already wait on a card (approval ${taken.id})`);
  const batch: Batch = { space: space.id, template: slug, name: t.name, version: version.version, templateSha: version.sha256, values: shared.values, copies, left, site: site.address, links, ...campaignArg(input) };
  const words = batchText(batch, (href) => linkHost(href, site.address), first);
  const action: ApprovalAction = { channel: BATCH_CHANNEL, project: project.id, projectName: project.name, summary: `Outreach: ${copies.length} on ${t.name}`.slice(0, 200), batch };
  const made = makeApproval({ kind: "action", title: words.title, body: words.body, requestedBy: caller.id, action }, now.getTime());
  const approval: StoredApproval = { ...made, expiresAt: new Date(now.getTime() + BATCH_CARD_MS).toISOString() };
  deps.approvals.save([...current, approval]);
  await deps.notify(approval);
  deps.log(`approval ${approval.id}: outreach batch of ${copies.length} on ${slug} v${version.version} proposed by ${caller.id}`);
  return { status: 202, body: { approval: publicView(approval), copies: copies.length, left } };
}

/**
 * The Allow of an outreach batch: one `outreach` job per ticked copy whose
 * draft is still ready and as the card holds it, in the order shown, due now.
 */
export function queueBatchJobs(b: Batch, template: EmailTemplate, rows: readonly DraftRow[], queue: EmailQueue, approval: string, now: Date): string {
  const going = b.copies.filter((c) => !c.skip);
  const changed: number[] = [];
  let queued = 0;
  for (const copy of going) {
    const row = rows.find((r) => r.draft === copy.draft);
    if (!row || row.status !== "ready" || copySha(row.subject, row.body) !== copy.sha256) {
      changed.push(copy.draft);
      continue;
    }
    const values = personValues(template, { ...(b.values as EmailValues), subject: row.subject, body: row.body }, { id: copy.personId, name: row.name, email: copy.to, organization: row.organization }, copy.to);
    queue.add({ kind: "outreach", template: b.template, version: b.version, templateSha: b.templateSha, values, to: copy.to, personId: copy.personId, dueAt: now.toISOString(), approval }, now);
    queued += 1;
  }
  const skipped = b.copies.length - going.length;
  return [`${queued} outreach ${queued === 1 ? "email" : "emails"} queued, one every 20 s`, skipped ? `${skipped} unticked` : "", changed.length ? `not sent, changed after the card: draft ${changed.join(", ")}` : ""].filter(Boolean).join("; ");
}

/**
 * A batch card's copy for the desk: drawn from its draft's words
 * now, refused when the draft no longer hashes to the card's (it will not go).
 */
function batchCopy(b: Batch, index: number, folders: EmailFolders, theme: ReturnType<typeof currentTheme>, deps: Pick<EmailRouteDeps, "drafts">): Reply {
  const copy = b.copies[index];
  if (!copy) return bad(404, `copy is 0 to ${b.copies.length - 1}`);
  const version = readVersion(folders, b.template, b.version);
  if (!version || version.sha256 !== b.templateSha) return bad(410, `template ${b.template} v${b.version} is no longer as allowed`);
  const row = deps.drafts?.(b.space, [copy.draft])?.[0];
  if (!row || copySha(row.subject, row.body) !== copy.sha256) return bad(410, `draft ${copy.draft} changed after the card was made, so this copy will not go`);
  const { drawn } = drawCopy(folders, theme, version.template, b.values as EmailValues, row);
  return {
    status: 200,
    body: { subject: drawn.subject, html: drawn.html, text: drawn.text, sample: false, copy: { index, count: b.copies.length, to: copy.to, name: copy.name, send: !copy.skip, edited: Boolean(copy.edited), subject: row.subject, body: row.body } },
  };
}

/**
 * The person's untick or edit of a batch copy before Allow (POST /email/batch
 * {approval, copy, send?, subject?, body?}, the desk's key): new
 * words are written to the draft as the person, checked to draw, and their
 * hash put on the card, whose words are drawn again.
 */
export function handleBatchEdit(method: string, body: string, caller: { kind: string }, deps: Pick<EmailRouteDeps, "approvals" | "spaceById" | "place" | "drafts" | "editDraft" | "now">, personKinds: ReadonlySet<string>): Reply {
  if (!personKinds.has(caller.kind)) return bad(403, "only the desk app you linked changes a batch");
  if (method !== "POST") return bad(405, "POST only");
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(body || "{}") as Record<string, unknown>;
  } catch {
    return bad(400, "the body is JSON");
  }
  const now = deps.now();
  const list = settle(deps.approvals.load(), now);
  const approval = list.find((a) => a.id === input.approval);
  const b = approval?.action?.batch;
  if (!approval || !b) return bad(404, "no such batch card");
  if (approval.state !== "pending") return bad(409, "this card was already answered");
  const index = typeof input.copy === "number" ? input.copy : -1;
  const copy = b.copies[index];
  if (!copy) return bad(400, `copy is 0 to ${b.copies.length - 1}`);
  const space = deps.spaceById(b.space);
  if (!space) return bad(404, "the Space is not open on this computer");
  const folders = emailFolders(space.dir);
  const theme = currentTheme(folders, deps.place(space));
  const version = readVersion(folders, b.template, b.version);
  if (!version || version.sha256 !== b.templateSha) return bad(410, `template ${b.template} v${b.version} is no longer as allowed`);
  if (input.send !== undefined) {
    if (typeof input.send !== "boolean") return bad(400, "send is true or false");
    copy.skip = !input.send || undefined;
    if (!copy.skip) delete copy.skip;
  }
  if (input.subject !== undefined || input.body !== undefined) {
    if (typeof input.subject !== "string" || typeof input.body !== "string") return bad(400, "subject and body come together, as text");
    const subject = input.subject.replace(/\s+/g, " ").trim();
    const words = input.body.replace(/\r\n/g, "\n").trim();
    if (!subject || subject.length > SUBJECT_MAX) return bad(400, `the subject is 1 to ${SUBJECT_MAX} characters`);
    if (!words || words.length > BODY_MAX) return bad(400, `the words are 1 to ${BODY_MAX} characters`);
    const row = deps.drafts?.(b.space, [copy.draft])?.[0];
    if (!row || copySha(row.subject, row.body) !== copy.sha256) return bad(410, `draft ${copy.draft} changed after the card was made, so this copy will not go`);
    const { drawn } = drawCopy(folders, theme, version.template, b.values as EmailValues, { ...row, subject, body: words });
    if (drawn.errors.length) return bad(400, `it does not draw: ${drawn.errors.join("; ")}`);
    if (!deps.editDraft) return bad(409, "this computer cannot change drafts");
    deps.editDraft(b.space, copy.draft, subject, words);
    copy.subject = drawn.subject;
    copy.sha256 = copySha(subject, words);
    copy.edited = true;
    for (const link of drawn.links) if (!b.links.some((l) => l.href === link.href)) b.links.push(link);
  }
  const first = b.copies.findIndex((c) => !c.skip);
  const firstText = first >= 0 ? (batchCopy(b, first, folders, theme, deps).body as { text?: string }).text ?? "" : "";
  const words = batchText(b, (href) => linkHost(href, b.site), firstText);
  const changed = { ...approval, title: words.title, body: words.body, action: { ...approval.action!, batch: b } };
  deps.approvals.save(list.map((a) => (a.id === approval.id ? changed : a)));
  return batchCopy(b, index, folders, theme, deps);
}

/**
 * A sequence card: each step pinned to its template's latest allowed version
 * and drawn with sample values, the trigger checked against People, and for
 * marketing steps the website and Mail. Allow saves the draft as the next
 * version and starts it (emailSequences.ts startSequence). Never trusted.
 */
async function proposeSequence(input: Record<string, unknown>, folders: EmailFolders, space: SpacePlace, project: Project, caller: Caller, deps: EmailRouteDeps, now: Date): Promise<Reply> {
  const slug = String(input.slug ?? "");
  if (!SLUG.test(slug)) return bad(400, "slug is lowercase letters, digits and dashes, at most 48");
  const check = validateSequence(input.sequence);
  if (!check.ok) return bad(400, `the sequence has problems:\n- ${check.errors.join("\n- ")}`);
  const sequence = check.sequence;
  const missing = deps.sequenceTrigger ? deps.sequenceTrigger(space.id, sequence.trigger) : `${space.name} keeps no People here`;
  if (missing) return bad(409, missing);
  const theme = currentTheme(folders, deps.place(space));
  const steps: PinnedStep[] = [];
  const shown: NonNullable<ApprovalAction["sequence"]>["steps"] = [];
  const links: { href: string; label: string }[] = [];
  let text = "";
  for (const [i, step] of sequence.steps.entries()) {
    const version = readVersion(folders, step.template);
    if (!version) return bad(404, `steps[${i}]: no allowed version of template ${step.template}; propose it with email_template_propose first`);
    const given = validateValues(version.template, step.values ?? {});
    if (!given.ok) return bad(400, `steps[${i}]: ${given.errors.join("; ")}`);
    const drawn = renderForView(folders, theme, version.template, { ...sampleValues(version.template), ...given.values });
    if (drawn.errors.length) return bad(400, `steps[${i}] does not draw: ${drawn.errors.join("; ")}`);
    steps.push({ template: step.template, version: version.version, templateSha: version.sha256, ...(step.after ? { after: step.after } : {}), values: given.values });
    shown.push({ template: step.template, name: version.template.name, version: version.version, emailKind: version.template.kind, subject: drawn.subject, after: delayWords(step.after) });
    for (const link of drawn.links) if (!links.some((l) => l.href === link.href)) links.push(link);
    if (i === 0) text = drawn.text;
  }
  let site: string | undefined;
  if (shown.some((s) => s.emailKind === "marketing")) {
    const found = deps.emailSite?.(space) ?? null;
    if (!found) return bad(409, `a sequence with marketing email needs ${space.name}'s website live with its unsubscribe page: publish the website again first`);
    const mailOff = deps.mailOn ? await deps.mailOn(space.id) : "this computer cannot read mail";
    if (mailOff) return bad(409, `a sequence with marketing email needs a mailbox the agent can read, so it sees bounces: ${mailOff}`);
    site = found.address;
  }
  const latest = readSequenceVersion(folders, slug);
  const current = settle(deps.approvals.load(), now.getTime());
  const waiting = current.find((a) => a.kind === "action" && a.state === "pending" && a.action?.sequence?.space === space.id && a.action.sequence.slug === slug);
  if (waiting) return bad(409, `a card for the sequence ${slug} already waits for the person (approval ${waiting.id})`);
  const draft = saveSequenceDraft(folders, slug, sequence, steps, now);
  if (latest?.sha256 === draft.sha256) return bad(409, `${slug} v${latest.version} is already exactly this`);
  const card: NonNullable<ApprovalAction["sequence"]> = {
    space: space.id,
    slug,
    name: sequence.name,
    version: (sequenceVersions(folders, slug).at(-1) ?? 0) + 1,
    ...(latest ? { previous: latest.version } : {}),
    sha256: draft.sha256,
    trigger: triggerWords(sequence.trigger),
    steps: shown,
    links,
    ...(site ? { site } : {}),
    text: text.slice(0, 20_000),
  };
  const action: ApprovalAction = { channel: SEQUENCE_CHANNEL, project: project.id, projectName: project.name, summary: `Email sequence ${sequence.name}`.slice(0, 200), sequence: card };
  const words = sequenceText(card);
  const approval = makeApproval({ kind: "action", title: words.title, body: words.body, requestedBy: caller.id, action }, now.getTime());
  deps.approvals.save([...current, approval]);
  await deps.notify(approval);
  deps.log(`approval ${approval.id}: email sequence ${slug} v${card.version} proposed by ${caller.id}`);
  return { status: 202, body: { approval: publicView(approval) } };
}

/**
 * A campaign's jobs after Allow: one per person in the audience as it is now
 * (the card's count may have moved), due at the send time, values filled from
 * People per person. Shared by the live Allow (emailLive.ts queueCampaign).
 */
export function queueCampaignJobs(c: NonNullable<ApprovalAction["campaign"]>, template: EmailTemplate, members: PersonFound[], queue: EmailQueue, approval: string, now: Date): string {
  if (members.length > AUDIENCE_MAX) throw new Error(`more than ${AUDIENCE_MAX} people now`);
  const due = Date.parse(c.sendAt) > now.getTime() ? c.sendAt : now.toISOString();
  for (const m of members) {
    const values = personValues(template, c.values as EmailValues, m, m.email);
    queue.add({ kind: "campaign", template: c.template, version: c.version, templateSha: c.templateSha, values, to: m.email, personId: m.id, dueAt: due, approval }, now);
  }
  const changed = members.length !== c.count ? ` (the card said ${c.count}; people joined or left since)` : "";
  return `${members.length} emails queued from ${due.slice(0, 16).replace("T", " ")} UTC${changed}; one every 20 s, the last should go on ${c.lastDay}`;
}

function hostOf(href: string): string {
  try {
    const url = new URL(href);
    return url.protocol === "mailto:" ? url.pathname : url.hostname;
  } catch {
    return href;
  }
}

/** The phone's and desk's preview of a card's email: the draft or version it names, drawn with its values, images inline. */
export function handleEmailPerson(route: string, method: string, url: URL, caller: { kind: string }, deps: Pick<EmailRouteDeps, "approvals" | "spaceById" | "place" | "drafts">, personKinds: ReadonlySet<string>): Reply {
  if (!personKinds.has(caller.kind)) return bad(403, "only the desk app you linked reads email previews");
  if (method !== "GET") return bad(405, "GET only");
  if (route !== "/email/preview") return bad(404, `no route ${route}`);
  const id = url.searchParams.get("approval") ?? "";
  const approval = deps.approvals.load().find((a) => a.id === id);
  if (!approval) return bad(404, "no such approval");
  const spaceId = approval.emailTemplate?.space ?? approval.action?.branded?.space ?? approval.action?.campaign?.space ?? approval.action?.sequence?.space ?? approval.action?.batch?.space;
  const space = spaceId ? deps.spaceById(spaceId) : null;
  if (!space) return bad(404, "this card has no email on this computer");
  const folders = emailFolders(space.dir);
  const theme = currentTheme(folders, deps.place(space));
  if (approval.emailTemplate) {
    const t = approval.emailTemplate;
    const draft = readDraft(folders, t.slug);
    const kept = draft?.sha256 === t.sha256 ? draft : readVersion(folders, t.slug, t.version);
    if (!kept || kept.sha256 !== t.sha256) return bad(410, "the draft this card showed has changed since; the Foreman proposes it again");
    const drawn = renderForView(folders, theme, kept.template, sampleValues(kept.template));
    return { status: 200, body: { subject: drawn.subject, html: drawn.html, text: drawn.text, sample: true } };
  }
  const batch = approval.action?.batch;
  if (batch) return batchCopy(batch, Number(url.searchParams.get("copy") ?? 0) || 0, folders, theme, deps);
  const q = approval.action?.sequence;
  if (q) {
    // The first step, drawn with sample values: the draft the card showed, or the version Allow saved from it.
    const kept = readSequenceDraft(folders, q.slug)?.sha256 === q.sha256 ? readSequenceDraft(folders, q.slug) : readSequenceVersion(folders, q.slug, q.version);
    const first = kept?.sha256 === q.sha256 ? kept.steps[0] : undefined;
    const version = first ? readVersion(folders, first.template, first.version) : null;
    if (!first || !version || version.sha256 !== first.templateSha) return bad(410, "the sequence this card showed has changed since; the Foreman proposes it again");
    const drawn = renderForView(folders, theme, version.template, { ...sampleValues(version.template), ...first.values });
    return { status: 200, body: { subject: drawn.subject, html: drawn.html, text: drawn.text, sample: true } };
  }
  const c = approval.action?.campaign;
  if (c) {
    const kept = readVersion(folders, c.template, c.version);
    if (!kept || kept.sha256 !== c.templateSha) return bad(410, `template ${c.template} v${c.version} is no longer as allowed`);
    const drawn = renderForView(folders, theme, kept.template, c.sampleValues as EmailValues);
    return { status: 200, body: { subject: drawn.subject, html: drawn.html, text: drawn.text, sample: false } };
  }
  const b = approval.action!.branded!;
  const version = readVersion(folders, b.template, b.version);
  if (!version || version.sha256 !== b.templateSha) return bad(410, `template ${b.template} v${b.version} is no longer as allowed`);
  const drawn = renderForView(folders, theme, version.template, b.values as EmailValues);
  return { status: 200, body: { subject: drawn.subject, html: drawn.html, text: drawn.text, sample: false } };
}

/**
 * The desk's block editor (phase 6). Every route names one of the Space's
 * projects (`project`), as the Foreman's do: its Foreman hears the card's
 * answer. The editor moves blocks, changes their words and picks images
 * from the Space's email/images; each draw checks the template and draws it
 * with sample values; propose saves it as the draft and makes the same
 * template card a Foreman's would, which the person allows. Nothing here
 * sends an email.
 */
export async function handleEmailEditor(route: string, method: string, url: URL, body: string, caller: { kind: string }, deps: EmailRouteDeps, personKinds: ReadonlySet<string>): Promise<Reply> {
  if (!personKinds.has(caller.kind)) return bad(403, "only the desk app you linked edits email templates");
  const posting = EDITOR_POSTS.has(route);
  if (method !== (posting ? "POST" : "GET")) return bad(405, posting ? "POST only" : "GET only");
  let input: Record<string, unknown> = {};
  if (posting) {
    try {
      input = JSON.parse(body || "{}") as Record<string, unknown>;
    } catch {
      return bad(400, "the body is JSON");
    }
  }
  const projectId = posting ? String(input.project ?? "") : (url.searchParams.get("project") ?? "");
  const project = projectId ? await deps.project(projectId) : undefined;
  if (!project) return bad(404, "no such project here");
  const space = deps.space(project);
  if (!space) return bad(409, `${project.name} is not part of a Space, so it has no branded email`);
  const folders = emailFolders(space.dir);
  const now = new Date(deps.now());
  try {
    switch (route) {
      case "/email/templates": {
        let images: string[] = [];
        try {
          images = readdirSync(folders.images).filter((f) => /^[a-z0-9][a-z0-9._-]{0,80}\.(?:jpe?g|png|gif|webp)$/.test(f)).sort();
        } catch {
          images = [];
        }
        return {
          status: 200,
          body: {
            space: { id: space.id, name: space.name },
            templates: listTemplates(folders),
            images,
            blockKinds: BLOCK_KINDS,
            starters: Object.entries(STARTERS).map(([id, starter]) => ({ id, name: starter.template.name, describe: starter.describe })),
          },
        };
      }
      case "/email/template": {
        const starter = url.searchParams.get("starter");
        if (starter) {
          const found = STARTERS[starter];
          return found ? { status: 200, body: { template: found.template, from: "starter" } } : bad(404, `starter is one of ${Object.keys(STARTERS).join(", ")}`);
        }
        const slug = url.searchParams.get("slug") ?? "";
        const draft = readDraft(folders, slug);
        if (draft) return { status: 200, body: { template: draft.template, from: "draft", ...(readVersion(folders, slug) ? { latest: readVersion(folders, slug)!.version } : {}) } };
        const latest = readVersion(folders, slug);
        return latest ? { status: 200, body: { template: latest.template, from: "version", latest: latest.version } } : bad(404, `no template ${slug}`);
      }
      case "/email/template/draw": {
        const check = validateTemplate(input.template);
        if (!check.ok) return { status: 200, body: { errors: check.errors } };
        const drawn = renderForView(folders, currentTheme(folders, deps.place(space)), check.template, sampleValues(check.template));
        return { status: 200, body: { subject: drawn.subject, html: drawn.html, text: drawn.text, errors: drawn.errors, warnings: drawn.warnings, bytes: drawn.bytes } };
      }
      case "/email/template/propose": {
        const slug = String(input.slug ?? "");
        saveDraft(folders, slug, input.template, now);
        return await proposeTemplate(slug, folders, space, project, { id: "person", kind: "person" }, deps, now);
      }
    }
    return bad(404, `no route ${route}`);
  } catch (caught) {
    if (caught instanceof EmailFileError) return bad(caught.status, caught.message);
    throw caught;
  }
}

/** The Allow of a template card: the draft becomes the version the card named; the Foreman hears either answer. */
export function settleTemplateApproval(approval: StoredApproval, deps: Pick<EmailRouteDeps, "spaceById">, now: Date): { approval: StoredApproval; news: string } {
  const t = approval.emailTemplate!;
  if (approval.state !== "allowed") return { approval, news: `The person did not allow the email template ${t.name} (${t.slug}); it stays a draft.` };
  const space = deps.spaceById(t.space);
  if (!space) return { approval: { ...approval, state: "failed", results: [{ ok: false, message: "the Space is not open on this computer" }] }, news: `The email template ${t.name} was allowed but its Space is not on this computer, so nothing was saved.` };
  try {
    const kept = acceptDraft(emailFolders(space.dir), t.slug, t.sha256, approval.id, now);
    const message = `saved as ${t.slug} v${kept.version}`;
    return { approval: { ...approval, state: "done", results: [{ ok: true, message }] }, news: `The person allowed the email template ${t.name}: ${message}. email_send can use it now.` };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { approval: { ...approval, state: "failed", results: [{ ok: false, message }] }, news: `The email template ${t.name} was allowed, but not saved: ${message}` };
  }
}
