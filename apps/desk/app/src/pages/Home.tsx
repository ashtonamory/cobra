/**
 * Home — Cobra first, given a desktop's width: her conversation on the left
 * (components/CobraChat.tsx: the Lead whose computer answers, else one that
 * waits on you, else the freshest; lib/home.ts), and down the right today's
 * morning brief with a ✕ (kept dismissed by its time, so tomorrow's comes
 * back), what needs you as hers to tell ("These 3 need you.", less her own
 * question, which her pane's dock answers), Landed, what the judge refused
 * your Workers today, Today, the budget, two weeks of throughput and Done
 * today. A narrow window stacks them, Cobra on top. The phone's Home
 * (apps/mobile/src/components/HomeFeed.tsx) is the same page in one column:
 * change both together.
 *
 * What needs you keeps its answers in view: Allow and Deny on an approval and
 * on a Claude's permission prompt. A Foreman's action (an email, files for
 * your Drive, a note) shows exactly what Allow sends (components/ActionCard.tsx).
 * Landed lists what ran on trust today, with no card, and the routine that
 * runs next (lib/trust.ts). What Cobra did lists what Instinct decided
 * without you this week, each with its Undo, and Pause (lib/decided.ts). The work map, the pull request list and "Tell the
 * Lead" left in October 2026: a Foreman asks for a merge as an approval, and
 * each project's PRs are on its page.
 */
import { MoneyTodayCard } from "./AllMoney.tsx";
import { useEffect, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp, useFleet } from "../app/context.ts";
import { BoardRow, Button, RequestView, cls } from "../components/ui.tsx";
import { ActionCard } from "../components/ActionCard.tsx";
import { CobraChat } from "../components/CobraChat.tsx";
import { usePlaces } from "../components/usePlaces.ts";
import { useShowCrew, whoWords } from "../lib/crewVisibility.ts";
import { Budget, Throughput, Timeline } from "../components/Charts.tsx";
import * as api from "../lib/api.ts";
import { actionView } from "../lib/approvalAction.ts";
import { routineApprovalView } from "../lib/routines.ts";
import * as trust from "../lib/trust.ts";
import { specialistText } from "../lib/specialistCard.ts";
import { trustApprovalView } from "../lib/trust.ts";
import * as charts from "../lib/charts.ts";
import * as config from "../lib/config.ts";
import * as home from "../lib/home.ts";
import { isDict, nowS, type Dict, type Json } from "../lib/json.ts";
import { allowOffer } from "../lib/allowScope.ts";
import { siteDomains, sitePreview, sitePreviewLabel, siteShots, siteSource } from "../lib/site.ts";
import { emailPreviewLabel } from "../lib/email.ts";
import { EmailPreviewDialog } from "../components/EmailPreview.tsx";
import { BoardPreview } from "../components/CobraBoard.tsx";
import { ExpensesPreview } from "../components/ExpensesPreview.tsx";
import { BillsPreview } from "../components/BillsPreview.tsx";
import type { ApprovalBills } from "../../../../../packages/contracts/src/approvals.ts";
import { ScopeChoices } from "../components/ScopeChoices.tsx";
import { SiteShots } from "../components/SiteShots.tsx";
import * as model from "../lib/model.ts";
import * as ops from "../lib/ops.ts";
import * as permissions from "../lib/permissions.ts";
import * as plans from "../lib/plans.ts";
import * as decided from "../lib/decided.ts";
import { WINDOW_MS } from "../lib/confirm.ts";
import "../styles/home.css";
import { LEAD_NAME } from "../lib/appName.ts";

/** The desk's narrow breakpoint: narrower than this is one column, Cobra on top. */
const NARROW = 900;
/** Where the brief's dismissal is kept: its `at`, on this computer only. */
const DISMISSED_KEY = "home.morningDismissed";

function useCompact(): boolean {
  const [compact, setCompact] = useState(window.innerWidth < NARROW);
  useEffect(() => {
    const r = () => setCompact(window.innerWidth < NARROW);
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, []);
  return compact;
}

/** What the judge refused your Workers in the last day (GET /policy/refused).
 * Nothing waits on you there, so it is read on its own minute, not with the fleet's poll. */
function useRefused(): Dict[] {
  const [rows, setRows] = useState<Dict[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const lists: Array<[string, Dict[]]> = [];
      for (const m of config.MACHINES) {
        try {
          lists.push([config.label(m.machine), ((await api.policyRefused(m.machine)) || {}).refused || []]);
        } catch {
          // away, or an agent from before the judge
        }
      }
      if (alive) setRows(permissions.refusedRows(lists));
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return rows;
}

/** Landed and Next: what ran on trust today (GET /trust) and the soonest routine (GET /routines) on every
 * computer. Nothing waits on you there, so it is read on its own minute, not with the fleet's poll. */
function useLanded(): { landed: Array<{ machine: string; approval: Dict }>; next: ReturnType<typeof trust.nextRoutine> } {
  const [state, setState] = useState<{ landed: Array<{ machine: string; approval: Dict }>; next: ReturnType<typeof trust.nextRoutine> }>({ landed: [], next: null });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const trusts: Array<[string, Dict]> = [];
      const routs: Array<[string, Dict]> = [];
      for (const m of config.MACHINES) {
        // Away, or an agent from before trust or routines: that computer is left out.
        try {
          trusts.push([m.machine, (await api.trust(m.machine)) || {}]);
        } catch { /* left out */ }
        try {
          routs.push([m.machine, (await api.routines(m.machine)) || {}]);
        } catch { /* left out */ }
      }
      if (alive) setState({ landed: trust.landedToday(trusts), next: trust.nextRoutine(routs) });
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return state;
}

/** What Cobra did (GET /decided on every computer), read on its own minute; whether Instinct is set anywhere
 * is read from the policy only at start and after a Pause, never on the minute. */
function useDecided(): { rows: decided.DecidedRow[]; caps: string | null; instinct: boolean; reload: (withPolicy?: boolean) => void } {
  const [state, setState] = useState<{ rows: decided.DecidedRow[]; caps: string | null }>({ rows: [], caps: null });
  const [instinct, setInstinct] = useState(false);
  const [tick, setTick] = useState(0);
  const [policyTick, setPolicyTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const lists: Array<[string, Dict, Json]> = [];
      for (const m of config.MACHINES) {
        try {
          const reply = await api.decided(m.machine);
          if (!isDict(reply)) continue;
          // A research receipt's reads, only where there is one; an agent before runs answers 404 and it stays plain.
          const hasRun = Array.isArray(reply.decided) && reply.decided.some((entry) => isDict(entry) && typeof entry.run === "string");
          const runs = hasRun ? await api.webRuns(m.machine).catch(() => null) : null;
          lists.push([m.machine, reply, runs]);
        } catch {
          // away, or an agent from before What Cobra did
        }
      }
      if (alive) setState({ rows: decided.decidedRows(lists), caps: decided.capsLine(lists.map(([, list]) => list)) });
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tick]);
  useEffect(() => {
    let alive = true;
    void decided.readInstinct().then((on) => alive && setInstinct(on), () => undefined);
    return () => {
      alive = false;
    };
  }, [policyTick]);
  const reload = (withPolicy = false) => {
    setTick((n) => n + 1);
    if (withPolicy) setPolicyTick((n) => n + 1);
  };
  return { ...state, instinct, reload };
}

/** Today's brief from the computer that sends it (GET /morning on every computer), read on its own ten minutes. */
function useMorning(): Dict | null {
  const [brief, setBrief] = useState<Dict | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const reads: Array<[string, Dict]> = [];
      for (const m of config.MACHINES) {
        try {
          reads.push([m.machine, ((await api.morning(m.machine)) || {}) as Dict]);
        } catch {
          // away, or an agent from before the brief
        }
      }
      if (alive) setBrief(home.todaysBrief(reads, Date.now())?.brief ?? null);
    };
    void load();
    const timer = setInterval(load, 10 * 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return brief;
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** A section as a rounded card, as on the phone: its name, its count or a note, ✕ when it can be dismissed. */
/** What Cobra did: each row with its Undo (a second click within the confirm window, its question shown
 * meanwhile), at most DECIDED_SHOWN of them, the caps, and Pause when Instinct is set anywhere. */
/** A research receipt's run (lib/decided.ts researchOf): how far it got, and its reads one click away. */
function ResearchReads({ research, open, toggle }: { research: decided.Research; open: boolean; toggle: () => void }) {
  const tone = { ok: "s-ink", dim: "s-muted", warn: "s-signal" } as const;
  return (
    // A click here is the reads', not the row's (which opens the project).
    <span className="col" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
      <span className="dim">{research.line}</span>
      {research.reads.length > 0 && (
        <Button small kind="flat" title={open ? "Hide its reads" : "See every search and page it read"} onClick={toggle}>
          {open ? "Hide reads" : `See ${research.reads.length === 1 ? "1 read" : `${research.reads.length} reads`}`}
        </Button>
      )}
      {open && research.reads.map((read, at) => (
        <span key={at} className="dim">
          <span className={cls("status", tone[read.tone])}>{read.word}</span> {read.subject}{read.tone === "ok" ? "" : ` · ${read.why}`}
        </span>
      ))}
    </span>
  );
}

function DecidedCard({ state }: { state: ReturnType<typeof useDecided> }) {
  const app = useApp();
  const [armed, setArmed] = useState<string | null>(null);
  const [openReads, setOpenReads] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  const shown = state.rows.slice(0, decided.DECIDED_SHOWN);
  const undo = (row: decided.DecidedRow) => {
    const key = `${row.machine}:${row.id}`;
    if (armed !== key) return setArmed(key);
    setArmed(null);
    setBusy(key);
    api.decidedUndo(row.machine, row.id)
      .then((reply) => app.toast(`Undone · ${row.title}${isDict(reply) && isDict(reply.decided) && reply.decided.undoNote ? `: ${String(reply.decided.undoNote)}` : ""}`))
      .catch((e) => app.toast(`Couldn't undo ${row.title}: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        setBusy(null);
        state.reload();
      });
  };
  const pause = () => {
    setBusy("pause");
    decided.pauseFleet()
      .then((words) => app.toast(words))
      .catch((e) => app.toast(`Couldn't pause Instinct: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        setBusy(null);
        state.reload(true);
      });
  };
  return (
    <HomeCard title={decided.DECIDED_TITLE} count={state.rows.length} note="this week">
      <div className="board">
        {shown.map((row) => {
          const key = `${row.machine}:${row.id}`;
          return (
            <BoardRow key={key} time={row.time} title={row.title} word={row.undone ? "UNDONE" : "DONE"} tone={row.undone ? "dim" : "ink"}
              machine={row.machine} keepActions
              detail={[decided.decidedDetail(row), config.label(row.machine)].filter((t) => t).join(" · ")}
              extra={armed === key ? <span className="dim">{decided.undoQuestion(row)}</span> : row.research ? <ResearchReads research={row.research} open={openReads === key} toggle={() => setOpenReads(openReads === key ? null : key)} /> : undefined}
              tooltip={row.noUndo ? `No Undo: ${row.noUndo}` : row.body || undefined}
              onClick={row.project ? () => app.openProject(row.machine, row.project!) : undefined}
              actions={row.undoable ? (
                <Button small kind={armed === key ? "primary" : "flat"} disabled={busy !== null} title={row.undoLabel ?? "Undo"}
                  onClick={() => undo(row)}>
                  {armed === key ? `Press again: ${row.undoLabel}` : "Undo"}
                </Button>
              ) : undefined} />
          );
        })}
        {!state.rows.length && <span className="dim">{decided.DECIDED_EMPTY}</span>}
      </div>
      {state.rows.length > shown.length && <span className="dim">+{state.rows.length - shown.length} more this week</span>}
      {state.caps && <span className="dim">{state.caps}</span>}
      {state.instinct && (
        <div className="row">
          <Button small kind="flat" disabled={busy !== null} title={`Turns Instinct to Balanced, so ${LEAD_NAME} asks you again.`}
            onClick={pause}>{decided.PAUSE_LABEL}</Button>
          <span className="dim">{LEAD_NAME} asks you again</span>
        </div>
      )}
    </HomeCard>
  );
}

function HomeCard({ title, count, note, lit, onDismiss, children }: {
  title: string; count?: number; note?: string; lit?: boolean; onDismiss?: () => void; children: ReactNode;
}) {
  return (
    <section className={cls("home-card", lit && "lit")}>
      <div className="home-card-head">
        <span className="home-card-title">{title}</span>
        {count ? <span className="home-card-count">{count}</span> : null}
        <span className="spacer" />
        {note && <span className="home-card-count">{note}</span>}
        {onDismiss && <button className="home-dismiss" title={`Dismiss ${title}`} aria-label={`Dismiss ${title}`} onClick={onDismiss}>✕</button>}
      </div>
      {children}
    </section>
  );
}

export function HomePage() {
  const app = useApp();
  const f = useFleet();
  const compact = useCompact();
  const refused = useRefused();
  const landed = useLanded();
  const decidedState = useDecided();
  const show = useShowCrew();
  const places = usePlaces(f.rows, f.orch);
  const brief = useMorning();
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);

  const now = nowS();
  const away = new Set(f.unreachable);
  const lead = home.homeLead(f.rows, away);

  // Today: one lane per project, its agents folded in (the phone's opsToday.ts projectLanes). With the crew
  // hidden (lib/crewVisibility.ts) only a Space's projects, each named by its Space and skill.
  const [allLanes, allMore] = ops.projectLanes(Object.entries(f.orchHistory), show ? 8 : 1000, now);
  const spaceLanes = show ? allLanes : allLanes.filter((lane) => places.of(String(lane.machine), String(lane.id)));
  const lanes = spaceLanes.slice(0, 8);
  const more = show ? allMore : spaceLanes.length - lanes.length;
  const baseName = (lane: Dict): string => {
    if (!show) return whoWords(places.of(String(lane.machine), String(lane.id)));
    const row = f.rows.find((r) => r.machine === lane.machine && r.id === lane.id);
    return row ? row.name : String(lane.label);
  };
  const laneNames = lanes.map(baseName);
  const days = ops.mergeDays(Object.values(f.orchHistory));

  // What needs you names the Space and skill, or Cobra, never a Foreman or Worker; a code project's git is not yours.
  const blockers = ops.blockers(f.approvals, f.rows, f.alerts, now);
  const alerts = home.cobraAlerts(show ? blockers : blockers
    .filter((b) => b.kind !== "diverged" || (b.row && places.ofRow(b.row)))
    .map((b) => ((b.kind === "claude" || b.kind === "diverged") && b.row ? { ...b, title: whoWords(places.ofRow(b.row)) } : b)), lead);
  const words = home.alertWords(alerts.length);
  const gauges = ops.mergeBudget(Object.values(f.orch));
  const [allDone, allDoneMore, doneCounts] = ops.doneToday(Object.entries(f.orchHistory), now, show ? 8 : 1000, Object.values(f.prs));
  const spaceDone = show ? allDone : allDone.filter((d) => d.project && places.of(d.machine, d.project));
  const done = spaceDone.slice(0, 8);
  const doneMore = show ? allDoneMore : spaceDone.length - done.length;

  const dismiss = () => {
    if (!brief) return;
    const at = String(brief.at ?? "");
    setDismissed(at);
    try {
      localStorage.setItem(DISMISSED_KEY, at);
    } catch {
      // kept for this run only
    }
  };

  const side = (
    <div className="home-side">
      {brief && !home.briefDismissed(brief, dismissed) && (
        <HomeCard title="Good morning" onDismiss={dismiss}>
          <div className="home-brief selectable">{String(brief.text ?? "")}</div>
        </HomeCard>
      )}
      {words && (
        <HomeCard title={words} lit>
          <div className="board">{alerts.map((b) => <BlockerRow key={b.key} b={b} />)}</div>
        </HomeCard>
      )}
      {(landed.landed.length > 0 || landed.next) && (
        <HomeCard title="Landed" count={landed.landed.length}>
          <div className="board">
            {landed.landed.map(({ machine, approval }) => {
              const v = trust.receiptView(approval);
              return (
                <BoardRow key={`${machine}:${v.id}`} time={v.time} title={v.title} word={v.word} tone={v.tone} machine={machine}
                  detail={v.detail} onClick={v.project ? () => app.openProject(machine, v.project) : undefined} />
              );
            })}
            {!landed.landed.length && <span className="dim">Nothing ran on trust yet today.</span>}
          </div>
          {landed.next && (
            <span className="dim clickable" onClick={() => app.openProject(landed.next!.machine, String(landed.next!.routine.project))}>
              {landed.next.line}
            </span>
          )}
        </HomeCard>
      )}
      {(decidedState.rows.length > 0 || decidedState.instinct) && <DecidedCard state={decidedState} />}
      {refused.length > 0 && (
        <HomeCard title="Refused by the judge" count={refused.length}>
          <div className="board">
            {refused.map((row, i) => (
              <BoardRow key={`${row.computer}/${row.at}/${i}`} time={hhmm(Number(row.at))} title={permissions.refusedLine(row)}
                word="REFUSED" tone="muted" detail={`${row.computer} · ${row.subject ?? ""}`} />
            ))}
          </div>
        </HomeCard>
      )}
      <MoneyTodayCard frame={(body) => <HomeCard title="Money">{body}</HomeCard>} />
      <HomeCard title="Today">
        <Timeline lanes={lanes} more={more} now={now}
          onOpen={(lane) => app.openProject(lane.machine, lane.id)}
          name={(lane) => charts.laneName(baseName(lane), lane.machine, laneNames)} />
      </HomeCard>
      <HomeCard title="Budget"><Budget gauges={gauges} now={now} /></HomeCard>
      <HomeCard title="Two weeks"><Throughput days={days} /></HomeCard>
      <HomeCard title="Done today" note={(show && doneCounts) || undefined}>
        <div className="board">
          {done.map((d) => (
            <BoardRow key={d.key} time={d.time} title={d.title} word={d.word} tone={d.tone} machine={d.machine}
              detail={d.detail} tooltip={[d.title, d.url].filter((t) => t).join("\n")}
              onClick={d.url ? () => void openUrl(d.url!).catch((e) => app.toast(String(e)))
                : d.project ? () => app.openProject(d.machine, d.project!) : undefined} />
          ))}
          {!done.length && <span className="dim">{f.loaded ? "Nothing merged or opened yet today." : "Asking the fleet…"}</span>}
        </div>
        {doneMore > 0 && <span className="dim">+{doneMore} more today</span>}
      </HomeCard>
      {f.unreachable.length > 0 && <span className="dim">Not answering: {f.unreachable.join(", ")}</span>}
    </div>
  );

  return (
    <div className={cls("home", compact && "compact")}>
      <div className="home-chat">
        <CobraChat lead={lead} env={{ toast: app.toast, refresh: () => f.refresh(), openChat: app.openChat,
          terminal: (row) => void app.actions.terminal(row), away, rows: f.rows, orch: f.orch }} />
      </div>
      {side}
    </div>
  );
}

// -- rows ------------------------------------------------------------------------

const DIALOG_WORDS: Record<string, string> = {
  permission: "Permission", question: "Question", trust: "Trust this folder?", model: "Picking a model",
};

function BlockerRow({ b }: { b: ops.Blocker }) {
  const app = useApp();
  const a = app.actions;
  const [emailOpen, setEmailOpen] = useState(false);
  if (b.kind === "approval" && b.approval?.plan) return <PlanRow b={b} />;
  if (b.kind === "approval") {
    const body = String(b.approval?.body || "");
    // A Foreman's action: what Allow sends, field by field (its title holds the summary); a routine: when, its
    // first run and its brief; trust: who, the templates and the cards it was. Anything else: its body's first line.
    const action = actionView(b.approval) ?? routineApprovalView(b.approval) ?? trustApprovalView(b.approval);
    // A website card: its version's own address, to look at before Allow puts it live, and where Allow saves its source;
    // a domain card: the names Allow attaches or takes off, and the website as it is now.
    const preview = sitePreview(b.approval);
    const source = siteDomains(b.approval) ?? siteSource(b.approval);
    // A branded email card (agent emailRoutes.ts): the email drawn as it will look, before Allow.
    const emailLabel = emailPreviewLabel(b.approval);
    // A board Cobra made (contracts boards.ts): its live preview, and Add or Not now, since a board only reads.
    const board = b.approval?.kind === "board" && b.approval.board ? b.approval.board : null;
    // Receipts Cobra read (agent receipts.ts): their photos; Allow records them, Not mine voids them.
    const expenses = b.approval?.kind === "expenses" && b.approval.expenses ? b.approval.expenses : null;
    // Bills Cobra found or Money proposed (agent billsCard.ts): each one to tick; Allow keeps the ticked ones.
    const bills = b.approval?.kind === "bills" && b.approval.bills ? (b.approval.bills as ApprovalBills) : null;
    const yes = action?.yes ?? (board ? "Add" : "Allow");
    const no = action?.no ?? (board ? "Not now" : expenses ? "Not mine" : "Deny");
    // A card from a turn that read text from outside says why it asks (lib/trust.ts taintNote).
    const tainted = trust.taintNote(b.approval);
    // A change to a specialist (lib/specialistCard.ts): every word of it, since Allow puts them into its rules.
    const whole = specialistText(b.approval);
    const shown = whole ? <pre className="card-whole" onClick={(e) => e.stopPropagation()}>{whole}</pre> : action ? <ActionCard view={action} /> : board ? <BoardPreview board={board} /> : expenses ? <ExpensesPreview machine={b.machine} approval={String(b.approval!.id)} expenses={expenses} /> : bills ? <BillsPreview approval={String(b.approval!.id)} bills={bills} /> : source || siteShots(b.approval).length ? <>
          {source && <div className="bdetail">{source}</div>}
          <SiteShots machine={b.machine} approval={b.approval} />
        </> : undefined;
    return (
      <BoardRow time={b.time} title={b.title} word={action ? action.word : board ? "BOARD" : expenses ? "RECEIPTS" : bills ? "BILLS" : b.word} tone="signal" machine={b.machine} keepActions
        detail={action || bills || whole ? null : body ? body.split("\n")[0] : null} tooltip={action || whole ? undefined : body || undefined}
        extra={tainted ? <>
          <div className="bdetail">{tainted}</div>
          {shown}
        </> : shown}
        actions={<>
          <Button kind="primary" small onClick={() => void a.answerApproval(b.machine, b.approval!, true)}>{yes}</Button>
          <Button kind="flat" small onClick={() => void a.answerApproval(b.machine, b.approval!, false)}>{no}</Button>
          {preview && <Button kind="flat" small onClick={() => void openUrl(preview)}>{sitePreviewLabel(b.approval)}</Button>}
          {emailLabel && <Button kind="flat" small onClick={() => setEmailOpen(true)}>{emailLabel}</Button>}
          {emailOpen && <EmailPreviewDialog machine={b.machine} approval={String(b.approval!.id)} onClose={() => setEmailOpen(false)} />}
        </>} />
    );
  }
  if (b.kind === "claude" && b.row) {
    const r = b.row;
    const tail = ((r.project?.tail || []) as string[]).filter((t) => String(t).trim());
    const what = DIALOG_WORDS[r.dialog || ""] ?? "Waiting";
    // An agent that sends the request: its words under the row; else the screen's last lines.
    const request = r.request;
    // Other ways to allow a Worker's prompt (lib/allowScope.ts): this task, this project, always.
    const offer = r.dialog === "permission" ? allowOffer(isDict(r.project) ? r.project.request : null) : null;
    return (
      <BoardRow time={b.time} title={b.title} word={b.word} tone="signal" machine={r.machine} keepActions
        detail={request ? what : `${what} · ` + (tail.length ? tail.slice(-2).join(" ") : "")}
        extra={request || offer ? <>
          {request && <RequestView request={request as unknown as Dict} full={false} />}
          <ScopeChoices offer={offer} onAllow={(choice) => void a.allowScoped(r, choice)} />
        </> : undefined}
        actions={<>
          {r.dialog === "permission" && <>
            <Button kind="primary" small onClick={() => void a.allow(r)}>{offer ? "Allow once" : "Allow"}</Button>
            <Button kind="flat" small onClick={() => void a.deny(r)}>Deny</Button>
          </>}
          <Button kind="flat" small onClick={() => app.openChat(r.machine, r.session)}>Chat</Button>
        </>} />
    );
  }
  if (b.kind === "alert") {
    return (
      <BoardRow time={b.time} title={b.title} word={b.word} tone="signal" machine={b.machine}
        detail={String(b.alert?.body || "") || null}
        actions={<Button kind="flat" small onClick={() => app.show("fleet")}>This computer</Button>} />
    );
  }
  const r = b.row;
  return (
    <BoardRow time={b.time} title={b.title} word={b.word} tone="signal" machine={b.machine}
      detail={r ? model.gradeReason(r.project?.git || {}) : null}
      onClick={r ? () => app.openProject(r.machine, r.id) : undefined} />
  );
}

/** A Foreman's plan: each task with the router's model, which a dropdown changes, then Approve or Decline. */
function PlanRow({ b }: { b: ops.Blocker }) {
  const a = useApp().actions;
  const approval = b.approval || {};
  const plan: Dict = approval.plan;
  const [changes, setChanges] = useState<Dict>({});
  const tasks = (plan.tasks || []) as Dict[];
  return (
    <BoardRow time={b.time} title={b.title} word={b.word} tone="signal" machine={b.machine} keepActions
      detail={plan.summary || null}
      extra={
        <div className="col plan-tasks" style={{ gap: 6 }} onClick={(e) => e.stopPropagation()}>
          {tasks.map((task, i) => {
            const options: string[] = task.options?.length ? task.options : [task.model];
            const chosen: string = changes[task.id] ?? task.model;
            return (
              <div key={String(task.id)} className="wrap plan-task">
                <div className="col grow" style={{ gap: 2 }}>
                  <span>{`${i + 1}. ${task.title}`}</span>
                  <span className="dim">{plans.taskChips(task, chosen).join(" · ")}</span>
                  <span className="dim">{plans.taskWhy(task, chosen)}</span>
                </div>
                <select className="entry" value={options.includes(chosen) ? chosen : options[0]}
                  onChange={(e) => setChanges({ ...changes, [task.id]: e.target.value })}>
                  {options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            );
          })}
          <span className="dim">{plans.FOOTNOTE}</span>
        </div>
      }
      actions={<>
        <Button kind="primary" small onClick={() => void a.answerApproval(b.machine, approval, true, plans.changedModels(plan, changes))}>
          {plans.approveLabel(plan)}
        </Button>
        <Button kind="flat" small onClick={() => void a.answerApproval(b.machine, approval, false)}>Decline</Button>
      </>} />
  );
}
