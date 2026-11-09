import { allower, makeApproval, settle, type StoredApproval } from "./approvals.ts";
import { installDefinition, keepProposal, loadDefined, takeProposal } from "./definedTrades.ts";
import { FOREMAN_TEMPLATES } from "./trades.ts";
import { definitionHash, describeDefinition, parseDefinition, type InstalledTrade, type TradeDefinition } from "./tradeDefine.ts";

/**
 * trade_define's flows (tradeDefine.ts the rules, definedTrades.ts the
 * files): the Lead proposes a definition, which becomes one approval of kind
 * `trade` (a newer one for the same id replaces a card not yet answered);
 * Allow installs exactly the definition the card was made from, Deny writes
 * nothing, and the Lead hears which.
 */

export type TradeDeps = {
  approvals: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };
  notify: (approval: StoredApproval) => Promise<void>;
  tell: (owner: string, text: string) => void;
  log: (line: string) => void;
  installed: (id: string) => InstalledTrade | null;
  install: (definition: TradeDefinition, now: Date) => InstalledTrade;
  keep: (approvalId: string, definition: TradeDefinition) => void;
  take: (approvalId: string) => TradeDefinition | null;
  now: () => number;
};

export function liveTradeDeps(input: Pick<TradeDeps, "approvals" | "notify" | "tell" | "log">): TradeDeps {
  return {
    ...input,
    installed: (id) => loadDefined(id),
    install: (definition, now) => installDefinition(definition, now),
    keep: (id, definition) => keepProposal(id, definition),
    take: (id) => takeProposal(id),
    now: Date.now,
  };
}

export type ProposeOutcome = { status: number; body: Record<string, unknown> };

/** POST /orch/trade/define {definition}: the card, or why not. Who may call it is orch.ts's to check. */
export async function proposeTrade(deps: TradeDeps, requestedBy: string, raw: unknown): Promise<ProposeOutcome> {
  const id = (raw as { id?: unknown } | null)?.id;
  const installed = typeof id === "string" ? deps.installed(id) : null;
  const definition = parseDefinition(raw, FOREMAN_TEMPLATES.map((trade) => trade.id), installed?.definition);
  if (typeof definition === "string") return { status: 400, body: { error: definition } };
  if (installed && definitionHash(installed.definition) === definitionHash(definition)) {
    return { status: 200, body: { unchanged: true, trade: definition.id } };
  }
  const words = describeDefinition(definition, installed?.definition);
  const now = deps.now();
  const approval = makeApproval({ kind: "trade", title: words.title, body: words.body, requestedBy, trade: words.trade }, now);
  // The person allows exactly what they read: a card cut short would not be that.
  if (approval.body !== words.body) return { status: 400, body: { error: `the card would be over ${approval.body.length} characters; shorten the brief or the descriptions` } };
  // A newer definition of the same trade replaces a card not answered yet.
  const replaced = (a: StoredApproval) => a.kind === "trade" && a.state === "pending" && a.trade?.id === definition.id;
  const current = settle(deps.approvals.load(), now);
  for (const old of current.filter(replaced)) deps.take(old.id);
  const list = current.map((a) => (replaced(a) ? { ...a, state: "expired" } : a));
  deps.keep(approval.id, definition);
  deps.approvals.save([...list, approval]);
  deps.log(`trade ${definition.id} proposed (${approval.id}) by ${requestedBy}`);
  await deps.notify(approval);
  return { status: 202, body: { approval: approval.id, trade: words.trade } };
}

/**
 * After the person answered a trade card (index.ts handleApprovals): Allow
 * installs the kept definition if its hash is still the card's, Deny drops
 * it, and the Lead that asked hears which. Returns the approval as it stands.
 */
export function settleTradeApproval(deps: TradeDeps, approval: StoredApproval): StoredApproval {
  if (approval.kind !== "trade" || !approval.trade) return approval;
  const definition = deps.take(approval.id);
  const name = approval.trade.name;
  if (approval.state !== "allowed") {
    deps.tell("lead", `The person declined the ${name} trade (${approval.trade.id}); nothing was installed.`);
    deps.log(`trade ${approval.trade.id} declined (${approval.id})`);
    return approval;
  }
  const result = (ok: boolean, message: string): StoredApproval => ({ ...approval, results: [{ ok, message }] });
  if (!definition || definitionHash(definition) !== approval.trade.sha256) {
    deps.tell("lead", `${allower(approval)} allowed the ${name} trade, but its definition was not the one on the card, so nothing was installed: trade_define it again.`);
    deps.log(`trade ${approval.trade.id}: no matching definition for ${approval.id}`);
    return result(false, "The definition was not the one shown; nothing was installed.");
  }
  try {
    const installed = deps.install(definition, new Date(deps.now()));
    const needs = definition.needs.length ? ` It needs ${definition.needs.map((need) => need.service).join(", ")}, with no connection yet: suggest the person add an MCP connector for it, and its fallback stands meanwhile.` : "";
    deps.tell("lead", `${allower(approval)} allowed the ${name} trade: it is installed as ${definition.id} (revision ${installed.revision}). foreman_create with template ${definition.id} makes a project for it.${needs}`);
    deps.log(`trade ${definition.id} installed, revision ${installed.revision}, ${installed.migrations.length} migration(s)`);
    return result(true, `Installed ${name}.`);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    deps.tell("lead", `${allower(approval)} allowed the ${name} trade, but it could not be installed (${message}).`);
    deps.log(`trade ${definition.id} install failed: ${message}`);
    return result(false, `Not installed: ${message}`);
  }
}
