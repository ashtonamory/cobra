/**
 * Settings → Audit log: per computer, what its agent did, newest first (`GET /audit/log`, the agent's
 * auditTrail.ts), read only: nothing here changes the log. Older pages come with Show older; Tool
 * decisions adds the policy's answers to Workers' tool calls, which are most of the lines. Words in
 * lib/auditLog.ts.
 */
import * as api from "../../lib/api.ts";
import * as audit from "../../lib/auditLog.ts";
import * as config from "../../lib/config.ts";
import { Board, BoardRow, Button } from "../ui.tsx";
import { Chip, Controller, Group, Spinner, statusOf, why } from "./common.tsx";

interface Shown {
  rows: audit.AuditRow[];
  more: boolean;
}

export class AuditLogController extends Controller {
  shown: Record<string, Shown> = {};   // machine → the rows read so far
  failed: Record<string, string> = {}; // machine → why it gave no log
  busy = new Set<string>();            // computers with a page in flight
  all = false;                         // tool decisions too
  generation = 0;

  reload() {
    this.generation += 1;
    this.shown = {};
    this.failed = {};
    this.draw();
    for (const m of config.MACHINES) void this.read(m.machine, false);
  }

  setAll(all: boolean) {
    this.all = all;
    this.reload();
  }

  /** The newest page, or (older) the page after the last row shown. */
  async read(machine: string, older: boolean) {
    const gen = this.generation;
    const before = older ? this.shown[machine]?.rows.at(-1)?.id : undefined;
    this.busy.add(machine);
    this.draw();
    try {
      const reply = await api.auditLog(machine, { ...(before ? { before } : {}), all: this.all });
      if (gen !== this.generation) return;
      delete this.failed[machine];
      const kept = older ? (this.shown[machine]?.rows ?? []) : [];
      this.shown[machine] = { rows: [...kept, ...audit.rows(reply)], more: audit.more(reply) };
    } catch (e) {
      if (gen !== this.generation) return;
      this.failed[machine] = audit.failureLine(statusOf(e), why(e), config.label(machine));
    } finally {
      this.busy.delete(machine);
      this.draw();
    }
  }
}

export function AuditLogSection({ c, only }: { c: AuditLogController; only: string | null }) {
  if (!config.MACHINES.length) return null;
  return <>{config.MACHINES.filter((m) => only === null || m.machine === only).map((m) => <Machine key={m.machine} c={c} m={m} />)}</>;
}

function Machine({ c, m }: { c: AuditLogController; m: config.Machine }) {
  const shown = c.shown[m.machine];
  const busy = c.busy.has(m.machine);
  const failed = c.failed[m.machine];
  return (
    <Group title="Audit log" note={audit.VERIFY_NOTE}>
      <div className="row" style={{ gap: 8 }}>
        <Chip label="Tool decisions" active={c.all} onClick={() => c.setAll(!c.all)} />
        <Button kind="flat" small disabled={busy} onClick={() => void c.read(m.machine, false)}>Refresh</Button>
      </div>
      {failed !== undefined ? (
        <Board>
          <BoardRow time={null} title="Audit log" word="no answer" tone="muted" machine={m.machine} detail={failed} />
        </Board>
      ) : !shown ? (
        <div className="row"><Spinner /><span className="dim">Asking {config.label(m.machine)}…</span></div>
      ) : shown.rows.length === 0 ? (
        <div className="dim">{audit.EMPTY}</div>
      ) : (
        <Board head="WHAT HAPPENED">
          {shown.rows.map((row) => (
            <BoardRow key={row.id} time={row.time} title={<span className="selectable">{row.text}</span>} word={row.word} tone={row.tone}
              detail={row.where} tooltip={new Date(row.at).toString()} />
          ))}
        </Board>
      )}
      {shown?.more && (
        <div className="row">
          <Button kind="flat" disabled={busy} onClick={() => void c.read(m.machine, true)}>{busy ? "Reading…" : "Show older"}</Button>
        </div>
      )}
    </Group>
  );
}
