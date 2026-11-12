import type { Decided } from "./decided.ts";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type http from "node:http";
import os from "node:os";

import type { ApprovalAction, ApprovalPlan, OrchForeman, OrchProject, OrchStatus, OrchWorker, PlanTask, Project } from "@cobra/contracts";

import { liveDeps as liveDispatchDeps, READY_TIMEOUT_MS } from "./dispatch.ts";
import { loadExtras, onLocalModel } from "./extras.ts";
import { safeGit } from "./gitSafe.ts";
import { briefText, companyFolders, describeForeman, designerImages, foremanCompany, foremanSession, foremanSettled, startForeman, typeBrief } from "./foreman.ts";
import { designerFolders, handleDesignerOrch, ORCH_DESIGNER_ROUTES, type DesignerDeps, findTessel, tesselExport } from "./designer.ts";
import { handleEmailOrch, ORCH_EMAIL_POSTS, ORCH_EMAIL_ROUTES } from "./emailRoutes.ts";
import { boxOfProject, liveEmailRouteDeps, mailboxOfProject } from "./emailLive.ts";
import { resolveBoxBatch } from "./boxMail.ts";
import { MailboxError, type Mailbox } from "./mailboxes.ts";
import { attachmentsDir } from "./attachments.ts";
import { STATE_DIR } from "./paths.ts";
import { handleFormOrch, liveFormDeps, ORCH_FORM_ROUTES, type FormDeps } from "./formLinks.ts";
import { handleSiteOrch, liveBuild, liveCheck, liveLint, liveShoot, ORCH_SITE_POSTS, ORCH_SITE_ROUTES, settleSite, type SiteDeps, SiteError, siteFolders, WEBSITE_BUILDER } from "./site.ts";
import { liveOutsideGithub, readLink } from "./outsideSite.ts";
import { containedBuild, isCoded, liveCodedDeps, seedConcept, startCoded } from "./codedSite.ts";
import { liveSiteGithub } from "./siteSource.ts";
import { cloudflareHere } from "./cloudflare.ts";
import type { NewEntry } from "./thread.ts";
import { changeCrew, projectNamed } from "./crew.ts";
import { cleanCrewName } from "../../../../packages/contracts/src/crew.ts";
import { readHookRecords } from "./hooks.ts";
import { localModels } from "./localModels.ts";
import { offers, readChecks } from "./localCheck.ts";
import { logDecision, readPolicyLog } from "./policy.ts";
import { readHistory, timeline } from "./timeline.ts";
import { collectUsage } from "./collect/usage.ts";
import { drain, heldBy, loadQueue, makeItem, modelPressures, overflowModel, position, pressures, saveQueue, spends, type Pressure, type QueueItem } from "./queue.ts";
import type { Extra } from "./extras.ts";
import { audienceOf, finishes, tellLine } from "./finishes.ts";
import { liveJobDeps, runJob } from "./jobs.ts";
import { keepMerged } from "./prNews.ts";
import { landCandidates, landingFor, type LandWanted } from "./landing.ts";
import { actionFingerprint, actionText, MAILBOX_CHANNEL, mailboxToday, NO_MAILBOX, parseAction, parseMailboxAction } from "./actions.ts";
import { MAILBOX_DAILY, type MailboxBatch, type MailboxRequest } from "./mailOrganize.ts";
import { DEFAULT_FILES_CONFIG, loadFilesConfig } from "./files.ts";
import {
  landText,
  plainWhat,
  publishedText,
  loadApprovals,
  makeApproval,
  runMerge,
  mergeCandidates,
  publicView,
  saveApprovals,
  settle,
  stampTaint,
  type StoredApproval,
} from "./approvals.ts";
import { ensureFolder, readFolders, writeFolders } from "./folders.ts";
import { loadRegistry } from "./registry.ts";
import { createProject, liveCreateDeps } from "./create.ts";
import { allTrades, defaultProjectName, knownTrade, tradeOrganizes, unknownTemplateError } from "./trades.ts";
import { createRemote, findGh, ghAuth } from "./github.ts";
import { runSessionAction, SessionError } from "./sessions.ts";
import {
  denyForWorker,
  describeWorker,
  discardWorker,
  liveDiscardDeps,
  findWorker,
  finishWorker,
  liveCounts,
  liveFinishDeps,
  liveMergeDeps,
  liveWorkerDeps,
  readPhase,
  type WorkerPhase,
  writePhase,
  runningSessions,
  localSlotsFull,
  requireRunning,
  sendToWorker,
  sessionTranscript,
  settled,
  spawnWorker,
  stopWorker,
  markStopped,
  workerRecords,
  orchWorkerRecords,
  workerTranscript,
  handoffWorker,
  wakeWorker,
  liveHandoffDeps,
  headlessAction,
  parseModel,
} from "./workers.ts";
import { directControlRefusal, directSpawnRefusal, LEAD_WORKER_ROUTES, liveDirect, startedByLead } from "./directWorkers.ts";
import { liveProjectModeDeps, projectForemen, type ProjectMode, type ProjectModeDeps } from "./spaceForemen.ts";
import { handoffRefusal, onCall, wordCount, writeHandoffNote } from "./onCall.ts";
import { checkCheckout } from "./checks.ts";
import { isCheckRunning, liveCheckoutDeps, liveWorkerScope, startWorkerCheck, type WorkerCheckDeps } from "./workerChecks.ts";
import { liveEaRun, liveMemorySync } from "./ea.ts";
import { computerName, MEMORY_DIR, memoryDay, projectKeyFor, sourceOf, withMemoryLock } from "./memory.ts";
import { DEFAULT_FALLBACKS, HARD_CAPS, loadPolicy, loadRoles, modelAllowed } from "./permissions.ts";
import { askMemory, readScoped, readSlice, rememberLesson, type SliceKind } from "./memoryAccess.ts";
import { orgForMemory, readIndexes } from "./memoryIndex.ts";
import { memoryHome, rememberForCompany, rulesLine } from "./companyBrain.ts";
import { monthSpendHere } from "./modelGateway.ts";
import { activeCodexCredential } from "./accounts.ts";
import { containAvailable, containEnabled, containMode } from "./contain.ts";
import { engineFor } from "./sessionHarness.ts";
import { answerAsk, answerWords, askPerson, findAsk, parseAsk } from "./asks.ts";
import { answerFor, answeredWords, parseAnswerInput, questionText } from "./foremanAnswer.ts";
import { requestRefusal, workerQuestion } from "./requestAnswer.ts";
import { liveBudget } from "./sessionBudget.ts";
import { clearRested, isRested } from "./sessionKeeper.ts";
import { catalog, isKind } from "./brain/catalog.ts";
import { route as routeTask, runnable, type RouteFacts } from "./brain/route.ts";
import { readBrain, type RuleProject } from "./brain/rules.ts";
import { codexModelsHere } from "./brain/codexModels.ts";
import { labelsFor, type Labels } from "./brain/labels.ts";
import { parsePlan, planText, reviewerFor, routedPlan } from "./plans.ts";
import { importSources } from "./workerImportSources.ts";
import { ImportError, importText, liveImportDeps, planImport } from "./workerImport.ts";
import { LOCAL_REVIEWER, parseVerdict, readReview, reviewForced, reviewGate, reviewNews, reviewQuestion, whenSlotFree, writeReview } from "./review.ts";
import { LEAD_SESSION } from "./lead.ts";
import { liveSpaceOf, waking, withWake } from "./wakes.ts";
import { DB_POSTS, DB_ROUTES, handleDb, liveDbDeps } from "./dbRoutes.ts";
import { handleRead, liveReadDeps, READ_BODY_LIMIT, READ_ROUTES, type ReadDeps } from "./readRoutes.ts";
import { liveTradeDeps, proposeTrade, type TradeDeps } from "./tradeRoutes.ts";
import { createTitle, liveSpecialistDeps, proposeSpecialist, type SpecialistDeps } from "./specialistRoutes.ts";
import { attachedRepos, setSpecialist } from "./specialists.ts";
import { detach as detachSpecialist, liveAttachDeps, proposeAttach, type AttachDeps } from "./specialistAttach.ts";
import { testModeOn, withTestLane } from "./apiTest.ts";
import { factsHere } from "./morning.ts";
import { handleOrgOrch, liveOrgDeps, loadOrg, ORCH_ORG_POSTS, ORCH_ORG_ROUTES, saveOrg, type OrgDeps } from "./orgRoutes.ts";
import { checkHire, hireBrief, proposeSpace, type SpaceDeps } from "./spaceCreate.ts";
import { boardSchema, liveBoardDeps, proposeBoard, readBoards, type BoardDeps } from "./spaceBoards.ts";
import { CONTACT_LOOKUP_ROUTE, handleContactLookup, liveContactDeps, type ContactDeps } from "./contactLookup.ts";
import { readSpace, registerSeat, seatOf, spaceDir, SPACES_DIR } from "./spaces.ts";
import { proposeBudgetCard, type BudgetCardDeps } from "./budgetCard.ts";
import { proposeBillsCard } from "./billsCard.ts";
import type { ProjectDb } from "./dbTypes.ts";
import { seatTrade } from "./trades/space.ts";
import { liveSpaceDeps } from "./spaceLive.ts";
import { applyOrg, companyNote, parseOrg, seatKey, type OrgCompany } from "../../../../packages/contracts/src/org.ts";
import { handleRoutineOrch, liveRoutineDeps, ORCH_ROUTINE_POSTS, ORCH_ROUTINE_ROUTES, type RoutineDeps } from "./routineRoutes.ts";
import { loadRoutines, type StoredRoutine } from "./routines.ts";
import { loadTrust, type TrustState } from "./actionTrust.ts";
import { isTainted, noteRead, reportTaint, taintedOwner, taintWorker, type Taint, type TaintSource } from "./taint.ts";
import { trustedApproval, type TrustDeps } from "./trustRoutes.ts";
import { workerToolNames } from "./workerSpace.ts";
import { redactDeep } from "./secretValues.ts";

/**
 * /orch/*: what an orchestrator (the Lead, a Foreman) may do on this computer.
 * The Lead reaches these through its MCP server with a Lead key (keys.ts
 * mintLead), which opens these routes and no others; the desk
 * reaches them with its own read and act.
 *
 *   GET  /orch/status                 projects, Workers, caps, local models
 *   POST /orch/worker/spawn           {project, task, model?, branch?, owner?}
 *   GET  /orch/worker?id=&after=      one Worker, and its transcript since a byte offset
 *   GET  /orch/worker/wait?ids=&timeoutSeconds=&since=
 *                                     returns when one of them finishes anew (idle after a turn,
 *                                     needs you, stopped, failed; finishes.ts): one the caller has
 *                                     not been told of, or newer than `since` (a previous cursor)
 *   POST /orch/worker/send            {id, text}   a follow-up for an idle Worker
 *   POST /orch/worker/deny            {id}         deny the prompt on its screen
 *   POST /orch/worker/stop            {id}         end its session; the worktree stays
 *   POST /orch/worker/finish          {id, title?, body?}  push its branch and open the PR, or in a
 *                                                  project with no remote ready it to land (landing.ts)
 *   POST /orch/worker/discard         {id}         remove a stopped Worker's worktree and branch
 *                                                  (yours, from Tidy: a Lead key is refused)
 *   POST /orch/job                    {project, question, model?}  a read-only answer, no worktree (jobs.ts)
 *   POST /orch/merge/request          {workers}    ask you to merge their PRs, or land their branches
 *                                                  into local main: one push, Allow/Deny
 *   GET  /orch/approval?id=           what became of an approval
 *   GET  /orch/history?days=          the charts' history: today's lanes, daily counts (timeline.ts)
 *   GET  /orch/policy?limit=          the policy's audit log, newest first
 *   POST /orch/foreman/brief          {project, text}  start the project's Foreman if none runs, then
 *                                                  type the brief into its empty input box (foreman.ts)
 *   GET  /orch/foreman?project=&after=  one Foreman, and its transcript since a byte offset
 *   GET  /orch/foreman/wait?projects=&timeoutSeconds=&since=
 *                                     as worker/wait, for Foremen
 *   GET  /orch/db/schema, POST /orch/db/query|write|undo|import, GET /orch/db/journal|mirror
 *                                     a Foreman's hands on its project's database (dbRoutes.ts):
 *                                     its own project only, 409 for a trade that keeps none
 *   POST /orch/mail/search|read
 *                                     a Foreman's reads of the person's calendar and mail (readRoutes.ts):
 *                                     its own project only, 403 for a trade that does not read that source,
 *                                     409 with the step when the person has not turned the read on
 *   GET  /orch/routines, POST /orch/routine/set|remove
 *                                     routines (routineRoutes.ts): the Lead's for any project here, a
 *                                     Foreman's for its own; set is an approval the person allows
 *   GET  /orch/org, POST /orch/org/set|propose
 *                                     My Organization (orgRoutes.ts): the Lead on this computer only;
 *                                     set does what the person said, propose is an approval
 *   POST /orch/contacts/lookup {space, query}
 *                                     Cobra's read-only duplicate check of a Space's People
 *                                     (contactLookup.ts): the Lead on this computer only
 *
 * The chain is person > Lead > Foreman > Workers:
 * the Lead's own key (kind lead, no project) is refused the Worker controls
 * and merge requests, and a Foreman's key is refused the Foreman routes.
 */

type Send = (response: http.ServerResponse, status: number, body: unknown) => void;
type ReadBody = (request: http.IncomingMessage, limit?: number) => Promise<string>;

export const ORCH_ROUTES: ReadonlySet<string> = new Set([
  "/orch/worker/handoff",
  "/orch/plan",
  "/orch/ask",
  "/orch/ask/wait",
  "/orch/brain/route",
  "/orch/status",
  "/orch/worker",
  "/orch/worker/spawn",
  "/orch/worker/wait",
  "/orch/worker/send",
  "/orch/worker/deny",
  "/orch/worker/stop",
  "/orch/worker/finish",
  "/orch/worker/check",
  "/orch/worker/import",
  "/orch/worker/discard",
  "/orch/merge/request",
  "/orch/action/propose",
  "/orch/job",
  "/orch/approval",
  "/orch/history",
  "/orch/policy",
  "/orch/foreman",
  "/orch/foreman/brief",
  "/orch/foreman/wait",
  "/orch/foreman/create",
  "/orch/foreman/answer",
  "/orch/request",
  "/orch/request/answer",
  "/orch/space/create",
  "/orch/board/schema",
  "/orch/board/propose",
  CONTACT_LOOKUP_ROUTE,
  ...ORCH_FORM_ROUTES,
  "/orch/trade/define",
  "/orch/specialist/set",
  "/orch/specialist/attach",
  "/orch/specialist/detach",
  "/orch/morning",
  "/orch/memory/file",
  "/orch/memory/slice",
  "/orch/memory/ask",
  "/orch/memory/remember",
  "/orch/notify",
  "/orch/web/run",
  "/orch/api-lane",
  ...DB_ROUTES,
  ...READ_ROUTES,
  ...ORCH_ROUTINE_ROUTES,
  ...ORCH_ORG_ROUTES,
  ...ORCH_DESIGNER_ROUTES,
  ...ORCH_SITE_ROUTES,
  ...ORCH_EMAIL_ROUTES,
]);

const POSTS = new Set([
  ...DB_POSTS,
  ...ORCH_EMAIL_POSTS,
  ...ORCH_DESIGNER_ROUTES,
  ...ORCH_SITE_POSTS,
  ...READ_ROUTES,
  ...ORCH_ROUTINE_POSTS,
  ...ORCH_ORG_POSTS,
  "/orch/worker/spawn",
  "/orch/worker/send",
  "/orch/worker/deny",
  "/orch/worker/stop",
  "/orch/worker/finish",
  "/orch/worker/check",
  "/orch/worker/import",
  "/orch/worker/discard",
  "/orch/merge/request",
  "/orch/action/propose",
  "/orch/job",
  "/orch/foreman/brief",
  "/orch/foreman/create",
  "/orch/foreman/answer",
  "/orch/request/answer",
  "/orch/space/create",
  "/orch/board/propose",
  CONTACT_LOOKUP_ROUTE,
  ...ORCH_FORM_ROUTES,
  "/orch/trade/define",
  "/orch/specialist/set",
  "/orch/specialist/attach",
  "/orch/specialist/detach",
  "/orch/memory/ask",
  "/orch/memory/remember",
  "/orch/notify",
  "/orch/web/run",
  "/orch/ask",
  "/orch/brain/route",
  "/orch/plan",
  "/orch/worker/handoff",
]);

/** A Worker's check, told to its owner through the finish tracker's notices. */
function liveWorkerCheckDeps(log: (line: string) => void): WorkerCheckDeps {
  const checkout = liveCheckoutDeps(log);
  return {
    check: (path, scope, name) => checkCheckout(checkout, path, { scope, name }),
    readPhase,
    writePhase,
    tell: tellLine,
    log,
    now: () => Date.now(),
  };
}

/** What the Lead briefs a Foreman to do instead (orch.ts refuses its key these). */
export const FOREMAN_ONLY: ReadonlySet<string> = new Set([
  "/orch/worker/spawn",
  "/orch/worker/handoff",
  "/orch/worker/send",
  "/orch/worker/deny",
  "/orch/worker/stop",
  "/orch/worker/finish",
  "/orch/worker/import",
  "/orch/merge/request",
  "/orch/action/propose",
  // The database is a project's, and the Lead never reads or changes one: it briefs the Foreman.
  ...DB_ROUTES,
  // So are the person's calendar and mail: a Foreman whose trade reads them reads them; the Lead never does.
  ...READ_ROUTES,
]);

/** The routes a Worker's Space tools call (spaceTools.ts WORKER_SPACE_TOOLS, through orchMcp.ts): mail_organize is an action card. */
const WORKER_SPACE_ROUTES: ReadonlySet<string> = new Set([...DB_ROUTES, ...READ_ROUTES, ...ORCH_EMAIL_ROUTES, ...ORCH_SITE_ROUTES, ...ORCH_DESIGNER_ROUTES, "/orch/action/propose"]);

/** The first of these sessions with a taint in force (a merge's caller, then each of its Workers), or undefined. */
/**
 * Why the Lead may not make or change a specialist now. What she read from
 * outside may have planted the request, and a specialist's job and
 * instructions outlive the conversation, so this waits for a clean one.
 */
export const ROSTER_TAINTED =
  "You read text from outside in this conversation (an email, a web page or a connected app's answer), so making or changing a specialist waits: tell the person plainly that you cannot do it in this conversation, and that they can start a new conversation with you and ask again, or do it themselves in the desk app.";

export function firstTaint(taintOf: (who: string) => Taint | null, sessions: readonly string[]): { session: string; taint: Taint } | undefined {
  for (const session of sessions) {
    const taint = taintOf(session);
    if (taint) return { session, taint };
  }
  return undefined;
}

/** Reads whose answer is outside text: each taints its caller's turn (taint.ts). */
const TAINTING_READS: Readonly<Record<string, TaintSource>> = Object.fromEntries([...READ_ROUTES].map((route) => [route, "email"]));

const FOREMAN_ROUTES: ReadonlySet<string> = new Set(["/orch/foreman", "/orch/foreman/brief", "/orch/foreman/wait", "/orch/foreman/create", "/orch/foreman/answer", "/orch/request", "/orch/request/answer"]);

/** Longest a wait is held open; the Lead calls again for longer. */
export const MAX_WAIT_SECONDS = 300;
const WAIT_POLL_MS = 2000;

/** A comma-separated query parameter as a set of ids. */
function listParam(url: URL, name: string): Set<string> {
  return new Set((url.searchParams.get(name) ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

/** A wait's timeoutSeconds (held to 1..MAX_WAIT_SECONDS) and its optional since cursor. */
function waitTiming(url: URL): { seconds: number; since: number | undefined } | { error: string } {
  const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, Number(url.searchParams.get("timeoutSeconds") ?? 120) || 120));
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw === null ? undefined : Number(sinceRaw);
  if (since !== undefined && !Number.isFinite(since)) return { error: "since is a time in milliseconds, from a previous wait's cursor" };
  return { seconds, since };
}

type Reply = { status: number; body: unknown };

/**
 * Asks `step` every few seconds until it has a reply. Its `last` is true once
 * the wait is over or the caller hung up, and it must reply then.
 */
async function holdOpen(request: http.IncomingMessage, seconds: number, step: (last: boolean) => Promise<Reply | null>): Promise<Reply> {
  const deadline = Date.now() + seconds * 1000;
  let closed = false;
  request.on("close", () => {
    closed = true;
  });
  for (;;) {
    const reply = await step(Date.now() >= deadline || closed);
    if (reply) return reply;
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
}

async function registered(configPath: string): Promise<Project[]> {
  const { projects } = await loadRegistry(configPath);
  return projects.filter((project) => project.machine === os.hostname());
}

async function describeAll(projects: Project[], only?: ReadonlySet<string>): Promise<OrchWorker[]> {
  const running = await runningSessions();
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const records = (await orchWorkerRecords()).filter((extra) => !only || only.has(extra.id));
  return Promise.all(records.map((extra) => describeWorker(extra, names.get(extra.parent) ?? extra.parent, running)));
}

/** A body field as a list of short strings (file paths), anything else as none. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.slice(0, 300)).slice(0, 50) : [];
}

/** Each subscription's pressure now (queue.ts), from the usage the phone shows. */
export async function livePressures(): Promise<Pressure[]> {
  try {
    return pressures((await collectUsage()).agents);
  } catch {
    // No usage to read: nothing is held.
    return [];
  }
}

/** A project as the router names it: its id, its owner/repo where it has one (its record's key), and the name the apps show (rules may use it). */
async function routedProject(project: Project): Promise<RuleProject> {
  const key = await projectKeyFor(project).catch(() => undefined);
  return { id: project.id, ...(key ? { key } : {}), name: project.name };
}

/** What the router knows of a project here (brain/route.ts): the models the accounts offer, the policy, the usage windows and your rules. */
export async function routeFactsFor(project: Project): Promise<RouteFacts> {
  const [budget, key] = await Promise.all([routerBudget(), projectKeyFor(project).catch(() => undefined)]);
  const roles = loadRoles({ computer: computerName(), project: key });
  const { brain } = readBrain();
  // API test mode (apiTest.ts): Claude models only, on the key, so the subscription's windows do not hold them.
  const test = testModeOn();
  return {
    candidates: catalog({ codexModels: !test && codexStatus().codex?.workers === true ? codexModelsHere() : null }),
    allowed: roles.foreman.workerModels,
    modelAllowed,
    // In test mode Claude Workers run on the key: the API lane's spend against its cap is their pressure, not the subscription's.
    budget: test ? budget.flatMap((pressure) => (pressure.id === "claude" ? [] : pressure.id === "api" ? [{ ...pressure, id: "claude" }] : [pressure])) : budget,
    rules: brain.rules,
  };
}

/** The windows the router weighs: each account's fullest, and each model's own (Fable Weekly). */
export async function routerBudget(): Promise<Pressure[]> {
  try {
    const { agents } = await collectUsage();
    return [...pressures(agents), ...modelPressures(agents)];
  } catch {
    // No usage to read: nothing is held.
    return [];
  }
}

/** What a Foreman tool says when nothing here goes by that id or name. */
function notHere(asked: string): string {
  return `no project or Foreman "${asked}" on this computer: give the project's id or its Foreman's name, as the status tool lists them`;
}

/** A project's roster lines for status (wave 7): trade, whether it reports to the Lead, routines, trust. */
export function rosterOf(
  project: Pick<Project, "id" | "foremanTemplate">,
  roster: { routines: readonly StoredRoutine[]; trust: TrustState; briefed: (id: string) => boolean },
): Pick<OrchProject, "trade" | "briefed" | "routines" | "trusted"> {
  const on = roster.routines.filter((routine) => routine.project === project.id && routine.enabled);
  const next = on.map((routine) => routine.nextRun).filter((at): at is string => at !== null).sort()[0];
  const trusted = roster.trust.grants.filter((grant) => grant.project === project.id).map((grant) => `${grant.what}${grant.to.length ? ` to ${grant.to.join(", ")}` : ""}`);
  return {
    ...(project.foremanTemplate ? { trade: project.foremanTemplate } : {}),
    ...(roster.briefed(project.id) ? { briefed: true } : {}),
    ...(on.length ? { routines: { on: on.length, ...(next ? { next } : {}) } } : {}),
    ...(trusted.length ? { trusted } : {}),
  };
}

export async function orchStatus(configPath: string): Promise<OrchStatus> {
  const projects = await registered(configPath);
  const [workers, running, extras, models, budget] = await Promise.all([
    describeAll(projects),
    runningSessions(),
    loadExtras(),
    localModels(),
    livePressures(),
  ]);
  const records = readHookRecords();
  const roster = { routines: loadRoutines(), trust: loadTrust(), briefed: (id: string) => finishes.isBriefed(id) };
  // The caps spawnWorker applies: the computer's, and each project's own.
  const computer = computerName();
  const here = loadRoles({ computer });
  const perProject = (roles: typeof here) => Math.min(roles.foreman.maxWorkers, HARD_CAPS.workersPerProject);
  // The owner's Worker chain, for status's budget advice; none when the policy lists none.
  const workerChain = loadPolicy({ computer }).fallbacks.worker;
  const workerFallbacks = workerChain.join(" ") === DEFAULT_FALLBACKS.worker.join(" ") ? undefined : [...workerChain];
  return {
    machine: os.hostname(),
    // The computer's memory may hold fewer than your cap (sessionBudget.ts).
    caps: { computer: Math.min(here.foreman.maxWorkersPerComputer, HARD_CAPS.workersPerComputer, liveBudget().workers), project: perProject(here) },
    live: liveCounts(extras, running).total,
    projects: await Promise.all(
      projects.map(async (project) => {
        const [landing, foreman, key] = await Promise.all([
          landingFor(project.path).catch(() => null),
          describeForeman(project, running, records),
          projectKeyFor(project).catch(() => undefined),
        ]);
        const maxWorkers = perProject(loadRoles({ computer, project: key }));
        return { id: project.id, name: project.name, path: project.path, ...(landing === "local" ? { landing } : {}), foreman, maxWorkers, ...rosterOf(project, roster) };
      }),
    ),
    workers,
    // Not one that failed Cobra's check (localCheck.ts).
    localModels: offers(models, readChecks()).map((model) => model.name),
    trades: allTrades().map(({ id, name, source }) => ({ id, name, source })),
    ...codexStatus(),
    budget,
    ...(workerFallbacks ? { workerFallbacks } : {}),
    queue: loadQueue().map(({ requestedBy: _drop, branch: _branch, at: _at, ...item }) => item),
  };
}

/** Where a codex Worker can run, and what a Worker with no model named gets (engines.ts). */
function codexStatus(): Pick<OrchStatus, "codex" | "workerDefault"> {
  const contained = containEnabled() && containAvailable();
  const signedIn = activeCodexCredential() !== null;
  const why = !contained ? "Workers here do not run in Cobra's sandbox, which Codex needs" : !signedIn ? "no Codex sign-in is active here" : undefined;
  const workers = contained && signedIn;
  return { codex: { workers, ...(why ? { why } : {}) }, workerDefault: engineFor("worker") === "codex" && workers ? "codex" : "claude" };
}

/**
 * What a Foreman's key sees of the status: its project, its Workers, its
 * queue; also the projects it works in besides its own (a Website Builder's
 * linked site, outsideSite.ts; the repositories it is attached to,
 * specialistAttach.ts), with the Workers it started there and no one else's.
 */
export function scopeStatus(status: OrchStatus, only: string | undefined, linked: string | null | ReadonlySet<string> = null): OrchStatus {
  if (only === undefined) return status;
  const also: ReadonlySet<string> = linked === null ? new Set() : typeof linked === "string" ? new Set([linked]) : linked;
  const mine = (project: string) => project === only || also.has(project);
  return {
    ...status,
    projects: status.projects.filter((project) => mine(project.id)),
    workers: status.workers.filter((worker) => worker.parent === only || (also.has(worker.parent) && worker.owner === only)),
    ...(status.queue ? { queue: status.queue.filter((item) => item.project === only || (also.has(item.project) && item.owner === only)) } : {}),
  };
}

/**
 * Starts a Worker now, or puts it in the queue: when the budget holds its
 * model, or (unless `queue` is false) when a cap is full. The queue starts it
 * later (drainQueue).
 */
async function startOrQueue(
  parent: Project,
  projects: Project[],
  input: { task: string; model?: string; branch?: string; owner?: string; labels?: Labels; research?: string; spaceTools?: true; startedBy?: "lead"; queue: boolean },
  caller: { id: string },
  log: (line: string) => void,
): Promise<{ started: Extra } | { queued: QueueItem; position: number }> {
  // Its task was written by an orchestrator that had read the web: the Worker starts tainted, now or when it leaves the queue (taint.ts).
  // Cobra's own Worker was asked for by her, whichever project owns it (directWorkers.ts).
  const taintedBy = taintedOwner(input.startedBy ?? input.owner ?? "lead");
  const enqueue = (waitingFor: string) => {
    const item = makeItem(
      {
        project: parent.id,
        task: input.task,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.branch !== undefined ? { branch: input.branch } : {}),
        ...(input.labels ? { labels: input.labels } : {}),
        ...(input.research ? { research: input.research } : {}),
        ...(input.spaceTools ? { spaceTools: true as const } : {}),
        ...(input.startedBy ? { startedBy: input.startedBy } : {}),
        ...(taintedBy ? { taintedBy } : {}),
        owner: input.owner ?? "lead",
        requestedBy: caller.id,
      },
      waitingFor,
      Date.now(),
    );
    const items = [...loadQueue(), item];
    saveQueue(items);
    log(`queue: ${item.id} for ${parent.id} waits (${waitingFor})`);
    return { queued: item, position: position(items, item.id) };
  };
  // Nothing jumps the line: while anything waits for this project, a new spawn waits behind it.
  // A plan's task waiting for another to land is not in the line.
  const ahead = loadQueue().some((item) => item.state === "waiting" && item.project === parent.id && !item.after?.length);
  if (ahead && input.queue) return enqueue("cap: earlier tasks for this project are waiting");
  // API test mode (apiTest.ts): the same Claude model on the key, which waits for the key alone.
  const test = testModeOn();
  const lane = withTestLane(input.model, test);
  if (lane.note) log(`worker for ${parent.id}: ${lane.note}`);
  // On the key a Worker runs headless, which the key's credits take; any other Claude Worker is interactive.
  const current = await livePressures();
  const held = heldBy(lane.model, current, Date.now(), { interactive: spends(lane.model) !== "api", test });
  // At the subscription's HOLD a Claude Worker goes on the key instead, headless, when the lane can take it (queue.ts overflowModel).
  const overflow = held && !test ? overflowModel(lane.model, current, Date.now()) : null;
  const waitForBudget = () => enqueue(`budget: ${held?.label} at ${Math.round((held?.percent ?? 1) * 100)}%, resets ${held?.resetsAt || "later"}`);
  if (held && !overflow) return waitForBudget();
  const model = overflow ?? lane.model;
  try {
    const started = await spawnWorker({ ...liveWorkerDeps(log), seed: codedSeed }, parent, projects, {
      task: input.task,
      ...(model !== undefined ? { model } : {}),
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.research ? { research: input.research } : {}),
      ...(input.spaceTools ? { spaceTools: true as const } : {}),
      ...(input.startedBy ? { startedBy: input.startedBy } : {}),
    });
    if (overflow) log(`worker ${started.extra.id} goes on the API key as ${overflow} (the subscription is at HOLD)`);
    if (taintedBy) taintWorker(started.extra.id, taintedBy);
    return { started: started.extra };
  } catch (caught) {
    // The overflow refused (the project's models, no sandbox for a headless Worker): it waits for the reset, as before.
    if (overflow && caught instanceof SessionError && (caught.status === 403 || caught.status === 409)) return waitForBudget();
    if (caught instanceof SessionError && caught.status === 429 && input.queue) return enqueue(`cap: ${caught.message}`);
    throw caught;
  }
}

/**
 * A coded Website Builder's new Worker starts with the picked concept in its
 * worktree (`.cobra-attachments/concept/`): its sandbox reads only the worktree,
 * and the concept lives in the Space's website folder.
 */
async function codedSeed(parent: Project, worktree: string): Promise<string | null> {
  if (parent.foremanTemplate !== WEBSITE_BUILDER || !isCoded(parent.path)) return null;
  const org = orgForMemory();
  const company = org?.seats[seatKey(os.hostname(), parent.id)]?.company;
  const space = company ? spaceDir(company) : undefined;
  const folders = siteFolders(parent, STATE_DIR, space && parent.path.startsWith(`${space}/`) ? space : undefined);
  return seedConcept(join(folders.website, "design", "concept"), await attachmentsDir(worktree));
}

/** The queue's tick: starts what can start (queue.ts drain). */
export async function drainQueue(configPath: string, log: (line: string) => void): Promise<number> {
  return drain({
    load: () => loadQueue(),
    save: (items) => saveQueue(items),
    pressures: livePressures,
    async start(item) {
      const projects = await registered(configPath);
      const parent = projects.find((project) => project.id === item.project);
      if (!parent) throw new SessionError(`project ${item.project} is gone`, 404);
      const started = await spawnWorker({ ...liveWorkerDeps(log), seed: codedSeed }, parent, projects, {
        task: item.task,
        ...(item.model !== undefined ? { model: item.model } : {}),
        ...(item.branch !== undefined ? { branch: item.branch } : {}),
        ...(item.labels ? { labels: item.labels } : {}),
        ...(item.research ? { research: item.research } : {}),
        ...(item.spaceTools ? { spaceTools: true as const } : {}),
        ...(item.startedBy ? { startedBy: item.startedBy } : {}),
        owner: item.owner,
      });
      if (item.taintedBy) taintWorker(started.extra.id, item.taintedBy);
      timeline.recordCount("worker-started", started.extra.id, parent.id);
      return started.extra.id;
    },
    prerequisite: livePrerequisite,
    log,
    now: () => Date.now(),
    test: testModeOn,
  });
}

/** The model to review a Worker's change: the plan's, else the best usable model on another engine than its own. */
async function reviewerOf(extra: Extra, parent: Project): Promise<string | null> {
  const labels = extra.worker?.brain;
  if (labels?.reviewer) return labels.reviewer;
  const local = onLocalModel(extra);
  if (!labels || !extra.worker) return local ? LOCAL_REVIEWER : null;
  // With the project's key and name, so its own record and rules count (it once routed with the id alone).
  const routed = routeTask({ text: extra.worker.task, kind: labels.kind, size: labels.size, project: await routedProject(parent) }, await routeFactsFor(parent));
  return reviewerFor(extra.worker.model, runnable(routed)) ?? (local ? LOCAL_REVIEWER : null);
}

/**
 * Whether worker_finish waits for a review (review.ts reviewGate): null when
 * the head it would push is approved, or no other engine can review here;
 * otherwise what to answer, after starting the review when the head is new.
 */
async function reviewFirst(extra: Extra, configPath: string, log: (line: string) => void): Promise<{ status: number; error: string; by: string } | null> {
  const parent = (await registered(configPath)).find((project) => project.id === extra.parent);
  if (!parent || !extra.worker) return null;
  const reviewer = await reviewerOf(extra, parent);
  if (!reviewer) {
    log(`worker ${extra.id}: no other engine can review it here; finishing without a review`);
    return null;
  }
  const sha = (await safeGit(extra.path, ["rev-parse", "HEAD"])).stdout.trim();
  if (!sha) throw new SessionError("could not read the Worker's head commit", 500);
  const gate = reviewGate(await readReview(extra.id), sha, reviewer);
  if (gate.go) return null;
  if (gate.start) startReview(extra, { ...parent, path: extra.path }, sha, reviewer, log);
  return { status: gate.status, error: gate.error, by: reviewer };
}

/** Runs the review job in the background and tells the Worker's owner the verdict. */
function startReview(extra: Extra, project: Project, sha: string, by: string, log: (line: string) => void): void {
  const at = () => new Date().toISOString();
  writeReview(extra.id, { sha, by, state: "running", at: at() });
  log(`review: ${extra.id} at ${sha.slice(0, 7)} by ${by}`);
  void whenSlotFree(() => runJob(liveJobDeps(), project, { question: reviewQuestion(extra.worker?.task ?? "", extra.branch), model: by }))
    .then(({ answer }) => {
      const verdict = parseVerdict(answer);
      writeReview(extra.id, { sha, by, state: verdict.state, ...(verdict.notes ? { notes: verdict.notes } : {}), at: at() });
    })
    .catch((caught: unknown) => writeReview(extra.id, { sha, by, state: "error", notes: (caught instanceof Error ? caught.message : String(caught)).slice(0, 300), at: at() }))
    .finally(async () => {
      const done = await readReview(extra.id);
      if (!done) return;
      log(`review: ${extra.id} ${done.state} by ${by}`);
      // Changes asked, or a review that could not run, are the Foreman's to act on (onCall.ts).
      finishes.tell(extra.worker?.owner ?? "lead", reviewNews(extra.id, done), "event", done.state === "approve" ? "info" : "decision");
    });
}

export type PrerequisiteDeps = {
  phase: (id: string) => Promise<WorkerPhase | null>;
  /** Whether the Worker's session still runs, or it rests and worker_send wakes it. */
  alive: (id: string) => Promise<boolean>;
  now: () => number;
  /** Worker id → when its session was first seen absent, cleared once it is seen alive. */
  misses: Map<string, number>;
};

/** How long a "running" Worker's session must stay absent, over two looks, before it counts as gone. */
export const GONE_AFTER_MS = 15_000;

const livePrerequisiteDeps: PrerequisiteDeps = {
  phase: (id) => readPhase(id),
  async alive(id) {
    // A Worker the keeper rested once its work was done wakes on worker_send (sessionKeeper.ts): not gone.
    if (isRested(id)) return true;
    const extra = (await workerRecords()).find((candidate) => candidate.id === id);
    return !!extra && (await runningSessions()).has(extra.session);
  },
  now: Date.now,
  // In memory only: a restart starts the count again, which only delays a failure.
  misses: new Map(),
};

/** Whether a plan task's prerequisite landed: a queue item through the Worker it became, a Worker by its PR. */
export async function livePrerequisite(ref: string, items: readonly QueueItem[], deps: PrerequisiteDeps = livePrerequisiteDeps): Promise<"landed" | "pending" | "failed"> {
  const item = items.find((candidate) => candidate.id === ref);
  if (item) {
    if (item.state === "failed") return "failed";
    if (item.state !== "started" || !item.worker) return "pending";
    return livePrerequisite(item.worker, [], deps);
  }
  const phase = await deps.phase(ref);
  // A "running" phase with nothing that may still land is looked at: one written before stopping
  // said so stays "running". Gone only when absent on two looks 15 s apart, so one tmux hiccup
  // cannot fail a plan task for good.
  let alive = true;
  if (phase?.phase === "running" && !phase.pr && !phase.local) {
    if (await deps.alive(ref)) {
      deps.misses.delete(ref);
    } else {
      const first = deps.misses.get(ref);
      if (first === undefined) deps.misses.set(ref, deps.now());
      else alive = deps.now() - first < GONE_AFTER_MS;
    }
  }
  return phaseLanded(phase, alive);
}

/**
 * A Worker's phase as a prerequisite: landed once its PR merged or, in a
 * project with no remote, once its branch landed in local main (landing.ts;
 * a real run's merge task on 4 Nov failed for want of this).
 */
export function phaseLanded(phase: Pick<WorkerPhase, "phase" | "prOutcome" | "local" | "pr"> | null, alive = true): "landed" | "pending" | "failed" {
  // Gone before anyone saw it land: a discarded Worker, or one pruned long after; either way nothing to wait for.
  if (!phase) return "failed";
  if (phase.prOutcome?.state === "MERGED" || phase.local?.landed) return "landed";
  if (phase.prOutcome?.state === "CLOSED" || phase.phase === "failed") return "failed";
  // Ended without finishing: stopped, or still "running" with its session gone (stopped before
  // stopping wrote its phase). Only its PR still open, or a local land still readied, may land.
  if (phase.phase === "stopped" || (phase.phase === "running" && !alive)) return phase.pr || phase.local ? "pending" : "failed";
  return "pending";
}

/**
 * Starts an allowed plan's Workers (plans.ts): each on its chosen model, with
 * its label and review; one with `after` waits in the queue for those to
 * land. Returns the plan with what each task became.
 */
export async function startPlan(configPath: string, plan: ApprovalPlan, requestedBy: string, log: (line: string) => void): Promise<ApprovalPlan> {
  const projects = await registered(configPath);
  const parent = projects.find((project) => project.id === plan.project);
  const refs = new Map<string, string>();
  const tasks: PlanTask[] = [];
  for (const task of plan.tasks) {
    if (!parent) {
      tasks.push({ ...task, error: `project ${plan.project} is gone` });
      continue;
    }
    // The plan decided review: force it where it was shown, skip it where it was not.
    const labels = labelsFor({ task: task.task, kind: task.kind, size: task.size, review: task.review ? "force" : "skip", ...(task.reviewer ? { reviewer: task.reviewer } : {}), ...(task.pick ? { routed: task.pick } : {}), ...(task.doer ? { role: "planner", doer: task.doer } : {}) });
    const after = (task.after ?? []).map((id) => refs.get(id)).filter((ref): ref is string => !!ref);
    try {
      if (after.length) {
        const item = makeItem({ project: parent.id, task: task.task, model: task.model, labels, ...(task.research ? { research: task.research } : {}), ...(taintedOwner(plan.project) ? { taintedBy: taintedOwner(plan.project) } : {}), after, owner: plan.project, requestedBy }, `after: ${after.join(", ")} ${after.length === 1 ? "lands" : "land"} first`, Date.now());
        saveQueue([...loadQueue(), item]);
        refs.set(task.id, item.id);
        tasks.push({ ...task, queued: item.id });
        continue;
      }
      const outcome = await startOrQueue(parent, projects, { task: task.task, model: task.model, owner: plan.project, labels, ...(task.research ? { research: task.research } : {}), queue: true }, { id: requestedBy }, log);
      if ("queued" in outcome) {
        refs.set(task.id, outcome.queued.id);
        tasks.push({ ...task, queued: outcome.queued.id });
      } else {
        refs.set(task.id, outcome.started.id);
        timeline.recordCount("worker-started", outcome.started.id, parent.id);
        tasks.push({ ...task, worker: outcome.started.id });
      }
    } catch (caught) {
      tasks.push({ ...task, error: (caught instanceof Error ? caught.message : String(caught)).slice(0, 300) });
    }
  }
  return { ...plan, tasks };
}

/** What a merge request knew of each Worker: its check's head and result, and whether its project merges on green. */
export type GreenCheck = { sha: string; green: boolean; onGreen: boolean };

/**
 * Merge on green: only PRs (never a
 * land), every one in a project whose policy allows it, each with its local
 * check passed on the very head being merged. Anything else asks you.
 */
export function mergesOnGreen(prs: ReadonlyArray<{ head: string; worker?: string }>, lands: number, checked: ReadonlyMap<string, GreenCheck>): boolean {
  if (prs.length === 0 || lands > 0) return false;
  return prs.every((pr) => {
    const seen = pr.worker ? checked.get(pr.worker) : undefined;
    return !!seen && seen.onGreen && seen.green && seen.sha !== "" && seen.sha === pr.head;
  });
}

export async function handleOrch(
  route: string,
  url: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  io: {
    send: Send;
    readBody: ReadBody;
    configPath: string;
    log: (line: string) => void;
    /** `worker`: a Worker's Space tool, run as its owner project's Foreman (workerSpace.ts). */
    caller: { id: string; kind: string; name: string; project?: string; worker?: string };
    /** Tells your phones about a new approval. */
    notify: (approval: StoredApproval) => Promise<void>;
    /** Tells your phones something that needs no answer (a merge on green). */
    announce?: (title: string, body: string, approval: string, decided?: Decided) => Promise<void>;
    /**
     * The Lead's own notification to you (notify_person; notifyPolicy.ts
     * leadNotice checks it). Resolves to an error to return, or null once sent.
     */
    tell?: (notice: { title?: string; text?: string; project?: { id: string; path: string; session: string } }) => Promise<{ status: number; error: string } | null>;
    /** Whether a project's policy merges its Workers' PRs on green (permissions.ts resolveRoles). */
    /** Whether this PR merges on green: the project, its GitHub repository and the head being merged. */
    mergeOnGreen?: (project: { id: string; path: string }, pr: { repo: string; head: string; local: boolean }) => Promise<boolean>;
    /** Research runs' store and judge (webRuns.ts); the live ones when left out. */
    webRuns?: import("./webRuns.ts").WebRunDeps;
    /** Notes a merge on green in What Cobra did (decided.ts). */
    decided?: (entry: Omit<Decided, "id" | "at">) => Decided | void;
    /** Whether merge on green is still under its daily cap (decided.ts DAILY_CAPS); past it, merges ask. */
    mergeCapLeft?: () => boolean;
    /** This computer's short name, as you know it (COBRA_MACHINE_NAME). */
    machineLabel: string;
    /** The agent's port, for a Foreman a brief starts (its key calls back here). */
    port: number;
    /** The mail reads (readRoutes.ts); tests give fakes. */
    reads?: ReadDeps;
    /** Works out a mailbox action's batch of messages (boxMail.ts); tests give a fake. */
    mailbox?: (request: MailboxRequest, remaining: number) => Promise<MailboxBatch>;
    /** The Space mailbox a project's mail_organize works on (emailLive.ts boxOfProject); tests fake it. */
    boxOf?: (project: Project) => Mailbox | null;
    /** The Space mailbox a project's plain email goes from (emailLive.ts mailboxOfProject); tests fake it. */
    mailboxOf?: (project: Project) => { box: string; address: string; mailbox: string } | null;
    /** Routines (routineRoutes.ts); tests give fakes. */
    routines?: RoutineDeps;
    /** A Designer's brand kit and designs (designer.ts); tests give fakes. */
    designer?: DesignerDeps;
    site?: SiteDeps;
    /** Cobra's thread on this computer, for a Designer's designs: null when it cannot be read, with why. */
    thread?: () => { append: (entries: readonly NewEntry[]) => unknown; current: () => string | null } | { notHub: string };
    /** My Organization (orgRoutes.ts), for tests. */
    org?: OrgDeps;
    /** Opening a Space (spaceCreate.ts), for tests. */
    space?: SpaceDeps;
    /** Boards Cobra makes for a Space (spaceBoards.ts), for tests. */
    boards?: BoardDeps;
    /** contact_lookup's Spaces and stores (contactLookup.ts), for tests. */
    contacts?: ContactDeps;
    /** Forms on websites Cobra did not build (formLinks.ts), for tests. */
    forms?: FormDeps;
    /** trade_define's deps (tradeRoutes.ts); the live ones when absent. Tests pass their own. */
    trades?: TradeDeps;
    /** specialist_set's deps (specialistRoutes.ts); the live ones when absent. Tests pass their own. */
    specialists?: SpecialistDeps;
    /** specialist_attach's and specialist_detach's deps (specialistAttach.ts); the live ones when absent. Tests pass their own. */
    attach?: AttachDeps;
    /** The repositories a specialist is attached to, by project id (specialists.ts attachedRepos); the live record when left out. */
    attachedOf?: (id: string, projects: readonly Project[]) => string[];
    /** Trust (trustRoutes.ts): whether an action runs on trust, and the agent's own carrying out of an allowed action (index.ts carryOutAction). */
    trust?: { deps: TrustDeps; carryOut: (approval: StoredApproval) => void };
    /** The taint in force for a session (`lead`, `foreman:<project>`, `worker:<id>`) (taint.ts); the live file when left out. */
    taintOf?: (who: string) => Taint | null;
    /** The taint on what a Foreman last said (taint.ts reportTaint). */
    reportTaintOf?: (who: string) => Taint | null;
    /** Cobra's own Workers (directWorkers.ts): each project's Space and its setting, and whether Workers here are contained; the live ones when left out. */
    direct?: { foremen?: ProjectModeDeps; contained?: () => boolean };
  },
): Promise<void> {
  // Every answer goes to a model (cobra-orch, a Worker's Space tools): no secret value the agent holds, and no token by its shape, ever leaves in one (secretValues.ts).
  const sendRaw = io.send;
  // Taint (taint.ts): who is calling, the taint in force for its turn, and marking what it read.
  const who = io.caller.worker !== undefined ? `worker:${io.caller.worker}` : io.caller.project === undefined ? "lead" : `foreman:${io.caller.project}`;
  const taintOf = io.taintOf ?? ((session: string) => isTainted(session));
  const reportOf = io.reportTaintOf ?? ((session: string) => reportTaint(session));
  const markRead = (session: string, source: TaintSource, why: string, hosts: readonly string[] = []): void => {
    try {
      noteRead(session, why, hosts, Date.now(), undefined, source);
    } catch (caught) {
      io.log(`taint: could not note ${session}'s read (${caught instanceof Error ? caught.message : String(caught)})`);
    }
  };
  // A read whose answer is outside text (the person's mail, their calendar) taints the caller's turn once it is answered.
  const readSource = TAINTING_READS[route];
  io = {
    ...io,
    send: (response, status, body) => {
      if (readSource && status >= 200 && status < 300) markRead(who, readSource, route);
      return sendRaw(response, status, redactDeep(body));
    },
  };
  // Every card made in a tainted turn says why it asks, and is never Cobra's to allow (taint always asks: approvals.ts stampTaint).
  const notifyRaw = io.notify;
  io = {
    ...io,
    notify: async (approval) => {
      const taint = approval.taint ? null : taintOf(who);
      const stamped = taint ? stampTaint(approval, who, taint) : approval;
      if (stamped !== approval) saveApprovals(loadApprovals().map((stored) => (stored.id === approval.id ? stamped : stored)));
      return notifyRaw(stamped);
    },
  };
  const { send } = io;
  // A Foreman's key (keys.ts mintForeman) is held to one project: it sees and acts on that one only.
  const only = io.caller.project;
  const isLead = io.caller.kind === "lead";
  const boardDeps = (): BoardDeps => io.boards ?? liveBoardDeps({ approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) }, notify: io.notify, tell: tellLine, log: io.log });
  // The Lead briefs Foremen; the Foremen run the Workers.
  // Her own direct Workers in an on-call Space pass to their routes, which check the rest (directWorkers.ts); merges, imports, handoffs, denials, the database and reads never do.
  if (isLead && only === undefined && FOREMAN_ONLY.has(route) && !LEAD_WORKER_ROUTES.has(route)) {
    return send(response, 403, { error: "the Lead does not run Workers or ask for merges: brief the project's Foreman (foreman_brief)" });
  }
  const modeOf = (project: { id: string; foremanTemplate?: string }): ProjectMode => projectForemen(project, io.direct?.foremen ?? liveProjectModeDeps(liveSpaceOf()));
  if (isLead && only !== undefined && FOREMAN_ROUTES.has(route)) {
    return send(response, 403, { error: "a Foreman does not brief Foremen" });
  }
  // A Worker's Space tools reach their own routes only (workerSpace.ts picks the route; this holds if it ever picked wrong).
  if (io.caller.worker !== undefined && !WORKER_SPACE_ROUTES.has(route)) {
    return send(response, 403, { error: "a Worker's Space tools do not reach this" });
  }
  const inScope = async (): Promise<Project[]> => {
    const projects = await registered(io.configPath);
    return only === undefined ? projects : projects.filter((project) => project.id === only);
  };
  // A Website Builder linked to a site someone else coded (outsideSite.ts, on the person's Allow) also starts and runs Workers there.
  let linkedMemo: Promise<string | null> | undefined;
  const linkedSite = (): Promise<string | null> =>
    (linkedMemo ??= (async () => {
      if (only === undefined) return null;
      const project = (await registered(io.configPath)).find((candidate) => candidate.id === only);
      if (!project || project.foremanTemplate !== WEBSITE_BUILDER) return null;
      const deps = io.site ?? liveSiteDeps(io);
      return readLink(siteFolders(project, deps.stateDir, deps.place(project).space).state)?.project ?? null;
    })());
  /**
   * The projects a Foreman works in besides its own: a Website Builder's
   * linked site, and the repositories the person attached it to
   * (specialistAttach.ts). Read from the record on each request, so a detach
   * holds from the next call. There it starts Workers and sees the ones it
   * started; the project's store, reads, routines and memory stay that
   * project's own (inScope).
   */
  let alsoMemo: Promise<ReadonlySet<string>> | undefined;
  const alsoIn = (): Promise<ReadonlySet<string>> =>
    (alsoMemo ??= (async () => {
      if (only === undefined) return new Set<string>();
      const projects = await registered(io.configPath);
      const attached = io.attachedOf ? io.attachedOf(only, projects) : attachedRepos(only, projects).map((project) => project.id);
      const linked = await linkedSite();
      return new Set([...attached.filter((id) => id !== only), ...(linked === null ? [] : [linked])]);
    })());
  /** The projects a Foreman's Workers may live in: its own, and the ones alsoIn names. */
  const workScope = async (): Promise<Project[]> => {
    const projects = await registered(io.configPath);
    if (only === undefined) return projects;
    const also = await alsoIn();
    return projects.filter((project) => project.id === only || also.has(project.id));
  };
  const scopedWorker = async (id: unknown): Promise<Extra> => {
    // The Lead and Foremen never see your own Pi sessions; the desk see every session (Tidy's Delete).
    const extra = await findWorker(id, isLead ? orchWorkerRecords : workerRecords);
    if (only !== undefined && extra.parent !== only) {
      // In a project it only works in, a Worker is its own when it started it: another specialist's there is not.
      if (!(await alsoIn()).has(extra.parent) || extra.worker?.owner !== only) throw new SessionError(`no Worker ${String(id)} in ${only}`, 404);
    }
    return extra;
  };
  const keyOf = async (id: string): Promise<string> => {
    const project = (await registered(io.configPath)).find((candidate) => candidate.id === id);
    return project ? projectKeyFor(project) : `local/${id}`;
  };
  const wantsPost = POSTS.has(route);
  if (wantsPost && request.method !== "POST") return send(response, 405, { error: "POST only" });
  if (!wantsPost && request.method !== "GET") return send(response, 405, { error: "GET only" });
  try {
    // This computer's API spend this month (modelGateway.ts). Never a Foreman's key.
    if (route === "/orch/api-lane") {
      if (only !== undefined) return send(response, 403, { error: "a Foreman's key does not read the API spend" });
      return send(response, 200, { machine: io.machineLabel, ...monthSpendHere() });
    }
    if (route === "/orch/status") return send(response, 200, scopeStatus(await orchStatus(io.configPath), only, await alsoIn()));
    if (route === "/orch/policy") {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
      const also = await alsoIn();
      const mine = only === undefined ? null : new Set((await orchWorkerRecords()).filter((extra) => extra.parent === only || (also.has(extra.parent) && extra.worker?.owner === only)).map((extra) => extra.id));
      return send(response, 200, { machine: os.hostname(), entries: readPolicyLog(limit).filter((entry) => !mine || mine.has(entry.worker)) });
    }
    if (route === "/orch/history") {
      const days = Number(url.searchParams.get("days") ?? 14) || 14;
      return send(response, 200, readHistory({ days, ...(only !== undefined ? { only } : {}) }));
    }
    if (route === "/orch/approval") {
      const id = url.searchParams.get("id") ?? "";
      const found = settle(loadApprovals(), Date.now()).find((a) => a.id === id && (only === undefined || a.requestedBy === io.caller.id));
      if (!found) return send(response, 404, { error: "no such approval" });
      return send(response, 200, { approval: publicView(found) });
    }
    if (route === "/orch/worker") {
      const extra = await scopedWorker(url.searchParams.get("id"));
      const afterRaw = url.searchParams.get("after");
      const after = afterRaw === null ? undefined : Number(afterRaw);
      if (after !== undefined && !Number.isInteger(after)) return send(response, 400, { error: "after must be a byte offset" });
      const projects = await workScope();
      const name = projects.find((project) => project.id === extra.parent)?.name ?? extra.parent;
      const [worker, transcript] = await Promise.all([describeWorker(extra, name, await runningSessions()), workerTranscript(extra, after)]);
      // A Worker that read text from outside: its words may carry what that text planted (taint.ts).
      const read = taintOf(`worker:${extra.id}`);
      if (read) markRead(who, "worker", `worker_read ${extra.id}`, read.hosts);
      return send(response, 200, { worker, ...transcript });
    }
    if (route === "/orch/worker/wait") {
      const ids = listParam(url, "ids");
      if (ids.size === 0) return send(response, 400, { error: "ids is a comma-separated list of Worker ids" });
      const timing = waitTiming(url);
      if ("error" in timing) return send(response, 400, timing);
      const { since } = timing;
      const projects = await workScope();
      const also = await alsoIn();
      const audience = audienceOf(io.caller);
      // A new finish (finishes.ts), not a state: a Worker already idle, or
      // still on a question already reported, does not come back again.
      const reply = await holdOpen(request, timing.seconds, async (last) => {
        const workers = (await describeAll(projects, ids)).filter((worker) => only === undefined || worker.parent === only || (also.has(worker.parent) && worker.owner === only));
        if (workers.length === 0) return { status: 404, body: { error: "none of those Workers is on this computer" } };
        const fresh = finishes.claim(workers.map((worker) => worker.id), audience, since);
        if (fresh.length > 0) {
          const done = new Set(fresh.map((finish) => finish.id));
          // Each finish carries its Worker's last words: one that read text from outside taints the reader (taint.ts).
          for (const id of done) {
            const read = taintOf(`worker:${id}`);
            if (read) markRead(who, "worker", `worker_wait ${id}`, read.hosts);
          }
          return {
            status: 200,
            body: { timedOut: false, workers: workers.filter((worker) => done.has(worker.id)), finishes: fresh, cursor: Math.max(...fresh.map((finish) => finish.at)) },
          };
        }
        if (!last) return null;
        return { status: 200, body: { timedOut: true, workers, finishes: [], cursor: since ?? Date.now(), settled: workers.filter(settled).map((worker) => worker.id) } };
      });
      return send(response, reply.status, reply.body);
    }

    if (route === "/orch/foreman") {
      const id = url.searchParams.get("project") ?? "";
      const project = projectNamed(await inScope(), id);
      if (!project) return send(response, 404, { error: notHere(id) });
      const afterRaw = url.searchParams.get("after");
      const after = afterRaw === null ? undefined : Number(afterRaw);
      if (after !== undefined && !Number.isInteger(after)) return send(response, 400, { error: "after must be a byte offset" });
      const foreman = await describeForeman(project, await runningSessions());
      const transcript = foreman.running ? await sessionTranscript(foreman.session, after) : { offset: after ?? 0, messages: [] };
      // Cobra has read it: an on-call Foreman whose final report this was may sleep now (onCall.ts).
      if (audienceOf(io.caller) === "lead") onCall.leadRead(project.id, Date.now());
      // A report written in a turn that read outside text carries it to its reader, though the Foreman's own taint ended at its Stop.
      const said = who === `foreman:${project.id}` || transcript.messages.length === 0 ? null : reportOf(`foreman:${project.id}`);
      if (said) markRead(who, "report", `foreman_read ${project.id}`, said.hosts);
      return send(response, 200, { foreman, ...transcript });
    }
    // request_read: the question a Worker under a Foreman the Lead briefed waits on (requestAnswer.ts).
    if (route === "/orch/request") {
      if (!isLead || only !== undefined) return send(response, 403, { error: "only the Lead on this computer reads a Worker's question" });
      const extra = await findWorker(url.searchParams.get("worker"), orchWorkerRecords);
      const refused = requestRefusal(extra, (project) => finishes.isBriefed(project));
      if (refused) return send(response, 409, { error: refused });
      const question = await workerQuestion(extra);
      return send(response, 200, {
        worker: extra.id,
        foreman: extra.worker!.owner,
        task: extra.worker!.task.slice(0, 600),
        waiting: question !== null,
        ...(question ? { question: questionText(question) } : {}),
      });
    }
    if (route === "/orch/foreman/wait") {
      const ids = listParam(url, "projects");
      if (ids.size === 0) return send(response, 400, { error: "projects is a comma-separated list of project ids" });
      const timing = waitTiming(url);
      if ("error" in timing) return send(response, 400, timing);
      const { since } = timing;
      const projects = await inScope();
      const chosen = [...new Set([...ids].map((id) => projectNamed(projects, id)).filter((project): project is Project => project !== undefined))];
      if (chosen.length === 0) return send(response, 404, { error: "none of those projects is on this computer" });
      const audience = audienceOf(io.caller);
      const reply = await holdOpen(request, timing.seconds, async (last) => {
        const [running, records] = [await runningSessions(), readHookRecords()];
        const foremen: OrchForeman[] = await Promise.all(chosen.map((project) => describeForeman(project, running, records)));
        const fresh = finishes.claimForemen(foremen.map((foreman) => foreman.project), audience, since);
        if (audience === "lead") for (const finish of fresh) onCall.leadRead(finish.id, Date.now());
        if (fresh.length > 0) {
          const done = new Set(fresh.map((finish) => finish.id));
          return {
            status: 200,
            body: { timedOut: false, foremen: foremen.filter((foreman) => done.has(foreman.project)), finishes: fresh, cursor: Math.max(...fresh.map((finish) => finish.at)) },
          };
        }
        if (!last) return null;
        const atRest = foremen.filter((foreman) => foremanSettled(foreman) !== null).map((foreman) => foreman.project);
        return { status: 200, body: { timedOut: true, foremen, finishes: [], cursor: since ?? Date.now(), settled: atRest } };
      });
      return send(response, reply.status, reply.body);
    }

    // Memory (memoryAccess.ts), a GET like the routes above: any caller reads it; a Foreman's key reads the dated notes and its own project's.
    if (route === "/orch/memory/file") {
      const onlyKey = only === undefined ? null : await keyOf(only);
      const read = readScoped(MEMORY_DIR, url.searchParams.get("path") ?? "", onlyKey);
      if ("error" in read) return send(response, read.status, { error: read.error });
      return send(response, 200, read);
    }
    // One slice of this computer's memory: a project's (by id or owner/repo) or a company's notes, state, lessons or brain.
    if (route === "/orch/memory/slice") {
      const onlyKey = only === undefined ? null : await keyOf(only);
      const asked = url.searchParams.get("project")?.trim() || undefined;
      const project = asked && !asked.includes("/") ? await keyOf(asked) : asked;
      const after = Number(url.searchParams.get("after") ?? "0");
      const slice = readSlice(
        MEMORY_DIR,
        computerName(),
        {
          ...(project ? { project } : {}),
          ...(url.searchParams.get("company") ? { company: url.searchParams.get("company")! } : {}),
          kind: (url.searchParams.get("kind") ?? "notes") as SliceKind,
          ...(url.searchParams.get("since") ? { since: url.searchParams.get("since")! } : {}),
          ...(Number.isFinite(after) && after > 0 ? { after } : {}),
        },
        onlyKey,
      );
      if ("error" in slice) return send(response, slice.status, { error: slice.error });
      return send(response, 200, slice);
    }
    // ask_person (asks.ts): the Lead or a Foreman on this computer asks you; it shows as its question card.
    const askSession = async (): Promise<string | { status: number; error: string }> => {
      if (!isLead) return { status: 403, error: "only the Lead and the Foremen on this computer ask the person" };
      const project = only === undefined ? null : (await inScope())[0];
      if (only !== undefined && !project) return { status: 404, error: `no project ${only} here` };
      return project ? foremanSession(project) : LEAD_SESSION;
    };
    if (route === "/orch/ask/wait") {
      const session = await askSession();
      if (typeof session !== "string") return send(response, session.status, { error: session.error });
      const id = url.searchParams.get("id") ?? "";
      const seconds = Math.min(50, Math.max(0, Number(url.searchParams.get("timeout") ?? "40") || 0));
      const until = Date.now() + seconds * 1000;
      for (;;) {
        const ask = findAsk(id);
        if (!ask || ask.session !== session) return send(response, 404, { error: `no question ${id} from this conversation (one older than a day is gone)` });
        if (ask.answer) return send(response, 200, { answered: true, answer: answerWords(ask) });
        if (Date.now() >= until) return send(response, 200, { answered: false });
        await new Promise((done) => setTimeout(done, 1000));
      }
    }

    if (DB_ROUTES.has(route)) {
      // A Foreman's key only, for its own project; the Lead's key stopped at FOREMAN_ONLY. The rest is dbRoutes.ts.
      if (only === undefined) return send(response, 403, { error: "only a project's Foreman reads or changes its database or renders its reports, with the db_ and report_ tools; the Lead briefs the Foreman" });
      const project = (await inScope()).find((candidate) => candidate.id === only);
      if (!project) return send(response, 404, { error: `no project "${only}" here` });
      // Its GETs carry no body; a query or a mutation's args can be large (rows).
      let dbBody: Record<string, unknown> = {};
      if (DB_POSTS.has(route)) {
        try {
          dbBody = JSON.parse(await io.readBody(request, 1_000_000)) as Record<string, unknown>;
        } catch {
          return send(response, 400, { error: "invalid JSON body" });
        }
      }
      // A budget's limits Money proposes become the person's one card (budgetCard.ts).
      // Bills Money proposes, too (billsCard.ts).
      const cardDeps = (db: ProjectDb): BudgetCardDeps => ({
        approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) },
        notify: io.notify,
        space: (seated) => {
          const seat = seatOf(seated);
          const record = seat ? readSpace(seat.space) : null;
          return record ? { id: record.id, name: record.name } : null;
        },
        open: () => db,
        stored: () => {},
        tell: tellLine,
        log: io.log,
        now: Date.now,
      });
      const budgetProposed = (id: string, db: ProjectDb, batch: number, by: string) => proposeBudgetCard(cardDeps(db), id, db, batch, by);
      const billsProposed = (id: string, db: ProjectDb, batch: number, by: string) => proposeBillsCard(cardDeps(db), id, db, batch, by);
      // A Worker's Space tool writes as itself (workerSpace.ts): the journal says which Worker did it.
      const by = io.caller.worker !== undefined ? `worker:${io.caller.worker}` : undefined;
      // A query of the people and timeline a website form or an email reply wrote into taints the turn (taint.ts).
      const outsideRead = (what: string) => markRead(who, "records", what);
      const reply = await handleDb(route, url, dbBody, project, { ...liveDbDeps(), budgetProposed, billsProposed, outsideRead }, io.log, by);
      return send(response, reply.status, reply.body);
    }

    if (READ_ROUTES.has(route)) {
      // A Foreman's key only, for its own project: the Lead's key stopped at FOREMAN_ONLY, Workers and jobs hold no key. The trade's reads and the rest are readRoutes.ts.
      if (only === undefined || !isLead) return send(response, 403, { error: "only a project's Foreman reads its Space's mailbox, and only when its trade reads mail; the Lead briefs the Foreman" });
      const project = (await inScope()).find((candidate) => candidate.id === only);
      if (!project) return send(response, 404, { error: `no project "${only}" here` });
      let readBody: Record<string, unknown>;
      try {
        const parsed = JSON.parse(await io.readBody(request, READ_BODY_LIMIT)) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        readBody = parsed as Record<string, unknown>;
      } catch {
        return send(response, 400, { error: "invalid JSON body" });
      }
      const reply = await handleRead(route, readBody, project, io.reads ?? liveReadDeps(), io.log);
      return send(response, reply.status, reply.body);
    }

    if (ORCH_ROUTINE_ROUTES.has(route)) {
      // The Lead for any project here, a Foreman for its own (routineRoutes.ts); a new one is an approval the person allows.
      const routineBody = ORCH_ROUTINE_POSTS.has(route) ? await io.readBody(request, 20_000) : "";
      const deps = io.routines ?? liveRoutineDeps({ configPath: io.configPath, port: io.port, notify: io.notify, tell: tellLine, log: io.log });
      const reply = await handleRoutineOrch(route, url, routineBody, io.caller, deps);
      return send(response, reply.status, reply.body);
    }

    if (ORCH_EMAIL_ROUTES.has(route)) {
      // A Foreman of a Space (emailRoutes.ts): branded email templates, each version and each send an approval the person allows.
      const emailBody = ORCH_EMAIL_POSTS.has(route) ? await io.readBody(request, 200_000) : "";
      const deps = liveEmailRouteDeps({
        configPath: io.configPath,
        notify: io.notify,
        log: io.log,
        approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) },
        project: async (id) => (await registered(io.configPath)).find((project) => project.id === id),
      });
      const trust = io.trust;
      if (trust) deps.trust = { approval: (action, by) => trustedApproval(trust.deps, action, by), carryOut: trust.carryOut };
      deps.tainted = (session: string) => taintOf(session) !== null;
      const reply = await handleEmailOrch(route, url, emailBody, io.caller, deps);
      return send(response, reply.status, reply.body);
    }

    if (ORCH_DESIGNER_ROUTES.has(route)) {
      // A Designer Foreman's (designer.ts): a brand kit is an approval the person allows; designs go into Cobra's thread.
      const designerBody = await io.readBody(request, 20_000);
      const deps = io.designer ?? liveDesignerDeps(io);
      const reply = await handleDesignerOrch(route, designerBody, io.caller, deps);
      return send(response, reply.status, reply.body);
    }

    if (ORCH_SITE_ROUTES.has(route)) {
      // A Website Builder Foreman's (site.ts): edits journaled, previews in the owner's Cloudflare, and going live only through a card.
      const siteBody = ORCH_SITE_POSTS.has(route) ? await io.readBody(request, 2_000_000) : "";
      const deps = io.site ?? liveSiteDeps(io);
      const reply = await handleSiteOrch(route, request.method, siteBody, io.caller, deps);
      return send(response, reply.status, reply.body);
    }

    if (ORCH_ORG_ROUTES.has(route)) {
      // My Organization (orgRoutes.ts): the Lead on this computer reads it, changes it when told, and proposes moves.
      const orgBody = ORCH_ORG_POSTS.has(route) ? await io.readBody(request, 20_000) : "";
      const deps = io.org ?? liveOrgDeps({ home: () => true, approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) }, notify: io.notify, tell: tellLine, log: io.log });
      const reply = await handleOrgOrch(route, orgBody, io.caller, deps);
      return send(response, reply.status, reply.body);
    }

    // The morning brief (morning.ts): this computer's facts, for the Lead's computer to put into words.
    if (route === "/orch/morning") {
      if (!isLead || only !== undefined) return send(response, 403, { error: "only the Lead reads a computer's morning facts" });
      return send(response, 200, factsHere());
    }

    // board_schema (spaceBoards.ts): a GET, so it is answered before the body below is read.
    if (route === "/orch/board/schema") {
      if (!isLead || only !== undefined) return send(response, 403, { error: "only the Lead on this computer makes a Space's boards" });
      const deps = boardDeps();
      const id = url.searchParams.get("space") ?? "";
      let space;
      try {
        space = id ? readSpace(id, deps.spacesRoot) : null;
      } catch {
        space = null;
      }
      if (!space) return send(response, 404, { error: `no Space ${id || "(none given)"} is open on this computer: space is a company id from org_read` });
      const db = deps.open(space.id);
      try {
        return send(response, 200, boardSchema(db, space, readBoards(space.id, deps.spacesRoot), deps.data(space.id)));
      } finally {
        db.close();
      }
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await io.readBody(request, 100_000)) as Record<string, unknown>;
    } catch {
      return send(response, 400, { error: "invalid JSON body" });
    }
    const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined);

    // contact_lookup (contactLookup.ts): Cobra's one read of a Space's People, for a duplicate check without waking its CRM Foreman.
    // Hers alone, on this computer: a Foreman reads its store with db_query, and a Worker's Space tools never reach it.
    if (route === CONTACT_LOOKUP_ROUTE) {
      if (!isLead || only !== undefined || io.caller.worker !== undefined) return send(response, 403, { error: "only Cobra on this computer looks up a Space's contacts" });
      const reply = handleContactLookup(body, io.contacts ?? liveContactDeps());
      return send(response, reply.status, reply.body);
    }

    if (route === "/orch/foreman/brief") {
      const id = text("project") ?? "";
      const project = projectNamed(await inScope(), id);
      if (!project) return send(response, 404, { error: notHere(id) });
      // The Lead sends the org (kept on its computer) so the brief can name this Foreman's company; seats name computers as os.hostname().
      const sentOrg = isLead && body.org ? parseOrg(body.org) : null;
      const seat = sentOrg?.seats[seatKey(os.hostname(), project.id)];
      const seated = seat && !seat.retired ? sentOrg?.companies.find((company) => company.id === seat.company) : undefined;
      // The company and its rules for the work (companyBrain.ts), from this computer's brain or its copy of it.
      const note = sentOrg ? [companyNote(sentOrg, os.hostname(), project.id), seated ? rulesLine(MEMORY_DIR, computerName(), seated) : null].filter(Boolean).join(" ") || null : null;
      const brief = briefText(text("text") ?? "", isLead, note);
      const session = foremanSession(project);
      const started = !(await runningSessions()).has(session);
      if (started) {
        await startForeman(project);
        io.log(`Foreman started for ${project.id} by ${io.caller.id}`);
      }
      // The Lead hears of this Foreman's finishes from now on, across restarts too (finishes.ts).
      if (audienceOf(io.caller) === "lead") finishes.briefed(project.id, { quiet: body.quiet === true });
      // A brief from a turn that read text from outside carries it: the Foreman's turn it starts is tainted (taint.ts).
      const briefTaint = isLead ? taintOf(who) : null;
      if (briefTaint) markRead(`foreman:${project.id}`, "brief", `brief from ${who}`, briefTaint.hosts);
      // A Lead's brief, or the person's own words from the desk (wakes.ts).
      await typeBrief(waking(liveDispatchDeps(), session, isLead ? "brief" : "person", project.id), session, brief, started ? READY_TIMEOUT_MS : 0);
      io.log(`Foreman for ${project.id} briefed by ${io.caller.id}`);
      return send(response, 200, { foreman: await describeForeman(project, await runningSessions()), started });
    }

    // Cobra answers a Foreman's question (foremanAnswer.ts): only a question, never a permission prompt, and only from the Lead on this computer.
    if (route === "/orch/foreman/answer") {
      if (!isLead || only !== undefined) return send(response, 403, { error: "only the Lead on this computer answers a Foreman's question" });
      const id = text("project") ?? "";
      const project = projectNamed(await inScope(), id);
      if (!project) return send(response, 404, { error: notHere(id) });
      const input = parseAnswerInput(body);
      if (typeof input === "string") return send(response, 400, { error: input });
      // A Foreman the person runs on their own is theirs to answer.
      if (!finishes.isBriefed(project.id)) return send(response, 409, { error: `the Foreman for ${project.id} was not briefed by you: its questions are the person's` });
      const session = foremanSession(project);
      const foreman = await describeForeman(project, await runningSessions());
      const answer = answerFor(foreman, input);
      if (typeof answer === "string") return send(response, 409, { error: answer });
      // An ask_person ask is answered in the agent's file; an AskUserQuestion on its screen, as the phone would.
      const answerTaint = taintOf(who);
      if (answerTaint) markRead(`foreman:${project.id}`, "brief", `answer from ${who}`, answerTaint.hosts);
      const asked = answerAsk(session, [answer], undefined, undefined, "cobra");
      if (asked) finishes.tell(asked.owner, `Cobra answered your question ${asked.id}: read it with ask_wait ${asked.id}.`, "answer");
      // A headless Foreman (API test mode) takes it on its waiting call (workers.ts headlessAction).
      else {
        await withWake(session, "answer", project.id, async () => {
          if (!(await headlessAction(session, "answer", { answers: [answer] }))) await runSessionAction("answer", session, { answers: [answer] });
        });
      }
      const words = answeredWords(foreman.question!, answer);
      timeline.recordCount("answered", session, project.id, undefined, `Cobra ${words}: ${foreman.question!.text}`.slice(0, 200));
      io.log(`Foreman for ${project.id}: Cobra ${words}`);
      return send(response, 200, { answered: `${words} to "${foreman.question!.text}"`, foreman: await describeForeman(project, await runningSessions()) });
    }

    // request_answer for a Worker: its question, answered for the person as a Foreman's is (requestAnswer.ts).
    if (route === "/orch/request/answer") {
      if (!isLead || only !== undefined) return send(response, 403, { error: "only the Lead on this computer answers a Worker's question" });
      const extra = await findWorker(text("worker"), orchWorkerRecords);
      const refused = requestRefusal(extra, (project) => finishes.isBriefed(project));
      if (refused) return send(response, 409, { error: refused });
      const input = parseAnswerInput(body);
      if (typeof input === "string") return send(response, 400, { error: input });
      const question = await workerQuestion(extra);
      const running = (await runningSessions()).has(extra.session);
      const answer = answerFor({ project: extra.id, running, needsInput: question !== null, dialog: question ? "question" : null, ...(question ? { question } : {}) }, input, `Worker ${extra.id}`);
      if (typeof answer === "string") return send(response, 409, { error: answer });
      if (taintOf(who)) taintWorker(extra.id, who);
      const asked = answerAsk(extra.session, [answer], undefined, undefined, "cobra");
      if (asked) finishes.tell(asked.owner, `Cobra answered your question ${asked.id}: read it with ask_wait ${asked.id}.`, "answer");
      else if (!(await headlessAction(extra.session, "answer", { answers: [answer] }))) await runSessionAction("answer", extra.session, { answers: [answer] });
      const words = answeredWords(question!, answer);
      // Its Foreman hears of it, as the Worker's own answer would show in its next report; her own Worker has no Foreman over it.
      if (!startedByLead(extra)) finishes.tell(extra.worker!.owner, `Cobra answered Worker ${extra.id}'s question for the person: she ${words}.`);
      timeline.recordCount("answered", extra.session, extra.parent, undefined, `Cobra ${words}: ${question!.text}`.slice(0, 200));
      io.log(`Worker ${extra.id}: Cobra ${words}`);
      return send(response, 200, { answered: `${words} to "${question!.text}"` });
    }

    // Cobra proposes a change to a specialist (specialistRoutes.ts): one card with every word, and only the person's Allow applies it.
    if (route === "/orch/specialist/set") {
      if (!isLead || only !== undefined || io.caller.worker !== undefined) return send(response, 403, { error: "only the Lead proposes a change to a specialist" });
      if (taintOf(who)) return send(response, 409, { error: ROSTER_TAINTED });
      const deps = io.specialists ?? liveSpecialistDeps({
        approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) },
        notify: io.notify,
        tell: tellLine,
        log: io.log,
        projects: () => inScope(),
        tradeName: (id) => allTrades().find((trade) => trade.id === id)?.name,
      });
      const outcome = await proposeSpecialist(deps, io.caller.id, body);
      return send(response, outcome.status, outcome.body);
    }

    // Cobra attaches a specialist to a project the person already has (specialistAttach.ts): a card, and only the person's Allow attaches. Detaching only takes access away, so it applies at once.
    if (route === "/orch/specialist/attach" || route === "/orch/specialist/detach") {
      if (!isLead || only !== undefined || io.caller.worker !== undefined) return send(response, 403, { error: "only the Lead attaches a specialist to a project, or detaches it" });
      // What she read from outside may have planted either: one gives a specialist a project's files, the other takes its work away.
      if (taintOf(who)) return send(response, 409, { error: ROSTER_TAINTED });
      const deps = io.attach ?? liveAttachDeps({
        approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) },
        notify: io.notify,
        tell: tellLine,
        log: io.log,
        projects: () => inScope(),
        workers: async () => {
          const running = await runningSessions();
          return (await orchWorkerRecords()).map((extra) => ({ id: extra.id, name: extra.id, parent: extra.parent, ...(extra.worker?.owner ? { owner: extra.worker.owner } : {}), running: running.has(extra.session) }));
        },
      });
      const outcome = route === "/orch/specialist/attach" ? await proposeAttach(deps, io.caller.id, body) : await detachSpecialist(deps, body, "lead", io.caller.id, { specialist: "specialist", repo: "project" });
      return send(response, outcome.status, outcome.body);
    }

    // Cobra defines a trade (tradeRoutes.ts): the Lead here proposes it, and only the person's Allow installs it.
    if (route === "/orch/trade/define") {
      if (!isLead || only !== undefined) return send(response, 403, { error: "only the Lead on this computer defines a trade" });
      if (taintOf(who)) return send(response, 409, { error: ROSTER_TAINTED });
      const deps = io.trades ?? liveTradeDeps({ approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) }, notify: io.notify, tell: tellLine, log: io.log });
      const outcome = await proposeTrade(deps, io.caller.id, body.definition);
      return send(response, outcome.status, outcome.body);
    }

    // A new Space from the intake (spaceCreate.ts): one card for the person; on Allow the agent opens the Space, with no Foremen until Cobra hires one on first need.
    if (route === "/orch/space/create") {
      if (!isLead || only !== undefined) return send(response, 403, { error: "only the Lead on this computer opens a Space" });
      const deps = io.space ?? liveSpaceDeps({ configPath: io.configPath, approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) }, notify: io.notify, tell: tellLine, log: io.log });
      const reply = await proposeSpace(deps, io.caller.id, body);
      return send(response, reply.status, reply.body);
    }

    // A board for a Space (spaceBoards.ts): board_schema reads its store's tables (a GET, read above with no body), board_propose checks and test-runs the widgets, then one card.
    if (route === "/orch/board/propose") {
      if (!isLead || only !== undefined) return send(response, 403, { error: "only the Lead on this computer makes a Space's boards" });
      const reply = await proposeBoard(boardDeps(), io.caller.id, body);
      return send(response, reply.status, reply.body);
    }

    // A form on a website Cobra did not build (formLinks.ts): form_sources reads the account's databases (names and counts), form_link makes one card, form_unlink stops the reading.
    if (ORCH_FORM_ROUTES.has(route)) {
      if (!isLead || only !== undefined) return send(response, 403, { error: "only the Lead on this computer links a website's form" });
      const deps = io.forms ?? liveFormDeps({ approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) }, card: io.notify, tell: tellLine, log: io.log });
      const reply = await handleFormOrch(route, body, io.caller.id, deps);
      return send(response, reply.status, reply.body);
    }

    // The Lead may create a new project only through a saved trade. It
    // cannot choose arbitrary shell commands or a starter prompt.
    if (route === "/orch/foreman/create") {
      if (!isLead || only !== undefined) return send(response, 403, { error: "only the Lead on this computer may create a templated Foreman" });
      if (taintOf(who)) return send(response, 409, { error: ROSTER_TAINTED });
      // Its own name and title, when the person gave them: checked before anything is made.
      const calledRaw = text("specialistName");
      const called = calledRaw === undefined ? undefined : cleanCrewName(calledRaw);
      if (called === null) return send(response, 400, { error: "specialistName is 1 to 20 letters, digits, spaces, ' . or -, and not Cobra" });
      const titled = createTitle(body.title);
      if ("error" in titled) return send(response, 400, { error: titled.error });
      const template = text("template");
      if (!knownTrade(template)) {
        return send(response, 400, { error: unknownTemplateError() });
      }
      const registry = await loadRegistry(io.configPath);
      // No name: the trade's own, made unique here ("Billing 2").
      const name = (text("name") ?? "").trim() || defaultProjectName(template!, registry.projects.filter((project) => project.machine === os.hostname()).map((project) => project.name));
      // Hiring into a Space (spaceCreate.ts checkHire): its folder, its store and its company, up to the cap before she asks.
      const spaceId = text("space");
      let hired: OrgCompany | undefined;
      if (spaceId) {
        const checked = checkHire(loadOrg(), spaceId, os.hostname(), body.confirmed === true, readSpace(spaceId) !== null);
        if ("error" in checked) return send(response, checked.status, { error: checked.error });
        if (body.remote === true) return send(response, 400, { error: "a Space's Foremen keep their repositories on this computer: leave remote out" });
        hired = checked.company;
      }
      const gh = await findGh();
      const auth = gh === null ? { authed: false } : await ghAuth(gh);
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || template!;
      const directory = text("directory") ?? (hired ? slug : undefined);
      // An opened Space's folder is a place projects may be made in: put it back on the list if folders.json lost it.
      if (hired) await ensureFolder(SPACES_DIR, readFolders(), registry.roots, writeFolders);
      const roots = hired ? (await loadRegistry(io.configPath)).roots : registry.roots;
      const result = await createProject(liveCreateDeps({ machine: os.hostname(), roots, registered: registry.projects, gh, githubAuth: auth.authed }), {
        mode: "init", name, directory, root: hired ? SPACES_DIR : text("root"), remote: body.remote === true, start: false, foremanTemplate: template,
        ...(hired && directory ? { under: hired.id, idHint: `${hired.id}-${directory}` } : {}),
      });
      // A seat of the Space's kind (People, Outreach, Money) also gets its first job, which a Space no longer starts
      // for it (spaceCreate.ts seatBrief), before Cobra's own brief.
      const role = hired ? seatTrade(template) : null;
      const joined = hireBrief(hired, role, text("brief"));
      const firstBrief = joined ? briefText(joined, true) : undefined;
      if (hired) {
        // Seated in the Space's store and put in its company before it starts, so its first write lands in the shared store.
        if (role) registerSeat(hired.id, result.project.id, role);
        saveOrg(applyOrg(loadOrg(), { op: "assign", seat: seatKey(os.hostname(), result.project.id), company: hired.id }).org);
      }
      // Named and titled before its first conversation, so it starts as who the person asked for.
      const naming: string[] = [];
      if (called) {
        try {
          changeCrew(result.project, { name: called });
        } catch (caught) {
          naming.push(`it kept its own name (${caught instanceof Error ? caught.message : String(caught)})`);
        }
      }
      if (titled.title) {
        try {
          setSpecialist(result.project.id, { title: titled.title }, "lead", io.caller.id);
        } catch (caught) {
          naming.push(`its title was not kept (${caught instanceof Error ? caught.message : String(caught)})`);
        }
      }
      result.warnings.push(...naming);
      try {
        const started = await startForeman(result.project);
        io.log(`templated Foreman ${template} started for ${result.project.id} by ${io.caller.id}`);
        // The Lead made it, so its reports and questions come to the Lead (finishes.ts), brief or none.
        finishes.briefed(result.project.id);
        const warnings = [...result.warnings];
        let briefed = false;
        if (firstBrief) {
          try {
            await typeBrief(waking(liveDispatchDeps(), started.session, "brief", result.project.id), started.session, firstBrief, READY_TIMEOUT_MS);
            briefed = true;
            io.log(`Foreman for ${result.project.id} briefed by ${io.caller.id}`);
          } catch (caught) {
            warnings.push(`the brief was not typed (${caught instanceof Error ? caught.message : String(caught)}): foreman_brief it again`);
          }
        }
        return send(response, 200, { project: result.project, foreman: await describeForeman(result.project, await runningSessions()), warnings, briefed });
      } catch (caught) {
        return send(response, 200, { project: result.project, warnings: [...result.warnings, caught instanceof Error ? `could not start Foreman (${caught.message})` : "could not start Foreman"] });
      }
    }

    if (route === "/orch/worker/spawn") {
      const projects = await workScope();
      const id = text("project") ?? "";
      const parent = projects.find((project) => project.id === id);
      if (!parent) return send(response, 404, { error: `no project "${id}" on this computer` });
      // The Lead's own key starts a Worker only for a light task in an on-call Space (directWorkers.ts, Figure 2); the rest is checked below.
      const direct = isLead && only === undefined;
      const mode = direct ? modeOf(parent) : null;
      if (mode && mode.mode !== "on-call") return send(response, 409, { error: `brief the Foreman: ${mode.why}` });
      const model = text("model");
      const branch = text("branch");
      // A Foreman's Workers are owned by its project, whatever it says; so are Cobra's own.
      const owner = only ?? (direct ? parent.id : text("owner"));
      const task = (text("task") ?? "").trim();
      if (!task) return send(response, 400, { error: "a Worker needs a task" });
      const research = (text("research") ?? "").replace(/\s+/g, " ").trim();
      if (research && (research.length < 8 || research.length > 400)) return send(response, 400, { error: "research is 8 to 400 characters: what the Worker finds out on the web, as one line" });
      // Its owner project's Space tools (workerSpace.ts): a Foreman's, for its own project; B3 lets the Lead.
      if (body.spaceTools !== undefined && typeof body.spaceTools !== "boolean") return send(response, 400, { error: "spaceTools is true or false" });
      // Cobra's own Worker always has them: its work is what it does with them.
      const spaceTools = direct || body.spaceTools === true;
      if (spaceTools && !direct) {
        if (!isLead || only === undefined) return send(response, 403, { error: "only a Foreman gives its Workers Space tools, for its own project" });
        const own = projects.find((project) => project.id === only);
        if (!own || workerToolNames(own.foremanTemplate ?? "").length === 0) return send(response, 409, { error: `${own?.name ?? only}'s trade has no Space tools for a Worker: leave out spaceTools` });
      }
      if (body.kind !== undefined && !isKind(body.kind)) return send(response, 400, { error: "kind is one of tests, docs, bugfix, refactor, feature, ui, infra, security" });
      // Its label (brain/labels.ts): the Foreman's, else the words' guess.
      const labels = labelsFor({ task, kind: body.kind, size: body.size, review: body.review, routed: body.routed, role: body.role, doer: body.doer, files: stringList(body.files) });
      // No model named and Claude the Workers' engine: the router's pick for its label, so it keeps to its cost tier
      // (a bare Claude Worker starts on Claude Code's default, which is Opus).
      // Cobra's own Worker is routed whatever the Workers' engine, since only Claude gets the Space tools; with no pick, Sonnet, never Claude Code's Opus default.
      const routed = async () => routeTask({ text: task, kind: labels.kind, size: labels.size, files: stringList(body.files), project: await routedProject(parent) }, await routeFactsFor(parent)).pick ?? undefined;
      const chosen = model ?? (direct ? ((await routed()) ?? "sonnet") : engineFor("worker") === "claude" ? await routed() : undefined);
      if (direct) {
        const queued = loadQueue().filter((item) => item.state === "waiting" && item.project === parent.id && item.startedBy === "lead").map((item) => ({ id: item.id, task: item.task }));
        const refused = directSpawnRefusal({
          mode: mode ?? modeOf(parent),
          body,
          task,
          tools: workerToolNames(parent.foremanTemplate ?? "").length > 0,
          contained: io.direct?.contained?.() ?? (containEnabled() && containAvailable()),
          engine: parseModel(chosen).kind,
          live: [...liveDirect(await orchWorkerRecords(), await runningSessions(), parent.id), ...queued],
        });
        if (refused) return send(response, refused.status, { error: refused.error });
      }
      const outcome = await startOrQueue(
        parent,
        projects,
        {
          task,
          labels,
          ...(chosen !== undefined ? { model: chosen } : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(owner !== undefined ? { owner } : {}),
          ...(research ? { research } : {}),
          ...(spaceTools ? { spaceTools: true as const } : {}),
          ...(direct ? { startedBy: "lead" as const } : {}),
          queue: body.queue !== false,
        },
        io.caller,
        io.log,
      );
      if ("queued" in outcome) {
        const { requestedBy: _drop, ...item } = outcome.queued;
        return send(response, 202, { queued: item, position: outcome.position });
      }
      io.log(`worker ${outcome.started.id} spawned in ${parent.id} on ${outcome.started.branch}`);
      timeline.recordCount("worker-started", outcome.started.id, parent.id);
      const worker = await describeWorker(outcome.started, parent.name, await runningSessions());
      return send(response, 200, { worker });
    }

    if (route === "/orch/plan") {
      // plan_propose (plans.ts): a Foreman's plan, each task routed, to you as one approval.
      if (only === undefined) return send(response, 403, { error: "a Foreman proposes plans for its project; the Lead briefs the Foreman" });
      const project = (await inScope())[0];
      if (!project) return send(response, 404, { error: `no project ${only} here` });
      const input = parsePlan(body);
      if ("error" in input) return send(response, 400, { error: input.error });
      const facts = await routeFactsFor(project);
      const named = await routedProject(project);
      const routes = input.tasks.map((task) =>
        routeTask({ text: task.task, kind: task.kind, ...(task.size ? { size: task.size } : {}), files: task.files, project: named, ...(task.review ? { review: task.review } : {}) }, facts),
      );
      const plan = routedPlan({ id: project.id, name: project.name }, input, routes);
      if ("error" in plan) return send(response, 400, { error: plan.error });
      const approval = makeApproval({ kind: "plan", ...planText(plan), requestedBy: io.caller.id, plan }, Date.now());
      saveApprovals([...settle(loadApprovals(), Date.now()), approval]);
      io.log(`plan ${approval.id} for ${project.id}: ${plan.tasks.length} task(s)`);
      await io.notify(approval);
      return send(response, 200, { approval: approval.id, plan });
    }
    if (route === "/orch/brain/route") {
      // The router's advice for one task (brain/route.ts): read-only, for the Lead and the Foremen.
      const project = (await workScope()).find((candidate) => candidate.id === (text("project") ?? ""));
      if (!project) return send(response, 404, { error: `no project "${text("project") ?? ""}" on this computer` });
      const task = (text("task") ?? "").trim();
      if (!task) return send(response, 400, { error: "task is required" });
      const labels = labelsFor({ task, kind: body.kind, size: body.size, files: stringList(body.files) });
      const routed = routeTask(
        { text: task, kind: labels.kind, size: labels.size, files: stringList(body.files), project: await routedProject(project), ...(labels.review ? { review: labels.review } : {}) },
        await routeFactsFor(project),
      );
      return send(response, 200, { ...routed, guessedKind: labels.guessed === true });
    }
    if (route === "/orch/job") {
      const id = text("project") ?? "";
      const project = projectNamed(await inScope(), id);
      if (!project) return send(response, 404, { error: notHere(id) });
      const model = text("model");
      const started = Date.now();
      const result = await runJob(liveJobDeps(), project, { question: text("question") ?? "", ...(model !== undefined ? { model } : {}) });
      io.log(`job in ${project.id} on ${result.model}: ${Math.round((Date.now() - started) / 1000)}s`);
      return send(response, 200, { project: project.id, ...result });
    }
    if (route === "/orch/memory/ask") {
      try {
        const models = await (await import("./fallbacks.ts")).liveChain("memory-ask");
        // A Foreman's question is answered from a folder of only its own project's and company's memory.
        const scope = only === undefined ? null : { computer: computerName(), onlyKey: await keyOf(only) };
        const answer = await askMemory((cwd, args, input, timeoutMs) => liveEaRun(cwd, "memory-ask")(args, input, timeoutMs), MEMORY_DIR, text("question") ?? "", models, scope);
        return send(response, 200, { answer });
      } catch (caught) {
        const status = (caught as { status?: number }).status;
        if (status) return send(response, status, { error: (caught as Error).message });
        throw caught;
      }
    }
    if (route === "/orch/notify") {
      // Only the Lead on this computer: the top of the chain is the one that tells you (notifyPolicy.ts).
      if (!isLead || only !== undefined) return send(response, 403, { error: "only the Lead on this computer notifies the person" });
      if (!io.tell) return send(response, 503, { error: "notifications are not set up on this computer" });
      const asked = (text("project") ?? "").trim();
      const project = asked ? (await inScope()).find((candidate) => candidate.id === asked) : undefined;
      if (asked && !project) return send(response, 404, { error: `no project "${asked}" here: give its id from the status tool, or leave it out` });
      const refused = await io.tell({ title: text("title"), text: text("text"), ...(project ? { project: { id: project.id, path: project.path, session: project.session } } : {}) });
      if (refused) return send(response, refused.status, { error: refused.error });
      return send(response, 200, { sent: true });
    }
    // A research run (webRuns.ts): the Lead here or a Foreman declares one goal, judged once.
    if (route === "/orch/web/run") {
      if (!isLead) return send(response, 403, { error: "only the Lead and the Foremen research the web here" });
      const { liveWebRunDeps, startResearch } = await import("./webRuns.ts");
      const deps = io.webRuns ?? liveWebRunDeps({ approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) }, notify: io.notify, tell: tellLine, decided: io.decided ?? (() => undefined), log: io.log });
      const who = only === undefined ? ({ role: "lead" } as const) : ({ role: "foreman", project: only } as const);
      const outcome = await startResearch(deps, who, io.caller.id, body);
      return send(response, outcome.status, outcome.body);
    }
    if (route === "/orch/ask") {
      const session = await askSession();
      if (typeof session !== "string") return send(response, session.status, { error: session.error });
      const input = parseAsk(body);
      if ("error" in input) return send(response, 400, { error: input.error });
      const ask = askPerson(session, only ?? "lead", input);
      io.log(`ask: ${session} asked the person (${ask.id})`);
      return send(response, 200, { id: ask.id });
    }
    if (route === "/orch/memory/remember") {
      // Lessons come from the Lead or a Foreman, and say which.
      if (!isLead) return send(response, 403, { error: "the Lead and the Foremen hand lessons to memory" });
      // A note from a conversation that read text from outside is kept, and says so wherever it is read later (taint.ts, memory.ts sourceOf).
      const outside = taintOf(who) !== null;
      const from = sourceOf(only === undefined ? "lead" : "foreman", outside);
      // An on-call Foreman's handoff note (onCall.ts): its own project's, in its Space's memory, at most HANDOFF_WORDS words.
      if (text("kind") === "handoff") {
        if (only === undefined || io.caller.worker !== undefined) return send(response, 403, { error: "a handoff note is an on-call Foreman's, for its own project" });
        const project = (await inScope()).find((candidate) => candidate.id === only);
        if (!project) return send(response, 404, { error: `no project "${only}" here` });
        const mode = modeOf(project);
        if (mode.mode !== "on-call" || !mode.space) return send(response, 409, { error: `a handoff note is for an on-call Foreman, and ${mode.why}: remember a decision, gotcha or preference instead` });
        const note = (text("text") ?? "").trim();
        const refused = handoffRefusal(note);
        if (refused) return send(response, 400, { error: refused });
        const now = Date.now();
        const path = writeHandoffNote(MEMORY_DIR, computerName(), mode.space, project.id, note, now, outside);
        onCall.handoffWritten(project.id, now);
        const sync = liveMemorySync(io.log);
        if (sync) void withMemoryLock(() => sync.push(`memory: ${computerName()} keeps ${project.id}'s handoff note`)).catch((caught: unknown) => io.log(`memory: push failed: ${String(caught)}`));
        return send(response, 200, { handoff: true, space: mode.space, path, words: wordCount(note), ...(outside ? { markedOutside: true } : {}) });
      }
      // A lesson for the whole company goes into its brain (companyBrain.ts): here when this computer holds it, else pending for the Lead's computer.
      if (text("scope") === "company") {
        const own = readIndexes(MEMORY_DIR, computerName())[0] ?? null;
        const org = orgForMemory();
        const companyOfKey = (key: string) => own?.entries.find((entry) => entry.key === key)?.company?.id;
        let id: string | undefined;
        if (only !== undefined) id = companyOfKey(await keyOf(only));
        else {
          const named = text("company")?.trim();
          const asked = text("project")?.trim();
          id = named || (asked ? companyOfKey(asked.includes("/") ? asked : await keyOf(asked)) : undefined);
        }
        const company = org?.companies.find((candidate) => candidate.id === id);
        if (!company) return send(response, 404, { error: only !== undefined ? `${only} is in no company: remember it for the project instead` : "name the company (its id from org_read) or one of its projects" });
        if (company.sensitive && !own?.entries.some((entry) => entry.company?.id === company.id)) {
          return send(response, 409, { error: `${company.name} is sensitive: its brain is on the computer its projects run on, so memory_remember with that computer` });
        }
        const result = rememberForCompany(
          MEMORY_DIR,
          computerName(),
          { id: company.id, name: company.name, sensitive: company.sensitive === true },
          memoryHome(),
          { kind: text("kind") ?? "", text: text("text") ?? "", from },
          memoryDay(Date.now()),
        );
        if ("error" in result) return send(response, result.status, { error: result.error });
        const sync = liveMemorySync(io.log);
        if (result.added && sync) void withMemoryLock(() => sync.push(`memory: ${computerName()} remembers for ${company.name}`)).catch((caught: unknown) => io.log(`memory: commit failed: ${String(caught)}`));
        return send(response, 200, { company: company.id, ...result });
      }
      const asked = (text("project") ?? "").trim();
      let key: string;
      const project = (await inScope()).find((candidate) => candidate.id === asked);
      if (project) key = await projectKeyFor(project);
      else if (only === undefined && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(asked)) key = asked;
      else return send(response, 404, { error: only === undefined ? `no project "${asked}" here: give its id from the status tool, or its owner/repo` : `a Foreman remembers for ${only} only` });
      const replaces = text("replaces")?.trim();
      const result = rememberLesson(MEMORY_DIR, computerName(), key, {
        kind: text("kind") ?? "",
        text: text("text") ?? "",
        from,
        ...(replaces ? { replaces } : {}),
      });
      if ("error" in result) return send(response, result.status, { error: result.error });
      // Out to the other computers now, rather than at the next round-up; it never holds up the answer.
      const sync = liveMemorySync(io.log);
      if ((result.added || result.replaced) && sync) void withMemoryLock(() => sync.push(`memory: ${computerName()} remembers for ${key}`)).catch((caught: unknown) => io.log(`memory: push failed: ${String(caught)}`));
      return send(response, 200, { key, ...result, ...(outside ? { markedOutside: true } : {}) });
    }
    if (route === "/orch/action/propose") {
      // Only a Foreman, for its own project: the exact content becomes an approval, and the agent carries it out after your Allow.
      if (only === undefined) return send(response, 403, { error: "only a project's Foreman proposes an action, with action_propose; the Lead briefs the Foreman" });
      const project = (await inScope()).find((candidate) => candidate.id === only);
      if (!project) return send(response, 404, { error: `no project "${only}" here` });
      const now = Date.now();
      const current = settle(loadApprovals(), now);
      let action: ApprovalAction;
      if (typeof body.channel === "string" && body.channel.trim().toLowerCase() === MAILBOX_CHANNEL) {
        // Organizing the person's mail: only a trade that organizes mail, and the batch is worked out and frozen now, so the card shows exactly the messages Allow changes.
        if (!tradeOrganizes(project.foremanTemplate)) return send(response, 403, { error: `${project.name}'s trade (${project.foremanTemplate ?? "none"}) does not organize the person's mail, so this Foreman has no mailbox channel` });
        // The Space's own mailbox (Settings → Mailboxes), over IMAP (boxMail.ts). Cobra reaches no other: it has no Google connection of its own.
        const box = (io.boxOf ?? boxOfProject)(project);
        if (!box && !io.mailbox) return send(response, 409, { error: NO_MAILBOX, problem: "mailbox" });
        const resolve =
          io.mailbox ??
          (async (request: MailboxRequest, remaining: number) => {
            try {
              return await resolveBoxBatch(box!, request, remaining);
            } catch (caught) {
              if (caught instanceof MailboxError) throw new SessionError(caught.message, caught.status);
              throw caught;
            }
          });
        action = await parseMailboxAction(body, project, resolve, Math.max(0, MAILBOX_DAILY - mailboxToday(current, now)));
        io.log(`mailbox ${box?.id ?? "(test)"}: ${action.mailbox?.op} ${action.mailbox?.ids.length} messages proposed for ${project.id}`);
      } else {
        // A file action names one of the local export folders in files.json; the key, label and path go onto the card.
        action = parseAction(body, project, (await loadFilesConfig(process.env.COBRA_FILES_CONFIG ?? DEFAULT_FILES_CONFIG)).exports);
        // An email goes from the Space's own mailbox (Settings → Mailboxes): frozen on the card, which shows From. With none there is nothing to send from, said now and not at Allow.
        if (action.channel === "email" && action.email) {
          const box = (io.mailboxOf ?? mailboxOfProject)(project);
          if (!box) return send(response, 409, { error: NO_MAILBOX, problem: "mailbox" });
          action = { ...action, email: { ...action.email, from: box } };
        }
      }
      // The same card twice is one question; two pay stubs with one summary are two.
      const print = actionFingerprint(action);
      const same = current.find((a) => a.kind === "action" && a.state === "pending" && a.action !== undefined && actionFingerprint(a.action) === print);
      if (same) return send(response, 409, { error: `"${same.title}" with this same content already waits for the person (approval ${same.id}); approval_status shows it` });
      // Trusted (actionTrust.ts): it runs now, as an Allow would, and lands as a receipt; nothing waits for the person.
      // Never in a tainted turn (taint.ts): what it read may have planted what it sends, so it is a card whatever trust says.
      const taint = taintOf(who);
      const run = io.trust && !taint ? trustedApproval(io.trust.deps, action, io.caller.id) : null;
      if (run && io.trust) {
        saveApprovals([...current, run]);
        io.log(`approval ${run.id}: ${run.title} runs on trust for ${io.caller.id} (${action.channel})`);
        io.trust.carryOut(run);
        return send(response, 202, { approval: publicView(run), trusted: true });
      }
      const made = makeApproval({ kind: "action", ...actionText(action), requestedBy: io.caller.id, action }, now);
      const approval = taint ? stampTaint(made, who, taint) : made;
      saveApprovals([...current, approval]);
      await io.notify(approval);
      io.log(`approval ${approval.id}: ${approval.title} proposed by ${io.caller.id} (${action.channel})`);
      return send(response, 202, { approval: publicView(approval) });
    }
    if (route === "/orch/merge/request") {
      const ids = Array.isArray(body.workers) ? body.workers.filter((id): id is string => typeof id === "string") : [];
      if (ids.length === 0 || ids.length > 10) return send(response, 400, { error: "workers is a list of 1 to 10 Worker ids" });
      const plain = plainWhat(body.plain);
      const wanted: Array<{ repo: string; number: number; worker: string }> = [];
      const landing: LandWanted[] = [];
      const checked = new Map<string, GreenCheck>();
      for (const id of ids) {
        const extra = await scopedWorker(id);
        // A Worker Cobra started herself never opens a PR or merges (directWorkers.ts): its work went through the Space tools.
        if (startedByLead(extra)) return send(response, 409, { error: `${id} was started by Cobra for a light task: it never opens a PR or merges` });
        // A change to a website someone else coded goes to the person only on the website card, with its screenshots, and never merges on green.
        if (only !== undefined && extra.parent !== only) return send(response, 409, { error: `${id} changed the website someone else coded: ask the person with site_publish {worker: "${id}"}, which shows them the preview` });
        // The same Worker seen from the site's own project: its Website Builder asks for it, never this Foreman.
        if (only !== undefined && extra.worker?.owner && extra.worker.owner !== only) return send(response, 409, { error: `${id} was started by ${extra.worker.owner}, which asks the person for it` });
        // A coded site's Worker (codedSite.ts): its PR goes live and merges only through the website card.
        const home = (await registered(io.configPath)).find((candidate) => candidate.id === extra.parent);
        if (home?.foremanTemplate === WEBSITE_BUILDER && isCoded(home.path)) return send(response, 409, { error: `${id} changed ${home.name}'s coded website: site_preview {worker: "${id}"}, then ask the person with site_publish {worker: "${id}"}; their Allow puts it live and merges it` });
        const phase = await readPhase(extra.id);
        // Finished in a project with no remote: its branch lands into local main.
        if (phase?.local) {
          landing.push({ worker: id, project: extra.parent, path: extra.path, branch: extra.branch, local: phase.local });
          continue;
        }
        const pr = phase?.pr;
        const repo = pr ? /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.url)?.[1] : undefined;
        if (!pr || !repo) return send(response, 409, { error: `${id} has no PR yet; finish it first` });
        // The person is asked only once the local check vouches for the work.
        const check = phase?.check;
        if (check?.state === "pending" || isCheckRunning(id)) return send(response, 409, { error: `${id}'s local check is still running; wait for its [cobra] line` });
        if (check && check.state !== "success") return send(response, 409, { error: `${id}'s local check ${check.state === "failure" ? "failed" : "could not run"}: ${check.description}. worker_read ${id} shows why` });
        wanted.push({ repo, number: pr.number, worker: id });
        const onGreen = (await io.mergeOnGreen?.({ id: extra.parent, path: extra.path }, { repo, head: check?.sha ?? "", local: extra.localModel !== undefined || (extra.worker?.model.startsWith("local:") ?? false) }).catch(() => false)) ?? false;
        checked.set(id, { sha: check?.sha ?? "", green: check?.state === "success", onGreen });
      }
      const prs = wanted.length ? await mergeCandidates(liveMergeDeps(), wanted) : [];
      const lands = await landCandidates(landing);
      // Merge on green: when every project here allows it and each
      // PR's local check passed on the very head being merged, it merges now and you are told after.
      // Anything else (a land, a check of an older head, a project that does not allow it) asks you.
      const capped = io.mergeCapLeft?.() === false;
      if (capped) io.log(`merge on green: today's cap is reached, so ${io.caller.id}'s merge asks you`);
      // Taint always asks (taint.ts): a merge asked for in a tainted turn, or of a Worker that read text from outside (or was started by an orchestrator that had), is a card.
      const tainted = firstTaint(taintOf, [who, ...ids.map((id) => `worker:${id}`)]);
      if (tainted && !capped && mergesOnGreen(prs, lands.length, checked)) io.log(`merge on green: ${tainted.session} had read text from outside, so ${io.caller.id}'s merge asks you`);
      if (!capped && !tainted && mergesOnGreen(prs, lands.length, checked)) {
        const asked = makeApproval({ kind: "merge", ...landText(prs, [], plain), requestedBy: io.caller.id, prs }, Date.now());
        const merged = await runMerge(liveMergeDeps(), asked);
        saveApprovals([...settle(loadApprovals(), Date.now()), merged]);
        const ok = (merged.results ?? []).filter((result) => result.ok).length;
        // The Foreman has its answer in this reply: the PR watch must not tell it again (prNews.ts).
        await keepMerged(
          { phase: (id) => readPhase(id), writePhase: (id, phase) => writePhase(id, phase), now: Date.now },
          prs.filter((pr) => merged.results?.some((result) => result.ok && result.number === pr.number)),
        ).catch(() => undefined);
        io.log(`merge on green by ${io.caller.id}: ${(merged.results ?? []).map((result) => result.message).join("; ")}`);
        const landed = prs.filter((pr) => merged.results?.some((result) => result.ok && result.number === pr.number));
        // What went live, in the person's words (docs/voice.md): no PR numbers; the log above keeps them.
        const published = publishedText(prs, ok, ok === prs.length ? plain : undefined);
        const entry = landed.length
          ? io.decided?.({
            kind: "merge",
            title: publishedText(landed, landed.length, ok === prs.length ? plain : undefined).title,
            body: [publishedText(landed, landed.length).body, "Its tests passed, so it went live without asking you."].join("\n"),
            approval: merged.id,
            undo: { kind: "merge", prs: landed.map((pr) => ({ repo: pr.repo, number: pr.number })) },
          })
          : undefined;
        await io
          .announce?.(
            published.title,
            published.body,
            merged.id,
            entry || undefined,
          )
          .catch(() => undefined);
        return send(response, 200, { approval: publicView(merged), merged: true });
      }
      const card = makeApproval(
        {
          kind: lands.length ? "land" : "merge",
          ...landText(prs, lands, plain),
          requestedBy: io.caller.id,
          ...(prs.length ? { prs } : {}),
          ...(lands.length ? { lands } : {}),
        },
        Date.now(),
      );
      const approval = tainted ? stampTaint(card, tainted.session, tainted.taint) : card;
      saveApprovals([...settle(loadApprovals(), Date.now()), approval]);
      await io.notify(approval);
      io.log(`approval ${approval.id}: ${approval.title} asked by ${io.caller.id}`);
      return send(response, 200, { approval: publicView(approval) });
    }

    const extra = await scopedWorker(body.id);
    // The Lead's key reaches only her own direct Workers, on her own computer (directWorkers.ts).
    if (isLead && only === undefined && LEAD_WORKER_ROUTES.has(route)) {
      const home = (await registered(io.configPath)).find((candidate) => candidate.id === extra.parent);
      const refused = directControlRefusal(route, extra, home ? modeOf(home) : { mode: "standing", space: null, why: `${extra.parent} is not on this computer` });
      if (refused) return send(response, refused.status, { error: refused.error });
    }
    if (route === "/orch/worker/discard") {
      // Throwing work away is yours to decide, never the Lead's.
      if (io.caller.kind === "lead") return send(response, 403, { error: "a Lead cannot discard a Worker" });
      const projects = await workScope();
      await discardWorker(
        liveDiscardDeps((parent) => projects.find((project) => project.id === parent)?.path ?? null),
        extra,
      );
      io.log(`worker ${extra.id} discarded: worktree and ${extra.branch} removed`);
      return send(response, 200, { ok: true });
    }
    // Words from a tainted turn into a Worker carry the taint for the rest of its run (taint.ts).
    if ((route === "/orch/worker/send" || route === "/orch/worker/handoff") && taintOf(who)) taintWorker(extra.id, who);
    if (route === "/orch/worker/handoff") {
      // Planner → doer (workers.ts handoffWorker): the planner's branch goes to the doer's model, same Worker.
      const projects = await workScope();
      const parent = projects.find((project) => project.id === extra.parent);
      if (!parent) return send(response, 404, { error: `project ${extra.parent} is not on this computer` });
      const model = text("model");
      const task = text("task");
      const handed = await handoffWorker(liveHandoffDeps(io.log), extra, parent, projects, { ...(model ? { model } : {}), ...(task ? { task } : {}) });
      io.log(`worker ${extra.id}: handed from ${extra.worker?.model} to ${handed.extra.worker?.model}`);
      const worker = await describeWorker(handed.extra, parent.name, await runningSessions());
      return send(response, 200, { worker });
    }
    if (route === "/orch/worker/send") {
      // A Worker the agent stopped once its work was done starts again in its worktree, its PR kept (sessionKeeper.ts).
      if (isRested(extra.id) && !(await runningSessions()).has(extra.session)) {
        const projects = await workScope();
        const parent = projects.find((project) => project.id === extra.parent);
        if (!parent) return send(response, 404, { error: `project ${extra.parent} is not on this computer` });
        await wakeWorker(liveWorkerDeps(io.log), extra, parent, projects, text("text") ?? "");
        clearRested(extra.id);
        io.log(`worker ${extra.id} woken by ${io.caller.id}`);
        return send(response, 200, { ok: true, woke: true });
      }
      requireRunning(extra, await runningSessions(), await readPhase(extra.id));
      await sendToWorker(extra, text("text") ?? "");
      return send(response, 200, { ok: true });
    }
    if (route === "/orch/worker/deny") {
      requireRunning(extra, await runningSessions(), await readPhase(extra.id));
      await denyForWorker(extra);
      return send(response, 200, { ok: true });
    }
    if (route === "/orch/worker/stop") {
      requireRunning(extra, await runningSessions(), await readPhase(extra.id));
      await stopWorker(extra);
      await markStopped(extra.id);
      io.log(`worker ${extra.id} stopped; its worktree stays`);
      return send(response, 200, { ok: true });
    }
    if (route === "/orch/worker/import") {
      // worker_import: files the Worker's sandbox cannot read, copied in only on the person's Allow (workerImport.ts).
      const parent = (await workScope()).find((project) => project.id === extra.parent);
      if (!parent) return send(response, 404, { error: `project ${extra.parent} is not on this computer` });
      const now = Date.now();
      try {
        const imports = await planImport(liveImportDeps(importSources()), extra.parent, { id: extra.id, path: extra.path }, body.files);
        const approval = makeApproval({ kind: "import", ...importText(imports, parent.name), requestedBy: io.caller.id, imports }, now);
        saveApprovals([...settle(loadApprovals(), now), approval]);
        await io.notify(approval);
        io.log(`approval ${approval.id}: ${approval.title} asked by ${io.caller.id}`);
        return send(response, 202, { approval: publicView(approval) });
      } catch (caught) {
        if (caught instanceof ImportError) return send(response, caught.status, { error: caught.message });
        throw caught;
      }
    }
    if (route === "/orch/worker/check") {
      // check_run: the local check of the Worker's current head, again.
      const phase = await readPhase(extra.id);
      if (!phase?.pr) return send(response, 409, { error: `${extra.id} has no PR yet; finish it first (that starts its check)` });
      const started = startWorkerCheck(liveWorkerCheckDeps(io.log), extra, liveWorkerScope(extra.id));
      return send(response, 200, { ok: true, started: started.started, ...(started.started ? {} : { why: "its check is already running" }) });
    }
    // /orch/worker/finish
    // Cobra's own Worker opens no PR, whoever finishes it: finishing it ends its session, and its work stays in the journal and the cards.
    if (startedByLead(extra)) {
      if ((await runningSessions()).has(extra.session)) await stopWorker(extra);
      io.log(`worker ${extra.id}: finished by ${io.caller.id}; a Worker Cobra started opens no PR`);
      return send(response, 200, { ok: true, ended: true });
    }
    // Another engine's review first, where the Worker's label asks for one or it runs on a local model (review.ts, phase 3).
    const review = reviewForced(extra, onLocalModel(extra));
    if (review.forced && (body.skipReview !== true || !review.skippable)) {
      if (body.skipReview === true) io.log(`worker ${extra.id}: runs on a local model, so its review is not skipped`);
      const held = await reviewFirst(extra, io.configPath, io.log);
      if (held) return send(response, held.status, held.status === 202 ? { review: "started", by: held.by, message: held.error } : { error: held.error });
    } else if (body.skipReview === true && review.forced) {
      io.log(`worker ${extra.id}: finished without its review, as its owner asked`);
    }
    const title = text("title");
    const prBody = text("body");
    const finished = await finishWorker(liveFinishDeps(), extra, {
      ...(title !== undefined ? { title } : {}),
      ...(prBody !== undefined ? { body: prBody } : {}),
    });
    if ("local" in finished) {
      io.log(`worker ${extra.id}: ready to land ${extra.branch} at ${finished.local.head.slice(0, 7)} into local main`);
      return send(response, 200, { ok: true, local: finished.local });
    }
    const pr = finished;
    io.log(`worker ${extra.id}: ${pr.created ? "opened" : "found"} PR #${pr.number}`);
    if (pr.created) timeline.recordCount("pr-opened", pr.url, extra.parent, undefined, title ?? extra.title);
    // Its head is checked here, in the background: the PR shows cobra/local-check.
    const check = startWorkerCheck(liveWorkerCheckDeps(io.log), extra, liveWorkerScope(extra.id));
    return send(response, 200, { ok: true, pr, check: check.started ? "started" : "running" });
  } catch (caught) {
    if (caught instanceof SessionError) return send(response, caught.status, { error: caught.message });
    throw caught;
  }
}

/** The live deps of a Designer's routes (designer.ts), from this agent's registry, org, approvals and thread. */
/** What a `site` card's Allow needs (index.ts, settleSite). */
export function liveSiteSettleDeps(configPath: string): Parameters<typeof settleSite>[1] {
  const deps = liveSiteDeps({ configPath, notify: async () => {}, log: () => {} });
  return { grant: deps.grant, fetch: deps.fetch, github: deps.github, stateDir: deps.stateDir, project: deps.project, place: deps.place, now: deps.now, merge: (repo, number, head) => liveMergeDeps().merge(repo, number, head) };
}

/** A Worker as the website routes need it: its project, who started it, its PR and its local check. */
async function siteWorker(id: string): Promise<{ id: string; parent: string; owner: string | null; pr?: { number: number; url: string }; check?: { state: string; sha: string; description: string }; checking: boolean } | null> {
  const extra = (await orchWorkerRecords()).find((record) => record.id === id);
  if (!extra) return null;
  const phase = await readPhase(extra.id);
  return {
    id: extra.id,
    parent: extra.parent,
    owner: extra.worker?.owner ?? null,
    ...(phase?.pr ? { pr: phase.pr } : {}),
    ...(phase?.check ? { check: { state: phase.check.state, sha: phase.check.sha, description: phase.check.description } } : {}),
    checking: isCheckRunning(extra.id),
  };
}

function liveSiteDeps(io: { configPath: string; notify: (approval: StoredApproval) => Promise<void>; log: (line: string) => void }): SiteDeps {
  const designer = liveDesignerDeps(io);
  const outsideGithub = liveOutsideGithub(
    (repo, number, head) => liveMergeDeps().merge(repo, number, head),
    (repo, number) => liveMergeDeps().readPr(repo, number),
  );
  return {
    project: designer.project,
    place: designer.place,
    images: async (project, folders) => [...designerImages(project), join(folders.base, "designs"), ...(await companyFolders(project))].filter((dir) => existsSync(dir)).map((dir) => realpathSync(dir)),
    brand: (project, space) => {
      const folder = designerFolders(project, space).brand;
      return existsSync(join(folder, "brand.json")) ? folder : null;
    },
    grant: () => cloudflareHere().grant(),
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(60_000) }),
    build: liveBuild,
    lint: liveLint,
    check: liveCheck,
    approvals: designer.approvals,
    notify: io.notify,
    github: liveSiteGithub(),
    // A website someone else coded (outsideSite.ts): the company's projects, GitHub through gh, the Worker records, a browser.
    outside: {
      sisters: async (project) => {
        const all = await registered(io.configPath);
        const paths = new Set(foremanCompany(project, all, orgForMemory(), os.hostname(), (id) => spaceDir(id)).sisters.map((sister) => sister.path));
        return all.filter((candidate) => candidate.id !== project.id && paths.has(candidate.path));
      },
      github: outsideGithub,
      worker: siteWorker,
      shoot: liveShoot,
      makeApproval: (input, now) => makeApproval(input, now),
    },
    // A coded site (codedSite.ts): built in Cobra's sandbox, its code in the project's own GitHub repository.
    coded: {
      build: (input) => containedBuild(input, liveCodedDeps()),
      head: async (path) => {
        // refs/heads/main, not main: refs/main and refs/tags/main come first, and a Worker can write those.
        const main = await safeGit(path, ["rev-parse", "--verify", "refs/heads/main^{commit}"]);
        if (main.code !== 0) throw new SiteError(409, `${path} has no main to build: ${main.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
        return main.stdout.trim();
      },
      repo: (path) => outsideGithub.repoOf(path),
      worker: siteWorker,
      readPr: (repo, number) => liveMergeDeps().readPr(repo, number),
      start: (input) =>
        startCoded(input, {
          git: (cwd, args) => safeGit(cwd, args),
          createRemote: async (name, cwd) => {
            const gh = await findGh();
            if (!gh) throw new Error("gh is not installed on this computer");
            return createRemote(gh, name, cwd);
          },
        }),
      contained: () => containMode(),
      git: (cwd, args, options) => safeGit(cwd, args, options ?? {}),
      openPr: async (repo, branch, title, body) => {
        const gh = await findGh();
        if (!gh) throw new SiteError(409, "gh is not installed on this computer");
        // From /, with the repository named: gh never runs git in the project itself.
        const made = await new Promise<{ code: number | null; out: string }>((done) => {
          execFile(gh, ["pr", "create", "-R", repo, "--head", branch, "--base", "main", "--title", title, "--body", body], { cwd: "/", timeout: 60_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (error, stdout, stderr) =>
            done({ code: error ? 1 : 0, out: `${stdout}\n${stderr}` }),
          );
        });
        const url = /https:\/\/github\.com\/\S+\/pull\/(\d+)/.exec(made.out);
        if (made.code !== 0 || !url) throw new SiteError(502, `The edit is pushed on ${branch}, but its PR could not be opened: ${made.out.trim().split("\n").slice(-1)[0] ?? ""}`);
        return { number: Number(url[1]), url: url[0] };
      },
      work: join(STATE_DIR, "site-builds"),
    },
    stateDir: STATE_DIR,
    random: () => randomBytes(2).toString("hex"),
    log: io.log,
    now: () => Date.now(),
  };
}

function liveDesignerDeps(io: { configPath: string; notify: (approval: StoredApproval) => Promise<void>; log: (line: string) => void; thread?: DesignerDeps["thread"] }): DesignerDeps {
  return {
    project: async (id) => (await registered(io.configPath)).find((project) => project.id === id),
    place: (project) => {
      const org = orgForMemory();
      const company = org?.seats[seatKey(os.hostname(), project.id)]?.company;
      const name = org?.companies.find((candidate) => candidate.id === company)?.name ?? project.name;
      const space = company ? spaceDir(company) : undefined;
      return { name, ...(space && project.path.startsWith(`${space}/`) ? { space } : {}) };
    },
    images: (project) => designerImages(project),
    // The site its company keeps here: a Space's own website folder, else the folder of a Website Builder in the same company.
    website: async (project) => {
      const projects = await registered(io.configPath);
      const company = foremanCompany(project, projects, orgForMemory(), os.hostname(), (id) => spaceDir(id));
      if (company.space) return { dir: join(company.space, "website") };
      const builder = projects.find((other) => other.foremanTemplate === WEBSITE_BUILDER && company.sisters.some((sister) => sister.path === other.path));
      if (builder) return { dir: join(builder.path, "website") };
      return { none: "No Website Builder works for this company on this computer, so there is no website to give the concept to. Tell Cobra, who can add one." };
    },
    approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) },
    notify: io.notify,
    thread: io.thread ?? (() => ({ notHub: "Cobra's thread is not kept on this computer" })),
    log: io.log,
    now: () => Date.now(),
    ...(() => {
      const bin = findTessel();
      return bin ? { conceptCode: tesselExport(bin) } : {};
    })(),
  };
}
