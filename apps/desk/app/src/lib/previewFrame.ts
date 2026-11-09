/**
 * How the desk draws HTML that Cobra generated or that came from outside (an email the agent drew, a template a
 * Foreman wrote): only in a frame, never in the desk's own page. Phase 2 step 5 (docs/plans/phase-2-security.md).
 *
 * - The frame's sandbox is empty: no scripts, no same origin (so no reach into the desk's storage, IPC or keys), no
 *   forms, no popups, no way to move the desk. Its links do nothing: the desk's own policy (tauri.conf.json,
 *   frame-src 'none') stops the frame loading any page, and pages.rs stops any window leaving the app.
 * - The page carries its own Content Security Policy, put in as the first element so it covers everything after it:
 *   nothing loads but inline styles and `data:` and https images and fonts. A `srcdoc` frame also keeps the desk's
 *   own policy, so in practice only `data:` images draw (the agent inlines a preview's pictures as `data:`).
 */

/** The frame's sandbox attribute, exactly: no allow-* at all. */
export const PREVIEW_SANDBOX = "";

/** The preview page's own policy. No script-src: with default-src 'none' no script runs. */
export const PREVIEW_CSP = [
  "default-src 'none'",
  "img-src data: https:",
  "style-src 'unsafe-inline'",
  "font-src data: https:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;

// What may come before the policy without breaking the page: leading space, comments and the doctype (a meta before
// the doctype would drop the email into quirks mode).
const PROLOGUE = /^(?:\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?/i;

/**
 * The HTML with the policy as its first element. The parser opens <html> and <head> for it, so the email's own
 * <html> and <head> tags join those (their attributes kept) and the policy is the head's first child, before any
 * <base>, <link>, <style> or <script> the email has.
 */
export function withPreviewPolicy(html: string): string {
  const prologue = PROLOGUE.exec(html)?.[0] ?? "";
  return `${prologue}${META}${html.slice(prologue.length)}`;
}
