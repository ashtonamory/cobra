/**
 * The words on a needs-you card (the pure parts of the desk's ui/popup.py):
 * its kind word and the one line a compact card shows.
 */
import type * as model from "./model.ts";
import type { Json } from "./json.ts";

/** The first non-blank line of a text, trimmed; "" when there is none. */
export function oneLine(text: Json | undefined): string {
  const lines = String(text ?? "").split(/\r?\n/).map((t) => t.trim()).filter((t) => t);
  return lines.length ? lines[0] : "";
}

/** A waiting session's kind word, from the dialog on its screen. */
export function needsKind(dialog: string | null): string {
  const words: Record<string, string> = { permission: "PERMISSION", question: "QUESTION", trust: "TRUST", model: "MODEL" };
  return words[dialog || ""] ?? "WAITING";
}

/** The screen's last lines that say something. */
export function tailOf(row: model.Row): string[] {
  const tail = row.project?.tail;
  return Array.isArray(tail) ? tail.map((t) => String(t)).filter((t) => t.trim()) : [];
}

/** A compact card's one line: the request's headline and what it asks, else the screen's last line. */
export function needsLine(row: model.Row): string {
  const request = row.request;
  if (request) {
    return [oneLine(request.headline), oneLine(request.exact || request.plain)].filter((x) => x).join(" · ");
  }
  const tail = tailOf(row);
  return tail.length ? tail[tail.length - 1].trim() : "Waiting on you";
}
