import type { TemplateData } from "./renderTypes.ts";

/**
 * The template engine behind Cobra's reports: a Mustache-like subset over data only. A template is HTML with
 * `{{path}}` substitutions, `{{#each}}`, `{{#if}}` / `{{else}}`, `{{#unless}}`,
 * `{{! comments }}` and a fixed set of helpers (`{{money row.net_cents}}`).
 * No JavaScript is ever evaluated: a template a Worker wrote, or one the owner
 * dropped in, can only read the data it is given and format it.
 *
 * Every substitution is HTML-escaped and there is no raw output (no
 * triple-stache, no partials). The rows come from the project's database,
 * which an imported sheet fills: an employee called `<script>` would otherwise
 * run in the Chromium that prints the PDF, or in the browser that opens the
 * HTML. A template that needs markup writes it in the template itself.
 */

export class TemplateError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

export type TemplateOptions = {
  /** Maps a repository-relative path to a file:// URL, or "" when it is refused. Without it the `file` helper renders "". */
  fileUrl?: (repoPath: string) => string;
};

type Expr =
  | { kind: "path"; path: string }
  | { kind: "str"; value: string }
  | { kind: "num"; value: number }
  | { kind: "call"; helper: string; args: Expr[] };

type Node =
  | { kind: "text"; text: string }
  | { kind: "out"; expr: Expr; line: number }
  | { kind: "each"; expr: Expr; body: Node[]; otherwise: Node[]; line: number }
  | { kind: "if"; expr: Expr; negate: boolean; body: Node[]; otherwise: Node[]; line: number };

type Block = Extract<Node, { kind: "each" | "if" }> & { closedBy: string; hasElse: boolean };

/** One `{{#each}}` iteration: the item and its position, for `this` and the `@` variables. */
type Frame = { item: unknown; index: number; length: number };

type Context = { data: TemplateData; frames: Frame[]; options: TemplateOptions };

type Helper = (args: unknown[], ctx: Context) => unknown;

const SPECIALS = new Set(["@index", "@number", "@first", "@last"]);

/** Renders `source` over `data`. Throws a TemplateError, naming the line, for a malformed template. */
export function renderTemplate(source: string, data: TemplateData, options: TemplateOptions = {}): string {
  const nodes = parse(source);
  const out: string[] = [];
  renderNodes(nodes, { data, frames: [], options }, out);
  return out.join("");
}

// --- parsing ----------------------------------------------------------------

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: Block[] = [];
  const target = (): Node[] => {
    const top = stack[stack.length - 1];
    if (!top) return root;
    return top.hasElse ? top.otherwise : top.body;
  };
  let at = 0;
  let line = 1;
  while (at < source.length) {
    const open = source.indexOf("{{", at);
    if (open === -1) {
      target().push({ kind: "text", text: source.slice(at) });
      break;
    }
    if (open > at) {
      const text = source.slice(at, open);
      target().push({ kind: "text", text });
      line += countLines(text);
    }
    const close = source.indexOf("}}", open + 2);
    if (close === -1) throw new TemplateError("a {{ is never closed", line);
    const raw = source.slice(open + 2, close);
    const tagLine = line;
    line += countLines(raw);
    at = close + 2;
    const content = raw.trim();
    if (content.startsWith("!")) continue;
    // Handlebars' {{{raw}}} is refused by name, since a template author will reach for it.
    if (content.startsWith("{")) throw new TemplateError("{{{ }}} is not supported: every value is escaped, so write the markup in the template", tagLine);
    if (content === "else") {
      const top = stack[stack.length - 1];
      if (!top) throw new TemplateError("{{else}} outside a block", tagLine);
      if (top.hasElse) throw new TemplateError(`a second {{else}} in the {{#${top.closedBy}}} opened on line ${top.line}`, tagLine);
      top.hasElse = true;
      continue;
    }
    if (content.startsWith("#")) {
      const [word, ...rest] = splitFirst(content.slice(1));
      const argument = rest.join(" ").trim();
      if (!argument) throw new TemplateError(`{{#${word}}} needs a path`, tagLine);
      const expr = parseExpr(argument, tagLine);
      let block: Block;
      if (word === "each") block = { kind: "each", expr, body: [], otherwise: [], line: tagLine, closedBy: "each", hasElse: false };
      else if (word === "if" || word === "unless") block = { kind: "if", expr, negate: word === "unless", body: [], otherwise: [], line: tagLine, closedBy: word, hasElse: false };
      else throw new TemplateError(`unknown block {{#${word}}}: use each, if or unless`, tagLine);
      target().push(block);
      stack.push(block);
      continue;
    }
    if (content.startsWith("/")) {
      const word = content.slice(1).trim();
      const top = stack.pop();
      if (!top) throw new TemplateError(`{{/${word}}} closes nothing`, tagLine);
      if (top.closedBy !== word) throw new TemplateError(`{{/${word}}} closes the {{#${top.closedBy}}} opened on line ${top.line}; write {{/${top.closedBy}}}`, tagLine);
      continue;
    }
    target().push({ kind: "out", expr: parseExpr(content, tagLine), line: tagLine });
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed) throw new TemplateError(`{{#${unclosed.closedBy}}} is never closed`, unclosed.line);
  return strip(root);
}

/** The Block bookkeeping fields are parse-time only. */
function strip(nodes: Node[]): Node[] {
  return nodes.map((node) => {
    if (node.kind === "each") return { kind: "each", expr: node.expr, body: strip(node.body), otherwise: strip(node.otherwise), line: node.line };
    if (node.kind === "if") return { kind: "if", expr: node.expr, negate: node.negate, body: strip(node.body), otherwise: strip(node.otherwise), line: node.line };
    return node;
  });
}

function countLines(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === "\n") n += 1;
  return n;
}

function splitFirst(text: string): string[] {
  const trimmed = text.trim();
  const space = trimmed.search(/\s/);
  return space === -1 ? [trimmed] : [trimmed.slice(0, space), trimmed.slice(space + 1)];
}

/** Breaks an expression into words, "quoted strings" and (parenthesised calls). */
function tokenize(text: string, line: number): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) throw new TemplateError(`a " is never closed in {{${text}}}`, line);
      tokens.push(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (ch === "(") {
      let depth = 0;
      let j = i;
      let inString = false;
      for (; j < text.length; j += 1) {
        const c = text[j];
        if (inString) {
          if (c === "\\") j += 1;
          else if (c === '"') inString = false;
          continue;
        }
        if (c === '"') inString = true;
        else if (c === "(") depth += 1;
        else if (c === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (j >= text.length) throw new TemplateError(`a ( is never closed in {{${text}}}`, line);
      tokens.push(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (ch === ")") throw new TemplateError(`a ) closes nothing in {{${text}}}`, line);
    let j = i;
    while (j < text.length && !/[\s"()]/.test(text[j]!)) j += 1;
    tokens.push(text.slice(i, j));
    i = j;
  }
  return tokens;
}

function parseExpr(text: string, line: number): Expr {
  const tokens = tokenize(text, line);
  if (tokens.length === 0) throw new TemplateError("an empty {{}}", line);
  // One word alone is a path, even when it spells a helper's name: a column
  // can be called `date` or `count`. A helper always has arguments.
  if (tokens.length === 1) return parseArg(tokens[0]!, line);
  const helper = tokens[0]!;
  if (!Object.hasOwn(HELPERS, helper)) throw new TemplateError(`unknown helper "${helper}"; the helpers are ${Object.keys(HELPERS).join(", ")}`, line);
  return { kind: "call", helper, args: tokens.slice(1).map((token) => parseArg(token, line)) };
}

function parseArg(token: string, line: number): Expr {
  if (token.startsWith('"')) return { kind: "str", value: token.slice(1, -1).replace(/\\(.)/g, "$1") };
  if (token.startsWith("(")) return parseExpr(token.slice(1, -1), line);
  if (/^-?\d+(\.\d+)?$/.test(token)) return { kind: "num", value: Number(token) };
  if (!/^(this|@\w+|[A-Za-z_][\w-]*)(\.[\w@-]+)*$/.test(token)) throw new TemplateError(`"${token}" is not a path, a "string" or a number`, line);
  if (token.startsWith("@") && !SPECIALS.has(token.split(".")[0]!)) throw new TemplateError(`unknown variable ${token}; the variables are ${[...SPECIALS].join(", ")}`, line);
  return { kind: "path", path: token };
}

// --- rendering --------------------------------------------------------------

function renderNodes(nodes: Node[], ctx: Context, out: string[]): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out.push(node.text);
        break;
      case "out":
        out.push(escapeHtml(stringify(evaluate(node.expr, ctx))));
        break;
      case "if": {
        const truthy = isTruthy(evaluate(node.expr, ctx)) !== node.negate;
        renderNodes(truthy ? node.body : node.otherwise, ctx, out);
        break;
      }
      case "each": {
        const list = evaluate(node.expr, ctx);
        if (!Array.isArray(list) || list.length === 0) {
          renderNodes(node.otherwise, ctx, out);
          break;
        }
        list.forEach((item, index) => {
          renderNodes(node.body, { ...ctx, frames: [...ctx.frames, { item, index, length: list.length }] }, out);
        });
        break;
      }
    }
  }
}

function evaluate(expr: Expr, ctx: Context): unknown {
  switch (expr.kind) {
    case "str":
      return expr.value;
    case "num":
      return expr.value;
    case "path":
      return lookup(expr.path, ctx);
    case "call":
      return HELPERS[expr.helper]!(expr.args.map((arg) => evaluate(arg, ctx)), ctx);
  }
}

/**
 * A dotted path. The head is looked up in the innermost `{{#each}}` item first,
 * then in the outer items, then in the data itself, so `{{name}}` inside an
 * each over rows is the row's name and `{{business.legal_name}}` still works
 * there. `this` is the current item; `@index`, `@number`, `@first` and `@last`
 * describe its position.
 */
function lookup(path: string, ctx: Context): unknown {
  const [head, ...rest] = path.split(".") as [string, ...string[]];
  const frame = ctx.frames[ctx.frames.length - 1];
  let value: unknown;
  if (head === "this") value = frame ? frame.item : ctx.data;
  else if (head.startsWith("@")) {
    if (!frame) return undefined;
    value = head === "@index" ? frame.index : head === "@number" ? frame.index + 1 : head === "@first" ? frame.index === 0 : frame.index === frame.length - 1;
  } else {
    value = undefined;
    let found = false;
    for (let i = ctx.frames.length - 1; i >= 0 && !found; i -= 1) {
      const item = ctx.frames[i]!.item;
      if (isObject(item) && Object.hasOwn(item, head)) {
        value = item[head];
        found = true;
      }
    }
    if (!found) value = Object.hasOwn(ctx.data, head) ? (ctx.data as Record<string, unknown>)[head] : undefined;
  }
  for (const key of rest) {
    if (Array.isArray(value) && /^\d+$/.test(key)) value = value[Number(key)];
    else if (isObject(value) && Object.hasOwn(value, key)) value = value[key];
    else return undefined;
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Falsy: null, undefined, "", 0, NaN, false and an empty list. */
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === "" || value === false) return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value) ?? "";
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// --- helpers ----------------------------------------------------------------

const SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

function withCommas(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Whole cents to "£1,234.56"; a currency without a symbol is spelled out: "CHF 1,234.56". */
export function formatMoney(cents: unknown, currency: string): string {
  const n = toNumber(cents);
  if (n === null) return "";
  const whole = Math.round(n);
  const abs = Math.abs(whole);
  const amount = `${withCommas(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
  const code = currency.trim().toUpperCase() || "GBP";
  const symbol = SYMBOLS[code];
  const sign = whole < 0 ? "-" : "";
  return symbol ? `${sign}${symbol}${amount}` : `${sign}${code} ${amount}`;
}

function formatNumber(value: unknown, decimals: unknown): string {
  const n = toNumber(value);
  if (n === null) return "";
  const places = toNumber(decimals);
  const text = places === null ? String(Math.abs(n)) : Math.abs(n).toFixed(Math.max(0, Math.min(20, Math.floor(places))));
  const [whole = "0", fraction] = text.split(".");
  return `${n < 0 ? "-" : ""}${withCommas(Number(whole))}${fraction === undefined ? "" : `.${fraction}`}`;
}

/**
 * A date as a person writes it. A plain YYYY-MM-DD is shown as written; a time
 * with a zone (Z or an offset) is moved to this computer's clock, since that is
 * where the document is printed; a time without a zone is read as written.
 */
function dateParts(value: unknown): { y: number; m: number; d: number; hh: number; mm: number } | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const plain = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(text);
  if (plain) return { y: Number(plain[1]), m: Number(plain[2]), d: Number(plain[3]), hh: Number(plain[4] ?? 0), mm: Number(plain[5] ?? 0) };
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate(), hh: date.getHours(), mm: date.getMinutes() };
}

function formatDate(value: unknown): string {
  const parts = dateParts(value);
  if (!parts) return stringify(value);
  return `${parts.d} ${MONTHS[parts.m - 1] ?? "?"} ${parts.y}`;
}

function formatDateTime(value: unknown): string {
  const parts = dateParts(value);
  if (!parts) return stringify(value);
  return `${formatDate(value)}, ${String(parts.hh).padStart(2, "0")}:${String(parts.mm).padStart(2, "0")}`;
}

function rowsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function columnOf(rows: Record<string, unknown>[], column: unknown): unknown[] {
  const name = typeof column === "string" ? column : "";
  return rows.map((row) => (Object.hasOwn(row, name) ? row[name] : undefined));
}

function sum(rows: unknown, column: unknown): number {
  let total = 0;
  for (const value of columnOf(rowsOf(rows), column)) total += toNumber(value) ?? 0;
  return total;
}

/** The currency a money helper uses when none is given: the business row's, else GBP. */
function currencyOf(given: unknown, ctx: Context): string {
  if (typeof given === "string" && given.trim()) return given;
  const own = ctx.data.business?.currency;
  return typeof own === "string" && own.trim() ? own : "GBP";
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  // "1" and 1 are the same value from SQLite's point of view, as are a number
  // in a template and one in a row; objects are never the same.
  return (typeof a !== "object" && typeof b !== "object") && String(a) === String(b);
}

const HELPERS: Record<string, Helper> = {
  money: ([cents, currency], ctx) => (cents === null || cents === undefined ? "" : formatMoney(cents, currencyOf(currency, ctx))),
  moneysum: ([rows, column, currency], ctx) => formatMoney(sum(rows, column), currencyOf(currency, ctx)),
  sum: ([rows, column]) => sum(rows, column),
  count: ([rows]) => (Array.isArray(rows) ? rows.length : 0),
  date: ([value]) => formatDate(value),
  datetime: ([value]) => formatDateTime(value),
  hours: ([value]) => {
    const n = toNumber(value);
    return n === null ? "" : String(Math.round(n * 100) / 100);
  },
  number: ([value, decimals]) => formatNumber(value, decimals),
  upper: ([value]) => stringify(value).toUpperCase(),
  lower: ([value]) => stringify(value).toLowerCase(),
  join: ([rows, column, separator]) =>
    columnOf(rowsOf(rows), column)
      .filter((value) => value !== null && value !== undefined && value !== "")
      .map(stringify)
      .join(typeof separator === "string" ? separator : ", "),
  default: ([value, fallback]) => (value === null || value === undefined || value === "" ? fallback : value),
  eq: ([a, b]) => same(a, b),
  file: ([path], ctx) => {
    if (typeof path !== "string" || !path.trim() || !ctx.options.fileUrl) return "";
    try {
      return ctx.options.fileUrl(path.trim());
    } catch {
      return "";
    }
  },
};

/** The helper names, for the prompt that tells a Worker how to write a template. */
export const TEMPLATE_HELPERS: readonly string[] = Object.keys(HELPERS);
