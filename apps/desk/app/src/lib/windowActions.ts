/**
 * What the picker and the popup do without the main window's Actions: the
 * same calls as lib/actions.ts, but their words go back to the main window as
 * toasts, and a refresh is asked of its poller.
 */
import * as api from "./api.ts";
import * as model from "./model.ts";
import { toMain } from "./surfaces.ts";
import { isDict, type Dict } from "./json.ts";
import { allowOffer, allowWithScope, type ScopeChoice } from "./allowScope.ts";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const toast = (text: string) => void toMain({ kind: "toast", text }).catch(() => {});
const refresh = () => void toMain({ kind: "refresh" }).catch(() => {});

/** Allow the prompt this row shows, and only that one: the agent refuses with a 409 when another replaced it. */
export async function allow(row: model.Row): Promise<void> {
  try {
    await api.sessionAction(row.machine, row.session, "approve", model.allowExtra(model.dialogKey(row.project)));
    toast(`Allowed · ${row.displayName}`);
  } catch (e) {
    if (e instanceof api.ApiError && e.status === 409) toast(`${row.displayName} is asking something else now: ${e.message}`);
    else toast(`${row.displayName}: ${msg(e)}`);
  }
  refresh();
}

/** Allow it for one of its request's scopes (allowScope.ts): this task, this project or always. */
export async function allowScoped(row: model.Row, choice: ScopeChoice): Promise<void> {
  try {
    const offer = allowOffer(isDict(row.project) ? row.project.request : null);
    toast(`${await allowWithScope(row.machine, row.session, model.dialogKey(row.project), offer, choice)} · ${row.displayName}`);
  } catch (e) {
    if (e instanceof api.ApiError && e.status === 409) toast(`${row.displayName} is asking something else now: ${e.message}`);
    else toast(`${row.displayName}: ${msg(e)}`);
  }
  refresh();
}

export async function deny(row: model.Row): Promise<void> {
  try {
    await api.sessionAction(row.machine, row.session, "deny");
    toast(`Denied · ${row.displayName}`);
  } catch (e) {
    toast(`${row.displayName}: ${msg(e)}`);
  }
  refresh();
}

/** What the Lead asked and only you may allow. */
export async function answerApproval(machine: string, approval: Dict, yes: boolean): Promise<void> {
  const title = String(approval.title || "Approval");
  try {
    await api.answerApproval(machine, String(approval.id), yes);
    toast(`${yes ? "Allowed" : "Denied"} · ${title}`);
  } catch (e) {
    toast(`${title}: ${msg(e)}`);
  }
  refresh();
}
