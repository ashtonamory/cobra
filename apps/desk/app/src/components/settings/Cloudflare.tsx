/**
 * Settings → Integrations → CLOUDFLARE: per computer, the owner's own Cloudflare account, where the
 * Website Builder puts the Spaces' sites (`GET /integrations/cloudflare`; Phase 2). Connect first says what Cloudflare will ask to grant, then asks the
 * computer for the sign-in page (`POST …/start`) and opens it in the browser; Cloudflare sends the
 * browser to cobra.example.com/connect/cloudflare, which shows a connection code to paste here, and
 * Finish hands it to the computer (`POST …/finish`), which swaps it for the token itself. A sign-in
 * that reaches several accounts asks which one the sites go in. Disconnect (behind a confirm)
 * revokes the token at Cloudflare. Words in lib/cloudflare.ts.
 */
import { useEffect, useRef, useState } from "react";
import * as api from "../../lib/api.ts";
import * as config from "../../lib/config.ts";
import * as cloudflare from "../../lib/cloudflare.ts";
import type { Dict, Json } from "../../lib/json.ts";
import { Board, BoardRow, Button } from "../ui.tsx";
import { Confirm } from "../Verbs.tsx";
import { Controller, Group, Spinner, openUri, statusOf, why } from "./common.tsx";

export class CloudflareController extends Controller {
  status: Record<string, Dict> = {};    // machine → CloudflareIntegration
  failed: Record<string, string> = {};  // machine → why it did not answer
  reading = new Set<string>();          // computers with a read in flight
  busy = new Set<string>();             // computers with a start, finish, choice or disconnect in flight
  noting = new Set<string>();           // computers showing what Connect grants, before the browser opens
  pasting = new Set<string>();          // computers showing the connection code box
  hidden = new Set<string>();           // computers whose code box was cancelled while the computer still waits
  removing: string | null = null;       // the computer whose Disconnect waits on the confirm
  generation = 0;

  reload() {
    this.generation += 1;
    this.status = {};
    this.failed = {};
    this.draw();
    for (const m of config.MACHINES) this.read(m.machine);
  }

  read(machine: string) {
    const gen = this.generation;
    this.reading.add(machine);
    this.draw();
    api.cloudflareIntegration(machine).then(
      (reply) => {
        if (gen !== this.generation) return;
        this.reading.delete(machine);
        delete this.failed[machine];
        this.keep(machine, reply);
      },
      (e) => {
        if (gen !== this.generation) return;
        this.reading.delete(machine);
        this.failed[machine] = cloudflare.failureLine(statusOf(e), why(e), config.label(machine));
        this.draw();
      },
    );
  }

  /** Keep what the computer answered (every route answers the connection as it is now). */
  keep(machine: string, reply: Json) {
    this.status[machine] = reply && typeof reply === "object" && !Array.isArray(reply) ? reply : {};
    if (cloudflare.cloudflareView(this.status[machine], "").fix !== "connect") this.pasting.delete(machine);
    this.draw();
  }

  async run(machine: string, call: () => Promise<Json>, failed: string, then?: () => void) {
    if (this.busy.has(machine)) return;
    this.busy.add(machine);
    this.draw();
    try {
      const reply = await call();
      this.busy.delete(machine);
      then?.();
      this.keep(machine, reply);
    } catch (e) {
      this.busy.delete(machine);
      this.app.toast(`${failed}: ${why(e)}`);
      this.draw();
    }
  }

  connect(machine: string) {
    this.noting.add(machine);
    this.draw();
  }

  cancel(machine: string) {
    this.noting.delete(machine);
    this.pasting.delete(machine);
    this.hidden.add(machine);
    this.draw();
  }

  /** After the note: the sign-in page in the browser, then the box for its code. */
  async start(machine: string) {
    if (this.busy.has(machine)) return;
    this.busy.add(machine);
    this.draw();
    try {
      const reply = await api.cloudflareStart(machine);
      const url = reply && typeof reply === "object" && typeof reply.url === "string" ? reply.url : "";
      if (!/^https:\/\//.test(url)) throw new Error(`${config.label(machine)} gave no sign-in page`);
      openUri(url);
      this.noting.delete(machine);
      this.hidden.delete(machine);
      this.pasting.add(machine);
      this.app.toast(cloudflare.OPENED_TOAST);
    } catch (e) {
      this.app.toast(`Couldn't start the sign-in: ${why(e)}`);
    }
    this.busy.delete(machine);
    this.read(machine);
  }

  finish(machine: string, text: string) {
    const checked = cloudflare.checkCode(text);
    if (!checked.ok) {
      this.app.toast(checked.why);
      return;
    }
    void this.run(machine, () => api.cloudflareFinish(machine, checked.code), "Not connected", () => {
      this.pasting.delete(machine);
      this.app.toast(`${config.label(machine)} is connected to Cloudflare`);
    });
  }

  choose(machine: string, account: cloudflare.Account) {
    void this.run(machine, () => api.cloudflareAccount(machine, account.id), "Not changed", () => {
      this.app.toast(`Websites from ${config.label(machine)} go in ${account.name}`);
    });
  }

  askDisconnect(machine: string) {
    this.removing = machine;
    this.draw();
  }

  disconnect(machine: string) {
    this.noting.delete(machine);
    this.pasting.delete(machine);
    void this.run(machine, () => api.cloudflareDisconnect(machine), "Couldn't disconnect", () => {
      this.app.toast(`${config.label(machine)} is no longer connected to Cloudflare`);
    });
  }
}

export function CloudflareSection({ c, only }: { c: CloudflareController; only: string | null }) {
  if (!config.MACHINES.length) return null;
  const removing = c.removing;
  return (
    <>
      {config.MACHINES.filter((m) => only === null || m.machine === only).map((m) => <Machine key={m.machine} c={c} m={m} />)}
      {removing && (
        <Confirm
          title={`Disconnect Cloudflare from ${config.label(removing)}?`}
          body={"Its sign-in is revoked at Cloudflare and deleted here. Websites already published stay up in your account; " +
            "nothing new is published until you connect again."}
          yes="Disconnect"
          danger
          onYes={() => c.disconnect(removing)}
          onClose={() => { c.removing = null; c.draw(); }}
        />
      )}
    </>
  );
}

function Machine({ c, m }: { c: CloudflareController; m: config.Machine }) {
  const computer = config.label(m.machine);
  const reading = c.reading.has(m.machine);
  const busy = c.busy.has(m.machine);
  const refresh = (
    <Button kind="flat" disabled={reading} title="Ask this computer again" onClick={() => c.read(m.machine)}>Refresh</Button>
  );
  if (m.machine in c.failed && !(m.machine in c.status)) {
    return (
      <Group title="Cloudflare" note={cloudflare.BLURB}>
        <Board>
          <BoardRow time={null} title="Cloudflare" word="no answer" tone="muted" machine={m.machine} detail={c.failed[m.machine]} />
        </Board>
        <div className="row">{refresh}</div>
      </Group>
    );
  }
  const status = c.status[m.machine];
  if (!status) {
    return (
      <Group title="Cloudflare" note={cloudflare.BLURB}>
        <div className="row"><Spinner /><span className="dim">Asking {computer}…</span></div>
      </Group>
    );
  }
  const view = cloudflare.cloudflareView(status, computer);
  const accounts = cloudflare.accountsOf(status);
  const chosen = cloudflare.accountOf(status);
  const noting = c.noting.has(m.machine);
  const pasting = view.fix === "connect" && (c.pasting.has(m.machine) || (view.waiting && !c.hidden.has(m.machine)));
  const connected = view.fix === "none" || view.fix === "choose" || (status.state === "attention" && chosen !== null);
  return (
    <Group title="Cloudflare" note={cloudflare.BLURB}>
      <Board>
        <BoardRow time={null} title="Cloudflare" word={view.word} tone={view.tone} machine={m.machine} detail={view.detail || null} />
      </Board>

      {accounts.length > 1 && (view.fix === "choose" || view.fix === "none") && (
        <>
          <span className="caps">{view.fix === "choose" ? "Which account your websites go in" : "Accounts this sign-in reaches"}</span>
          <Board>
            {accounts.map((a) => {
              const inUse = chosen?.id === a.id;
              return (
                <BoardRow key={a.id} time={null} title={a.name} word={inUse ? "in use" : ""} tone={inUse ? "ink" : "muted"} keepActions
                  actions={inUse ? null : (
                    <Button kind={view.fix === "choose" ? "primary" : "flat"} small disabled={busy} onClick={() => c.choose(m.machine, a)}>Use</Button>
                  )} />
              );
            })}
          </Board>
        </>
      )}

      {noting && (
        <div className="col" style={{ gap: 6 }}>
          <span className="caps">Before you connect</span>
          <div className="dim">{cloudflare.ADMIN_NOTE}</div>
          <div className="row wrap">
            <Button kind="primary" disabled={busy} title="Opens Cloudflare's sign-in page in the browser" onClick={() => void c.start(m.machine)}>
              Open Cloudflare
            </Button>
            <Button kind="flat" onClick={() => c.cancel(m.machine)}>Cancel</Button>
          </div>
        </div>
      )}

      {pasting && !noting && <CodePaste c={c} machine={m.machine} busy={busy} />}

      <div className="row wrap">
        {view.fix === "connect" && !noting && (
          <Button kind={pasting ? "flat" : "primary"} disabled={busy} onClick={() => c.connect(m.machine)}>
            {pasting ? "Start again" : status.state === "attention" ? "Connect again" : "Connect Cloudflare"}
          </Button>
        )}
        {connected && (
          <Button kind="danger" disabled={busy} title="Revoke this computer's sign-in at Cloudflare" onClick={() => c.askDisconnect(m.machine)}>
            Disconnect
          </Button>
        )}
        {refresh}
        {(reading || busy) && <Spinner />}
      </div>
    </Group>
  );
}

function CodePaste({ c, machine, busy }: { c: CloudflareController; machine: string; busy: boolean }) {
  const [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="dim">{cloudflare.PASTE_LINE}:</div>
      <div className="row">
        <input ref={field} className="entry grow" placeholder="Connection code" value={text} autoComplete="off" spellCheck={false}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && c.finish(machine, text)} />
        <Button kind="primary" disabled={busy || !text.trim()} onClick={() => c.finish(machine, text)}>Finish</Button>
        <Button kind="flat" onClick={() => c.cancel(machine)}>Cancel</Button>
      </div>
    </div>
  );
}
