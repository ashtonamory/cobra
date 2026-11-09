// The Marketing board: what a Space's
// Marketing seat shows on the desk and the phone, worked out from four places
// at once, which the view engine (views.ts, one store's SQL) cannot join:
//
//   - the template folders (email/templates/<slug>/vN.json, emailFiles.ts),
//   - the send ledger (space-<id>.email.db: email_sends, email_clicks,
//     sequence_runs; emailQueue.ts),
//   - the Space store (People's interactions for replies, campaigns, topics,
//     segments, email_status, email_sequences),
//   - the routines (routines.json: their `templates` and `campaign`).
//
// `buildBoard` is pure over rows already read, so it is tested without files;
// `readBoard` reads them. Test sends (to the owner's own addresses) are kept
// apart and never counted. A reply counts for the template of the person's
// last send on or before its day. A send's routine is stamped when its job is
// queued (`linkOf`): the routine of the same project whose run started at most
// six hours before the card was made.
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@cobra/contracts";
import {
  briefCount, briefTemplates, campaignStatus, median, replyRate, ROUTINE_WINDOW_MS, TEST_SLUG, templateStatus,
  type ComingUp, type MarketingBoard, type MarketingCampaign, type MarketingRange, type MarketingTemplate, MARKETING_RANGES,
} from "../../../../packages/contracts/src/marketing.ts";
import { sampleValues } from "../../../../packages/contracts/src/emailTemplate.ts";
import type { StoredApproval } from "./approvals.ts";
import { audienceOf } from "./emailAudience.ts";
import { currentTheme, EmailFileError, emailFolders, listTemplates, readDraft, readVersion, SLUG, type EmailFolders, type ThemePlace } from "./emailFiles.ts";
import type { EmailQueue, JobLink } from "./emailQueue.ts";
import { DAILY_CAP } from "./emailQueue.ts";
import { renderForView } from "./emailSend.ts";
import { readSequenceVersion } from "./emailSequences.ts";
import type { ProjectDb } from "./dbTypes.ts";
import { asRule, nextRun, type StoredRoutine } from "./routines.ts";
import type { SegmentFilter } from "./trades/audience.ts";

const DAY_MS = 24 * 60 * 60_000;
const RANGE_DAYS: Record<MarketingRange, number> = { "7d": 7, "30d": 30, "90d": 90 };
const COMING_DAYS = 7;

// --- the link a job carries ----------------------------------------------------------

/**
 * A new job's routine and campaign, from the approval it was allowed on: the routine of the card's project
 * that started a run at most six hours before the card was made (one naming the job's template first), and
 * the campaign the card named, else the routine's.
 */
export function linkOf(approval: Pick<StoredApproval, "createdAt" | "action"> | undefined, routines: readonly StoredRoutine[]): JobLink | null {
  const action = approval?.action;
  if (!approval || !action) return null;
  const made = Date.parse(approval.createdAt);
  const template = action.batch?.template ?? action.campaign?.template ?? action.branded?.template ?? null;
  const ran = routines.filter((r) => {
    if (r.project !== action.project || !r.lastRun || r.lastRun.outcome !== "started") return false;
    const at = Date.parse(r.lastRun.at);
    return Number.isFinite(at) && at <= made && made - at <= ROUTINE_WINDOW_MS;
  });
  const named = ran.filter((r) => template !== null && r.templates?.includes(template));
  const routine = [...(named.length ? named : ran)].sort((a, b) => Date.parse(b.lastRun!.at) - Date.parse(a.lastRun!.at))[0] ?? null;
  const campaign = action.batch?.marketingCampaign ?? action.campaign?.marketingCampaign ?? routine?.campaign ?? null;
  if (!routine && campaign === null) return null;
  return { routine: routine?.id ?? null, routineRun: routine?.lastRun?.due ?? null, campaign };
}

// --- rows ----------------------------------------------------------------------------

export type SendRowLite = { id: number; jobId: number | null; kind: string; template: string; to: string; account: string; personId: number | null; sentAt: string; routine: string | null; routineRun: string | null; campaign: number | null };
export type ReplyRowLite = { id: number; personId: number; name: string; summary: string; on: string };
export type TemplateFile = { slug: string; name: string; kind: string; versions: { version: number; acceptedAt: string; sha: string }[] };
export type CampaignRow = { id: number; name: string; goal: string | null; audience: string | null; status: string; startsOn: string | null; endsOn: string | null };
export type TopicRow = { id: number; name: string; describe: string | null; members: number; joined30: number; left30: number; sources: { source: string; count: number }[] };
export type SequenceRowLite = { id: number; slug: string; name: string; version: number; state: string; trigger: string; steps: { template: string; after: string }[]; active: number; nextAt: string | null };

export type BoardInput = {
  space: { id: string; name: string };
  sender: MarketingBoard["sender"];
  range: MarketingRange;
  now: number;
  today: string;
  own: readonly string[];
  templates: readonly TemplateFile[];
  sends: readonly SendRowLite[];
  clicks: readonly { jobId: number; at: string }[];
  replies: readonly ReplyRowLite[];
  routines: readonly StoredRoutine[];
  /** A routine's runs in the next 7 days (the rule's own times). */
  runsOf: (routine: StoredRoutine) => string[];
  campaigns: readonly CampaignRow[];
  needs: { toAllow: number; stopped: number };
  status: { unsubscribes: number; bounces: number };
  audience: { people: number; onLists: number; stopped: number; lists: TopicRow[]; segments: MarketingBoard["audience"]["segments"] };
  sequences: readonly SequenceRowLite[];
};

/** The routines' templates: their field, or the slugs their brief names when they have none. */
export function routineTemplates(routine: Pick<StoredRoutine, "templates" | "brief">, slugs: readonly string[]): string[] {
  return routine.templates?.length ? routine.templates : briefTemplates(routine.brief, slugs);
}

export function buildBoard(input: BoardInput): MarketingBoard {
  const own = new Set(input.own.map((a) => a.trim().toLowerCase()).filter(Boolean));
  // A test: to the owner's own address, or of a template kept for trying things out.
  const isTest = (s: SendRowLite) => own.has(s.to.trim().toLowerCase()) || TEST_SLUG.test(s.template);
  const real = input.sends.filter((s) => !isTest(s));
  const tests = input.sends.filter(isTest);
  const rangeDays = RANGE_DAYS[input.range];
  const since = new Date(input.now - (rangeDays - 1) * DAY_MS).toISOString().slice(0, 10);
  const slugs = input.templates.map((t) => t.slug);
  const routineById = new Map(input.routines.map((r) => [r.id, r]));
  const campaignName = new Map(input.campaigns.map((c) => [c.id, c.name]));

  // A reply belongs to the person's last send on or before its day.
  const byPerson = new Map<number, SendRowLite[]>();
  for (const s of [...real].sort((a, b) => a.sentAt.localeCompare(b.sentAt))) if (s.personId !== null) byPerson.set(s.personId, [...(byPerson.get(s.personId) ?? []), s]);
  const replyOf = new Map<number, SendRowLite | null>();
  for (const r of input.replies) {
    const before = (byPerson.get(r.personId) ?? []).filter((s) => s.sentAt.slice(0, 10) <= r.on);
    replyOf.set(r.id, before.at(-1) ?? null);
  }
  const sendOfJob = new Map(real.filter((s) => s.jobId !== null).map((s) => [s.jobId!, s]));
  const clicked = input.clicks.flatMap((c) => (sendOfJob.has(c.jobId) ? [{ send: sendOfJob.get(c.jobId)!, at: c.at }] : []));
  const repliesFor = (pick: (s: SendRowLite) => boolean) => input.replies.filter((r) => { const s = replyOf.get(r.id); return s ? pick(s) : false; });

  const comingUp: ComingUp[] = [];
  for (const routine of input.routines) {
    if (!routine.enabled) continue;
    const sends = routineTemplates(routine, slugs);
    if (!sends.length) continue;
    const runs = new Map<string, number>();
    for (const s of real) if (s.routine === routine.id && s.routineRun) runs.set(s.routineRun, (runs.get(s.routineRun) ?? 0) + 1);
    const lastFive = [...runs.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 5).map(([, n]) => n);
    const about = median(lastFive) ?? briefCount(routine.brief);
    const first = input.templates.find((t) => t.slug === sends[0]);
    const latest = first?.versions.at(-1) ?? null;
    for (const at of input.runsOf(routine)) {
      comingUp.push({ at, routine: { id: routine.id, name: routine.name }, template: sends[0]!, templateName: first?.name ?? sends[0]!, version: latest?.version ?? null, sha: latest?.sha ?? null, about });
    }
  }
  comingUp.sort((a, b) => a.at.localeCompare(b.at));
  const dueSoon = new Set(comingUp.flatMap((c) => (c.template ? [c.template] : [])));

  const templates: MarketingTemplate[] = input.templates.map((file) => {
    const mine = real.filter((s) => s.template === file.slug);
    const mineTests = tests.filter((s) => s.template === file.slug).length;
    const lastUsed = mine.reduce<string | null>((max, s) => (max === null || s.sentAt > max ? s.sentAt : max), null);
    const latest = file.versions.at(-1) ?? null;
    const kind = mine.some((s) => s.kind === "outreach") ? "outreach" : file.kind;
    const state = templateStatus({ slug: file.slug, version: latest?.version ?? null, sends: mine.length, tests: mineTests, lastUsed, dueSoon: dueSoon.has(file.slug) }, input.now);
    const listing = input.routines.filter((r) => routineTemplates(r, slugs).includes(file.slug));
    const groups = new Map<string | null, SendRowLite[]>();
    for (const s of mine) groups.set(s.routine, [...(groups.get(s.routine) ?? []), s]);
    const senders = [...groups.entries()].map(([routine, rows]) => ({
      routine,
      name: routine === null ? "Cobra by hand" : (routineById.get(routine)?.name ?? "A removed routine"),
      count: rows.length,
      last: rows.reduce((m, s) => (s.sentAt > m ? s.sentAt : m), ""),
    })).sort((a, b) => b.last.localeCompare(a.last));
    const mismatch = senders.flatMap((s) => {
      const r = s.routine ? routineById.get(s.routine) : undefined;
      return r && r.templates?.length && !r.templates.includes(file.slug) ? [r.name] : [];
    });
    const campaignCounts = new Map<number, number>();
    for (const s of mine) if (s.campaign !== null) campaignCounts.set(s.campaign, (campaignCounts.get(s.campaign) ?? 0) + 1);
    const campaignId = [...campaignCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? listing.find((r) => r.campaign !== undefined)?.campaign ?? null;
    return {
      slug: file.slug,
      name: file.name,
      kind,
      version: latest?.version ?? null,
      sha: latest?.sha ?? null,
      versions: file.versions.map((v) => ({ version: v.version, acceptedAt: v.acceptedAt })),
      ...state,
      sends: mine.length,
      sendsInRange: mine.filter((s) => s.sentAt.slice(0, 10) >= since).length,
      replies: repliesFor((s) => s.template === file.slug).length,
      clicks: clicked.filter((c) => c.send.template === file.slug).length,
      lastUsed,
      routines: listing.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })),
      senders,
      mismatch: [...new Set(mismatch)],
      campaign: campaignId !== null && campaignName.has(campaignId) ? { id: campaignId, name: campaignName.get(campaignId)! } : null,
      tests: mineTests,
    };
  });

  const days: MarketingBoard["band"]["days"] = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const day = new Date(input.now - i * DAY_MS).toISOString().slice(0, 10);
    days.push({ day, sent: real.filter((s) => s.sentAt.slice(0, 10) === day).length, replies: input.replies.filter((r) => r.on === day).length });
  }
  const inRange = real.filter((s) => s.sentAt.slice(0, 10) >= since);
  const rates = templates
    .filter((t) => !t.shelf && t.sendsInRange > 0)
    .map((t) => {
      const replies = repliesFor((s) => s.template === t.slug && s.sentAt.slice(0, 10) >= since).length;
      return { template: t.slug, name: t.name, sends: t.sendsInRange, replies, rate: replyRate(t.sendsInRange, replies) };
    })
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.sends - a.sends);

  const campaigns: MarketingCampaign[] = input.campaigns.map((c) => {
    const mine = real.filter((s) => s.campaign === c.id);
    const linked = input.routines.filter((r) => r.campaign === c.id);
    const lastSend = mine.reduce<string | null>((m, s) => (m === null || s.sentAt > m ? s.sentAt : m), null);
    return {
      id: c.id, name: c.name, goal: c.goal, audience: c.audience,
      status: campaignStatus({ stored: c.status, sends: mine.length, lastSend, routineOn: linked.some((r) => r.enabled), endsOn: c.endsOn }, input.today, input.now),
      startsOn: c.startsOn, endsOn: c.endsOn,
      sends: mine.length,
      replies: repliesFor((s) => s.campaign === c.id).length,
      clicks: clicked.filter((x) => x.send.campaign === c.id).length,
      templates: [...new Set([...mine.map((s) => s.template), ...linked.flatMap((r) => routineTemplates(r, slugs))])].map((slug) => input.templates.find((t) => t.slug === slug)?.name ?? slug),
      routines: linked.map((r) => r.name),
    };
  });
  const order: Record<MarketingCampaign["status"], number> = { running: 0, planned: 1, done: 2, archived: 3 };
  campaigns.sort((a, b) => order[a.status] - order[b.status] || (b.startsOn ?? "").localeCompare(a.startsOn ?? ""));

  const sequences = input.sequences.map((q) => ({
    id: q.id, slug: q.slug, name: q.name, state: (q.state === "paused" ? "paused" : "active") as "active" | "paused", trigger: q.trigger,
    steps: q.steps.map((st) => {
      const mine = real.filter((s) => s.kind === "sequence" && s.template === st.template);
      return {
        template: st.template,
        name: input.templates.find((t) => t.slug === st.template)?.name ?? st.template,
        after: st.after,
        sent: mine.length,
        replied: repliesFor((s) => s.kind === "sequence" && s.template === st.template).length,
        clicked: clicked.filter((c) => c.send.kind === "sequence" && c.send.template === st.template).length,
      };
    }),
    active: q.active, nextAt: q.nextAt,
  }));

  return {
    space: input.space,
    sender: input.sender,
    range: input.range,
    comingUp: comingUp.slice(0, 20),
    needs: input.needs,
    band: { days, rates, health: { sent: inRange.length, clicks: clicked.filter((c) => c.at.slice(0, 10) >= since).length, unsubscribes: input.status.unsubscribes, bounces: input.status.bounces } },
    templates,
    replies: [...input.replies].sort((a, b) => b.on.localeCompare(a.on) || b.id - a.id).slice(0, 8).map((r) => ({ ...r, template: replyOf.get(r.id)?.template ?? null })),
    campaigns,
    audience: input.audience,
    sequences,
  };
}

// --- reading -------------------------------------------------------------------------

export type MarketingDeps = {
  project: (id: string) => Promise<Project | undefined>;
  space: (project: Project) => { id: string; dir: string; name: string } | null;
  /** The routines whose project is in this Space. */
  routines: (space: string) => Promise<StoredRoutine[]>;
  queue: (space: string) => EmailQueue;
  store: <T>(space: string, use: (db: ProjectDb) => T) => T | null;
  sender: (space: string) => Promise<{ mailbox: string; address: string | null }>;
  cap: (space: string) => Promise<{ cap: number; left: number }>;
  /** The owner's own addresses: every sending mailbox and the Gmail account. Sends to these are tests. */
  own: () => Promise<string[]>;
  place: (space: { id: string; dir: string; name: string }) => ThemePlace;
  now: () => number;
  tz?: string;
  log: (line: string) => void;
};

function n(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
}
const sOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function templateFiles(folders: EmailFolders): TemplateFile[] {
  return listTemplates(folders).map((t) => ({
    slug: t.slug,
    name: t.latest ? (readVersion(folders, t.slug)?.template.name ?? t.name) : (t.draft?.name ?? t.name),
    kind: t.kind,
    versions: t.versions.flatMap((v) => {
      const kept = readVersion(folders, t.slug, v);
      return kept ? [{ version: v, acceptedAt: kept.acceptedAt, sha: kept.sha256 }] : [];
    }),
  }));
}

function sendRows(queue: EmailQueue): SendRowLite[] {
  return (queue.db.prepare("SELECT id, job_id, kind, template, to_email, account, person_id, sent_at, routine, routine_run, campaign FROM email_sends ORDER BY id DESC LIMIT 20000").all() as Record<string, unknown>[]).map((r) => ({
    id: n(r.id), jobId: r.job_id === null ? null : n(r.job_id), kind: String(r.kind ?? ""), template: String(r.template ?? ""), to: String(r.to_email ?? ""), account: String(r.account ?? ""),
    personId: r.person_id === null || r.person_id === undefined ? null : n(r.person_id), sentAt: String(r.sent_at ?? ""),
    routine: sOrNull(r.routine), routineRun: sOrNull(r.routine_run), campaign: r.campaign === null || r.campaign === undefined ? null : n(r.campaign),
  }));
}

function delayWords(after: { days?: number; hours?: number } | undefined, first: boolean): string {
  if (!after || (!after.days && !after.hours)) return first ? "At once" : "Right after";
  const parts = [after.days ? `${after.days} ${after.days === 1 ? "day" : "days"}` : "", after.hours ? `${after.hours} h` : ""].filter(Boolean).join(" ");
  return `After ${parts}`;
}

function filterWords(filter: SegmentFilter): string {
  const parts = [
    filter.stages?.length ? `stage ${filter.stages.join(" or ")}` : "",
    filter.sources?.length ? `from ${filter.sources.join(" or ")}` : "",
    filter.topics?.length ? `on ${filter.topics.join(" and ")}` : "",
    ...(filter.fields ?? []).map((f) => `${f.field} is ${f.is}`),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Everyone";
}

/** Store tables a Space without People lacks read as empty. */
function rows(db: ProjectDb, sql: string, params: (string | number)[] = []): Record<string, unknown>[] {
  try {
    return db.queryRaw(sql, params, 5000).rows as Record<string, unknown>[];
  } catch {
    return [];
  }
}

export async function readBoard(space: { id: string; dir: string; name: string }, range: MarketingRange, deps: MarketingDeps): Promise<MarketingBoard> {
  const now = deps.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const days30 = new Date(now - 30 * DAY_MS).toISOString();
  const since = new Date(now - (RANGE_DAYS[range] - 1) * DAY_MS).toISOString().slice(0, 10);
  const folders = emailFolders(space.dir);
  const queue = deps.queue(space.id);
  const [routines, sender, cap, own] = await Promise.all([
    deps.routines(space.id),
    deps.sender(space.id).catch(() => ({ mailbox: "Mail", address: null })),
    deps.cap(space.id).catch(() => ({ cap: DAILY_CAP, left: DAILY_CAP })),
    deps.own().catch(() => [] as string[]),
  ]);
  const sends = sendRows(queue);
  const accounts = [...new Set(sends.map((s) => s.account).filter(Boolean))];
  const clicks = (queue.db.prepare("SELECT job_id, at FROM email_clicks ORDER BY id DESC LIMIT 20000").all() as Record<string, unknown>[]).map((r) => ({ jobId: n(r.job_id), at: String(r.at ?? "") }));
  let active: Record<string, { active: number; nextAt: string | null }> = {};
  try {
    active = Object.fromEntries((queue.db.prepare("SELECT slug, count(*) AS n, min(next_at) AS next FROM sequence_runs WHERE state = 'active' GROUP BY slug").all() as Record<string, unknown>[]).map((r) => [String(r.slug), { active: n(r.n), nextAt: sOrNull(r.next) }]));
  } catch {
    active = {};
  }

  const fromStore = deps.store(space.id, (db) => {
    const replies = rows(db, `SELECT i.id AS id, i.person_id AS person_id, p.name AS name, i.summary AS summary, i.happened_on AS on_day
      FROM interactions i JOIN people p ON p.id = i.person_id WHERE i.kind = 'email' AND i.ref LIKE 'reply:%' ORDER BY i.happened_on DESC, i.id DESC LIMIT 2000`)
      .map((r) => ({ id: n(r.id), personId: n(r.person_id), name: String(r.name ?? ""), summary: String(r.summary ?? ""), on: String(r.on_day ?? "") }));
    const campaigns = rows(db, "SELECT id, name, goal, audience, status, starts_on, ends_on FROM campaigns ORDER BY id")
      .map((r) => ({ id: n(r.id), name: String(r.name ?? ""), goal: sOrNull(r.goal), audience: sOrNull(r.audience), status: String(r.status ?? "planned"), startsOn: sOrNull(r.starts_on), endsOn: sOrNull(r.ends_on) }));
    const toAllow = n(rows(db, "SELECT count(*) AS n FROM person_topics WHERE state = 'proposed'")[0]?.n);
    const stoppedRecent = n(rows(db, "SELECT count(*) AS n FROM email_status WHERE since >= ?", [days30])[0]?.n);
    const unsubscribes = n(rows(db, "SELECT count(*) AS n FROM email_status WHERE status = 'unsubscribed' AND substr(since, 1, 10) >= ?", [since])[0]?.n);
    const bounces = n(rows(db, "SELECT count(*) AS n FROM email_status WHERE status = 'bounced' AND substr(since, 1, 10) >= ?", [since])[0]?.n);
    const people = n(rows(db, "SELECT count(*) AS n FROM people WHERE archived_at IS NULL")[0]?.n);
    const onLists = n(rows(db, "SELECT count(DISTINCT person_id) AS n FROM person_topics WHERE state = 'joined'")[0]?.n);
    const stopped = n(rows(db, "SELECT count(*) AS n FROM email_status")[0]?.n);
    const lists = rows(db, "SELECT id, name, describe FROM email_topics WHERE archived_at IS NULL ORDER BY name").map((t) => {
      const id = n(t.id);
      const sources = rows(db, "SELECT source, count(*) AS n FROM person_topics WHERE topic_id = ? AND state = 'joined' GROUP BY source ORDER BY n DESC", [id]).map((r) => ({ source: String(r.source ?? ""), count: n(r.n) }));
      return {
        id, name: String(t.name ?? ""), describe: sOrNull(t.describe),
        members: sources.reduce((sum, x) => sum + x.count, 0),
        joined30: n(rows(db, "SELECT count(*) AS n FROM person_topics WHERE topic_id = ? AND state = 'joined' AND joined_at >= ?", [id, days30])[0]?.n),
        left30: n(rows(db, "SELECT count(*) AS n FROM person_topics WHERE topic_id = ? AND left_at >= ?", [id, days30])[0]?.n),
        sources,
      };
    });
    const segments = rows(db, "SELECT id, name, filter FROM segments WHERE archived_at IS NULL ORDER BY name").map((r) => {
      let filter: SegmentFilter = {};
      try {
        filter = JSON.parse(String(r.filter ?? "{}")) as SegmentFilter;
      } catch {
        filter = {};
      }
      let count: number | null = null;
      const [topic, ...more] = filter.topics ?? [];
      if (topic) {
        try {
          count = audienceOf(db, topic, { ...filter, topics: more }).length;
        } catch {
          count = null;
        }
      }
      return { id: n(r.id), name: String(r.name ?? ""), words: filterWords(filter), count };
    });
    const sequences = rows(db, "SELECT id, slug, name, version, state, trigger FROM email_sequences ORDER BY name").map((r) => {
      const slug = String(r.slug ?? "");
      const kept = readSequenceVersion(folders, slug, n(r.version));
      return {
        id: n(r.id), slug, name: String(r.name ?? slug), version: n(r.version), state: String(r.state ?? "active"), trigger: String(r.trigger ?? ""),
        steps: (kept?.steps ?? []).map((st, i) => ({ template: st.template, after: delayWords(st.after, i === 0) })),
        active: active[slug]?.active ?? 0, nextAt: active[slug]?.nextAt ?? null,
      };
    });
    return { replies, campaigns, needs: { toAllow, stopped: stoppedRecent }, status: { unsubscribes, bounces }, audience: { people, onLists, stopped, lists, segments }, sequences };
  });
  const store = fromStore ?? { replies: [], campaigns: [], needs: { toAllow: 0, stopped: 0 }, status: { unsubscribes: 0, bounces: 0 }, audience: { people: 0, onLists: 0, stopped: 0, lists: [], segments: [] }, sequences: [] };

  const until = now + COMING_DAYS * DAY_MS;
  const runsOf = (routine: StoredRoutine): string[] => {
    const rule = asRule(routine.rule);
    if (!rule || !routine.nextRun) return [];
    const out: string[] = [];
    let at = Date.parse(routine.nextRun);
    while (Number.isFinite(at) && at <= until && out.length < 14) {
      out.push(new Date(at).toISOString());
      at = nextRun(rule, new Date(at + 60_000), deps.tz).getTime();
    }
    return out;
  };

  return buildBoard({
    space: { id: space.id, name: space.name },
    sender: { mailbox: sender.mailbox, address: sender.address, usedToday: Math.max(0, cap.cap - cap.left), cap: cap.cap },
    range,
    now,
    today,
    own: [...own, ...accounts],
    templates: templateFiles(folders),
    sends,
    clicks,
    replies: store.replies,
    routines,
    runsOf,
    campaigns: store.campaigns,
    needs: store.needs,
    status: store.status,
    audience: store.audience,
    sequences: store.sequences,
  });
}

// --- routes --------------------------------------------------------------------------

export const MARKETING_ROUTES = new Set(["/marketing", "/marketing/preview", "/marketing/test", "/marketing/archive"]);
export const MARKETING_POSTS = new Set(["/marketing/test", "/marketing/archive"]);

type Reply = { status: number; body: unknown };
const bad = (status: number, error: string): Reply => ({ status, body: { error } });

/**
 * The phone's and the desk's Marketing board. `GET /marketing?project=&range=` the board; `GET
 * /marketing/preview?project=&template=` a template's latest allowed version drawn with sample values
 * (its draft when it has none); `POST /marketing/test {project, template}` that version to the Space's own
 * sending address (never counted); `POST /marketing/archive {project, template}` its folder moved to
 * email/archive/ (kept on disk; refused while a routine names it).
 */
export async function handleMarketing(route: string, method: string, url: URL, body: string, caller: { kind: string }, deps: MarketingDeps & { enqueueTest: (space: string, job: { template: string; version: number; templateSha: string; values: Record<string, unknown>; to: string }) => number }, personKinds: ReadonlySet<string>): Promise<Reply> {
  if (!personKinds.has(caller.kind)) return bad(403, "only a phone or a desk you linked reads the Marketing board");
  const posting = MARKETING_POSTS.has(route);
  if (method !== (posting ? "POST" : "GET")) return bad(405, posting ? "POST only" : "GET only");
  let input: Record<string, unknown> = {};
  if (posting) {
    try {
      input = JSON.parse(body || "{}") as Record<string, unknown>;
    } catch {
      return bad(400, "the body is JSON");
    }
  }
  const projectId = posting ? String(input.project ?? "") : (url.searchParams.get("project") ?? "");
  const project = projectId ? await deps.project(projectId) : undefined;
  if (!project) return bad(404, "no such project here");
  const space = deps.space(project);
  if (!space) return bad(409, `${project.name} is not part of a Space, so it has no email`);
  const folders = emailFolders(space.dir);
  try {
    if (route === "/marketing") {
      const asked = url.searchParams.get("range") ?? "30d";
      const range = (MARKETING_RANGES as readonly string[]).includes(asked) ? (asked as MarketingRange) : "30d";
      return { status: 200, body: await readBoard(space, range, deps) };
    }
    const slug = String((posting ? input.template : url.searchParams.get("template")) ?? "");
    if (!SLUG.test(slug)) return bad(400, "template is a template's slug");
    const version = readVersion(folders, slug);
    if (route === "/marketing/preview") {
      const theme = currentTheme(folders, deps.place(space));
      const drawnFrom = version?.template ?? readDraft(folders, slug)?.template ?? null;
      if (!drawnFrom) return bad(404, `no template ${slug}`);
      const drawn = renderForView(folders, theme, drawnFrom, sampleValues(drawnFrom));
      return { status: 200, body: { subject: drawn.subject, html: drawn.html, text: drawn.text, version: version?.version ?? null, sample: true } };
    }
    if (route === "/marketing/test") {
      if (!version) return bad(409, `${slug} has no allowed version yet, so it cannot send`);
      const sender = await deps.sender(space.id).catch(() => ({ mailbox: "Mail", address: null }));
      if (!sender.address) return bad(409, `${space.name} has no sending address here: choose its mailbox in Settings → Mailboxes`);
      const id = deps.enqueueTest(space.id, { template: slug, version: version.version, templateSha: version.sha256, values: sampleValues(version.template), to: sender.address });
      deps.log(`marketing: test of ${slug} v${version.version} queued as job ${id} to ${sender.address}`);
      return { status: 200, body: { queued: id, to: sender.address, summary: `A test of ${version.template.name} goes to ${sender.address} within a minute` } };
    }
    // Archive: the folder moves to email/archive/<slug>-<date>; nothing is deleted.
    const naming = (await deps.routines(space.id)).filter((r) => r.templates?.includes(slug));
    if (naming.length) return bad(409, `${naming.map((r) => `“${r.name}”`).join(", ")} still sends ${slug}: change the routine first`);
    const from = join(folders.templates, slug);
    if (!existsSync(from)) return bad(404, `no template ${slug}`);
    const archive = join(folders.root, "archive");
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    let to = join(archive, `${slug}-${new Date(deps.now()).toISOString().slice(0, 10)}`);
    for (let i = 2; existsSync(to); i++) to = join(archive, `${slug}-${new Date(deps.now()).toISOString().slice(0, 10)}-${i}`);
    renameSync(from, to);
    deps.log(`marketing: archived template ${slug} of ${space.id}`);
    return { status: 200, body: { archived: slug, summary: `Archived ${slug}; it is kept in email/archive` } };
  } catch (caught) {
    if (caught instanceof EmailFileError) return bad(caught.status, caught.message);
    throw caught;
  }
}
