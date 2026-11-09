/**
 * Cobra's popup — one card, top right, in her voice ("These 3 need you."),
 * listing everything that waits on you with its answer on it: Allow / Deny /
 * Open chat, until answered (it began as the desk's ui/popup.py, a stack of
 * Omarchy notifications). Rounded like the phone's cards, Cobra's sprite on
 * its head with how long the oldest has waited, lit after ten minutes.
 *
 * Three kinds of item: a Claude session waiting on a dialog, an approval the
 * Lead or a Foreman asked for (a merge, Workers on another computer, an email,
 * files for your Drive, a note: an action shows exactly what Allow sends), and
 * a computer listening on your network, each with its kind word (PERMISSION,
 * QUESTION, APPROVE, EMAIL, FILES, NOTE, LAN…) and its age.
 *
 * A new item joins the card instead of stacking a new one. The newest (or the
 * one opened with "Details ▸") is drawn in full, the rest compact, scrolling
 * inside the screen's height. ✕ on an item takes it off the card and ✕ on the
 * card hides what it lists; either keeps waiting on Home, and an item leaves
 * for good only when it is answered somewhere. Which items are drawn, and how,
 * is lib/popupLayout.ts's.
 *
 * The main window owns the poller and sends `popup-add` / `popup-remove`; this
 * window measures its column after each render and asks the Rust side to fit
 * it (bridge.popupLayout; 0 hides it).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import * as config from "../lib/config.ts";
import * as model from "../lib/model.ts";
import * as pl from "../lib/popupLayout.ts";
import { isDict, nowS, type Dict } from "../lib/json.ts";
import { allowOffer } from "../lib/allowScope.ts";
import { ScopeChoices } from "../components/ScopeChoices.tsx";
import { bridge } from "../lib/bridge.ts";
import { onSnapshot, toMain, type PopupCard } from "../lib/surfaces.ts";
import { needsKind, needsLine, oneLine, tailOf } from "../lib/popupCards.ts";
import * as act from "../lib/windowActions.ts";
import { Button, Chip, cls, RequestView } from "../components/ui.tsx";
import { Sprite } from "../components/Sprite.tsx";
import * as crew from "../lib/crew.ts";
import { useShowCrew } from "../lib/crewVisibility.ts";
import { ActionCard } from "../components/ActionCard.tsx";
import { actionView } from "../lib/approvalAction.ts";
import { routineApprovalView } from "../lib/routines.ts";
import { taintNote, trustApprovalView } from "../lib/trust.ts";
import { sitePreview, sitePreviewLabel } from "../lib/site.ts";
import { openUrl } from "@tauri-apps/plugin-opener";
import "../styles/surfaces.css";
import { LEAD_NAME } from "../lib/appName.ts";

// The exact request opens in a box this tall at most, and scrolls.
const EXACT_HEIGHT = 160;
// Room on the card for its head.
const CHROME = 64;

/** An action on a card: its words, what it does, its style. */
type Action = [string, () => void, "primary" | "danger" | "flat" | undefined];

interface Card {
  key: string;
  kind: string; // PERMISSION, QUESTION, TRUST, MODEL, WAITING, APPROVE, EMAIL, FILES, NOTE, LAN
  signal: boolean; // the signal border: an approval or a LAN alert
  title: string;
  machine: string;
  line: string; // the compact card's one line
  body: () => ReactNode;
  actions: Action[];
  compactActions: Action[];
  hideTip: string;
}

interface Stack {
  sent: Record<string, PopupCard>;
  order: string[]; // newest first
  since: Record<string, number>; // when each card first came, kept while it stays
  hidden: Set<string>;
  expanded: string | null;
}

const EMPTY: Stack = { sent: {}, order: [], since: {}, hidden: new Set(), expanded: null };

function put(st: Stack, card: PopupCard): Stack {
  const isNew = !(card.key in st.sent);
  return {
    ...st,
    sent: { ...st.sent, [card.key]: card },
    order: pl.place(st.order, card.key),
    since: card.key in st.since ? st.since : { ...st.since, [card.key]: card.at || nowS() },
    // A new card is the one drawn in full.
    expanded: isNew ? null : st.expanded,
  };
}

/** The card's dialog was answered (here, on the phone, in a terminal): it goes for good. */
function drop(st: Stack, key: string): Stack {
  if (!(key in st.sent)) return st;
  const sent = { ...st.sent };
  delete sent[key];
  const since = { ...st.since };
  delete since[key];
  const hidden = new Set(st.hidden);
  hidden.delete(key);
  const order = st.order.filter((k) => k !== key);
  return { sent, order, since, hidden, expanded: st.expanded === key ? null : st.expanded };
}

export function PopupSurface() {
  const [st, setSt] = useState<Stack>(EMPTY);
  const showCrew = useShowCrew();
  const [now, setNow] = useState(nowS());
  const [, setMachines] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const { sent, order, since, hidden, expanded } = st;
  const remove = (key: string) => setSt((s) => drop(s, key));

  useEffect(() => {
    document.body.classList.add("surface-popup");
    const offs = [
      listen<PopupCard>("popup-add", (e) => {
        setSt((s) => put(s, e.payload));
        setNow(nowS());
      }),
      listen<string>("popup-remove", (e) => remove(e.payload)),
      // The computers' names and hues come with every snapshot.
      onSnapshot((snap) => {
        config.setMachines(snap.machines);
        setMachines((v) => v + 1);
      }),
    ];
    bridge.computers().then((found) => {
      config.setMachines(found);
      setMachines((v) => v + 1);
    }).catch(() => {});
    // Every 30 s: the ages move on and light up after ten minutes.
    const tick = setInterval(() => setNow(nowS()), 30_000);
    return () => {
      clearInterval(tick);
      offs.forEach((p) => p.then((f) => f()));
    };
  }, []);

  // After every render: the column's height to the Rust side, which sizes and places the window.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const report = () => {
      bridge.popupLayout(listed ? Math.ceil(el.getBoundingClientRect().height) : 0).catch(() => {});
    };
    report();
    const watch = new ResizeObserver(report);
    watch.observe(el);
    return () => watch.disconnect();
  });

  const then = (key: string, fn: () => void) => () => {
    remove(key);
    fn();
  };
  const hide = (key: string) =>
    setSt((s) => ({ ...s, hidden: new Set(s.hidden).add(key), expanded: s.expanded === key ? null : s.expanded }));
  const hideAll = (keys: string[]) => setSt((s) => ({ ...s, hidden: new Set([...s.hidden, ...keys]), expanded: null }));
  const setExpanded = (key: string) => setSt((s) => ({ ...s, expanded: key }));

  const cards: Record<string, Card> = {};
  for (const key of order) if (sent[key]) cards[key] = build(sent[key], then, showCrew);
  const keys = order.filter((k) => cards[k]);
  const listed = keys.some((k) => !hidden.has(k));
  // The tallest the cards may be: the screen less the margins and the bar.
  const maxHeight = pl.maxHeight(window.screen.availHeight || 800) - CHROME;

  const age = (key: string) => {
    const seconds = now - (since[key] ?? now);
    return <span className={cls("popup-age", pl.stale(seconds) && "stale")}>{pl.age(seconds)}</span>;
  };
  const close = (c: Card) => (
    <button className="btn flat popup-close" title={c.hideTip} onClick={() => hide(c.key)}>✕</button>
  );
  const buttons = (actions: Action[], extra?: ReactNode) => (
    <div className="popup-buttons">
      {actions.map(([text, fn, kind]) => (
        <Button key={text} kind={kind} onClick={fn}>{text}</Button>
      ))}
      {extra}
    </div>
  );
  const full = (c: Card) => (
    <div key={c.key} className={cls("popup-card", c.signal && "popup-approval")}>
      <div className="popup-head">
        <span className="popup-kind">{c.kind}</span>
        <Chip machine={c.machine} />
        <span className="spacer" />
        {age(c.key)}
        {close(c)}
      </div>
      <div className="n-title clamp-2">{c.title}</div>
      {c.body()}
      {buttons(c.actions)}
    </div>
  );
  const compact = (c: Card) => (
    <div key={c.key} className={cls("popup-card", c.signal && "popup-approval", "compact")}>
      <div className="popup-head">
        <span className="popup-kind">{c.kind}</span>
        <span className="n-title ellipsis">{c.title}</span>
        <Chip machine={c.machine} />
        <span className="spacer" />
        {age(c.key)}
        {close(c)}
      </div>
      {c.line && <div className="n-line ellipsis">{c.line}</div>}
      {buttons(c.compactActions, (
        <>
          <span className="spacer" />
          <button className="btn flat popup-link" onClick={() => setExpanded(c.key)}>Details ▸</button>
        </>
      ))}
    </div>
  );

  const lay = pl.layout(keys, hidden, expanded);
  const list = pl.drawn(lay);
  const [words, oldest] = pl.head(lay, since, now);
  const waited = Math.max(0, ...list.map((k) => now - (since[k] ?? now)));
  const content = list.length ? (
    <div className="popup-cobra">
      <div className="popup-cobra-head">
        <Sprite spec={crew.COBRA} colour={crew.LEAD_COLOR} state="needs" size={30} animate />
        <div className="popup-cobra-words grow">
          <span className="popup-cobra-name">{LEAD_NAME}</span>
          <span className="popup-cobra-line">{words}</span>
        </div>
        <span className={cls("popup-age", pl.stale(waited) && "stale")}>{oldest}</span>
        <button className="btn flat popup-close" title="Hide — they keep waiting on Home" onClick={() => hideAll(list)}>✕</button>
      </div>
      <div className="popup-scroll" style={{ maxHeight }}>
        {list.map((k) => (k === lay.full ? full(cards[k]) : compact(cards[k])))}
      </div>
    </div>
  ) : null;
  return <div className="popup" ref={root}>{content}</div>;
}

/** A card from what the main window sent: its words, its body and its buttons. */
function build(sent: PopupCard, then: (key: string, fn: () => void) => () => void, showCrew: boolean): Card {
  const key = sent.key;
  const machine = sent.machine;
  if (sent.kind === "approval") {
    // What the Lead asked and only you may allow. Allow on a merge squash-merges each PR at the
    // commit shown, once its checks are green (the agent's approvals.ts).
    const approval: Dict = sent.approval ?? {};
    const text = String(approval.body || "");
    // A Foreman's action (an email, files, a note): exactly what Allow sends, field by field; a routine: when,
    // its first run and its brief; trust: who, the templates and the cards it was, with Trust and Keep asking.
    const action = actionView(approval) ?? routineApprovalView(approval) ?? trustApprovalView(approval);
    const allow: Action = [action?.yes ?? "Allow", then(key, () => act.answerApproval(machine, approval, true)), "primary"];
    const deny: Action = [action?.no ?? "Deny", then(key, () => act.answerApproval(machine, approval, false)), "danger"];
    // A website card: its version's own address, to look at before Allow puts it live (a domain card: the website as it is).
    const preview = sitePreview(approval);
    const look: Action[] = preview ? [[sitePreviewLabel(approval), () => void openUrl(preview), "flat"]] : [];
    return {
      key, kind: action ? action.word : "APPROVE", signal: true, title: String(approval.title || "Approve?"), machine,
      line: action ? action.fields.map(([k, v]) => `${k} ${v}`).join(" · ") || oneLine(action.text) : oneLine(text),
      // A card from a turn that read text from outside says why it asks; a plain card's body already ends with it.
      body: () => (action ? <>
        {taintNote(approval) && <div className="n-line">{taintNote(approval)}</div>}
        <ActionCard view={action} compact />
      </> : text ? <div className="n-body clamp-6">{text}</div> : null),
      actions: [allow, deny, ...look, ["Open Home", then(key, () => void toMain({ kind: "show", page: "ops" })), "flat"]],
      compactActions: [allow, deny],
      hideTip: "Hide — it keeps waiting on Home",
    };
  }
  // A session waiting on a dialog.
  const row = model.rowForProject(sent.project ?? {}, machine);
  const tail = tailOf(row);
  const request = row.request;
  const openChat = then(key, () => void toMain({ kind: "open-chat", machine: row.machine, session: row.session }));
  const actions: Action[] = [];
  const compactActions: Action[] = [];
  // Other ways to allow a Worker's prompt (lib/allowScope.ts), under the request on the full card.
  const offer = row.dialog === "permission" ? allowOffer(isDict(row.project) ? row.project.request : null) : null;
  if (row.dialog === "permission") {
    const allow: Action = [offer ? "Allow once" : "Allow", then(key, () => act.allow(row)), "primary"];
    const deny: Action = ["Deny", then(key, () => act.deny(row)), "danger"];
    actions.push(allow, deny);
    compactActions.push(allow, deny);
  } else {
    compactActions.push(["Open chat", openChat, "primary"]);
  }
  actions.push(["Open chat", openChat, undefined], ["Terminal", then(key, () => act.terminal(row)), "flat"]);
  return {
    // With the crew hidden (lib/crewVisibility.ts) the Space and skill that asks, or Cobra, never a Foreman or Worker.
    key, kind: needsKind(row.dialog), signal: false, title: !showCrew && sent.who ? sent.who : row.displayName, machine, line: needsLine(row),
    // The request in plain words when the agent sends it; else the screen's last lines.
    body: () => (
      <>
        {request
          ? <RequestView request={request as unknown as Dict} full={false} exactHeight={EXACT_HEIGHT} />
          : tail.length ? <div className="tail clamp-4">{tail.slice(-3).join(" ")}</div> : null}
        <ScopeChoices offer={offer} onAllow={(choice) => then(key, () => void act.allowScoped(row, choice))()} />
      </>
    ),
    actions, compactActions,
    hideTip: "Hide — the session keeps waiting",
  };
}
