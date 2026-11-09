/**
 * Settings → ACCOUNTS: each computer's Claude and Codex accounts, which one it uses, and adding one
 * (the agent's accounts.ts; words in lib/accounts.ts), with the engine each role starts on above them
 * (lib/engines.ts).
 *
 * A Claude account is a `claude setup-token` token pasted here. A Codex account signs in with Codex's
 * own device code, shown here as GitHub's is under GITHUB: the computer gets the sign-in from OpenAI,
 * never through the desktop. Use switches; Remove forgets a saved account.
 */
import { APP_NAME } from "../../lib/appName.ts";
import { useEffect, useRef, useState } from "react";
import * as accounts from "../../lib/accounts.ts";
import * as api from "../../lib/api.ts";
import * as config from "../../lib/config.ts";
import * as engines from "../../lib/engines.ts";
import type { Dict, Json } from "../../lib/json.ts";
import { Button } from "../ui.tsx";
import { Controller, FlowRow, Group, Spinner, Toggles, openCode, statusOf, why } from "./common.tsx";

export class AccountsController extends Controller {
  views: Record<string, Dict> = {};      // machine → GET /accounts
  engines: Record<string, Dict> = {};    // machine → GET /settings/engines (absent on an older agent)
  failed: Record<string, string> = {};
  adding: Record<string, string> = {};   // machine → "claude" while its paste field shows
  logins: Record<string, Dict> = {};     // machine → a Codex sign-in under way
  busy = new Set<string>();
  generation = 0;
  pollTimer: ReturnType<typeof setInterval> | null = null;

  reload() {
    this.generation += 1;
    const gen = this.generation;
    this.views = {};
    this.failed = {};
    this.engines = {};
    this.draw();
    for (const m of config.MACHINES) {
      api.accounts(m.machine).then(
        (view) => {
          if (gen !== this.generation) return;
          this.views[m.machine] = view || {};
          this.draw();
        },
        (e) => {
          if (gen !== this.generation) return;
          this.failed[m.machine] = statusOf(e) === 404 ? `Update ${APP_NAME} on this computer to manage its accounts here.`
            : `Not answering: ${why(e)}`;
          this.draw();
        },
      );
      // An agent before engines.ts answers 404: the rows are simply left out.
      api.engines(m.machine).then(
        (view) => {
          if (gen === this.generation && view) {
            this.engines[m.machine] = view;
            this.draw();
          }
        },
        () => {},
      );
    }
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // -- acting ------------------------------------------------------------------

  async call(m: config.Machine, run: () => Promise<Json>, failed: string, then?: (reply: Json) => void) {
    if (this.busy.has(m.machine)) return;
    this.busy.add(m.machine);
    this.draw();
    try {
      const reply = await run();
      this.busy.delete(m.machine);
      if (reply && typeof reply === "object" && "accounts" in reply) this.views[m.machine] = reply;
      then?.(reply);
    } catch (e) {
      this.busy.delete(m.machine);
      this.app.toast(`${failed}: ${why(e)}`);
    }
    this.draw();
  }

  setEngine(m: config.Machine, role: string, title: string, engine: string) {
    void this.call(m, () => api.enginesSet(m.machine, role, engine), "Couldn't change the engine", (reply) => {
      if (reply) this.engines[m.machine] = reply;
      this.app.toast(engines.changedWords(title, engine, config.label(m.machine)));
    });
  }

  use(m: config.Machine, row: accounts.AccountRow) {
    void this.call(m, () => api.accountsUse(m.machine, row.provider, row.id), "Couldn't switch",
      () => this.app.toast(`${config.label(m.machine)}: ${accounts.switchNote(row.provider)}`));
  }

  showPaste(m: config.Machine) {
    this.adding[m.machine] = "claude";
    this.draw();
  }

  hidePaste(m: config.Machine) {
    delete this.adding[m.machine];
    this.draw();
  }

  addClaude(m: config.Machine, token: string, name: string) {
    if (!token.trim()) return;
    void this.call(m, () => api.accountsAddClaude(m.machine, token.trim(), name.trim()), "Couldn't keep the token", (reply) => {
      delete this.adding[m.machine];
      const account: Dict = (reply || {}).account || {};
      this.app.toast(`${config.label(m.machine)} keeps ${account.label ?? "the account"}. Use it to switch.`);
    });
  }

  startCodex(m: config.Machine) {
    void this.call(m, () => api.accountsCodexStart(m.machine), "Couldn't start the sign-in", (reply) => {
      const login: Dict = (reply || {}).login || {};
      if (login.id) {
        this.logins[m.machine] = login;
        this.poll();
      }
    });
  }

  endLogin(m: config.Machine) {
    // The computer's sign-in runs out by itself after 15 minutes; this only stops watching it.
    delete this.logins[m.machine];
    this.draw();
  }

  poll() {
    if (!this.pollTimer) this.pollTimer = setInterval(() => this.tick(), 3000);
  }

  tick() {
    if (!Object.keys(this.logins).length) {
      this.stop();
      return;
    }
    for (const [machine, login] of Object.entries(this.logins)) {
      const m = config.machine(machine);
      if (!m) {
        delete this.logins[machine];
        continue;
      }
      api.accountsCodexStatus(m.machine, login.id).then(
        (reply) => {
          const state = ((reply || {}).login || {}).state;
          if (state === "done") {
            delete this.logins[m.machine];
            this.app.toast(`${config.label(m.machine)} keeps the Codex account. Use it to switch.`);
            void this.call(m, () => api.accounts(m.machine), "Couldn't read the accounts");
          } else if (state === "failed") {
            delete this.logins[m.machine];
            this.app.toast(`Codex sign-in on ${config.label(m.machine)}: ${((reply || {}).login || {}).why ?? "it did not finish"}`);
            this.draw();
          }
        },
        () => {
          delete this.logins[m.machine];
          this.draw();
        },
      );
    }
  }
}

export function AccountsSection({ c, only }: { c: AccountsController; only: string | null }) {
  if (!config.MACHINES.length) return <div className="dim">Link a computer first: Settings → Computers.</div>;
  return <>{config.MACHINES.filter((m) => only === null || m.machine === only).map((m) => <Machine key={m.machine} c={c} m={m} />)}</>;
}

function Machine({ c, m }: { c: AccountsController; m: config.Machine }) {
  if (m.machine in c.failed) return <Group title="Accounts" note={c.failed[m.machine]} />;
  const view = c.views[m.machine];
  if (!view) return <Group title="Accounts"><div className="dim">Asking…</div></Group>;
  const busy = c.busy.has(m.machine);
  const engineView = c.engines[m.machine];
  return (
    <>
      {/* The engines first: which one each role starts on is what this page is most often opened for. */}
      {engineView && <Engines c={c} m={m} view={engineView} busy={busy} />}
      {(["claude", "codex"] as const).map((provider) => (
        <Group key={provider} title={provider === "claude" ? "Claude accounts" : "Codex accounts"}
          note={provider === "claude" ? accounts.BLURB : undefined}>
          {accounts.rows(view, provider).map((row) => <AccountLine key={row.id ?? "own"} c={c} m={m} row={row} busy={busy} />)}
          <div className="row">
            {provider === "claude" && c.adding[m.machine] !== "claude" && (
              <Button kind="flat" disabled={busy} onClick={() => c.showPaste(m)}>Add a Claude account…</Button>
            )}
            {provider === "codex" && accounts.canSaveCodex(view) && (
              <Button kind="flat" disabled={busy} title="Save this computer's Codex sign-in as an account, so you can switch back to it"
                onClick={() => c.call(m, () => api.accountsCodexSave(m.machine), "Couldn't keep it")}>Keep this sign-in</Button>
            )}
            {provider === "codex" && !(m.machine in c.logins) && (
              <Button kind="flat" disabled={busy} onClick={() => c.startCodex(m)}>Add a Codex account…</Button>
            )}
          </div>
          {provider === "claude" && c.adding[m.machine] === "claude" && <Paste c={c} m={m} busy={busy} />}
          {provider === "codex" && m.machine in c.logins && <CodexLogin c={c} m={m} />}
        </Group>
      ))}
    </>
  );
}

/** Engines: one Claude | Codex toggle per role. Codex is offered only where it can start. */
function Engines({ c, m, view, busy }: { c: AccountsController; m: config.Machine; view: Dict; busy: boolean }) {
  return (
    <Group title="Engines" note={engines.BLURB} footnote={engines.codexLine(view)}>
      {engines.ROLES.map(([role, title, detail]) => {
        const current = engines.engineKey((view.engines || {})[role]);
        return (
          <FlowRow key={role}
            main={<div className="col" style={{ gap: 2 }}><span>{title}</span><span className="dim">{detail}</span></div>}
            trailing={
              <Toggles active={current} onPick={(engine) => c.setEngine(m, role, title, engine)}
                options={engines.OPTIONS.map(([key, name]) => {
                  const blocked = key === "codex" ? engines.codexBlocked(view, role) : null;
                  return { key, label: name, disabled: busy || !(blocked === null || key === current),
                    title: blocked ?? `${title} start on ${name} from their next conversation` };
                })} />
            } />
        );
      })}
      {/* What each model source needs here, so a role is never set to one that cannot start. */}
      {engines.sourceRows(view).map((row) => (
        <FlowRow key={row.name}
          lead={<span className="mono">{row.ready ? "●" : "○"}</span>}
          main={
            <div className="col" style={{ gap: 2, minWidth: 0 }}>
              <span>{row.name}</span>
              <span className="dim">{row.detail}</span>
              {row.fix && <span className="bdetail">{row.fix}</span>}
            </div>
          }
          trailing={<span className={`status ${row.ready ? "s-ink" : "s-dim"}`}>{row.ready ? "READY" : "NOT YET"}</span>} />
      ))}
    </Group>
  );
}

function AccountLine({ c, m, row, busy }: { c: AccountsController; m: config.Machine; row: accounts.AccountRow; busy: boolean }) {
  return (
    <FlowRow
      lead={<span className="mono">{row.active ? "●" : "○"}</span>}
      main={
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <span className="mono ellipsis">{row.title}</span>
          {row.detail && <span className="bdetail ellipsis">{row.detail}</span>}
        </div>
      }
      trailing={
        <div className="row" style={{ gap: 4 }}>
          {row.active && <span className="status s-ink">IN USE</span>}
          {row.canUse && <Button kind="flat" small disabled={busy} onClick={() => c.use(m, row)}>Use</Button>}
          {row.canRemove && (
            <Button kind="flat" small disabled={busy}
              onClick={() => c.call(m, () => api.accountsRemove(m.machine, row.id || ""), "Couldn't remove it")}>Remove</Button>
          )}
        </div>
      } />
  );
}

function Paste({ c, m, busy }: { c: AccountsController; m: config.Machine; busy: boolean }) {
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="dim">{accounts.CLAUDE_HELP}</div>
      <input ref={field} className="entry" type="password" placeholder="sk-ant-oat01-…" value={token} autoComplete="off"
        onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === "Enter" && c.addClaude(m, token, name)} />
      <div className="row">
        <input className="entry grow" placeholder="Name (optional): Work, Personal…" value={name} onChange={(e) => setName(e.target.value)} />
        <Button kind="primary" disabled={busy} onClick={() => c.addClaude(m, token, name)}>Keep</Button>
        <Button kind="flat" onClick={() => c.hidePaste(m)}>Cancel</Button>
      </div>
    </div>
  );
}

function CodexLogin({ c, m }: { c: AccountsController; m: config.Machine }) {
  const login = c.logins[m.machine];
  const code: string = login.code ?? "";
  const url: string = login.url ?? "https://auth.openai.com/codex/device";
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="dim">{accounts.CODEX_HELP}</div>
      <div className="device-code selectable">{code}</div>
      <div className="row">
        <Button kind="primary" onClick={() => openCode(code, url, c.app.toast)}>Copy code and open the page</Button>
        <Button kind="flat" onClick={() => c.endLogin(m)}>Cancel</Button>
      </div>
      <div className="row"><Spinner /><span className="dim">Waiting for you to sign in…</span></div>
    </div>
  );
}
