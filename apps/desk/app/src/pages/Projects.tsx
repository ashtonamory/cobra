/**
 * Projects — every project on every machine, running or not, drawn as the
 * phone's board: a time, a name with its machine's dot, one status word. The
 * everyday verbs (Allow, Chat, ▶ Cobra, Terminal) show on the row under the
 * pointer; the rest of the phone's hold sheet is behind ⋯ and on a
 * right-click (Verbs). A click on a Claude row opens its chat, on any other
 * project its page (ProjectPage). Pinned projects come first. New project…
 * adopts, clones or makes one (NewProject); Tidy lists what wants tidying.
 */
import { APP_NAME } from "../lib/appName.ts";
import { useEffect, useState } from "react";
import { useApp, useFleet } from "../app/context.ts";
import * as model from "../lib/model.ts";
import { allPins } from "../lib/pins.ts";
import { Board, BoardHead, BoardRow, Button } from "../components/ui.tsx";
import { MenuDots, useVerbs, type Verbs } from "../components/Verbs.tsx";
import { NewProject } from "../components/NewProject.tsx";
import { Tidy } from "../components/Tidy.tsx";
import "../styles/projects.css";

// The last New project ask this page answered: the count outlives the page
// (Main keeps it), so a page mounted later must not open the dialog again.
let answeredAsk = 0;

const key = (r: model.Row) => `${r.machine}\u0000${r.id}`;

export function ProjectsPage({ newProjectAsk }: { newProjectAsk: number }) {
  const fleet = useFleet();
  const verbs = useVerbs();
  const [text, setText] = useState("");
  const [dialog, setDialog] = useState<"new" | "tidy" | null>(null);

  useEffect(() => {
    if (newProjectAsk > 0 && newProjectAsk > answeredAsk) {
      answeredAsk = newProjectAsk;
      setDialog("new");
    }
  }, [newProjectAsk]);

  // The Lead is listed with the projects so its questions reach you; Chat pins it.
  const all = model.filterRows(fleet.rows, text).filter((r) => !r.lead);
  // A specialist hired on its own is not one of your projects: it is listed apart, with its conversation and helpers,
  // so they stay one click away here as well as in My Organization.
  const { projects: rows, specialists } = model.splitSpecialists(all);
  const pins = allPins();
  const root = (r: model.Row) =>
    r.parent ? rows.find((p) => p.parent === null && p.id === r.parent && p.machine === r.machine) ?? r : r;
  const pinned = new Set(rows.filter((r) => pins.includes(model.pinKey(root(r)) ?? "")).map(key));
  const live = new Map(rows.map((r) => [key(r), model.familyActive(r, rows)]));
  const rest = rows.filter((r) => !pinned.has(key(r)));
  const groups: Array<[string, model.Row[]]> = [
    ["Pinned", rows.filter((r) => pinned.has(key(r)))],
    ["Active", rest.filter((r) => live.get(key(r)))],
    ["Not started", rest.filter((r) => !live.get(key(r)))],
    ["Specialists", specialists],
  ];

  return (
    <>
      <div className="pj-top board-page">
        <input className="entry grow" type="search" placeholder="Filter by project or machine" value={text}
          style={{ minWidth: 120 }} onChange={(e) => setText(e.target.value)} />
        <Button kind="flat" title="Merged branches, stale branches and old PRs" onClick={() => setDialog("tidy")}>
          Tidy
        </Button>
        <Button kind="flat" title="Adopt, clone from GitHub, or start an empty repository" onClick={() => setDialog("new")}>
          New project…
        </Button>
      </div>
      <div className="page board-page">
        <div className="col" style={{ gap: 18 }}>
          {all.length > 0 && <BoardHead item="PROJECT" />}
          {groups.map(([title, items]) =>
            items.length ? (
              <div className="col" style={{ gap: 6 }} key={title}>
                <span className="caps">{`${title.toUpperCase()} · ${items.length}`}</span>
                <Board>
                  {model.nest(items).map((r) => <ProjectRow key={key(r)} r={r} verbs={verbs} />)}
                </Board>
              </div>
            ) : null,
          )}
          {!all.length && <div className="dim">{text ? "Nothing matches." : "Asking the fleet…"}</div>}
        </div>
      </div>
      {verbs.node}
      {dialog === "new" && <NewProject onClose={() => setDialog(null)} />}
      {dialog === "tidy" && <Tidy onClose={() => setDialog(null)} />}
    </>
  );
}

function ProjectRow({ r, verbs }: { r: model.Row; verbs: Verbs }) {
  const app = useApp();
  const a = app.actions;
  const git = r.project?.git ?? {};
  const [word, tone] = model.boardStatus(r);
  // An extra session sits under its project, named by its title; its type, model and state
  // are the detail line, and its branch is in the tooltip.
  const detail = r.isExtra ? model.sessionDetail(r) : null;
  const permission = r.dialog === "permission";
  const btns = (
    <>
      {r.state === "needs" && permission && <Button kind="primary" small onClick={() => void a.allow(r)}>{verbs.offersScopes(r) ? "Allow once" : "Allow"}</Button>}
      {r.state === "needs" && permission && verbs.offersScopes(r) && (
        <MenuDots title="Allow for this task, this project or always" label="▾" onOpen={(x, y) => verbs.allowMenuAt(r, x, y)} />
      )}
      {r.state === "needs" && <Button kind="flat" small onClick={() => void a.deny(r)}>{permission ? "Deny" : "Dismiss"}</Button>}
      {r.isAgent && r.project ? (
        <Button kind="flat" small onClick={() => app.openChat(r.machine, r.session)}>Chat</Button>
      ) : !r.active && r.project ? (
        <Button kind="flat" small title={`Start ${APP_NAME} in this project`} onClick={() => void a.start(r)}>▶ {APP_NAME}</Button>
      ) : null}
      <Button kind="flat" small onClick={() => void a.terminal(r)}>Terminal</Button>
      <MenuDots onOpen={(x, y) => verbs.menuAt(r, x, y)} />
    </>
  );
  const tip = [git.branch ? `⎇ ${git.branch}` : "", git.grade || "", r.meta, r.label].filter((x) => x).join(" · ");
  const click = r.isAgent && r.project
    ? () => app.openChat(r.machine, r.session)
    : r.project
      ? () => app.openProject(r.machine, r.id)
      : undefined;
  return (
    <BoardRow time={model.boardTime(r.project?.lastActivityAt ?? null)} title={r.title} word={word} tone={tone}
      machine={r.machine} actions={btns} indent={Boolean(r.parent)} tooltip={tip} detail={detail}
      keepActions={r.state === "needs"} onClick={click} onMenu={(x, y) => verbs.menuAt(r, x, y)} />
  );
}
