/**
 * Outreach batches: emails each written
 * for its person. Lead Outreach writes one Outreach draft per person (subject
 * and body) and marks it ready; `email_batch` puts up to 50 of them on one
 * card with a marketing template that names no topic and draws `{body}`.
 *
 * The card keeps each copy's hash, never its words: the words stay in the
 * draft. Before Allow the person may untick a copy or change its words
 * (POST /email/batch, which writes the draft as the person and the new hash
 * on the card). Allow queues one `outreach` job per ticked copy whose draft
 * still hashes to the card's, so a draft changed any other way after the
 * card does not go. After each send the agent marks its draft sent
 * (`draft_mailed`). An outreach copy is stopped by a bounce or an unsubscribe,
 * never by topics: these people never joined one.
 */

import { createHash } from "node:crypto";

import type { ApprovalAction } from "@cobra/contracts";

import type { ProjectDb } from "./dbTypes.ts";

export const BATCH_CHANNEL = "batch";
export const BATCH_MAX = 50;
export const BATCH_CARD_MS = 3 * 24 * 60 * 60_000;
/** As a template value may be (contracts emailTemplate.ts EMAIL_LIMITS). */
export const SUBJECT_MAX = 150;
export const BODY_MAX = 4000;

export type Batch = NonNullable<ApprovalAction["batch"]>;
/** An Outreach draft as the batch reads it. */
export type DraftRow = { draft: number; personId: number | null; to: string; name: string; organization: string | null; status: string; channel: string; subject: string; body: string; emailStatus: string | null };

export function copySha(subject: string, body: string): string {
  return createHash("sha256").update(JSON.stringify([subject, body])).digest("hex");
}

/** The batch card's title and body: each copy's person and subject, what was left off and why, every link's host. */
export function batchText(b: Batch, hostOf: (href: string) => string, firstText: string): { title: string; body: string } {
  const going = b.copies.filter((c) => !c.skip);
  const lines = [
    `${going.length} of ${b.copies.length} ${b.copies.length === 1 ? "email" : "emails"} to send, each written for its person, on ${b.name} v${b.version}.`,
    ...b.copies.map((c) => `${c.skip ? "✗" : "✓"} ${c.name || c.to} <${c.to}>: ${c.subject}${c.edited ? " (you changed it)" : ""}`),
    b.left.length ? `Left off: ${b.left.map((l) => `draft ${l.draft} (${l.why})`).join("; ")}` : "",
    b.links.length ? `Links: ${b.links.map((l) => `${l.label} → ${hostOf(l.href)}`).join("; ")}` : "",
    "Each has an unsubscribe link; anyone unsubscribed or bounced is left off. See each copy to read it, untick it or change its words before Allow.",
    "",
    firstText.trim(),
  ];
  return { title: `Outreach: ${going.length} ${going.length === 1 ? "email" : "emails"} on ${b.name}`.slice(0, 120), body: lines.filter((line, i, all) => line !== "" || (all[i - 1] !== "" && i < all.length - 1)).join("\n").trim() };
}

/** These Outreach drafts with their person, address and email status (People's email_status). */
export function readDrafts(db: ProjectDb, ids: readonly number[]): DraftRow[] {
  if (!ids.length) return [];
  return db
    .queryRaw(
      `SELECT d.id AS draft, d.person_id AS person_id, d.status AS status, d.channel AS channel, d.subject AS subject, d.body AS body, p.name AS name, p.email AS email, p.organization AS organization, s.status AS email_status
         FROM drafts d LEFT JOIN people p ON p.id = d.person_id AND p.archived_at IS NULL LEFT JOIN email_status s ON s.email = p.email COLLATE NOCASE
        WHERE d.id IN (${ids.map(() => "?").join(", ")})`,
      [...ids],
    )
    .rows.map((r) => ({
      draft: Number(r.draft),
      personId: typeof r.person_id === "number" && typeof r.email === "string" && r.email.trim() ? r.person_id : null,
      to: typeof r.email === "string" ? r.email : "",
      name: typeof r.name === "string" ? r.name : "",
      organization: typeof r.organization === "string" ? r.organization : null,
      status: String(r.status ?? ""),
      channel: String(r.channel ?? ""),
      subject: typeof r.subject === "string" ? r.subject : "",
      body: typeof r.body === "string" ? r.body : "",
      emailStatus: typeof r.email_status === "string" ? r.email_status : null,
    }));
}
