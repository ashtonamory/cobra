/**
 * Settings → Permissions on the desk, the phone's
 * app/permissions.tsx: one policy for every computer. You edit a draft; Review asks a computer what it
 * would change, in words; Apply sends the next revision to every computer that answered, and a change
 * that grants more needs the second press. A computer that was off shows behind, with Bring up to date.
 * The words come from lib/permissions.ts.
 *
 * The controller lives on the Settings page, not in this section: LOCAL MODELS edits the policy
 * through it and shows the same change block.
 */
import { useState } from "react";
import * as api from "../../lib/api.ts";
import * as config from "../../lib/config.ts";
import * as permissions from "../../lib/permissions.ts";
import { ConfirmPress } from "../../lib/confirm.ts";
import { shortWhen } from "../../lib/appSettings.ts";
import { isDict, type Dict } from "../../lib/json.ts";
import { Button, Card, Switch, cls } from "../ui.tsx";
import { Chip, Controller, Group, NumberField, statusOf, why } from "./common.tsx";

export class PermissionsController extends Controller {
  reads: Record<string, Dict | null> = {};   // machine → PolicyStatus, or null when it did not answer
  failed: Record<string, string> = {};
  lanes: Record<string, Dict | null> = {};   // machine → ApiLaneStatus, or null when it did not answer
  draft: Dict | null = null;
  review: Dict | null = null;                // PolicyWritten for the draft
  generation = 0;
  applyConfirm = new ConfirmPress((done) => this.apply(done), () => this.draw(),
    (ms, fn) => setTimeout(fn, ms), (h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  stop() {
    this.applyConfirm.reset();
  }

  // -- reading ----------------------------------------------------------------

  reload() {
    this.generation += 1;
    const gen = this.generation;
    this.reads = {};
    this.failed = {};
    this.lanes = {};
    this.draw();
    for (const m of config.MACHINES) {
      api.policy(m.machine).then(
        (reply) => {
          if (gen !== this.generation) return;
          this.reads[m.machine] = reply;
          this.draw();
        },
        (e) => {
          if (gen !== this.generation) return;
          this.reads[m.machine] = null;
          const s = statusOf(e);
          this.failed[m.machine] = s === 404 ? "update agent" : s === 0 ? "offline" : "unavailable";
          this.draw();
        },
      );
      api.apiLane(m.machine).then(
        (reply) => {
          if (gen !== this.generation) return;
          this.lanes[m.machine] = reply;
          this.draw();
        },
        () => {
          if (gen !== this.generation) return;
          this.lanes[m.machine] = null;
          this.draw();
        },
      );
    }
  }

  answered(): Record<string, Dict> {
    return Object.fromEntries(Object.entries(this.reads).filter(([, v]) => v)) as Record<string, Dict>;
  }

  fleet(): [string, Dict] | null {
    return permissions.newest(this.answered());
  }

  /** The policy a change starts from: the draft in progress, else the fleet's newest. */
  current(): Dict | null {
    const found = this.fleet();
    return this.draft ?? (found ? found[1].policy : null);
  }

  /** That computer's GET /policy, when it answered. */
  readFor(machine: string): Dict | null {
    return this.reads[machine] || null;
  }

  edit(draft: Dict) {
    this.draft = draft;
    this.review = null;
    this.applyConfirm.reset();
    this.draw();
  }

  /** The policy an edit starts from on this page: the draft, else the fleet's. */
  base(): Dict {
    return this.draft ?? this.fleet()![1].policy;
  }

  // -- acting -----------------------------------------------------------------

  discard() {
    this.draft = null;
    this.review = null;
    this.applyConfirm.reset();
    this.draw();
  }

  async reviewChange(source: string) {
    const policy = { ...this.draft, revision: permissions.nextRevision(this.answered()) };
    try {
      this.review = (await api.policyPreview(source, policy)) || { lines: [], widens: false };
      this.draw();
    } catch (e) {
      this.app.toast(`Couldn't review the change: ${why(e)}`);
    }
  }

  pressApply() {
    // A change that grants more takes the second press; one that does not goes at once.
    if (this.review?.widens) {
      this.applyConfirm.press();
    } else {
      this.applyConfirm.busy = true;
      this.draw();
      this.apply(() => {});
    }
  }

  apply(done: () => void) {
    const widens = !!this.review?.widens;
    const policy = { ...this.draft, revision: permissions.nextRevision(this.answered()) };
    void this.send(policy, config.MACHINES.filter((m) => this.reads[m.machine]), widens, done);
  }

  async bringUp(m: config.Machine) {
    const found = this.fleet();
    if (!found) return;
    const policy = found[1].policy;
    let reply: Dict | null;
    try {
      reply = await api.policyPreview(m.machine, policy);
    } catch (e) {
      this.app.toast(`Couldn't read ${config.label(m.machine)}: ${why(e)}`);
      return;
    }
    if (reply?.widens) {
      // No dialog on the desk: the second press is the confirmation, so a change that grants more
      // on a computer that was behind goes through Review like any other.
      this.app.toast(`${config.label(m.machine)} would get more permissions: review it as a change first`);
      this.draft = policy;
      this.review = reply;
      this.draw();
      return;
    }
    await this.send(policy, [m], false, () => {});
  }

  async send(policy: Dict, targets: readonly config.Machine[], widens: boolean, done: () => void) {
    const failed: string[] = [];
    for (const m of targets) {
      try {
        await api.policyWrite(m.machine, policy, widens);
      } catch (e) {
        // The agent's refusal, in its words: a change it will not take (a hard cap, a shape it
        // does not know) says why here.
        failed.push(`${config.label(m.machine)}: ${why(e)}`);
      }
    }
    done();
    this.applyConfirm.busy = false;
    const n = targets.length - failed.length;
    this.app.toast(failed.length ? `In force on ${n} of ${targets.length}: ` + failed.join("; ")
      : n === 1 ? `In force on ${config.label(targets[0].machine)}` : "In force");
    this.draft = null;
    this.review = null;
    this.reload();
  }
}

export function PermissionsSection({ p }: { p: PermissionsController }) {
  if (!config.MACHINES.length) return <Card><div className="dim">Link a computer first: Settings → Computers.</div></Card>;
  const found = p.fleet();
  if (!found) {
    return (
      <Card>
        <div className="dim">
          {Object.keys(p.reads).length < config.MACHINES.length ? "Reading this computer…" : "No computer answered with a policy."}
        </div>
      </Card>
    );
  }
  const status = found[1];
  const policy: Dict = p.draft ?? status.policy;
  const preset: string = policy.preset || "locked";
  const rows: Dict = ((status.presets || []) as Dict[]).find((x) => x.name === preset)?.rows ?? {};
  const caps: Dict = status.hardCaps || permissions.HARD_CAPS_FALLBACK;
  const revision: number = status.policy.revision ?? 0;
  const changes: Dict[] = status.changes || [];
  const models = permissions.fleetRole(policy, "foreman", "workerModels") as string[] | null;

  return (
    <>
      <Group title="Every computer">
        {permissions.PRESET_ORDER.map((name) => (
          <label key={name} className="radio-row">
            <input
              type="radio"
              name="fleet-preset"
              checked={name === preset}
              onChange={() => name !== (p.base().preset || "locked") && p.edit(permissions.setFleetPreset(p.base(), name))}
            />
            <span className="col" style={{ gap: 2 }}>
              <span>{permissions.presetTitle(name, status)}</span>
              <span className="dim">{permissions.PRESET_BLURB[name]}</span>
            </span>
          </label>
        ))}
        {Object.entries((status.capabilities || {}) as Record<string, string>).map(([capability, words]) => (
          <div className="row" key={capability} style={{ gap: 12 }}>
            <span className="dim grow">{words}</span>
            <span>{permissions.VERDICT_WORD[rows[capability] ?? ""] ?? rows[capability] ?? ""}</span>
          </div>
        ))}
      </Group>

      <Group title="Always comes to you">
        {((status.floor || []) as string[]).map((line, i) => <div key={i}>· {line}</div>)}
      </Group>

      <ApiCredits p={p} policy={policy} />

      <Group title="House rules"
        note={`In your own words. The judge reads them as yours before it allows anything; Workers never see them. At most ${permissions.RULES_MAX}.`}>
        {((policy.rules || []) as string[]).map((rule, index) => (
          <div className="row" key={`${index}-${rule}`} style={{ gap: 12 }}>
            <span className="grow selectable">{rule}</span>
            <Button kind="flat" small onClick={() => p.edit(permissions.removeRule(p.base(), index))}>Remove</Button>
          </div>
        ))}
        {((policy.rules || []) as string[]).length < permissions.RULES_MAX && (
          <AddField placeholder="Always check with me before you buy anything." onAdd={(text) => {
            const clean = permissions.cleanRule(text);
            if (clean) p.edit(permissions.addRule(p.base(), clean));
            else p.app.toast(`A rule is one to ${permissions.RULE_MAX} characters`);
            return !!clean;
          }} />
        )}
      </Group>

      <Group title="Websites Workers may reach"
        note="In Balanced, Auto and Instinct, a Worker may reach these and their subdomains without asking.">
        {(((policy.network || {}).allow || []) as string[]).map((host) => (
          <div className="row" key={host} style={{ gap: 12 }}>
            <span className="mono grow selectable">{host}</span>
            <Button kind="flat" small onClick={() => p.edit(permissions.removeFleetHost(p.base(), host))}>Remove</Button>
          </div>
        ))}
        <AddField placeholder="registry.npmjs.org" onAdd={(text) => {
          const clean = permissions.cleanHost(text);
          if (clean) p.edit(permissions.addFleetHost(p.base(), clean));
          else p.app.toast("That is not a website name (like registry.npmjs.org)");
          return !!clean;
        }} />
      </Group>

      <Group title="This computer">
        {config.MACHINES.map((m) => {
          const read = p.reads[m.machine];
          const line = p.failed[m.machine] || permissions.computerLine(read ?? null, revision);
          const name: string | undefined = read?.computer;
          const own = name ? ((policy.computers || {})[name] || {}).preset ?? null : null;
          return (
            <div className="col" key={m.machine} style={{ gap: 6 }}>
              <div className="row" style={{ gap: 12 }}>
                <span className="mono grow">{config.label(m.machine)}</span>
                <span className="dim">{line}</span>
              </div>
              {read && name && (
                <div className="row chips">
                  {[null, ...permissions.PRESET_ORDER].map((choice) => (
                    <Chip key={choice ?? "fleet"} label={choice ? permissions.presetTitle(choice, status) : "Same as above"}
                      active={own === choice}
                      onClick={() => p.edit(permissions.setComputerPreset(p.base(), name, choice))} />
                  ))}
                </div>
              )}
              {read && permissions.isBehind(read, revision) && (
                <div><Button kind="flat" onClick={() => p.bringUp(m)}>Bring up to date</Button></div>
              )}
            </div>
          );
        })}
      </Group>

      <Group title="Projects"
        note="A project can have its own preset and its own number of Workers, whichever computer it runs on. Set one apart, then pick its preset; it keeps the one it runs under now until you do.">
        {Object.entries((policy.projects || {}) as Record<string, Dict>).map(([key, level]) => {
          const [value, own] = permissions.projectMaxWorkers(policy, key);
          return (
            <div className="col" key={key} style={{ gap: 6 }}>
              <div className="row chips">
                <span className="mono grow selectable">{key}</span>
                {permissions.PRESET_ORDER.map((choice) => (
                  <Chip key={choice} label={permissions.presetTitle(choice, status)} active={level.preset === choice}
                    onClick={() => p.edit(permissions.setProjectPreset(p.base(), key, choice))} />
                ))}
                <Chip label="Merge on green" active={!!(level.foreman || {}).mergeOnGreen}
                  onClick={() => p.edit(permissions.setProjectMergeOnGreen(p.base(), key, !(level.foreman || {}).mergeOnGreen))} />
                <Button kind="flat" small onClick={() => p.edit(permissions.removeProject(p.base(), key))}>Remove</Button>
              </div>
              <div className="row" style={{ gap: 12 }}>
                <span className="mono grow">{own ? "Workers at once" : "Workers at once (fleet)"}</span>
                <NumberField value={value} min={0} max={caps.workersPerProject}
                  onChange={(v) => p.edit(permissions.setProjectMaxWorkers(p.base(), key, Math.trunc(v)))} />
              </div>
              {((isDict(level.network) && Array.isArray(level.network.allow) ? level.network.allow : []) as string[]).map((host) => (
                <div className="row" key={host} style={{ gap: 12 }}>
                  <span className="mono grow selectable">{host} <span className="dim">its Workers may reach it without asking</span></span>
                  <Button kind="flat" small onClick={() => p.edit(permissions.removeProjectHost(p.base(), key, host))}>Remove</Button>
                </div>
              ))}
            </div>
          );
        })}
        {permissions.projectChoices(p.answered(), policy).map((choice) => (
          <div className="row" key={choice.key} style={{ gap: 12 }}>
            <span className="mono grow selectable">
              {choice.name} <span className="dim">{choice.key} · {choice.runs.map((run) => permissions.presetTitle(run, status)).join(", ")} now</span>
            </span>
            <Button kind="flat" small onClick={() => p.edit(permissions.setProjectPreset(p.base(), choice.key, permissions.startingPreset(choice)))}>Set apart</Button>
          </div>
        ))}
        <AddField placeholder="owner/repo" onAdd={(text) => {
          const clean = permissions.cleanProject(text);
          if (clean) p.edit(permissions.setProjectPreset(p.base(), clean, "locked"));
          else p.app.toast("Name a project as owner/repo");
          return !!clean;
        }} />
      </Group>

      <Group title="Judge"
        note={`${permissions.judgeLine(status)}. It decides only what a preset hands to it, and never sees a file's contents.`} />

      <Group title="Lead and Foremen"
        note="A project's own Workers and merge on green are under PROJECTS; every project's Workers together stay within the computer's number. The Lead never writes code or starts Workers itself.">
        <Stepper p={p} title="Workers at once in a project" policy={policy} role="foreman" field="maxWorkers" low={0} high={caps.workersPerProject} />
        <Stepper p={p} title="Workers at once on a computer" policy={policy} role="foreman" field="maxWorkersPerComputer" low={0}
          high={caps.workersPerComputer ?? permissions.HARD_CAPS_FALLBACK.workersPerComputer} />
        <div className="dim">Models Workers may use</div>
        <div className="row chips">
          {permissions.MODEL_CHOICES.map(([model, title]) => (
            <Chip key={model} label={title} active={models === null || models === undefined || models.includes(model)}
              onClick={() => p.edit(permissions.setFleetRole(p.base(), "foreman", "workerModels",
                permissions.toggleModel(permissions.fleetRole(p.base(), "foreman", "workerModels"), model)))} />
          ))}
        </div>
        <div className="row" style={{ gap: 12 }}>
          <span className="mono grow">Foremen use the web</span>
          <Switch checked={!!permissions.fleetRole(policy, "foreman", "webTools")}
            onChange={(on) => p.edit(permissions.setFleetRole(p.base(), "foreman", "webTools", on))} />
        </div>
        <div className="row" style={{ gap: 12 }}>
          <span className="mono grow">The Lead uses the web</span>
          <Switch checked={!!permissions.fleetRole(policy, "lead", "webTools")}
            onChange={(on) => p.edit(permissions.setFleetRole(p.base(), "lead", "webTools", on))} />
        </div>
        <Stepper p={p} title="Read-only jobs at once" policy={policy} role="job" field="concurrent" low={0} high={caps.jobsAtOnce} />
      </Group>

      <ChangeBlock p={p} />

      {changes.length > 0 && (
        <Group title="Changes">
          {changes.slice(0, 10).map((entry, i) => (
            <div className="col" key={i} style={{ gap: 2 }}>
              <div className="dim">{shortWhen(entry.at)} · {entry.by ?? ""}</div>
              {((entry.lines || []) as Dict[]).map((line, j) => <div className="dim" key={j}>{permissions.changeLine(line)}</div>)}
            </div>
          ))}
        </Group>
      )}
    </>
  );
}

/** THIS CHANGE: Review in words, then Apply to every computer that answered (the second press when
 * it grants more), or Discard. Nothing while there is no change. LOCAL MODELS shows its own copy. */
export function ChangeBlock({ p }: { p: PermissionsController }) {
  const found = p.fleet();
  if (!found || !p.draft || !permissions.changed(p.draft, found[1].policy)) return null;
  const source = found[0];
  const review = p.review;
  const c = p.applyConfirm;
  const online = Object.values(p.reads).filter((v) => v).length;
  const caption = c.busy ? "Applying…" : c.armed ? "Press again to allow more" : online === 1 ? "Apply" : "Apply";
  return (
    <div className="card change-card">
      <div className="caps">This change</div>
      {review === null ? (
        <div className="row">
          <Button kind="primary" onClick={() => p.reviewChange(source)}>Review changes</Button>
          <Button kind="flat" onClick={() => p.discard()}>Discard</Button>
        </div>
      ) : (
        <>
          {!(review.lines || []).length && <div className="dim">Nothing changes on that computer.</div>}
          {((review.lines || []) as Dict[]).map((line, i) => (
            <div key={i} className={cls(line.widens ? "mono" : "dim")}>{permissions.changeLine(line)}</div>
          ))}
          {review.widens && <div className="dim">{permissions.WIDENS_NOTE}</div>}
          <div className="row">
            <Button kind={c.armed ? "danger" : "primary"} disabled={c.busy} onClick={() => p.pressApply()}>{caption}</Button>
            <Button kind="flat" onClick={() => p.discard()}>Discard</Button>
          </div>
        </>
      )}
    </div>
  );
}

/** API CREDITS: the fleet's switch and monthly cap, edited into the
 * draft like any other setting (Review, then Apply; turning it on or raising the cap takes the
 * second press), and each computer's key and spend from its GET /api-lane. */
function ApiCredits({ p, policy }: { p: PermissionsController; policy: Dict }) {
  const lane = permissions.apiLane(policy);
  const spent = permissions.fleetSpend(p.lanes);
  const test = permissions.testLine(p.lanes);
  return (
    <Group title="API credits" note={permissions.API_BLURB} footnote={permissions.KEY_HOWTO}>
      <label className="radio-row">
        <input type="checkbox" checked={lane.enabled} onChange={(e) => {
          const now = permissions.apiLane(p.base());
          if (e.target.checked !== now.enabled) p.edit(permissions.setApiLane(p.base(), e.target.checked, now.monthlyCapUsd));
        }} />
        <span>Use API credits when the subscription is full</span>
      </label>
      <div className="row" style={{ gap: 12 }}>
        <span className="mono grow">Monthly cap in dollars</span>
        <NumberField value={lane.monthlyCapUsd} min={0} max={100_000} step={5} digits={2} onChange={(v) => {
          const now = permissions.apiLane(p.base());
          if (Math.round(v * 100) / 100 !== now.monthlyCapUsd) p.edit(permissions.setApiLane(p.base(), now.enabled, v));
        }} />
      </div>
      {lane.enabled && lane.monthlyCapUsd > 0 && (
        <div className="dim">
          {permissions.money(spent)} of {permissions.money(lane.monthlyCapUsd)} this month · you are told at 50%, 80% and the cap
        </div>
      )}
      <label className="radio-row" title={permissions.TEST_BLURB}>
        <input type="checkbox" checked={lane.enabled && lane.testMode} disabled={!lane.enabled || lane.monthlyCapUsd <= 0} onChange={(e) => {
          const now = permissions.apiLane(p.base());
          if (e.target.checked !== now.testMode) p.edit(permissions.setApiLane(p.base(), now.enabled, now.monthlyCapUsd, e.target.checked));
        }} />
        <span>API test mode: run everything on API credits</span>
      </label>
      <div className="dim">{permissions.TEST_BLURB}</div>
      {test && <div className="dim">{test}</div>}
      {config.MACHINES.map((m) => {
        const read = p.lanes[m.machine];
        const words = !(m.machine in p.lanes) ? "asking…" : read === null ? "update its agent to use API credits there" : permissions.laneLine(read);
        return (
          <div className="row" key={m.machine} style={{ gap: 12, alignItems: "flex-start" }}>
            <span className="mono">{config.label(m.machine)}</span>
            <span className="dim grow">{words}</span>
          </div>
        );
      })}
    </Group>
  );
}

function Stepper({ p, title, policy, role, field, low, high }: {
  p: PermissionsController; title: string; policy: Dict; role: string; field: string; low: number; high: number;
}) {
  return (
    <div className="row" style={{ gap: 12 }}>
      <span className="mono grow">{title}</span>
      <NumberField value={Number(permissions.fleetRole(policy, role, field))} min={low} max={high}
        onChange={(v) => p.edit(permissions.setFleetRole(p.base(), role, field, Math.trunc(v)))} />
    </div>
  );
}

/** An entry and Add; Enter adds too. `onAdd` says whether it was taken, and the field empties if so. */
function AddField({ placeholder, onAdd }: { placeholder: string; onAdd: (text: string) => boolean }) {
  const [text, setText] = useState("");
  const add = () => {
    if (onAdd(text)) setText("");
  };
  return (
    <div className="row">
      <input className="entry grow" placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()} />
      <Button onClick={add}>Add</Button>
    </div>
  );
}
