/**
 * Tidy — the phone's app/tidy.tsx (the desk's ui/tidy.py): one list across
 * every repository on every computer of merged branches still present, stale
 * branches with unique commits, and old PRs. Each row says why it is here and
 * offers the one safe action. A branch with commits main lacks is never
 * deletable from here; Ask Claude sends the assessment into that
 * repository's session instead.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../app/context.ts";
import * as api from "../lib/api.ts";
import * as config from "../lib/config.ts";
import * as model from "../lib/model.ts";
import type { Dict } from "../lib/json.ts";
import { Board, BoardRow, Button } from "./ui.tsx";
import { Confirm } from "./Verbs.tsx";
import { Sheet, Spinner } from "./NewProject.tsx";
import "../styles/projects.css";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Tidy({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [found, setFound] = useState<Record<string, Dict[]>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ machine: string; row: Dict } | null>(null);
  const generation = useRef(0);

  const reload = useCallback(() => {
    generation.current += 1;
    const gen = generation.current;
    setFound({});
    setFailed({});
    for (const m of config.MACHINES) {
      api.tidy(m.machine).then(
        (reply) => {
          if (gen === generation.current) setFound((f) => ({ ...f, [m.machine]: [...(reply?.rows ?? [])] }));
        },
        (e) => {
          if (gen === generation.current) setFailed((f) => ({ ...f, [m.machine]: msg(e) }));
        },
      );
    }
  }, []);

  useEffect(() => {
    reload();
    // A closed dialog takes no late answers.
    return () => void (generation.current += 1);
  }, [reload]);

  /** A minimal row for the verbs, which act by machine and project id. */
  const rowFor = (machine: string, project: string): model.Row =>
    app.fleet.rows.find((r) => r.machine === machine && r.id === project) ??
    new model.Row({ id: project, name: project, machine, session: "", path: "", rank: 9, state: "none", meta: "", active: false });

  /** A Worker whose PR was closed: its worktree and local branch go, with any commits not on GitHub. */
  const discard = (machine: string, row: Dict) =>
    api.discardWorker(machine, String(row.worker)).then(
      () => {
        app.toast(`Deleted ${row.branch}`);
        app.fleet.refresh();
        reload();
      },
      (e) => app.toast(`Not deleted: ${msg(e)}`),
    );

  const deleteAll = async (sec: model.TidySection) => {
    const branches = sec.rows.filter((row) => row.action === "delete" && row.branch).map((row) => String(row.branch));
    try {
      const kept: string[] = [];
      for (const b of branches) {
        try {
          await api.gitAction(sec.machine, String(sec.project), "delete-branch", { branch: b });
        } catch (e) {
          if (!(e instanceof api.ApiError)) throw e;
          kept.push(`${b}: ${e.message}`);
        }
      }
      app.toast(kept.length ? `Kept ${kept.length}: ${kept[0]}` : `Deleted ${branches.length} merged branches · ${sec.title}`);
      app.fleet.refresh();
      reload();
    } catch (e) {
      app.toast(`${sec.title}: ${msg(e)}`);
    }
  };

  const section = (sec: model.TidySection) => {
    const r = rowFor(sec.machine, String(sec.project));
    const a = app.actions;
    return (
      <div className="col" style={{ gap: 6 }} key={sec.key}>
        <div className="row">
          <span className="caps grow">{`${sec.title.toUpperCase()} · ${config.label(sec.machine).toUpperCase()}`}</span>
          {sec.deletable > 1 && (
            <Button kind="flat" small title="Every branch here whose commits are all in main" onClick={() => void deleteAll(sec)}>
              Delete {sec.deletable} merged
            </Button>
          )}
        </div>
        <Board>
          {sec.rows.map((row, i) => {
            const action = row.action;
            const verb = model.TIDY_VERBS[action] ?? String(action);
            let fn: (() => void) | null = null;
            if (action === "delete" && row.branch) {
              fn = () => void a.git(r.machine, r.id, "delete-branch", sec.title, { branch: row.branch }).then(reload);
            } else if (action === "close" && row.number) {
              fn = () => void a.git(r.machine, r.id, "close-pr", sec.title, { number: row.number }).then(reload);
            } else if (action === "discard" && row.worker) {
              fn = () => setConfirm({ machine: sec.machine, row });
            } else if (action === "ask-claude") {
              fn = () => void a.askClaude(r);
            }
            const age = row.ageDays;
            return (
              <BoardRow key={i} time={age !== null && age !== undefined ? `${age}d` : "—"} title={model.tidyLabel(row)}
                word={row.kind === "pr" ? "PR" : "BRANCH"} tone="muted" detail={String(row.reason || "")} keepActions
                actions={fn ? <Button kind="flat" small onClick={fn}>{verb}</Button> : undefined} />
            );
          })}
        </Board>
      </div>
    );
  };

  const total = config.MACHINES.length;
  const asked = Object.keys(found).length + Object.keys(failed).length;
  const sections = model.tidySections(Object.entries(found).flatMap(([m, rows]) => rows.map((row) => [m, row] as const)));
  const left = total - asked;

  return (
    <Sheet title="Tidy" width={720} canClose={confirm === null} onClose={onClose}
      extra={<button className="btn icon flat" title="Ask every computer again" onClick={reload}>⟳</button>}>
      <div className="col" style={{ gap: 16 }}>
        {asked < total && (
          <div className="row">
            <Spinner />
            <span className="dim">{`Asking ${left} more computer${left > 1 ? "s" : ""}…`}</span>
          </div>
        )}
        {Object.entries(failed).map(([machine, why]) => (
          <div className="dim" key={machine}>{`${config.label(machine)}: ${why}`}</div>
        ))}
        {asked === total && !sections.length && (
          <div className="dim">Nothing to tidy: no merged branches left behind, no stale branches, no old PRs.</div>
        )}
        {sections.map(section)}
      </div>
      {confirm && (
        <Confirm title={`Delete ${confirm.row.branch || "this Worker"}?`}
          body={`Its worktree and local branch are removed from ${config.label(confirm.machine)}. Commits that were never merged go with them, unless the branch is still on GitHub.`}
          yes="Delete" danger onYes={() => void discard(confirm.machine, confirm.row)} onClose={() => setConfirm(null)} />
      )}
    </Sheet>
  );
}
