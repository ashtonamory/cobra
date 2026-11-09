/**
 * Settings → BRAIN: how the agent's router picks a model (the agent's brain). The picked computer's picks by kind and size and its usage windows, the
 * benchmark table with where each model is offered, your rules with Remove, and a row to add one.
 * brain.json is the fleet's: an edit goes to every computer that answered, as the next revision. Words
 * in lib/brain.ts.
 */
import { useState } from "react";
import * as api from "../../lib/api.ts";
import * as brain from "../../lib/brain.ts";
import * as config from "../../lib/config.ts";
import type { Dict } from "../../lib/json.ts";
import { Board, Button, Card, GroupTitle } from "../ui.tsx";
import { Controller, FlowRow, Toggles, why } from "./common.tsx";

export class BrainController extends Controller {
  views: Record<string, Dict> = {};
  kind = "feature";
  machine: string | null = null;
  busy = false;
  generation = 0;

  reload() {
    this.generation += 1;
    const gen = this.generation;
    this.views = {};
    this.draw();
    for (const m of config.MACHINES) {
      api.brain(m.machine).then(
        (view) => {
          if (gen === this.generation && view) {
            this.views[m.machine] = view;
            this.draw();
          }
        },
        () => {},
      );
    }
  }

  show(kind: string) {
    this.kind = kind;
    this.draw();
  }

  on(machine: string) {
    this.machine = machine;
    this.draw();
  }

  /** The next brain.json to every computer that answered; a toast says how it went. */
  async save(file: Dict, done: string) {
    if (this.busy) return;
    this.busy = true;
    this.draw();
    const failures: string[] = [];
    for (const name of Object.keys(this.views)) {
      try {
        await api.brainWrite(name, file);
      } catch (e) {
        failures.push(`${config.label(name)}: ${why(e)}`);
      }
    }
    this.busy = false;
    this.app.toast(!failures.length ? done : "Not saved everywhere: " + failures.join("; "));
    this.reload();
  }
}

export function BrainSection({ c }: { c: BrainController }) {
  const answered = Object.values(c.views);
  const views = brain.currentViews(answered);
  if (!views.length) {
    const words = answered.length ? brain.UPDATE_AGENTS : config.MACHINES.length ? "Asking…" : "Link a computer first: Settings → Computers.";
    return <Card><div className="dim">{words}</div></Card>;
  }
  const current = brain.newestBrain(views);
  const kinds: string[] = views[0].kinds || [];
  const rules: Dict[] = current.rules || [];
  const shown = views.find((v) => v.machine === c.machine) ?? views[0];
  return (
    <>
      <div className="dim">{brain.BLURB}</div>
      {views.length > 1 && (
        <Toggles active={shown.machine} onPick={(m) => c.on(m)} options={views.map((v) => ({ key: v.machine, label: config.label(v.machine) }))} />
      )}

      {/* The picked computer's picks, one kind of task at a time. */}
      <GroupTitle>{`Picks on ${config.label(shown.machine)}`}</GroupTitle>
      <div className="h-scroll">
        <Toggles active={kinds.includes(c.kind) ? c.kind : null} onPick={(k) => c.show(k)}
          options={kinds.map((k) => ({ key: k, label: k }))} />
      </div>
      <Card>
        <Board>
          {brain.picksFor(shown, c.kind).map((pick) => (
            <div className="brow" key={pick.size}>
              <FlowRow main={<div className="col" style={{ gap: 2 }}><span className="btitle">{brain.pickTitle(pick)}</span><span className="bdetail">{pick.reason}</span></div>} trailing={null} />
            </div>
          ))}
        </Board>
      </Card>
      <div className="footnote">{brain.PICKS_FOOTER}</div>

      {/* Its usage windows: what lowers (TIGHT) or leaves out (HOLD) a model. */}
      <GroupTitle>{`Usage on ${config.label(shown.machine)}`}</GroupTitle>
      <Card>
        <Board>
          {!(shown.windows || []).length && <div className="dim">No usage read: nothing is held or lowered.</div>}
          {((shown.windows || []) as Dict[]).map((w) => (
            <div className="brow" key={`${w.id}:${w.label}`}>
              <FlowRow main={<span className="btitle">{brain.windowTitle(w)}</span>} trailing={<span className="record">{brain.windowValue(w)}</span>} />
            </div>
          ))}
        </Board>
      </Card>

      {/* The benchmark table the router ships with, and where each model is offered. */}
      <GroupTitle>Benchmarks</GroupTitle>
      <Card>
        <Board>
          {brain.benchmarkRows(views).map((b) => (
            <div className="brow" key={b.model}>
              <FlowRow
                main={<div className="col" style={{ gap: 2 }}><span className="btitle">{`${b.name} (${b.model})`}</span><span className="bdetail">{brain.benchmarkDetail(b)}</span></div>}
                trailing={<span className="dim">{brain.offeredOn(views, b.model)}</span>} />
            </div>
          ))}
        </Board>
      </Card>
      <div className="footnote">{brain.benchmarksFooter(shown.asOf)}</div>

      {/* Your rules, then a row to add one. */}
      <GroupTitle>Your rules</GroupTitle>
      <Card>
        <Board>
          {!rules.length && <div className="dim">No rules yet: benchmarks and usage decide alone.</div>}
          {rules.map((rule, at) => (
            <div className="brow" key={at}>
              <FlowRow
                main={<div className="col" style={{ gap: 2 }}><span className="btitle">{brain.ruleWords(rule)}</span>{rule.note && <span className="bdetail">{rule.note}</span>}</div>}
                trailing={<Button kind="flat" disabled={c.busy} onClick={() => c.save(brain.withoutRule(current, at), "Rule removed")}>Remove</Button>} />
            </div>
          ))}
          {brain.ruleWarnings(views).map((warning) => <div className="dim" key={warning}>{warning}</div>)}
        </Board>
      </Card>
      <GroupTitle>Add a rule</GroupTitle>
      <Card><Adder key={rules.length} c={c} views={views} kinds={kinds} current={current} /></Card>
      <div className="footnote">{brain.RULES_FOOTER}</div>
    </>
  );
}

const ACTIONS = ["prefer", "never", "always reviewed", "never reviewed"];

/** Add a rule: when (kind, project, path), what (prefer, never or review), which models, why. */
function Adder({ c, views, kinds, current }: { c: BrainController; views: Dict[]; kinds: string[]; current: Dict }) {
  const [kind, setKind] = useState(brain.ANY);
  const [project, setProject] = useState("");
  const [path, setPath] = useState("");
  const [action, setAction] = useState(ACTIONS[0]);
  const [models, setModels] = useState("");
  const [note, setNote] = useState("");
  const add = () => {
    const listed = models.split(",").map((x) => x.trim()).filter(Boolean);
    const rule = brain.draftRule(kind, project, path, action.includes("reviewed") ? "review" : action, listed,
      action === "always reviewed" ? "force" : "skip", note);
    if (typeof rule === "string") {
      c.app.toast(rule);
      return;
    }
    void c.save(brain.withRule(current, rule), "Rule added");
  };
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="form-grid">
        <span className="dim">When the task is</span>
        <select className="entry" value={kind} onChange={(e) => setKind(e.target.value)}>
          {[brain.ANY, ...kinds].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <span className="dim">In project</span>
        <input className="entry" placeholder="Project (optional)" value={project} onChange={(e) => setProject(e.target.value)} />
        <span className="dim">Touching files</span>
        <input className="entry" placeholder="Files (optional): maps/**" value={path} onChange={(e) => setPath(e.target.value)} />
        <span className="dim">Then</span>
        <select className="entry" value={action} onChange={(e) => setAction(e.target.value)}>
          {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <span className="dim">Models</span>
        <input className="entry" placeholder={"Models: " + brain.ruleModels(views).join(", ")} value={models} onChange={(e) => setModels(e.target.value)} />
        <span className="dim">Why</span>
        <input className="entry" placeholder="Why (optional): shown on the plan card" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Button kind="primary" disabled={c.busy} onClick={add}>Add rule</Button>
      </div>
    </div>
  );
}
