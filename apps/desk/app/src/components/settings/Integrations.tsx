/**
 * Settings → Integrations → GITHUB (beside Google, components/settings/Google.tsx): per computer,
 * GitHub for the Lead and Foremen (`GET /mcp`): its state,
 * and Connect — Sign in with GitHub shows a code to type on GitHub while the computer waits for the token from GitHub itself, or Use a token instead hands it one
 * you paste. Once connected, an on/off switch and Disconnect. Under Advanced, the token's state and the
 * pinned binary with Verify, which asks the computer to check the binary and
 * push your Allow. Presets only; the words come from lib/integrations.ts.
 */
import { useEffect, useRef, useState } from "react";
import * as api from "../../lib/api.ts";
import * as config from "../../lib/config.ts";
import * as integrations from "../../lib/integrations.ts";
import type { Dict, Json } from "../../lib/json.ts";
import { Board, BoardRow, Button, Switch } from "../ui.tsx";
import { Controller, Group, Spinner, openCode, openUri, statusOf, why } from "./common.tsx";

export class IntegrationsController extends Controller {
  status: Record<string, Dict> = {};    // machine → McpStatus
  failed: Record<string, string> = {};  // machine → why it did not answer
  asked = new Set<string>();            // computers whose Verify has pushed an Allow
  verifying = new Set<string>();        // computers with a Verify in flight
  pasting = new Set<string>();          // computers showing the token field
  connecting = new Set<string>();       // computers with a connect or disconnect in flight
  /** A switch flipped and not yet read back: it shows the new state now, as Gtk.Switch did. */
  switched: Record<string, boolean> = {};
  pollTimer: ReturnType<typeof setInterval> | null = null;  // reads computers with something under way
  generation = 0;

  reload() {
    this.generation += 1;
    const gen = this.generation;
    this.status = {};
    this.failed = {};
    this.switched = {};
    this.draw();
    for (const m of config.MACHINES) {
      api.mcp(m.machine).then(
        (reply) => {
          if (gen !== this.generation) return;
          this.status[m.machine] = reply || {};
          this.draw();
          this.keepPolling();
        },
        (e) => {
          if (gen !== this.generation) return;
          this.failed[m.machine] = integrations.failureText(statusOf(e), why(e));
          this.draw();
        },
      );
    }
  }

  // --- connecting -------------------------------------------------------------------

  /** Keep what `/mcp/connect` or `/mcp/disconnect` answered, and draw it. */
  answered(m: config.Machine, reply: Json) {
    this.connecting.delete(m.machine);
    if (m.machine in this.status && reply && typeof reply === "object") {
      this.status[m.machine] = integrations.withIntegration(this.status[m.machine], reply.integration);
    }
    this.draw();
    this.keepPolling();
  }

  async connectCall(m: config.Machine, run: () => Promise<Json>, failed: string, then?: () => void) {
    if (this.connecting.has(m.machine)) return;
    this.connecting.add(m.machine);
    this.draw();
    try {
      const reply = await run();
      then?.();
      this.answered(m, reply);
    } catch (e) {
      this.connecting.delete(m.machine);
      this.app.toast(`${failed}: ${why(e)}`);
      this.draw();
    }
  }

  signIn(m: config.Machine) {
    this.pasting.delete(m.machine);
    void this.connectCall(m, () => api.mcpConnect(m.machine, "github", "device"), "Couldn't start the sign-in");
  }

  showPaste(m: config.Machine) {
    this.pasting.add(m.machine);
    this.draw();
  }

  hidePaste(m: config.Machine) {
    this.pasting.delete(m.machine);
    this.draw();
  }

  saveToken(m: config.Machine, text: string) {
    const token = text.trim();
    if (token.length < 20) {
      this.app.toast("That is not a GitHub token");
      return;
    }
    void this.connectCall(m, () => api.mcpConnect(m.machine, "github", "token", token), "Couldn't keep the token", () => {
      this.pasting.delete(m.machine);
      this.app.toast(`${config.label(m.machine)} has the token`);
    });
  }

  disconnect(m: config.Machine) {
    void this.connectCall(m, () => api.mcpDisconnect(m.machine, "github"), "Couldn't disconnect");
  }

  // --- reading again while something is under way -------------------------------------

  keepPolling() {
    const busy = Object.values(this.status).some((s) => integrations.shouldPoll(integrations.githubIntegration(s)));
    if (busy && !this.pollTimer) this.pollTimer = setInterval(() => this.poll(), 3000);
    else if (!busy) this.stop();
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  poll() {
    const gen = this.generation;
    for (const m of config.MACHINES) {
      if (!integrations.shouldPoll(integrations.githubIntegration(this.status[m.machine] || {}))) continue;
      if (this.connecting.has(m.machine)) continue;
      api.mcp(m.machine).then(
        (reply) => {
          if (gen !== this.generation) return;
          this.status[m.machine] = reply || {};
          delete this.switched[m.machine];
          this.draw();
          this.keepPolling();
        },
        () => {},
      );
    }
  }

  async toggle(m: config.Machine, on: boolean) {
    this.switched[m.machine] = on;
    this.draw();
    try {
      const reply = await api.mcpToggle(m.machine, "github", on);
      // Keep what the computer saved, so a redraw shows this switch and `why`, not the old ones.
      if (m.machine in this.status) {
        this.status[m.machine] = integrations.withEntry(this.status[m.machine], reply);
        this.draw();
      }
      this.app.toast(`GitHub ${on ? "on" : "off"} for ${config.label(m.machine)}`);
    } catch (e) {
      this.app.toast(`Not changed: ${why(e)}`);
      this.reload();
    }
  }

  async verify(m: config.Machine) {
    if (this.verifying.has(m.machine)) return;
    this.verifying.add(m.machine);
    this.draw(); // the button is disabled until the computer answers
    try {
      await api.mcpVerify(m.machine, "github");
      this.verifying.delete(m.machine);
      this.asked.add(m.machine);
      this.app.toast(integrations.askedText(config.label(m.machine)));
    } catch (e) {
      this.verifying.delete(m.machine);
      this.app.toast(`Not verified: ${why(e)}`);
    }
    this.draw();
  }
}

export function IntegrationsSection({ c, only }: { c: IntegrationsController; only: string | null }) {
  if (!config.MACHINES.length) return <div className="dim">Link a computer to set up integrations: Settings → Computers.</div>;
  return (
    <>
      {config.MACHINES.filter((m) => only === null || m.machine === only).map((m) => <Machine key={m.machine} c={c} m={m} />)}
      <div className="footnote">{integrations.APPLIES_NOTE}</div>
    </>
  );
}

function Machine({ c, m }: { c: IntegrationsController; m: config.Machine }) {
  if (m.machine in c.failed) return <Group title="GitHub" note={c.failed[m.machine]} />;
  const status = c.status[m.machine];
  if (!status) return <Group title="GitHub"><div className="dim">Asking…</div></Group>;
  const integration = integrations.githubIntegration(status);
  if (integration === null) {
    // An agent from before the controller: the pinned-binary rows, as they were.
    return (
      <Group title="GitHub" note={integrations.updateAgentLine(config.label(m.machine))}>
        <Advanced c={c} m={m} status={status} />
      </Group>
    );
  }
  return (
    <Group title="GitHub" note={integrations.GITHUB_BLURB}>
      <ConnectBlock c={c} m={m} integration={integration} />
      <details className="advanced">
        <summary>Advanced</summary>
        <Advanced c={c} m={m} status={status} />
      </details>
    </Group>
  );
}

/** The GitHub row and what it offers now, from the agent's `state`. */
function ConnectBlock({ c, m, integration }: { c: IntegrationsController; m: config.Machine; integration: Dict }) {
  const action = integrations.integrationAction(integration);
  const busy = c.connecting.has(m.machine);
  const methods: string[] = integration.methods || [];
  const on = c.switched[m.machine] ?? !!integration.enabled;
  const signIn: Dict | null = integration.signIn ?? null;
  const pasting = c.pasting.has(m.machine) && methods.includes("token");
  return (
    <>
      <Board>
        <BoardRow time={null} title="GitHub" word={integrations.stateWord(integration)} tone={integrations.stateTone(integration)}
          machine={m.machine} detail={integration.why || null} keepActions
          actions={action === "manage" ? <Switch checked={on} title="Offer GitHub to the Lead and Foremen" onChange={(v) => c.toggle(m, v)} /> : undefined} />
      </Board>

      {(action === "connect" || action === "choose-repos" || action === "manage") && (
        <div className="row wrap">
          {action === "connect" && methods.includes("device") && (
            <Button kind="primary" disabled={busy} title="Show a code to type on GitHub; this computer gets the token from GitHub"
              onClick={() => c.signIn(m)}>Sign in with GitHub</Button>
          )}
          {action === "connect" && methods.includes("token") && !c.pasting.has(m.machine) && (
            <Button kind="flat" disabled={busy} onClick={() => c.showPaste(m)}>
              {methods.includes("device") ? "Use a token instead" : "Paste a token"}
            </Button>
          )}
          {action === "choose-repos" && integration.manageUrl && (
            <>
              <Button kind="primary" disabled={busy} onClick={() => openUri(integration.manageUrl)}>Choose repositories</Button>
              <Button kind="flat" disabled={busy} onClick={() => c.disconnect(m)}>Disconnect</Button>
            </>
          )}
          {action === "manage" && (
            <>
              {integration.manageUrl && <Button kind="flat" disabled={busy} onClick={() => openUri(integration.manageUrl)}>Choose repositories</Button>}
              <Button kind="danger" disabled={busy} onClick={() => c.disconnect(m)}>Disconnect</Button>
            </>
          )}
        </div>
      )}

      {integration.state === "signing-in" && signIn ? (
        <>
          <div className="dim">Type this code on GitHub to let {config.label(m.machine)} read GitHub:</div>
          <div className="device-code selectable">{signIn.userCode ?? ""}</div>
          <div className="row">
            <Button kind="primary" onClick={() => openCode(signIn.userCode ?? "", signIn.verificationUri ?? "https://github.com/login/device", c.app.toast)}>
              Copy code and open GitHub
            </Button>
            <Button kind="flat" onClick={() => c.disconnect(m)}>Cancel</Button>
          </div>
          <div className="row"><Spinner /><span className="dim">Waiting for you to approve it on GitHub…</span></div>
        </>
      ) : integration.state === "installing" ? (
        <div className="row"><Spinner /><span className="dim">Installing GitHub's MCP server…</span></div>
      ) : null}
      {action === "manage" && <div className="dim">{integrations.REVOKE_LINE}</div>}

      {pasting && <TokenPaste c={c} m={m} busy={busy} tokenUrl={integration.tokenUrl ?? null} />}
    </>
  );
}

function TokenPaste({ c, m, busy, tokenUrl }: { c: IntegrationsController; m: config.Machine; busy: boolean; tokenUrl: string | null }) {
  const [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <>
      <div className="row">
        <input ref={field} className="entry grow" type="password" placeholder="github_pat_…" value={text} autoComplete="off"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && c.saveToken(m, text)} />
        <Button kind="primary" disabled={busy} onClick={() => c.saveToken(m, text)}>Save token</Button>
        <Button kind="flat" onClick={() => c.hidePaste(m)}>Cancel</Button>
      </div>
      <div className="dim">{integrations.TOKEN_HELP}</div>
      {tokenUrl && <div className="row"><Button kind="flat" onClick={() => openUri(tokenUrl)}>Create a token on GitHub</Button></div>}
    </>
  );
}

/** The token's state and the pinned binary with Verify. */
function Advanced({ c, m, status }: { c: IntegrationsController; m: config.Machine; status: Dict }) {
  const entry: Dict = integrations.githubEntry(status) || { name: "github", enabled: false };
  const state = integrations.githubState(status);
  const notReady = state.hint ? "" : integrations.whyNotReady(status);
  const on = c.switched[m.machine] ?? !!entry.enabled;
  return (
    <div className="col" style={{ gap: 6 }}>
      <Board>
        <BoardRow time="TOKEN" title={integrations.tokenLine(status)} word="" tone="dim" machine={m.machine} />
        <BoardRow time="MCP" title="github" word={state.word} tone={state.tone} machine={m.machine} detail={state.detail || null} keepActions
          actions={
            <>
              {state.verify && (
                <Button kind="flat" small disabled={c.verifying.has(m.machine)} title="Check the binary and ask for your Allow on that computer"
                  onClick={() => c.verify(m)}>{state.verify}</Button>
              )}
              <Switch checked={on} title="Offer GitHub to the Lead and Foremen" onChange={(v) => c.toggle(m, v)} />
            </>
          } />
      </Board>
      {status.refused && <div className="dim">Its registry file was refused: {String(status.refused)}</div>}
      {state.hint ? (
        <div className="row"><span className="dim">Install:</span><span className="mono selectable">{state.hint}</span></div>
      ) : notReady ? (
        <div className="dim">Left out of a start now: {notReady}</div>
      ) : null}
      {c.asked.has(m.machine) && <div className="dim">{integrations.askedText(config.label(m.machine))}</div>}
    </div>
  );
}

