import { gzipSync } from "node:zlib";

/**
 * JSON replies gzipped for a caller that asks. /orch/status and /projects
 * run to tens of kilobytes and are polled all day; as gzip they are a
 * fraction of that. A caller that asks for nothing gets plain JSON.
 */

/** Replies smaller than this are sent as they are: gzip would save less than its own cost. */
export const GZIP_MIN_BYTES = 1024;

/** Whether an Accept-Encoding header takes gzip: listed (or `*`) and not with q=0. */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(",") : (header ?? "");
  let star: boolean | null = null;
  for (const part of value.split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    const allowed = q === undefined || Number(q.slice(2)) > 0;
    if (name.trim() === "gzip") return allowed;
    if (name.trim() === "*") star = allowed;
  }
  return star === true;
}

/** The body to send, gzipped when it is worth it and the caller takes it. */
export function encodeJson(payload: string, acceptEncoding: string | string[] | undefined): { body: Buffer; gzip: boolean } {
  const plain = Buffer.from(payload);
  if (plain.length < GZIP_MIN_BYTES || !acceptsGzip(acceptEncoding)) return { body: plain, gzip: false };
  return { body: gzipSync(plain), gzip: true };
}
