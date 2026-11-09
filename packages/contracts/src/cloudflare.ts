import { z } from "zod";

/**
 * GET /integrations/cloudflare (agent cloudflare.ts): the owner's Cloudflare
 * connection on one computer, for the Website Builder. Never the token.
 *
 * `state` is a string, not an enum, so a later state reaches an older app as
 * text it does not know rather than a failed parse: not-connected,
 * connecting (a sign-in started here and not finished), choose-account
 * (several accounts and none chosen), connected, attention (`problem` says
 * what to do).
 */
export const CloudflareAccount = z.object({ id: z.string(), name: z.string() });
export type CloudflareAccount = z.infer<typeof CloudflareAccount>;

/**
 * What the optional permissions granted (Phase 4b): Turnstile for the
 * contact form's spam check, Email Routing and Zone Read for the inquiry
 * email. An owner with no domain on Cloudflare can decline them; the sites
 * work without either. Absent from an agent before Phase 4b.
 */
export const CloudflareFeatures = z.object({ spamCheck: z.boolean(), email: z.boolean() });
export type CloudflareFeatures = z.infer<typeof CloudflareFeatures>;

export const CloudflareIntegration = z.object({
  state: z.string(),
  account: CloudflareAccount.nullable(),
  accounts: z.array(CloudflareAccount),
  scopes: z.array(z.string()),
  connectedAt: z.string().nullable(),
  problem: z.string().nullable(),
  clientId: z.string(),
  /** Where Cloudflare sends the browser back (the landing site's return page). */
  redirect: z.string(),
  /** Which optional permissions this connection holds; null while not connected. */
  features: CloudflareFeatures.nullable().optional(),
});
export type CloudflareIntegration = z.infer<typeof CloudflareIntegration>;

/** POST /integrations/cloudflare/start. */
export const CloudflareStart = z.object({ url: z.string() });
export type CloudflareStart = z.infer<typeof CloudflareStart>;
