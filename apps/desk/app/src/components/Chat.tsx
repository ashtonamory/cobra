/**
 * A conversation's parts, shared by the Org page's chat (pages/Agents.tsx) and
 * Cobra's pane on Home (components/CobraChat.tsx): the status line, a row of
 * the log (a bubble, a tool card, a question), and the dock that answers
 * whatever dialog waits on you.
 */
import { useEffect, useState } from "react";
import { bridge } from "../lib/bridge.ts";
import type { DesignFile } from "../lib/threadRules.ts";
import { APP_NAME } from "../lib/appName.ts";
import * as model from "../lib/model.ts";
import { segments, toHtml } from "../lib/markdown.ts";
import { commandText, dockOf, toolCard } from "../lib/chatView.ts";
import { isDict, type Dict } from "../lib/json.ts";
import { allowOffer, type ScopeChoice } from "../lib/allowScope.ts";
import { Button, RequestView, cls } from "./ui.tsx";
import { ScopeChoices } from "./ScopeChoices.tsx";

export function modelLine(m: { model: string; effort: string | null } | null): string {
  const name = model.modelName(m?.model);
  return name && m?.effort ? `${name} · ${m.effort}` : name;
}

export function ChatStatus({ screen, reachable }: { screen: Dict | null; reachable: boolean }) {
  const [text, tone] = model.statusOf(screen, reachable);
  return <span className={cls("dim ellipsis", tone === "warn" && "warning", tone === "ok" && "success")}>{text}</span>;
}

/**
 * A row of a conversation's log. `machine` is the computer the thread came from (the hub), which a
 * designs row fetches its images from; `toast` says where a saved one went.
 */
export function LogRow({ r, onCopy, machine, toast }: { r: Dict; onCopy: (value: string, said: string) => void; machine?: string | null; toast?: (message: string) => void }) {
  // From Cobra's thread (lib/threadRules.ts): the line over a conversation, and what was said in an earlier one (faded) or a digest.
  if (r.kind === "marker") return <div className={cls("thread-marker", r.earlier && "earlier")}>{String(r.label ?? "")}</div>;
  if (r.kind === "designs") {
    return (
      <div className={cls("thread-said", r.earlier && "earlier")}>
        <Designs machine={machine ?? null} text={String(r.text ?? "")} files={(r.files as DesignFile[]) ?? []} onCopy={onCopy} toast={toast} />
      </div>
    );
  }
  if (r.kind === "said") {
    const body = String(r.text ?? "");
    return (
      <div className={cls("thread-said", r.earlier && "earlier")}>
        {r.who === "you"
          ? <div className="bubble bubble-user md-flow selectable" dangerouslySetInnerHTML={{ __html: toHtml(body) }} />
          : <Assistant body={body} onCopy={onCopy} />}
      </div>
    );
  }
  // A line the agent typed into the session for her (lib/threadRules.ts cobraNote): a quiet note, never the person's message.
  if (r.kind === "note") return <div className="thread-note dim selectable">{String(r.text ?? "")}</div>;
  if (r.kind === "text") {
    if (r.role !== "user") return <Assistant body={String(r.text ?? "")} onCopy={onCopy} />;
    return (
      <div className={cls("bubble bubble-user md-flow selectable", r.pending && "bubble-pending")}
        dangerouslySetInnerHTML={{ __html: toHtml(String(r.text ?? "")) }} />
    );
  }
  if (r.kind === "command") return <div className="toolrun selectable pre">{commandText(r)}</div>;
  if (r.kind === "tools") {
    const card = toolCard(r.tools as Dict[]);
    // Ellipsized, or one long command sets the whole column's width and the conversation runs off
    // the side of the window.
    return (
      <details className="toolrun">
        <summary className="ellipsis">{card.head}</summary>
        <div className="mono dim selectable pre">{card.lines.join("\n")}</div>
      </details>
    );
  }
  // an AskUserQuestion, answered or still open
  const tool = (r.tool as Dict) || {};
  const qs = (tool.questions as Dict[]) || [];
  const answers = (tool.answers as Dict) || {};
  return (
    <div className="question asked">
      {qs.map((q, i) => (
        <div key={i} className="col" style={{ gap: 4 }}>
          <div className="heading">{String(q.question ?? "")}</div>
          {q.question in answers && <div className="dim">→ {String(answers[q.question])}</div>}
        </div>
      ))}
      {tool.status === "running" && !Object.keys(answers).length && <div className="dim">waiting for your answer below</div>}
    </div>
  );
}

/** The agent's message as a stack: prose, and each fenced code block as its own box with a Copy
 * button in the corner. Links carry a ⧉ that copies them and inline code copies on a click. */
/** Each design once per run: the thread draws it again on every read. A failed fetch is forgotten, so a click tries again. */
const designs = new Map<string, Promise<string>>();

function designUrl(machine: string, file: DesignFile): Promise<string> {
  const key = `${machine}:${file.path}:${file.bytes}`;
  let found = designs.get(key);
  if (!found) {
    found = bridge.designImage(machine, file.path);
    found.catch(() => designs.delete(key));
    designs.set(key, found);
  }
  return found;
}

/**
 * Designs a Designer showed in Cobra's thread (agent designer.ts `designs_show`): what it said, then
 * the PNGs, fetched from the hub; a click opens one large with Save to Pictures. Posting is the person's.
 */
function Designs({ machine, text, files, onCopy, toast }: { machine: string | null; text: string; files: DesignFile[]; onCopy: (value: string, said: string) => void; toast?: (message: string) => void }) {
  const [open, setOpen] = useState<DesignFile | null>(null);
  return (
    <div className="designs">
      {text.trim() ? <Assistant body={text} onCopy={onCopy} /> : null}
      <div className={cls("designs-grid", files.length > 1 && "two")}>
        {files.map((file) => <DesignTile key={file.path} machine={machine} file={file} onOpen={() => setOpen(file)} />)}
      </div>
      <div className="designs-hint dim">Click one to save it to Pictures, then post it yourself.</div>
      {open && machine ? <DesignLarge machine={machine} file={open} close={() => setOpen(null)} toast={toast} /> : null}
    </div>
  );
}

export function useDesignUrl(machine: string | null, file: DesignFile, tries: number): { url: string | null; failed: string | null } {
  const [state, setState] = useState<{ url: string | null; failed: string | null }>({ url: null, failed: null });
  useEffect(() => {
    if (!machine) return;
    let current = true;
    setState((s) => ({ url: s.url, failed: null }));
    designUrl(machine, file)
      .then((url) => current && setState({ url, failed: null }))
      .catch((e) => current && setState({ url: null, failed: (e as { message?: string })?.message ?? String(e) }));
    return () => {
      current = false;
    };
  }, [machine, file, tries]);
  return state;
}

function DesignTile({ machine, file, onOpen }: { machine: string | null; file: DesignFile; onOpen: () => void }) {
  const [tries, setTries] = useState(0);
  const { url, failed } = useDesignUrl(machine, file, tries);
  return (
    <button
      className="design-tile"
      // Never taller than a post's 4:5: a website concept's whole page shows its top (the phone's threadRules designTileHeight).
      style={{ aspectRatio: `${file.width} / ${Math.min(file.height, (file.width * 5) / 4)}` }}
      title={failed ? `Could not load ${file.name}: ${failed}. Click to try again.` : file.name}
      onClick={failed ? () => setTries((n) => n + 1) : url ? onOpen : undefined}
    >
      {url ? <img src={url} alt={file.name} /> : <span className="dim">{failed ? "Could not load. Click to try again." : machine ? "Loading…" : file.name}</span>}
    </button>
  );
}

function DesignLarge({ machine, file, close, toast }: { machine: string; file: DesignFile; close: () => void; toast?: (message: string) => void }) {
  const { url } = useDesignUrl(machine, file, 0);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const where = await bridge.designSave(machine, file.path, file.name);
      toast?.(`Saved to ${where}`);
    } catch (e) {
      toast?.(`Could not save: ${(e as { message?: string })?.message ?? String(e)}`);
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <div className="design-overlay" onClick={close}>
      <div className="design-large" onClick={(e) => e.stopPropagation()}>
        {!url ? (
          <span className="dim">Loading…</span>
        ) : file.height > file.width * 2 ? (
          // A whole page scrolls at a readable width rather than shrinking to fit.
          <div className="design-large-scroll">
            <img src={url} alt={file.name} style={{ width: Math.min(file.width, 720) }} />
          </div>
        ) : (
          <img src={url} alt={file.name} />
        )}
        <div className="design-large-foot">
          <span className="dim ellipsis">{`${file.name} · ${file.width} × ${file.height}`}</span>
          <Button kind="flat" onClick={close}>Close</Button>
          <Button disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save to Pictures"}</Button>
        </div>
      </div>
    </div>
  );
}

export function Assistant({ body, onCopy }: { body: string; onCopy: (value: string, said: string) => void }) {
  return (
    <div className="bubble bubble-assistant">
      {segments(body).map(([kind, value], i) =>
        kind === "code" ? (
          <div key={i} className="codeblock">
            <button className="codecopy" title="Copy this code" onClick={() => onCopy(value, "Code copied")}>⧉ Copy</button>
            <div className="mono code selectable pre">{value}</div>
          </div>
        ) : (
          <div key={i} className="md-flow selectable" dangerouslySetInnerHTML={{ __html: value }} />
        ),
      )}
    </div>
  );
}

// -- the dock: whatever is waiting on you ----------------------------------------------------------

export function DockView({ entries, screen, nonce, onAllow, onAct, onAnswer, onTerminal }: {
  entries: Dict[]; screen: Dict | null; nonce: number;
  /** Allow once (choice null), or for one of the request's scopes (lib/allowScope.ts). */
  onAllow: (key: string, choice: ScopeChoice | null) => void; onAct: (action: string) => void; onAnswer: (answers: Dict[]) => void; onTerminal: () => void;
}) {
  const d = dockOf(entries, screen);
  if (!d.dialog) return null;
  const key = `${d.key}:${nonce}`;
  if (d.dialog === "permission") {
    const offer = allowOffer(isDict(screen) ? screen.request : null);
    return (
      <div className="dock" key={key}>
        <div className="dialog-banner col">
          <div className="heading">{APP_NAME} wants permission</div>
          {d.request ? <RequestView request={d.request as unknown as Dict} /> : <div className="tail selectable pre">{d.tail}</div>}
          <div className="row">
            <Button kind="primary" onClick={() => onAllow(model.dialogKey(screen), null)}>{offer ? "Allow once" : "Allow"}</Button>
            <Button kind="danger" onClick={() => onAct("deny")}>Deny</Button>
          </div>
          <ScopeChoices offer={offer} onAllow={(choice) => onAllow(model.dialogKey(screen), choice)} />
        </div>
      </div>
    );
  }
  if (d.dialog === "trust") {
    return (
      <div className="dock" key={key}>
        <div className="dialog-banner col">
          <div className="heading">{APP_NAME} asks whether to trust this folder</div>
          <div className="row">
            <Button kind="primary" onClick={() => onAct("trust")}>Trust folder</Button>
            <Button onClick={onTerminal}>Open terminal</Button>
          </div>
        </div>
      </div>
    );
  }
  if (d.dialog === "question" && d.active) {
    return (
      <div className="dock" key={key}>
        <QuestionPanel active={d.active} onAnswer={onAnswer} />
      </div>
    );
  }
  return (
    <div className="dock" key={key}>
      <div className="dialog-banner col">
        <div className="heading">A dialog is open that this view can't drive.</div>
        <div className="row">
          <Button onClick={onTerminal}>Open terminal</Button>
          <Button onClick={() => onAct("deny")}>Dismiss</Button>
        </div>
      </div>
    </div>
  );
}

export function QuestionPanel({ active, onAnswer }: { active: Dict; onAnswer: (answers: Dict[]) => void }) {
  const q = active.question as Dict;
  const [checked, setChecked] = useState<boolean[]>([]);
  const [other, setOther] = useState("");
  const opts = (q.options as Dict[]) || [];
  return (
    <div className="question col">
      {q.header && <div className="caps">{String(q.header).toUpperCase()}</div>}
      <div className="heading">{String(q.question ?? "")}</div>
      {active.submit ? (
        <div className="row">
          <Button kind="primary" onClick={() => onAnswer([{ question: "Ready to submit your answers?", option: 1 }])}>
            Submit answers
          </Button>
        </div>
      ) : (
        <>
          {q.multiSelect ? (
            <>
              {opts.map((o, i) => (
                <label key={i} className="col check" style={{ gap: 2 }}>
                  <span className="row">
                    <input type="checkbox" checked={!!checked[i]}
                      onChange={(e) => setChecked((c) => Object.assign([...c], { [i]: e.target.checked }))} />
                    {String(o.label)}
                  </span>
                  {o.description && <span className="dim">{String(o.description)}</span>}
                </label>
              ))}
              <div className="row">
                <Button kind="primary" onClick={() => onAnswer([{
                  question: q.question, options: opts.map((_, i) => i + 1).filter((n) => checked[n - 1]),
                }])}>Send answers</Button>
              </div>
            </>
          ) : (
            opts.map((o, i) => (
              <button key={i} className="btn option" onClick={() => onAnswer([{ question: q.question, option: i + 1 }])}>
                <div>{String(o.label)}</div>
                {o.description && <div className="dim">{String(o.description)}</div>}
              </button>
            ))
          )}
          <input
            className="entry"
            placeholder="Or type an answer…"
            value={other}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && other.trim()) onAnswer([{ question: q.question, text: other.trim() }]);
            }}
          />
        </>
      )}
    </div>
  );
}
