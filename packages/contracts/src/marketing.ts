/**
 * The Marketing board, desk and phone alike: what `GET /marketing` answers
 * for a Space's Marketing seat, read by the desk's components/MarketingBoard.tsx and the phone's
 * components/MarketingBoard.tsx, and the rules the agent (agent/marketing.ts) works it out with. Zod-free, so
 * the agent runs it by path and the shapes are tested without a screen.
 *
 * Marketing is about the email: which templates there are, what goes out next, which works. The CRM is about
 * the people. Every number leaves out test sends (an email that went to the owner's own address).
 */

export const MARKETING_PAGES = ["Overview", "Templates", "Campaigns", "Audience", "Sequences"] as const;
export type MarketingPage = (typeof MARKETING_PAGES)[number];

export const MARKETING_RANGES = ["7d", "30d", "90d"] as const;
export type MarketingRange = (typeof MARKETING_RANGES)[number];

/** A template ranks on reply rate after this many sends; before that it is "too few to tell". */
export const RANK_AFTER = 20;
/** A send or a due routine in this many days makes a template Sending. */
export const SENDING_DAYS = 7;
/** A send learns the routine whose run its Foreman started at most this long before the card was made. */
export const ROUTINE_WINDOW_MS = 6 * 60 * 60_000;

export type TemplateStatus = "sending" | "ready" | "idle" | "draft" | "test";

export type RoutineRef = { id: string; name: string; enabled: boolean };
/** Who actually sent a template, from the ledger: a routine, or `null` for Cobra by hand. */
export type Sender = { routine: string | null; name: string; count: number; last: string };

export type MarketingTemplate = {
  slug: string;
  name: string;
  /** transactional, marketing or outreach (an outreach template is a marketing one used by batches). */
  kind: string;
  /** The latest allowed version; null for a draft never allowed. */
  version: number | null;
  /** That version's hash, which the preview is cached by. */
  sha: string | null;
  versions: { version: number; acceptedAt: string }[];
  status: TemplateStatus;
  /** Why it sits on Drafts & tests ("Only ever sent to you"). */
  shelf?: string;
  /** Real sends, all time and in the range. */
  sends: number;
  sendsInRange: number;
  replies: number;
  clicks: number;
  lastUsed: string | null;
  /** Routines whose `templates` name it. */
  routines: RoutineRef[];
  senders: Sender[];
  /** Routines that sent it without naming it: the flag on its page. */
  mismatch: string[];
  campaign: { id: number; name: string } | null;
  /** Test sends to the owner (never counted). */
  tests: number;
};

export type ComingUp = {
  at: string;
  routine: { id: string; name: string };
  template: string | null;
  templateName: string | null;
  version: number | null;
  sha: string | null;
  /** About how many emails: the median of the routine's last runs, else the number its brief names. */
  about: number | null;
};

export type MarketingReply = { id: number; personId: number; name: string; summary: string; on: string; template: string | null };

export type MarketingCampaign = {
  id: number;
  name: string;
  goal: string | null;
  audience: string | null;
  status: "planned" | "running" | "done" | "archived";
  startsOn: string | null;
  endsOn: string | null;
  sends: number;
  replies: number;
  clicks: number;
  templates: string[];
  routines: string[];
};

export type MarketingList = { id: number; name: string; describe: string | null; members: number; joined30: number; left30: number; sources: { source: string; count: number }[] };
export type MarketingSegment = { id: number; name: string; words: string; count: number | null };

export type SequenceStepView = { template: string; name: string; after: string; sent: number; replied: number; clicked: number };
export type MarketingSequence = { slug: string; name: string; state: "active" | "paused"; trigger: string; steps: SequenceStepView[]; active: number; nextAt: string | null; id: number };

export type MarketingBoard = {
  space: { id: string; name: string };
  sender: { mailbox: string; address: string | null; usedToday: number; cap: number };
  range: MarketingRange;
  comingUp: ComingUp[];
  needs: { toAllow: number; stopped: number };
  band: {
    days: { day: string; sent: number; replies: number }[];
    rates: { template: string; name: string; sends: number; replies: number; rate: number | null }[];
    health: { sent: number; clicks: number; unsubscribes: number; bounces: number };
  };
  templates: MarketingTemplate[];
  replies: MarketingReply[];
  campaigns: MarketingCampaign[];
  audience: { people: number; onLists: number; stopped: number; lists: MarketingList[]; segments: MarketingSegment[] };
  sequences: MarketingSequence[];
};

// --- rules (the agent works the board out with these) -----------------------------------

const DAY_MS = 24 * 60 * 60_000;

/** A template's status and, for one on the Drafts & tests shelf, why. */
/** A template kept for trying things out, by its slug: "cold-outreach-test", "realtor-rebuild-scratch", "size-probe2". */
export const TEST_SLUG = /(^|-)(test|scratch|probe\d*)(-|$)/;

export function templateStatus(input: { slug: string; version: number | null; sends: number; tests: number; lastUsed: string | null; dueSoon: boolean }, now: number): { status: TemplateStatus; shelf?: string } {
  if (TEST_SLUG.test(input.slug)) return { status: "test", shelf: "A test copy" };
  if (input.version === null) return { status: "draft", shelf: "Never allowed" };
  if (input.sends === 0 && input.tests > 0) return { status: "test", shelf: "Only ever sent to you" };
  const recent = input.lastUsed !== null && now - Date.parse(input.lastUsed) <= SENDING_DAYS * DAY_MS;
  if (recent || input.dueSoon) return { status: "sending" };
  return { status: input.sends === 0 ? "ready" : "idle" };
}

/** A campaign's status from its sends (set by code): Planned until the first, Running while a routine of it is on or a send came in 7 days, then Done. */
export function campaignStatus(input: { stored: string; sends: number; lastSend: string | null; routineOn: boolean; endsOn: string | null }, today: string, now: number): MarketingCampaign["status"] {
  if (input.stored === "archived") return "archived";
  if (input.endsOn && input.endsOn < today && input.sends > 0) return "done";
  if (input.sends === 0 && !input.routineOn) return input.endsOn && input.endsOn < today ? "done" : "planned";
  if (input.routineOn) return "running";
  return input.lastSend !== null && now - Date.parse(input.lastSend) <= SENDING_DAYS * DAY_MS ? "running" : "done";
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** The number a routine's brief names for its emails: "find 10 prospects", "email 25 realtors". */
export function briefCount(brief: string): number | null {
  const m = /\b(\d{1,3})\s+(?:new\s+|more\s+)?(?:emails?|prospects?|people|realtors?|agents?|leads?|businesses|offices?|contacts?)\b/i.exec(brief);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 500 ? n : null;
}

/** The template slugs a brief names, among the Space's: what a routine with no `templates` field sends. */
export function briefTemplates(brief: string, slugs: readonly string[]): string[] {
  return slugs.filter((slug) => new RegExp(`(^|[^a-z0-9-])${slug.replace(/[-]/g, "\\-")}($|[^a-z0-9-])`, "i").test(brief));
}

/** The reply rate as a whole percent, or null before a template has RANK_AFTER sends. */
export function replyRate(sends: number, replies: number): number | null {
  return sends >= RANK_AFTER ? Math.round((100 * replies) / sends) : null;
}

// --- words both apps use ----------------------------------------------------------------

export const STATUS_WORDS: Record<TemplateStatus, string> = { sending: "Sending", ready: "Ready", idle: "Idle", draft: "Draft", test: "Test" };
export const CAMPAIGN_WORDS: Record<MarketingCampaign["status"], string> = { planned: "Planned", running: "Running", done: "Done", archived: "Archived" };

export function kindWords(kind: string): string {
  return kind === "transactional" ? "Transactional" : kind === "outreach" ? "Outreach" : kind === "marketing" ? "Newsletter" : kind;
}

/** "Today 9:00 AM", "Tue 10:00 AM", in the device's own time. */
export function runWords(iso: string, now: Date): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (day(at) === day(now)) return `Today ${time}`;
  const tomorrow = new Date(now.getTime() + DAY_MS);
  if (day(at) === day(tomorrow)) return `Tomorrow ${time}`;
  return `${at.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

/** "Nov 6", or "—". */
export function dayWords(iso: string | null): string {
  if (!iso) return "—";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
}

export function rateWords(rate: number | null): string {
  return rate === null ? "too few to tell" : `${rate}%`;
}

/** The Templates page: the gallery (newest use first) and the Drafts & tests shelf. */
export function gallery(templates: readonly MarketingTemplate[]): { shown: MarketingTemplate[]; shelf: MarketingTemplate[] } {
  const byUse = (a: MarketingTemplate, b: MarketingTemplate) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? "") || a.name.localeCompare(b.name);
  return { shown: templates.filter((t) => !t.shelf).sort(byUse), shelf: templates.filter((t) => t.shelf).sort(byUse) };
}

/** The Overview's templates: the busiest in the range, at most `n`. */
export function topTemplates(templates: readonly MarketingTemplate[], n = 4): MarketingTemplate[] {
  return templates.filter((t) => !t.shelf && t.sends > 0).sort((a, b) => b.sendsInRange - a.sendsInRange || (b.lastUsed ?? "").localeCompare(a.lastUsed ?? "")).slice(0, n);
}

/** The pages' badges: Templates' count, Campaigns' and Sequences'. */
export function pageCount(board: MarketingBoard, page: MarketingPage): number | null {
  if (page === "Templates") return gallery(board.templates).shown.length || null;
  if (page === "Campaigns") return board.campaigns.filter((c) => c.status !== "archived").length || null;
  if (page === "Sequences") return board.sequences.length || null;
  return null;
}

/** What "Ask Cobra to change it" puts in her box. */
export function askChange(template: Pick<MarketingTemplate, "name" | "slug">): string {
  return `[Template: ${template.name} (${template.slug})] Change this email: `;
}

// --- reading it -------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const ns = (v: unknown): string | null => (typeof v === "string" ? v : null);
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const nn = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);

function routineRef(v: unknown): RoutineRef {
  const r = obj(v);
  return { id: s(r.id), name: s(r.name), enabled: r.enabled !== false };
}

function template(v: unknown): MarketingTemplate | null {
  const t = obj(v);
  if (!s(t.slug)) return null;
  const c = obj(t.campaign);
  return {
    slug: s(t.slug),
    name: s(t.name, s(t.slug)),
    kind: s(t.kind),
    version: nn(t.version),
    sha: ns(t.sha),
    versions: arr(t.versions).map((x) => ({ version: n(obj(x).version), acceptedAt: s(obj(x).acceptedAt) })),
    status: pick(t.status, ["sending", "ready", "idle", "draft", "test"] as const, "idle"),
    ...(typeof t.shelf === "string" ? { shelf: t.shelf } : {}),
    sends: n(t.sends),
    sendsInRange: n(t.sendsInRange),
    replies: n(t.replies),
    clicks: n(t.clicks),
    lastUsed: ns(t.lastUsed),
    routines: arr(t.routines).map(routineRef),
    senders: arr(t.senders).map((x) => ({ routine: ns(obj(x).routine), name: s(obj(x).name), count: n(obj(x).count), last: s(obj(x).last) })),
    mismatch: arr(t.mismatch).filter((x): x is string => typeof x === "string"),
    campaign: typeof c.id === "number" ? { id: c.id, name: s(c.name) } : null,
    tests: n(t.tests),
  };
}

export function parseMarketing(raw: unknown): MarketingBoard | null {
  const b = obj(raw);
  const space = obj(b.space);
  if (!s(space.id)) return null;
  const sender = obj(b.sender);
  const band = obj(b.band);
  const health = obj(band.health);
  const needs = obj(b.needs);
  const aud = obj(b.audience);
  return {
    space: { id: s(space.id), name: s(space.name) },
    sender: { mailbox: s(sender.mailbox, "Mail"), address: ns(sender.address), usedToday: n(sender.usedToday), cap: n(sender.cap) || 200 },
    range: pick(b.range, MARKETING_RANGES, "30d"),
    comingUp: arr(b.comingUp).map((x) => {
      const c = obj(x);
      const r = obj(c.routine);
      return { at: s(c.at), routine: { id: s(r.id), name: s(r.name) }, template: ns(c.template), templateName: ns(c.templateName), version: nn(c.version), sha: ns(c.sha), about: nn(c.about) };
    }).filter((c) => c.at),
    needs: { toAllow: n(needs.toAllow), stopped: n(needs.stopped) },
    band: {
      days: arr(band.days).map((x) => ({ day: s(obj(x).day), sent: n(obj(x).sent), replies: n(obj(x).replies) })),
      rates: arr(band.rates).map((x) => ({ template: s(obj(x).template), name: s(obj(x).name), sends: n(obj(x).sends), replies: n(obj(x).replies), rate: nn(obj(x).rate) })),
      health: { sent: n(health.sent), clicks: n(health.clicks), unsubscribes: n(health.unsubscribes), bounces: n(health.bounces) },
    },
    templates: arr(b.templates).map(template).filter((t): t is MarketingTemplate => t !== null),
    replies: arr(b.replies).map((x) => {
      const r = obj(x);
      return { id: n(r.id), personId: n(r.personId), name: s(r.name), summary: s(r.summary), on: s(r.on), template: ns(r.template) };
    }),
    campaigns: arr(b.campaigns).map((x) => {
      const c = obj(x);
      return {
        id: n(c.id), name: s(c.name), goal: ns(c.goal), audience: ns(c.audience), status: pick(c.status, ["planned", "running", "done", "archived"] as const, "planned"),
        startsOn: ns(c.startsOn), endsOn: ns(c.endsOn), sends: n(c.sends), replies: n(c.replies), clicks: n(c.clicks),
        templates: arr(c.templates).filter((t): t is string => typeof t === "string"), routines: arr(c.routines).filter((t): t is string => typeof t === "string"),
      };
    }),
    audience: {
      people: n(aud.people),
      onLists: n(aud.onLists),
      stopped: n(aud.stopped),
      lists: arr(aud.lists).map((x) => {
        const l = obj(x);
        return { id: n(l.id), name: s(l.name), describe: ns(l.describe), members: n(l.members), joined30: n(l.joined30), left30: n(l.left30), sources: arr(l.sources).map((y) => ({ source: s(obj(y).source), count: n(obj(y).count) })) };
      }),
      segments: arr(aud.segments).map((x) => ({ id: n(obj(x).id), name: s(obj(x).name), words: s(obj(x).words), count: nn(obj(x).count) })),
    },
    sequences: arr(b.sequences).map((x) => {
      const q = obj(x);
      return {
        id: n(q.id), slug: s(q.slug), name: s(q.name), state: pick(q.state, ["active", "paused"] as const, "active"), trigger: s(q.trigger),
        steps: arr(q.steps).map((y) => {
          const st = obj(y);
          return { template: s(st.template), name: s(st.name), after: s(st.after), sent: n(st.sent), replied: n(st.replied), clicked: n(st.clicked) };
        }),
        active: n(q.active), nextAt: ns(q.nextAt),
      };
    }),
  };
}
