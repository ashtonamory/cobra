/**
 * A Foreman's action card, as words: an approval of kind `action` carries exactly what Allow sends
 * (`ApprovalAction` in packages/contracts/src/approvals.ts; the agent's actions.ts). Channels:
 * `email` (sent from the person's Gmail), `file` (into `Cobra/<project>` in their Google Drive,
 * or a local folder they added to files.json) and `note` (nothing leaves; the card is the
 * delivery). Pure.
 *
 * `channel` is a string: one this build does not know, or one missing its block, is no action card
 * here, and the approval is drawn as a plain one with its title and body.
 */
import { isDict, type Dict, type Json } from "./json.ts";

/** The folder key that means the person's Google Drive (the agent's actions.ts DRIVE_KEY). */
export const DRIVE_KEY = "drive";

/** A message longer than this many lines, or characters, opens folded. */
export const FOLD_LINES = 4;
export const FOLD_CHARS = 280;

export interface FileView {
  name: string;
  /** The path in the repository, when it differs from the name. */
  path: string;
  size: string;
}

export interface ActionView {
  /** "routine" is a routine approval's card (lib/routines.ts routineApprovalView) and "trust" a trust approval's (lib/trust.ts), drawn the same way. */
  channel: "email" | "file" | "note" | "routine" | "trust";
  /** The kind word, as the popup's head and the board's status show it. */
  word: string;
  summary: string;
  /** Label and value, in order (To, Cc, Subject; Where). */
  fields: Array<[string, string]>;
  /** The message, the file action's note, or the note's text; empty when there is none. */
  text: string;
  /** Whether `text` opens folded. */
  folded: boolean;
  /** The text's opening, for the folded line. */
  preview: string;
  /** What the files list is called: Attachments, Files. */
  filesLabel: string;
  files: FileView[];
  /** What Allow does, when the card says it itself (a routine); else allowLine works it out. */
  allow?: string;
  /** The approval's buttons, when they are not Allow and Deny (trust: Trust and Keep asking). */
  yes?: string;
  no?: string;
}

/** The action an approval carries, when it is one this build can draw. */
export function actionOf(approval: Json): Dict | null {
  if (!isDict(approval) || !isDict(approval.action)) return null;
  const action: Dict = approval.action;
  const channel = action.channel;
  if (channel === "email" && isDict(action.email)) return action;
  if (channel === "file" && isDict(action.files)) return action;
  if (channel === "note" && isDict(action.note)) return action;
  return null;
}

export function formatBytes(bytes: Json): string {
  const n = typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function files(list: Json): FileView[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isDict).map((f) => {
    const path = typeof f.path === "string" ? f.path : "";
    const name = typeof f.name === "string" && f.name ? f.name : path.split("/").pop() || "file";
    return { name, path: path && path !== name ? path : "", size: formatBytes(f.bytes) };
  });
}

function list(value: Json): string {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.trim()).join(", ") : "";
}

function str(value: Json): string {
  return typeof value === "string" ? value : "";
}

/** Where a file action puts its files, as the card says it. */
export function whereWords(block: Dict): string {
  const path = str(block.path);
  const label = str(block.label);
  // A local folder's path is always absolute (the agent's files.ts); Drive's is `Cobra/<project>`.
  const drive = block.to === DRIVE_KEY && !/^([/\\]|[A-Za-z]:[\\/])/.test(path);
  if (drive) return path ? `Your Google Drive, in ${path}` : "Your Google Drive";
  if (label && path) return `${label} (${path})`;
  return label || path || "A folder on this computer";
}

/** Whether a text opens folded, and its opening line for the folded summary. */
export function fold(text: string): { folded: boolean; preview: string } {
  const lines = text.split("\n");
  const folded = lines.length > FOLD_LINES || text.length > FOLD_CHARS;
  const first = lines.find((l) => l.trim()) ?? "";
  const preview = first.length > 120 ? `${first.slice(0, 119)}…` : first;
  return { folded, preview };
}

/** The card for an approval's action; null when it carries none this build knows. */
export function actionView(approval: Json): ActionView | null {
  const action = actionOf(approval);
  if (action === null) return null;
  const summary = str(action.summary);
  if (action.channel === "email") {
    const e: Dict = action.email;
    const fields: Array<[string, string]> = [["To", list(e.to) || "nobody"]];
    const cc = list(e.cc);
    if (cc) fields.push(["Cc", cc]);
    fields.push(["Subject", str(e.subject) || "(no subject)"]);
    const text = str(e.text);
    return { channel: "email", word: "EMAIL", summary, fields, text, ...fold(text), filesLabel: "Attachments", files: files(e.attachments) };
  }
  if (action.channel === "file") {
    const f: Dict = action.files;
    const text = str(f.text);
    return { channel: "file", word: "FILES", summary, fields: [["To", whereWords(f)]], text, ...fold(text), filesLabel: "Files", files: files(f.items) };
  }
  const n: Dict = action.note;
  const text = str(n.text);
  return { channel: "note", word: "NOTE", summary, fields: [], text, ...fold(text), filesLabel: "Attachments", files: files(n.attachments) };
}

/** What Allow does, in one line under the card. */
export function allowLine(view: ActionView): string {
  if (view.allow) return view.allow;
  if (view.channel === "email") return "Allow sends exactly this from your Gmail.";
  if (view.channel === "file") return view.fields[0]?.[1].startsWith("Your Google Drive") ? "Allow puts these files in your Drive." : "Allow copies these files there.";
  return "Nothing is sent: Allow marks it read.";
}
