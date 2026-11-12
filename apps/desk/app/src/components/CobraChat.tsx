/**
 * Cobra's pane: the Lead's conversation, the way most people talk to her
 * each day (Home's left side, and the Cobra box on SUPER+SHIFT+J,
 * surfaces/CobraBox.tsx; the phone's components/CobraWindow.tsx). Her
 * messages, the dock that answers what she asks, and a box to tell her what to
 * do. With no Lead running it offers to start her. The full chat, with images
 * and New conversation, is the Org page's (pages/Agents.tsx), a click away on
 * her name. What it does beyond the agent's API comes in `env`, so it works in
 * the main window and in a small one alike.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as attach from "../lib/attach.ts";
import * as api from "../lib/api.ts";
import * as config from "../lib/config.ts";
import * as crew from "../lib/crew.ts";
import * as home from "../lib/home.ts";
import { currentDraft, takeDraft, useCobraDraft } from "../lib/cobraDraft.ts";
import { activityLine, chipWords, pickedSpace, spaceChoices, useShowCrew, withSpace } from "../lib/crewVisibility.ts";
import { usePlaces } from "./usePlaces.ts";
import * as model from "../lib/model.ts";
import { COPY_SCHEME } from "../lib/markdown.ts";
import { copiedWord } from "../lib/chatView.ts";
import { historyOf, threadRows } from "../lib/threadRules.ts";
import { useThread } from "./useThread.ts";
import { isDict, type Dict } from "../lib/json.ts";
import { allowOffer, allowWithScope, type ScopeChoice } from "../lib/allowScope.ts";
import { Button, Chip, cls } from "./ui.tsx";
import { DockView, LogRow } from "./Chat.tsx";
import { Sprite } from "./Sprite.tsx";
import { LEAD_NAME } from "../lib/appName.ts";

/** How many more rows are drawn each time an older page of her thread comes in. */
const OLDER_ROWS = 100;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the pane does that is not a request to the agent: the main window's, or a small window's through it. */
export interface CobraEnv {
  toast: (text: string) => void;
  /** Ask the fleet again, after an answer or a message. */
  refresh: () => void;
  /** The full conversation, on the Org page. */
  openChat: (machine: string, session: string) => void;
  /** Labels of the computers that do not answer. */
  away: ReadonlySet<string>;
  /** The fleet's rows and /orch/status, for the activity line and the Space chip while the crew is hidden. */
  rows?: readonly model.Row[];
  orch?: Record<string, Dict>;
}

const NO_ROWS: readonly model.Row[] = [];

/** `shown` is how many of the newest rows are drawn; `head` goes at the right of her head; `under` between her
 * messages and the box; `input` is the box, for a window that focuses it when shown. */
export function CobraChat({ lead, env, shown = 200, head, under, input }: {
  lead: model.Row | null; env: CobraEnv; shown?: number; head?: ReactNode; under?: ReactNode;
  input?: RefObject<HTMLInputElement | null>;
}) {
  const app = { toast: env.toast, openChat: env.openChat };
  const fleet = { refresh: env.refresh };
  const [entries, setEntries] = useState<Dict[]>([]);
  const [screen, setScreen] = useState<Dict | null>(null);
  const [reachable, setReachable] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [text, setText] = useState("");
  const [starting, setStarting] = useState(false);
  // The box, ours when the window gave none, so words asked for from another page (New Space) can take the keyboard.
  const own = useRef<HTMLInputElement>(null);
  const box = input ?? own;
  // With the crew hidden (lib/crewVisibility.ts): one activity line for the work under way, and the Space chip,
  // whose Space goes before what you send as "[Space: <name>] ".
  const show = useShowCrew();
  const places = usePlaces(env.rows ?? NO_ROWS, env.orch);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const space = pickedSpace(places.org, spaceId);
  const asked = useCobraDraft();
  useEffect(() => {
    const words = takeDraft();
    if (words === null) return;
    const named = currentDraft().space;
    if (named) setSpaceId(named);
    setText(words);
    const timer = setTimeout(() => box.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [asked.n, box]);
  const scheduleRef = useRef<(ms: number) => void>(() => {});
  const stick = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);
  const machine = lead?.machine ?? null;
  const session = lead?.session ?? null;
  // Her thread on the hub: the earlier conversations, faded, above the transcript's current one (lib/threadRules.ts).
  const thread = useThread(machine);
  const history = useMemo(() => historyOf(thread.entries, thread.current, Date.now()), [thread.entries, thread.current]);

  // The transcript, read from where the last read stopped, as often as the screen says (model.pollInterval).
  useEffect(() => {
    setEntries([]);
    setScreen(null);
    if (!machine || !session) return;
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
        schedule(model.pollInterval(s));
      } catch {
        if (dead) return;
        setReachable(false);
        schedule(4000);
      }
    };
    scheduleRef.current = schedule;
    schedule(0);
    return () => {
      dead = true;
      clearTimeout(timer);
      scheduleRef.current = () => {};
    };
  }, [machine, session]);

  // Older pages of her thread load as you scroll to the top; the row you were reading stays where it was.
  const [extra, setExtra] = useState(0);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const pinned = useRef(true);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
    if (el.scrollTop > 40 || anchor.current) return;
    anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    void thread.older().then((brought) => {
      if (brought) setExtra((n) => n + OLDER_ROWS);
      // Nothing drawn came of it (its rows were tool calls, say): let the next scroll to the top ask again.
      setTimeout(() => (anchor.current = null), 600);
    });
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    const from = anchor.current;
    if (!el || !from || el.scrollHeight === from.height) return;
    el.scrollTop = from.top + (el.scrollHeight - from.height);
    anchor.current = null;
  });

  // The newest message stays in view as more arrive, unless you scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || anchor.current) return;
    // Her thread can come in above after the transcript did: a pane read at its foot stays at its foot.
    if (stick.current || pinned.current) el.scrollTop = el.scrollHeight;
    stick.current = false;
  }, [entries, history]);

  const act = async (action: string, extra: Dict = {}) => {
    if (!machine || !session) return;
    try {
      await api.sessionAction(machine, session, action, extra);
      fleet.refresh();
      scheduleRef.current(300);
    } catch (e) {
      app.toast(msg(e));
    }
  };

  /** Allow the prompt the dock shows, bound to it by its key; a 409 means another replaced it. */
  const allow = async (key: string, choice: ScopeChoice | null = null) => {
    if (!machine || !session) return;
    try {
      const said = await allowWithScope(machine, session, key, allowOffer(isDict(screen) ? screen.request : null), choice);
      if (choice) app.toast(said);
      fleet.refresh();
      scheduleRef.current(300);
    } catch (e) {
      app.toast(e instanceof api.ApiError && e.status === 409 ? `Asking something else now: ${e.message}` : msg(e));
      setNonce((n) => n + 1);
      scheduleRef.current(0);
    }
  };

  // An image with the next message (+, or a photo dropped on her pane): it goes to her computer first, then the
  // message names its path there, as a conversation's does (lib/attach.ts, pages/Agents.tsx).
  const [image, setImage] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const takeImage = (path: string) => {
    const problem = attach.problem(path);
    if (problem) app.toast(problem);
    else setImage(path);
  };
  const pickImage = async () => {
    try {
      const picked = await openDialog({ title: `Send ${LEAD_NAME} an image`, multiple: false, directory: false, filters: [{ name: "Images", extensions: attach.PATTERNS.map((p) => p.slice(2)) }] });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (path) takeImage(path);
    } catch (e) {
      app.toast(msg(e));
    }
  };
  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        // Only the pane that is on screen takes it (Home and the Cobra box are separate windows; a hidden page is not).
        if (e.payload.type === "drop" && e.payload.paths.length && root.current?.offsetParent) takeImage(e.payload.paths[0]);
      })
      .then((f) => (gone ? f() : (off = f)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  const send = () => {
    const typed = text.trim();
    if ((!typed && !image) || !lead) return;
    const said = show ? typed : withSpace(typed, space?.name ?? null);
    setText("");
    stick.current = true;
    if (image && machine && session) {
      const img = image;
      setImage(null);
      void (async () => {
        try {
          const saved = (await api.attach(machine, session, img)) as Dict;
          const message = attach.withImage(said, String(saved.path));
          setEntries((prev) => model.withPending(prev, message));
          await act("say", { text: message });
        } catch (e) {
          app.toast(`Not sent: ${msg(e)}`);
          setText(typed);
          setImage(img);
        }
      })();
      return;
    }
    setEntries((prev) => model.withPending(prev, said));
    void act("say", { text: said });
  };

  const start = async () => {
    const m = config.MACHINES[0]?.machine;
    if (!m || starting) return;
    setStarting(true);
    try {
      await api.startLead(m);
      fleet.refresh();
    } catch (e) {
      app.toast(`${LEAD_NAME} did not start: ${msg(e)}`);
    } finally {
      setStarting(false);
    }
  };

  const copy = (value: string, said: string) => {
    navigator.clipboard.writeText(value).then(() => app.toast(said), (e) => app.toast(msg(e)));
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
      openUrl(href).catch((err) => app.toast(msg(err)));
    }
  };

  const away = new Set(env.away);
  if (!reachable && lead) away.add(lead.label);
  const status = home.leadStatus(lead, config.MACHINES.length, away, !!screen?.working);
  const rows = threadRows(history, model.rowsOf(entries)).slice(-(shown + extra));

  return (
    <div className="cobra" ref={root}>
      <div className="cobra-head">
        <Sprite spec={crew.COBRA} colour={crew.LEAD_COLOR} state={lead ? crew.spriteState(lead.state, lead.active) : "away"} size={40} animate={!!lead} />
        <button className="cobra-name" disabled={!lead} title={lead ? "Open the full conversation" : undefined}
          onClick={() => lead && app.openChat(lead.machine, lead.session)}>
          <span className="cobra-title">{LEAD_NAME}</span>
          <span className={cls("cobra-status", status === "Asks you something" && "lit")}>{status}</span>
        </button>
        <span className="spacer" />
        {lead && <Chip machine={lead.machine} />}
        {screen?.working && <Button kind="flat" small onClick={() => void act("interrupt")}>Stop</Button>}
        {head}
      </div>
      {!lead ? (
        <div className="cobra-empty">
          <p>{show ? `${LEAD_NAME} plans work with you, starts Workers in your projects and tells you what needs you.`
            : `${LEAD_NAME} plans work with you, does it in your Spaces and tells you what needs you.`}</p>
          {config.MACHINES.length > 0 && (
            <Button kind="primary" disabled={starting} onClick={() => void start()}>
              {starting ? `Starting ${LEAD_NAME}…` : `Start ${LEAD_NAME} on ${config.label(config.MACHINES[0].machine)}`}
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="cobra-log" ref={scroller} onClick={onLink} onScroll={onScroll}>
            <div className="cobra-log-inner">
              {!rows.length && <div className="cobra-quiet">{reachable ? `Say hello to ${LEAD_NAME}.` : `Waiting for ${LEAD_NAME}'s computer…`}</div>}
              {rows.map((r) => <LogRow key={String(r.id)} r={r} onCopy={copy} machine={machine} toast={app.toast} />)}
            </div>
          </div>
          <DockView entries={entries} screen={screen} nonce={nonce}
            onAllow={(key, choice) => void allow(key, choice)} onAct={(a) => void act(a)}
            onAnswer={(answers) => {
              setNonce((n) => n + 1);
              void act("answer", { answers });
            }} />
          {under}
          {!show && (
            <SpaceBar activity={activityLine(places.working)} choices={spaceChoices(places.org)} picked={space}
              open={picking} setOpen={setPicking} pick={(id) => (setSpaceId(id), setPicking(false), box.current?.focus())} />
          )}
          {image && (
            <div className="cobra-attachment">
              <img src={convertFileSrc(image)} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
              <span className="dim ellipsis">{image.split(/[\\/]/).pop()}</span>
              <button className="btn icon flat round" title="Remove image" onClick={() => setImage(null)}>✕</button>
            </div>
          )}
          <div className="cobra-compose">
            <button className="attach" title={`Send ${LEAD_NAME} an image (or drop one here)`} onClick={() => void pickImage()}>＋</button>
            <input ref={box} className="entry grow" placeholder={!show && space ? `Message ${LEAD_NAME} about ${space.name}…` : `Message ${LEAD_NAME}…`} value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && send()} />
            <button className="send" title="Send" disabled={!text.trim() && !image} onClick={send}>↑</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Over Cobra's box with the crew hidden: what she is working on, in one line naming Spaces (never the crew),
 * and the Space chip, "Space: All ▾", to say which Space a message is about. */
function SpaceBar({ activity, choices, picked, open, setOpen, pick }: {
  activity: string | null; choices: Array<{ id: string; name: string }>; picked: { id: string; name: string } | null;
  open: boolean; setOpen: (open: boolean) => void; pick: (id: string | null) => void;
}) {
  if (!activity && !choices.length) return null;
  return (
    <div className="cobra-spacebar">
      {choices.length > 0 && (
        <div className="space-chip-wrap">
          <button className={cls("space-chip", picked && "on")} aria-haspopup="listbox" aria-expanded={open}
            title="Which Space your message is about" onClick={() => setOpen(!open)}>
            {chipWords(picked?.name ?? null)}
          </button>
          {open && (
            <div className="space-chip-menu" role="listbox">
              <button role="option" aria-selected={!picked} className={cls(!picked && "on")} onClick={() => pick(null)}>All</button>
              {choices.map((c) => (
                <button key={c.id} role="option" aria-selected={picked?.id === c.id} className={cls(picked?.id === c.id && "on")}
                  onClick={() => pick(c.id)}>{c.name}</button>
              ))}
            </div>
          )}
        </div>
      )}
      {activity && <span className="cobra-activity dim ellipsis"><span className="cobra-activity-dot" />{activity}</span>}
    </div>
  );
}
