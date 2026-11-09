/**
 * Branded email cards (agent emailRoutes.ts): a template version to save
 * (kind `email_template`) or one email to send (an action on channel
 * `branded`). See the email draws it from GET /email/preview. A port of the
 * phone's emailRules.ts: change both together.
 */

type EmailApproval = {
  kind?: unknown;
  emailTemplate?: unknown;
  action?: { channel?: unknown; branded?: unknown; campaign?: unknown; sequence?: unknown; batch?: unknown } | null;
} | null | undefined;

/** The words on the card's button, or null when the card has no email to draw. */
export function emailPreviewLabel(approval: unknown): string | null {
  const a = approval as EmailApproval;
  if (!a || typeof a !== "object") return null;
  if (a.kind === "email_template" && a.emailTemplate && typeof a.emailTemplate === "object") return "See the email";
  if (a.action?.channel === "branded" && a.action.branded && typeof a.action.branded === "object") return "See the email as it will go";
  if (a.action?.channel === "campaign" && a.action.campaign && typeof a.action.campaign === "object") return "See one copy";
  if (a.action?.channel === "sequence" && a.action.sequence && typeof a.action.sequence === "object") return "See the first email";
  if (a.action?.channel === "batch" && a.action.batch && typeof a.action.batch === "object") return "See each copy";
  return null;
}

/** The note over the drawn email: what the values are. */
export function emailPreviewNote(sample: boolean): string {
  return sample ? "Drawn with sample names and values. Each email fills in its own." : "Exactly as it will go, in your brand.";
}

/** A batch copy as the preview carries it (agent GET /email/preview `copy`, phase 5). */
export type BatchCopy = { index: number; count: number; to: string; name: string; send: boolean; edited: boolean; subject: string; body: string };

/** Over a batch copy: which of how many, and for whom. */
export function copyHeading(copy: BatchCopy): string {
  return `${copy.index + 1} of ${copy.count} · ${copy.name || copy.to}`;
}

/** The copy one step on or back, or null at either end. */
export function stepCopy(index: number, count: number, by: 1 | -1): number | null {
  const next = index + by;
  return next >= 0 && next < count ? next : null;
}

/** What a copy's words may be (the agent's SUBJECT_MAX and BODY_MAX): null when they will do. */
export function copyWordsProblem(subject: string, body: string): string | null {
  if (!subject.trim()) return "The subject cannot be empty.";
  if (subject.trim().length > 150) return "The subject is at most 150 characters.";
  if (!body.trim()) return "The words cannot be empty.";
  if (body.trim().length > 4000) return "The words are at most 4,000 characters.";
  return null;
}

/** Under the copy: whether it goes, and that the person changed it. */
export function copyNote(copy: BatchCopy): string {
  return [copy.send ? "Goes on Allow." : "Unticked: it will not go.", copy.edited ? "You changed its words." : ""].filter(Boolean).join(" ");
}
