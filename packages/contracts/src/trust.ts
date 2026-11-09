import { z } from "zod";

/**
 * Trust: an action a Foreman proposes the same way, to the same people,
 * from the same templates, that the person allowed three times running, may
 * be trusted with one Allow. A trusted action runs when it is proposed and
 * lands as a receipt under Landed, with no card to answer. The person revokes
 * it in one tap on the project page.
 *
 * What makes two actions "the same" is the action key, worked out by the
 * agent: the project, the channel, who it reaches (every address, or the
 * folder), and the templates its attachments were rendered from, each with
 * the hash of its source. A new recipient or a changed template is a new key,
 * so it asks again. The apps never compute a key; they show these words.
 */

/** What a key covers, in words for the card and the project page. */
export const TrustSubject = z.object({
  /** The agent's own key: a sha256, opaque to the apps; Revoke and Clear send it back. */
  key: z.string(),
  project: z.string(),
  projectName: z.string(),
  /** email, file or note. */
  channel: z.string(),
  /** The kind of thing, in words: "pay-stub", "invoice and receipt", "a message". */
  what: z.string(),
  /** Who it reaches: every address (email), the folder (file), or none (note). */
  to: z.array(z.string()),
  /** The templates its attachments came from, by name; none for a message alone. */
  templates: z.array(z.string()),
});
export type TrustSubject = z.infer<typeof TrustSubject>;

/** A trust approval (kind `trust`): Allow writes a grant for exactly this key. */
export const ApprovalTrust = TrustSubject.extend({
  /** Allowed this many times running with no denial between. */
  runs: z.number().int(),
  /** The last few cards it was, by summary, newest last. */
  examples: z.array(z.string()),
});
export type ApprovalTrust = z.infer<typeof ApprovalTrust>;

/** On an action that ran on trust: it is a receipt, not a question. */
export const ApprovalTrusted = z.object({
  key: z.string(),
  grantedAt: z.string(),
  /** Set when the injection audit read it first (agent taintAudit.ts): its Foreman had read the web. */
  audited: z.string().optional(),
});
export type ApprovalTrusted = z.infer<typeof ApprovalTrusted>;

export const TrustGrant = TrustSubject.extend({
  grantedAt: z.string(),
  /** Trusted runs since the grant. */
  runsSince: z.number().int(),
  lastUsed: z.string().optional(),
});
export type TrustGrant = z.infer<typeof TrustGrant>;

/** A key the person said always asks (Deny on its trust card): never proposed again until they clear it. */
export const TrustAsk = TrustSubject.extend({
  at: z.string(),
});
export type TrustAsk = z.infer<typeof TrustAsk>;
