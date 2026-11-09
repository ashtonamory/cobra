/**
 * Settings → Integrations → GOOGLE: per computer, whether its agent can use the account's Google
 * connection (`GET /integrations/google`; design: Connect for everyone). Connected: as whom, and what the connection allows. Not: why, in
 * plain words, with the fix — add Google's MCP connector, Connect
 * Google (the account page in the browser: this desk holds a desk key, not an account session, so
 * it cannot connect Google itself), or try again shortly. After Connect Google the desk reads the
 * computer again every few seconds for a few minutes, until it is connected. Under a connected
 * computer, Calendar and Mail (Connected reads): on, or Turn on, which opens the account page the
 * same way and watches until that read is on. Words in lib/google.ts.
 */
import * as api from "../../lib/api.ts";
import * as config from "../../lib/config.ts";
import { APP_NAME } from "../../lib/appName.ts";
import * as google from "../../lib/google.ts";
import type { Dict } from "../../lib/json.ts";
import { Board, BoardRow, Button } from "../ui.tsx";
import { Controller, Group, Spinner, openUri, statusOf, why } from "./common.tsx";

export class GoogleController extends Controller {
  status: Record<string, Dict> = {};    // machine → GoogleIntegration
  failed: Record<string, string> = {};  // machine → why it did not answer
  reading = new Set<string>();          // computers with a read in flight
  watching: Record<string, { since: number; read: google.ReadName | null }> = {};  // machine → when Connect Google or Turn on was pressed (ms), and which read
  timer: ReturnType<typeof setInterval> | null = null;
  generation = 0;

  reload() {
    this.generation += 1;
    this.status = {};
    this.failed = {};
    this.draw();
    for (const m of config.MACHINES) this.read(m.machine);
  }

  /** One computer, read again (Refresh, or the watch after Connect Google). */
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
        this.keepWatching();
      },
      (e) => {
        if (gen !== this.generation) return;
        this.reading.delete(machine);
        this.failed[machine] = google.failureLine(statusOf(e), why(e), config.label(machine));
        this.draw();
      },
    );
  }

  /** The account page the agent names, in the browser; `read` is a Turn on. */
  async connect(machine: string, read: google.ReadName | null = null) {
    const page = google.accountPage(this.status[machine]?.accountUrl ?? null);
    if (page === null) {
      this.app.toast(`${config.label(machine)}'s agent has no Google sign-in page yet.`);
      return;
    }
    openUri(page);
    if (read === null ? google.googleView(this.status[machine], "").fix === "none" : google.readOn(this.status[machine], read)) return;
    this.app.toast(google.watchToast(read));
    this.watching[machine] = { since: Date.now(), read };
    this.keepWatching();
    this.draw();
  }

  keepWatching() {
    const now = Date.now();
    let ended = false;
    for (const [machine, { since, read }] of Object.entries(this.watching)) {
      if (!google.keepWatching(this.status[machine], since, now, read)) {
        delete this.watching[machine];
        ended = true;
      }
    }
    if (ended) this.draw();
    const busy = Object.keys(this.watching).length > 0;
    if (busy && !this.timer) {
      this.timer = setInterval(() => {
        for (const machine of Object.keys(this.watching)) if (!this.reading.has(machine)) this.read(machine);
        this.keepWatching();
      }, google.WATCH_EVERY_MS);
    } else if (!busy) this.stopTimer();
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stop() {
    this.stopTimer();
    this.watching = {};
  }
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
  const checked = google.checkedLine(status.checkedAt);
  const watching = c.watching[m.machine];
  const reads = google.readRows(status);
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
      {reads.length > 0 && (
        <>
          <span className="caps">What {APP_NAME} can read</span>
          <Board>
            {reads.map((row) => (
              <BoardRow key={row.name} time={null} title={row.title} word={row.word} tone={row.tone}
                detail={row.note ? <>{row.line}<br />{row.note}</> : row.line}
                keepActions
                actions={row.on ? null : (
                  <Button kind="flat" small title="Opens your account page in the browser, where you turn it on"
                    onClick={() => void c.connect(m.machine, row.name)}>Turn on</Button>
                )} />
            ))}
          </Board>
          <div className="dim">{google.READS_NOTE}</div>
        </>
      )}
      <div className="row wrap">
        {view.fix === "connect" && (
          <Button kind="primary" title="Opens your account page in the browser, where you sign in to Google"
            onClick={() => void c.connect(m.machine)}>Connect Google</Button>
        )}
        {view.fix === "none" && (
          <Button kind="flat" title="Change or disconnect Google on your account page, in the browser"
            onClick={() => void c.connect(m.machine)}>Account page</Button>
        )}
        {view.fix === "retry" ? (
          <Button kind="primary" disabled={busy} onClick={() => c.read(m.machine)}>Try again</Button>
        ) : refresh}
        {(busy || watching) && <Spinner />}
        {watching && !busy && <span className="dim">{google.watchLine(watching.read)}</span>}
      </div>
      {checked && <div className="dim">{checked}</div>}
    </Group>
  );
}
