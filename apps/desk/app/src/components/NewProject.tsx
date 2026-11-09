/**
 * New project — the phone's app/project/new.tsx on the desktop (the desk's
 * ui/new_project.py). Pick a computer, then where the project comes from: a
 * repository already on it, one of your GitHub repositories (cloned by that
 * computer's own gh), or a new empty one. The computer registers it, trusts
 * the folder and starts Claude, and the chat opens on it.
 *
 * Everything the dialog shows is per computer, so switching computers throws
 * all of it away rather than showing the last one's repositories. Each answer
 * carries the generation it was asked in, and a stale one is dropped.
 *
 * Also here, because Tidy and the project page share them: Sheet (the desk's
 * Adw.Dialog with a header bar), Toggles (Adw.ToggleGroup) and Waiting.
 */
import { APP_NAME } from "../lib/appName.ts";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "../app/context.ts";
import * as api from "../lib/api.ts";
import * as config from "../lib/config.ts";
import * as model from "../lib/model.ts";
import * as newProject from "../lib/newProject.ts";
import type { Dict } from "../lib/json.ts";
import { seatKey } from "../../../../../packages/contracts/src/org.ts";
import { changeOrg, setHiring, useOrg } from "../lib/orgStore.ts";
import { Button, Dialog, Status, Switch, cls } from "./ui.tsx";
import "../styles/projects.css";

// -- shared pieces ---------------------------------------------------------------

/** A dialog with a header bar: a title, what the header holds, and ×. Escape
 * closes it unless `canClose` is false (busy, or a confirmation on top). */
export function Sheet({ title, width = 720, extra, canClose = true, onClose, children }: {
  title: string; width?: number; extra?: ReactNode; canClose?: boolean; onClose: () => void; children: ReactNode;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && canClose && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [canClose, onClose]);
  return (
    <div className="scrim">
      <div className="dialog pj-sheet board-page" style={{ width: `min(${width}px, 94vw)` }} onClick={(e) => e.stopPropagation()}>
        <div className="pj-sheet-head">
          <h2 className="grow">{title}</h2>
          {extra}
          <button className="btn icon flat" title="Close" disabled={!canClose} onClick={onClose}>×</button>
        </div>
        <div className="pj-sheet-body">{children}</div>
      </div>
    </div>
  );
}

/** One of a few, side by side (Adw.ToggleGroup). Not homogeneous: three slots
 * as wide as "On this computer" outgrew a window tiled phone-narrow. */
export function Toggles({ options, active, onChange }: {
  options: Array<readonly [string, string]>; active: string | null; onChange: (name: string) => void;
}) {
  return (
    <div className="pj-toggles" role="radiogroup">
      {options.map(([name, text]) => (
        <button key={name} role="radio" aria-checked={name === active} className={cls("pj-toggle", name === active && "on")}
          onClick={() => name !== active && onChange(name)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function Spinner() {
  return <span className="pj-spinner" aria-label="Loading" />;
}

export function Waiting({ text }: { text: string }) {
  return (
    <div className="row" style={{ margin: 8 }}>
      <Spinner />
      <span className="dim">{text}</span>
    </div>
  );
}

/**
 * A note that outlives the page that raised it: New project closes and the
 * chat opens, and the note stays over it (the desk presented it on the
 * window). Main does not host one, so it gets a root of its own.
 */
export function showNote(heading: string, body: string): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    root.unmount();
    host.remove();
  };
  root.render(
    <Dialog title={heading} onClose={close} buttons={<Button kind="primary" onClick={close}>OK</Button>}>
      <div className="dim selectable" style={{ whiteSpace: "pre-wrap" }}>{body}</div>
    </Dialog>,
  );
}

// -- the dialog -------------------------------------------------------------------

/** A repository row: when, name and where or what, a status word. */
function RepoRow({ title, detail, word, tone, when, picked, onPick }: {
  title: string; detail: string; word: string; tone: string; when?: string; picked: boolean; onPick: () => void;
}) {
  return (
    <div className={cls("brow clickable pj-pick", picked && "picked")} role="option" aria-selected={picked} onClick={onPick}>
      {when ? <span className="btime">{when}</span> : null}
      <div className="col grow" style={{ gap: 2 }}>
        <span className="btitle">{title}</span>
        {detail ? <span className="bdetail pj-one-line">{detail}</span> : null}
      </div>
      {/* Cut here rather than ellipsized: a long branch name must not set the dialog's width. */}
      {word ? <Status word={word.length <= 20 ? word : word.slice(0, 19) + "…"} tone={tone} /> : null}
    </div>
  );
}

interface State {
  draft: newProject.Draft;
  caps: Dict | null;
  local: Dict[] | null;
  remote: Dict[] | null;
  busy: string | null;
  generation: number;
  asking: Set<string>;
  error: string | null;
  /** A list failed: no spinner under the error until the body is drawn afresh. */
  cleared: boolean;
}

export function NewProject({ machine, onClose }: { machine?: string; onClose: () => void }) {
  const app = useApp();
  const { hiring } = useOrg();
  const here = machine && config.machine(machine) ? machine : config.MACHINES[0]?.machine ?? "";
  const s = useRef<State>({
    draft: newProject.emptyDraft(here), caps: null, local: null, remote: null, busy: null,
    generation: 0, asking: new Set(), error: null, cleared: false,
  }).current;
  const [, setTick] = useState(0);
  const render = useCallback(() => setTick((n) => n + 1), []);
  const [search, setSearch] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  const current = () => config.machine(s.draft.machine) ?? config.MACHINES[0];
  const m = current();
  const githubAuth = Boolean(s.caps?.githubAuth);

  const problem = (text: string | null) => {
    s.error = text;
  };

  /** The repository list for the mode showing, once per computer (and, for
   * GitHub, per root): a scan and a gh round trip are both wasted on a dialog
   * opened to make an empty repo. */
  const fetch = () => {
    if (s.caps === null) return;
    const gen = s.generation, mm = current(), mode = s.draft.mode, root = s.draft.root ?? "";
    const auth = Boolean(s.caps.githubAuth);
    let call: () => Promise<Dict>;
    if (mode === "adopt" && s.local === null && !s.asking.has("adopt")) call = () => api.localRepos(mm.machine);
    else if (mode === "clone" && s.remote === null && auth && !s.asking.has(`clone:${root}`)) call = () => api.githubRepos(mm.machine, root);
    else return;
    const key = mode === "adopt" ? "adopt" : `clone:${root}`;
    s.asking.add(key);
    call().then(
      (reply) => {
        s.asking.delete(key);
        if (!alive.current || gen !== s.generation) return;
        if (mode === "adopt") s.local = [...(reply?.discovered ?? [])];
        else if (root === (s.draft.root ?? "")) s.remote = [...(reply?.repos ?? [])];
        if (mode === s.draft.mode) render();
      },
      (e) => {
        s.asking.delete(key);
        if (!alive.current || gen !== s.generation) return;
        // No spinner under the error; switching modes asks again.
        problem(newProject.describe(e, mm.label));
        if (mode === s.draft.mode) s.cleared = true;
        render();
      },
    );
  };

  const loadMachine = () => {
    s.generation += 1;
    const gen = s.generation, mm = current();
    s.cleared = false;
    s.caps = s.local = s.remote = null;
    s.asking.clear();
    s.draft.root = s.draft.path = s.draft.repo = null;
    problem(null);
    render();
    if (!mm) return;
    api.capabilities(mm.machine).then(
      (caps) => {
        if (!alive.current || gen !== s.generation) return;
        s.caps = caps ?? {};
        s.draft.root = newProject.preferredRoot(s.caps!.roots ?? []);
        render();
        fetch();
      },
      (e) => {
        if (!alive.current || gen !== s.generation) return;
        problem(newProject.describe(e, mm.label));
        render();
      },
    );
  };

  useEffect(() => {
    loadMachine();
    // Asked once on open; a switch asks again from its own handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setMode = (mode: string) => {
    if (mode && mode !== s.draft.mode) {
      s.draft.mode = mode;
      s.cleared = false;
      render();
      fetch();
    }
  };

  const setRoot = (root: string) => {
    if (root && root !== s.draft.root) {
      s.draft.root = root;
      // A clash is relative to where the clone lands: ask again for this root.
      s.remote = null;
      s.cleared = false;
      setSearch("");
      render();
      fetch();
    }
  };

  const submit = async () => {
    const body = newProject.requestFor(s.draft);
    if (body === null || s.busy || !m) return;
    const mm = m;
    problem(null);
    s.busy = newProject.busyWord(body.mode);
    render();
    try {
      const reply: Dict | null = await api.createProject(mm.machine, body);
      s.busy = null;
      const project: Dict = reply?.project ?? {};
      // Hire on a company's page in My Organization: the new Foreman works there.
      if (hiring && project.id) {
        const into = hiring;
        setHiring(null);
        void changeOrg({ op: "assign", seat: seatKey(String(project.machine || mm.machine), String(project.id)), company: into.id })
          .catch((e) => app.toast(`Not added to ${into.name}: ${e instanceof Error ? e.message : String(e)}`));
      }
      app.fleet.refresh();
      onClose();
      // Made, but not all of it: a refused first push leaves no remote, and
      // the reason (with the fix) is too long for a toast.
      const warnings = ((reply?.warnings ?? []) as unknown[]).filter((w) => w).map(String);
      if (warnings.length) showNote(`${project.name || "Project"} made, with a problem`, warnings.join("\n\n"));
      // Straight into the chat: the point of starting Claude here is that the
      // next thing you do is talk to it.
      if (reply?.started && project.session) {
        app.toast(`${newProject.doneWord(body.mode)} · ${project.name || ""}`);
        app.openChat(mm.machine, String(project.session));
      } else {
        app.toast(newProject.outcome(reply, mm.label));
      }
    } catch (e) {
      s.busy = null;
      if (!alive.current) return;
      problem(newProject.describe(e, mm.label));
      render();
    }
  };

  // -- drawing ----------------------------------------------------------------
  const roots: string[] = s.caps?.roots ?? [];
  const home = newProject.homeFrom(roots);
  const stopper = newProject.blocker(s.draft, githubAuth);
  const label = m?.label ?? "this computer";

  const adoptBody = () => {
    if (s.local === null) return <Waiting text="Looking for repositories…" />;
    if (!s.local.length) return <div className="dim">Every git repository under ~ and ~/Projects is already a project.</div>;
    return (
      <div className="board pj-list" role="listbox">
        {s.local.map((repo) => {
          const [word, tone] = newProject.adoptStatus(repo);
          return (
            <RepoRow key={String(repo.path)} title={repo.name || ""} detail={newProject.rootLabel(repo.path || "", home)}
              word={word} tone={tone} picked={repo.path === s.draft.path}
              onPick={() => { s.draft.path = repo.path; render(); }} />
          );
        })}
      </div>
    );
  };

  const cloneBody = () => {
    if (!githubAuth) {
      return <div className="dim">{label} has no GitHub login. Open a terminal on it and run `gh auth login`, then come back.</div>;
    }
    if (s.remote === null) return <Waiting text="Asking GitHub…" />;
    const user = s.caps?.githubUser;
    const found = newProject.matchRepos(s.remote, search);
    return (
      <>
        <input className="entry" type="search" placeholder={user ? `Search ${user}'s repositories` : "Search"} value={search}
          onChange={(e) => setSearch(e.target.value)} />
        {!found.length ? (
          <div className="dim">Nothing matches.</div>
        ) : (
          <div className="board pj-list" role="listbox">
            {found.map((repo) => {
              // Said before you pick, rather than as a refusal afterwards.
              const [word, tone] = repo.wouldClash ? ["ALREADY HERE", "ink"] : [String(repo.primaryLanguage || "").toUpperCase(), "muted"];
              return (
                <RepoRow key={String(repo.nameWithOwner)} title={repo.name || ""} detail={repo.description || repo.nameWithOwner || ""}
                  word={word} tone={tone} when={repo.pushedAt ? model.boardTime(repo.pushedAt) : "—"}
                  picked={repo.nameWithOwner === s.draft.repo}
                  onPick={() => { s.draft.repo = repo.nameWithOwner; render(); }} />
              );
            })}
          </div>
        )}
      </>
    );
  };

  const initBody = () => {
    const d = newProject.directoryFrom(s.draft.name);
    const why = githubAuth ? "Pushes the first commit, so it is not only on one computer." : `${label} is not logged in to GitHub.`;
    return (
      <>
        <input className="entry" autoFocus placeholder="My project" value={s.draft.name}
          onChange={(e) => { s.draft.name = e.target.value; render(); }} />
        {d ? <div className="dim">Directory and session: {d}</div> : null}
        <label className="row" style={{ gap: 12 }}>
          <div className="col grow" style={{ gap: 2 }}>
            <span>Create a private GitHub repo</span>
            <span className="dim">{why}</span>
          </div>
          <Switch checked={s.draft.remote && githubAuth} disabled={!githubAuth}
            onChange={(on) => { s.draft.remote = on; render(); }} />
        </label>
      </>
    );
  };

  const body = () => {
    if (s.caps === null) return s.error ? null : <Waiting text={`Asking ${label}…`} />;
    if (s.cleared) return null;
    if (s.draft.mode === "adopt") return adoptBody();
    if (s.draft.mode === "clone") return cloneBody();
    return initBody();
  };

  const blurb = newProject.MODES.find(([k]) => k === s.draft.mode)?.[2] ?? "";

  return (
    <Sheet title="New project" width={600} canClose={s.busy === null} onClose={onClose}>
      <div className="col" style={{ gap: 10 }}>
        {hiring && (
          <div className="row" style={{ gap: 8 }}>
            <span className="dim">Its Foreman joins {hiring.name} in My Organization.</span>
            <Button kind="flat" small onClick={() => setHiring(null)}>No company</Button>
          </div>
        )}
        <span className="caps">SOURCE</span>
        <Toggles options={newProject.MODES.map(([k, t]) => [k, t] as const)} active={s.draft.mode} onChange={setMode} />
        <div className="dim">{blurb}</div>
        <div className="col" style={{ gap: 8 }}>{body()}</div>
        {s.draft.mode !== "adopt" && roots.length >= 2 && (
          <div className="col" style={{ gap: 8 }}>
            <span className="caps">WHERE</span>
            <Toggles options={roots.map((r) => [r, newProject.rootLabel(r, home)] as const)} active={s.draft.root ?? roots[0]} onChange={setRoot} />
          </div>
        )}
        {s.error ? <div className="pj-error selectable">{s.error}</div> : null}
        <div style={{ marginTop: 8 }}>
          <Button kind="primary" disabled={s.busy !== null || s.caps === null || stopper !== null} onClick={() => void submit()}>
            {s.busy ?? stopper ?? "Create and open"}
          </Button>
        </div>
        <div className="dim">
          Starts {APP_NAME} in a tmux session on {label} and opens the chat. The folder is marked trusted first, so nothing stops to ask.
        </div>
      </div>
    </Sheet>
  );
}
