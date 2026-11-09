/**
 * The agents' HTTP API (the desk's api.py), named calls so the UI reads as
 * intent rather than URLs. Requests are made on the Rust side with this
 * desktop's key for that computer; errors carry the agent's own message: a
 * 409 from `POST /session` says why the screen was not what it expected, and
 * that sentence is what the toast shows.
 */
import { bridge } from "./bridge.ts";
import type { Dict, Json } from "./json.ts";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Machines are passed by name everywhere; the Rust side holds the rest. */
type M = string | { machine: string };
const name = (m: M) => (typeof m === "string" ? m : m.machine);

async function call(m: M, method: string, path: string, body?: Json, timeoutS = 4, owner = false): Promise<Json> {
  try {
    return await (owner ? bridge.apiOwner : bridge.api)(name(m), method, path, body, Math.round(timeoutS * 1000));
  } catch (e) {
    const err = e as { status?: number; message?: string } | string;
    if (typeof err === "string") throw new ApiError(0, err);
    throw new ApiError(err?.status ?? 0, err?.message ?? String(e));
  }
}

export const get = (m: M, path: string, timeout = 4) => call(m, "GET", path, undefined, timeout);
export const post = (m: M, path: string, body: Dict, timeout = 10) => call(m, "POST", path, body, timeout);
export const patch = (m: M, path: string, body: Dict, timeout = 10) => call(m, "PATCH", path, body, timeout);
export const q = (value: string) => encodeURIComponent(value);

// -- named calls -------------------------------------------------------------

export const sessionAction = (m: M, session: string, action: string, extra: Dict = {}) =>
  post(m, "/session", { session, action, ...extra }, 30);

/** An image for a session (`POST /session/attach`); the agent answers `{path, size}`. */
export async function attach(m: M, session: string, filePath: string): Promise<Json> {
  const base = filePath.split(/[\\/]/).pop() ?? "image";
  try {
    return await bridge.apiUpload(name(m), `/session/attach?session=${q(session)}&name=${q(base)}`, filePath);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    throw new ApiError(err?.status ?? 0, err?.message ?? String(e));
  }
}

export const gitAction = (m: M, project: string, action: string, extra: Dict = {}) =>
  post(m, "/git", { project, action, ...extra }, 60);

export const transcript = (m: M, session: string, after: number | null) =>
  get(m, `/transcript?session=${q(session)}` + (after !== null && after !== undefined ? `&after=${after}` : ""), 6);

/** Cobra's thread (`GET /thread`, the hub only: 404 anywhere else and on an agent without it). */
export const thread = (m: M, query: { before?: number; after?: number; limit?: number } = {}) => {
  const parts = Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`);
  return get(m, "/thread" + (parts.length ? `?${parts.join("&")}` : ""), 8);
};

export const dispatch = (m: M, project: string, prompt: string) => post(m, "/dispatch", { project, prompt }, 60);

/**
 * One more Claude in a project, in its own worktree on a new branch from
 * origin/main. A 429 is the soft cap: ask, then call again with overCap.
 */
export function newSession(
  m: M,
  project: string,
  opts: { prompt?: string; branch?: string; overCap?: boolean; localModel?: string; harness?: string | null; engine?: string } = {},
) {
  const body: Dict = { project };
  if (opts.prompt) body.prompt = opts.prompt;
  if (opts.branch) body.branch = opts.branch;
  if (opts.overCap) body.overCap = true;
  if (opts.localModel) {
    body.localModel = opts.localModel;
    if (opts.harness) body.harness = opts.harness;
  } else if (opts.engine === "codex") body.engine = "codex";
  return post(m, "/session/new", body, 120);
}

export const capabilities = (m: M) => get(m, "/capabilities", 20);
export const localRepos = (m: M) => get(m, "/repos/local", 20);
export const githubRepos = (m: M, root = "") => get(m, "/repos/github" + (root ? `?root=${q(root)}` : ""), 30);
export const createProject = (m: M, body: Dict) => post(m, "/project/create", body, 300);
export const repo = (m: M, project: string) => get(m, `/git/repo?project=${q(project)}`, 25);
export const tidy = (m: M) => get(m, "/git/tidy", 25);
export const templates = (m: M) => get(m, "/templates", 10);
export const dispatchTemplate = (m: M, project: string, template: string) =>
  post(m, "/dispatch", { project, template }, 60);
export const removeProject = (m: M, project: string) => post(m, "/project/remove", { id: project }, 15);
export const startLead = (m: M) => post(m, "/lead/start", {}, 20);
export const clearLead = (m: M) => post(m, "/lead/clear", {}, 20);
export const discardWorker = (m: M, worker: string) => post(m, "/orch/worker/discard", { id: worker }, 30);
export const foremanAction = (m: M, project: string, action: string) => post(m, `/foreman/${action}`, { project }, 20);
export const mcp = (m: M) => get(m, "/mcp", 15);
export const mcpToggle = (m: M, n: string, enabled: boolean) => post(m, "/mcp/toggle", { name: n, enabled }, 15);
export const mcpVerify = (m: M, n: string) => post(m, "/mcp/verify", { name: n }, 90);
export const mcpConnect = (m: M, integration: string, method: string, token?: string | null) =>
  post(m, "/mcp/connect", { id: integration, method, ...(token !== undefined && token !== null ? { token } : {}) }, 30);
export const mcpDisconnect = (m: M, integration: string) => post(m, "/mcp/disconnect", { id: integration }, 15);
export const policy = (m: M) => get(m, "/policy", 10);
export const policyPreview = (m: M, p: Dict) => post(m, "/policy/preview", { policy: p }, 15);
export const policyWrite = (m: M, p: Dict, confirmed: boolean) => post(m, "/policy", { policy: p, confirmed }, 15);
export const apiLane = (m: M) => get(m, "/api-lane", 10);
export const policyRefused = (m: M) => get(m, "/policy/refused", 10);
/** The audit log, newest first (the agent's auditTrail.ts), a page at a time: `before` is the last id shown; `all` keeps the policy's tool decisions. */
export const auditLog = (m: M, opts: { before?: string; all?: boolean; limit?: number } = {}) =>
  get(m, `/audit/log?limit=${opts.limit ?? 50}${opts.before ? `&before=${q(opts.before)}` : ""}${opts.all ? "&all=1" : ""}`, 10);
export const morning = (m: M) => get(m, "/morning", 8);
export const local = (m: M) => get(m, "/local", 15);
export const localCheck = (m: M, model: string) => post(m, "/local/check", { model }, 15);
export const accounts = (m: M) => get(m, "/accounts");
export const accountsAddClaude = (m: M, token: string, lbl = "") => post(m, "/accounts/claude", { token, label: lbl }, 25);
export const accountsCodexStart = (m: M, lbl = "") => post(m, "/accounts/codex/start", { label: lbl }, 20);
export const accountsCodexStatus = (m: M, loginId: string) => get(m, `/accounts/codex/status?id=${q(loginId)}`);
export const accountsCodexSave = (m: M) => post(m, "/accounts/codex/save", {});
export const accountsUse = (m: M, provider: string, accountId: string | null) =>
  post(m, "/accounts/use", { provider, id: accountId });
export const accountsRemove = (m: M, accountId: string) => post(m, "/accounts/remove", { id: accountId });
export const engines = (m: M) => get(m, "/settings/engines");
/** Where a computer looks for projects (Settings → Projects): `{home, roots, added}`. */
export const folders = (m: M) => get(m, "/settings/folders");
export const folderAdd = (m: M, path: string) => post(m, "/settings/folders", { add: path });
export const folderRemove = (m: M, path: string) => post(m, "/settings/folders", { remove: path });
export const enginesSet = (m: M, role: string, engine: string) => post(m, "/settings/engines", { [role]: engine });
export const brain = (m: M) => get(m, "/brain", 10);
export const brainWrite = (m: M, file: Dict) => post(m, "/brain", { brain: file });
/** POST /approvals/answer with this desk's key (it has `act`); `models` are a plan's tasks whose model you changed, `accounts` the receipts whose "Paid from" you changed, `skip` the bills you unticked. */
export const answerApproval = (m: M, approval: string, allow: boolean, models?: Dict | null, accounts?: Record<string, number>, skip?: number[]) =>
  post(m, "/approvals/answer", { id: approval, allow, ...(models ? { models } : {}), ...(accounts ? { accounts } : {}), ...(skip?.length ? { skip } : {}) }, 20);
// The account's Google connection and a project's records (the agent's personRoutes.ts, contracts records.ts).
/** Whether this computer's agent can use the account's Google; it asks the cloud, so it may take a few seconds. */
export const googleIntegration = (m: M) => get(m, "/integrations/google", 20);
/** Keep the Google client the person made (the JSON Google gave them); answers whether one is saved, never its secret. */
export const googleClient = (m: M, json: string) => post(m, "/integrations/google/client", { json }, 10);
/** Google's sign-in page for this computer (`{url}`), with a read added when `read` is set; Google returns to the agent. */
export const googleConnect = (m: M, read: string | null = null) => post(m, "/integrations/google/connect", read ? { read } : {}, 10);
/** Sign out at Google and here; `forgetClient` removes the saved client too. */
export const googleDisconnect = (m: M, forgetClient = false) => post(m, "/integrations/google/disconnect", { forgetClient }, 30);
// The owner's Cloudflare connection (the agent's cloudflare.ts, contracts cloudflare.ts): one sign-in per computer, the token kept there.
export const cloudflareIntegration = (m: M) => get(m, "/integrations/cloudflare", 10);
/** Cloudflare's sign-in page for this computer (`{url}`); the other half of the sign-in stays on the computer. */
export const cloudflareStart = (m: M) => post(m, "/integrations/cloudflare/start", {}, 10);
/** The connection code the return page showed (`<state>.<code>`, or its whole address); the computer swaps it for the token. */
export const cloudflareFinish = (m: M, connectCode: string) => post(m, "/integrations/cloudflare/finish", { connectCode }, 30);
export const cloudflareAccount = (m: M, account: string) => post(m, "/integrations/cloudflare/account", { id: account }, 10);
export const cloudflareDisconnect = (m: M) => post(m, "/integrations/cloudflare/disconnect", {}, 30);
export const dbJournal = (m: M, project: string, limit = 30) => get(m, `/db/journal?project=${q(project)}&limit=${limit}`, 10);
export const dbMirror = (m: M, project: string) => get(m, `/db/mirror?project=${q(project)}`, 10);
/** Undo one journal entry as you (this desk's key has `act`); answers the entry after. */
export const dbUndo = (m: M, project: string, journal: number) => post(m, "/db/undo", { project, journal }, 20);

// A trade's dashboards (the agent's views.ts, personRoutes.ts; contracts views.ts and viewsRead.ts to read them).
/** The desk asks for its own views (`surface=desk`): a Money seat's Finance rail; others are as the phone's. */
export const views = (m: M, project: string) => get(m, `/views?project=${q(project)}&surface=desk`, 10);
/** All money (agent allMoney.ts): every Money seat on that computer, its month in `to` (else its household's currency). */
export const allMoney = (m: M, month: string, to?: string) => get(m, `/money/all?month=${q(month)}${to ? `&to=${q(to)}` : ""}`, 15);
/** A bank statement for a Money seat (agent statements.ts): the raw CSV or PDF in (`{file}` back), then read into Money by that name. */
export async function addStatement(m: M, project: string, filePath: string): Promise<Json> {
  const base = filePath.split(/[\\/]/).pop() ?? "statement";
  try {
    return await bridge.apiUpload(name(m), `/statements/add?project=${q(project)}&name=${q(base)}`, filePath);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    throw new ApiError(err?.status ?? 0, err?.message ?? String(e));
  }
}
/** Reads an added statement; a 409 means it needs `account_id`. Reading a PDF takes Haiku a while. */
export const readStatement = (m: M, project: string, body: { file: string; name: string; account_id?: number }) =>
  post(m, `/statements/read?project=${q(project)}`, { project, ...body }, 180);
/** `range` is a chart's range switch and `key` the bar or part a chart was tapped on (contracts views.ts `ClientParam`);
 * `filter` is a kanban's picks as JSON (contracts viewsRead.ts `filterParam`). */
export const view = (m: M, project: string, id: string, input: { id?: string; q?: string; range?: string; key?: string; month?: string; filter?: string } = {}) =>
  get(m, `/view?project=${q(project)}&view=${q(id)}${(["id", "q", "range", "key", "month", "filter"] as const).map((k) => (input[k] ? `&${k}=${q(input[k])}` : "")).join("")}`, 10);
/** `ownerOnly`: the mutation is the person's alone (`personOnly`), so it goes through the passcode check (passcode.rs `api_owner`). */
export const viewWrite = (m: M, project: string, mutation: string, args: Dict, ownerOnly = false) =>
  call(m, "POST", "/view/write", { project, mutation, args }, 20, ownerOnly);
export const viewReveal = (m: M, project: string, request: Dict) => post(m, "/view/reveal", { project, ...request }, 20);
// The Marketing board (agent marketing.ts, contracts marketing.ts).
export const marketing = (m: M, project: string, range: string) => get(m, `/marketing?project=${q(project)}&range=${q(range)}`, 15);
/** A template's latest allowed version drawn with sample values: `{subject, html, text, version}`. */
export const marketingPreview = (m: M, project: string, template: string) => get(m, `/marketing/preview?project=${q(project)}&template=${q(template)}`, 15);
/** Send me a test: that version to the Space's own sending address, never counted. */
export const marketingTest = (m: M, project: string, template: string) => post(m, "/marketing/test", { project, template }, 15);
/** A test or scratch template's folder moved to email/archive (kept on disk). */
export const marketingArchive = (m: M, project: string, template: string) => post(m, "/marketing/archive", { project, template }, 15);
// The boards Cobra made for the Space a project is seated in (agent spaceBoards.ts, contracts boards.ts).
export const boards = (m: M, project: string) => get(m, `/boards?project=${q(project)}`, 10);
export const boardView = (m: M, project: string, board: string, view: string, input: { range?: string; key?: string } = {}) =>
  get(m, `/board/view?project=${q(project)}&board=${q(board)}&view=${q(view)}${(["range", "key"] as const).map((k) => (input[k] ? `&${k}=${q(input[k])}` : "")).join("")}`, 10);
export const boardRemove = (m: M, project: string, board: string) => post(m, "/boards/remove", { project, board }, 20);
// Routines (the agent's routines.ts, contracts routines.ts): none of these grants anything, so the desk's key may.
export const routines = (m: M) => get(m, "/routines", 10);
export const routinePause = (m: M, routine: string, enabled: boolean) => post(m, "/routines/pause", { id: routine, enabled }, 20);
export const routineRemove = (m: M, routine: string) => post(m, "/routines/remove", { id: routine }, 20);
export const routineRun = (m: M, routine: string) => post(m, "/routines/run", { id: routine }, 20);
// Trust (the agent's actionTrust.ts, contracts trust.ts): Revoke and Clear grant nothing, so the desk's key may. Trust itself is
// granted only by answering its approval.
// My Organization (agent orgRoutes.ts): which company each Foreman works for, kept on the Lead's computer.
export const org = (m: M) => get(m, "/org", 8);
export const orgChange = (m: M, change: Dict, revision?: number) => post(m, "/org", { change, ...(revision !== undefined ? { revision } : {}) }, 15);
/** A Foreman's name or look (agent crew.ts): `{name: string | null}` or `{look: "next" | "reset"}`. */
export const crew = (m: M, project: string, change: Dict) => post(m, "/crew", { project, ...change }, 10);

export const trust = (m: M, project?: string) => get(m, project ? `/trust?project=${q(project)}` : "/trust", 10);
export const trustRevoke = (m: M, key: string) => post(m, "/trust/revoke", { key }, 20);
export const trustClear = (m: M, key: string) => post(m, "/trust/clear", { key }, 20);
// What Cobra did (the agent's decided.ts): Undo takes away what Instinct did, so it grants nothing and the desk's key may.
export const decided = (m: M) => get(m, "/decided?days=7", 10);
export const decidedUndo = (m: M, id: string) => post(m, "/decided/undo", { id }, 45);
/** Research runs this week with their reads (agent webRuns.ts); 404 from an agent before them. */
export const webRuns = (m: M) => get(m, "/web/runs?days=7", 10);
export const emailPreview = (m: M, approval: string, copy?: number) => get(m, `/email/preview?approval=${encodeURIComponent(approval)}${copy !== undefined ? `&copy=${copy}` : ""}`, 15);
/** An outreach batch's copy before Allow: tick or untick it, or change its words; the copy comes back drawn. */
export const editBatchCopy = (m: M, approval: string, copy: number, change: { send: boolean } | { subject: string; body: string }) => post(m, "/email/batch", { approval, copy, ...change }, 15);
/** Mailboxes (phase 7, agent mailboxRoutes.ts): iCloud and Zoho boxes, never their passwords, and the box each Space sends from. */
export const mailboxes = (m: M) => get(m, "/email/mailboxes", 15);
/** The computer logs in to both of the box's servers before it keeps it: slow. */
export const addMailbox = (m: M, form: { provider: string; address: string; user?: string; password: string; region?: string }) => post(m, "/email/mailboxes", form, 60);
export const removeMailbox = (m: M, id: string) => post(m, "/email/mailboxes/remove", { id }, 15);
export const setSpaceMailbox = (m: M, space: string, box: string) => post(m, "/email/mailboxes/space", { space, box }, 15);
/** The block editor (phase 6): a Space's templates and images, one template (or a starter), a live draw, and propose as a template card. */
export const emailTemplates = (m: M, project: string) => get(m, `/email/templates?project=${encodeURIComponent(project)}`, 15);
export const emailTemplate = (m: M, project: string, from: { slug: string } | { starter: string }) =>
  get(m, `/email/template?project=${encodeURIComponent(project)}&${"slug" in from ? `slug=${encodeURIComponent(from.slug)}` : `starter=${encodeURIComponent(from.starter)}`}`, 15);
export const drawEmailTemplate = (m: M, project: string, template: unknown) => post(m, "/email/template/draw", { project, template }, 15);
export const proposeEmailTemplate = (m: M, project: string, slug: string, template: unknown) => post(m, "/email/template/propose", { project, slug, template }, 15);

// Cobra's Notebook: each computer serves its own notes; lib/notebook.ts merges them.
export const notebookShelf = (m: M, month: string) => get(m, `/notebook/shelf?month=${q(month)}`, 8);
export const notebookDay = (m: M, day: string) => get(m, `/notebook/day?day=${q(day)}`, 8);
export const notebookVolume = (m: M, id: string) => get(m, `/notebook/volume?id=${q(id)}`, 8);
export const notebookBrains = (m: M) => get(m, "/notebook/brains", 8);
export const notebookSearch = (m: M, query: string) => get(m, `/notebook/search?q=${q(query)}`, 8);
export const notebookTick = (m: M, day: string, text: string, done: boolean) => post(m, "/notebook/tick", { day, text, done });
