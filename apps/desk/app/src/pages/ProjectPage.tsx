/**
 * The project page — the phone's app/repo/[id].tsx on the desktop (the desk's
 * ui/project_page.py, a dialog there, a page here with a way back). One
 * repository on one computer, with a switch when other computers hold a
 * checkout of the same remote: its session and what to do with it, its extra
 * sessions and + New session, then the repository — grade, the one git
 * offer, Land, Fetch, pull requests (Merge when green) and branches (Resume,
 * Delete, Ask Claude). A project made for a trade that keeps a database also
 * gets RECORDS: the journal of changes newest first with Undo behind a confirm (lib/records.ts;
 * the agent's personRoutes.ts). ROUTINES lists what the Foreman is given on a
 * schedule, with Run now, Pause or Resume, and Remove behind a confirm
 * (lib/routines.ts; the agent's routines.ts). TRUST lists what the Foreman
 * does with no card (Revoke, a second press to confirm), what you said keeps
 * asking (Clear), and what ran on trust lately (lib/trust.ts; the agent's
 * actionTrust.ts). A trade that ships dashboards (a Space's CRM, its books) gets a
 * DASHBOARD above RECORDS (components/Dashboard.tsx; the agent's views.ts).
 *
 * State comes from the fleet's poll, so the page follows it; branches and PRs
 * are read once on open and again after each git action; records on open, on
 * Refresh and after an Undo.
 */
import { APP_NAME } from "../lib/appName.ts";
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useApp, useFleet } from "../app/context.ts";
import * as api from "../lib/api.ts";
import * as config from "../lib/config.ts";
import * as model from "../lib/model.ts";
import { togglePin } from "../lib/pins.ts";
import type { Dict } from "../lib/json.ts";
import { allowOffer } from "../lib/allowScope.ts";
import { ScopeChoices } from "../components/ScopeChoices.tsx";
import * as records from "../lib/records.ts";
import * as routines from "../lib/routines.ts";
import * as trust from "../lib/trust.ts";
import { ConfirmPress } from "../lib/confirm.ts";
import { Board, BoardRow, Button, RequestView, Status } from "../components/ui.tsx";
import { Confirm, MenuDots, useVerbs, type Verbs } from "../components/Verbs.tsx";
import { Spinner, Toggles } from "../components/NewProject.tsx";
import { Dashboard } from "../components/Dashboard.tsx";
import { usePlaces } from "../components/usePlaces.ts";
import { useShowCrew, whoWords } from "../lib/crewVisibility.ts";
import "../styles/projects.css";

const FOOTNOTE =
  "Sync fetches from origin and fast-forwards main only when it is clean and not ahead. Park commits " +
  `everything to a wip/ branch and pushes it; Resume checks that branch out; Land asks ${APP_NAME} to name it ` +
  "and open its PR. Delete removes a branch only when every commit on it is already in main. Merge " +
  "squashes a green PR and deletes its branch. Nothing here rebases or discards work.";

const keyOf = (r: model.Row) => `${r.machine}\u0000${r.id}`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Branches and PRs of one checkout: loading, read, or why not. */
type Detail = { state: "loading" } | { state: "read"; repo: Dict } | { state: "failed"; error: string };

export function ProjectPage({ machine, project, onClose }: { machine: string; project: string; onClose: () => void }) {
  const fleet = useFleet();
  const verbs = useVerbs();
  const here = `${machine}\u0000${project}`;
  const [chosen, setChosen] = useState(here);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const asked = useRef(new Set<string>());
  const showCrew = useShowCrew();
  const places = usePlaces(fleet.rows, fleet.orch);

  const hereRow = fleet.rows.find((r) => keyOf(r) === here && r.project) ?? null;
  const checkouts = hereRow ? model.checkouts(hereRow, fleet.rows) : [];
  const cur = checkouts.find((r) => keyOf(r) === chosen) ?? hereRow;

  /** Branches and PRs of `r`, into details. */
  const load = useCallback((r: model.Row) => {
    if (!r.project?.git || !config.machine(r.machine)) return;
    const k = keyOf(r);
    asked.current.add(k);
    setDetails((d) => ({ ...d, [k]: { state: "loading" } }));
    api.repo(r.machine, r.id).then(
      (repo) => setDetails((d) => ({ ...d, [k]: { state: "read", repo: repo ?? {} } })),
      (e) => setDetails((d) => ({ ...d, [k]: { state: "failed", error: msg(e) } })),
    );
  }, []);

  useEffect(() => {
    if (cur && !asked.current.has(keyOf(cur))) load(cur);
  }, [cur, load]);

  if (hereRow === null || cur === null) {
    return (
      <div className="page board-page">
        <Back onClose={onClose} />
        <div className="dim">This project is not listed right now: its computer may be away, or it was removed.</div>
      </div>
    );
  }

  const choose = (m: string) => {
    const r = checkouts.find((x) => x.machine === m);
    if (r && keyOf(r) !== chosen) setChosen(keyOf(r));
  };

  const git: Dict = cur.project?.git ?? {};
  const facts = [
    git.defaultBranch ? `default ${git.defaultBranch}` : "",
    git.openPrs !== null && git.openPrs !== undefined ? `${git.openPrs} open PR${git.openPrs === 1 ? "" : "s"}` : "",
    checkouts.length > 1 ? `${checkouts.length} checkouts` : "",
  ].filter((f) => f);

  return (
    <div className="page board-page">
      <div className="col" style={{ gap: 16 }}>
        {showCrew ? <Head r={cur} verbs={verbs} onClose={onClose} /> : (
          // With the crew hidden (lib/crewVisibility.ts): its Space and skill, its dashboard and records; no
          // sessions, Foreman or repository.
          <div className="pj-head">
            <Button kind="flat" small onClick={onClose}>← Back</Button>
            <div className="col grow" style={{ gap: 0, alignItems: "center" }}>
              <span className="pj-title ellipsis">{whoWords(places.of(cur.machine, cur.id))}</span>
            </div>
          </div>
        )}
        {showCrew && (
          <div className="col" style={{ gap: 2 }}>
            <span className="mono selectable ellipsis">{git.remote || cur.path}</span>
            {facts.length > 0 && <span className="dim">{facts.join(" · ")}</span>}
            {git.remote ? <span className="dim mono ellipsis">{cur.path}</span> : null}
          </div>
        )}
        {showCrew && checkouts.length > 1 && (
          <Toggles options={checkouts.map((r) => [r.machine, `${r.label} · ${model.sessionWord(r)}`] as const)}
            active={cur.machine} onChange={choose} />
        )}
        {showCrew && <Panel r={cur} verbs={verbs} />}
        {showCrew && cur.parent === null && Object.keys(git).length > 0 && <Sessions r={cur} verbs={verbs} />}
        {cur.parent === null && Object.keys(git).length > 0 && <Routines key={`routines:${keyOf(cur)}`} r={cur} />}
        {cur.parent === null && Object.keys(git).length > 0 && <Trust key={`trust:${keyOf(cur)}`} r={cur} />}
        {cur.parent === null && cur.project?.foremanTemplate && Object.keys(git).length > 0 && (
          <Dashboard key={`dash:${keyOf(cur)}`} machine={cur.machine} project={cur.id} />
        )}
        {cur.parent === null && records.asksForRecords(cur.project?.foremanTemplate) && (
          <Records key={keyOf(cur)} r={cur} />
        )}
        {showCrew && <Repository r={cur} git={git} detail={details[keyOf(cur)]} verbs={verbs} reload={() => load(cur)} />}
        {showCrew && <div className="dim">{FOOTNOTE}</div>}
      </div>
      {verbs.node}
    </div>
  );
}

function Back({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Button kind="flat" small onClick={onClose}>← Projects</Button>
    </div>
  );
}

/** The header bar: the way back, the name and computer, the pin and ⋯. */
function Head({ r, verbs, onClose }: { r: model.Row; verbs: Verbs; onClose: () => void }) {
  const app = useApp();
  const pinned = verbs.isPinned(r);
  const pin = () => {
    const k = model.pinKey(r);
    if (k) togglePin(k).then((now) => app.toast(now ? `Pinned ${r.name}` : `Unpinned ${r.name}`));
  };
  return (
    <div className="pj-head">
      <Button kind="flat" small onClick={onClose}>← Projects</Button>
      <div className="col grow" style={{ gap: 0, alignItems: "center" }}>
        <span className="pj-title ellipsis">{r.name}</span>
        <span className="dim">{r.label}</span>
      </div>
      <button className="btn flat" title={pinned ? "Unpin" : "Pin to the top of Projects"} onClick={pin}>
        {pinned ? "★" : "☆"}
      </button>
      <MenuDots onOpen={(x, y) => verbs.menuAt(r, x, y)} />
    </div>
  );
}

/** The session and what to do with it. The first button is the likeliest next step. */
function Panel({ r, verbs }: { r: model.Row; verbs: Verbs }) {
  const app = useApp();
  const a = app.actions;
  const p: Dict = r.project ?? {};
  const activity = p.activity || "none";
  const chat = () => app.openChat(r.machine, r.session);
  const template = <Button title="Saved prompts" onClick={() => verbs.pickTemplate(r)}>Template…</Button>;
  let word: string, tone: string, btns: ReactNode;
  if (p.needsInput) {
    [word, tone] = ["WAITING ON YOU", "signal"];
    // Other ways to allow a Worker's prompt (lib/allowScope.ts): this task, this project, always.
    const offer = p.dialog === "permission" ? allowOffer(p.request) : null;
    btns = (
      <>
        {p.dialog === "permission" && <Button kind="primary" onClick={() => void a.allow(r)}>{offer ? "Allow once" : "Allow"}</Button>}
        <Button onClick={() => void a.deny(r)}>{p.dialog === "permission" ? "Deny" : "Dismiss"}</Button>
        <Button onClick={chat}>Chat</Button>
        <ScopeChoices offer={offer} onAllow={(choice) => void a.allowScoped(r, choice)} />
      </>
    );
  } else if (activity === "none") {
    [word, tone] = ["NO SESSION", "dim"];
    btns = (
      <>
        <Button kind="primary" onClick={() => void a.start(r)}>▶ Start {APP_NAME}</Button>
        <Button onClick={() => verbs.askPrompt(r)}>With a prompt…</Button>
        {template}
      </>
    );
  } else if (activity === "agent-working" || activity === "agent-idle") {
    [word, tone] = activity === "agent-working" ? ["CLAUDE WORKING", "ink"] : ["CLAUDE DONE", "muted"];
    btns = (
      <>
        <Button kind="primary" onClick={chat}>Chat</Button>
        {template}
        <Button title={`Esc to ${APP_NAME}`} onClick={() => void a.interrupt(r)}>Interrupt</Button>
      </>
    );
  } else {
    [word, tone] = activity === "busy" ? [`RUNNING ${p.command || ""}`.trim(), "muted"] : ["SHELL OPEN", "muted"];
    btns = (
      <>
        <Button kind="primary" onClick={chat}>As chat</Button>
        {activity === "idle" ? (
          <Button title="claude --continue" onClick={() => void a.resumeClaude(r)}>Resume {APP_NAME}</Button>
        ) : (
          <Button title="Ctrl-C" onClick={() => void a.interrupt(r)}>Interrupt</Button>
        )}
        {template}
      </>
    );
  }
  const when = p.lastActivityAt ? model.boardTime(p.lastActivityAt) : "";
  const tail = ((p.tail ?? []) as string[]).filter((t) => String(t).trim()).slice(-3);
  const request = p.needsInput ? r.request : null;
  return (
    <div className="col" style={{ gap: 8 }}>
      <span className="caps">SESSION</span>
      <div className="row">
        <Status word={word} tone={tone} />
        <span className="dim mono grow ellipsis">{r.session}</span>
        {when ? <span className="btime">{when}</span> : null}
      </div>
      {request ? (
        <RequestView request={request as unknown as Dict} />
      ) : tail.length ? (
        <div className="col" style={{ gap: 0 }}>
          {tail.map((t, i) => <span className="bdetail pj-one-line" key={i}>{t}</span>)}
        </div>
      ) : null}
      <div className="wrap" style={{ gap: 8 }}>
        {btns}
        {activity !== "none" && (
          <Button kind="danger" title="End the tmux session and everything in it" onClick={() => verbs.confirmKill(r)}>Kill…</Button>
        )}
      </div>
    </div>
  );
}

function Sessions({ r, verbs }: { r: model.Row; verbs: Verbs }) {
  const app = useApp();
  const extras = model.extrasOf(r, app.fleet.rows);
  // The Foreman (the agent's foreman.ts): this project's orchestrator, which you open.
  const fm = extras.find((x) => x.foreman);
  const foreman = (action: string) => {
    const said: Record<string, string> = {
      start: "The Foreman started", clear: "The Foreman starts a new conversation",
      stop: "The Foreman stopped; its Workers keep running",
    };
    api.foremanAction(r.machine, r.id, action).then(
      () => {
        app.toast(`${said[action]} · ${r.name}`);
        app.fleet.refresh();
        if (action === "start") app.openChat(r.machine, `${r.session}_fm`);
      },
      (e) => app.toast(`Foreman: ${msg(e)}`),
    );
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      <span className="caps">{extras.length ? `SESSIONS · ${extras.length + 1}` : "SESSIONS"}</span>
      {extras.length > 0 && (
        <Board>
          {extras.map((x) => {
            const [word, tone] = model.boardStatus(x);
            const active = ![undefined, null, "none"].includes(x.project?.activity);
            // An extra session: its title, then its type, model and state, then the full branch for git.
            const detail = x.isExtra ? [model.sessionDetail(x), `⎇ ${x.branch}`].filter((s) => s).join(" · ") : x.session;
            return (
              <BoardRow key={keyOf(x)} time={model.boardTime(x.project?.lastActivityAt ?? null)} title={x.title}
                word={word} tone={tone} detail={detail}
                onClick={active ? () => app.openChat(x.machine, x.session) : () => app.openProject(x.machine, x.id)}
                onMenu={(px, py) => verbs.menuAt(x, px, py)} />
            );
          })}
        </Board>
      )}
      <div>
        <Button kind="flat" title={`Another ${APP_NAME} session, in its own worktree on a new branch`} onClick={() => verbs.askNewSession(r)}>
          + New session
        </Button>
      </div>
      {fm === undefined ? (
        <div>
          <Button kind="flat" title="An orchestrator for this project: plans with you and starts Workers here" onClick={() => foreman("start")}>
            + Foreman
          </Button>
        </div>
      ) : (
        <div className="row" style={{ gap: 4 }}>
          <Button kind="flat" onClick={() => foreman("clear")}>Foreman: new conversation</Button>
          <Button kind="flat" title="Its Workers keep running" onClick={() => foreman("stop")}>Stop the Foreman</Button>
        </div>
      )}
    </div>
  );
}

/** A project's records: the journal with Undo. */
type Recs = { state: "loading" } | { state: "read"; journal: Dict } | { state: "failed"; error: string };

function Records({ r }: { r: model.Row }) {
  const app = useApp();
  const [recs, setRecs] = useState<Recs>({ state: "loading" });
  const [asking, setAsking] = useState<Dict | null>(null);
  const [undoing, setUndoing] = useState<number | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);

  const load = useCallback(() => {
    if (!config.machine(r.machine)) return;
    api.dbJournal(r.machine, r.id, records.JOURNAL_LIMIT).then(
      (journal) => live.current && setRecs({ state: "read", journal: journal ?? {} }),
      (e) => live.current && setRecs({
        state: "failed",
        error: (e as { status?: number })?.status === 404 ? records.updateAgentLine(r.label) : `Could not read the records: ${msg(e)}`,
      }),
    );
  }, [r.machine, r.id]);
  useEffect(load, [load]);

  const undo = (entry: Dict) => {
    const id = Number(entry.id);
    setUndoing(id);
    api.dbUndo(r.machine, r.id, id).then(
      () => {
        app.toast(`Undone · ${records.entryView(entry).title}`);
        if (live.current) setUndoing(null);
        load();
      },
      (e) => {
        app.toast(`Not undone: ${msg(e)}`);
        if (live.current) setUndoing(null);
        load();
      },
    );
  };

  const head = (
    <div className="row">
      <span className="caps grow">RECORDS</span>
      <Button kind="flat" small title="Read the journal again" onClick={load}>Refresh</Button>
    </div>
  );
  // A trade that may keep no database is drawn only once its records say it has some.
  if (recs.state !== "read" && !records.RECORD_TRADES.has(String(r.project?.foremanTemplate))) return null;
  if (recs.state === "loading") {
    return <div className="col" style={{ gap: 8 }}>{head}<div className="row"><Spinner /><span className="dim">Reading the records…</span></div></div>;
  }
  if (recs.state === "failed") {
    return <div className="col" style={{ gap: 8 }}>{head}<div className="dim">{recs.error}</div></div>;
  }
  if (!records.showsRecords(r.project?.foremanTemplate, recs.journal)) return null;
  const entries = records.entriesOf(recs.journal);
  return (
    <div className="col" style={{ gap: 8 }}>
      {head}
      <span className="caps">{entries.length ? `JOURNAL · ${entries.length}` : "JOURNAL"}</span>
      {!entries.length ? (
        <div className="dim">{records.NO_ENTRIES}</div>
      ) : (
        <>
          <Board>
            {entries.map((entry) => {
              const v = records.entryView(entry);
              return (
                <BoardRow key={String(entry.id)} time={model.boardTime(entry.at)} title={v.title} word={v.word} tone={v.tone}
                  detail={v.detail} keepActions
                  actions={v.undo ? (
                    <Button kind="flat" small disabled={undoing !== null} onClick={() => setAsking(entry)}>
                      {undoing === Number(entry.id) ? "Undoing…" : "Undo"}
                    </Button>
                  ) : undefined} />
              );
            })}
          </Board>
          <div className="dim">{records.UNDO_NOTE}</div>
        </>
      )}
      {asking && (() => {
        const ask = records.undoConfirm(asking, r.name);
        return <Confirm title={ask.title} body={ask.body} yes={ask.yes} danger onYes={() => undo(asking)} onClose={() => setAsking(null)} />;
      })()}
    </div>
  );
}

/** A project's routines: when each runs, the next run and the last, with Run now, Pause or Resume, and Remove. */
type Routs = { state: "loading" } | { state: "read"; list: Dict[] } | { state: "none" } | { state: "failed"; error: string };

function Routines({ r }: { r: model.Row }) {
  const app = useApp();
  const [routs, setRouts] = useState<Routs>({ state: "loading" });
  const [asking, setAsking] = useState<Dict | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);

  const load = useCallback(() => {
    if (!config.machine(r.machine)) return;
    api.routines(r.machine).then(
      (list) => live.current && setRouts({ state: "read", list: routines.routinesFor(list, r.id) }),
      (e) => live.current && setRouts((e as { status?: number })?.status === 404 ? { state: "none" } : { state: "failed", error: msg(e) }),
    );
  }, [r.machine, r.id]);
  useEffect(load, [load]);

  // A Foreman here: a project made for a trade, or one whose Foreman runs.
  const hasForeman = Boolean(r.project?.foremanTemplate) || model.extrasOf(r, app.fleet.rows).some((x) => x.foreman);
  const list = routs.state === "read" ? routs.list : null;
  if (routs.state === "loading" || routs.state === "none") return null;
  if (routs.state === "failed" ? !hasForeman : !routines.showsRoutines(list, hasForeman)) return null;

  const act = (routine: Dict, action: "run" | "pause" | "resume" | "remove") => {
    const id = String(routine.id);
    const name = routines.routineView(routine).title;
    setBusy(`${id}:${action}`);
    const sent = action === "run" ? api.routineRun(r.machine, id)
      : action === "remove" ? api.routineRemove(r.machine, id)
      : api.routinePause(r.machine, id, action === "resume");
    sent.then(
      () => app.toast(routines.doneWords(action, name)),
      (e) => app.toast(`Couldn't ${action} ${name}: ${msg(e)}`),
    ).finally(() => {
      if (live.current) setBusy(null);
      load();
    });
  };

  const head = (
    <div className="row">
      <span className="caps grow">{list?.length ? `ROUTINES · ${list.length}` : "ROUTINES"}</span>
      <Button kind="flat" small title="Read the routines again" onClick={load}>Refresh</Button>
    </div>
  );
  if (routs.state === "failed") {
    return <div className="col" style={{ gap: 8 }}>{head}<div className="dim">Could not read the routines: {routs.error}</div></div>;
  }
  if (!list?.length) {
    return <div className="col" style={{ gap: 8 }}>{head}<div className="dim">{routines.HINT}</div></div>;
  }
  const now = Date.now();
  return (
    <div className="col" style={{ gap: 8 }}>
      {head}
      <Board>
        {list.map((routine) => {
          const v = routines.routineView(routine, now);
          const doing = (a: string) => busy === `${v.id}:${a}`;
          return (
            <BoardRow key={v.id} time={null} title={v.title} word={v.word} tone={v.tone} detail={v.detail} keepActions
              extra={v.last ? <div className={v.failed ? "pj-error" : "bdetail"}>{v.last}</div> : undefined}
              actions={<>
                <Button kind="primary" small disabled={busy !== null} onClick={() => act(routine, "run")}>{doing("run") ? "Running…" : "Run now"}</Button>
                <Button kind="flat" small disabled={busy !== null} onClick={() => act(routine, v.paused ? "resume" : "pause")}>{v.toggle}</Button>
                <Button kind="flat" small disabled={busy !== null} onClick={() => setAsking(routine)}>{doing("remove") ? "Removing…" : "Remove"}</Button>
              </>} />
          );
        })}
      </Board>
      <div className="dim">{routines.NOTE}</div>
      {asking && (() => {
        const ask = routines.removeConfirm(asking, r.name);
        return <Confirm title={ask.title} body={ask.body} yes={ask.yes} danger onYes={() => act(asking, "remove")} onClose={() => setAsking(null)} />;
      })()}
    </div>
  );
}

/** A project's trust: what the Foreman does with no card, with Revoke; what keeps asking, with Clear; what ran on trust lately. */
type Trusts = { state: "loading" } | { state: "read"; t: ReturnType<typeof trust.trustFor> } | { state: "none" } | { state: "failed"; error: string };

function Trust({ r }: { r: model.Row }) {
  const app = useApp();
  const [trusts, setTrusts] = useState<Trusts>({ state: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);

  const load = useCallback(() => {
    if (!config.machine(r.machine)) return;
    api.trust(r.machine, r.id).then(
      (list) => live.current && setTrusts({ state: "read", t: trust.trustFor(list, r.id) }),
      (e) => live.current && setTrusts((e as { status?: number })?.status === 404 ? { state: "none" } : { state: "failed", error: msg(e) }),
    );
  }, [r.machine, r.id]);
  useEffect(load, [load]);

  // Nothing trusted, nothing asking, nothing landed (or an agent from before trust, or one away): no section.
  if (trusts.state !== "read" || !trust.showsTrust(trusts.t)) return null;
  const head = (
    <div className="row">
      <span className="caps grow">TRUST</span>
      <Button kind="flat" small title="Read trust again" onClick={load}>Refresh</Button>
    </div>
  );
  const { grants, always, receipts } = trusts.t;

  const act = (key: string, title: string, action: "revoke" | "clear", done: () => void) => {
    setBusy(`${key}:${action}`);
    (action === "revoke" ? api.trustRevoke(r.machine, key) : api.trustClear(r.machine, key)).then(
      () => app.toast(trust.doneWords(action, title)),
      (e) => app.toast(`Couldn't ${action} ${title}: ${msg(e)}`),
    ).finally(() => {
      done();
      if (live.current) setBusy(null);
      load();
    });
  };
  const now = Date.now();
  return (
    <div className="col" style={{ gap: 8 }}>
      {head}
      {(grants.length > 0 || always.length > 0) && (
        <Board>
          {grants.map((grant) => {
            const v = trust.grantView(grant, now);
            return (
              <BoardRow key={v.key} time={null} title={v.title} word="TRUSTED" tone="ink" detail={v.detail} keepActions
                extra={<div className="bdetail">{v.since}</div>}
                actions={<RevokeButton disabled={busy !== null} onRevoke={(done) => act(v.key, v.title, "revoke", done)} />} />
            );
          })}
          {always.map((ask) => {
            const v = trust.askView(ask, now);
            return (
              <BoardRow key={v.key} time={null} title={v.title} word="ASKS" tone="dim" detail={v.detail} keepActions
                extra={<div className="bdetail">{v.since}</div>}
                actions={<Button kind="flat" small disabled={busy !== null} onClick={() => act(v.key, v.title, "clear", () => undefined)}>
                  {busy === `${v.key}:clear` ? "Clearing…" : "Clear"}
                </Button>} />
            );
          })}
        </Board>
      )}
      {receipts.length > 0 && (
        <>
          <span className="caps">{`LANDED · ${receipts.length}`}</span>
          <Board>
            {receipts.map((approval) => {
              const v = trust.receiptView(approval, now);
              return <BoardRow key={v.id} time={v.time} title={v.title} word={v.word} tone={v.tone} detail={v.detail} />;
            })}
          </Board>
        </>
      )}
      <div className="dim">{trust.NOTE}</div>
    </div>
  );
}

/** Revoke, armed by the first press (red, 4 seconds) and done by a second (lib/confirm.ts). */
function RevokeButton({ disabled, onRevoke }: { disabled: boolean; onRevoke: (done: () => void) => void }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const press = useRef<ConfirmPress | null>(null);
  if (!press.current) {
    press.current = new ConfirmPress((done) => onRevoke(done), () => redraw(),
      (ms, fn) => setTimeout(fn, ms), (h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }
  useEffect(() => () => press.current?.reset(), []);
  const p = press.current;
  return (
    <Button kind={p.armed ? "danger" : "flat"} small disabled={disabled || p.busy} onClick={() => p.press()}>
      {p.busy ? "Revoking…" : p.armed ? "Press again to revoke" : "Revoke"}
    </Button>
  );
}

function Repository({ r, git, detail, verbs, reload }: {
  r: model.Row; git: Dict; detail: Detail | undefined; verbs: Verbs; reload: () => void;
}) {
  const app = useApp();
  const a = app.actions;
  if (!Object.keys(git).length) {
    return (
      <div className="col" style={{ gap: 8 }}>
        <span className="caps">REPOSITORY</span>
        <span className="dim">Not a git repository.</span>
      </div>
    );
  }
  const [word, tone] = model.gradeWord(git.grade);
  const reason = model.gradeReason(git);
  const offer = model.offerFor(git);
  const gitDo = (action: string, extra: Dict = {}) => void a.git(r.machine, r.id, action, r.name, extra).then(reload);

  let below: ReactNode;
  if (detail === undefined || detail.state === "loading") {
    below = (
      <div className="row">
        <Spinner />
        <span className="dim">Reading branches and pull requests…</span>
      </div>
    );
  } else if (detail.state === "failed") {
    below = <div className="dim">Could not read branches and pull requests: {detail.error}</div>;
  } else {
    const repo = detail.repo;
    const prs: Dict[] | null | undefined = repo.prs;
    const branches: Dict[] = repo.branches ?? [];
    const local = branches.filter((b) => b.local).length;
    const remote = branches.filter((b) => b.remote).length;
    below = (
      <>
        <span className="caps">{`PULL REQUESTS${prs && prs.length ? ` · ${prs.length}` : ""}`}</span>
        {prs === null || prs === undefined ? (
          <div className="dim">{repo.prError || "gh could not list them."}</div>
        ) : !prs.length ? (
          <div className="dim">None open.</div>
        ) : (
          <Board>
            {prs.map((pr) => {
              const why = model.prWord(pr);
              const red = why === "checks failing" || why === "conflicting";
              const acts = why === null
                ? <Button kind="primary" small onClick={() => verbs.confirmMerge(r, pr, reload)}>Merge</Button>
                : red ? <Button kind="flat" small onClick={() => void a.askClaude(r)}>Ask {APP_NAME}</Button> : undefined;
              return (
                <BoardRow key={String(pr.number)} time={`${pr.ageDays}d`} title={`#${pr.number} ${pr.title}`}
                  word={why === null ? "READY" : why.toUpperCase()} tone={why === null ? "ink" : red ? "signal" : "muted"}
                  detail={`${pr.head} → ${pr.base}`} actions={acts} keepActions />
              );
            })}
          </Board>
        )}
        <span className="caps">{`BRANCHES · ${local} LOCAL · ${remote} REMOTE`}</span>
        {!branches.length ? (
          <div className="dim">Only {git.defaultBranch || "main"}.</div>
        ) : (
          <>
            <Board>
              {branches.slice(0, 12).map((b) => {
                const verb = model.branchVerb(b, Boolean(git.dirty));
                const acts = verb === "resume" ? <Button kind="primary" small onClick={() => gitDo("resume", { branch: b.name })}>Resume</Button>
                  : verb === "delete" ? <Button kind="flat" small onClick={() => gitDo("delete-branch", { branch: b.name })}>Delete</Button>
                    : verb === "ask" ? <Button kind="flat" small onClick={() => void a.askClaude(r)}>Ask {APP_NAME}</Button>
                      : undefined;
                const age = b.ageDays;
                return (
                  <BoardRow key={String(b.name)} time={age !== null && age !== undefined ? `${age}d` : "—"} title={b.name || ""}
                    word={b.current ? "CURRENT" : b.parked ? "PARKED" : b.merged ? "MERGED" : b.stale ? "STALE" : ""}
                    tone={b.current || b.parked ? "ink" : "muted"} detail={model.branchWord(b)} actions={acts} keepActions />
                );
              })}
            </Board>
            {branches.length > 12 && <div className="dim">… {branches.length - 12} more in Tidy.</div>}
          </>
        )}
      </>
    );
  }

  return (
    <div className="col" style={{ gap: 8 }}>
      <span className="caps">REPOSITORY</span>
      <div className="row">
        <span className="mono grow">{model.gitLine(git)}</span>
        <Status word={word} tone={tone} />
      </div>
      {reason ? <div className="dim">{reason}</div> : null}
      <div className="dim">{model.gitFacts(git).join(" · ")}</div>
      <div className="wrap" style={{ gap: 8 }}>
        {offer && (
          <Button kind="primary" title={model.OFFER_SENTENCE[offer[0]]} onClick={() => gitDo(offer[0])}>{offer[1]}</Button>
        )}
        {String(git.branch || "").startsWith("wip/") && (
          // On a resumed wip branch the next step is Claude's: name it, write the message, open the PR.
          <Button kind="primary" title={`${APP_NAME} names the branch and opens a draft PR`} onClick={() => void a.askClaude(r, "land-parked")}>
            Land
          </Button>
        )}
        {(!offer || offer[0] !== "sync") && (
          <Button title="Fetch from origin; fast-forward main when it is clean" onClick={() => gitDo("sync")}>Fetch</Button>
        )}
      </div>
      {below}
    </div>
  );
}
