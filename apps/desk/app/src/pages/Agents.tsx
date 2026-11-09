/**
 * Agents — every agent you can talk to, and a Claude Code session as a conversation (the phone's
 * Agents tab and its chat screen; the desk's ui/chat.py). The list is the Lead, then each project's
 * Foreman, the Workers, the tasks waiting in the queue, and your own sessions.
 *
 * Two sources in one poll of `GET /transcript`: Claude Code's own transcript (what was said, which
 * tools ran, what was asked) and the screen (whether a dialog is up *now*, which the transcript
 * cannot know until it is answered). Every answer goes through the agent's screen-driven actions,
 * which 409 when the screen is not what they expect — so a stale button is harmless.
 */
import { LEAD_NAME } from "../lib/appName.ts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type MouseEvent } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useApp, useFleet } from "../app/context.ts";
import * as api from "../lib/api.ts";
import * as attach from "../lib/attach.ts";
import * as config from "../lib/config.ts";
import * as crew from "../lib/crew.ts";
import * as model from "../lib/model.ts";
import { ConfirmPress, WINDOW_MS } from "../lib/confirm.ts";
import { COPY_SCHEME } from "../lib/markdown.ts";
import { copiedWord, inbox, layout, rosterLine } from "../lib/chatView.ts";
import { isDict, type Dict } from "../lib/json.ts";
import { allowOffer, allowWithScope, type ScopeChoice } from "../lib/allowScope.ts";
import { Button, Chip, MachineDot, Status, cls } from "../components/ui.tsx";
import { ChatStatus, DockView, LogRow, modelLine } from "../components/Chat.tsx";
import { useThread } from "../components/useThread.ts";
import { historyOf, threadRows } from "../lib/threadRules.ts";
import { Sprite, SpriteFor } from "../components/Sprite.tsx";
import { usePlaces } from "../components/usePlaces.ts";
import { useShowCrew, visibleGroups, whoWords } from "../lib/crewVisibility.ts";
import "../styles/agents.css";

type Target = readonly [string, string]; // (machine, session)

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const same = (a: Target | null, b: Target | null) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

// What was open when the page was last left, so coming back to Agents finds it again (the desk's
// page lived on while hidden); and the last `open` request already honoured.
let kept: Target | null = null;
let seenOpen = 0;

export function AgentsPage({ open }: { open: { machine: string; session: string; n: number } | null }) {
  const { toast, actions } = useApp();
  const fleet = useFleet();
  const showCrew = useShowCrew();
  const places = usePlaces(fleet.rows, fleet.orch);

  const [target, setTarget] = useState<Target | null>(null);
  const [entries, setEntries] = useState<Dict[]>([]);
  const [screen, setScreen] = useState<Dict | null>(null);
  const [modelId, setModelId] = useState<{ model: string; effort: string | null } | null>(null);
  const [heard, setHeard] = useState<string | null>(null); // the transcript's own title
  const [reachable, setReachable] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [dockNonce, setDockNonce] = useState(0);
  const [image, setImageState] = useState<string | null>(null); // an image to send with the next message
  const [text, setTextState] = useState("");
  const [starting, setStarting] = useState(false);
  const [compact, setCompact] = useState(window.innerWidth < 720); // a narrow window shows the list or the chat
  const [browsing, setBrowsing] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  // The Lead's thread on the hub (lib/threadRules.ts): her earlier conversations stay drawn, faded, after a New conversation.
  const leadMachine = target && fleet.row(target[0], target[1])?.lead ? target[0] : null;
  const thread = useThread(leadMachine);
  const history = useMemo(() => historyOf(thread.entries, thread.current, Date.now()), [thread.entries, thread.current]);
  const refreshThread = useRef(thread.refresh);
  refreshThread.current = thread.refresh;

  // The poll loop and the async verbs read these, never a stale render's values.
  const targetRef = useRef<Target | null>(null);
  const imageRef = useRef<string | null>(null);
  const textRef = useRef("");
  const scheduleRef = useRef<(ms: number) => void>(() => {});
  const firstDelay = useRef(0);
  const stick = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);

  const setImage = (path: string | null) => {
    imageRef.current = path;
    setImageState(path);
  };
  const setText = (v: string) => {
    textRef.current = v;
    setTextState(v);
  };

  // The Lead only: a new conversation (/clear); its Workers keep running. It cannot be undone, so
  // the first click only arms the button (red, 4 seconds); a second one clears.
  const newConfirm = useRef<ConfirmPress | null>(null);
  if (!newConfirm.current) {
    newConfirm.current = new ConfirmPress(
      (done) => clearLead(done),
      () => redraw(),
      (ms, fn) => setTimeout(fn, ms),
      (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    );
  }

  // -- opening -------------------------------------------------------------
  const openConvo = useCallback((machine: string, session: string) => {
    const t: Target = [machine, session];
    if (!same(targetRef.current, t)) {
      targetRef.current = t;
      kept = t;
      setTarget(t);
      setEntries([]);
      setScreen(null);
      setModelId(null);
      setHeard(null);
      setImage(null);
      firstDelay.current = 0;
      setGeneration((g) => g + 1);
    } else {
      scheduleRef.current(0);
    }
    newConfirm.current!.reset();
    setBrowsing(false);
  }, []);

  useEffect(() => {
    if (open && open.n !== seenOpen) {
      seenOpen = open.n;
      openConvo(open.machine, open.session);
    } else if (kept && !targetRef.current) {
      openConvo(kept[0], kept[1]);
    }
  }, [open?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- polling the transcript ------------------------------------------------
  useEffect(() => {
    if (!target) return;
    const [machine, session] = target;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let offset: number | null = null;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!dead) timer = setTimeout(poll, ms);
    };
    const poll = async () => {
      timer = undefined;
      try {
        const t = (await api.transcript(machine, session, offset)) as Dict;
        if (dead) return;
        setReachable(true);
        const el = scroller.current;
        stick.current = stick.current || !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
        if (t.offset !== undefined && t.offset !== null) offset = t.offset;
        setEntries((prev) => model.mergeMessages(prev, (t.messages as Dict[]) || []));
        const s = (t.screen as Dict) ?? null;
        setScreen(s);
        if (t.model) setModelId({ model: String(t.model), effort: t.effort ? String(t.effort) : null });
        if (t.title) setHeard(String(t.title));
        schedule(model.pollInterval(s));
      } catch {
        if (dead) return;
        setReachable(false);
        schedule(4000);
      }
    };
    scheduleRef.current = schedule;
    schedule(firstDelay.current);
    return () => {
      dead = true;
      clearTimeout(timer);
      scheduleRef.current = () => {};
    };
  }, [target, generation]);

  // A message drawn at the bottom stays in view as more arrive, unless you scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current || model.rowsOf(entries).length < 3) el.scrollTop = el.scrollHeight;
    stick.current = false;
  }, [entries]);

  // -- narrow windows, focus -----------------------------------------------
  useEffect(() => {
    const resize = () => setCompact(window.innerWidth < 720);
    // A clear waiting for its second click does not survive the window losing focus.
    const blur = () => newConfirm.current!.reset();
    window.addEventListener("resize", resize);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", blur);
      newConfirm.current!.reset();
    };
  }, []);

  // An image dropped on the window waits for the next message, as one picked with + does.
  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") setDropping(!!targetRef.current);
        else if (p.type === "leave") setDropping(false);
        else if (p.type === "drop") {
          setDropping(false);
          if (targetRef.current && p.paths.length) takeImage(p.paths[0]);
        }
      })
      .then((f) => (gone ? f() : (off = f)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // -- verbs ---------------------------------------------------------------
  const rowNow = () => (targetRef.current ? fleet.row(targetRef.current[0], targetRef.current[1]) : undefined);

  const act = async (action: string, extra: Dict = {}) => {
    const t = targetRef.current;
    if (!t) return;
    try {
      await api.sessionAction(t[0], t[1], action, extra);
      fleet.refresh();
      scheduleRef.current(300);
    } catch (e) {
      toast(msg(e));
    }
  };

  /** Allow the prompt the dock shows, bound to it by its key. A 409 means another prompt replaced
   * it (or it was answered): the screen is read again at once to show what is up. */
  const allow = async (key: string, choice: ScopeChoice | null = null) => {
    const t = targetRef.current;
    if (!t) return;
    try {
      // Beyond once (lib/allowScope.ts): the agent keeps the task; this project and always also go on the fleet's policy.
      const said = await allowWithScope(t[0], t[1], key, allowOffer(isDict(screen) ? screen.request : null), choice);
      if (choice) toast(said);
      fleet.refresh();
      scheduleRef.current(300);
    } catch (e) {
      toast(e instanceof api.ApiError && e.status === 409 ? `Asking something else now: ${e.message}` : msg(e));
      setDockNonce((n) => n + 1);
      scheduleRef.current(0);
    }
  };

  const answer = (answers: Dict[]) => {
    setDockNonce((n) => n + 1);
    act("answer", { answers });
  };

  const terminal = () => {
    const row = rowNow();
    if (row) actions.terminal(row);
  };

  const startLead = async (machine: string) => {
    if (starting) return;
    setStarting(true);
    try {
      await api.startLead(machine);
      setStarting(false);
      fleet.refresh();
      openConvo(machine, "cobra_lead");
    } catch (e) {
      setStarting(false);
      toast(`The Lead did not start: ${msg(e)}`);
    }
  };

  function clearLead(done: () => void) {
    const t = targetRef.current;
    if (!t) return done();
    api.clearLead(t[0]).then(
      () => {
        done();
        toast("The Lead starts a new conversation");
        // The transcript is a new file after /clear: read it from the start. The thread keeps what was said; the
        // hub writes the new conversation's line a few seconds after it begins.
        for (const ms of [800, 3000, 8000]) setTimeout(() => refreshThread.current(), ms);
        setEntries([]);
        setScreen(null);
        firstDelay.current = 500;
        setDockNonce((n) => n + 1);
        setGeneration((g) => g + 1);
      },
      (e) => {
        done();
        toast(`Not cleared: ${msg(e)}`);
      },
    );
  }

  // -- an image with the next message ---------------------------------------
  function takeImage(path: string) {
    const problem = attach.problem(path);
    if (problem) {
      toast(problem);
      return;
    }
    setImage(path);
  }

  const pickImage = async () => {
    let picked: string | string[] | null;
    try {
      picked = await openDialog({
        title: "Attach an image", multiple: false, directory: false,
        filters: [{ name: "Images", extensions: attach.PATTERNS.map((p) => p.slice(2)) }],
      });
    } catch (e) {
      toast(msg(e));
      return;
    }
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return; // cancelled
    takeImage(path);
  };

  /** The image goes to the computer first, then the message names its path there. */
  const sendWithImage = async (said: string, img: string) => {
    const t = targetRef.current!;
    setText("");
    setImage(null);
    try {
      const saved = (await api.attach(t[0], t[1], img)) as Dict;
      const message = attach.withImage(said, String(saved.path));
      await api.sessionAction(t[0], t[1], "say", { text: message });
      fleet.refresh();
      if (!same(targetRef.current, t)) return;
      stick.current = true;
      setEntries((prev) => model.withPending(prev, message));
      scheduleRef.current(300);
    } catch (e) {
      toast(`Not sent: ${msg(e)}`);
      if (!same(targetRef.current, t)) return;
      if (!textRef.current) setText(said);
      if (imageRef.current === null) setImage(img);
    }
  };

  const send = () => {
    const said = textRef.current.trim();
    if (imageRef.current && targetRef.current) {
      sendWithImage(said, imageRef.current);
      return;
    }
    if (!said || !targetRef.current) return;
    setText("");
    stick.current = true;
    setEntries((prev) => model.withPending(prev, said));
    act("say", { text: said });
  };

  // -- links in a message ----------------------------------------------------
  const copy = (value: string, said: string) => {
    navigator.clipboard.writeText(value).then(() => toast(said), (e) => toast(msg(e)));
  };

  /** Inline code is a `copy:` link: a click copies it. Real links open in the browser. */
  const onLink = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") || "";
    e.preventDefault();
    if (href.startsWith(COPY_SCHEME)) {
      let value = href.slice(COPY_SCHEME.length);
      try {
        value = decodeURIComponent(value);
      } catch {
        /* kept as written */
      }
      copy(value, copiedWord(value));
    } else if (/^https?:\/\//i.test(href)) {
      openUrl(href).catch((err) => toast(msg(err)));
    }
  };

  // -- drawing ---------------------------------------------------------------
  const box = inbox(fleet.rows, fleet.orch, config.MACHINES.map((m) => m.machine));
  const shown = layout(compact, target !== null, browsing);
  const row = target ? fleet.row(target[0], target[1]) : undefined;
  // With the crew hidden (lib/crewVisibility.ts), a conversation opened from a card that is not Cobra's is named
  // by its Space and skill, with no sprite; the list keeps Cobra only.
  const crewHidden = !showCrew && !!row && !row.lead;
  const confirm = newConfirm.current!;

  return (
    <div className={cls("agents", compact && "compact")}>
      {shown.side && (
        <div className="agents-side board-page">
          {box.starter && (
            <>
              <div className="list-head caps">LEAD</div>
              <div
                className="inbox-row clickable"
                title={`Start the Lead on ${config.label(box.starter)}`}
                onClick={() => startLead(box.starter!)}
              >
                <Sprite spec={crew.COBRA} colour={crew.LEAD_COLOR} state="away" size={36} />
                <div className="col grow" style={{ gap: 4 }}>
                  <div className="row">
                    <span className="btitle grow">{starting ? `Starting ${LEAD_NAME}…` : showCrew ? `Start ${LEAD_NAME}, the Lead` : `Start ${LEAD_NAME}`}</span>
                    <MachineDot machine={box.starter} />
                  </div>
                  <span className="dim ellipsis">{showCrew ? "Plans work with you and starts Workers in your projects." : "Plans work with you and does it in your Spaces."}</span>
                </div>
              </div>
            </>
          )}
          {visibleGroups(box.groups, showCrew).map(([title, members]) => (
            <div key={title}>
              <div className="list-head caps">{title}</div>
              {members.map((r) => (
                <InboxRow key={`${r.machine}:${r.session}`} r={r} selected={same(target, [r.machine, r.session])}
                  roster={r.foreman ? rosterLine(fleet.orch, r.machine, r.project?.parent ?? r.project?.id) : ""}
                  onClick={() => openConvo(r.machine, r.session)} />
              ))}
              {title === "WORKERS" &&
                box.queued.map(([machine, q]) => (
                  <div key={`${machine}:${q.id}`} className="inbox-row"
                    title="Waits for a free place or the budget; the agent starts it by itself.">
                    <div className="col grow" style={{ gap: 4 }}>
                      <div className="row">
                        <span className="btitle dim grow">{String(q.task ?? "")}</span>
                        <MachineDot machine={machine} />
                      </div>
                      <div className="row">
                        <span className="btime">{String(q.project || "")}</span>
                        <Status word="QUEUED" tone="muted" />
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}
      {shown.chat && (
        <div className={cls("agents-chat", dropping && "dropping")}>
          {!target ? (
            <div className="empty agents-empty">Pick an agent on the left.</div>
          ) : (
            <>
              <div className="chat-top">
                <div className="row grow" style={{ gap: 10, minWidth: 0 }}>
                  {/* Who this is (crew.ts): Cobra, a Foreman or a Worker, moving; nothing for anyone else. */}
                  {row && !crewHidden && <SpriteFor project={row.project} state={crew.spriteState(row.state, row.active)} size={40} animate />}
                  <div className="col grow" style={{ gap: 2 }}>
                    <div className="row" style={{ minWidth: 0 }}>
                      <span className="chat-title ellipsis">{crewHidden && row ? whoWords(places.ofRow(row)) : heard || (row ? row.displayName : target[1])}</span>
                      <Chip machine={target[0]} />
                      {/* The title is the header; the full branch is for git. */}
                      {row && row.isExtra && <span className="dim ellipsis">⎇ {row.branch}</span>}
                    </div>
                    <div className="row" style={{ gap: 10, minWidth: 0 }}>
                      <ChatStatus screen={screen} reachable={reachable} />
                      <span className="dim mono ellipsis">{modelLine(modelId)}</span>
                    </div>
                  </div>
                </div>
                <div className="row" style={{ gap: 4 }}>
                  {row?.lead && (
                    <button
                      type="button"
                      className={cls("btn", confirm.armed ? "danger" : "flat")}
                      disabled={confirm.busy}
                      title={confirm.armed ? `Clears the Lead's conversation. Click again within ${WINDOW_MS / 1000} seconds.` : undefined}
                      aria-label={confirm.armed ? "Click again to clear the Lead's conversation"
                        : confirm.busy ? "Clearing the Lead's conversation" : "New conversation"}
                      onClick={() => targetRef.current && confirm.press()}
                    >
                      {confirm.busy ? "Clearing…" : confirm.armed ? "Click again to clear" : "New conversation"}
                    </button>
                  )}
                  <Button kind="flat" disabled={!screen?.working} onClick={() => act("interrupt")}>Interrupt</Button>
                  <Button kind="flat" onClick={terminal}>Terminal</Button>
                </div>
                {compact && (
                  <button className="btn icon flat" title="Sessions" onClick={() => setBrowsing(true)}>☰</button>
                )}
              </div>
              <div className="chat-log" ref={scroller} onClick={onLink}>
                <div className="chat-log-inner">
                  {threadRows(history, model.rowsOf(entries)).slice(-200).map((r) => <LogRow key={String(r.id)} r={r} onCopy={copy} machine={leadMachine} toast={toast} />)}
                </div>
              </div>
              <DockView
                entries={entries} screen={screen} nonce={dockNonce}
                onAllow={(key, choice) => void allow(key, choice)} onAct={(a) => act(a)} onAnswer={answer} onTerminal={terminal}
              />
              <div className="compose">
                {image && (
                  <div className="attachment row">
                    <img src={convertFileSrc(image)} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
                    <span className="dim ellipsis" style={{ maxWidth: "40ch" }}>{image.split(/[\\/]/).pop()}</span>
                    <button className="btn icon flat round" title="Remove image" onClick={() => setImage(null)}>✕</button>
                  </div>
                )}
                <div className="row">
                  <button className="btn icon flat" title="Attach an image" onClick={pickImage}>＋</button>
                  <input
                    className="entry grow"
                    placeholder={`Message ${LEAD_NAME}…`}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
                    }}
                  />
                  <Button kind="primary" onClick={send}>Send</Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** One agent in the inbox: its sprite, its name on its own line (sharing one with the status
 * squeezed it to "Con…"), whose crew and what runs it, then when and its status word. */
function InboxRow({ r, selected, roster, onClick }: { r: model.Row; selected: boolean; roster: string; onClick: () => void }) {
  const [word, tone] = model.boardStatus(r);
  const title = r.lead || r.foreman ? model.agentName(r) : r.title;
  // A Foreman's roster after who it is (chatView.ts rosterLine).
  const kind = [crew.crewLabel(r.project), r.kindLine, roster].filter((x) => x).join(" · ");
  // The crew as sprites, still unless one needs you.
  const state = crew.spriteState(r.state, r.active);
  return (
    <div className={cls("inbox-row clickable", selected && "selected")} onClick={onClick}>
      <SpriteFor project={r.project} state={state} size={36} animate={state === "needs"} />
      <div className="col grow" style={{ gap: 4 }}>
        <div className="row">
          <span className="btitle grow">{title}</span>
          <MachineDot machine={r.machine} />
        </div>
        {kind && <span className="bdetail ellipsis">{kind}</span>}
        <div className="row">
          <span className="btime">{model.boardTime(r.project?.lastActivityAt)}</span>
          <Status word={word} tone={tone} />
        </div>
      </div>
    </div>
  );
}
