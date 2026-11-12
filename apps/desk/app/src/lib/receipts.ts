/**
 * Receipts added on the desk (the agent's receipts.ts): which files can go, and what the person is
 * told. Pure.
 *
 * Each photo goes to the Space first (`POST /receipts/add`), then one `POST /receipts/read` starts
 * the reading. Nothing is recorded by either: the agent proposes each expense and asks once, on a
 * card.
 */
import { APP_NAME } from "./appName.ts";

/** The agent reads this many in one go (receipts.ts READ_MAX). */
export const READ_MAX = 20;
export const EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;

const ACCEPTED = /\.(png|jpe?g|gif|webp)$/i;
const HEIC = /\.(heic|heif)$/i;

export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** Whether a dropped file is a receipt photo, so the page knows which of its two drops takes it. */
export const isReceiptFile = (path: string): boolean => ACCEPTED.test(path) || HEIC.test(path);

/** Why a file cannot be sent as a receipt, before it is uploaded; null when it can. */
export function problem(path: string): string | null {
  const name = baseName(path);
  if (HEIC.test(name)) return `${name}: ${APP_NAME} cannot read HEIC photos. Save it as a JPEG or PNG first.`;
  if (/\.pdf$/i.test(name)) return `${name}: a receipt is a photo here. Take a screenshot of the PDF and add that.`;
  if (!ACCEPTED.test(name)) return `${name}: a receipt is a PNG, JPEG, GIF or WebP photo.`;
  return null;
}

/** What to send of what was chosen: the photos that can go, at most READ_MAX and each once, and why the others cannot. */
export function plan(paths: readonly string[]): { send: string[]; refused: string[] } {
  const send: string[] = [];
  const refused: string[] = [];
  for (const path of [...new Set(paths)]) {
    const why = problem(path);
    if (why) refused.push(why);
    else if (send.length >= READ_MAX) refused.push(`${baseName(path)}: ${READ_MAX} receipts at a time. Add the rest after these.`);
    else send.push(path);
  }
  return { send, refused };
}

const count = (n: number): string => `${n} ${n === 1 ? "receipt" : "receipts"}`;

/** While the photos go to the computer. */
export const sendingLine = (done: number, total: number): string => (total === 1 ? "Sending 1 receipt…" : `Sending receipt ${done + 1} of ${total}…`);

/** Once the reading has started: what happens next, and that nothing is recorded without the person. */
export function readingLine(n: number): string {
  return `${APP_NAME} is reading ${count(n)}. A card will ask you before anything is recorded.`;
}

/** An agent's refusal in the person's words. The agent's own text when no better one is known. */
export function failure(status: number, message: string): string {
  if (status === 404) return "This Space keeps no Money yet, so there is nowhere to put a receipt.";
  if (status === 413) return "That photo is over 20 MB. Send a smaller one.";
  if (status === 415) return "That file is not a photo this computer can read. Use a PNG or JPEG.";
  return message;
}
