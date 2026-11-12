/**
 * The verbs every surface shares — a popup's Allow, the Ops page's Allow and
 * the chat's Allow are the same call — so they live once, here (the desk's
 * actions.py, the phone's projectActions.ts). Every call goes to the machine
 * the session lives on; each agent only ever acts on its own sessions.
 */
import { APP_NAME } from "./appName.ts";
import * as api from "./api.ts";
import * as config from "./config.ts";
import * as model from "./model.ts";
import type { Fleet } from "./fleet.ts";
import { isDict, type Dict, type Json } from "./json.ts";
import { allowOffer, allowWithScope, type ScopeChoice } from "./allowScope.ts";
import { accountPicks, accountsAnswer } from "./expenses.ts";
import { billSkips } from "./bills.ts";
import { skipAnswer } from "../../../../../packages/contracts/src/billsCard.ts";
import type { ApprovalBills, ApprovalExpenses } from "../../../../../packages/contracts/src/approvals.ts";

export interface ActionHost {
  fleet: Fleet;
  toast: (text: string) => void;
  openChat: (machine: string, session: string) => void;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Actions {
  constructor(private app: ActionHost) {}

  // -- sessions ------------------------------------------------------------
  async session(row: model.Row, action: string, ok = "", extra: Dict = {}): Promise<Json> {
    try {
      const reply = await api.sessionAction(row.machine, row.session, action, extra);
      if (ok) this.app.toast(ok);
      this.app.fleet.refresh();
      return reply;
    } catch (e) {
      this.app.toast(`${row.displayName}: ${msg(e)}`);
      return null;
    }
  }

  /** Allow the prompt this row shows, and only that one: the agent refuses with a 409 when another replaced it. */
  async allow(row: model.Row): Promise<void> {
    try {
      await api.sessionAction(row.machine, row.session, "approve", model.allowExtra(model.dialogKey(row.project)));
      this.app.toast(`Allowed · ${row.displayName}`);
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 409) this.app.toast(`${row.displayName} is asking something else now: ${e.message}`);
      else this.app.toast(`${row.displayName}: ${msg(e)}`);
    }
    this.app.fleet.refresh();
  }

  /** Allow it for one of its request's scopes (allowScope.ts): this task, this project or always. */
  async allowScoped(row: model.Row, choice: ScopeChoice): Promise<void> {
    try {
      const offer = allowOffer(isDict(row.project) ? row.project.request : null);
      this.app.toast(`${await allowWithScope(row.machine, row.session, model.dialogKey(row.project), offer, choice)} · ${row.displayName}`);
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 409) this.app.toast(`${row.displayName} is asking something else now: ${e.message}`);
      else this.app.toast(`${row.displayName}: ${msg(e)}`);
    }
    this.app.fleet.refresh();
  }

  deny = (row: model.Row) => this.session(row, "deny", `Denied · ${row.displayName}`);
  interrupt = (row: model.Row) => this.session(row, "interrupt", `Interrupted · ${row.displayName}`);
  dismiss = (row: model.Row) => this.session(row, "deny", `Dismissed · ${row.displayName}`);
  kill = (row: model.Row) => this.session(row, "kill", `Killed · ${row.displayName}`);
  newWindow = (row: model.Row) => this.session(row, "new-window", `New window · ${row.displayName}`, row.path ? { cwd: row.path } : {});
  resumeClaude = (row: model.Row) => this.session(row, "resume-claude", `Resumed · ${row.displayName}`);
  /** Says `text` into the session (the chat's composer). */
  say = (row: model.Row, text: string) => api.sessionAction(row.machine, row.session, "say", { text });

  async start(row: model.Row, thenChat = true): Promise<void> {
    try {
      await api.sessionAction(row.machine, row.session, "start");
      this.app.toast(`Started ${APP_NAME} · ${row.displayName}`);
      this.app.fleet.refresh();
      if (thenChat) this.app.openChat(row.machine, row.session);
    } catch (e) {
      this.app.toast(`${row.displayName}: ${msg(e)}`);
    }
  }

  async startWithPrompt(row: model.Row, prompt: string): Promise<void> {
    try {
      await api.dispatch(row.machine, row.id, prompt);
      this.app.toast(`Dispatched · ${row.displayName}`);
      this.app.fleet.refresh();
      this.app.openChat(row.machine, row.session);
    } catch (e) {
      this.app.toast(`${row.displayName}: ${msg(e)}`);
    }
  }

  /**
   * Another Claude beside the one in `row`, in a worktree of its own.
   * `onCap(message)` is asked when the project is at the soft cap (429).
   */
  async newSession(
    row: model.Row,
    opts: { prompt?: string; branch?: string; overCap?: boolean; localModel?: string; harness?: string | null; engine?: string } = {},
    onCap?: (message: string) => void,
  ): Promise<void> {
    try {
      const reply = await api.newSession(row.machine, row.id, opts);
      const started = reply?.project ?? {};
      const on = opts.localModel || (opts.engine === "codex" ? "Codex" : "");
      this.app.toast(`New session · ${started.name || row.name}${on ? ` · ${on}` : ""}`);
      this.app.fleet.refresh();
      if (started.session) this.app.openChat(row.machine, started.session);
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 429 && !opts.overCap && onCap) onCap(e.message);
      else this.app.toast(`${row.displayName}: ${msg(e)}`);
    }
  }

  /**
   * The Ollama models `row`'s computer can run a session on (title-tagged),
   * whether it starts them on Pi, and whether Codex is ready there; empty
   * when it cannot be asked, so the choice stays Claude.
   */
  async localModels(row: model.Row): Promise<{ choices: Array<[string, string]>; pi: boolean; codex: boolean }> {
    try {
      const caps = await api.capabilities(row.machine);
      return { choices: model.localModelChoices(caps) as Array<[string, string]>, pi: model.piReady(caps), codex: model.codexReady(caps) };
    } catch {
      return { choices: [], pi: false, codex: false };
    }
  }

  // -- templates -------------------------------------------------------------
  async templates(row: model.Row): Promise<Dict[]> {
    try {
      return (await api.templates(row.machine))?.templates ?? [];
    } catch (e) {
      this.app.toast(`Couldn't list templates: ${msg(e)}`);
      return [];
    }
  }

  /** Starts the project's session if there is none, or a new one beside it. */
  async runTemplate(row: model.Row, template: string, name = "", said = ""): Promise<void> {
    try {
      await api.dispatchTemplate(row.machine, row.id, template);
      this.app.toast(said || `${name || template} sent · ${row.displayName}`);
      this.app.fleet.refresh();
    } catch (e) {
      this.app.toast(`${row.displayName}: ${msg(e)}`);
    }
  }

  /** Claude's turn: assess branches with unique commits, or land a parked one. */
  askClaude(row: model.Row, template = "assess-branches"): Promise<void> {
    const said =
      template === "land-parked"
        ? `Asked ${APP_NAME} to land the parked branch · ${row.displayName}`
        : `Asked ${APP_NAME} to assess the branches · ${row.displayName}`;
    return this.runTemplate(row, template, "", said);
  }

  async forget(row: model.Row): Promise<boolean> {
    try {
      await api.removeProject(row.machine, row.id);
      this.app.toast(`Removed from the list · ${row.displayName} (the folder stays)`);
      this.app.fleet.refresh();
      return true;
    } catch (e) {
      this.app.toast(`${row.displayName}: ${msg(e)}`);
      return false;
    }
  }

  // -- git -----------------------------------------------------------------
  /** Mechanical git on the computer that holds the checkout. Resolves after it, success or not. */
  async git(machine: string, project: string, action: string, name = "", extra: Dict = {}): Promise<void> {
    const label = name || project;
    try {
      const reply = await api.gitAction(machine, project, action, extra);
      const did = reply?.did;
      if (did === "fetched") this.app.toast(`Already current · ${label}`);
      else if (did === "parked" && reply?.branch) this.app.toast(`Parked to ${reply.branch} · ${label}`);
      else if (action === "merge-pr") this.app.toast(`Merged #${extra.number} · ${label}`);
      else {
        const verb = ({ sync: "Synced", resume: "Resumed", "delete-branch": "Deleted", "close-pr": "Closed" } as Dict)[action] ?? action;
        const what = extra.branch || (extra.number ? `#${extra.number}` : "");
        this.app.toast(`${verb}${what ? " " + what : ""} · ${label}`);
      }
      this.app.fleet.refresh();
    } catch (e) {
      this.app.toast(`${label}: ${msg(e)}`);
    }
  }

  // -- the orchestrators -----------------------------------------------------
  /** Allow or Deny what the Lead asked; a merge then runs there, a plan starts its Workers on `models`, receipts go on the accounts picked on the card. */
  async answerApproval(machine: string, approval: Dict, allow: boolean, models?: Dict | null): Promise<boolean> {
    const title = String(approval.title || "Approval");
    const expenses = approval.expenses as ApprovalExpenses | undefined;
    const bills = approval.bills as ApprovalBills | undefined;
    try {
      await this.app.fleet.answerApproval(machine, String(approval.id), allow, models, allow && expenses ? accountsAnswer(expenses, accountPicks(String(approval.id))) : undefined, allow && bills ? skipAnswer(bills, billSkips(String(approval.id))) : undefined);
      this.app.toast(`${allow ? "Allowed" : "Denied"} · ${title}`);
      return true;
    } catch (e) {
      this.app.toast(`${title}: ${msg(e)}`);
      return false;
    }
  }

  /**
   * Says `text` to the Lead, starting it first when none runs (on this
   * computer, or the first one linked). A Lead just started takes a few
   * seconds to take input, so the message is tried every two seconds for forty.
   */
  async tellLead(text: string): Promise<boolean> {
    const lead = this.app.fleet.rows.find((r) => r.lead);
    const m = lead ? config.machine(lead.machine) : config.MACHINES.find((x) => x.local) ?? config.MACHINES[0];
    if (!m) {
      this.app.toast("Link a computer first: Settings → Computers");
      return false;
    }
    const session = lead ? lead.session : "cobra_lead";
    try {
      if (!lead) await api.startLead(m.machine);
      let last: unknown = null;
      for (let i = 0; i < 20; i++) {
        try {
          await api.sessionAction(m.machine, session, "say", { text });
          this.app.toast("Sent to the Lead");
          this.app.fleet.refresh();
          return true;
        } catch (e) {
          last = e;
          if (e instanceof api.ApiError && (e.status === 401 || e.status === 403)) throw e;
          await sleep(2000);
        }
      }
      throw last ?? new Error("the Lead did not answer");
    } catch (e) {
      this.app.toast(`Not sent to the Lead: ${msg(e)}`);
      return false;
    }
  }
}
