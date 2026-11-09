/**
 * A Space's Marketing tab on the desk: a left rail like Finance's (Overview, Templates, Campaigns, Audience, Sequences) with the sending mailbox
 * at its foot, in the coral marketing accent. Everything comes from the agent's `GET /marketing` (marketing.ts,
 * contracts marketing.ts): Coming up from the routines that send email, Needs you (people to add to a list,
 * addresses that stopped), the band, the template gallery with the real emails drawn by the agent, a template's
 * page with Ask Cobra to change it and Send me a test, campaigns, lists and segments, and each sequence's steps.
 * Allow / Drop, Let them back and Pause / Resume are the Outreach trade's own writes (viewSpecs/outreach.ts),
 * run through Dashboard.tsx's `act`.
 */
import { useEffect, useMemo, useState } from "react";
import {
  askChange, CAMPAIGN_WORDS, dayWords, gallery, kindWords, MARKETING_PAGES, MARKETING_RANGES, pageCount, parseMarketing, rateWords, replyRate, STATUS_WORDS, topTemplates, runWords,
  type MarketingBoard as Board, type MarketingPage, type MarketingRange, type MarketingTemplate,
} from "../../../../../packages/contracts/src/marketing.ts";
import { parseViewResult } from "../../../../../packages/contracts/src/viewsRead.ts";
import type { ViewAction, ViewRow } from "../../../../../packages/contracts/src/views.ts";
import * as api from "../lib/api.ts";
import { askCobraWith } from "../lib/cobraDraft.ts";
import { useApp } from "../app/context.ts";
import { Button, Dialog, cls } from "./ui.tsx";
import { PreviewFrame } from "./PreviewFrame.tsx";
import "../styles/marketing.css";
import { LEAD_NAME } from "../lib/appName.ts";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Preview = { subject: string; html: string } | { error: string };
/** Drawn emails, by computer, project, template and version hash: a gallery draws each once. */
const previews = new Map<string, Promise<Preview>>();

function usePreview(machine: string, project: string, template: string | null, sha: string | null): Preview | null {
  const [got, setGot] = useState<Preview | null>(null);
  useEffect(() => {
    if (!template) return setGot(null);
    let live = true;
    const key = `${machine}|${project}|${template}|${sha ?? "draft"}`;
    let promise = previews.get(key);
    if (!promise) {
      promise = api.marketingPreview(machine, project, template).then(
        (raw) => { const r = raw as { subject?: string; html?: string }; return { subject: r?.subject ?? "", html: r?.html ?? "" }; },
        (e) => ({ error: msg(e) }),
      );
      previews.set(key, promise);
    }
    void promise.then((p) => live && setGot(p));
    return () => void (live = false);
  }, [machine, project, template, sha]);
  return got;
}

/** The email as a light mail app shows it: its own dark-mode rules stay off (Dark is the page's own switch). */
function lightOnly(html: string): string {
  const head = '<meta name="color-scheme" content="light only"><style>:root{color-scheme:light only}</style>';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${head}`) : `${head}${html}`;
}

/** A template's email, small: the agent's HTML in a sandboxed frame, scaled from 600 px to the tile's width. */
function Thumb({ machine, project, template, sha, height = 150 }: { machine: string; project: string; template: string | null; sha: string | null; height?: number }) {
  const preview = usePreview(machine, project, template, sha);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.4);
  useEffect(() => {
    if (!box) return;
    const seen = new ResizeObserver(() => setScale(Math.max(0.05, box.clientWidth / 600)));
    seen.observe(box);
    return () => seen.disconnect();
  }, [box]);
  return (
    <div className="mkt-thumb" style={{ height }} ref={setBox}>
      {!preview ? <div className="mkt-thumb-note dim">Drawing…</div>
        : "error" in preview ? <div className="mkt-thumb-note dim">No preview</div>
        : <PreviewFrame className="mkt-thumb-frame" title="Email" html={lightOnly(preview.html)} tabIndex={-1} style={{ transform: `scale(${scale})`, height: Math.ceil(height / scale) }} />}
    </div>
  );
}

export type MarketingProps = {
  machine: string; project: string; space?: string; written: number;
  act: (action: ViewAction, id: string | null) => void;
};

export function MarketingBoard(props: MarketingProps) {
  const { machine, project, written } = props;
  const app = useApp();
  const [page, setPage] = useState<MarketingPage>("Overview");
  const [range, setRange] = useState<MarketingRange>("30d");
  const [board, setBoard] = useState<Board | { error: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [sheet, setSheet] = useState(false);

  useEffect(() => {
    let live = true;
    api.marketing(machine, project, range).then(
      (raw) => live && setBoard(parseMarketing(raw) ?? { error: "the computer answered with no board" }),
      (e) => live && setBoard({ error: msg(e) }),
    );
    return () => void (live = false);
  }, [machine, project, range, written, round]);

  if (!board) return <div className="dim">Reading…</div>;
  if ("error" in board) return <div className="dim">Could not read Marketing: {board.error}</div>;
  const opened = open ? board.templates.find((t) => t.slug === open) ?? null : null;
  const ask = (text: string) => { askCobraWith(text, props.space); app.show("ops"); };
  const ctx: Ctx = { ...props, board, range, setRange, openTemplate: (slug) => setOpen(slug), ask, refresh: () => setRound((n) => n + 1), openSheet: () => setSheet(true) };

  return (
    <div className="mkt">
      <nav className="mkt-rail" aria-label="Marketing pages">
        <div className="caps mkt-rail-title">Marketing</div>
        {MARKETING_PAGES.map((p) => {
          const count = pageCount(board, p);
          return (
            <button key={p} className={cls("mkt-rail-item", p === page && !opened && "on")} aria-current={p === page ? "page" : undefined} onClick={() => { setPage(p); setOpen(null); }}>
              <span className="grow">{p}</span>{count !== null && <span className="mkt-rail-count">{count}</span>}
            </button>
          );
        })}
        <div className="mkt-rail-foot">
          <div className="caps">Sends from</div>
          <div className="mkt-rail-addr" title={board.sender.address ?? ""}>{board.sender.address ?? "No mailbox yet"}</div>
          <div className="dim">{board.sender.mailbox} · {board.sender.usedToday} of {board.sender.cap} today</div>
        </div>
      </nav>
      <div className="mkt-page">
        {opened ? <TemplatePage ctx={ctx} template={opened} onBack={() => setOpen(null)} />
          : page === "Overview" ? <Overview ctx={ctx} />
          : page === "Templates" ? <Templates ctx={ctx} />
          : page === "Campaigns" ? <Campaigns ctx={ctx} />
          : page === "Audience" ? <Audience ctx={ctx} />
          : <Sequences ctx={ctx} />}
      </div>
      {sheet && <NeedsYouSheet ctx={ctx} onClose={() => { setSheet(false); setRound((n) => n + 1); }} />}
    </div>
  );
}

type Ctx = MarketingProps & {
  board: Board; range: MarketingRange; setRange: (r: MarketingRange) => void;
  openTemplate: (slug: string) => void; ask: (text: string) => void; refresh: () => void; openSheet: () => void;
};

function Head({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="mkt-page-head">
      <div className="grow">
        <h3 className="mkt-page-title">{title}</h3>
        {sub && <div className="dim">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function Card({ title, extra, wide, children }: { title?: string; extra?: React.ReactNode; wide?: boolean; children: React.ReactNode }) {
  return (
    <section className={cls("mkt-card", wide && "wide")} aria-label={title}>
      {(title || extra) && <div className="mkt-card-head"><b className="grow">{title}</b>{extra}</div>}
      {children}
    </section>
  );
}

function StatusChip({ status }: { status: MarketingTemplate["status"] }) {
  return <span className={cls("mkt-chip", `s-${status}`)}>{STATUS_WORDS[status]}</span>;
}

// --- Overview ----------------------------------------------------------------------------

function Overview({ ctx }: { ctx: Ctx }) {
  const { board } = ctx;
  const now = new Date();
  const sentInRange = board.band.health.sent;
  const top = topTemplates(board.templates);
  return (
    <>
      <Head title="Overview" sub={`${board.space.name} · ${sentInRange} sent in ${ctx.range === "7d" ? "7 days" : ctx.range === "30d" ? "30 days" : "90 days"}`}>
        <Ranges ctx={ctx} />
      </Head>
      <Card title="Coming up" wide extra={<span className="dim">Next 7 days</span>}>
        {board.comingUp.length === 0 ? (
          <div className="mkt-empty">
            <span className="grow dim">Nothing sends this week. A routine that sends email shows here with the email it sends.</span>
            <Button small onClick={() => ctx.ask(`[Space: ${board.space.name}] Set up a routine that sends email: `)}>Ask {LEAD_NAME}</Button>
          </div>
        ) : (
          <div className="mkt-coming">
            {board.comingUp.map((c) => (
              <button key={`${c.routine.id}-${c.at}`} className="mkt-coming-card" onClick={() => c.template && ctx.openTemplate(c.template)}>
                <div className="mkt-coming-when">{runWords(c.at, now)}</div>
                <div className="mkt-coming-routine">{c.routine.name}</div>
                <Thumb machine={ctx.machine} project={ctx.project} template={c.template} sha={c.sha} height={110} />
                <div className="mkt-coming-foot"><span className="grow">{c.templateName}{c.version ? ` · v${c.version}` : ""}</span>{c.about !== null && <b>~{c.about}</b>}</div>
              </button>
            ))}
          </div>
        )}
      </Card>
      {(board.needs.toAllow > 0 || board.needs.stopped > 0) && (
        <div className="mkt-needs">
          <span className="mkt-needs-dot" />
          <span className="grow">
            <b>Needs you</b>
            {board.needs.toAllow > 0 && ` · ${board.needs.toAllow} to add to a list`}
            {board.needs.stopped > 0 && ` · ${board.needs.stopped} stopped getting email this month`}
          </span>
          <Button small kind="primary" onClick={ctx.openSheet}>Review</Button>
        </div>
      )}
      <Band ctx={ctx} />
      <div className="mkt-grid">
        <Card title="Templates" extra={<span className="dim">Most sent</span>}>
          {top.length === 0 ? <div className="dim">No email went out in this range.</div> : top.map((t) => (
            <button key={t.slug} className="mkt-row" onClick={() => ctx.openTemplate(t.slug)}>
              <Thumb machine={ctx.machine} project={ctx.project} template={t.slug} sha={t.sha} height={52} />
              <span className="grow mkt-row-text"><b>{t.name}</b><span className="dim">{t.sendsInRange} sent · {rateWords(replyRate(t.sends, t.replies))} replied · last {dayWords(t.lastUsed)}</span></span>
              <StatusChip status={t.status} />
            </button>
          ))}
        </Card>
        <Card title="Replies" extra={<span className="dim">People are on the CRM</span>}>
          {board.replies.length === 0 ? <div className="dim">No replies read yet. With Mail on, {LEAD_NAME} reads the sending mailbox every 30 minutes.</div>
            : board.replies.slice(0, 5).map((r) => (
              <div key={r.id} className="mkt-reply">
                <div className="mkt-reply-top"><b className="grow">{r.name}</b><span className="dim">{dayWords(r.on)}</span></div>
                <div className="dim">{r.summary}</div>
                {r.template && <div className="mkt-reply-tpl">{ctx.board.templates.find((t) => t.slug === r.template)?.name ?? r.template}</div>}
              </div>
            ))}
        </Card>
      </div>
    </>
  );
}

function Ranges({ ctx }: { ctx: Ctx }) {
  return (
    <div className="mkt-seg" role="tablist">
      {MARKETING_RANGES.map((r) => <button key={r} role="tab" aria-selected={r === ctx.range} className={cls(r === ctx.range && "on")} onClick={() => ctx.setRange(r)}>{r.replace("d", " d")}</button>)}
    </div>
  );
}

function Band({ ctx }: { ctx: Ctx }) {
  const { band } = ctx.board;
  const max = Math.max(1, ...band.days.map((d) => d.sent));
  const W = 560;
  const H = 120;
  const step = W / Math.max(1, band.days.length);
  const bw = Math.max(2, Math.min(18, step * 0.7));
  const ranked = band.rates.filter((r) => r.rate !== null);
  const few = band.rates.filter((r) => r.rate === null);
  const topRate = Math.max(1, ...ranked.map((r) => r.rate ?? 0));
  return (
    <Card title="How email is doing" wide>
      <div className="mkt-band">
        <div className="mkt-band-chart">
          <div className="caps">Sent per day <span className="mkt-key"><i className="k-sent" /> sent <i className="k-reply" /> replied</span></div>
          <svg viewBox={`0 0 ${W} ${H + 18}`} className="mkt-bars" role="img" aria-label="Emails sent per day">
            <defs>
              <pattern id="mkt-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2.2" height="5" className="mkt-hatch" /></pattern>
            </defs>
            <line x1="0" x2={W} y1={H} y2={H} className="mkt-axis" />
            {band.days.map((d, i) => {
              const h = (d.sent / max) * (H - 8);
              const rh = (Math.min(d.replies, d.sent || d.replies) / max) * (H - 8);
              const x = i * step + (step - bw) / 2;
              return (
                <g key={d.day}>
                  <title>{`${dayWords(d.day)}: ${d.sent} sent, ${d.replies} replied`}</title>
                  {d.sent > 0 && <rect x={x} y={H - h} width={bw} height={h} rx="2" className="mkt-bar" />}
                  {d.replies > 0 && <rect x={x} y={H - rh} width={bw} height={rh} rx="2" fill="url(#mkt-hatch)" className="mkt-bar-reply" />}
                </g>
              );
            })}
            <text x="0" y={H + 14} className="mkt-axis-text">{dayWords(band.days[0]?.day ?? null)}</text>
            <text x={W} y={H + 14} textAnchor="end" className="mkt-axis-text">{dayWords(band.days.at(-1)?.day ?? null)}</text>
          </svg>
        </div>
        <div className="mkt-band-rates">
          <div className="caps">Reply rate by template</div>
          {ranked.length === 0 && few.length === 0 && <div className="dim">Nothing sent in this range.</div>}
          {ranked.map((r) => (
            <button key={r.template} className="mkt-rate" onClick={() => ctx.openTemplate(r.template)}>
              <span className="mkt-rate-name">{r.name}</span>
              <span className="mkt-rate-bar"><i style={{ width: `${Math.max(2, ((r.rate ?? 0) / topRate) * 100)}%` }} /></span>
              <b>{r.rate}%</b>
              <span className="dim mkt-rate-n">{r.replies}/{r.sends}</span>
            </button>
          ))}
          {few.length > 0 && <div className="dim mkt-few">Too few sends to tell ({"<"}20): {few.map((r) => r.name).join(", ")}</div>}
        </div>
        <div className="mkt-band-health">
          <div className="caps">List health</div>
          <div className="mkt-health">
            <div><b>{band.health.clicks}</b><span className="dim">clicks</span></div>
            <div><b>{band.health.unsubscribes}</b><span className="dim">unsubscribed</span></div>
            <div><b>{band.health.bounces}</b><span className="dim">bounced</span></div>
          </div>
          <div className="dim">Test sends to you are never counted.</div>
        </div>
      </div>
    </Card>
  );
}

// --- Needs you ---------------------------------------------------------------------------

function NeedsYouSheet({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const [rows, setRows] = useState<{ allow: ViewRow[]; stopped: ViewRow[] } | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    void Promise.all([
      api.view(ctx.machine, ctx.project, "email-to-allow").then((r) => parseViewResult(r).rows ?? [], () => []),
      api.view(ctx.machine, ctx.project, "email-stopped").then((r) => parseViewResult(r).rows ?? [], () => []),
    ]).then(([allow, stopped]) => live && setRows({ allow, stopped }));
    return () => void (live = false);
  }, [ctx.machine, ctx.project, round, ctx.written]);
  const run = (mutation: string, label: string, id: unknown, confirm = false) => {
    ctx.act({ mutation, label, on: "row", fixed: { id: "id" }, ...(confirm ? { confirm: true } : {}) }, String(id));
    setTimeout(() => setRound((n) => n + 1), 600);
  };
  return (
    <Dialog title="Needs you" onClose={onClose} buttons={<Button onClick={onClose}>Done</Button>}>
      {!rows ? <div className="dim">Reading…</div> : (
        <div className="mkt-sheet">
          <div className="mkt-sheet-head"><b className="grow">To add to a list · {rows.allow.length}</b>
            {rows.allow.length > 1 && <Button small kind="primary" onClick={() => rows.allow.forEach((r) => run("topic_allow", "Allow", r.id))}>Allow all</Button>}
          </div>
          {rows.allow.length === 0 && <div className="dim">Nobody waits.</div>}
          {rows.allow.map((r) => (
            <div key={String(r.id)} className="mkt-sheet-row">
              <span className="grow"><b>{String(r.title ?? "")}</b><span className="dim"> · {String(r.subtitle ?? "")}</span></span>
              <Button small onClick={() => run("topic_decline", "Drop", r.id)}>Drop</Button>
              <Button small kind="primary" onClick={() => run("topic_allow", "Allow", r.id)}>Allow</Button>
            </div>
          ))}
          <div className="mkt-sheet-head"><b className="grow">Left off every send · {rows.stopped.length}</b></div>
          {rows.stopped.length === 0 && <div className="dim">Nobody stopped.</div>}
          {rows.stopped.map((r) => (
            <div key={String(r.id)} className="mkt-sheet-row">
              <span className="grow"><b>{String(r.title ?? "")}</b><span className="dim"> · {String(r.badge ?? "")} · {String(r.subtitle ?? "")}</span></span>
              <Button small onClick={() => run("email_status_clear", "Let them back", r.id, true)}>Let them back</Button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// --- Templates ---------------------------------------------------------------------------

const FILTERS = ["All", "Sending", "Ready", "Idle"] as const;

function Templates({ ctx }: { ctx: Ctx }) {
  const app = useApp();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [shelfOpen, setShelfOpen] = useState(false);
  const { shown, shelf } = useMemo(() => gallery(ctx.board.templates), [ctx.board.templates]);
  const list = filter === "All" ? shown : shown.filter((t) => STATUS_WORDS[t.status] === filter);
  const archive = async (t: MarketingTemplate) => {
    try {
      const done = (await api.marketingArchive(ctx.machine, ctx.project, t.slug)) as { summary?: string } | null;
      app.toast(done?.summary ?? `Archived ${t.name}`);
      ctx.refresh();
    } catch (e) {
      app.toast(`Not archived: ${msg(e)}`);
    }
  };
  return (
    <>
      <Head title="Templates" sub={`${shown.length} in use or ready · drawn as they send, with sample words`}>
        <div className="mkt-seg">
          {FILTERS.map((f) => <button key={f} className={cls(f === filter && "on")} onClick={() => setFilter(f)}>{f}</button>)}
        </div>
      </Head>
      <div className="mkt-gallery">
        {list.map((t) => <TemplateCard key={t.slug} ctx={ctx} t={t} />)}
        <button className="mkt-new" onClick={() => ctx.ask(`[Space: ${ctx.board.space.name}] Make a new email template: `)}>
          <span className="mkt-new-plus">+</span><b>New template</b><span className="dim">Ask {LEAD_NAME}: the Designer draws it, you allow it</span>
        </button>
      </div>
      {shelf.length > 0 && (
        <section className="mkt-shelf">
          <button className="mkt-shelf-head" onClick={() => setShelfOpen((o) => !o)} aria-expanded={shelfOpen}>
            <span>{shelfOpen ? "▾" : "▸"}</span><b className="grow">Drafts & tests · {shelf.length}</b><span className="dim">Left out of every number</span>
          </button>
          {shelfOpen && shelf.map((t) => (
            <div key={t.slug} className="mkt-shelf-row">
              <span className="grow"><b>{t.name}</b><span className="dim"> · {t.slug} · {t.shelf}{t.tests ? ` · ${t.tests} test ${t.tests === 1 ? "send" : "sends"}` : ""}</span></span>
              {t.version !== null && <Button small kind="flat" onClick={() => ctx.openTemplate(t.slug)}>Open</Button>}
              <Button small onClick={() => void archive(t)}>Archive</Button>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function TemplateCard({ ctx, t }: { ctx: Ctx; t: MarketingTemplate }) {
  return (
    <button className="mkt-tile" onClick={() => ctx.openTemplate(t.slug)}>
      <Thumb machine={ctx.machine} project={ctx.project} template={t.slug} sha={t.sha} height={180} />
      <div className="mkt-tile-body">
        <div className="mkt-tile-top"><b className="grow">{t.name}</b><StatusChip status={t.status} /></div>
        <div className="dim">{kindWords(t.kind)}{t.version !== null ? ` · v${t.version}` : ""}</div>
        <div className="mkt-tile-nums"><span><b>{t.sends}</b> sent</span><span><b>{rateWords(replyRate(t.sends, t.replies))}</b> replied</span><span className="dim">last {dayWords(t.lastUsed)}</span></div>
        {(t.routines.length > 0 || t.campaign) && (
          <div className="mkt-tags">
            {t.routines.map((r) => <span key={r.id} className={cls("mkt-tag", !r.enabled && "off")}>⟳ {r.name}</span>)}
            {t.campaign && <span className="mkt-tag camp">{t.campaign.name}</span>}
          </div>
        )}
      </div>
    </button>
  );
}

function TemplatePage({ ctx, template: t, onBack }: { ctx: Ctx; template: MarketingTemplate; onBack: () => void }) {
  const app = useApp();
  const preview = usePreview(ctx.machine, ctx.project, t.slug, t.sha);
  const [width, setWidth] = useState<"desk" | "phone">("desk");
  const [dark, setDark] = useState(false);
  const [sending, setSending] = useState(false);
  const test = async () => {
    setSending(true);
    try {
      const done = (await api.marketingTest(ctx.machine, ctx.project, t.slug)) as { summary?: string } | null;
      app.toast(done?.summary ?? "A test is on its way to you");
    } catch (e) {
      app.toast(`No test sent: ${msg(e)}`);
    } finally {
      setSending(false);
    }
  };
  const rate = replyRate(t.sends, t.replies);
  return (
    <>
      <button className="dash-back mkt-back" onClick={onBack}>‹ Templates</button>
      <Head title={t.name} sub={`${kindWords(t.kind)}${t.version !== null ? ` · v${t.version}` : " · not allowed yet"} · ${t.slug}`}>
        <StatusChip status={t.status} />
        <Button onClick={() => ctx.ask(askChange(t))}>Ask {LEAD_NAME} to change it</Button>
        <Button kind="primary" disabled={sending || t.version === null} onClick={() => void test()}>{sending ? "Sending…" : "Send me a test"}</Button>
      </Head>
      <div className="mkt-detail">
        <Card>
          <div className="mkt-preview-bar">
            <div className="grow mkt-preview-subject">
              <div><span className="dim">Subject </span><b>{preview && !("error" in preview) ? preview.subject : "…"}</b></div>
              <div className="dim">From {ctx.board.sender.address ?? "the Space's mailbox"}</div>
            </div>
            <div className="mkt-seg">
              <button className={cls(width === "desk" && "on")} onClick={() => setWidth("desk")}>Desk</button>
              <button className={cls(width === "phone" && "on")} onClick={() => setWidth("phone")}>Phone</button>
            </div>
            <div className="mkt-seg">
              <button className={cls(!dark && "on")} onClick={() => setDark(false)}>Light</button>
              <button className={cls(dark && "on")} onClick={() => setDark(true)}>Dark</button>
            </div>
          </div>
          <div className={cls("mkt-preview", width, dark && "dark")}>
            {!preview ? <div className="dim">Drawing…</div>
              : "error" in preview ? <div className="dim">Could not draw it: {preview.error}</div>
              : <PreviewFrame className="mkt-preview-frame" title={t.name} html={lightOnly(preview.html)} />}
          </div>
          <div className="dim">Drawn with sample words; each send fills in its person.</div>
        </Card>
        <div className="mkt-side">
          <Card title="How it does">
            <div className="mkt-nums">
              <div><b>{t.sends}</b><span className="dim">sent</span></div>
              <div><b>{t.replies}</b><span className="dim">replied</span></div>
              <div><b>{rate === null ? "—" : `${rate}%`}</b><span className="dim">{rate === null ? "too few to tell" : "reply rate"}</span></div>
              <div><b>{t.clicks}</b><span className="dim">clicks</span></div>
            </div>
            <div className="dim">Last sent {dayWords(t.lastUsed)}{t.tests ? ` · ${t.tests} test ${t.tests === 1 ? "send" : "sends"} to you not counted` : ""}</div>
          </Card>
          <Card title="Routines">
            <div className="caps">Used by</div>
            {t.routines.length === 0 ? <div className="dim">No routine names it.</div> : t.routines.map((r) => (
              <div key={r.id} className="mkt-line"><span className="grow">⟳ {r.name}</span><span className="dim">{r.enabled ? "On" : "Paused"}</span></div>
            ))}
            <div className="caps">Actually sent by</div>
            {t.senders.length === 0 ? <div className="dim">Not sent yet.</div> : t.senders.map((s) => (
              <div key={s.routine ?? "hand"} className="mkt-line"><span className="grow">{s.name}</span><span className="dim">{s.count} · last {dayWords(s.last)}</span></div>
            ))}
            {t.mismatch.length > 0 && (
              <div className="mkt-flag">
                <b>{t.mismatch.join(", ")}</b> sent this email but does not list it.
                <Button small kind="flat" onClick={() => ctx.ask(`[Template: ${t.name} (${t.slug})] ${t.mismatch.join(", ")} sent this template but does not list it in its templates. Fix the routine: `)}>Ask {LEAD_NAME}</Button>
              </div>
            )}
          </Card>
          <Card title="Versions">
            {t.versions.length === 0 ? <div className="dim">A draft, never allowed.</div> : [...t.versions].reverse().map((v) => (
              <div key={v.version} className="mkt-line"><span className="grow">v{v.version}{v.version === t.version ? " · sending" : ""}</span><span className="dim">allowed {dayWords(v.acceptedAt)}</span></div>
            ))}
            {t.campaign && <div className="mkt-line"><span className="grow">Campaign</span><span className="mkt-tag camp">{t.campaign.name}</span></div>}
          </Card>
        </div>
      </div>
    </>
  );
}

// --- Campaigns, Audience, Sequences ------------------------------------------------------

function Campaigns({ ctx }: { ctx: Ctx }) {
  const [showArchived, setShowArchived] = useState(false);
  const live = ctx.board.campaigns.filter((c) => c.status !== "archived");
  const archived = ctx.board.campaigns.filter((c) => c.status === "archived");
  return (
    <>
      <Head title="Campaigns" sub="A group of sends with a goal. Status comes from its sends.">
        <Button onClick={() => ctx.ask(`[Space: ${ctx.board.space.name}] Plan a new email campaign: `)}>Plan a campaign</Button>
      </Head>
      {live.length === 0 && <div className="mkt-empty"><span className="dim grow">No campaigns yet. Ask {LEAD_NAME} to plan one; the sends it proposes link to it.</span></div>}
      <div className="mkt-grid">
        {live.map((c) => (
          <Card key={c.id} title={c.name} extra={<span className={cls("mkt-chip", `c-${c.status}`)}>{CAMPAIGN_WORDS[c.status]}</span>}>
            {c.goal && <div>{c.goal}</div>}
            <div className="dim">{c.startsOn ? `From ${dayWords(c.startsOn)}` : "No start date"}{c.endsOn ? ` to ${dayWords(c.endsOn)}` : ""}</div>
            <div className="mkt-nums three">
              <div><b>{c.sends}</b><span className="dim">sent</span></div>
              <div><b>{c.replies}</b><span className="dim">replied</span></div>
              <div><b>{c.clicks}</b><span className="dim">clicks</span></div>
            </div>
            {(c.templates.length > 0 || c.routines.length > 0) && (
              <div className="mkt-tags">
                {c.templates.map((t) => <span key={t} className="mkt-tag">{t}</span>)}
                {c.routines.map((r) => <span key={r} className="mkt-tag">⟳ {r}</span>)}
              </div>
            )}
            {c.sends === 0 && c.status === "planned" && <div className="dim">No send is linked yet. Sends count here when {LEAD_NAME} proposes them for this campaign.</div>}
            {c.audience && <div className="dim mkt-small">Audience: {c.audience}</div>}
          </Card>
        ))}
      </div>
      {archived.length > 0 && (
        <section className="mkt-shelf">
          <button className="mkt-shelf-head" onClick={() => setShowArchived((o) => !o)} aria-expanded={showArchived}>
            <span>{showArchived ? "▾" : "▸"}</span><b className="grow">Archived · {archived.length}</b>
          </button>
          {showArchived && archived.map((c) => <div key={c.id} className="mkt-shelf-row"><span className="grow"><b>{c.name}</b>{c.goal ? <span className="dim"> · {c.goal}</span> : null}</span></div>)}
        </section>
      )}
    </>
  );
}

function Audience({ ctx }: { ctx: Ctx }) {
  const a = ctx.board.audience;
  return (
    <>
      <Head title="Audience" sub="Who may get newsletters: email lists and saved segments. People live on the CRM." />
      <div className="mkt-tiles">
        <div className="mkt-stat"><b>{a.people}</b><span className="dim">people</span></div>
        <div className="mkt-stat"><b>{a.onLists}</b><span className="dim">on a list</span></div>
        <div className="mkt-stat"><b>{a.stopped}</b><span className="dim">stopped (unsubscribed or bounced)</span></div>
      </div>
      <div className="mkt-grid">
        <Card title="Lists">
          {a.lists.length === 0 ? (
            <div className="mkt-empty"><span className="dim grow">No email lists yet. People join one on the website's tick box or when you add them.</span>
              <Button small onClick={() => ctx.ask(`[Space: ${ctx.board.space.name}] Make an email list: `)}>Ask {LEAD_NAME}</Button></div>
          ) : a.lists.map((l) => (
            <div key={l.id} className="mkt-list">
              <div className="mkt-line"><b className="grow">{l.name}</b><b>{l.members}</b></div>
              <div className="dim">{l.describe ?? ""}{l.describe ? " · " : ""}+{l.joined30} joined, −{l.left30} left in 30 days</div>
              {l.sources.length > 0 && <div className="mkt-tags">{l.sources.map((s) => <span key={s.source} className="mkt-tag">{s.source} {s.count}</span>)}</div>}
            </div>
          ))}
        </Card>
        <Card title="Segments">
          {a.segments.length === 0 ? <div className="dim">No saved segments. {LEAD_NAME} saves one when a campaign needs part of a list.</div>
            : a.segments.map((s) => (
              <div key={s.id} className="mkt-line"><span className="grow"><b>{s.name}</b><span className="dim"> · {s.words}</span></span><b>{s.count ?? "—"}</b></div>
            ))}
        </Card>
      </div>
    </>
  );
}

function Sequences({ ctx }: { ctx: Ctx }) {
  const seqs = ctx.board.sequences;
  const now = new Date();
  return (
    <>
      <Head title="Sequences" sub="A few emails to one person in turn, started by a form, a stage or a date." />
      {seqs.length === 0 && (
        <div className="mkt-empty big">
          <span className="grow"><b>No sequences yet</b><br /><span className="dim">A welcome series after the website's form, a check-in a week after someone becomes a customer: {LEAD_NAME} drafts the steps from your templates and you allow it once.</span></span>
          <Button kind="primary" onClick={() => ctx.ask(`[Space: ${ctx.board.space.name}] Set up an email sequence: `)}>Ask {LEAD_NAME}</Button>
        </div>
      )}
      {seqs.map((q) => (
        <Card key={q.slug} wide title={q.name} extra={<>
          <span className={cls("mkt-chip", q.state === "active" ? "s-sending" : "s-idle")}>{q.state === "active" ? "Running" : "Paused"}</span>
          {q.state === "active"
            ? <Button small onClick={() => ctx.act({ mutation: "sequence_pause", label: "Pause", on: "row", fixed: { id: "id" } }, String(q.id))}>Pause</Button>
            : <Button small onClick={() => ctx.act({ mutation: "sequence_resume", label: "Resume", on: "row", fixed: { id: "id" } }, String(q.id))}>Resume</Button>}
        </>}>
          <div className="dim">{q.trigger} · {q.active} in it now{q.nextAt ? ` · next ${runWords(q.nextAt, now)}` : ""}</div>
          <div className="mkt-steps">
            {q.steps.map((st, i) => (
              <div key={`${st.template}-${i}`} className="mkt-step">
                <div className="mkt-step-when">{st.after}</div>
                <button className="mkt-step-card" onClick={() => ctx.openTemplate(st.template)}>
                  <Thumb machine={ctx.machine} project={ctx.project} template={st.template} sha={ctx.board.templates.find((t) => t.slug === st.template)?.sha ?? null} height={90} />
                  <b>{st.name}</b>
                  <span className="dim">{st.sent} sent · {st.replied} replied · {st.clicked} clicked</span>
                </button>
                {i < q.steps.length - 1 && <span className="mkt-step-arrow">→</span>}
              </div>
            ))}
          </div>
        </Card>
      ))}
    </>
  );
}
