import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkCommit, WorkPr } from "@cobra/contracts";

import { git } from "./collect/git.ts";

const run = promisify(execFile);

/**
 * What was done in one repository since a time, for the phone's "what have we
 * done in X today?" (`GET /worklog`): commits on every branch and the PRs
 * merged on GitHub. Reads only. Merge commits are left out, since a merge says
 * nothing a PR line does not; a squash merge is one ordinary commit on main.
 */

/** At most this many commits go to the phone; `truncated` says there were more. */
export const MAX_COMMITS = 200;
/** The longest window the phone may ask for. */
export const MAX_WINDOW_MS = 31 * 24 * 60 * 60_000;

const FIELD = "\x1f";
const FORMAT = ["%H", "%S", "%s", "%an", "%aI"].join("%x1f");

/** `--source` names the ref a commit was reached by: "refs/heads/main" and "refs/remotes/origin/main" both read "main". */
export function refName(source: string): string | null {
  const name = source
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/[^/]+\//, "")
    .replace(/^refs\/tags\//, "");
  if (!name || name === "HEAD" || name.startsWith("refs/")) return null;
  return name;
}

/** `git log` output in FORMAT, one commit per line, into commits; malformed lines are skipped. */
export function parseLog(stdout: string): WorkCommit[] {
  const commits: WorkCommit[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const [sha, source, subject, author, at] = line.split(FIELD);
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha) || subject === undefined || !at || seen.has(sha)) continue;
    seen.add(sha);
    commits.push({ sha, subject: subject.trim(), author: (author ?? "").trim(), at: at.trim(), ref: refName(source ?? "") });
  }
  return commits;
}

export async function readCommits(path: string, since: number): Promise<{ commits: WorkCommit[]; truncated: boolean }> {
  const out = await git(
    path,
    ["log", "--all", "--source", "--no-merges", `--since=${new Date(since).toISOString()}`, `--format=${FORMAT}`, "-n", String(MAX_COMMITS + 1)],
    8000,
  );
  const commits = parseLog(out ?? "").filter((commit) => Date.parse(commit.at) >= since);
  return { commits: commits.slice(0, MAX_COMMITS), truncated: commits.length > MAX_COMMITS };
}

type GhMerged = { number?: unknown; title?: unknown; mergedAt?: unknown; headRefName?: unknown; url?: unknown };

/** gh's merged PR list into PRs merged since the time, newest first. */
export function parseMerged(raw: unknown, since: number): WorkPr[] {
  if (!Array.isArray(raw)) return [];
  const prs: WorkPr[] = [];
  for (const item of raw as GhMerged[]) {
    if (typeof item?.number !== "number" || typeof item.title !== "string" || typeof item.mergedAt !== "string") continue;
    if (!(Date.parse(item.mergedAt) >= since)) continue;
    prs.push({
      number: item.number,
      title: item.title,
      mergedAt: item.mergedAt,
      ...(typeof item.headRefName === "string" ? { branch: item.headRefName } : {}),
      ...(typeof item.url === "string" ? { url: item.url } : {}),
    });
  }
  return prs.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
}

export async function listMerged(gh: string, remote: string, since: number): Promise<WorkPr[]> {
  // GitHub's search takes a day; the exact time is filtered after.
  const day = new Date(since).toISOString().slice(0, 10);
  const { stdout } = await run(
    gh,
    ["pr", "list", "-R", remote, "--state", "merged", "--search", `merged:>=${day}`, "--limit", "100", "--json", "number,title,mergedAt,headRefName,url"],
    { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseMerged(JSON.parse(stdout) as unknown, since);
}

/** The `since` query parameter, held to the last MAX_WINDOW_MS; a missing or bad one means a day. */
export function windowStart(param: string | null, now = Date.now()): number {
  const asked = Date.parse(param ?? "");
  if (!Number.isFinite(asked)) return now - 24 * 60 * 60_000;
  return Math.min(now, Math.max(asked, now - MAX_WINDOW_MS));
}
