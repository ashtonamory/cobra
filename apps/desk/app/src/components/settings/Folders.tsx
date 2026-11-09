/**
 * Settings → Projects: per computer, the folders its agent looks in for repositories (the agent's
 * folders.ts, `GET /settings/folders`), its own (projects.json's roots, or ~ and ~/Projects) and
 * the ones added here, with Add a folder (a path typed as /… or ~/…, checked on that computer) and
 * Remove on an added one (`POST /settings/folders {add | remove}`). Words in lib/folders.ts.
 */
import { useState } from "react";
import * as api from "../../lib/api.ts";
import * as config from "../../lib/config.ts";
import * as folders from "../../lib/folders.ts";
import type { Dict } from "../../lib/json.ts";
import { Board, BoardRow, Button } from "../ui.tsx";
import { Controller, Group, Spinner, statusOf, why } from "./common.tsx";

export class FoldersController extends Controller {
  views: Record<string, Dict> = {};    // machine → FoldersView
  failed: Record<string, string> = {}; // machine → why it gave no list
  busy = new Set<string>();            // computers with a change in flight
  generation = 0;

  reload() {
    this.generation += 1;
    this.views = {};
    this.failed = {};
    this.draw();
    for (const m of config.MACHINES) this.read(m.machine);
  }

  read(machine: string) {
    const gen = this.generation;
    api.folders(machine).then(
      (reply) => {
        if (gen !== this.generation) return;
        delete this.failed[machine];
        this.views[machine] = reply || {};
        this.draw();
      },
      (e) => {
        if (gen !== this.generation) return;
        this.failed[machine] = folders.failureLine(statusOf(e), why(e), config.label(machine));
        this.draw();
      },
    );
  }

  /** Add or remove one; true when it took. The agent's answer is the new list and a line to show. */
  async change(machine: string, how: "add" | "remove", path: string): Promise<boolean> {
    this.busy.add(machine);
    this.draw();
    try {
      const reply = (how === "add" ? await api.folderAdd(machine, path) : await api.folderRemove(machine, path)) || {};
      this.views[machine] = reply;
      if (typeof reply.said === "string") this.app.toast(`${config.label(machine)}: ${reply.said}`);
      // The new folder's repositories are offered at once under New project → On this computer.
      this.app.fleet.refreshSlow();
      return true;
    } catch (e) {
      this.app.toast(`${config.label(machine)}: ${why(e)}`);
      return false;
    } finally {
      this.busy.delete(machine);
      this.draw();
    }
  }
}

export function FoldersSection({ c, only }: { c: FoldersController; only: string | null }) {
  if (!config.MACHINES.length) return null;
  return <>{config.MACHINES.filter((m) => only === null || m.machine === only).map((m) => <Machine key={m.machine} c={c} m={m} />)}</>;
}

function Machine({ c, m }: { c: FoldersController; m: config.Machine }) {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const computer = config.label(m.machine);
  const busy = c.busy.has(m.machine);
  const view = c.views[m.machine];
  if (!view) {
    return (
      <Group title="Folders" note={folders.BLURB}>
        {m.machine in c.failed ? (
          <Board>
            <BoardRow time={null} title="Folders" word="no answer" tone="muted" machine={m.machine} detail={c.failed[m.machine]} />
          </Board>
        ) : (
          <div className="row"><Spinner /><span className="dim">Asking {computer}…</span></div>
        )}
        {m.machine in c.failed && (
          <div className="row"><Button kind="flat" onClick={() => c.read(m.machine)}>Refresh</Button></div>
        )}
      </Group>
    );
  }
  const add = async () => {
    const wrong = folders.problem(typed);
    setProblem(wrong);
    if (wrong) return;
    if (await c.change(m.machine, "add", typed.trim())) setTyped("");
  };
  return (
    <Group title="Folders" note={folders.BLURB}>
      <Board>
        {folders.rows(view).map((row) => (
          <BoardRow key={row.path} time={null} title={<span className="mono selectable">{row.title}</span>} word={row.word}
            tone={row.added ? "ink" : "muted"} machine={m.machine} detail={row.title === row.path ? null : row.path}
            actions={row.added ? (
              <Button kind="flat" small disabled={busy} onClick={() => void c.change(m.machine, "remove", row.path)}>Remove</Button>
            ) : null} />
        ))}
      </Board>
      <span className="caps">Add a folder</span>
      <div className="row" style={{ gap: 8 }}>
        <input className="entry mono grow" value={typed} placeholder="~/code or /mnt/work" disabled={busy}
          aria-label={`A folder on ${computer}`}
          onChange={(e) => { setTyped(e.target.value); setProblem(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
        <Button kind="primary" disabled={busy || !typed.trim()} onClick={() => void add()}>{busy ? "Adding…" : "Add"}</Button>
      </div>
      {problem && <div className="dim">{problem}</div>}
      <div className="dim">
        {m.local ? "A path on this computer." : `A path on ${computer}, not on this one.`} The repositories in it, up to two
        folders down, show under New project → On this computer.
      </div>
    </Group>
  );
}
