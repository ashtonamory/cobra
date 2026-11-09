// A CSV a Worker wrote, read into a table of the Foreman's database by the
// agent (sheet_import with `file`), so rows move by code and never through a
// model's context: a real run on 2026-11-03 had the Lead and a Foreman copy
// 40 rows by hand, one db_write each.
//
// The file must be inside a folder of the Foreman's company on this computer
// (its project, its sister projects, the Space folder) or one of their
// Workers' worktrees, after links are resolved; never a secret's name.

import { realpathSync, statSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, sep } from "node:path";

import { isSecret } from "./credentials.ts";

export const CSV_MAX_BYTES = 5 * 1024 * 1024;

/** RFC 4180 CSV: quoted fields with "" for a quote, commas and newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at]!;
    if (quoted) {
      if (char === '"' && body[at + 1] === '"') {
        field += '"';
        at += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[at + 1] === "\n") at += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw new Error("a quoted field never ends");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const inside = (path: string, root: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

/** The CSV at `path` as a grid, when it lies inside one of `roots`; else an Error saying why. */
export function readCsvIn(path: string, roots: readonly string[]): { grid: string[][]; name: string } {
  if (!isAbsolute(path)) throw new Error("file is an absolute path to a .csv file");
  if (!path.toLowerCase().endsWith(".csv")) throw new Error("file must be a .csv file");
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new Error(`there is no file at ${path}`);
  }
  const root = roots.map((one) => {
    try {
      return realpathSync(one);
    } catch {
      return null;
    }
  }).find((one): one is string => one !== null && inside(real, one));
  if (!root) throw new Error(`${path} is not in this Foreman's company folders or their Workers' worktrees`);
  if (isSecret(relative(root, real))) throw new Error(`${path} has a secret's name`);
  const size = statSync(real).size;
  if (size > CSV_MAX_BYTES) throw new Error(`${path} is ${size} bytes; at most ${CSV_MAX_BYTES}`);
  return { grid: parseCsv(readFileSync(real, "utf8")), name: basename(real) };
}
