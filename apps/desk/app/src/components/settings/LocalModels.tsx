/**
 * Settings → LOCAL MODELS: per
 * computer, what its Ollama has and how each model did in the agent's check (`GET /local`), Check for one
 * model (`POST /local/check`, which loads it onto the GPU, so only when pressed), how many local-model
 * sessions may run there at once (phase 4, policy `local.slots`), and which local model each helper falls
 * back to there.
 *
 * A helper's choice, like the slots, is a policy change, and the policy is the fleet's: the choice becomes
 * PERMISSIONS' draft and goes through its own Review, second press and Apply to every computer
 * (Permissions.tsx ChangeBlock), shown here too. The words come from lib/localModels.ts.
 */
import { APP_NAME } from "../../lib/appName.ts";
import * as api from "../../lib/api.ts";
import * as config from "../../lib/config.ts";
import * as localmodels from "../../lib/localModels.ts";
import type { Dict } from "../../lib/json.ts";
import { Board, BoardRow, Button, Card } from "../ui.tsx";
import { Controller, Group, NumberField, statusOf, why } from "./common.tsx";
import { ChangeBlock, type PermissionsController } from "./Permissions.tsx";

const POLL_MS = 3000;
const key = (machine: string, model: string) => `${machine}\u0000${model}`;

export class LocalModelsController extends Controller {
  status: Record<string, Dict> = {};     // machine → LocalStatus
  failed: Record<string, string> = {};
  pressed = new Set<string>();           // (machine, model) whose Check was just pressed
  generation = 0;
  pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Shown now: a hidden section does not poll (the desk's get_mapped). */
  mapped = false;

  constructor(draw: () => void, readonly permissions: PermissionsController) {
    super(draw);
  }

  // -- reading ----------------------------------------------------------------

  reload() {
    this.generation += 1;
    this.stop();
    this.status = {};
    this.failed = {};
    this.pressed = new Set();
    this.draw();
    for (const m of config.MACHINES) this.read(m);
  }

  read(m: config.Machine) {
    const gen = this.generation;
    api.local(m.machine).then(
      (reply) => {
        if (gen !== this.generation) return;
        this.status[m.machine] = reply || {};
        delete this.failed[m.machine];
        // A press is answered once the agent says it is checking (or already has a verdict).
        this.pressed = new Set([...this.pressed].filter((k) => !k.startsWith(`${m.machine}\u0000`)));
        this.draw();
        this.keepPolling();
      },
      (e) => {
        if (gen !== this.generation) return;
        this.failed[m.machine] = statusOf(e) === 404 ? `Update ${APP_NAME} on this computer to see its local models here.`
          : `Not answering: ${why(e)}`;
        this.draw();
      },
    );
  }

  stop() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** While a check runs anywhere, read those computers again every few seconds. */
  keepPolling() {
    if (this.pollTimer || !this.mapped) return;
    if (!Object.values(this.status).some((s) => localmodels.anyChecking(s)) && !this.pressed.size) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      for (const m of config.MACHINES) {
        if (localmodels.anyChecking(this.status[m.machine] ?? null) ||
          [...this.pressed].some((k) => k.startsWith(`${m.machine}\u0000`))) this.read(m);
      }
    }, POLL_MS);
  }

  // -- acting -----------------------------------------------------------------

  async check(m: config.Machine, name: string) {
    this.pressed.add(key(m.machine, name));
    this.draw();
    try {
      await api.localCheck(m.machine, name);
      this.read(m);
      this.keepPolling();
    } catch (e) {
      this.pressed.delete(key(m.machine, name));
      this.draw();
      this.app.toast(`Couldn't check ${name}: ${why(e)}`);
    }
  }

  /** The PERMISSIONS policy the change starts from and this computer's name in it, or null (with a
   * toast) while the permissions are still being read. */
  private start(m: config.Machine, status: Dict): [Dict, string, Dict] | null {
    const base = this.permissions.current();
    const read = this.permissions.readFor(m.machine);
    if (base === null || read === null) {
      this.app.toast("Permissions are still being read: try again in a moment");
      this.draw();
      return null;
    }
    return [base, read.computer || status.computer || m.machine, read];
  }

  setSlots(m: config.Machine, status: Dict, slots: number) {
    const found = this.start(m, status);
    if (!found) return;
    const [base, computer] = found;
    this.permissions.edit(localmodels.nextPolicyWithSlots(base, computer, slots));
    this.app.toast("Review the change below, then Apply");
  }

  choose(m: config.Machine, status: Dict, role: string, model: string | null) {
    const found = this.start(m, status);
    if (!found) return;
    const [base, computer, read] = found;
    const chain: string[] = ((read.resolved || {}).fallbacks || {})[role] || [];
    this.permissions.edit(localmodels.nextPolicyWithLocal(base, computer, role, model, [...chain]));
    this.app.toast("Review the change below, then Apply");
  }
}

export function LocalModelsSection({ c, only }: { c: LocalModelsController; only: string | null }) {
  if (!config.MACHINES.length) return <Card><div className="dim">Link a computer first: Settings → Computers.</div></Card>;
  return (
    <>
      {config.MACHINES.filter((m) => only === null || m.machine === only).map((m) => <Machine key={m.machine} c={c} m={m} />)}
      <ChangeBlock p={c.permissions} />
    </>
  );
}

function Machine({ c, m }: { c: LocalModelsController; m: config.Machine }) {
  if (m.machine in c.failed) return <Group title="Models" note={c.failed[m.machine]} />;
  const status = c.status[m.machine];
  if (!status) return <Group title="Models"><div className="dim">Asking…</div></Group>;
  const fix = localmodels.fixLine(status);
  const models: Dict[] = status.models || [];
  const slots: Dict | null = status.slots && typeof status.slots === "object" ? status.slots : null;
  const uses: Dict[] = status.uses || [];
  const now = Date.now();
  return (
    <>
      <Group title="Models">
        <div className="dim">{localmodels.ollamaLine(status)}</div>
        {fix && <div className="dim selectable">{fix}</div>}
        {models.length > 0 && (
          <Board>
            {models.map((row) => {
              const busy = !!row.checking || c.pressed.has(key(m.machine, row.name));
              return (
                <BoardRow key={row.name} time={null} title={row.name} machine={m.machine}
                  word={busy ? "Checking…" : localmodels.rowWord(row)} tone={busy ? "muted" : localmodels.rowTone(row)}
                  detail={localmodels.modelDetail(row, now)} keepActions
                  actions={
                    <Button kind="flat" small disabled={busy || !row.tools} title="Loads the model onto this computer's GPU for up to a minute"
                      onClick={() => c.check(m, row.name)}>
                      {row.check ? "Check again" : "Check"}
                    </Button>
                  } />
              );
            })}
          </Board>
        )}
      </Group>
      {slots && (
        <Group title="Sessions at once" footnote={localmodels.SLOTS_HINT}>
          <Board>
            <BoardRow time={null} title={localmodels.SLOTS_LABEL} word={localmodels.slotsLine(slots)} tone="dim" keepActions
              actions={<NumberField value={Math.trunc(Number(slots.limit || 1))} min={localmodels.SLOTS_MIN} max={localmodels.SLOTS_MAX}
                title="A change here goes through Review, then Apply"
                onChange={(v) => v !== Math.trunc(Number(slots.limit || 1)) && c.setSlots(m, status, Math.trunc(v))} />} />
          </Board>
        </Group>
      )}
      {uses.length > 0 && models.length > 0 && (
        <Group title="Use local models for" footnote={localmodels.USE_FOOTER}>
          <Board>
            {uses.map((use) => <UseRow key={use.role} c={c} m={m} status={status} use={use} />)}
          </Board>
        </Group>
      )}
    </>
  );
}

function UseRow({ c, m, status, use }: { c: LocalModelsController; m: config.Machine; status: Dict; use: Dict }) {
  const options = localmodels.useOptions(status);
  const titles = options.map((o) => o.label);
  let current = options.findIndex((o) => o.model === use.model);
  if (current < 0 && use.model) {
    // A model the policy names that is not offered now (removed, or failed its check): show it as it is.
    titles.push(`${use.model} — not offered now`);
    current = options.length;
  }
  return (
    <BoardRow time={null} title={use.label || use.role} word="" tone="dim" keepActions
      actions={
        <select className="entry" value={Math.max(current, 0)} title="A change here goes through Review, then Apply"
          onChange={(e) => {
            const i = Number(e.target.value);
            if (i < options.length && options[i].model !== use.model) c.choose(m, status, use.role, options[i].model);
          }}>
          {titles.map((t, i) => <option key={i} value={i}>{t}</option>)}
        </select>
      } />
  );
}
