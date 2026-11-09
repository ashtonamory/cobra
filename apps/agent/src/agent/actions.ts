import { createHash } from "node:crypto";
import { batchText } from "./emailBatch.ts";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import type { Approval, ApprovalAction, ApprovalActionAttachment, Project } from "@cobra/contracts";

import { BODY_MAX, type StoredApproval } from "./approvals.ts";
import { audit, recipients } from "./auditTrail.ts";
import { ReadRequestError } from "./calendar.ts";
import { DRIVE_ROOT_NAME, driveFolderName, type DriveFile, type DriveProject, type DriveUploaded, DriveUploadError, uploadToDrive } from "./drive.ts";
import { SECRET_FILE } from "./ea.ts";
import { type FilesConfig, formatBytes, loadFilesConfig, uniqueName } from "./files.ts";
import { sendGmail } from "./gmail.ts";
import { inverseOf, type MailboxBatch, mailboxDone, mailboxHeadline, type MailboxOp, type MailboxOutcome, type MailboxRequest, mailboxRequest, organizeMail, resolveMailbox } from "./gmailOrganize.ts";
import { GoogleAuthError } from "./googleAuth.ts";
import { type MailMessage, typeForName, validEmail } from "./mime.ts";
import { boxAdapter, loadMailboxes, MailboxError } from "./mailboxes.ts";
import { organizeBox } from "./boxMail.ts";
import { SessionError } from "./sessions.ts";

/**
 * Actions: something a Foreman wants done in the world, which only you may
 * allow and only the agent carries out.
 *
 * A Foreman proposes an action with its exact content (orchMcp.ts
 * action_propose, through /orch/action/propose). That content becomes an
 * approval (approvals.ts): the card on your phone and the desk shows it, the
 * push carries it, and Allow is behind Face ID. After Allow the agent sends
 * exactly what you were shown, in code: no model is in the way, so nothing can
 * be reworded between the card and the wire, the card holds the whole message
 * (one that would not fit is refused, never cut), and each attachment is sent
 * only if its bytes are the ones hashed when the card was made. A changed
 * draft is a new approval. The Foreman hears what became of it as a [cobra] line
 * (actionNews, told through finishes.ts) and never waits.
 *
 * Channels: `email`,
 * sent through Gmail as the person, from the Google account they connected in
 * the app (gmail.ts); `file`, which puts repository files in the person's
 * Google Drive, in `Cobra/<project>` (drive.ts, folder `drive`, the default),
 * or copies them into a local folder the person added to files.json
 * (`exports`, optional); and `note`, which leaves nothing: the card is the
 * delivery. Attachments, for email and file alike, are files in the Foreman's
 * own repository, by relative path, read at send time and refused if one moved
 * out of the repository or looks like a credential. Proposing touches no
 * network: whether Google is connected is learned at Allow, and a missing
 * connection fails the approval with the words that say how to connect.
 *
 * Channel `mailbox` is the
 * one exception to "proposing touches no network": its batch is worked out
 * when the Foreman proposes (gmailOrganize.ts `resolveMailbox`) and frozen on
 * the card, so Allow changes exactly the messages the person was shown. It is
 * not in CHANNELS, since parseAction is synchronous: orch.ts hands it to
 * parseMailboxAction. It never takes trust (actionTrust.ts: an unknown channel
 * is never trusted).
 */

export const MAX_SUMMARY = 120;
export const MIN_SUMMARY = 3;
export const MAX_RECIPIENTS = 20;
export const MAX_SUBJECT = 200;
export const MAX_TEXT = 4000;
export const MAX_NOTE = 4000;
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** What the card holds at most (approvals.ts BODY_MAX): an action that needs more is refused, so nothing the person allows was cut. */
export const MAX_BODY = BODY_MAX.action ?? 8000;

export const CHANNELS = ["email", "note", "file"] as const;
export type Channel = (typeof CHANNELS)[number];

type Resolved = ApprovalActionAttachment & { full: string };

function refuse(message: string): never {
  throw new SessionError(message, 400);
}

function oneLine(value: unknown, what: string, min: number, max: number): string {
  if (typeof value !== "string") refuse(`${what} is required`);
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length < min) refuse(`${what} needs at least ${min} characters`);
  if (flat.length > max) refuse(`${what} is at most ${max} characters`);
  return flat;
}

function longText(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") refuse(`${what} is required`);
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (!text) refuse(`${what} is empty`);
  if (text.length > max) refuse(`${what} is at most ${max} characters`);
  return text;
}

function addresses(value: unknown, what: string, min: number): string[] {
  if (value === undefined && min === 0) return [];
  if (!Array.isArray(value)) refuse(`${what} is a list of email addresses`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") refuse(`${what} holds a value that is not an address`);
    const address = entry.trim();
    if (!validEmail(address)) refuse(`${what}: "${address.slice(0, 80)}" is not an email address (one address per entry, no names or brackets)`);
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  if (out.length < min) refuse(`${what} needs at least ${min} address${min === 1 ? "" : "es"}`);
  if (out.length > MAX_RECIPIENTS) refuse(`${what} is at most ${MAX_RECIPIENTS} addresses`);
  return out;
}

/**
 * One attachment, as a path inside the repository: relative, resolving (through
 * any symlink) to a regular file under the repository's real path, and not a
 * credential-looking file (the same rule that keeps them out of memory). Its
 * bytes are hashed now, so Allow can tell the file the person saw from one
 * rewritten since, whatever its size.
 */
export function resolveAttachment(root: string, given: unknown): Resolved {
  if (typeof given !== "string" || !given.trim()) refuse("an attachment is a path in the repository");
  const path = given.trim();
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) refuse(`attachment "${path}": give a path inside the repository, not an absolute one or one with ..`);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    refuse("the repository is not on disk");
  }
  let full: string;
  try {
    full = realpathSync(resolve(realRoot, path));
  } catch {
    refuse(`attachment "${path}" is not in the repository`);
  }
  const inside = relative(realRoot, full);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) refuse(`attachment "${path}" is outside the repository`);
  if (SECRET_FILE.test(path) || SECRET_FILE.test(inside)) refuse(`attachment "${path}" looks like a credential file and is never sent`);
  const stat = statSync(full);
  if (!stat.isFile()) refuse(`attachment "${path}" is not a file`);
  return { path: inside, name: basename(inside), bytes: stat.size, sha256: sha256(readFileSync(full)), full };
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function attachments(root: string, value: unknown): Resolved[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) refuse("attachments is a list of paths in the repository");
  if (value.length > MAX_ATTACHMENTS) refuse(`at most ${MAX_ATTACHMENTS} attachments`);
  const out: Resolved[] = [];
  let total = 0;
  for (const entry of value) {
    const file = resolveAttachment(root, entry);
    if (out.some((other) => other.path === file.path)) continue;
    total += file.bytes;
    if (total > MAX_ATTACHMENT_BYTES) refuse(`attachments are at most ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB together`);
    out.push(file);
  }
  return out;
}

/** The folder key that means the person's Google Drive; files.json cannot take it for a local folder. */
export const DRIVE_KEY = "drive";
export const DRIVE_LABEL = "your Google Drive";

/** Where a project's files land in Drive, as the card shows it: `Cobra/<project>`. */
export function drivePath(projectName: string): string {
  return `${DRIVE_ROOT_NAME}/${driveFolderName(projectName)}`;
}

/** A Drive file action, told from a local one by its key and its path: a local folder's path is always absolute (files.ts). */
export function goesToDrive(files: Pick<NonNullable<ApprovalAction["files"]>, "to" | "path">): boolean {
  return files.to === DRIVE_KEY && !isAbsolute(files.path);
}

/**
 * The folder a file action names: the person's Google Drive (`drive`, the
 * default when none is given), or a local folder by its key in files.json.
 * The refusal lists the folders there are (key and label), Drive first, since
 * the Foreman only knows what the person told it.
 */
function exportFolder(given: unknown, projectName: string, exports: FilesConfig["exports"]): { key: string; label: string; path: string } {
  const drive = { key: DRIVE_KEY, label: DRIVE_LABEL, path: drivePath(projectName) };
  const local = Object.entries(exports).filter(([key]) => key !== DRIVE_KEY);
  const known = [`${drive.key} (${drive.label})`, ...local.map(([key, folder]) => `${key} (${folder.label})`)];
  if (given !== undefined && typeof given !== "string") refuse(`folder is the key of a folder: one of ${known.join(", ")}`);
  const key = typeof given === "string" ? given.trim() : "";
  if (!key || key === DRIVE_KEY) return drive;
  const folder = local.find(([name]) => name === key)?.[1];
  if (!folder) refuse(`no folder "${key.slice(0, 80)}": the folders there are ${known.join(", ")}; give the key, or leave folder out for Drive`);
  return { key, ...folder };
}

/** What a Foreman proposed, checked, as the approval keeps it. Refusals are 400s that say what is wrong. */
export function parseAction(body: unknown, project: Pick<Project, "id" | "name" | "path">, exports: FilesConfig["exports"] = {}): ApprovalAction {
  const input = (body ?? {}) as Record<string, unknown>;
  const channel = typeof input.channel === "string" ? input.channel.trim().toLowerCase() : "";
  if (!(CHANNELS as readonly string[]).includes(channel)) refuse(`channel is one of ${CHANNELS.join(", ")}`);
  const summary = oneLine(input.summary, "summary", MIN_SUMMARY, MAX_SUMMARY);
  const base = { channel, project: project.id, projectName: project.name, summary };
  if (channel === "note") {
    // A note sends nothing: an email mislabelled as one would be read, allowed and never go out.
    for (const key of ["to", "cc", "subject", "folder"]) {
      if (input[key] !== undefined) refuse(`a note has no ${key}: it is read on the card and nothing is sent. To send it, use channel email`);
    }
    // A note may carry files for the person to open on the card (a rendered
    // document to look over before it goes anywhere); they stay on this computer.
    const files = attachments(project.path, input.attachments).map(({ full: _drop, ...file }) => file);
    return fitted({ ...base, note: { text: longText(input.text, "text", MAX_NOTE), ...(files.length ? { attachments: files } : {}) } });
  }
  if (channel === "file") {
    // A copy reaches nobody: an email mislabelled as one would land in a folder and never go out.
    for (const key of ["to", "cc", "subject"]) {
      if (input[key] !== undefined) refuse(`a file action has no ${key}: it puts files in your Google Drive or a folder on this computer and sends them to nobody. To send them, use channel email`);
    }
    const folder = exportFolder(input.folder, project.name, exports);
    const items = attachments(project.path, input.attachments).map(({ full: _drop, ...file }) => file);
    if (items.length === 0) refuse(`attachments names the files to copy: 1 to ${MAX_ATTACHMENTS} paths in the repository`);
    const text = input.text === undefined ? undefined : longText(input.text, "text", MAX_NOTE);
    return fitted({ ...base, files: { to: folder.key, label: folder.label, path: folder.path, items, ...(text ? { text } : {}) } });
  }
  const to = addresses(input.to, "to", 1);
  const cc = addresses(input.cc, "cc", 0);
  const subject = oneLine(input.subject, "subject", 1, MAX_SUBJECT);
  const text = longText(input.text, "text", MAX_TEXT);
  const files = attachments(project.path, input.attachments).map(({ full: _drop, ...file }) => file);
  return fitted({
    ...base,
    email: { to, ...(cc.length ? { cc } : {}), subject, text, ...(files.length ? { attachments: files } : {}) },
  });
}

/** The channel that organizes the person's mail; asked for apart from CHANNELS, since resolving its batch reads Gmail. */
export const MAILBOX_CHANNEL = "mailbox";

/** How many messages the mailbox cards of the last 24 hours changed or still may (pending, allowed or done; not denied, failed or lapsed). */
export function mailboxToday(list: readonly Pick<StoredApproval, "kind" | "state" | "createdAt" | "action">[], now: number): number {
  const since = now - 24 * 60 * 60_000;
  return list.reduce((sum, approval) => {
    const batch = approval.action?.mailbox;
    if (approval.kind !== "action" || !batch || Date.parse(approval.createdAt) < since) return sum;
    return approval.state === "pending" || approval.state === "allowed" || approval.state === "done" ? sum + batch.ids.length : sum;
  }, 0);
}

/**
 * A Foreman's mailbox proposal, checked and resolved: the batch of messages is
 * worked out now by `resolve` (Gmail, in gmailOrganize.ts) and frozen on the
 * action, with the card's numbers counted by code from Gmail's metadata.
 * `remaining` is what today's limit still allows. Refusals are 400s that say
 * what is wrong; a Google problem (not connected, Organize mail off) is thrown
 * as it is for the route to answer.
 */
export async function parseMailboxAction(
  body: unknown,
  project: Pick<Project, "id" | "name">,
  resolve: (request: MailboxRequest, remaining: number) => Promise<MailboxBatch>,
  remaining: number,
): Promise<ApprovalAction> {
  const input = (body ?? {}) as Record<string, unknown>;
  const summary = oneLine(input.summary, "summary", MIN_SUMMARY, MAX_SUMMARY);
  // A mailbox action moves messages; an address or text on it would be an email mislabelled.
  for (const key of ["to", "cc", "subject", "text", "folder", "attachments"]) {
    if (input[key] !== undefined) refuse(`a mailbox action has no ${key}: it changes mail that is already in the person's mailbox. To write to someone, use channel email`);
  }
  let request: MailboxRequest;
  try {
    request = mailboxRequest(input);
  } catch (caught) {
    refuse(caught instanceof Error ? caught.message : String(caught));
  }
  let batch: MailboxBatch;
  try {
    batch = await resolve(request, remaining);
  } catch (caught) {
    // The search, the label or the limit is wrong: a 400 that says what to change. The connection's own problems pass as they are.
    if (caught instanceof ReadRequestError) refuse(caught.message);
    throw caught;
  }
  return fitted({ channel: MAILBOX_CHANNEL, project: project.id, projectName: project.name, summary, mailbox: batch });
}

/** The whole action must fit its card: the person allows what they read, so nothing is ever cut. */
function fitted(action: ApprovalAction): ApprovalAction {
  const { body } = actionText(action);
  if (body.length > MAX_BODY) refuse(`the card shows at most ${MAX_BODY} characters and this needs ${body.length}: shorten the message, or attach the long part as a file`);
  return action;
}

/** What makes two proposals the same: the project and the whole card. The route refuses a second one while the first waits. */
export function actionFingerprint(action: ApprovalAction): string {
  const { title, body } = actionText(action);
  return createHash("sha256").update(`${action.project}\n${title}\n${body}`).digest("hex");
}

/** A branded email's card (emailRoutes.ts): who, the subject, the template, what is left empty, every link's real host, then the plain text. */
export function brandedText(b: NonNullable<ApprovalAction["branded"]>): { title: string; body: string } {
  const host = (href: string): string => {
    try {
      const url = new URL(href);
      return url.protocol === "mailto:" ? url.pathname : url.hostname;
    } catch {
      return href;
    }
  };
  const lines = [
    `To: ${b.to}${b.personName ? ` (${b.personName})` : " (not in People)"}`,
    `Subject: ${b.subject}`,
    `${b.name} v${b.version}`,
    b.missing.length ? `Left empty: ${b.missing.join(", ")}` : "",
    b.links.length ? `Links: ${b.links.map((l) => `${l.label} → ${host(l.href)}`).join("; ")}` : "",
    "",
    (b.text ?? "").trim(),
  ];
  return { title: `Email ${b.to}: ${b.subject}`.slice(0, 120), body: lines.filter((line, i, all) => line !== "" || (all[i - 1] !== "" && i < all.length - 1)).join("\n").trim() };
}

/** A link's host, and whether it is off the Space's website (the card marks those). */
export function linkHost(href: string, site?: string): string {
  try {
    const url = new URL(href);
    if (url.protocol === "mailto:") return url.pathname;
    const siteHost = site ? new URL(site).hostname : null;
    return siteHost && url.hostname !== siteHost ? `${url.hostname} (off the website)` : url.hostname;
  } catch {
    return href;
  }
}

/** A campaign's card (emailRoutes.ts): the audience and its count, when it goes and the last day under the daily cap, the copies, every link's real host, then one copy's text. */
export function campaignText(c: NonNullable<ApprovalAction["campaign"]>): { title: string; body: string } {
  const when = new Date(c.sendAt);
  const at = Number.isNaN(when.getTime()) ? c.sendAt : when.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const lines = [
    `To: ${c.count} ${c.count === 1 ? "person" : "people"} in ${c.topic}${c.segment ? `, segment ${c.segment}` : ""} (each checked again right before it goes)`,
    `Subject: ${c.samples[0]?.subject ?? ""}`,
    `${c.name} v${c.version}`,
    `From ${at}; ${c.lastDay === c.sendAt.slice(0, 10) ? "all the same day" : `the last should go on ${c.lastDay}`} (${c.leftToday} of ${c.cap} left today)`,
    c.samples.length ? `Copies: ${c.samples.map((s) => `${s.to}${s.personName ? ` (${s.personName})` : ""}`).join("; ")}` : "",
    c.missing.length ? `Left empty for some: ${c.missing.join(", ")}` : "",
    c.links.length ? `Links: ${c.links.map((l) => `${l.label} → ${linkHost(l.href, c.site)}`).join("; ")}` : "",
    "Every copy has an unsubscribe link to the website.",
    "",
    (c.text ?? "").trim(),
  ];
  return { title: `Campaign: ${c.name} to ${c.count} in ${c.topic}`.slice(0, 120), body: lines.filter((line, i, all) => line !== "" || (all[i - 1] !== "" && i < all.length - 1)).join("\n").trim() };
}

/** A sequence's card (emailRoutes.ts): what starts it, each step with its delay, every link's host, then the first step's text. */
export function sequenceText(q: NonNullable<ApprovalAction["sequence"]>): { title: string; body: string } {
  const marketing = q.steps.some((s) => s.emailKind === "marketing");
  const lines = [
    `${q.trigger}.`,
    ...q.steps.map((s, i) => `${i + 1}. ${s.after[0]!.toUpperCase()}${s.after.slice(1)}: ${s.subject} (${s.name} v${s.version})`),
    q.links.length ? `Links: ${q.links.map((l) => `${l.label} → ${linkHost(l.href, q.site)}`).join("; ")}` : "",
    `${q.previous ? `Replaces v${q.previous}. ` : ""}After Allow it runs by itself: each email is checked again right before it goes${marketing ? ", and only people in its topic get it" : ""}. The morning brief says what it sent; pause it any time in People's Email sequences.`,
    "",
    (q.text ?? "").trim(),
  ];
  return { title: `Email sequence: ${q.name}${q.previous ? ` (v${q.version})` : ""}`.slice(0, 120), body: lines.filter((line, i, all) => line !== "" || (all[i - 1] !== "" && i < all.length - 1)).join("\n").trim() };
}

/** The approval's title and body: the card, the push and the Lead's approval_status read exactly this, whole. */
export function actionText(action: ApprovalAction): { title: string; body: string } {
  if (action.branded) return brandedText(action.branded);
  if (action.campaign) return campaignText(action.campaign);
  if (action.sequence) return sequenceText(action.sequence);
  if (action.batch) return batchText(action.batch, (href) => linkHost(href, action.batch!.site), "");
  if (action.mailbox) return { title: `Mail: ${action.summary}`, body: mailboxBody(action.mailbox) };
  if (action.email) {
    const email = action.email;
    const head = [...(email.from ? [`From: ${email.from.address} (${email.from.mailbox})`] : []), `To: ${email.to.join(", ")}`, ...(email.cc?.length ? [`Cc: ${email.cc.join(", ")}`] : []), `Subject: ${email.subject}`];
    const files = email.attachments?.length ? `\n\nAttachments: ${email.attachments.map((file) => `${file.name} (${formatBytes(file.bytes)})`).join(", ")}` : "";
    return { title: `Send: ${action.summary}`, body: `${head.join("\n")}\n\n${email.text}${files}` };
  }
  if (action.files) {
    const files = action.files;
    const list = files.items.map((file) => `${file.name} (${formatBytes(file.bytes)})`).join(", ");
    return { title: `${goesToDrive(files) ? "Save to Drive" : "Copy"}: ${action.summary}`, body: `To: ${files.label} (${files.path})\n\nFiles: ${list}${files.text ? `\n\n${files.text}` : ""}` };
  }
  const noteFiles = action.note?.attachments?.length ? `\n\nAttachments: ${action.note.attachments.map((file) => `${file.name} (${formatBytes(file.bytes)})`).join(", ")}` : "";
  return { title: `Note: ${action.summary}`, body: `${action.note?.text ?? ""}${noteFiles}` };
}

/** A mailbox card's body: what Allow does, how the batch was found, who it is from and a few examples. Counted by the agent; nothing in it is a model's word except the Foreman's search. */
function mailboxBody(batch: NonNullable<ApprovalAction["mailbox"]>): string {
  const lines = [mailboxHeadline(batch)];
  if (batch.box) lines.push(`Mailbox: ${batch.box.address} (${batch.box.mailbox})`);
  if (batch.query !== undefined) lines.push(`Search: ${batch.query}`);
  const found = [`${batch.matched} found`];
  if (batch.skipped.alreadyDone) found.push(`${batch.skipped.alreadyDone} already as asked`);
  if (batch.skipped.starred) found.push(`${batch.skipped.starred} ${batch.box ? "flagged" : "starred"}, which a batch never trashes`);
  if (batch.skipped.missing) found.push(`${batch.skipped.missing} gone since`);
  lines.push(`${found.join(", ")}.`);
  if (batch.more) lines.push(`More than ${batch.matched} match: this card holds the newest ${batch.matched}. The rest need another card.`);
  lines.push("", "From:", ...batch.senders.map((sender) => `  ${sender.count} × ${sender.from}`));
  if (batch.samples.length > 0) lines.push("", "For example:", ...batch.samples.map((sample) => `  • ${sample.from}: ${sample.subject}`));
  lines.push("", `Allow does this to exactly these ${batch.ids.length} messages and no others. Nothing is deleted for good.`);
  return lines.join("\n");
}

export type ActionDeps = {
  /** Sends one message through Gmail as the connected Google account (gmail.ts); a GoogleAuthError says how to connect. */
  sendGmail: (message: MailMessage) => Promise<{ id: string; from: string }>;
  /** Sends one message from a Space's own mailbox (mailboxes.ts) by its id, refusing when the box is gone or its address changed since the card. */
  sendBox: (box: string, address: string, message: MailMessage) => Promise<{ id: string; from: string }>;
  /** Applies a mailbox batch's operation to its frozen ids through Gmail (gmailOrganize.ts); a GoogleAuthError says how to connect or turn on Organize mail. */
  organizeMail: (batch: MailboxBatch) => Promise<MailboxOutcome>;
  /** Puts files in `Cobra/<project>` in the connected account's Drive (drive.ts), resolving with each one's link. */
  uploadToDrive: (files: DriveFile[], project: DriveProject) => Promise<DriveUploaded[]>;
  readFile: (path: string) => Promise<Uint8Array>;
  /** The repository of a project on this computer, by id, or null when it is gone. */
  projectPath: (project: string) => Promise<string | null>;
  /** files.json as it is now: a local folder is checked again at copy time, not trusted from the card. */
  readFilesConfig: () => Promise<FilesConfig>;
  /** Makes the folder and its parents when missing (mkdir -p). */
  mkdir: (path: string) => Promise<void>;
  /** The names already in the folder, so nothing there is overwritten. */
  listDir: (path: string) => Promise<string[]>;
  /** Copies one file to a name that does not exist yet, and fails rather than overwrite one that appeared since listDir. */
  copyFile: (from: string, to: string) => Promise<void>;
  /** Channel branded: queues the email on its Space's queue (emailQueue.ts) and says when it goes; absent on a computer that cannot. */
  queueBranded?: (branded: NonNullable<ApprovalAction["branded"]>, approval: string) => Promise<string>;
  /** Channel campaign: one job per person in the audience as it is now, from the send time (emailLive.ts); absent on a computer that cannot. */
  queueCampaign?: (campaign: NonNullable<ApprovalAction["campaign"]>, approval: string) => Promise<string>;
  /** Channel sequence: saves the version and starts it (emailLive.ts); absent on a computer that cannot. */
  startSequence?: (sequence: NonNullable<ApprovalAction["sequence"]>, approval: string) => Promise<string>;
  /** Channel batch: queues the ticked copies whose drafts are as the card holds them (emailLive.ts); absent on a computer that cannot. */
  queueBatch?: (batch: NonNullable<ApprovalAction["batch"]>, approval: string) => Promise<string>;
};

export function liveActionDeps(projectPath: ActionDeps["projectPath"], readFilesConfig: ActionDeps["readFilesConfig"] = () => loadFilesConfig()): ActionDeps {
  return {
    sendGmail: (message) => sendGmail(message),
    sendBox: async (id, address, message) => {
      const box = loadMailboxes().boxes.find((candidate) => candidate.id === id);
      if (!box || box.address !== address) throw new Error(`the mailbox ${address} is no longer on this computer (Settings → Mailboxes); propose the email again`);
      const sent = await boxAdapter(box, { log: (line) => console.log(`[cobra-agent] ${line}`) }).send(message);
      return { id: sent.messageId, from: sent.account };
    },
    organizeMail: async (batch) => {
      if (!batch.box) return await organizeMail({}, batch);
      // A Space's own mailbox (boxMail.ts): the box the card named, refused when it is gone or its address changed since.
      const box = loadMailboxes().boxes.find((candidate) => candidate.id === batch.box!.id);
      if (!box || box.address !== batch.box.address) throw new Error(`the mailbox ${batch.box.address} is no longer on this computer (Settings → Mailboxes); propose the batch again`);
      try {
        return await organizeBox(box, batch);
      } catch (caught) {
        if (caught instanceof MailboxError) throw new Error(caught.message);
        throw caught;
      }
    },
    uploadToDrive: (files, project) => uploadToDrive(files, { project }),
    readFile: (path) => readFile(path),
    projectPath,
    readFilesConfig,
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    listDir: (path) => readdir(path),
    copyFile: (from, to) => copyFile(from, to, constants.COPYFILE_EXCL),
  };
}

type Results = NonNullable<Approval["results"]>;

function said(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * The files a card named, read now: each resolved inside the repository again
 * and its bytes hashed, so one that moved out or was rewritten since the card
 * (even to the same size) is refused rather than sent. A string is why not.
 */
async function readItems(deps: ActionDeps, project: string, items: readonly ApprovalActionAttachment[], what: string): Promise<Array<{ name: string; full: string; data: Uint8Array }> | string> {
  if (items.length === 0) return [];
  const root = await deps.projectPath(project);
  if (!root) return `project ${project} is no longer on this computer`;
  const out: Array<{ name: string; full: string; data: Uint8Array }> = [];
  for (const file of items) {
    try {
      const found = resolveAttachment(root, file.path);
      const data = await deps.readFile(found.full);
      if (found.bytes !== file.bytes || sha256(data) !== file.sha256) return `${what}${file.name} changed since you were shown it; propose it again with the file as it is now`;
      out.push({ name: file.name, full: found.full, data });
    } catch (caught) {
      return said(caught);
    }
  }
  return out;
}

/**
 * After Allow: carries the action out exactly as the approval holds it, and
 * returns it done or failed, as runMerge does. An email goes through Gmail as
 * the person, the very draft the card showed, its attachments read and hashed
 * again now. Not connected to Google, the approval fails with the words that
 * say how to connect, as they are.
 */
export async function runAction(deps: ActionDeps, approval: StoredApproval): Promise<StoredApproval> {
  const done = await carryOut(deps, approval);
  auditAction(done);
  return done;
}

/**
 * The one audit record (auditTrail.ts) of an action carried out: what went
 * out, as counts, recipients' domains and file hashes, never the message or
 * the files. Who allowed it is on the card's own records (approvals.ts).
 */
export function auditAction(done: StoredApproval, log: typeof audit = audit): void {
  const action = done.action;
  if (!action) return;
  const outcome = done.state === "done" ? "ok" : "failed";
  const base = { actor: "agent", outcome, subject: { project: action.project, card: done.id } };
  const hashes = (items: readonly ApprovalActionAttachment[]) => items.map((item) => `${item.name}:${item.sha256.slice(0, 16)}`);
  if (action.channel === "note") return log("note.read", { ...base, actor: "person", detail: { title: done.title } });
  if (action.channel === MAILBOX_CHANNEL && action.mailbox) {
    return log("mailbox.changed", { ...base, detail: { op: action.mailbox.op, messages: action.mailbox.ids.length, mailbox: action.mailbox.box ? `a mailbox at ${recipients([action.mailbox.box.address]).domains[0] ?? "?"}` : "Gmail" } });
  }
  if (action.channel === "file" && action.files) {
    const drive = goesToDrive(action.files);
    return log(drive ? "drive.saved" : "file.saved", { ...base, subject: { ...base.subject, target: drive ? action.files.path : action.files.to }, detail: { files: action.files.items.length, ...(drive ? {} : { folder: action.files.label }), hashes: hashes(action.files.items) } });
  }
  if (action.channel === "email" && action.email) {
    const to = [...action.email.to, ...(action.email.cc ?? [])];
    const attachments = action.email.attachments ?? [];
    return log("email.sent", { ...base, detail: { ...recipients(to), from: action.email.from ? recipients([action.email.from.address]).domains[0] ?? "mailbox" : "Gmail", attachments: attachments.length, ...(attachments.length ? { hashes: hashes(attachments) } : {}) } });
  }
  // Branded, campaign, batch and sequence are queued here and sent one by one by the queue, which logs each send (emailSend.ts).
  const branded = action.branded ? [action.branded.to] : [];
  log("email.queued", { ...base, detail: { channel: action.channel, ...(branded.length ? recipients(branded) : {}) } });
}

async function carryOut(deps: ActionDeps, approval: StoredApproval): Promise<StoredApproval> {
  const action = approval.action;
  const fail = (message: string): StoredApproval => ({ ...approval, state: "failed", results: [{ ok: false, message }] });
  if (!action) return fail("the approval carries no action");
  if (action.channel === "note") return { ...approval, state: "done", results: [{ ok: true, message: "read" }] };
  if (action.channel === MAILBOX_CHANNEL && action.mailbox) return runMailbox(deps, approval, action.mailbox);
  if (action.channel === "file" && action.files) return goesToDrive(action.files) ? runUpload(deps, approval, action.files) : runCopy(deps, approval, action.files);
  if (action.channel === "branded" && action.branded) {
    if (!deps.queueBranded) return fail("this computer does not send branded email");
    try {
      return { ...approval, state: "done", results: [{ ok: true, message: await deps.queueBranded(action.branded, approval.id) }] };
    } catch (caught) {
      return fail(`not queued: ${said(caught)}`);
    }
  }
  if (action.channel === "campaign" && action.campaign) {
    if (!deps.queueCampaign) return fail("this computer does not send campaigns");
    try {
      return { ...approval, state: "done", results: [{ ok: true, message: await deps.queueCampaign(action.campaign, approval.id) }] };
    } catch (caught) {
      return fail(`not queued: ${said(caught)}`);
    }
  }
  if (action.channel === "batch" && action.batch) {
    if (!deps.queueBatch) return fail("this computer does not send branded email");
    try {
      return { ...approval, state: "done", results: [{ ok: true, message: await deps.queueBatch(action.batch, approval.id) }] };
    } catch (caught) {
      return fail(`not queued: ${said(caught)}`);
    }
  }
  if (action.channel === "sequence" && action.sequence) {
    if (!deps.startSequence) return fail("this computer does not run email sequences");
    try {
      return { ...approval, state: "done", results: [{ ok: true, message: await deps.startSequence(action.sequence, approval.id) }] };
    } catch (caught) {
      return fail(`not started: ${said(caught)}`);
    }
  }
  if (action.channel !== "email" || !action.email) return fail(`no channel called ${action.channel} on this computer`);
  const read = await readItems(deps, action.project, action.email.attachments ?? [], "attachment ");
  if (typeof read === "string") return fail(read);
  const files = read.map((file) => ({ name: file.name, data: file.data, type: typeForName(file.name) }));
  const box = action.email.from;
  try {
    const message0: MailMessage = {
      to: action.email.to,
      ...(action.email.cc?.length ? { cc: action.email.cc } : {}),
      subject: action.email.subject,
      text: action.email.text,
      ...(files.length ? { attachments: files } : {}),
    };
    // From the Space's own mailbox when the card named one, never Gmail in its place.
    const sent = box ? await deps.sendBox(box.box, box.address, message0) : await deps.sendGmail(message0);
    const count = action.email.to.length + (action.email.cc?.length ?? 0);
    const message = `sent to ${count} address${count === 1 ? "" : "es"} from ${sent.from}${sent.id ? ` (${box ? box.mailbox : "Gmail"} message ${sent.id})` : ""}`;
    return { ...approval, state: "done", results: [{ ok: true, message }] };
  } catch (caught) {
    if (caught instanceof GoogleAuthError) return fail(caught.message);
    return fail(`not sent: ${said(caught)}`);
  }
}

/** How to put a box batch back: a moved message has a new id in its new folder, so the undo is a search there, never the same ids. */
function boxUndo(batch: NonNullable<ApprovalAction["mailbox"]>): string {
  const inverse = inverseOf(batch.op as MailboxOp);
  const where: Partial<Record<MailboxOp, string>> = { archive: "in:archive", trash: "in:trash", label: `in:"${batch.label ?? ""}"`, unarchive: "in:inbox", untrash: "in:inbox", unlabel: "in:inbox" };
  const place = where[batch.op as MailboxOp];
  if (!place) return `to put it back, propose op ${inverse} on the same messages`;
  return `to put it back, propose op ${inverse}${inverse === "label" ? ` with label "${batch.label ?? ""}"` : ""} on a search in the folder they are in now (${place}${batch.query !== undefined ? ` plus the words of ${JSON.stringify(batch.query)}` : ""}); moved messages have new ids there, so search first`;
}

/**
 * Channel mailbox, after Allow: the operation on the frozen ids and no others.
 * A batch that changed some and failed some is failed, with the counts, so
 * the Foreman does not take it for done. The result lines say how to put it
 * back: every operation has an inverse, and Gmail keeps the trash 30 days.
 */
async function runMailbox(deps: ActionDeps, approval: StoredApproval, batch: NonNullable<ApprovalAction["mailbox"]>): Promise<StoredApproval> {
  const fail = (message: string): StoredApproval => ({ ...approval, state: "failed", results: [{ ok: false, message }] });
  try {
    const outcome = await deps.organizeMail(batch);
    const undo = batch.box ? boxUndo(batch) : `to put it back, propose op ${inverseOf(batch.op as MailboxOp)} on the same messages${batch.query !== undefined ? ` (the search ${JSON.stringify(batch.query)}${batch.op === "trash" ? " with in:trash" : ""})` : ""}`;
    const made = outcome.createdLabel ? ` and created the ${batch.box ? "folder" : "label"} "${outcome.createdLabel}"` : "";
    if (outcome.failed > 0) {
      const message = `${mailboxDone(batch, outcome.changed)}${made}, but ${batch.box ? batch.box.address : "Gmail"} refused ${outcome.failed} of ${batch.ids.length}${outcome.failure ? `: ${outcome.failure}` : ""}`;
      return { ...approval, state: "failed", results: [{ ok: false, message }, { ok: true, message: undo }] };
    }
    return { ...approval, state: "done", results: [{ ok: true, message: `${mailboxDone(batch, outcome.changed)}${made}` }, { ok: true, message: undo }] };
  } catch (caught) {
    if (caught instanceof GoogleAuthError) return fail(caught.message);
    return fail(`nothing was changed in the mailbox: ${said(caught)}`);
  }
}

/**
 * Channel file to Drive, after Allow: every item is read and hashed again as
 * an email's attachments are, then put in the folder the card named
 * (`Cobra/<project>`; Drive keeps two files of one name side by side, so
 * nothing there is written over). One result line says how many landed, then
 * one per file with its Drive link.
 */
async function runUpload(deps: ActionDeps, approval: StoredApproval, files: NonNullable<ApprovalAction["files"]>): Promise<StoredApproval> {
  const fail = (message: string): StoredApproval => ({ ...approval, state: "failed", results: [{ ok: false, message }] });
  const project = approval.action?.project ?? "";
  const read = await readItems(deps, project, files.items, "");
  if (typeof read === "string") return fail(read);
  // The folder is the one the card showed, by its own words, never worked out again from a project renamed since.
  const name = files.path.startsWith(`${DRIVE_ROOT_NAME}/`) ? files.path.slice(DRIVE_ROOT_NAME.length + 1) : files.path;
  const where = `${files.label} (${files.path})`;
  const links = (done: DriveUploaded[]): Results => done.map((file) => ({ ok: true, message: `${file.name}: ${file.webViewLink}` }));
  try {
    const done = await deps.uploadToDrive(read.map((file) => ({ name: file.name, data: file.data, type: typeForName(file.name) })), { id: project, name });
    return { ...approval, state: "done", results: [{ ok: true, message: `put ${done.length} file${done.length === 1 ? "" : "s"} in ${where}` }, ...links(done)] };
  } catch (caught) {
    if (caught instanceof GoogleAuthError) return fail(caught.message);
    if (caught instanceof DriveUploadError) {
      const message = `put ${caught.uploaded.length} of ${read.length} file${read.length === 1 ? "" : "s"} in ${where}; ${caught.failed} failed: ${caught.message}`;
      return { ...approval, state: "failed", results: [...links(caught.uploaded), { ok: false, message }] };
    }
    return fail(`nothing was put in ${where}: ${said(caught)}`);
  }
}

/**
 * Channel file to a local folder, after Allow: every item is resolved and
 * hashed again as an email's attachments are, the folder must still be the
 * one the card named (same key, same path in files.json), and each file lands
 * under a name that is free, so a pay stub already in the folder is never
 * written over.
 */
async function runCopy(deps: ActionDeps, approval: StoredApproval, files: NonNullable<ApprovalAction["files"]>): Promise<StoredApproval> {
  const fail = (message: string): StoredApproval => ({ ...approval, state: "failed", results: [{ ok: false, message }] });
  let folder: FilesConfig["exports"][string] | undefined;
  try {
    folder = (await deps.readFilesConfig()).exports[files.to];
  } catch (caught) {
    return fail(`files.json could not be read: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  if (!folder) return fail(`export folder ${files.label} (${files.to}) is no longer in files.json; propose it again once it is set up`);
  if (folder.path !== files.path) return fail(`export folder ${files.label} now points at ${folder.path}, not ${files.path} as you were shown; propose it again`);
  const sources = await readItems(deps, approval.action?.project ?? "", files.items, "");
  if (typeof sources === "string") return fail(sources);
  let taken: Set<string>;
  try {
    await deps.mkdir(folder.path);
    taken = new Set(await deps.listDir(folder.path));
  } catch (caught) {
    return fail(`${files.label} (${folder.path}) could not be opened: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  const renamed: string[] = [];
  let copied = 0;
  for (const source of sources) {
    const name = uniqueName(source.name, taken);
    taken.add(name);
    try {
      await deps.copyFile(source.full, join(folder.path, name));
    } catch (caught) {
      return fail(`copied ${copied} of ${sources.length} file${sources.length === 1 ? "" : "s"} to ${files.label}; ${source.name} failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
    copied += 1;
    if (name !== source.name) renamed.push(`${source.name} landed as ${name}`);
  }
  const message = `copied ${copied} file${copied === 1 ? "" : "s"} to ${files.label}${renamed.length ? ` (${renamed.join("; ")})` : ""}`;
  return { ...approval, state: "done", results: [{ ok: true, message }] };
}

/** The one [cobra] line the project's Foreman gets about an action once the person answered it (one that lapses is told nobody; approval_status shows it). */
export function actionNews(approval: Pick<StoredApproval, "id" | "state" | "title" | "results" | "action">): string {
  const what = `"${approval.title}"`;
  const tail = `approval_status ${approval.id}`;
  const outcome = (approval.results ?? []).map((result) => result.message).join("; ");
  switch (approval.state) {
    case "denied":
      return `The person denied ${what}. Do not ${approval.action?.channel === "file" ? "copy it" : approval.action?.channel === MAILBOX_CHANNEL ? "run it" : "send it"} again as it was; ask them what to change, or move on. ${tail}`;
    case "done":
      return approval.action?.channel === "note" ? `The person read ${what}. ${tail}` : `The person allowed ${what}: ${outcome || "done"}. ${tail}`;
    case "failed":
      return `The person allowed ${what}, but it was not carried out: ${outcome || "failed"}. Propose it again once that is fixed. ${tail}`;
    default:
      return `${what} waits for the person. ${tail}`;
  }
}
