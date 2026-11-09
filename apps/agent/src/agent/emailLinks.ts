/**
 * Signed links for a campaign's email,
 * checked by the Space site's Worker (siteDeploy.ts WORKER_SOURCE `verified`):
 * base64url JSON, a dot, and the first 16 bytes of its HMAC-SHA256 under the
 * site's own key (site.ts record `emailKey`). The unsubscribe link names the
 * address it was sent to and the topics it may leave; a click link names
 * where it goes, so the Worker never redirects anywhere a signature did not.
 */

import { createHmac } from "node:crypto";

export type UnsubscribeToken = { k: "u"; s: string; e: string; t: string[]; c?: string };
export type ClickToken = { k: "c"; s: string; i: number; u: string };

const b64url = (bytes: Buffer): string => bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function signToken(key: string, payload: UnsubscribeToken | ClickToken): string {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("the site's email key is not 64 hex characters");
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = createHmac("sha256", Buffer.from(key, "hex")).update(body).digest().subarray(0, 16);
  return `${body}.${b64url(mac)}`;
}

/** The job's reference in a token and in the Worker's events: `j<job id>`, read back by sitePull.ts. */
export const jobRef = (jobId: number): string => `j${jobId}`;

export function unsubscribeUrl(site: string, key: string, input: { job: number; email: string; topics: readonly string[]; topic?: string }): string {
  const token = signToken(key, { k: "u", s: jobRef(input.job), e: input.email, t: [...input.topics].slice(0, 20), ...(input.topic ? { c: input.topic } : {}) });
  return `${site.replace(/\/$/, "")}/e/u/${token}`;
}

export function clickUrl(site: string, key: string, input: { job: number; link: number; href: string }): string {
  return `${site.replace(/\/$/, "")}/e/c/${signToken(key, { k: "c", s: jobRef(input.job), i: input.link, u: input.href })}`;
}
