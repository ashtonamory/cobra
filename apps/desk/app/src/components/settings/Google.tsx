/**
 * Settings → Integrations → GOOGLE: per computer, whether its agent can use Google
 * (`GET /integrations/google`). Connected: as whom, what it allows, and Disconnect. Not: why, in
 * plain words, with the fix: the setup steps for the person's own Google client and a box to paste
 * its JSON, Connect Google (the agent answers Google's sign-in page and the desk opens it in the
 * browser), or try again shortly. After Connect Google the desk reads the computer again every few
 * seconds for a few minutes, until it is connected. Under a connected computer, Calendar and Mail
 * (Connected reads): on, or Turn on, which opens Google's page with that read added and watches
 * until it is on. Words in lib/google.ts.
 */
import { useState } from "react";
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
  saving = new Set<string>();          // computers with a client being saved, or a disconnect in flight
  changing = new Set<string>();        // computers whose setup steps are open while connected

  /** Keep the client JSON the person pasted, then read the computer again. */
  async saveClient(machine: string, json: string): Promise<boolean> {
    this.saving.add(machine);
    this.draw();
    try {
      await api.googleClient(machine, json);
      this.changing.delete(machine);
      this.app.toast("Google client saved. Now press Connect Google.");
      this.read(machine);
      return true;
    } catch (e) {
      this.app.toast(why(e));
      return false;
    } finally {
      this.saving.delete(machine);
      this.draw();
    }
  }

  async disconnect(machine: string, forgetClient = false) {
    this.saving.add(machine);
    this.draw();
    try {
      await api.googleDisconnect(machine, forgetClient);
      this.app.toast(forgetClient ? "Google disconnected, and the client removed" : "Google disconnected");
    } catch (e) {
      this.app.toast(why(e));
    } finally {
      this.saving.delete(machine);
      this.read(machine);
    }
  }

  toggleChange(machine: string) {
    if (this.changing.has(machine)) this.changing.delete(machine);
    else this.changing.add(machine);
    this.draw();
  }

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

  /** Google's sign-in page from the agent, in the browser; `read` is a Turn on. */
  async connect(machine: string, read: google.ReadName | null = null) {
    let page: string | null = null;
    try {
      const reply = await api.googleConnect(machine, read);
      page = google.signInPage(reply?.url ?? null);
    } catch (e) {
      this.app.toast(why(e));
      this.read(machine);
      return;
    }
    if (page === null) {
      this.app.toast(`${config.label(machine)}'s agent did not give a Google sign-in page.`);
      return;
    }
    openUri(page);
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
                  <Button kind="flat" small title="Opens Google's page in the browser, where you allow it"
                    onClick={() => void c.connect(m.machine, row.name)}>Turn on</Button>
                )} />
            ))}
          </Board>
          <div className="dim">{google.READS_NOTE}</div>
        </>
      )}
      {(view.fix === "setup" || c.changing.has(m.machine)) && <Setup c={c} machine={m.machine} />}
      <div className="row wrap">
        {view.fix === "connect" && (
          <Button kind="primary" title="Opens Google's page in your browser, where you sign in"
            onClick={() => void c.connect(m.machine)}>Connect Google</Button>
        )}
        {view.fix === "none" && status.connected === true && (
          <Button kind="flat" disabled={c.saving.has(m.machine)} title="Signs out of Google on this computer; the client stays"
            onClick={() => void c.disconnect(m.machine)}>Disconnect</Button>
        )}
        {status.clientSet === true && view.fix !== "setup" && (
          <Button kind="flat" title="Paste a different Google client"
            onClick={() => c.toggleChange(m.machine)}>{c.changing.has(m.machine) ? "Keep this client" : "Change client"}</Button>
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

/** The steps in Google Cloud, a box for the client JSON, and Save. */
function Setup({ c, machine }: { c: GoogleController; machine: string }) {
  const [text, setText] = useState("");
  const busy = c.saving.has(machine);
  const save = async () => {
    if (await c.saveClient(machine, text)) setText("");
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      <span className="caps">Set up your Google client, once</span>
      <ol className="col" style={{ gap: 4, margin: 0, paddingLeft: 20 }}>
        {google.SETUP_STEPS.map((step, i) => (
          <li key={step} className="dim">
            {step}
            {i === 0 && <> <Button kind="flat" small onClick={() => openUri(google.CONSOLE_URL)}>Open Google Cloud</Button></>}
          </li>
        ))}
      </ol>
      <div className="dim">{google.SETUP_NOTE}</div>
      <textarea className="entry mono" rows={5} value={text} placeholder='{"installed":{"client_id":"…apps.googleusercontent.com", …}}'
        aria-label="Google client JSON" autoComplete="off" spellCheck={false} disabled={busy} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <Button kind="primary" disabled={busy || !text.trim()} onClick={() => void save()}>Save</Button>
        {busy && <Spinner />}
      </div>
    </div>
  );
}
