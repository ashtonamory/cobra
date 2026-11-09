// Trust's routes and flows (the rules are actionTrust.ts).
//
// For the person's phone and desk (their own keys, never a Lead's):
//   GET  /trust?project=         TrustList: the grants, the keys that always ask, the receipts (newest first)
//   POST /trust/revoke {key}     200 {removed}: the grant goes; those actions are cards again
//   POST /trust/clear {key}      200 {removed}: a key that always asked may earn trust again
//
// The flows the agent runs around an action (index.ts and orch.ts):
//   trustedRun      at action_propose: the grant it runs on, or null when it asks
//   afterAnswer     after the person answered an action card: counts it, and proposes trust at CLEAN_RUNS
//   settleTrustCard after the person answered a trust card: grant, or always ask
//
// The project's Foreman hears of a grant, a "keep asking" and a revoke as a
// [cobra] line (finishes.ts tell).
import type { ApprovalAction, ApprovalTrusted } from "@cobra/contracts";

import { actionText, goesToDrive } from "./actions.ts";
import { makeApproval, type StoredApproval } from "./approvals.ts";
import {
  actionKey,
  clearAsk,
  DRIVE_CONSENT,
  DRIVE_SAVES_PER_DAY,
  mayRunTrusted,
  noteOutcome,
  revokeNews,
  revokeTrust,
  settleTrust,
  trustApproval,
  trustFileStore,
  trustList,
  trustedRuns,
  useGrant,
  type TrustStore,
} from "./actionTrust.ts";
import { loadRenders, type RenderEntry } from "./renders.ts";
import { needsOfState, type Needs } from "./onCall.ts";

export type Reply = { status: number; body: unknown };

export const PERSON_TRUST_ROUTES: ReadonlySet<string> = new Set(["/trust", "/trust/revoke", "/trust/clear"]);
export const PERSON_TRUST_POSTS: ReadonlySet<string> = new Set(["/trust/revoke", "/trust/clear"]);
const PERSON_KINDS: ReadonlySet<string> = new Set(["phone", "desk"]);

export type TrustDeps = TrustStore & {
  approvals: { load: () => StoredApproval[]; save: (list: StoredApproval[]) => void };
  /** The render ledger (renders.ts), read when a key is worked out. */
  renders: () => Record<string, RenderEntry>;
  /** Pushes a new approval to the person's phones (index.ts notifyApproval). */
  notify: (approval: StoredApproval) => Promise<void>;
  /** finishes.ts tell: one [cobra] line for a project's Foreman. */
  tell: (owner: string, text: string, needs?: Needs) => void;
  now: () => number;
  log: (line: string) => void;
};

const bad = (status: number, error: string): Reply => ({ status, body: { error } });

function parse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function handleTrustPerson(route: string, method: string | undefined, url: URL, bodyText: string, caller: { kind: string }, deps: TrustDeps): Promise<Reply> {
  if (!PERSON_KINDS.has(caller.kind)) return bad(403, "only the desk app you linked uses /trust");
  const post = PERSON_TRUST_POSTS.has(route);
  if (post && method !== "POST") return bad(405, "POST only");
  if (!post && method !== "GET") return bad(405, "GET only");
  if (route === "/trust") {
    const project = (url.searchParams.get("project") ?? "").trim();
    return { status: 200, body: trustList(deps.load(), deps.approvals.load(), deps.now(), project || undefined) };
  }
  const input = parse(bodyText);
  if (!input) return bad(400, "invalid JSON body");
  const key = typeof input.key === "string" ? input.key.trim() : "";
  if (!key) return bad(400, "key is required");
  if (route === "/trust/revoke") {
    const { state, removed } = revokeTrust(deps.load(), key);
    if (!removed) return bad(404, "nothing is trusted under that key on this computer");
    deps.save(state);
    deps.log(`trust ${key.slice(0, 12)} (${removed.project}) revoked from the ${caller.kind}`);
    deps.tell(removed.project, revokeNews(removed));
    return { status: 200, body: { removed } };
  }
  const { state, removed } = clearAsk(deps.load(), key);
  if (!removed) return bad(404, "no key that always asks under that key on this computer");
  deps.save(state);
  deps.log(`trust ${key.slice(0, 12)} (${removed.project}) may be earned again (from the ${caller.kind})`);
  return { status: 200, body: { removed } };
}

/**
 * At action_propose: whether this action runs on trust now. When it does, the
 * grant's run is counted and the approval is made already allowed, carrying
 * `trusted`; the caller carries it out as an Allow would.
 */
export function trustedRun(deps: TrustDeps, action: ApprovalAction): ApprovalTrusted | null {
  const now = deps.now();
  // The person's own Drive: agreed to at Connect (actionTrust.ts DRIVE_CONSENT), no grant needed.
  if (action.channel === "file" && action.files && goesToDrive(action.files) && trustedRuns(deps.approvals.load(), DRIVE_CONSENT, now) < DRIVE_SAVES_PER_DAY) {
    return { key: DRIVE_CONSENT, grantedAt: new Date(now).toISOString() };
  }
  const keyed = actionKey(action, deps.renders());
  const state = deps.load();
  const grant = mayRunTrusted(state, keyed, deps.approvals.load(), now);
  if (!grant) return null;
  deps.save(useGrant(state, grant.key, now));
  return { key: grant.key, grantedAt: grant.grantedAt };
}

/** At action_propose, when it runs on trust: the approval, made already allowed and carrying `trusted`, for the caller to save and carry out. Null when it asks. */
export function trustedApproval(deps: TrustDeps, action: ApprovalAction, requestedBy: string): StoredApproval | null {
  const trusted = trustedRun(deps, action);
  return trusted ? makeApproval({ kind: "action", ...actionText(action), requestedBy, action, trusted }, deps.now()) : null;
}

/**
 * After the person answered an action card and it was carried out (done,
 * failed) or denied: counts it toward trust, and at CLEAN_RUNS proposes trust
 * as one card of kind `trust`, pushed like any approval. Returns that card,
 * or null. A trusted run counts nothing: it is already trusted.
 */
export async function afterAnswer(deps: TrustDeps, approval: StoredApproval): Promise<StoredApproval | null> {
  if (approval.kind !== "action" || !approval.action || approval.trusted) return null;
  const keyed = actionKey(approval.action, deps.renders());
  const list = deps.approvals.load();
  const { state, propose } = noteOutcome(deps.load(), keyed, approval, list, deps.now());
  deps.save(state);
  if (!propose || !keyed.trustable) return null;
  const card = makeApproval(trustApproval(keyed.subject, propose), deps.now());
  deps.approvals.save([...list, card]);
  deps.log(`approval ${card.id}: ${card.title} (trust after ${propose.clean} clean runs)`);
  await deps.notify(card).catch((caught: unknown) => deps.log(`trust push: ${caught instanceof Error ? caught.message : String(caught)}`));
  return card;
}

/** After the person answered a trust card: writes the grant or the "always ask", and tells the Foreman. Returns the approval as it now stands. */
export function settleTrustCard(deps: Pick<TrustDeps, "load" | "save" | "tell" | "log" | "now">, approval: StoredApproval): StoredApproval {
  if (approval.kind !== "trust" || !approval.trust) return approval;
  const settled = settleTrust(deps.load(), approval, deps.now());
  deps.save(settled.state);
  if (settled.news) deps.tell(approval.trust.project, settled.news, needsOfState(settled.approval.state));
  deps.log(`trust approval ${approval.id} ${settled.approval.state} for ${approval.trust.project}`);
  return settled.approval;
}

/** The live deps: trust.json and renders.json in the state folder, the approvals file and the agent's own push and lines. */
export function liveTrustDeps(input: {
  approvals: TrustDeps["approvals"];
  notify: TrustDeps["notify"];
  tell: TrustDeps["tell"];
  log: TrustDeps["log"];
}): TrustDeps {
  return { ...trustFileStore(), renders: () => loadRenders(), now: () => Date.now(), ...input };
}
