/**
 * A project's menu and the dialogs behind it, shared by the Projects board
 * (the ⋯ button and a right-click on a row), the project page, Ops and the
 * chat — the desk's ui/verbs.py, the phone's hold sheet. What the menu offers
 * is model.choicesFor; this only draws it and runs the pick.
 *
 *   const verbs = useVerbs();
 *   ...{verbs.node}  // render once, anywhere in the page
 *   <MenuDots onClick={(x, y) => verbs.menuAt(row, x, y)} />
 */
import { APP_NAME } from "../lib/appName.ts";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useApp } from "../app/context.ts";
import { allowMenu, allowOffer, confirmWords, type ScopeChoice } from "../lib/allowScope.ts";
import { isDict } from "../lib/json.ts";
import * as model from "../lib/model.ts";
import { loadPins, pinned, pinStore, togglePin } from "../lib/pins.ts";
import type { Dict } from "../lib/json.ts";
import { Button, Dialog, useMenu } from "./ui.tsx";

let pinsLoaded = false;

export interface Verbs {
  node: ReactNode;
  menuAt: (r: model.Row, x: number, y: number) => void;
  /** Allow once and the other ways the request offers (allowScope.ts allowMenu), for the Projects row's ▾. */
  allowMenuAt: (r: model.Row, x: number, y: number) => void;
  /** Whether the row's prompt offers more than once. */
  offersScopes: (r: model.Row) => boolean;
  run: (r: model.Row, action: string) => void;
  askPrompt: (r: model.Row) => void;
  askNewSession: (r: model.Row) => void;
  confirmKill: (r: model.Row) => void;
  confirmForget: (r: model.Row, then?: () => void) => void;
  pickTemplate: (r: model.Row) => void;
  /** `then` runs after the merge, success or not, so a page can read the repo again. */
  confirmMerge: (r: model.Row, pr: Dict, then?: () => void) => void;
  isPinned: (r: model.Row) => boolean | null;
}

export function useVerbs(): Verbs {
  const app = useApp();
  const a = app.actions;
  const [menu, openMenu] = useMenu();
  const [dialog, setDialog] = useState<ReactNode>(null);
  useSyncExternalStore(pinStore.subscribe, pinStore.version);
  useEffect(() => {
    if (!pinsLoaded) {
      pinsLoaded = true;
      loadPins();
    }
  }, []);
  const close = () => setDialog(null);

  const isPinned = (r: model.Row) => pinned(model.pinKey(r));

  const run = (r: model.Row, action: string) => {
    if (action === "open-page") return app.openProject(r.machine, r.id);
    if (action === "pin") {
      togglePin(model.pinKey(r) ?? "").then((now) => app.toast(now ? `Pinned ${r.displayName}` : `Unpinned ${r.displayName}`));
      return;
    }
    if (action === "new-session") return askNewSession(r);
    if (action === "start") return void a.start(r);
    if (action === "prompt") return askPrompt(r);
    if (action === "templates") return pickTemplate(r);
    if (action === "open-terminal") return void a.terminal(r);
    if (action === "open-chat") return app.openChat(r.machine, r.session);
    if (action === "resume-claude") return void a.resumeClaude(r);
    if (action === "approve") return void a.allow(r);
    if (action.startsWith("approve:")) {
      const entry = allowEntries(r).find((each) => each.action === action);
      if (entry?.choice) allowScoped(r, entry.choice);
      return;
    }
    if (action === "deny") return void a.dismiss(r);
    if (action === "interrupt") return void a.interrupt(r);
    if (action === "new-window") return void a.newWindow(r);
    if (action === "kill") return confirmKill(r);
    if (action === "forget") return confirmForget(r);
    if (action.startsWith("git-")) return void a.git(r.machine, r.id, action.slice(4), r.name);
  };

  const allowEntries = (r: model.Row) => allowMenu(allowOffer(isDict(r.project) ? r.project.request : null));
  const offersScopes = (r: model.Row) => allowEntries(r).length > 0;

  // A choice that writes the policy (this project, always) grants more: it asks first, as Settings → Permissions does.
  const allowScoped = (r: model.Row, choice: ScopeChoice) => {
    if (!choice.writes) return void a.allowScoped(r, choice);
    setDialog(
      <Confirm title={`${choice.label}?`} body={`${confirmWords(choice)}.\nThe host goes on ${choice.writes === "fleet" ? "the fleet's" : "this project's"} allowlist on every computer, as Settings → Permissions would write it.`}
        yes="Allow" onYes={() => void a.allowScoped(r, choice)} onClose={close} />,
    );
  };

  const menuAt = (r: model.Row, x: number, y: number) => {
    const scoped = allowEntries(r);
    openMenu(
      x,
      y,
      model.choicesFor(r, isPinned(r)).flatMap((c) =>
        c.action === "approve" && scoped.length
          ? scoped.map((entry) => ({ label: entry.label, danger: false, onClick: () => run(r, entry.action) }))
          : [{ label: c.label, danger: c.destructive, onClick: () => run(r, c.action) }],
      ),
    );
  };

  const allowMenuAt = (r: model.Row, x: number, y: number) =>
    openMenu(x, y, allowEntries(r).map((entry) => ({ label: entry.label, danger: false, onClick: () => run(r, entry.action) })));

  const askPrompt = (r: model.Row) => setDialog(<PromptDialog r={r} onClose={close} />);
  const askNewSession = (r: model.Row) => setDialog(<NewSessionDialog r={r} onClose={close} setDialog={setDialog} />);

  const confirmKill = (r: model.Row) => {
    const kept = r.parent ? " Its worktree stays until its branch is merged." : "";
    setDialog(
      <Confirm title={`Kill ${r.session} on ${r.label}?`} body={`The tmux session and everything running in it end now.${kept}`}
        yes="Kill" danger onYes={() => a.kill(r)} onClose={close} />,
    );
  };

  const confirmForget = (r: model.Row, then?: () => void) =>
    setDialog(
      <Confirm title={`Remove ${r.displayName} from the list?`}
        body={`Only the entry on ${r.label} goes. The folder and its git history stay, and it is offered again under New project → On this computer.`}
        yes="Remove" danger onYes={() => a.forget(r).then((ok) => ok && then?.())} onClose={close} />,
    );

  const pickTemplate = (r: model.Row) => {
    a.templates(r).then((found) => {
      if (!found.length) return app.toast(`No templates on ${r.label} (config/projects.json has none)`);
      setDialog(
        <Dialog title={`Run a template in ${r.displayName}`} onClose={close} buttons={<Button onClick={close}>Cancel</Button>}>
          <div className="dim">Starts the project's session if there is none, or a new session beside it if one is running.</div>
          <div className="col">
            {found.map((t) => (
              <Button key={String(t.id)} onClick={() => { close(); a.runTemplate(r, String(t.id), String(t.name || t.id)); }}>
                {String(t.name || t.id)}
              </Button>
            ))}
          </div>
        </Dialog>,
      );
    });
  };

  const confirmMerge = (r: model.Row, pr: Dict, then?: () => void) => {
    const checks = ({ green: "✓ checks passed", none: "no checks configured" } as Dict)[pr.checks] ?? `checks ${pr.checks}`;
    const mergeable = pr.mergeable === "MERGEABLE" ? "no conflicts" : String(pr.mergeable || "mergeability unknown").toLowerCase();
    // The head this row showed (model.mergeExtra): the agent merges nothing pushed after it.
    const merge = (force: boolean) => a.git(r.machine, r.id, "merge-pr", r.name, model.mergeExtra(pr, force)).then(() => then?.());
    const agree = model.checksAgree(pr);
    setDialog(
      <Confirm
        title={`Merge #${pr.number}?`}
        body={`${pr.title}\n${pr.head} → ${pr.base}\n${checks} · ${mergeable}`}
        yes={agree ? "Squash and merge" : "Merge anyway"}
        danger={!agree}
        onClose={close}
        onYes={() => {
          if (agree) return void merge(false);
          // Red or running checks: the agent refuses without `force`, sent only after a second ask.
          const failing = pr.checks === "red";
          setTimeout(() =>
            setDialog(
              <Confirm title={`Merge #${pr.number} without green checks?`}
                body={failing ? "Its checks are failing. Merging lands that commit on main as it is."
                  : "Its checks have not finished. Merging lands that commit on main before they do."}
                yes="Merge anyway" danger onYes={() => merge(true)} onClose={close} />,
            ),
          );
        }}
      />,
    );
  };

  return {
    node: (
      <>
        {menu}
        {dialog}
      </>
    ),
    menuAt, allowMenuAt, offersScopes, run, askPrompt, askNewSession, confirmKill, confirmForget, pickTemplate, confirmMerge, isPinned,
  };
}

/** The ⋯ button that opens a row's menu. */
export function MenuDots({ onOpen, title, label }: { onOpen: (x: number, y: number) => void; title?: string; label?: string }) {
  return (
    <button
      className="btn small flat"
      title={title ?? "More (or right-click the row)"}
      onClick={(e) => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        onOpen(r.left, r.bottom + 4);
      }}
    >
      {label ?? "⋯"}
    </button>
  );
}

export function Confirm({ title, body, yes, danger, onYes, onClose }: {
  title: string; body: string; yes: string; danger?: boolean; onYes: () => void; onClose: () => void;
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      buttons={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button kind={danger ? "danger" : "primary"} onClick={() => { onClose(); onYes(); }}>{yes}</Button>
        </>
      }
    >
      <div className="dim" style={{ whiteSpace: "pre-wrap" }}>{body}</div>
    </Dialog>
  );
}

function PromptDialog({ r, onClose }: { r: model.Row; onClose: () => void }) {
  const { actions } = useApp();
  const [text, setText] = useState("");
  const go = () => {
    onClose();
    // An empty prompt is a plain start, as on the phone.
    if (text.trim()) actions.startWithPrompt(r, text.trim());
    else actions.start(r);
  };
  return (
    <Dialog title={`Start ${r.displayName}`} onClose={onClose}
      buttons={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={go}>Start</Button></>}>
      <div className="dim">{APP_NAME} starts on {r.label} and gets this prompt.</div>
      <input className="entry" autoFocus placeholder={`What should ${APP_NAME} do?`} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go()} />
    </Dialog>
  );
}

function NewSessionDialog({ r, onClose, setDialog }: { r: model.Row; onClose: () => void; setDialog: (n: ReactNode) => void }) {
  const { actions } = useApp();
  const [prompt, setPrompt] = useState("");
  const [branch, setBranch] = useState("");
  // Claude unless the computer serves Ollama models or Codex; the choice appears once /capabilities answers.
  const [choices, setChoices] = useState<Array<[string, string]>>([["claude", "Claude"]]);
  const [onPi, setOnPi] = useState(false);
  const [selected, setSelected] = useState("claude");
  const [claudeCode, setClaudeCode] = useState(false);
  useEffect(() => {
    actions.localModels(r).then(({ choices: found, pi, codex }) => {
      setOnPi(pi);
      setChoices([["claude", "Claude"], ...(codex ? [["codex", "Codex"] as [string, string]] : []), ...found.map(([n, t]) => [`local:${n}`, t] as [string, string])]);
    });
  }, [actions, r]);
  const local = selected.startsWith("local:") ? selected.slice(6) : "";
  const engine = selected === "codex" ? "codex" : "claude";
  const harness = local && onPi && claudeCode ? "claude" : null;
  const go = () => {
    onClose();
    const opts = { prompt: prompt.trim(), branch: branch.trim(), localModel: local, harness, engine };
    actions.newSession(r, opts, (message) =>
      setDialog(
        <Confirm title="Start another session?" body={message} yes="Start anyway" onClose={() => setDialog(null)}
          onYes={() => actions.newSession(r, { ...opts, overCap: true })} />,
      ),
    );
  };
  return (
    <Dialog title={`New session in ${r.displayName}`} onClose={onClose}
      buttons={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={go}>Start</Button></>}>
      <div className="dim">Another {APP_NAME} session on {r.label}, in its own worktree on a new branch from origin/main.</div>
      <input className="entry" autoFocus placeholder={`What should ${APP_NAME} do? (optional)`} value={prompt}
        onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
      <input className="entry mono" placeholder="Branch (optional: named from the prompt)" value={branch} onChange={(e) => setBranch(e.target.value)} />
      {choices.length > 1 && (
        <div className="row">
          <span className="dim">Model</span>
          <select className="entry grow" value={selected} onChange={(e) => setSelected(e.target.value)}>
            {choices.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
        </div>
      )}
      {onPi && local && (
        <label className="col" style={{ gap: 2 }}>
          <span className="row"><input type="checkbox" checked={claudeCode} onChange={(e) => setClaudeCode(e.target.checked)} />{model.PI_SWITCH}</span>
          <span className="dim">{model.PI_SWITCH_HINT}</span>
        </label>
      )}
    </Dialog>
  );
}
