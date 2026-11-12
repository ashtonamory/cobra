/**
 * Settings → Integrations → GOOGLE: which of Gmail, Google Calendar and Google Drive the Claude
 * account on this computer has connected (`GET /integrations/google`). Cobra has no Google sign-in
 * of its own, so nothing is connected here: the button opens claude.ai's connector settings, and
 * Refresh asks the agent again. Words in lib/google.ts.
 */
import * as api from "../../lib/api.ts";
import * as config from "../../lib/config.ts";
import * as google from "../../lib/google.ts";
import type { Dict } from "../../lib/json.ts";
import { Board, BoardRow, Button } from "../ui.tsx";
import { Controller, Group, Spinner, openUri, statusOf, why } from "./common.tsx";

export class GoogleController extends Controller {
  status: Record<string, Dict> = {};    // machine → GoogleIntegration
  failed: Record<string, string> = {};  // machine → why it did not answer
  reading = new Set<string>();          // computers with a read in flight
  generation = 0;

  reload() {
    this.generation += 1;
    this.status = {};
    this.failed = {};
    this.draw();
    for (const m of config.MACHINES) this.read(m.machine);
  }

  /** One computer, read again (Refresh). */
  read(machine: string) {
    const gen = this.generation;
    this.reading.add(machine);
    this.draw();
    api.googleIntegration(machine).then(
      (reply) => {
        if (gen !== this.generation) return;
        this.reading.delete(machine);
        delete this.failed[machine];
        this.status[machine] = reply || {};
        this.draw();
      },
      (e) => {
        if (gen !== this.generation) return;
        this.reading.delete(machine);
        this.failed[machine] = google.failureLine(statusOf(e), why(e), config.label(machine));
        this.draw();
      },
    );
  }

  /** Nothing runs between reads; kept so the page that owns this controller can stop it as it does the others. */
  stop() {}
}

export function GoogleSection({ c, only }: { c: GoogleController; only: string | null }) {
  if (!config.MACHINES.length) return null;
  return <>{config.MACHINES.filter((m) => only === null || m.machine === only).map((m) => <Machine key={m.machine} c={c} m={m} />)}</>;
}

function Machine({ c, m }: { c: GoogleController; m: config.Machine }) {
  const computer = config.label(m.machine);
  const busy = c.reading.has(m.machine);
  const refresh = (
    <Button kind="flat" disabled={busy} title="Ask this computer again" onClick={() => c.read(m.machine)}>Refresh</Button>
  );
  if (m.machine in c.failed && !(m.machine in c.status)) {
    return (
      <Group title="Google" note={google.BLURB}>
        <Board>
          <BoardRow time={null} title="Google" word="no answer" tone="muted" machine={m.machine} detail={c.failed[m.machine]} />
        </Board>
        <div className="row">{refresh}</div>
      </Group>
    );
  }
  const status = c.status[m.machine];
  if (!status) {
    return (
      <Group title="Google" note={google.BLURB}>
        <div className="row"><Spinner /><span className="dim">Asking {computer}…</span></div>
      </Group>
    );
  }
  const view = google.googleView(status, computer);
  return (
    <Group title="Google" note={google.BLURB}>
      <Board>
        <BoardRow time={null} title="Google" word={view.word} tone={view.tone} machine={m.machine} detail={view.detail || null} />
      </Board>
      {view.allows.length > 0 && (
        <div className="col" style={{ gap: 2 }}>
          <span className="caps">What it allows</span>
          {view.allows.map((line) => <span key={line} className="dim">{line}</span>)}
        </div>
      )}
      <div className="row wrap">
        <Button kind="flat" title="Opens claude.ai's connector settings in the browser"
          onClick={() => openUri(google.CONNECTORS_PAGE)}>Claude connectors</Button>
        {refresh}
        {busy && <Spinner />}
      </div>
    </Group>
  );
}
