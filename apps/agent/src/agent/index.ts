import { lookForConnectors } from "./connectors.ts";
import http from "node:http";
import os from "node:os";
import { homedir } from "node:os";
import { createReadStream, readFileSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  Answer,
  Health,
  OrchForeman,
  OrchWorker,
  Project,
  SystemStats,
  ThreadEntry,
} from "@cobra/contracts";

import { authorize, bearer } from "./auth.ts";
import { keyRoute } from "./keyRoutes.ts";
import { encodeJson } from "./compress.ts";
import { config } from "./config.ts";
import { collectCpu, primeCpu } from "./collect/cpu.ts";
import { collectMemory } from "./collect/memory.ts";
import { collectDisks } from "./collect/disk.ts";
import { collectNetwork } from "./collect/net.ts";
import { collectThermal } from "./collect/thermal.ts";
import { collectPower, setLidAwake } from "./collect/power.ts";
import { collectTmux, paneIdentity } from "./collect/tmux.ts";
import { mintTicket } from "./tickets.ts";
import { collectProjects, DEFAULT_CONFIG_PATH } from "./collect/projects.ts";
import { collectRepos } from "./collect/repos.ts";
import { createProject, liveCreateDeps } from "./create.ts";
import { allTrades, knownTrade, unknownTemplateError } from "./trades.ts";
import { liveTradeDeps, settleTradeApproval } from "./tradeRoutes.ts";
import { liveSpecialistDeps, setByPerson, settleSpecialistApproval } from "./specialistRoutes.ts";
import { SPECIALIST_MODELS, specialistViews } from "./specialists.ts";
import { seatKey } from "../../../../packages/contracts/src/org.ts";
import { liveMorningDeps, loadLatest, loadSettings, morningTick, parseSettings, saveSettings, sendsHere } from "./morning.ts";
import { findGh, ghAuth, listRepos } from "./github.ts";
import { settleBrand } from "./designer.ts";
import { settleSite } from "./site.ts";
import { createThreadStore, NEW_CONVERSATION, type ThreadSource } from "./thread.ts";
import { waitForThread, waitMs } from "./threadWait.ts";
import { dropHandoff, writeHandoff } from "./handoff.ts";
import { onThreadRead } from "./digest.ts";
import { makeHandoff, shouldRotate } from "./leadRotation.ts";
import { liveHandoffDeps, rotationFactsHere } from "./leadRotationLive.ts";
import { loadRegistry, removeLocal } from "./registry.ts";
import { runSessionAction, SESSION_ACTIONS, SESSION_NAME, SessionError } from "./sessions.ts";
import { dispatch, liveDeps, loadDispatchConfig, READY_TIMEOUT_MS, resolve } from "./dispatch.ts";
import { GITHUB_TOKEN_ROUTE, githubHandoff } from "./mcp.ts";
import { installLogRedaction, sentBody } from "./secretValues.ts";
import { auditRoute } from "./auditRoutes.ts";
import { onAuditFailure } from "./auditTrail.ts";
import { LOCAL_RECIPIENT, sendPush, type PushMessage, type Recipient } from "./push.ts";
import { KEY_EXPIRES_HEADER, mintForeman, mintLead, type Caller } from "./keys.ts";
import { createRateLimiter } from "./rateLimit.ts";
import { liveSources } from "./modelSources.ts";
import { foremanLineName, LEAD_LINE, oldComputerFiles, OrchLines, useOrchLines } from "./orchSocket.ts";
import { readEvents, recordEvents } from "./events.ts";
import { notices } from "./notices.ts";
import { leadNotice, markHandled } from "./notifyPolicy.ts";
import { liveNewSessionDeps, liveTidyDeps, loadExtras, startExtra, tidyExtras } from "./extras.ts";
import { LOCAL_MODEL_NAME, localModels } from "./localModels.ts";
import { localStatus, offers, readChecks, requestCheck } from "./localCheck.ts";
import { OLLAMA, ollamaTagList, sameModel, type Fetch } from "./ollama.ts";
import { isPi, OWNER_YOU, piRequest, piTranscriptFile, piTranscriptReply, piView, readPiTranscript } from "./pi.ts";

/** Whether a local model starts on Pi on this computer: Pi pinned, and Cobra's sandbox running (Pi never runs outside it). */
function piReady(): boolean {
  return piHarness() !== null && containEnabled() && containAvailable();
}

function piUnavailable(): string {
  if (!piHarness()) return "Pi is not installed on this computer (install it, e.g. mise use -g pi, then run install.sh again)";
  return "Pi runs only in Cobra's sandbox, which this computer does not run";
}
import { startWatcher } from "./watcher.ts";
import { explainedRequest, liveExplainer, PUSH_WAIT_MS } from "./permissionRequest.ts";
import { attachDirtyStore, cachedMergedHeads, cachedPrs, parkRepo, refreshGithub, resumeRepo, startGitSync, syncRepo } from "./gitsync.ts";
import { prList } from "./prs.ts";
import { checkedOutBranches, closePr, commonDir, deleteBranch, HEAD_SHA, mergePr, readBranches, tidyRows } from "./repo.ts";
import { collectUnits } from "./collect/units.ts";
import { readPrivateFile, removePrivateFile, writePrivateFile } from "./private.ts";
import { collectUsage } from "./collect/usage.ts";
import {
  ALERTS_PATH,
  type Condition,
  compose as composeAlert,
  evaluate,
  loadAlertState,
  saveAlertState,
  serializeAlertState,
  step,
} from "./alerts.ts";
import { DEFAULT_HISTORY_PATH, openStore } from "./history.ts";
import { startRecorder } from "./recorder.ts";
import { collectCommands } from "./collect/skills.ts";
import { claudeHooksInstalled, findCodexTranscript, readCodexTranscript, readTranscript, transcriptForPane } from "./transcript.ts";
import { CODEX_SESSIONS_DIR, orchestratorCodexSessionName, projectCodexSessionName } from "./codexSessions.ts";
import { defaultProjectLaunch, orchestratorRole, startedOn, type SessionEngine } from "./sessionHarness.ts";
import { changeEngines, readEngines, recordedEngine, recordSessionEngine, writeEngines } from "./engines.ts";
import { changeFolders, readFolders, writeFolders } from "./folders.ts";
import { answerAsk, askingOf, overlayAsk, pendingAsk } from "./asks.ts";
import { remoteShown } from "./codexAsks.ts";
import { catalog } from "./brain/catalog.ts";
import { readBrain, writeBrain } from "./brain/rules.ts";
import { codexModelsHere } from "./brain/codexModels.ts";
import { acceptBrain, brainView } from "./brain/view.ts";
import { capturePane, readPane } from "./collect/pane.ts";
import { askedFor, readAsked, readHookRecords } from "./hooks.ts";
import { DEFAULT_FILES_CONFIG, loadFilesConfig } from "./files.ts";
import { ensureTmuxConf, TMUX_SOCKET } from "./tmuxHost.ts";
import { browseRoots, disposition, FILE_HEADERS, mimeFor, openFile } from "./browse.ts";
import { ATTACH_MAX_BYTES, saveAttachment } from "./attachments.ts";
import { isAgentCommand } from "./collect/commands.ts";
import { listMerged, readCommits, windowStart } from "./worklog.ts";
import { allMoney, liveAllMoneyDeps } from "./allMoney.ts";
import { eaArgs, liveEaRun, liveIndex, startEa } from "./ea.ts";
import { answerOrchWeb, liveOrchWebDeps, noteConnectorRead, parseOrchWho } from "./orchWeb.ts";
import { answerAfter, liveClaimDeps } from "./webClaims.ts";
import { dueForJudge, judgeUnanswered, refusedImportNews } from "./unanswered.ts";
import { startGate } from "./gate.ts";
import { acceptable, CAPABILITY_WORDS, describeChange, FLOOR_WORDS, mayChange, PRESET_TITLES, readChanges, readPolicyFile, writePolicy } from "./policyEdit.ts";
import { HARD_CAPS, loadPolicy, loadRoles, modelAllowed, PRESETS, resolvePolicy, resolveRoles, type PresetName } from "./permissions.ts";
import { BLOCKLIST_RULE, readPolicyLog } from "./policy.ts";
import { BLOCKLIST_WORDS } from "./blocklist.ts";
import { computerName, MEMORY_DIR, projectKeyFor } from "./memory.ts";
import { readScope as readAllowScope } from "./allowScopes.ts";
import { loadDecided, recentDecided, recordDecided, undoDecided, undoLabel, underCap, DAILY_CAPS, capOf, receiptCategory, type Decided, type DecidedUndo } from "./decided.ts";
import { liveUndoDeps, seatCompany } from "./decidedLive.ts";
import { loadRuns, runsView, saveRuns, settleWebRunApproval, stopRun } from "./webRuns.ts";
import { actsAlone, liveDeployReader, mergeDeploys, mergeOnGreenAt, projectOf as projectOfApproval, receiptWords, writtenMergeOnGreen } from "./instinctActs.ts";
import { callerOfAs, takeTurn } from "./usageLedger.ts";
import { CLAUDE_TOKEN_PATH, claudeToken, liveProxyDeps, resumeWorkerProxies, stopAllWorkerProxies, writeLimits } from "./workerProxy.ts";
import { containAvailable, containedWorker, containEnabled, containLayout, containMode, containSetting, harness, piHarness, PROBE_EVERY_MS, reprobeContain, sandboxTool } from "./contain.ts";
import { drainQueue, handleOrch, liveSiteSettleDeps, ORCH_ROUTES, routerBudget, startPlan } from "./orch.ts";
import { runSpaceTool, setSpaceRunner } from "./workerSpace.ts";
import { chooseModels, planNews } from "./plans.ts";
import { finishes, liveFinishTickDeps, tellLine, TICK_MS as FINISH_TICK_MS, type FinishTickDeps } from "./finishes.ts";
import { endGone, noteRead, ownerWho, setTurnProbe } from "./taint.ts";
import { liveTurnProbe } from "./taintTurns.ts";
import { personCause, waking, wakes, withWake } from "./wakes.ts";
import { AFRESH_LINE, liveOnCallSpace, needsOfState, onCall, ROTATE_LINE, WRAP_LINE, type Needs } from "./onCall.ts";
import { lastContextTokens } from "./leadRotationLive.ts";
import { keepMerged, livePrNewsDeps, startPrNews, tellApproval } from "./prNews.ts";
import { settleLink, SITE_LINK } from "./outsideSite.ts";
import { answer as answerApproval, loadApprovals, publicView, runLand, runMerge, saveApprovals, settle, writeLapsed, type StoredApproval } from "./approvals.ts";
import { actionNews, liveActionDeps, runAction } from "./actions.ts";
import { liveDbDeps } from "./dbRoutes.ts";
import { markDocumentsSent } from "./sentFiles.ts";
import { receiptNotice } from "./actionTrust.ts";
import { afterAnswer, handleTrustPerson, liveTrustDeps, PERSON_TRUST_POSTS, PERSON_TRUST_ROUTES, settleTrustCard, trustedApproval } from "./trustRoutes.ts";
import { liveMcpDeps, loginCache, mcpConnect, mcpDisconnect, mcpStatus, mcpToggle, mcpVerifyRequest, readAccount, runMcpVerify } from "./mcpRoutes.ts";
import { handlePerson, livePersonDeps, PERSON_KINDS, PERSON_POSTS, PERSON_ROUTES } from "./personRoutes.ts";
import { handleNotebook, NOTEBOOK_ROUTES, TICKS_PATH } from "./notebook.ts";
import { CLOUDFLARE_ROUTES, cloudflareHere, handleCloudflare } from "./cloudflare.ts";
import { openProjectDb, spaceDataPath } from "./db.ts";
import { STATE_DIR } from "./paths.ts";
import { liveFetchJson, priceSpaces, type PriceDeps } from "./prices.ts";
import { PULL_EVERY_MS, sitePuller, type PullNotice } from "./sitePull.ts";
import { FORM_LINKS_DIR, formPuller, settleFormApproval } from "./formLinks.ts";
import { listSpaces, readSpace, seatFor, seatOf, SPACES_DIR } from "./spaces.ts";
import { handleSpaceForemen, SPACE_FOREMEN_ROUTE } from "./spaceForemen.ts";
import { cardOwner } from "./directWorkers.ts";
import { SPACE_SCHEMA } from "./trades/space.ts";
import { handleMailboxes, MAILBOX_ROUTES } from "./mailboxRoutes.ts";
import { handleMarketing, MARKETING_POSTS, MARKETING_ROUTES } from "./marketing.ts";
import { EDITOR_POSTS, EDITOR_ROUTES, handleBatchEdit, handleEmailEditor, handleEmailPerson, PERSON_EMAIL_ROUTES, settleTemplateApproval } from "./emailRoutes.ts";
import { draftsIn, editDraftLive, emailInFlight, liveEmailRouteDeps, marketingDeps, queueBatch, queueBranded, queueCampaign, queueFor, spaceById, startEmailSender, startSequenceLive, themePlace } from "./emailLive.ts";
import { handleOrgPerson, liveOrgDeps, loadOrg, PERSON_ORG_ROUTES, settleOrgApproval, type OrgDeps } from "./orgRoutes.ts";
import { settleSpaceApproval } from "./spaceCreate.ts";
import { liveBoardDeps, settleBoardApproval, snapshotSpaces } from "./spaceBoards.ts";
import { startRates } from "./fxLive.ts";
import { settleBudgetApproval } from "./budgetCard.ts";
import { chooseSkips, proposeBillsCard, settleBillsApproval } from "./billsCard.ts";
import { findBillsIn, findBillsWeekly, type FinderDeps } from "./billFinder.ts";
import { addReceipt, chooseAccounts, liveRead, settleExpensesApproval, startReading, type ReceiptDeps } from "./receipts.ts";
import { addStatement, livePdfText, PDF_SYSTEM, readStatement, READ_TIMEOUT_MS as STATEMENT_READ_TIMEOUT_MS, STATEMENT_MAX_BYTES, type StatementDeps } from "./statements.ts";
import { subscriptionHeld } from "./subscriptionHeld.ts";
import { liveSpaceDeps } from "./spaceLive.ts";
import { handleRoutinePerson, liveRoutineDeps, liveTickDeps, PERSON_ROUTINE_POSTS, PERSON_ROUTINE_ROUTES, settleRoutineApproval } from "./routineRoutes.ts";
import { fileStore, startRoutines, type TickDeps } from "./routines.ts";
import { liveMergeDeps } from "./workers.ts";
import { importNews, importsText, liveImportDeps, runImport } from "./workerImport.ts";
import { importSources } from "./workerImportSources.ts";
import { LEAD_SESSION, leadHome, leadRunning, leadSetUp, newLeadConversation, startLead, stopLead, tmuxHas } from "./lead.ts";
import { alertText, markSent, newThresholds, readAlerts, saveAlerts } from "./apiAlerts.ts";
import { laneFactsNow, laneState, nextMonthStart } from "./apiLane.ts";
import { accountsView, activeCodexCredential, addClaudeAccount, codexLoginStatus, codexRunning, removeAccount, saveLiveCodex, startCodexLogin, useAccount } from "./accounts.ts";
import { CODEX_BROKER_PORT, CODEX_UPSTREAMS, liveSessionForToken, startCodexBroker } from "./codexBroker.ts";
import { SUBSCRIPTION_LIMITS } from "./limits.ts";
import { keptTokenAt, laneStatus, onKeyNow, startModelGateway } from "./modelGateway.ts";
import { foremanRunning, foremanSession, newForemanConversation, setForemanRoom, startForeman, stopForeman, typeBrief } from "./foreman.ts";
import { closeCard, createKeeper, keepCloseCard, liveWaitsOn, loadOffered, markRested, saveOffered, stillIdle } from "./sessionKeeper.ts";
import { countVoiceCalls, liveBudget, loadActivity, saveActivity } from "./sessionBudget.ts";
import { createVoiceCalls, type HandOff, type VoiceCalls } from "./voiceFront.ts";
import { liveVoiceDeps, summarizeLate, VOICE_DIR } from "./voiceLive.ts";
import { createLateAnswers, type LateAnswers } from "./lateAnswer.ts";
import { LATE_ANSWER_CATEGORY } from "../../../../packages/contracts/src/voiceCall.ts";
import { VOICE_ROUTES, voiceRoute } from "./voiceRoutes.ts";
import { killTmuxSession, listTmuxSessions, loadSweep, PARKED_REPORT_MS, saveSweep, sweepDue, sweepPlan, sweepReport } from "./sessionSweep.ts";
import { changeCrew, CrewError, type CrewChange } from "./crew.ts";
import { headlessRequest, headlessTranscriptFile, headlessView, isHeadless, servePermission } from "./headlessWorkers.ts";
import { orchCwd, orchHeadless, orchLook, orchTranscriptFile } from "./orchHeadless.ts";
import { currentTestReport, testModeOf, testModeOn } from "./apiTest.ts";
import { liveNote as liveTestNote, liveOn as liveTestOn, switchTestMode } from "./testSwitch.ts";
import { sessionTranscriptFile } from "./workers.ts";
import { answeredRequest, closedWorkerRows, endMergedWorkers, grantForAllow, settleAnswer, headlessAction, liveLandDeps, liveLifecycleDeps, liveWorkerDeps, localRunning, localSlotsFull, pruneWorkerFiles, resumeTrustedCodexWorker, runningSessions, spawnWorker, workerRecords, stopWorker as endWorker } from "./workers.ts";
import { timeline } from "./timeline.ts";
import { loadQueue, pressures, waitingFor } from "./queue.ts";

const SERVICE = "cobra-agent";
// Every line the agent logs goes to the journal redacted: no secret value it holds, no token by its shape (secretValues.ts).
installLogRedaction();
// A record the audit log could not take is told once in the desk too; the action goes ahead (auditTrail.ts).
onAuditFailure((problem) => notices.record({ kind: "audit", projectId: "", title: "The audit log is not being written", body: problem }));
const startedAt = new Date();
/** The owner's Cloudflare connection here: its sign-in in progress and one refresh at a time (cloudflare.ts). */
const cloudflare = cloudflareHere((line) => console.log(`[${SERVICE}] ${line}`));

/**
 * History and alert state, owned here so the HTTP handlers and the sampling
 * loop read the same thing. COBRA_HISTORY exists for the same reason
 * COBRA_PUSH_TOKENS does: so a local agent can be exercised end to end without
 * writing into the real machine's store.
 */
const store = openStore(process.env.COBRA_HISTORY ?? DEFAULT_HISTORY_PATH);
// The Unpushed grace clock survives a restart (see attachDirtyStore).
attachDirtyStore(store);
// Kept across restarts (ALERTS_PATH), so an install does not push every
// standing alert again.
const alertState = loadAlertState(ALERTS_PATH, (line) => console.log(`[${SERVICE}] ${line}`));
let savedAlertState = serializeAlertState(alertState);
let lastConditions: Condition[] = [];
let lastCheckedAt: string | null = null;

async function kernelVersion(): Promise<string> {
  try {
    const raw = await readFile("/proc/sys/kernel/osrelease", "utf8");
    return raw.trim();
  } catch {
    return os.release();
  }
}

async function buildSystemStats(): Promise<SystemStats> {
  // Collectors are independent and all I/O-bound, so run them together rather
  // than serially: on a slow disk the difference is noticeable.
  const [cpu, memory, disks, network, thermal, kernel, power] = await Promise.all([
    collectCpu(),
    collectMemory(),
    collectDisks(),
    collectNetwork(),
    collectThermal(),
    kernelVersion(),
    collectPower(),
  ]);

  return {
    host: os.hostname(),
    kernel,
    uptimeSeconds: os.uptime(),
    capturedAt: new Date().toISOString(),
    cpu,
    memory,
    disks,
    network,
    thermal,
    power,
  };
}

/**
 * Rejected requests since the last sample, and where they landed.
 *
 * In memory on purpose: this is a rate alarm, and a counter that survived a
 * restart would report a burst that happened before the process existed. It
 * counts this agent only — the term-gateway is a separate process with its own
 * ticket failures, which it logs but does not share.
 */
/** Turned-away requests in one sampling window that earn a warning in the log. */
const REJECT_WARN_PER_SAMPLE = 10;
let rejects = 0;
const rejectRoutes = new Map<string, number>();

function noteRejection(route: string): void {
  rejects += 1;
  rejectRoutes.set(route, (rejectRoutes.get(route) ?? 0) + 1);
}

/** The busiest rejected route, for the alert body. */
function topRejectedRoute(): string | null {
  let top: string | null = null;
  let best = 0;
  for (const [route, count] of rejectRoutes) {
    if (count > best) {
      best = count;
      top = route;
    }
  }
  return top;
}

function buildHealth(): Health {
  return {
    ok: true,
    service: SERVICE,
    version: config.version,
    // The name this computer was given (`install.sh --name`), else its hostname;
    // `hostname` keeps the real one for anything that needs it.
    host: process.env.COBRA_MACHINE_NAME?.trim() || os.hostname(),
    hostname: os.hostname(),
    uptimeSeconds: process.uptime(),
    startedAt: startedAt.toISOString(),
  };
}

/** Bodies read ahead of their handler (kept for readRaw's callers). */
const readAhead = new WeakMap<http.IncomingMessage, Buffer>();

async function readRaw(request: http.IncomingMessage, limit: number): Promise<Buffer> {
  const ahead = readAhead.get(request);
  if (ahead) {
    if (ahead.length > limit) throw new Error("body too large");
    return ahead;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(request: http.IncomingMessage, limit = 4096): Promise<string> {
  return (await readRaw(request, limit)).toString("utf8");
}

async function handleTicket(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "POST only" });
  }
  let body: { session?: unknown; cwd?: unknown };
  try {
    body = JSON.parse(await readBody(request)) as typeof body;
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }

  const session = typeof body.session === "string" ? body.session : "";
  const cwd = typeof body.cwd === "string" && body.cwd.length > 0 ? body.cwd : homedir();

  if (!SESSION_NAME.test(session)) {
    return sendJson(response, 400, {
      error: "session must match [A-Za-z0-9._-]{1,64}",
    });
  }
  if (!cwd.startsWith("/")) {
    return sendJson(response, 400, { error: "cwd must be an absolute path" });
  }

  // A headless Worker has no tmux session: a terminal there would start a plain shell under its name,
  // which every "is it running" check would then count as the Worker (headlessWorkers.ts).
  if ((await loadExtras()).some((extra) => extra.session === session && extra.worker && isHeadless(extra.id))) {
    return sendJson(response, 409, { error: "this Worker runs headless: it has no terminal; open its conversation instead" });
  }
  if (orchHeadless(session)) {
    return sendJson(response, 409, { error: "this session runs headless in API test mode: it has no terminal; open its conversation instead" });
  }
  const { ticket, claims } = mintTicket(config.ticketKey, session, cwd);
  console.log(`[${SERVICE}] minted terminal ticket for session "${session}"`);
  return sendJson(response, 200, {
    ticket,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    session,
  });
}

/**
 * The one endpoint that changes a machine rather than describing it. Same
 * shape constraints as /ticket; the actions themselves live in sessions.ts.
 */
async function handleSession(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "POST only" });
  }

  // Checked by hand rather than with the zod schema: the agent runs with no
  // node_modules at all, so @cobra/contracts can only ever be imported as types.
  let body: {
    session?: unknown;
    action?: unknown;
    cwd?: unknown;
    answers?: unknown;
    text?: unknown;
    command?: unknown;
    args?: unknown;
    model?: unknown;
    makeDefault?: unknown;
    dialogKey?: unknown;
    scope?: unknown;
  };
  try {
    body = JSON.parse(await readBody(request, 16 * 1024)) as typeof body;
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  const session = typeof body.session === "string" ? body.session : "";
  const action = SESSION_ACTIONS.find((known) => known === body.action);
  const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
  const text = typeof body.text === "string" ? body.text : undefined;
  const command = typeof body.command === "string" ? body.command : undefined;
  const args = typeof body.args === "string" ? body.args : undefined;
  const model = typeof body.model === "string" ? body.model : undefined;
  // Enter on the model picker writes a machine-wide default, so it is opt-in
  // and only ever by an explicit true.
  const makeDefault = body.makeDefault === true;
  // The dialog an Allow was for (sessions.ts allowRefusal); a key that is not this dialog's is a 409.
  const dialogKey = typeof body.dialogKey === "string" ? body.dialogKey.slice(0, 128) : undefined;
  // What an Allow covers beyond this call (allowScopes.ts): once, task, project or always.
  const scope = readAllowScope(body.scope);
  const answers = readAnswers(body.answers);
  if (answers === null) {
    return sendJson(response, 400, {
      error: "answers must be [{question, option | options | text}]",
    });
  }
  if (!action) {
    return sendJson(response, 400, { error: `action must be one of ${SESSION_ACTIONS.join(", ")}` });
  }
  if (!SESSION_NAME.test(session)) {
    return sendJson(response, 400, {
      error: "session must match [A-Za-z0-9._-]{1,64}",
    });
  }
  if (cwd !== undefined && !cwd.startsWith("/")) {
    return sendJson(response, 400, { error: "cwd must be an absolute path" });
  }

  try {
    // The call a Worker's prompt was for, read before the answer goes in, while its dialog is still up.
    const answered = action === "approve" || action === "deny" ? await answeredRequest(session, dialogKey).catch(() => null) : null;
    // A contained Worker's network prompt: its hosts are granted before the Enter goes in (workers.ts grantForAllow).
    const undo = action === "approve" ? await grantForAllow(session, dialogKey).catch(() => () => {}) : () => {};
    try {
      // A headless Worker has no pane: its pipe and permission tool take the action (workers.ts headlessAction).
      const input = { cwd, answers, text, command, args, model, makeDefault, dialogKey };
      // A question the Lead or a Foreman asked through ask_person (asks.ts) is answered here, not on its screen.
      const asked = action === "answer" ? answerAsk(session, answers ?? []) : null;
      if (asked) finishes.tell(asked.owner, `The person answered your question ${asked.id}: read it with ask_wait ${asked.id}.`, "answer");
      else {
        // What the person types or answers wakes the session (wakes.ts, for the API ledger); other actions wake nothing.
        const cause = personCause(action);
        const act = async () => {
          if (!(await headlessAction(session, action, input))) await runSessionAction(action, session, input);
        };
        await (cause ? withWake(session, cause, undefined, act) : act());
      }
      // A contained Codex Worker cannot receive its first task until the
      // person has accepted Codex's own folder-trust screen.  This helper is
      // narrowly gated to that prior failure and replays only its saved task.
      if (action === "trust") {
        await resumeTrustedCodexWorker(session).catch((failed) => {
          console.log(`[cobra-agent] could not resume trusted Codex Worker ${session}: ${failed instanceof Error ? failed.message : String(failed)}`);
        });
      }
    } catch (failed) {
      undo();
      throw failed;
    }
    if (answered) settleAnswer(answered, action === "approve", scope);
    // A question you answered, for the charts' daily counts (timeline.ts).
    if (action === "approve" || action === "deny" || action === "answer") timeline.recordCount("answered", session);
  } catch (caught) {
    if (caught instanceof SessionError) {
      return sendJson(response, caught.status, { error: caught.message });
    }
    throw caught;
  }
  console.log(`[${SERVICE}] ${action} on session "${session}"`);
  return sendJson(response, 200, { ok: true, session, action });
}

/**
 * Mechanical git on this machine's own checkout: sync (fetch, then
 * fast-forward a clean main), park (commit everything to a wip/ branch and
 * push it), resume (check a parked branch out). The
 * repo is re-read before anything happens and a refusal is a 409 with its
 * reason, so a stale button on the phone is harmless.
 */
const GIT_ACTIONS = ["sync", "park", "resume", "delete-branch", "close-pr", "merge-pr"] as const;

/** gh's path, resolved once; null means the GitHub half of /git is unavailable here. */
let ghPath: Promise<string | null> | null = null;
function gh(): Promise<string | null> {
  ghPath ??= findGh();
  return ghPath;
}

/**
 * One repository in full for the repo screen: every branch with whether main
 * already holds it, and the open PRs listed fresh from gh (the timer's copy is
 * the fallback when gh is slow or away).
 */
async function handleGitRepo(url: URL, response: http.ServerResponse): Promise<void> {
  const id = url.searchParams.get("project") ?? "";
  const list = await collectProjects(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH);
  const project = list.projects.find((candidate) => candidate.id === id);
  if (!project) return sendJson(response, 404, { error: `no project "${id}" on this machine` });
  const git = project.git ?? null;
  const ghBin = await gh();
  let prs = null;
  let prError: string | null = null;
  if (!ghBin) prError = "gh is not installed on this machine";
  else if (!git?.remote) prError = "no GitHub remote";
  else {
    // Fresh from gh first, so the branch list below knows which tips were
    // squash-merged by a PR that closed a minute ago.
    prs = await refreshGithub(project.path, git.remote, ghBin);
    if (prs === null) {
      const cached = cachedPrs(project.path);
      prs = cached?.prs ?? null;
      prError = cached ? `gh did not answer; showing the list from ${cached.at}` : "gh did not answer";
    }
  }
  const branches = await readBranches(project.path, git, Date.now(), cachedMergedHeads(project.path));
  const { activity, lastActivityAt, command, attached, needsInput, dialog, tail, git: _g, sessionCreatedAt, windows, ...bare } = project;
  void activity; void lastActivityAt; void command; void attached; void needsInput; void dialog; void tail; void _g; void sessionCreatedAt; void windows;
  return sendJson(response, 200, { machine: os.hostname(), project: bare, git, branches, prs, prError, at: new Date().toISOString() });
}

/**
 * GET /prs: every repository's open PRs as git sync last read them (prs.ts).
 * The cache only: gh runs on the timer, never per request.
 */
async function handlePrs(response: http.ServerResponse): Promise<void> {
  const list = await collectProjects(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH);
  return sendJson(response, 200, prList(list.projects, cachedPrs, { ghFound: (await gh()) !== null, syncOn: gitSyncOn, machine: os.hostname() }));
}

/**
 * What was done in one repository since a time (worklog.ts): commits on every
 * branch, PRs merged on GitHub, and the moments this agent kept. For the
 * phone's "what have we done in X today?". Reads only.
 */
async function handleWorkLog(url: URL, response: http.ServerResponse): Promise<void> {
  const id = url.searchParams.get("project") ?? "";
  const list = await collectProjects(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH);
  const project = list.projects.find((candidate) => candidate.id === id);
  if (!project) return sendJson(response, 404, { error: `no project "${id}" on this machine` });
  const since = windowStart(url.searchParams.get("since"));
  const remote = project.git?.remote ?? null;
  const ghBin = await gh();
  const [{ commits, truncated }, merged] = await Promise.all([
    readCommits(project.path, since),
    ghBin && remote
      ? listMerged(ghBin, remote, since).then(
          (prs) => ({ prs, error: null }),
          () => ({ prs: null, error: "gh did not answer" }),
        )
      : Promise.resolve({ prs: null, error: ghBin ? "no GitHub remote" : "gh is not installed on this machine" }),
  ]);
  return sendJson(response, 200, {
    machine: os.hostname(),
    project: { id: project.id, name: project.name },
    since: new Date(since).toISOString(),
    commits,
    truncated,
    merged: merged.prs,
    prError: merged.error,
    events: readEvents(since).filter((event) => event.projectId === project.id),
  });
}

/**
 * GET /foreman?project=: whether its Foreman runs. POST /foreman/start,
 * /stop, /clear {project}. A phone's or desktop's key; the Lead opens one
 * with its first brief instead (/orch/foreman/brief, orch.ts).
 */
async function handleForeman(route: string, url: URL, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  let id = url.searchParams.get("project") ?? "";
  if (route !== "/foreman") {
    if (request.method !== "POST") return sendJson(response, 405, { error: "POST only" });
    try {
      id = String((JSON.parse(await readBody(request)) as { project?: unknown }).project ?? "");
    } catch {
      return sendJson(response, 400, { error: "invalid JSON body" });
    }
  }
  const { projects } = await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH);
  const project = projects.find((candidate) => candidate.id === id && candidate.machine === os.hostname());
  if (!project) return sendJson(response, 404, { error: `no project "${id}" on this machine` });
  try {
    if (route === "/foreman/start") {
      await startForeman(project);
      console.log(`[${SERVICE}] Foreman started for ${project.id}`);
    } else if (route === "/foreman/stop") {
      await stopForeman(project);
      console.log(`[${SERVICE}] Foreman stopped for ${project.id}`);
    } else if (route === "/foreman/clear") {
      // A fresh start, not /clear, so it has today's MCP servers (foreman.ts newForemanConversation).
      await newForemanConversation(project, config.port);
      console.log(`[${SERVICE}] Foreman for ${project.id}: new conversation`);
    }
  } catch (caught) {
    if (caught instanceof SessionError) return sendJson(response, caught.status, { error: caught.message });
    throw caught;
  }
  return sendJson(response, 200, { project: project.id, session: foremanSession(project), running: await foremanRunning(project) });
}

/**
 * POST /crew {project, name?, look?}: rename a project's Foreman (a name, or
 * null for the one it would be given) or draw it a new look ("next", "reset").
 * A phone's or desktop's key; the Foreman itself has no say (crew.ts).
 */
async function handleCrew(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (request.method !== "POST") return sendJson(response, 405, { error: "POST only" });
  let body: { project?: unknown; name?: unknown; look?: unknown };
  try {
    body = JSON.parse(await readBody(request)) as typeof body;
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  const change: CrewChange = {};
  if (body.name !== undefined) {
    if (body.name !== null && typeof body.name !== "string") return sendJson(response, 400, { error: "name is a string or null" });
    change.name = body.name;
  }
  if (body.look !== undefined) {
    if (body.look !== "next" && body.look !== "reset") return sendJson(response, 400, { error: 'look is "next" or "reset"' });
    change.look = body.look;
  }
  const { projects } = await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH);
  const project = projects.find((candidate) => candidate.id === String(body.project ?? "") && candidate.machine === os.hostname());
  if (!project) return sendJson(response, 404, { error: `no project "${String(body.project ?? "")}" on this machine` });
  try {
    const crew = changeCrew(project, change);
    console.log(`[${SERVICE}] Foreman for ${project.id} is ${crew.name} (look ${crew.look})`);
    return sendJson(response, 200, { project: project.id, crew });
  } catch (caught) {
    if (caught instanceof CrewError) return sendJson(response, caught.status, { error: caught.message });
    throw caught;
  }
}

/** A trade's name as the person reads it, for a specialist with no title of its own (specialists.ts). */
const tradeName = (id: string): string | undefined => allTrades().find((trade) => trade.id === id)?.name;

/**
 * The roster (specialists.ts): GET /specialists lists every Foreman here with
 * its name, title, instructions and model; POST /specialists/set is the
 * person's own change from the desk, so it asks for no card.
 */
async function handleSpecialists(route: string, request: http.IncomingMessage, response: http.ServerResponse, caller: Caller): Promise<void> {
  if (caller.kind !== "desk") return sendJson(response, 403, { error: "only the desk app you linked reads and changes the specialists" });
  const { projects } = await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH);
  const here = projects.filter((project) => project.machine === os.hostname());
  if (route === "/specialists") {
    if (request.method !== "GET") return sendJson(response, 405, { error: "GET only" });
    const org = loadOrg();
    const companyOf = (project: { id: string }) => {
      const seat = org.seats[seatKey(os.hostname(), project.id)];
      const company = seat && !seat.retired ? org.companies.find((candidate) => candidate.id === seat.company) : undefined;
      return company ? { id: company.id, name: company.name } : undefined;
    };
    return sendJson(response, 200, { specialists: specialistViews(here, tradeName, { companyOf }), models: [...SPECIALIST_MODELS] });
  }
  if (request.method !== "POST") return sendJson(response, 405, { error: "POST only" });
  let body: { id?: unknown };
  try {
    body = JSON.parse(await readBody(request, 64 * 1024)) as typeof body;
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  const project = here.find((candidate) => candidate.id === String(body.id ?? ""));
  if (!project) return sendJson(response, 404, { error: `no specialist "${String(body.id ?? "")}" on this computer` });
  const outcome = setByPerson(project, body, `person:${caller.id}`);
  if (outcome.status === 200) console.log(`[${SERVICE}] specialist ${project.id} changed by the person`);
  return sendJson(response, outcome.status, outcome.body);
}

/** A new approval reaches every phone: Allow and Deny on the lock screen. */
/**
 * A push that needs no answer: something Cobra did for you under your policy
 * (a merge on green). No category, so no Allow or Deny on the lock screen.
 */
async function announce(title: string, body: string, approval: string, decided?: Decided): Promise<void> {
  const tokens = await loadPushTokens();
  if (tokens.length === 0) return;
  // A receipt of something Cobra did carries its Stop or Undo to the lock screen (decided.ts receiptCategory).
  const category = decided ? receiptCategory(decided.undo) : undefined;
  const outcome = await push(tokens, {
    title,
    body,
    ...(category ? { category } : {}),
    data: { machine: os.hostname(), approval, kind: "merge", ...(category && decided ? { decided: decided.id } : {}) },
  });
  for (const error of outcome.errors) console.log(`[${SERVICE}] push ticket: ${error}`);
  for (const token of outcome.dead) await dropPushToken(token);
}

/**
 * The Lead's own notification (notify_person): what the chain under it cannot
 * settle without you. Pushed plainly, and kept for the desk like the
 * watcher's (notices.ts). It opens the project it names, else the Lead.
 */
let lastLeadNotice: number | null = null;
// Whether the Lead's session runs, read on each finish tick: a briefed Foreman reports to it only while it does.
let leadUp = true;
void leadRunning().then((up) => {
  leadUp = up;
});
/** Whether this computer writes the morning brief (morning.ts sendsHere). */
function sendsMorning(): boolean {
  return sendsHere(leadSetUp(), leadUp, process.env.COBRA_MORNING);
}

/** My Organization's deps (orgRoutes.ts): org.json here, kept for the fleet where the morning brief is written (the Lead's computer). */
function orgDeps(): OrgDeps {
  return liveOrgDeps({ home: sendsMorning, approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) }, notify: notifyApproval, tell: tellLine, log: (line) => console.log(`[${SERVICE}] ${line}`) });
}
/** What follows a write to a Space's store: nothing now. The modules keep the hook so a follow-up has one place to go. */
const noFollowUp = (_space: string): void => undefined;

/** Receipts scanned on the phone (receipts.ts): read here, proposed in the Space's Money, one card to allow. */
function receiptDeps(): ReceiptDeps {
  return {
    spacesRoot: SPACES_DIR,
    open: (space) => openProjectDb(`space-${space}`, SPACE_SCHEMA),
    read: liveRead,
    approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) },
    notify: notifyApproval,
    stored: noFollowUp,
    log: (line) => console.log(`[${SERVICE}] ${line}`),
    now: Date.now,
  };
}
/** Statements dropped on the Finance tab (statements.ts): a PDF is read by Haiku on this computer's own sign-in, never the API key. */
function statementDeps(): StatementDeps {
  const run = liveEaRun(undefined, "statements", false);
  return {
    spacesRoot: SPACES_DIR,
    open: (space) => openProjectDb(`space-${space}`, SPACE_SCHEMA),
    pdfText: livePdfText,
    readPdf: async (part) => {
      if (await subscriptionHeld()) throw new Error("the subscription is at its hold: send a CSV, or try the PDF later");
      return run(eaArgs("haiku", PDF_SYSTEM), `<statement>\n${part}\n</statement>`, STATEMENT_READ_TIMEOUT_MS);
    },
    stored: receiptDeps().stored,
    log: (line) => console.log(`[${SERVICE}] ${line}`),
  };
}
/** Cobra's bill finder (billFinder.ts): each family Space's Money seat, its store, and the card. */
function billFinderDeps(): FinderDeps {
  const statePath = join(STATE_DIR, "bill-finder.json");
  return {
    spaces: () => listSpaces().filter((space) => space.kind === "family").flatMap((space) => {
      const money = seatFor(space.id, "money");
      return money ? [{ id: space.id, money }] : [];
    }),
    open: (space) => openProjectDb(`space-${space}`, SPACE_SCHEMA),
    proposed: (project, db, batch, by) => proposeBillsCard({
      ...receiptDeps(),
      space: (seated) => {
        const seat = seatOf(seated);
        const record = seat ? readSpace(seat.space) : null;
        return record ? { id: record.id, name: record.name } : null;
      },
      open: () => db,
      tell: tellLine,
    }, project, db, batch, by),
    load: () => {
      try {
        return JSON.parse(readFileSync(statePath, "utf8")) as Record<string, number>;
      } catch {
        return {};
      }
    },
    save: (state) => writePrivateFile(statePath, `${JSON.stringify(state)}\n`),
    log: (line) => console.log(`[${SERVICE}] ${line}`),
    now: Date.now,
  };
}
/** After the person allows a bank import: a family Space's finder reads it now rather than at the week's end. */
function billsAfterImport(project: string): void {
  const seat = seatOf(project);
  const space = seat ? readSpace(seat.space) : null;
  const money = space?.kind === "family" ? seatFor(space.id, "money") : null;
  if (!space || !money) return;
  void findBillsIn(billFinderDeps(), space.id, money).catch((caught: unknown) => console.log(`[${SERVICE}] bills: ${space.id}: ${caught instanceof Error ? caught.message : String(caught)}`));
}
/** Opening a Space's deps (spaceCreate.ts, spaceLive.ts): this computer's org, registry, folders and brain. */
function spaceDeps() {
  return liveSpaceDeps({ approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) }, notify: notifyApproval, tell: tellLine, log: (line) => console.log(`[${SERVICE}] ${line}`) });
}
/** Whether a project's Foreman reports to Cobra now: she briefed it and she runs (notifyPolicy.ts Briefed). */
const cobraAnswers = (project: string): boolean => leadUp && finishes.isBriefed(project);
/**
 * A page a Foreman Cobra briefed read that is not what it claims (webClaims.ts): she hears of it, as she would its question.
 * A Worker's flag reaches her in its Foreman's report, as its other findings do.
 */
function claimTeller(who: string, site: string, why: string): void {
  const project = who.startsWith("foreman:") ? who.slice("foreman:".length) : null;
  if (!project || !cobraAnswers(project)) return;
  finishes.tell("lead", `The Foreman for ${project} read ${site}, which is not what it claims (${why}): nothing from it counts as checked.`);
}
async function tellPerson(input: {
  title?: string;
  text?: string;
  project?: { id: string; path: string; session: string };
}): Promise<{ status: number; error: string } | null> {
  const checked = leadNotice(input, lastLeadNotice, Date.now());
  if ("error" in checked) return checked;
  lastLeadNotice = Date.now();
  const opens = input.project ?? { id: LEAD_SESSION, path: leadHome(), session: LEAD_SESSION };
  notices.record({ kind: "lead", projectId: opens.id, session: opens.session, title: checked.title, body: checked.body });
  threadNotice(checked.title, checked.body);
  const tokens = await loadPushTokens();
  if (tokens.length === 0) return null;
  const outcome = await push(tokens, {
    title: checked.title,
    body: checked.body,
    data: { machine: os.hostname(), projectId: opens.id, session: opens.session, path: opens.path },
  });
  console.log(`[${SERVICE}] pushed "${checked.title}" for the Lead as a desktop notification`);
  for (const error of outcome.errors) console.log(`[${SERVICE}] push ticket: ${error}`);
  for (const token of outcome.dead) await dropPushToken(token);
  return null;
}

/** Routines' routes, live (routineRoutes.ts). */
function routineDeps() {
  return liveRoutineDeps({
    configPath: process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH,
    port: config.port,
    notify: notifyApproval,
    tell: tellLine,
    log: (line) => console.log(`[${SERVICE}] ${line}`),
    // Run now in an on-call Space goes by the same rule as the tick (onCall.ts).
    onCall: { onCall: (project) => liveOnCallSpace(project), asleep: (project) => keeper.isAsleep(project), direct: routineWorker, log: (line) => console.log(`[${SERVICE}] ${line}`) },
  });
}

/** A routine run skipped or failed (routines.ts): told to the person once, kept for the desk and pushed. */
async function routineNotice(notice: Parameters<TickDeps["notifyOnce"]>[0]): Promise<void> {
  // A tap opens the project, as the Lead's own notification does.
  const project = (await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH).catch(() => ({ projects: [] as Project[] }))).projects.find(
    (candidate) => candidate.id === notice.routine.project && candidate.machine === os.hostname(),
  );
  const opens = { projectId: notice.routine.project, session: project?.session ?? notice.routine.project, path: project?.path ?? "" };
  notices.record({ kind: "routine", projectId: opens.projectId, session: opens.session, title: notice.title, body: notice.body });
  threadNotice(notice.title, notice.body);
  const tokens = await loadPushTokens();
  if (tokens.length === 0) return;
  const outcome = await push(tokens, { title: notice.title, body: notice.body, data: { machine: os.hostname(), ...opens } });
  for (const error of outcome.errors) console.log(`[${SERVICE}] push ticket: ${error}`);
  for (const token of outcome.dead) await dropPushToken(token);
}

async function notifyApproval(approval: StoredApproval): Promise<void> {
  const tokens = await loadPushTokens();
  if (tokens.length === 0) return;
  const outcome = await push(tokens, {
    title: approval.title,
    body: approval.body,
    category: "approval",
    data: { machine: os.hostname(), approval: approval.id, kind: approval.kind },
  });
  for (const error of outcome.errors) console.log(`[${SERVICE}] push ticket: ${error}`);
  for (const token of outcome.dead) await dropPushToken(token);
}

/**
 * GET /decided?days= (at most 14): what Cobra decided without you, newest
 * first, each with its Undo's words (or none and why), and how much of each
 * daily cap is used. POST /decided/undo {id}: that Undo, once.
 */
async function handleDecided(route: string, url: URL, request: http.IncomingMessage, response: http.ServerResponse, caller: Caller): Promise<void> {
  if (caller.kind !== "desk") return sendJson(response, 403, { error: "only the desk app you linked reads what Cobra did" });
  if (route === "/decided") {
    if (request.method !== "GET") return sendJson(response, 405, { error: "GET only" });
    const days = Math.min(14, Math.max(1, Number(url.searchParams.get("days") ?? 7) || 7));
    const all = loadDecided();
    const now = Date.now();
    const used = (cap: "merge" | "cards") => all.filter((entry) => capOf(entry.kind) === cap && now - Date.parse(entry.at) < 24 * 60 * 60_000).length;
    return sendJson(response, 200, {
      decided: recentDecided(all, now, days).map((entry) => ({ ...entry, undoLabel: undoLabel(entry.undo), ...(entry.undo.kind === "none" ? { noUndo: entry.undo.why } : {}), ...(entry.undo.kind === "web-run" ? { run: entry.undo.run } : {}) })),
      caps: { merge: { used: used("merge"), cap: DAILY_CAPS.merge }, cards: { used: used("cards"), cap: DAILY_CAPS.cards } },
    });
  }
  if (request.method !== "POST") return sendJson(response, 405, { error: "POST only" });
  let body: { id?: unknown };
  try {
    body = JSON.parse((await readBody(request)) || "{}") as { id?: unknown };
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  if (typeof body.id !== "string") return sendJson(response, 400, { error: "id is required" });
  const outcome = await undoDecided(body.id, liveUndoDeps(tellLine, (line) => console.log(`[${SERVICE}] ${line}`)));
  if (outcome.entry) console.log(`[${SERVICE}] undid ${outcome.entry.title}: ${outcome.entry.undoNote}`);
  else console.log(`[${SERVICE}] undo of ${body.id} refused (${outcome.status}): ${outcome.error}`);
  return sendJson(response, outcome.status, outcome.entry ? { decided: outcome.entry } : { error: outcome.error });
}

/** What Undo does for an approval Cobra allows (decided.ts), from what it is about to change. */
function undoFor(approval: StoredApproval): DecidedUndo {
  if (approval.kind === "plan") return { kind: "plan", approval: approval.id };
  if (approval.kind === "routine" && approval.routine) return { kind: "routine", project: approval.routine.project, name: approval.routine.name };
  if (approval.kind === "org" && approval.org) return { kind: "org", seat: approval.org.seat, company: seatCompany(approval.org.seat) };
  if (approval.kind === "trade") return { kind: "none", why: "Nothing uses the trade until you hire a Foreman for it." };
  return { kind: "none", why: "There is nothing here to undo." };
}

/** Whether Instinct is in force for a project here (by its id), or for this computer (null). */
async function instinctAt(projectId: string | null): Promise<boolean> {
  const where: { computer: string; project?: string } = { computer: computerName() };
  if (projectId) {
    const project = (await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH)).projects.find((entry) => entry.id === projectId);
    if (project) where.project = await projectKeyFor(project).catch(() => undefined);
  }
  return loadPolicy(where).escalate;
}

/**
 * What a new approval from the Lead or a Foreman does (handleOrch's notify):
 * under Instinct a low-stakes kind (instinctActs.ts actsAlone) is allowed by
 * Cobra herself, exactly as your Allow would, and lands as a receipt with no
 * buttons; anything else reaches your phone as before. A failure to act
 * leaves the card for you.
 */
async function notifyOrAct(approval: StoredApproval): Promise<void> {
  const projectId = projectOfApproval(approval);
  const instinct = await instinctAt(projectId).catch(() => false);
  const why = actsAlone(approval, () => instinct);
  if (!why) return notifyApproval(approval);
  // A bad day stays small (decided.ts DAILY_CAPS): past the cap, the card is yours again.
  if (!underCap(loadDecided(), approval.kind)) {
    console.log(`[${SERVICE}] approval ${approval.id}: Instinct's daily cap is reached; asking you`);
    return notifyApproval(approval);
  }
  try {
    // Where an org move came from, read before it moves, so Undo can move it back.
    const undo = undoFor(approval);
    const done = await answerAndApply(approval.id, true, undefined, Date.now(), "cobra");
    console.log(`[${SERVICE}] approval ${approval.id} ${why}: ${approval.title}`);
    const words = receiptWords(done, why);
    const opens = projectId ?? LEAD_SESSION;
    const entry = recordDecided({ kind: approval.kind, title: words.title, body: words.body, approval: approval.id, ...(projectId ? { project: projectId } : {}), undo });
    notices.record({ kind: "receipt", projectId: opens, session: opens, title: words.title, body: words.body });
    await announce(words.title, words.body, approval.id, entry);
  } catch (caught) {
    console.log(`[${SERVICE}] approval ${approval.id}: Instinct could not allow it (${caught instanceof Error ? caught.message : String(caught)}); asking you`);
    await notifyApproval(approval);
  }
}

/**
 * A card nobody answered (unanswered.ts): under Instinct, one that can be
 * undone goes to the judge after its wait. Its allow is Cobra's Allow, kept
 * in What Cobra did with its Undo; its refusal is Cobra's Deny, and the
 * Foreman hears why; an escalation leaves the card for you. Each card is put
 * to the judge once.
 */
let unansweredBusy = false;
async function judgeUnansweredCards(): Promise<void> {
  if (unansweredBusy) return;
  unansweredBusy = true;
  try {
    // Cards that lapsed are written down now, so the audit log has each lapse near its time (auditTrail.ts).
    writeLapsed(Date.now());
    for (const approval of dueForJudge(settle(loadApprovals(), Date.now()), Date.now())) {
      if (!underCap(loadDecided(), approval.kind)) continue;
      const verdict = await judgeUnanswered(approval, {
        taskOf: async (worker) => (await loadExtras()).find((extra) => extra.id === worker)?.worker?.task ?? null,
        policy: async (card) => {
          const projectId = projectOfApproval(card);
          if (!(await instinctAt(projectId))) return null;
          const project = projectId ? (await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH)).projects.find((entry) => entry.id === projectId) : undefined;
          return loadPolicy({ computer: computerName(), ...(project ? { project: await projectKeyFor(project) } : {}) });
        },
        judge: async (input, config, mode) => {
          const live = await import("./judge.ts");
          return live.judge(input, config, live.liveJudgeDeps, mode);
        },
      });
      if (!verdict) continue;
      const judged = { at: new Date().toISOString(), verdict: verdict.verdict, reason: verdict.reason };
      // Marked first: whatever happens next, it is not judged again.
      saveApprovals(loadApprovals().map((a) => (a.id === approval.id ? { ...a, judged } : a)));
      console.log(`[${SERVICE}] approval ${approval.id} unanswered; the judge (${verdict.by}) said ${verdict.verdict}: ${verdict.reason}`);
      if (verdict.verdict === "escalate" || !approval.imports) continue;
      const imports = approval.imports;
      if (verdict.verdict === "refuse") {
        const { approval: denied, list } = answerApproval(loadApprovals(), approval.id, false, Date.now());
        saveApprovals(list);
        if (denied.state === "denied") finishes.tell(imports.project, refusedImportNews(approval.id, imports, verdict.reason), "event", "decision");
        continue;
      }
      try {
        const done = await answerAndApply(approval.id, true, undefined, Date.now(), "cobra");
        const copied = imports.files.filter((file) => done.results?.some((result) => result.ok && result.message === `${file.to}: copied`));
        const why = `Nobody answered, and Cobra's judge allowed it: ${verdict.reason}`;
        const title = `Cobra did: ${approval.title}`.slice(0, 120);
        const body = `${approval.body.split("\n").slice(0, 6).join("\n")}\n\n${why}`.slice(0, 1200);
        const entry = recordDecided({
          kind: "import",
          title,
          body,
          approval: approval.id,
          project: imports.project,
          undo: copied.length ? { kind: "import", project: imports.project, worker: imports.worker, files: copied.map((file) => ({ to: file.to, sha256: file.sha256 })) } : { kind: "none", why: "Nothing was copied." },
        });
        notices.record({ kind: "receipt", projectId: imports.project, session: imports.project, title, body });
        await announce(title, body, approval.id, entry);
      } catch (caught) {
        console.log(`[${SERVICE}] approval ${approval.id}: Cobra could not allow it (${caught instanceof Error ? caught.message : String(caught)}); it waits for you`);
      }
    }
  } finally {
    unansweredBusy = false;
  }
}

/** Trust (actionTrust.ts, trustRoutes.ts), live. */
function trustDeps() {
  return liveTrustDeps({
    approvals: { load: loadApprovals, save: saveApprovals },
    notify: notifyApproval,
    tell: tellLine,
    log: (line) => console.log(`[${SERVICE}] ${line}`),
  });
}

/**
 * Carries out an allowed action (actions.ts runAction), in the background:
 * after your Allow, or at once when it runs on trust. The Foreman hears how it
 * went; a trusted run lands as a receipt (kept for the desk and pushed, no
 * buttons), and an answered one counts toward trust (actionTrust.ts), which
 * Cobra proposes at the third clean run.
 */
/** Who hears what became of a card: Cobra for one her own direct Worker made (directWorkers.ts), else the owner named (its Foreman). */
function cardTell(approval: Pick<StoredApproval, "byLeadWorker">): (owner: string, text: string, cause?: "event" | "answer", needs?: Needs) => void {
  return (owner, text, cause, needs) => finishes.tell(cardOwner(approval, owner), text, cause, needs);
}
function carryOutAction(approval: StoredApproval): void {
  const action = approval.action;
  if (!action) return;
  const tell = cardTell(approval);
  const projectOf = async (id: string) => (await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH)).projects.find((project) => project.id === id);
  const projectPath = async (id: string) => (await projectOf(id))?.path ?? null;
  const settled = async (done: StoredApproval): Promise<void> => {
    if (done.trusted) {
      const notice = receiptNotice(done);
      const project = await projectOf(action.project).catch(() => undefined);
      const opens = { projectId: action.project, session: project?.session ?? action.project, path: project?.path ?? "" };
      notices.record({ kind: "receipt", projectId: opens.projectId, session: opens.session, title: notice.title, body: notice.body });
      // In What Cobra did too (decided.ts): sent is sent, so its Undo takes back the trust that sent it, and the next one asks.
      const undo: DecidedUndo = { kind: "trust", key: done.trusted.key };
      const entry = recordDecided({ kind: "action", title: notice.title, body: notice.body, approval: done.id, project: action.project, undo });
      const tokens = await loadPushTokens();
      if (tokens.length === 0) return;
      const category = receiptCategory(undo);
      const outcome = await push(tokens, { title: notice.title, body: notice.body, ...(category ? { category } : {}), data: { machine: os.hostname(), ...opens, ...(category ? { decided: entry.id } : {}) } });
      for (const error of outcome.errors) console.log(`[${SERVICE}] push ticket: ${error}`);
      for (const token of outcome.dead) await dropPushToken(token);
      return;
    }
    await afterAnswer(trustDeps(), done);
  };
  void runAction({ ...liveActionDeps(projectPath, () => filesConfig()), queueBranded, queueCampaign, startSequence: startSequenceLive, queueBatch }, approval)
    .then(async (done) => {
      saveApprovals(loadApprovals().map((a) => (a.id === done.id ? done : a)));
      for (const result of done.results ?? []) console.log(`[${SERVICE}] approval ${done.id}: ${result.message}`);
      if (done.state === "done") timeline.recordCount("action-done", approval.id, action.project, undefined, approval.title);
      // The rendered files it carried are marked sent by the agent itself (sentFiles.ts), so the Foreman does not have to.
      let marked: string | null = null;
      if (done.state === "done") {
        const project = await projectOf(action.project).catch(() => undefined);
        try {
          marked = project ? markDocumentsSent(liveDbDeps(), project, { action: done.action, cardId: done.id, at: new Date().toISOString() }) : null;
          if (marked) console.log(`[${SERVICE}] db ${action.project}: ${marked}`);
        } catch (error) {
          console.log(`[${SERVICE}] db ${action.project}: marking sent failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      tell(action.project, marked ? `${actionNews(done)} The agent recorded it as sent: ${marked}.` : actionNews(done), undefined, needsOfState(done.state));
      return done;
    })
    .catch((error: unknown) => {
      // Nothing went out: the approval says so rather than staying allowed for good, and the Foreman hears it.
      const message = error instanceof Error ? error.message : String(error);
      const failed: StoredApproval = { ...approval, state: "failed", results: [{ ok: false, message }] };
      saveApprovals(loadApprovals().map((a) => (a.id === failed.id ? failed : a)));
      console.log(`[${SERVICE}] action ${approval.id}: ${message}`);
      tell(action.project, actionNews(failed), undefined, "decision");
      return failed;
    })
    .then((done) => settled(done))
    .catch((error: unknown) => console.log(`[${SERVICE}] after action ${approval.id}: ${error instanceof Error ? error.message : String(error)}`));
}

/**
 * GET /approvals: the ones waiting for you. POST /approvals/answer {id,
 * allow}: yours to answer, with a phone's or desktop's `act` (a Lead key has
 * neither). An allowed merge runs here, in the background, at the heads you
 * were shown; an allowed land (landing.ts) lands each branch into local main
 * at the commit you were shown, onto the main you were shown.
 */
async function handleApprovals(route: string, request: http.IncomingMessage, response: http.ServerResponse, caller: Caller): Promise<void> {
  const now = Date.now();
  if (route === "/approvals") {
    if (request.method !== "GET") return sendJson(response, 405, { error: "GET only" });
    const list = settle(loadApprovals(), now);
    return sendJson(response, 200, { machine: os.hostname(), approvals: list.filter((a) => a.state === "pending").map(publicView) });
  }
  if (request.method !== "POST") return sendJson(response, 405, { error: "POST only" });
  let body: { id?: unknown; allow?: unknown; models?: unknown; accounts?: unknown; skip?: unknown };
  try {
    body = JSON.parse(await readBody(request)) as typeof body;
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  if (typeof body.id !== "string" || typeof body.allow !== "boolean") return sendJson(response, 400, { error: "id and allow are required" });
  try {
    const answered = await answerAndApply(body.id, body.allow, body.models, now, undefined, body.accounts, body.skip, caller.id);
    return sendJson(response, 200, { approval: publicView(answered) });
  } catch (caught) {
    if (caught instanceof SessionError) return sendJson(response, caught.status, { error: caught.message });
    throw caught;
  }
}

/**
 * One answer to an approval and what it sets going: the plan's Workers, the
 * merge, the email, the routine, the trade… Shared by your Allow or Deny
 * (POST /approvals/answer) and by Cobra's own Allow under Instinct
 * (notifyOrAct). Throws SessionError for an answer that cannot be taken.
 */
async function answerAndApply(id: string, allow: boolean, models: unknown, now: number, by?: "cobra", accounts?: unknown, skip?: unknown, who?: string): Promise<StoredApproval> {
  // A plan's models as you chose them on its card (plans.ts), checked before anything is answered.
  const asked = loadApprovals().find((a) => a.id === id);
  const chosen = asked?.plan && allow ? chooseModels(asked.plan, models) : null;
  if (chosen && "error" in chosen) throw new SessionError(chosen.error, 400);
  // The accounts you picked on a receipts card (receipts.ts), checked the same way.
  const paidFrom = asked?.expenses && allow ? chooseAccounts(asked.expenses, accounts) : null;
  if (paidFrom && "error" in paidFrom) throw new SessionError(paidFrom.error, 400);
  // The bills you unticked on a bills card (billsCard.ts).
  const kept = asked?.bills && allow ? chooseSkips(asked.bills, skip) : null;
  if (kept && "error" in kept) throw new SessionError(kept.error, 400);
  const result = answerApproval(loadApprovals(), id, allow, now);
  const marked = { ...(chosen ? { plan: chosen } : {}), ...(paidFrom ? { expenses: paidFrom } : {}), ...(kept ? { bills: kept } : {}), ...(by && result.approval.state === "allowed" ? { allowedBy: by } : {}), ...(who ? { answeredBy: who } : {}) };
  const list = result.list.map((a) => (a.id === id ? { ...a, ...marked } : a));
  const approval: StoredApproval = { ...result.approval, ...marked };
  const tell = cardTell(approval);
  saveApprovals(list);
  if (approval.kind === "plan" && approval.plan) {
    const plan = approval.plan;
    if (approval.state === "allowed") {
      void startPlan(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH, plan, approval.requestedBy, (line) => console.log(`[${SERVICE}] ${line}`)).then((started) => {
        saveApprovals(loadApprovals().map((a) => (a.id === approval.id ? { ...a, plan: started, state: "done" } : a)));
        tell(plan.project, planNews(approval.id, started, true, approval.allowedBy === "cobra"), undefined, started.tasks.some((task) => task.error) ? "decision" : "info");
        console.log(`[${SERVICE}] plan ${approval.id}: ${started.tasks.map((task) => `${task.id} ${task.worker ?? task.queued ?? `failed (${task.error})`}`).join(", ")}`);
      });
    } else {
      tell(plan.project, planNews(approval.id, plan, false), undefined, "decision");
    }
  }
  console.log(`[${SERVICE}] approval ${approval.id} ${approval.state}: ${approval.title}`);
  if ((approval.kind === "merge" || approval.kind === "land") && approval.state === "allowed") {
    void (async () => {
      const merged = approval.prs?.length ? await runMerge(liveMergeDeps(), approval) : approval;
      return approval.lands?.length ? runLand(await landDeps(), merged) : merged;
    })().then(async (done) => {
      saveApprovals(loadApprovals().map((a) => (a.id === done.id ? done : a)));
      for (const result of done.results ?? []) console.log(`[${SERVICE}] approval ${done.id}: ${result.message}`);
      for (const pr of done.prs ?? []) {
        if (done.results?.some((result) => result.ok && result.number === pr.number)) timeline.recordCount("pr-merged", `${pr.repo}#${pr.number}`, undefined, undefined, pr.title);
      }
      // The Foreman that asked hears what became of it now, not when you tell it (prNews.ts).
      await tellApproval(prNewsDeps, done).catch((error: unknown) => console.log(`[${SERVICE}] pr news: ${error instanceof Error ? error.message : String(error)}`));
    });
  }
  if ((approval.kind === "merge" || approval.kind === "land") && approval.state === "denied") {
    void tellApproval(prNewsDeps, approval).catch((error: unknown) => console.log(`[${SERVICE}] pr news: ${error instanceof Error ? error.message : String(error)}`));
  }
  // An action a Foreman proposed (actions.ts): after Allow the agent sends exactly what you were shown, and the Foreman hears how it went.
  if (approval.kind === "action" && approval.action) {
    if (approval.state === "allowed") carryOutAction(approval);
    else {
      tell(approval.action.project, actionNews(approval), undefined, needsOfState(approval.state));
      // A Deny starts the action's count toward trust again (actionTrust.ts).
      void afterAnswer(trustDeps(), approval).catch((error: unknown) => console.log(`[${SERVICE}] trust: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  // Pinning github-mcp-server: re-checked now, and written only if the file is still the one you were shown.
  let answered = approval;
  // A routine the Lead or a Foreman proposed (routines.ts): Allow writes exactly it, and the proposer hears either answer.
  if (approval.kind === "routine" && approval.routine) {
    answered = settleRoutineApproval({ ...fileStore(), tell: (owner, text, needs) => tell(owner, text, undefined, needs), log: (line) => console.log(`[${SERVICE}] ${line}`) }, approval, Date.now());
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
  }
  // A trade Cobra defined (tradeRoutes.ts): Allow installs exactly the definition the card was made from, and the Lead hears which.
  if (approval.kind === "trade" && approval.trade) {
    answered = settleTradeApproval(liveTradeDeps({ approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) }, notify: notifyApproval, tell: (owner, text) => tell(owner, text), log: (line) => console.log(`[${SERVICE}] ${line}`) }), approval);
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
  }
  // A change Cobra proposed to a specialist (specialistRoutes.ts): Allow applies exactly the change the card was made from, and the Lead hears which.
  if (approval.kind === "specialist" && approval.specialist) {
    answered = settleSpecialistApproval(
      liveSpecialistDeps({
        approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) },
        notify: notifyApproval,
        tell: (owner, text) => tell(owner, text),
        log: (line) => console.log(`[${SERVICE}] ${line}`),
        projects: async () => (await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH)).projects.filter((project) => project.machine === os.hostname()),
        tradeName,
      }),
      approval,
      who ? `person:${who}` : "person",
    );
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
  }
  // A research run's card (webRuns.ts): Allow starts the run, and its owner hears either answer.
  // Your own idle sessions (sessionKeeper.ts): Allow ends those still at rest; nothing else is touched.
  if (approval.kind === "close-sessions" && approval.state === "allowed" && approval.closes) {
    void closeIdleSessions(approval.closes).catch((caught: unknown) => console.log(`[${SERVICE}] sessions: ${caught instanceof Error ? caught.message : String(caught)}`));
  }
  if (approval.kind === "web-run") {
    settleWebRunApproval({ load: () => loadRuns(), save: (list) => saveRuns(list), tell: (owner, text, needs) => tell(owner, text, undefined, needs), log: (line) => console.log(`[${SERVICE}] ${line}`), now: () => Date.now() }, approval);
  }
  // A move Cobra suggested in My Organization (orgRoutes.ts): Allow makes it, and the Lead hears which.
  if (approval.kind === "org" && approval.org) {
    answered = settleOrgApproval(orgDeps(), approval);
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
  }
  // A brand kit a Designer drafted (designer.ts): Allow saves exactly it, and the Designer hears either answer.
  if (approval.kind === "brand" && approval.brand) {
    const settled = settleBrand(approval);
    answered = settled.approval;
    tell(approval.brand.project, settled.news, undefined, needsOfState(answered.state));
    console.log(`[${SERVICE}] brand approval ${approval.id} ${answered.state}`);
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
  }
  // An email template a Foreman drafted (emailRoutes.ts): Allow saves exactly that draft as the next version, and the Foreman hears either answer.
  if (approval.kind === "email_template" && approval.emailTemplate) {
    const settled = settleTemplateApproval(approval, { spaceById }, new Date());
    answered = settled.approval;
    tell(approval.emailTemplate.project, settled.news, undefined, needsOfState(answered.state));
    console.log(`[${SERVICE}] email template approval ${approval.id} ${answered.state}`);
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
  }
  // A website version the Website Builder asked to put live (site.ts): Allow deploys exactly it, and the Foreman hears either answer.
  if (approval.kind === "site" && approval.site) {
    const settled = await settleSite(approval, liveSiteSettleDeps(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH));
    answered = settled.approval;
    tell(approval.site.project, settled.news, undefined, needsOfState(answered.state));
    console.log(`[${SERVICE}] site approval ${approval.id} ${answered.state}`);
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
    // A linked site's PR merged on this card (outsideSite.ts): the Website Builder has its news, so the PR watch keeps it quietly.
    const outside = approval.site.outside;
    if (outside && answered.state === "done") {
      void keepMerged(prNewsDeps, [{ worker: outside.workerId, number: outside.number }]).catch(() => undefined);
      timeline.recordCount("pr-merged", `${outside.repo}#${outside.number}`, undefined, undefined, approval.site.message);
    }
    // Its source to the owner's GitHub (Phase 3b), after the answer: the Foreman hears how it went, and the approval keeps it.
    const project = approval.site.project;
    void settled.source?.then((saved) => {
      tell(project, saved.note, undefined, saved.ok ? "info" : "decision");
      saveApprovals(loadApprovals().map((a) => (a.id === approval.id ? { ...a, results: [...(a.results ?? []), { ok: saved.ok, message: saved.note }] } : a)));
      console.log(`[${SERVICE}] site approval ${approval.id}: ${saved.note}`);
    }).catch((caught: unknown) => console.error(`[${SERVICE}] site approval ${approval.id}: ${caught instanceof Error ? caught.message : String(caught)}`));
  }
  // A Space Cobra proposed from an intake (spaceCreate.ts): Allow opens it with no Foremen yet, and the Lead is told to hire on first need.
  if (approval.kind === "space" && approval.space) {
    answered = await settleSpaceApproval(spaceDeps(), approval);
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
  }
  // A Website Builder asking to work on a site someone else coded (outsideSite.ts): Allow keeps the link, and the Website Builder hears either answer.
  if (approval.kind === SITE_LINK) {
    answered = settleLink(approval, { stateDir: STATE_DIR, tell: (owner, text, needs) => tell(owner, text, undefined, needs), now: Date.now });
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
  }
  // A form on a website Cobra did not build (formLinks.ts): Allow keeps the link and adds the Space's missing fields; its first pull runs at once.
  if (approval.kind === "form") {
    answered = settleFormApproval({ dir: FORM_LINKS_DIR, store: formStore, tell: (owner, text) => tell(owner, text), now: Date.now }, approval);
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
    if (answered.state === "done") formPullTick();
  }
  // A board Cobra made for a Space (spaceBoards.ts): Allow adds exactly it, and the Lead hears either answer.
  if (approval.kind === "board" && approval.board) {
    answered = settleBoardApproval({ spacesRoot: SPACES_DIR, tell: (owner, text) => tell(owner, text), now: Date.now, data: (space) => spaceDataPath(space) }, approval);
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
  }
  // Receipts Cobra read (receipts.ts): Allow records each expense and matches its bank line; Not mine voids them.
  if (approval.kind === "expenses" && approval.expenses) {
    answered = settleExpensesApproval(receiptDeps(), approval);
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
  }
  // A budget's limits (budgetCard.ts): Allow makes the proposal count, Deny drops it; Money's Foreman hears which.
  if (approval.kind === "budget" && approval.budget) {
    answered = settleBudgetApproval({ ...receiptDeps(), tell: (owner, text, needs) => tell(owner, text, undefined, needs) }, approval);
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
  }
  // Bills Cobra found or Money proposed (billsCard.ts): Allow keeps the ticked ones, Deny drops them; Money's Foreman hears which.
  if (approval.kind === "bills" && approval.bills) {
    answered = settleBillsApproval({ ...receiptDeps(), tell: (owner, text, needs) => tell(owner, text, undefined, needs) }, approval);
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
  }
  // Trust Cobra proposed (actionTrust.ts): Allow grants exactly that key, Deny keeps it asking, and the Foreman hears which.
  if (approval.kind === "trust" && approval.trust) {
    answered = settleTrustCard(trustDeps(), approval);
    if (answered !== approval) saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
  }
  // Files a Foreman asked to give its Worker (workerImport.ts): Allow copies exactly the bytes on the card, and the Foreman hears how it went.
  if (approval.kind === "import" && approval.imports) {
    const imports = approval.imports;
    if (approval.state === "allowed") {
      const worker = (await loadExtras()).find((extra) => extra.id === imports.worker && extra.parent === imports.project);
      const results = worker ? await runImport(liveImportDeps(importSources()), imports, worker.path) : [{ ok: false, message: `Worker ${imports.worker} has ended` }];
      // A file from outside its worktree that is not a picture or a font is text from outside: the Worker is tainted for the rest of its run (taint.ts).
      if (worker && importsText(imports) && results.some((result) => result.ok)) noteRead(`worker:${imports.worker}`, `files copied in: ${imports.files.map((file) => file.to).join(", ")}`, [], Date.now(), undefined, "file");
      answered = { ...approval, state: results.every((result) => result.ok) ? "done" : "failed", results };
      saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
      tell(imports.project, importNews(approval.id, imports, true, results), undefined, results.every((result) => result.ok) ? "info" : "decision");
    } else {
      tell(imports.project, importNews(approval.id, imports, false), undefined, "decision");
    }
  }
  if (approval.kind === "mcp-verify" && approval.state === "allowed") {
    answered = await runMcpVerify(approval);
    saveApprovals(loadApprovals().map((a) => (a.id === answered.id ? answered : a)));
    for (const result of answered.results ?? []) console.log(`[${SERVICE}] approval ${answered.id}: ${result.message}`);
  }
  timeline.recordCount("answered", approval.id);
  return answered;
}

// Whose GitHub token it is (and, for an App token, whether the App is installed), kept by its hash and never the token (mcpRoutes.ts).
const mcpLogin = loginCache((token) => readAccount(token));

/**
 * GET /mcp: the MCP servers for the Lead and Foremen (mcp.ts). POST
 * /mcp/toggle {name, enabled}: a preset on or off. POST /mcp/verify {name:
 * "github"}: asks for your Allow to pin the github-mcp-server file found here
 * (202 {approval}); the pin is written by that Allow, in handleApprovals.
 * POST /mcp/connect {id, method, token?} and /mcp/disconnect {id}: Settings →
 * Integrations; a pasted token is never logged.
 * A phone's or desktop's read and act only: a Lead or Foreman key reaches
 * /orch/* and nothing else, so an orchestrator cannot turn on a server.
 */
/**
 * GET /policy, POST /policy/preview, POST /policy, GET /policy/refused
 *. Only the desk you linked
 * may change it; a change that grants more is refused until it says you
 * confirmed it (the second press in the desk).
 */
async function handlePolicy(route: string, caller: Caller, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const computer = computerName();
  if (route === "/policy/refused") {
    if (request.method !== "GET") return sendJson(response, 405, { error: "GET only" });
    const refused = readPolicyLog(400)
      .filter((entry) => entry.decision === "deny" && (entry.rule.startsWith("judge:") || entry.rule.startsWith("never:") || entry.rule.startsWith(BLOCKLIST_RULE)))
      .slice(0, 50)
      .map((entry) => ({
        at: entry.at,
        worker: entry.worker,
        tool: entry.tool,
        rule: entry.rule,
        subject: entry.subject,
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.judge ? { judge: entry.judge } : {}),
      }));
    return sendJson(response, 200, { machine: computer, refused });
  }
  const read = readPolicyFile();
  if (route === "/policy" && request.method === "GET") {
    const resolved = resolvePolicy(read.policy, { computer }, read.refused);
    // This computer's projects by their policy keys, so the apps can set one apart without knowing its key.
    const { projects: registered } = await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH).catch(() => ({ projects: [] as Project[] }));
    const projects = (
      await Promise.all(
        registered
          .filter((project) => project.machine === os.hostname())
          .map(async (project) => {
            const key = await projectKeyFor(project).catch(() => null);
            return key ? [{ key, name: project.name, preset: resolvePolicy(read.policy, { computer, project: key }, read.refused).preset }] : [];
          }),
      )
    ).flat();
    return sendJson(response, 200, {
      computer,
      policy: read.policy,
      refused: read.refused,
      resolved: { preset: resolved.preset, network: resolved.network, judge: resolved.judge, fallbacks: resolved.fallbacks, notes: resolved.notes },
      presets: (Object.keys(PRESETS) as PresetName[]).map((name) => ({ name, title: PRESET_TITLES[name], rows: { ...PRESETS[name] } })),
      floor: FLOOR_WORDS,
      blocklist: BLOCKLIST_WORDS,
      capabilities: CAPABILITY_WORDS,
      roles: resolveRoles(read.policy, { computer }),
      hardCaps: HARD_CAPS,
      changes: readChanges(30),
      projects,
    });
  }
  if (request.method !== "POST") return sendJson(response, 405, { error: "POST only" });
  if (!mayChange(caller.kind)) return sendJson(response, 403, { error: "only the desk app you linked may change the policy" });
  let body: { policy?: unknown; confirmed?: unknown };
  try {
    body = JSON.parse(await readBody(request, 65_536)) as typeof body;
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  // A preview may be of the revision in force: it changes nothing.
  const taken = acceptable(body.policy, route === "/policy/preview" ? { ...read.policy, revision: -1 } : read.policy);
  if ("error" in taken) return sendJson(response, taken.status, { error: taken.error });
  const lines = describeChange(read.policy, taken.policy);
  const widens = lines.some((line) => line.widens);
  if (route === "/policy/preview") return sendJson(response, 200, { lines, widens });
  if (widens && body.confirmed !== true) {
    return sendJson(response, 428, { error: "this change grants more: confirm it (the second press in the desk app) and send it again", lines, widens });
  }
  writePolicy(taken.policy, { at: Date.now(), revision: taken.policy.revision, by: caller.name, lines });
  console.log(`[${SERVICE}] policy revision ${taken.policy.revision} by ${caller.name}: ${lines.map((line) => line.text).join("; ") || "no change in force here"}`);
  return sendJson(response, 200, { lines, widens, revision: taken.policy.revision });
}

/**
 * Local models (localCheck.ts): GET
 * /local says what Ollama here has and how each model did in Cobra's check;
 * POST /local/check {model} checks one, in the background (it loads the model
 * onto the GPU, so only when asked), and GET /local shows it as checking
 * until the verdict is in. A phone's or desk's key.
 */
async function handleLocal(route: string, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const computer = computerName();
  if (route === "/local") {
    if (request.method !== "GET") return sendJson(response, 405, { error: "GET only" });
    return sendJson(
      response,
      200,
      await localStatus({
        fetcher: fetch as unknown as Fetch,
        target: OLLAMA,
        computer,
        fallbacks: () => loadPolicy({ computer }).fallbacks,
        slots: async () => ({ limit: loadRoles({ computer }).local.slots, running: localRunning(await loadExtras(), await runningSessions()) }),
      }),
    );
  }
  if (request.method !== "POST") return sendJson(response, 405, { error: "POST only" });
  let body: { model?: unknown };
  try {
    body = JSON.parse(await readBody(request)) as typeof body;
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  const model = typeof body.model === "string" ? body.model.trim().replace(/:latest$/, "") : "";
  if (!LOCAL_MODEL_NAME.test(model)) return sendJson(response, 400, { error: "model must be one Ollama has here" });
  if (!OLLAMA.url) return sendJson(response, 503, { error: `no local model here: ${OLLAMA.refused ?? "Ollama is not set up"}` });
  const tags = await ollamaTagList(fetch as unknown as Fetch, OLLAMA.url);
  if (tags === null) return sendJson(response, 503, { error: "Ollama isn't answering on this computer" });
  if (!tags.some((tag) => sameModel(tag.name, model))) return sendJson(response, 404, { error: `Ollama here has no model ${model}` });
  console.log(`[${SERVICE}] local check: ${model} asked for`);
  void requestCheck(model).catch(() => undefined);
  return sendJson(response, 202, { model, checking: true });
}

/**
 * Accounts (accounts.ts): more than one Claude and
 * Codex account on this computer, and which one is in use here. GET
 * /accounts lists them; POST /accounts/claude {token, label} keeps a
 * `claude setup-token` token (never logged), /accounts/codex/start {label}
 * starts Codex's device sign-in and GET /accounts/codex/status?id= says when
 * it finished, /accounts/codex/save keeps this computer's own Codex sign-in
 * as an account, /accounts/use {provider, id} switches, /accounts/remove
 * {id} forgets one. A phone's or desk's key only, like /mcp.
 */
async function handleAccounts(route: string, url: URL, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  try {
    if (route === "/accounts" || route === "/accounts/codex/status") {
      if (request.method !== "GET") return sendJson(response, 405, { error: "GET only" });
      if (route === "/accounts") return sendJson(response, 200, accountsView());
      return sendJson(response, 200, { login: codexLoginStatus(url.searchParams.get("id") ?? "") });
    }
    if (request.method !== "POST") return sendJson(response, 405, { error: "POST only" });
    let body: { token?: unknown; label?: unknown; provider?: unknown; id?: unknown };
    try {
      body = JSON.parse(await readBody(request)) as typeof body;
    } catch {
      return sendJson(response, 400, { error: "invalid JSON body" });
    }
    if (route === "/accounts/claude") {
      const account = await addClaudeAccount(body);
      console.log(`[${SERVICE}] accounts: kept Claude account ${account.id} (${account.label})`);
      return sendJson(response, 200, { account, ...accountsView() });
    }
    if (route === "/accounts/codex/start") {
      const login = await startCodexLogin(body);
      console.log(`[${SERVICE}] accounts: Codex sign-in ${login.id} started`);
      return sendJson(response, 200, { login });
    }
    if (route === "/accounts/codex/save") {
      const account = saveLiveCodex(undefined, typeof body.label === "string" ? body.label : undefined);
      if (!account) return sendJson(response, 409, { error: "codex is not signed in on this computer" });
      return sendJson(response, 200, { account, ...accountsView() });
    }
    if (route === "/accounts/use") {
      const view = await useAccount(body, { codexRunning, clearLimits: () => rmSync(SUBSCRIPTION_LIMITS, { force: true }) });
      console.log(`[${SERVICE}] accounts: ${String(body.provider)} now ${body.id === null ? "this computer's own" : String(body.id)}`);
      return sendJson(response, 200, view);
    }
    if (route === "/accounts/remove") {
      const view = removeAccount(body);
      console.log(`[${SERVICE}] accounts: removed ${String(body.id)}`);
      return sendJson(response, 200, view);
    }
    return sendJson(response, 404, { error: "not found" });
  } catch (caught) {
    if (caught instanceof SessionError) return sendJson(response, caught.status, { error: caught.message });
    throw caught;
  }
}

async function handleMcp(route: string, caller: Caller, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const deps = liveMcpDeps(mcpLogin, os.hostname(), process.env.COBRA_MACHINE_NAME?.trim() || os.hostname());
  try {
    if (route === "/mcp") {
      if (request.method !== "GET") return sendJson(response, 405, { error: "GET only" });
      return sendJson(response, 200, await mcpStatus(deps));
    }
    if (request.method !== "POST") return sendJson(response, 405, { error: "POST only" });
    let body: { name?: unknown; enabled?: unknown; roles?: unknown; id?: unknown; method?: unknown; token?: unknown };
    try {
      body = JSON.parse(await readBody(request)) as typeof body;
    } catch {
      return sendJson(response, 400, { error: "invalid JSON body" });
    }
    if (route === "/mcp/connect") {
      const integration = await mcpConnect(body, deps);
      console.log(`[${SERVICE}] mcp ${integration.id} connect (${String(body.method)}): ${integration.state}`);
      return sendJson(response, 200, { integration });
    }
    if (route === "/mcp/disconnect") {
      const integration = await mcpDisconnect(body, deps);
      console.log(`[${SERVICE}] mcp ${integration.id} disconnected`);
      return sendJson(response, 200, { integration });
    }
    if (route === "/mcp/toggle") {
      const entry = await mcpToggle(body, deps);
      console.log(`[${SERVICE}] mcp ${entry.name} ${entry.enabled ? "on" : "off"}${entry.why ? ` (${entry.why})` : ""}`);
      return sendJson(response, 200, entry);
    }
    const asked = await mcpVerifyRequest(body, deps, { load: loadApprovals, save: saveApprovals }, caller.id);
    if (asked.created) {
      console.log(`[${SERVICE}] approval ${asked.approval.id} asked: ${asked.approval.title}`);
      await notifyApproval(asked.approval);
    }
    return sendJson(response, 202, { approval: publicView(asked.approval) });
  } catch (caught) {
    if (caught instanceof SessionError) return sendJson(response, caught.status, { error: caught.message });
    throw caught;
  }
}

/** What a land after Allow needs: each project's checkout, and whether a session is mid-turn in one. */
async function landDeps() {
  const configPath = process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH;
  const { projects } = await loadRegistry(configPath);
  const here = projects.filter((project) => project.machine === os.hostname());
  return liveLandDeps(
    (id) => here.find((project) => project.id === id)?.path ?? null,
    async (checkout) => {
      const list = await collectProjects(configPath, { git: false });
      const clean = (path: string) => path.replace(/\/+$/, "");
      return list.projects.some((project) => clean(project.path) === clean(checkout) && project.activity === "agent-working");
    },
  );
}

/** Every repository on this machine, reduced to the rows that want a tap. PRs come from the timer's copy. */
async function handleGitTidy(response: http.ServerResponse): Promise<void> {
  const list = await collectProjects(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH);
  const ghBin = await gh();
  const rows = [];
  // Worktrees of one repository share its branches: list them once.
  const seen = new Set<string>();
  for (const project of list.projects) {
    const git = project.git ?? null;
    if (!git) continue;
    const repo = (await commonDir(project.path)) ?? project.path;
    if (seen.has(repo)) continue;
    seen.add(repo);
    let prs = cachedPrs(project.path)?.prs ?? null;
    if (prs === null && ghBin && git.remote) prs = await refreshGithub(project.path, git.remote, ghBin);
    const branches = await readBranches(project.path, git, Date.now(), cachedMergedHeads(project.path));
    rows.push(...tidyRows(project, branches, prs, git, await checkedOutBranches(project.path)));
  }
  // Workers whose PR was closed without merging: yours to discard.
  const names = new Map(list.projects.map((project) => [project.id, project.name]));
  rows.push(...(await closedWorkerRows(liveLifecycleDeps(), (id) => names.get(id) ?? id)));
  return sendJson(response, 200, { machine: os.hostname(), rows, at: new Date().toISOString() });
}

/**
 * POST /power {lidAwake: boolean} — switch lid-awake (desktop/lid-awake) on
 * or off. 409 where it is not installed. Answers with the fresh PowerStats.
 */
async function handlePower(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "POST only" });
  }
  let body: { lidAwake?: unknown };
  try {
    body = JSON.parse(await readBody(request, 1024)) as typeof body;
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  if (typeof body.lidAwake !== "boolean") {
    return sendJson(response, 400, { error: "lidAwake must be true or false" });
  }
  const state = await setLidAwake(body.lidAwake);
  if (!state.available) {
    return sendJson(response, 409, { error: "lid-awake is not installed on this machine" });
  }
  return sendJson(response, 200, await collectPower());
}

async function handleGit(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "POST only" });
  }
  let body: { project?: unknown; action?: unknown; branch?: unknown; number?: unknown; head?: unknown; force?: unknown };
  try {
    body = JSON.parse(await readBody(request, 4 * 1024)) as typeof body;
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  const id = typeof body.project === "string" ? body.project : "";
  const action = GIT_ACTIONS.find((known) => known === body.action);
  if (!action) {
    return sendJson(response, 400, { error: `action must be one of ${GIT_ACTIONS.join(", ")}` });
  }
  const branch = typeof body.branch === "string" ? body.branch : undefined;
  if (branch !== undefined && !/^[A-Za-z0-9._\/-]{1,120}$/.test(branch)) {
    return sendJson(response, 400, { error: "branch name is not usable" });
  }
  const number = typeof body.number === "number" && Number.isInteger(body.number) && body.number > 0 ? body.number : undefined;
  if ((action === "close-pr" || action === "merge-pr") && number === undefined) {
    return sendJson(response, 400, { error: "number is required" });
  }
  // A merge names the commit you were shown (repo.ts mergePr): a tap with no
  // head, as from an app older than this rule, is refused rather than
  // merging whatever the PR holds now.
  const head = typeof body.head === "string" ? body.head : undefined;
  if (action === "merge-pr" && (head === undefined || !HEAD_SHA.test(head))) {
    return sendJson(response, 400, { error: "merge needs the head commit you were shown; update the app and try again" });
  }
  // Only by an explicit true, which the apps send after a second confirmation.
  const force = body.force === true;
  if (action === "delete-branch" && branch === undefined) {
    return sendJson(response, 400, { error: "branch is required" });
  }
  const configPath = process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH;
  const needsGit = action === "delete-branch" || action === "close-pr" || action === "merge-pr";
  const list = await collectProjects(configPath, { git: needsGit });
  const project = list.projects.find((candidate) => candidate.id === id);
  if (!project) {
    return sendJson(response, 404, { error: `no project "${id}" on this machine` });
  }
  try {
    const ghFor = async (): Promise<[string, string]> => {
      const bin = await gh();
      if (!bin) throw new SessionError("gh is not installed on this machine", 409);
      const remote = project.git?.remote;
      if (!remote) throw new SessionError("no GitHub remote", 409);
      return [bin, remote];
    };
    const outcome =
      action === "park"
        ? await parkRepo(project.path, project.activity, os.hostname())
        : action === "resume"
          ? await resumeRepo(project.path, project.activity, branch)
          : action === "delete-branch"
            ? await (async () => {
                // A delete right after a merge must see that merge: refresh
                // the merged heads when gh is available before judging.
                const bin = await gh();
                if (bin && project.git?.remote) await refreshGithub(project.path, project.git.remote, bin);
                return deleteBranch(project.path, project.git ?? null, branch ?? "", Date.now(), cachedMergedHeads(project.path));
              })()
            : action === "close-pr"
              ? await (async () => {
                  const [bin, remote] = await ghFor();
                  const closed = await closePr(bin, remote, number ?? 0);
                  // /prs serves the cache: drop the closed PR from it now, not at the next tick.
                  await refreshGithub(project.path, remote, bin);
                  return closed;
                })()
              : action === "merge-pr"
                ? await (async () => {
                    const [bin, remote] = await ghFor();
                    const merged = await mergePr(bin, remote, number ?? 0, head ?? "", { force, by: "person" });
                    if (force) console.log(`[${SERVICE}] git merge-pr ${id} #${number}: merged with force at ${head}, whatever its checks said`);
                    await refreshGithub(project.path, remote, bin);
                    return merged;
                  })()
                : await syncRepo(project.path, project.activity, { action: true });
    console.log(`[${SERVICE}] git ${action} ${id}: ${outcome.did}${"branch" in outcome ? ` (${outcome.branch})` : ""}`);
    return sendJson(response, 200, {
      ok: true,
      project: id,
      action,
      did: outcome.did,
      ...("branch" in outcome ? { branch: outcome.branch } : {}),
      git: "git" in outcome ? outcome.git : null,
    });
  } catch (caught) {
    if (caught instanceof SessionError) {
      return sendJson(response, caught.status, { error: caught.message });
    }
    throw caught;
  }
}

/** The answers of an `answer` action, by hand (types-only contracts); null when malformed. */
function readAnswers(raw: unknown): Answer[] | undefined | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const answers: Answer[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    if (!item || typeof item.question !== "string") return null;
    const answer: Answer = { question: item.question };
    if (item.option !== undefined) {
      if (typeof item.option !== "number") return null;
      answer.option = item.option;
    }
    if (item.options !== undefined) {
      if (!Array.isArray(item.options) || !item.options.every((n) => typeof n === "number")) return null;
      answer.options = item.options as number[];
    }
    if (item.text !== undefined) {
      if (typeof item.text !== "string") return null;
      answer.text = item.text;
    }
    answers.push(answer);
  }
  return answers;
}

/**
 * The conversation in a session, as Claude Code's own transcript records it,
 * plus what its screen is doing right now. `after` is the offset the last
 * read returned, so a poll costs only what was appended since.
 */
/** Cobra's thread, kept here while she runs on this computer (thread.ts). */
const thread = createThreadStore();

/**
 * A notice the person must read (the Lead's notify_person, a routine's, a
 * website's), kept in Cobra's thread as her words as well as pushed, so
 * nothing she tells them lives only on the lock screen.
 */
function threadNotice(title: string, body: string): void {
  if (!thread.exists()) return;
  try {
    thread.append([{ at: new Date().toISOString(), kind: "cobra", conversation: thread.current() ?? "", text: `${title}: ${body}` }]);
  } catch (caught) {
    console.log(`[${SERVICE}] could not keep a notice in Cobra's thread: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

/** Where her conversation is read from now, whatever she runs on, as GET /transcript finds it; null when she is not running. */
async function leadThreadSource(): Promise<ThreadSource | null> {
  if (orchHeadless(LEAD_SESSION)) {
    const file = orchTranscriptFile(LEAD_SESSION);
    return file ? { file, read: readTranscript } : null;
  }
  if (!(await tmuxHas(LEAD_SESSION))) return null;
  if (startedOn(LEAD_SESSION, "lead") === "codex") {
    const name = orchestratorCodexSessionName(LEAD_SESSION);
    const file = name ? await findCodexTranscript(join(CODEX_SESSIONS_DIR, name)) : null;
    return file ? { file, read: readCodexTranscript } : null;
  }
  const identity = await paneIdentity(LEAD_SESSION);
  const file = await transcriptForPane(readHookRecords(), { path: leadHome(), ...(identity ?? {}) }, await claudeHooksInstalled());
  return file ? { file, read: readTranscript } : null;
}

let threadBusy: Promise<number> | null = null;
/** Copies what is new in her transcript into the thread; one copy at a time. */
function ingestThread(): Promise<number> {
  threadBusy ??= leadThreadSource()
    .then((source) => thread.ingest(source))
    .catch((caught: unknown) => {
      console.log(`[${SERVICE}] thread: ${caught instanceof Error ? caught.message : String(caught)}`);
      return 0;
    })
    .finally(() => {
      threadBusy = null;
    });
  return threadBusy;
}

/** Her conversation now as the thread has it, and whether anything was said in it. */
function currentConversation(): { entries: ThreadEntry[]; said: boolean } {
  const current = thread.current();
  const entries = current && current !== NEW_CONVERSATION ? thread.conversation(current) : [];
  return { entries, said: entries.some((entry) => entry.kind === "you" || entry.kind === "cobra") };
}

/** The handoff note for the conversation ending (leadRotation.ts); a Codex Cobra has no start hook to read it, so none. */
async function leadHandoff(reason: string, timeoutMs: number): Promise<string | null> {
  if (startedOn(LEAD_SESSION, "lead") === "codex") return null;
  const log = (line: string) => console.log(`[${SERVICE}] ${line}`);
  return await makeHandoff(liveHandoffDeps(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH, log), currentConversation().entries, reason, timeoutMs);
}

/** New conversation's handoff: what the phone's request leaves room for (it gives up at 20 s). */
const CLEAR_HANDOFF_MS = 10_000;
/** The fresh start's handoff: nobody waits on it. */
const IDLE_HANDOFF_MS = 2 * 60_000;

/** Her fresh start after two quiet hours, or ten in a conversation past 100k tokens, asked each minute; off unless COBRA_LEAD_ROTATE=on. */
async function rotateIfQuiet(): Promise<void> {
  const enabled = process.env.COBRA_LEAD_ROTATE === "on";
  if (!enabled || !leadUp) return;
  const configPath = process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH;
  const facts = async () => {
    await ingestThread();
    const source = await leadThreadSource();
    return await rotationFactsHere({
      enabled,
      running: await leadRunning(),
      sourceFile: source?.file ?? null,
      said: currentConversation().said,
      configPath,
    });
  };
  const first = shouldRotate(await facts());
  if (!first.rotate) return;
  const note = await leadHandoff(first.reason, IDLE_HANDOFF_MS);
  // The note took a while: the person may have spoken since.
  const again = shouldRotate(await facts());
  if (!again.rotate) {
    console.log(`[${SERVICE}] Lead: fresh start held (${again.why})`);
    return;
  }
  if (note) writeHandoff(note);
  // Either way it is a fresh start on her thread (the phone's "Fresh start"); the handoff says why.
  thread.markNext("idle");
  try {
    await newLeadConversation(config.port);
  } catch (caught) {
    dropHandoff();
    throw caught;
  }
  console.log(`[${SERVICE}] Lead: fresh start ${first.reason === "context" ? "after a quiet spell in a long conversation" : "after two quiet hours"}`);
}

/**
 * GET /thread?before=|after=&limit= (contracts ThreadPage): Cobra's thread,
 * brought up to date first. 404 where she has never run since it began.
 */
async function handleThread(url: URL, response: http.ServerResponse): Promise<void> {
  const up = await leadRunning();
  if (up) await ingestThread();
  if (!thread.exists()) return sendJson(response, 404, { error: "no conversation with the Lead on this computer yet" });
  // Back after half an hour away: one line of what happened here meanwhile (digest.ts).
  {
    try {
      onThreadRead(Date.now(), (text) => {
        thread.append([{ at: new Date().toISOString(), kind: "digest", conversation: thread.current() ?? "", text }]);
      });
    } catch (caught) {
      console.log(`[${SERVICE}] thread digest: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  const number = (name: string): number | undefined | null => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : null;
  };
  const before = number("before");
  const after = number("after");
  const limit = number("limit");
  if (before === null || after === null || limit === null) return sendJson(response, 400, { error: "before, after and limit are whole numbers" });
  const page = thread.page({ before, after, limit });
  return sendJson(response, 200, { machine: os.hostname(), entries: page.entries, current: up ? thread.current() : null, more: page.more });
}

/** Cobra is in the middle of a turn now: her /projects row works or is busy. */
async function leadWorking(): Promise<boolean> {
  const { projects } = await collectProjects(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH, { git: false });
  const lead = projects.find((project) => project.lead);
  return !!lead && (lead.activity === "agent-working" || lead.activity === "busy");
}

/**
 * GET /thread/wait?after=<id>&timeout=<s> (contracts ThreadWaitPage, threadWait.ts):
 * Talk's way to hear her reply as soon as her turn ends, instead of the 30 s page read.
 */
async function handleThreadWait(url: URL, response: http.ServerResponse): Promise<void> {
  const raw = url.searchParams.get("after");
  const after = raw === null ? NaN : Number(raw);
  if (!Number.isInteger(after) || after < 0) return sendJson(response, 400, { error: "after is the id of the last entry you have" });
  if (!(await leadRunning())) return sendJson(response, 409, { error: "Cobra is not running on this computer" });
  const result = await waitForThread(after, waitMs(url.searchParams.get("timeout")), {
    ingest: ingestThread,
    after: (id) => thread.page({ after: id, limit: 200 }).entries,
    working: leadWorking,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  });
  if (!thread.exists()) return sendJson(response, 404, { error: "Cobra keeps no thread on this computer yet" });
  const first = result.entries[0];
  return sendJson(response, 200, {
    machine: os.hostname(),
    entries: result.entries,
    current: thread.current(),
    more: first ? thread.page({ before: first.id, limit: 1 }).entries.length > 0 : false,
    working: result.working,
  });
}

let voiceCalls: VoiceCalls | null = null;
let lateAnswers: LateAnswers | null = null;
let lateTimer: ReturnType<typeof setInterval> | null = null;

/** Answers to calls' hand-offs that come after the turn (lateAnswer.ts): looked for every 5 s while any wait. */
function liveLateAnswers(): LateAnswers {
  if (lateAnswers) return lateAnswers;
  const log = (line: string) => console.log(`[${SERVICE}] ${line}`);
  lateAnswers = createLateAnswers({
    now: Date.now,
    entriesAfter: (id) => thread.page({ after: id, limit: 200 }).entries,
    leadWorking,
    summarize: (request, reply) => summarizeLate(request, reply, log),
    tellCall: (call, text) => voiceCalls?.tell(call, text) ?? false,
    push: async (request, spoken) => {
      const title = `Done: ${request.length > 60 ? `${request.slice(0, 59).trimEnd()}…` : request}`;
      notices.record({ kind: "lead", projectId: LEAD_SESSION, session: LEAD_SESSION, title, body: spoken });
      const tokens = await loadPushTokens();
      if (tokens.length === 0) return;
      const outcome = await push(tokens, {
        title,
        body: spoken,
        data: { machine: os.hostname(), projectId: LEAD_SESSION, session: LEAD_SESSION, path: leadHome(), spoken },
        category: LATE_ANSWER_CATEGORY,
      });
      for (const error of outcome.errors) log(`push ticket: ${error}`);
      for (const token of outcome.dead) await dropPushToken(token);
    },
    log,
  });
  return lateAnswers;
}

function waitForLateAnswer(handoff: HandOff): void {
  const late = liveLateAnswers();
  late.add(handoff, thread.page({ limit: 1 }).entries.at(-1)?.id ?? 0);
  if (lateTimer) return;
  lateTimer = setInterval(() => {
    void late.tick().finally(() => {
      if (late.waiting() === 0 && lateTimer) {
        clearInterval(lateTimer);
        lateTimer = null;
      }
    });
  }, 5000);
  lateTimer.unref?.();
}

/** The voice front's calls (voiceFront.ts, voiceLive.ts), made on the first call; a crashed agent's call folders go first. */
function liveVoiceCalls(): VoiceCalls {
  if (voiceCalls) return voiceCalls;
  rmSync(VOICE_DIR, { recursive: true, force: true });
  const calls = createVoiceCalls(
    liveVoiceDeps({
      projects: async () => {
        const { projects } = await collectProjects(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH, { git: false });
        return markHandled(projects, cobraAnswers);
      },
      leadWorking,
      recent: (limit) => thread.page({ limit }).entries,
      thread: { append: (entries) => void thread.append(entries), conversation: () => thread.current() ?? "" },
      // What the person said goes to her as /session say types it: nothing of the voice front's own.
      handOff: async (text) => {
        if (!(await leadRunning())) throw new Error("Cobra is not running on this computer");
        await withWake(LEAD_SESSION, "person", undefined, async () => {
          if (!(await headlessAction(LEAD_SESSION, "say", { text }))) await runSessionAction("say", LEAD_SESSION, { text });
        });
      },
      handedOff: waitForLateAnswer,
      log: (line) => console.log(`[${SERVICE}] ${line}`),
    }),
  );
  // An open call holds one Worker's room (sessionBudget.ts).
  countVoiceCalls(() => (calls.open() ? 1 : 0));
  voiceCalls = calls;
  return calls;
}

/** /voice/* (voiceRoutes.ts): calls with Cobra, where her thread is. */
async function handleVoice(route: string, url: URL, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (!thread.exists()) return sendJson(response, 409, { error: "Cobra keeps no thread on this computer yet, so there is nothing to call" });
  let body: Record<string, unknown> = {};
  if (request.method === "POST") {
    try {
      const raw = await readBody(request, 8 * 1024);
      body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return sendJson(response, 400, { error: "invalid JSON body" });
    }
  }
  const reply = await voiceRoute(liveVoiceCalls(), route, request.method ?? "GET", url.searchParams, body);
  return sendJson(response, reply.status, reply.body);
}

async function handleTranscript(url: URL, response: http.ServerResponse): Promise<void> {
  const session = url.searchParams.get("session") ?? "";
  if (!SESSION_NAME.test(session)) {
    return sendJson(response, 400, { error: "session must match [A-Za-z0-9._-]{1,64}" });
  }
  const afterRaw = url.searchParams.get("after");
  const after = afterRaw === null ? undefined : Number(afterRaw);
  if (after !== undefined && !Number.isInteger(after)) {
    return sendJson(response, 400, { error: "after must be a byte offset" });
  }

  // A headless Worker (headlessWorkers.ts): its own transcript, and a screen made from its stream and permission tool.
  const headlessWorker = (await loadExtras()).find((extra) => extra.session === session && extra.worker && isHeadless(extra.id));
  if (headlessWorker) {
    const view = headlessView(headlessWorker.id);
    const request = view ? headlessRequest(headlessWorker.id) : null;
    const screen = view
      ? { recognised: true, working: view.working, needsInput: view.needsInput, dialog: view.dialog, tail: view.tail, question: view.question, model: null, ...(request ? { request } : {}) }
      : null;
    const file = headlessTranscriptFile(headlessWorker.id);
    const read = file ? await readTranscript(file, after) : null;
    return sendJson(response, 200, {
      session,
      path: headlessWorker.path,
      file,
      offset: read?.offset ?? 0,
      title: read?.title ?? null,
      messages: read?.messages ?? [],
      screen,
      model: read?.model ?? null,
      effort: read?.effort ?? null,
      asking: null,
    });
  }

  // A headless Lead or Foreman (API test mode, orchHeadless.ts): its transcript, and a screen from its stream, call and ask.
  const look = orchHeadless(session) ? orchLook(session) : null;
  if (look) {
    const screen = { recognised: true, working: look.working, needsInput: look.needsInput, dialog: look.dialog, tail: look.tail, question: look.question ?? null, model: null, ...(look.request ? { request: look.request } : {}) };
    const file = orchTranscriptFile(session);
    const read = file ? await readTranscript(file, after) : null;
    const asked = pendingAsk(session);
    return sendJson(response, 200, {
      session,
      path: orchCwd(session) ?? leadHome(),
      file,
      offset: read?.offset ?? 0,
      title: read?.title ?? null,
      messages: read?.messages ?? [],
      screen,
      model: read?.model ?? null,
      effort: read?.effort ?? null,
      asking: look.question && asked ? askingOf(asked) : null,
    });
  }

  // A Pi session (pi.ts): its own session file, and a screen made from its record and held call (its TUI is not read).
  const piSession = (await loadExtras()).find((extra) => extra.session === session && extra.worker && isPi(extra.id));
  if (piSession) {
    const view = piView(piSession.id, piSession.path, readHookRecords());
    const request = view.needsInput ? piRequest(piSession.id) : null;
    const file = piTranscriptFile(piSession.id);
    const read = file ? await readPiTranscript(file, after) : null;
    return sendJson(response, 200, piTranscriptReply({ session, path: piSession.path, file, title: piSession.title ?? null, read, view, request }));
  }

  const tmux = await collectTmux();
  const found = tmux.sessions.find((candidate) => candidate.name === session);
  if (!found) return sendJson(response, 404, { error: "no such session" });

  const [identity, raw, hooks] = await Promise.all([
    paneIdentity(session, found.windowIndex),
    capturePane(session, found.windowIndex),
    claudeHooksInstalled(),
  ]);
  // The session's own transcript, by its hooks; null until its first message.
  const file = await transcriptForPane(readHookRecords(), { path: found.path, ...identity }, hooks);
  // A question asked through ask_person is drawn as if it were on screen (asks.ts).
  const pendingQuestion = pendingAsk(session);
  const pane = overlayAsk(raw ? readPane(raw) : null, pendingQuestion);
  // A Worker's prompt from the call its policy hook kept; any other session's off its screen.
  const extras = await loadExtras();
  const sessionExtra = extras.find((extra) => extra.session === session);
  const worker = sessionExtra?.worker ? sessionExtra : undefined;
  // Codex has no Claude hook transcript: its isolated runtime writes an event
  // stream under its own home, which supplies the same phone-chat messages.
  const orchestratorHome = orchestratorCodexSessionName(session);
  const codexName = orchestratorHome && startedOn(session, orchestratorRole(session)) === "codex" ? orchestratorHome : null;
  // Normal Codex project sessions use the same isolated home as the launcher.
  // The persisted extra marker covers a parked/idle session; the pane marker
  // covers a root project session, which has no extras.json record.
  const projectCodexName = projectCodexSessionName(session, sessionExtra?.engine === "codex" || recordedEngine(session) === "codex" || pane?.codexHome === true);
  const codexFile = worker?.worker?.model.startsWith("codex")
    ? await findCodexTranscript(containLayout(worker.id).codex)
    : codexName ? await findCodexTranscript(join(CODEX_SESSIONS_DIR, codexName))
      : projectCodexName ? await findCodexTranscript(join(CODEX_SESSIONS_DIR, projectCodexName)) : null;
  if (codexFile) {
    const read = await readCodexTranscript(codexFile, after);
    // A Codex Worker's ask, which its screen never shows, is drawn as its permission prompt (codexAsks.ts).
    const remote = worker && pane ? remoteShown(worker.id, { activity: pane.working ? "agent-working" : "agent-idle", needsInput: pane.needsInput }) : null;
    return sendJson(response, 200, {
      session,
      path: found.path,
      file: codexFile,
      offset: read.offset,
      title: worker?.title ?? null,
      messages: read.messages,
      screen: pane
        ? {
            recognised: pane.recognised,
            working: pane.working,
            needsInput: pane.needsInput || remote !== null,
            dialog: remote ? remote.dialog : pane.dialog,
            tail: pane.tail,
            question: pane.question,
            model: pane.model,
            ...(remote ? { request: remote.request } : {}),
          }
        : null,
      model: read.model,
      effort: read.effort,
      asking: pane?.question ? askingOf(pendingQuestion) : null,
    });
  }
  const request = explainedRequest(worker?.id ?? null, pane);
  // The hook's copy of the question on screen, for its previews and descriptions.
  const asking = pane?.question && !pane.question.submit ? (askingOf(pendingQuestion) ?? askedFor(readAsked(), found.path, pane.question.text)) : null;
  const screen = pane
    ? {
        recognised: pane.recognised,
        working: pane.working,
        needsInput: pane.needsInput,
        dialog: pane.dialog,
        tail: pane.tail,
        question: pane.question,
        model: pane.model,
        ...(request ? { request } : {}),
      }
    : null;

  if (!file) {
    return sendJson(response, 200, {
      session,
      path: found.path,
      file: null,
      offset: 0,
      title: null,
      messages: [],
      screen,
      model: null,
      effort: null,
      asking,
    });
  }
  const read = await readTranscript(file, after);
  return sendJson(response, 200, {
    session,
    path: found.path,
    file,
    offset: read.offset,
    title: read.title,
    messages: read.messages,
    screen,
    // Null on an incremental read with no assistant turn in it: the app keeps
    // what it had, because "nothing new" is not "no model".
    model: read.model,
    effort: read.effort,
    asking,
  });
}

/**
 * The slash commands the session would accept. Resolved against its own
 * directory, so a project's skills are in the list when it has any, and
 * cached because it is a few hundred file reads that change about never.
 */
async function handleCommands(url: URL, response: http.ServerResponse): Promise<void> {
  const session = url.searchParams.get("session") ?? "";
  if (!SESSION_NAME.test(session)) {
    return sendJson(response, 400, { error: "session must match [A-Za-z0-9._-]{1,64}" });
  }
  const tmux = await collectTmux();
  const found = tmux.sessions.find((candidate) => candidate.name === session);
  if (!found) return sendJson(response, 404, { error: "no such session" });

  const cached = commandCache.get(found.path);
  if (cached && Date.now() - cached.at < COMMAND_TTL_MS) {
    return sendJson(response, 200, { session, commands: cached.commands });
  }
  const commands = await collectCommands(found.path);
  commandCache.set(found.path, { at: Date.now(), commands });
  return sendJson(response, 200, { session, commands });
}

/** Skills are files on disk; they change when one is written, not between polls. */
const COMMAND_TTL_MS = 60_000;
const commandCache = new Map<string, { at: number; commands: Awaited<ReturnType<typeof collectCommands>> }>();

/**
 * Start work from the phone. The other half of the loop the push notifications
 * opened: this begins a turn, and the watcher tells you when it stops.
 */
async function handleDispatch(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "POST only" });
  }

  // By hand, like /session: @cobra/contracts is types-only on the agent.
  let body: { project?: unknown; template?: unknown; prompt?: unknown; overCap?: unknown };
  try {
    body = JSON.parse(await readBody(request)) as typeof body;
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  const projectId = typeof body.project === "string" ? body.project : "";
  const template = typeof body.template === "string" ? body.template : undefined;
  const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
  if (projectId.length === 0) {
    return sendJson(response, 400, { error: "project is required" });
  }

  const configPath = process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH;
  const configured = await loadDispatchConfig(configPath);
  try {
    const resolved = resolve(configured, os.hostname(), projectId, template, prompt);
    const deps = liveDeps();
    if (await deps.sessionExists(resolved.project.session)) {
      // Something is already running there. Typing into it would interrupt
      // it, and a second window in the same checkout would share its branch,
      // so the task gets a session of its own (extras.ts) — of the project
      // itself when the busy one is already an extra.
      const { projects } = await loadRegistry(configPath);
      const rootId = resolved.project.parent ?? resolved.project.id;
      const parent = projects.find((candidate) => candidate.id === rootId && candidate.machine === os.hostname());
      if (!parent) return sendJson(response, 404, { error: "no such project" });
      const started = await startExtra(liveNewSessionDeps(), parent, projects, {
        prompt: resolved.prompt,
        overCap: body.overCap === true,
      });
      console.log(`[${SERVICE}] dispatched to "${started.project.session}" (new session on ${started.project.branch})`);
      return sendJson(response, 200, {
        ok: true,
        session: started.project.session,
        created: true,
        prompt: resolved.prompt,
        project: started.project.id,
      });
    }
    // The default engine for your sessions; Claude when Codex is chosen but nobody is signed in to it.
    const launch = defaultProjectLaunch(resolved.project.path, resolved.project.session);
    const result = await dispatch(deps, resolved.project, resolved.prompt, launch.env, launch.command);
    recordSessionEngine(resolved.project.session, launch.engine);
    const note = launch.fellBack ? "Started on Claude: Codex is the default here, but no Codex sign-in is active." : undefined;
    console.log(`[${SERVICE}] dispatched to "${result.session}" (new session${launch.fellBack ? ", Claude in place of Codex" : ""})`);
    return sendJson(response, 200, { ok: true, ...result, prompt: resolved.prompt, ...(note ? { note } : {}) });
  } catch (caught) {
    if (caught instanceof SessionError) {
      return sendJson(response, caught.status, { error: caught.message });
    }
    throw caught;
  }
}

/**
 * POST /session/new {project, prompt?, branch?, overCap?, localModel?, onKey?, engine?}:
 * one more interactive session in a project, in its own worktree and tmux
 * session (extras.ts), on a local model when one is named (localModels.ts).
 */
async function handleNewSession(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "POST only" });
  }
  let body: { project?: unknown; prompt?: unknown; branch?: unknown; overCap?: unknown; localModel?: unknown; onKey?: unknown; harness?: unknown; engine?: unknown };
  try {
    body = JSON.parse(await readBody(request)) as typeof body;
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  const id = typeof body.project === "string" ? body.project : "";
  const { projects } = await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH);
  const parent = projects.find((candidate) => candidate.id === id && candidate.machine === os.hostname());
  if (!parent) return sendJson(response, 404, { error: `no project "${id}" on this machine` });
  try {
    // A local model runs on Pi, in Cobra's sandbox, where Pi is pinned and the sandbox runs, unless Claude Code is asked for (pi.ts).
    const localModel = typeof body.localModel === "string" ? body.localModel.trim() : "";
    if (body.engine !== undefined && body.engine !== "claude" && body.engine !== "codex") {
      return sendJson(response, 400, { error: "engine must be claude or codex" });
    }
    const engine: SessionEngine | undefined = body.engine === "codex" ? "codex" : body.engine === "claude" ? "claude" : undefined;
    if (localModel && body.harness !== "claude" && piReady()) {
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      const spawned = await spawnWorker(liveWorkerDeps((line) => console.log(`[${SERVICE}] ${line}`)), parent, projects, {
        task: prompt,
        model: `local:${localModel}`,
        owner: OWNER_YOU,
        harness: "pi",
        overCap: body.overCap === true,
        ...(typeof body.branch === "string" ? { branch: body.branch } : {}),
      });
      void spawned.background;
      console.log(`[${SERVICE}] new Pi session "${spawned.project.session}" in ${parent.id} on ${spawned.project.branch} with ${localModel}`);
      return sendJson(response, 200, { ok: true, project: spawned.project, dispatched: prompt.trim().length > 0 });
    }
    if (body.harness === "pi") return sendJson(response, 409, { error: piUnavailable() });
    // Claude Code on a local model holds the GPU too: the same slots (phase 4), the same "Start anyway".
    if (localModel && body.overCap !== true) {
      const full = localSlotsFull(await loadExtras(), await runningSessions(), loadRoles({ computer: computerName() }).local.slots, true);
      if (full) return sendJson(response, 429, { error: full });
    }
    const started = await startExtra(liveNewSessionDeps(), parent, projects, {
      ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
      ...(typeof body.branch === "string" ? { branch: body.branch } : {}),
      ...(typeof body.localModel === "string" ? { localModel: body.localModel } : {}),
      ...(body.onKey === true ? { onKey: true } : {}),
      ...(engine ? { engine } : {}),
      overCap: body.overCap === true,
    });
    const on = started.project.localModel ? ` with ${started.project.localModel}` : "";
    console.log(`[${SERVICE}] new session "${started.project.session}" in ${parent.id} on ${started.project.branch}${on}`);
    return sendJson(response, 200, { ok: true, ...started });
  } catch (caught) {
    if (caught instanceof SessionError) {
      return sendJson(response, caught.status, { error: caught.message });
    }
    throw caught;
  }
}

/** The saved tasks this machine will dispatch, so the phone can offer a list. */
/**
 * gh is looked up once and cached briefly. Resolving the binary is a handful of
 * stats, but `gh auth status` is a network round trip, and the app asks for this
 * every time the create screen opens.
 */
const CAPABILITY_TTL_MS = 60_000;
let capabilityCache: { at: number; gh: string | null; authed: boolean; user: string | null } | null =
  null;

async function githubState(): Promise<{ gh: string | null; authed: boolean; user: string | null }> {
  const now = Date.now();
  if (capabilityCache && now - capabilityCache.at < CAPABILITY_TTL_MS) return capabilityCache;
  const gh = await findGh();
  const auth = gh === null ? { authed: false, user: null } : await ghAuth(gh);
  capabilityCache = { at: now, gh, authed: auth.authed, user: auth.user };
  return capabilityCache;
}

async function handleCapabilities(response: http.ServerResponse): Promise<void> {
  const [{ roots }, github, local] = await Promise.all([
    loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH),
    githubState(),
    localModels(),
  ]);
  const offered = offers(local, readChecks());
  return sendJson(response, 200, {
    machine: os.hostname(),
    gh: github.gh,
    githubAuth: github.authed,
    githubUser: github.user,
    roots,
    // A model that failed Cobra's check is not offered; one not checked yet is, marked (localCheck.ts).
    localModels: offered.map((model) => model.name),
    localModelInfo: offered,
    // Whether a local model starts on Pi here (pinned, and Cobra's sandbox runs); without it, Claude Code.
    pi: piReady(),
    codex: activeCodexCredential() !== null,
    engines: readEngines(),
  });
}

/**
 * Settings → Brain (brain/view.ts): GET /brain is this computer's rules,
 * the benchmark table, its accounts' models and windows, and the pick per
 * kind and size; POST {brain} writes a newer brain.json, the desk's key
 * only. A rule only orders the models the policy already allows, so it
 * grants nothing and needs no second press.
 */
async function handleBrain(caller: Caller, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const view = async () => {
    const read = readBrain();
    const candidates = catalog({ codexModels: containEnabled() && containAvailable() && activeCodexCredential() !== null ? codexModelsHere() : null });
    const [budget, allowed] = [await routerBudget(), loadRoles({ computer: computerName() }).foreman.workerModels];
    // This computer's projects, so a rule naming none of them is said to do nothing here.
    const { projects } = await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH).catch(() => ({ projects: [] as Project[] }));
    const named = await Promise.all(
      projects.filter((project) => project.machine === os.hostname()).map(async (project) => ({ id: project.id, name: project.name, key: await projectKeyFor(project).catch(() => undefined) })),
    );
    return brainView({
      machine: os.hostname(),
      brain: read.brain,
      refused: read.refused,
      candidates,
      allowed,
      modelAllowed,
      budget,
      projects: named.map(({ key, ...rest }) => (key ? { ...rest, key } : rest)),
    });
  };
  if (request.method === "GET") return sendJson(response, 200, await view());
  if (request.method !== "POST") return sendJson(response, 405, { error: "GET or POST" });
  if (!mayChange(caller.kind)) return sendJson(response, 403, { error: "only the desk app you linked may change the router's rules" });
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request, 65_536));
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  const taken = acceptBrain(body, readBrain().brain);
  if ("error" in taken) return sendJson(response, taken.status, { error: taken.error });
  writeBrain(taken.brain);
  console.log(`[${SERVICE}] brain revision ${taken.brain.revision} by ${caller.name}: ${taken.brain.rules.length} rule(s)`);
  return sendJson(response, 200, await view());
}

/**
 * Settings → Engines (engines.ts): GET /settings/engines says which engine
 * each role starts on here; POST {lead?, foreman?, session?, worker?} changes
 * them, the desk's key only. A change applies to each role's next
 * conversation; a running session keeps the engine it started on.
 */
async function handleEngines(caller: Caller, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const view = async () => ({
    machine: os.hostname(),
    engines: readEngines(),
    codex: activeCodexCredential() !== null,
    contained: containEnabled() && containAvailable(),
    // Whether Claude, Codex and Ollama are ready here, with what to do for one that is not (modelSources.ts).
    sources: await liveSources(),
  });
  if (request.method === "GET") return sendJson(response, 200, await view());
  if (request.method !== "POST") return sendJson(response, 405, { error: "GET or POST" });
  if (!mayChange(caller.kind)) return sendJson(response, 403, { error: "only the desk app you linked may change the engines" });
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request));
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  const before = readEngines();
  const changed = changeEngines(before, body, activeCodexCredential() !== null);
  if ("error" in changed) return sendJson(response, changed.status, { error: changed.error });
  writeEngines(changed.engines);
  const lines = (Object.keys(changed.engines) as (keyof typeof before)[]).filter((role) => before[role] !== changed.engines[role]).map((role) => `${role} ${before[role]} → ${changed.engines[role]}`);
  console.log(`[${SERVICE}] engines by ${caller.name}: ${lines.join(", ") || "no change"}`);
  return sendJson(response, 200, await view());
}

/**
 * Settings → Projects (folders.ts): GET /settings/folders lists where this
 * computer looks for projects (`roots`) and which of them were added here
 * (`added`); POST {add} or {remove} changes the added ones, the desk's key only, and answers with the new view and a line to show.
 */
async function handleFolders(caller: Caller, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const configPath = process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH;
  const view = async () => {
    const { roots, added } = await loadRegistry(configPath);
    return { machine: os.hostname(), home: homedir(), roots, added };
  };
  if (request.method === "GET") return sendJson(response, 200, await view());
  if (request.method !== "POST") return sendJson(response, 405, { error: "GET or POST" });
  if (!mayChange(caller.kind)) return sendJson(response, 403, { error: "only the desk app you linked may change where projects are looked for" });
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request));
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  const { roots, added } = await loadRegistry(configPath);
  const changed = await changeFolders(readFolders(), roots.filter((root) => !added.includes(root)), body);
  if ("error" in changed) return sendJson(response, changed.status, { error: changed.error });
  writeFolders(changed.folders);
  console.log(`[${SERVICE}] project folders by ${caller.name}: ${changed.said}`);
  return sendJson(response, 200, { ...(await view()), said: changed.said });
}

async function handleLocalRepos(response: http.ServerResponse): Promise<void> {
  const { projects, roots } = await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH);
  return sendJson(response, 200, await collectRepos(roots, projects));
}

async function handleGithubRepos(url: URL, response: http.ServerResponse): Promise<void> {
  const { projects, roots } = await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH);
  const github = await githubState();
  if (github.gh === null) {
    return sendJson(response, 409, { error: "gh is not installed on this machine" });
  }
  if (!github.authed) {
    return sendJson(response, 409, {
      error: "gh is installed but not logged in; run `gh auth login` there",
    });
  }

  // Clash is relative to where the clone would land, so the app can mark a name
  // before you tap it rather than after the create call 409s.
  const requested = url.searchParams.get("root");
  const root = roots.find((candidate) => candidate === requested) ?? roots[0] ?? homedir();
  // This machine's ids only. A name another machine holds is no longer a
  // clash — create.ts suffixes it — and marking it here would talk you out of
  // a clone that would in fact have worked.
  const here = os.hostname();
  const ids = new Set(
    projects.filter((project) => project.machine === here).map((project) => project.id),
  );
  const onDisk = new Set<string>();
  try {
    for (const entry of await readdir(root)) onDisk.add(entry);
  } catch {
    // An unreadable root just means nothing is known to clash.
  }

  try {
    const repos = await listRepos(github.gh, (name) => ids.has(name) || onDisk.has(name));
    return sendJson(response, 200, { machine: os.hostname(), repos });
  } catch (caught) {
    if (caught instanceof SessionError) {
      return sendJson(response, caught.status, { error: caught.message });
    }
    throw caught;
  }
}

const CREATE_MODES = ["adopt", "clone", "init"] as const;

async function handleProjectCreate(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "POST only" });
  }

  // By hand, like /session and /dispatch: @cobra/contracts is types-only here.
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(request)) as Record<string, unknown>;
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }

  const mode = CREATE_MODES.find((known) => known === body.mode);
  if (!mode) {
    return sendJson(response, 400, { error: `mode must be one of ${CREATE_MODES.join(", ")}` });
  }
  const text = (key: string): string | undefined =>
    typeof body[key] === "string" ? (body[key] as string) : undefined;

  const [{ projects, roots }, github] = await Promise.all([
    loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH),
    githubState(),
  ]);

  // A trade this build does not know is refused, not dropped: a project made
  // without its trade would start a plain Foreman the person did not ask for.
  const template = text("foremanTemplate");
  if (template !== undefined && !knownTrade(template)) {
    return sendJson(response, 400, { error: unknownTemplateError() });
  }

  try {
    const result = await createProject(
      liveCreateDeps({
        machine: os.hostname(),
        roots,
        registered: projects,
        gh: github.gh,
        githubAuth: github.authed,
      }),
      {
        mode,
        name: text("name"),
        path: text("path"),
        root: text("root"),
        directory: text("directory"),
        repo: text("repo"),
        session: text("session"),
        note: text("note"),
        foremanTemplate: template,
        remote: body.remote === true,
        // A template's entry point is its Foreman, never a generic Claude
        // session in the repository. The project is still made and trusted by
        // createProject before the Foreman gets a key.
        start: template ? false : body.start !== false,
      },
    );
    let foreman: { session: string; path: string } | undefined;
    if (template && body.start !== false) {
      try {
        foreman = await startForeman(result.project);
      } catch (caught) {
        result.warnings.push(caught instanceof Error ? `could not start the ${template} Foreman (${caught.message})` : `could not start the ${template} Foreman`);
      }
    }
    console.log(
      `[${SERVICE}] created "${result.project.id}" (${result.did}) at ${result.project.path}` +
        `${result.started ? " and started it" : ""}` +
        `${result.warnings.length > 0 ? ` — ${result.warnings.join("; ")}` : ""}`,
    );
    return sendJson(response, 200, {
      ok: true,
      project: result.project,
      did: result.did,
      started: result.started,
      trusted: result.trusted,
      ...(foreman ? { foreman } : {}),
      remoteUrl: result.remoteUrl,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    });
  } catch (caught) {
    if (caught instanceof SessionError) {
      return sendJson(response, caught.status, { error: caught.message });
    }
    throw caught;
  }
}

async function handleProjectRemove(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "POST only" });
  }
  let body: { id?: unknown };
  try {
    body = JSON.parse(await readBody(request)) as typeof body;
  } catch {
    return sendJson(response, 400, { error: "invalid JSON body" });
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (id.length === 0) return sendJson(response, 400, { error: "id is required" });

  // Only ever the local registry. A tracked project would come back on the next
  // deploy, and a card that reappears reads as a bug rather than as a refusal.
  const removed = await removeLocal(id);
  if (!removed) {
    return sendJson(response, 409, {
      error: "no project made here has that id; a tracked one is removed in the repo",
    });
  }
  console.log(`[${SERVICE}] removed local project "${id}"`);
  // The directory is deliberately left alone: unregistering is not deleting,
  // and the scan will offer it again.
  return sendJson(response, 200, { ok: true, id });
}

async function handleTemplates(response: http.ServerResponse): Promise<void> {
  const configured = await loadDispatchConfig(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH);
  return sendJson(response, 200, {
    host: os.hostname(),
    templates: configured.templates.map((template) => ({
      id: template.id,
      name: template.name,
      prompt: template.prompt,
    })),
  });
}

/**
 * A metric series. `hours` is bounded because the only caller is a phone
 * drawing a chart, and an unbounded window would happily serialise a year of
 * minute samples into a notification-sized screen.
 */
function handleHistory(url: URL, response: http.ServerResponse): void {
  const metric = url.searchParams.get("metric") ?? "cpu";
  const scope = url.searchParams.get("scope") ?? "";
  const requested = Number(url.searchParams.get("hours") ?? 24);
  const hours = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 24 * 90) : 24;
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  return sendJson(response, 200, {
    host: os.hostname(),
    metric,
    scope,
    hours,
    points: store.series(metric, scope, since),
  });
}

/** How long each project's agent has actually been working, in minutes. */
function handleActivity(url: URL, response: http.ServerResponse): void {
  const requested = Number(url.searchParams.get("days") ?? 7);
  const days = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 365) : 7;
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  return sendJson(response, 200, {
    host: os.hostname(),
    days,
    totals: store.activityTotals(since),
  });
}

/**
 * What is wrong with this machine right now. Distinct from the pushes, which
 * are edges: a phone that registered after a disk filled up would never have
 * received that edge, and this is where it finds out.
 */
function handleAlerts(response: http.ServerResponse): void {
  const firing = lastConditions.filter((condition) => alertState.get(condition.id)?.firing);
  return sendJson(response, 200, {
    host: os.hostname(),
    checkedAt: lastCheckedAt,
    alerts: firing.map((condition) => ({
      id: condition.id,
      level: condition.level,
      title: condition.title,
      body: condition.body,
    })),
  });
}

/**
 * The security audit (audit.ts, auditGather.ts): every check, run now, for
 * Fleet → Security → Security audit on the desk. Read-only, so
 * a `read` key is enough, as for /posture. Two callers at once share one run.
 */
/** The limits and export folders in files.json (files.ts). */
const filesConfig = () => loadFilesConfig(process.env.COBRA_FILES_CONFIG ?? DEFAULT_FILES_CONFIG);

function declaredLength(request: http.IncomingMessage): number | null {
  const raw = request.headers["content-length"];
  const value = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : null;
}

/**
 * One file's bytes from this computer (browse.ts), for the desk: a report, a
 * picture, a page a Worker wrote. A GET, so `read` is enough.
 */
async function handleBrowse(
  route: string,
  url: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const roots = browseRoots();
  const path = url.searchParams.get("path") ?? "";
  try {
    if (request.method !== "GET") return sendJson(response, 405, { error: "GET only" });
    if (route === "/fs/get") {
      const file = await openFile(roots, path);
      const stream = createReadStream(file.path);
      await new Promise<void>((resolve, reject) => {
        stream.once("open", () => resolve());
        stream.once("error", reject);
      }).catch(() => {
        throw new SessionError("that file cannot be read", 403);
      });
      response.writeHead(200, {
        "content-type": mimeFor(file.name),
        "content-length": file.size,
        "content-disposition": disposition(file.name),
        "last-modified": new Date(file.modifiedAt).toUTCString(),
        "cache-control": "no-store",
        ...FILE_HEADERS,
      });
      stream.on("error", () => response.destroy());
      response.on("close", () => stream.destroy());
      stream.pipe(response);
      return;
    }
    return sendJson(response, 404, { error: "not found", route });
  } catch (caught) {
    if (caught instanceof SessionError) return sendJson(response, caught.status, { error: caught.message });
    throw caught;
  }
}

/**
 * An image for a Claude Code or Codex session (attachments.ts): saved in the
 * session's own folder, where the session, a Worker's sandbox included, can
 * read it. The app then says "<text> [Image: <path>]". A POST, so `act`.
 */
async function handleAttach(url: URL, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (request.method !== "POST") return sendJson(response, 405, { error: "POST only" });
  const session = url.searchParams.get("session") ?? "";
  if (!SESSION_NAME.test(session)) return sendJson(response, 400, { error: "session must match [A-Za-z0-9._-]{1,64}" });
  const limits = await filesConfig();
  const maxBytes = Math.min(limits.maxBytes, ATTACH_MAX_BYTES);
  const declared = declaredLength(request);
  if (declared !== null && declared > maxBytes) return sendJson(response, 413, { error: "image is over the limit" });
  const found = (await collectTmux()).sessions.find((candidate) => candidate.name === session);
  if (!found) return sendJson(response, 404, { error: "no such session" });
  if (!isAgentCommand(found.command)) {
    return sendJson(response, 409, { error: `foreground is ${found.command}, not an agent` });
  }
  try {
    const saved = await saveAttachment({
      root: found.path,
      name: url.searchParams.get("name") ?? "",
      body: request,
      maxBytes,
      retainDays: limits.retainDays,
    });
    console.log(`[${SERVICE}] attached ${saved.path} (${saved.size} bytes) for ${session}`);
    return sendJson(response, 200, saved);
  } catch (caught) {
    if (caught instanceof SessionError) return sendJson(response, caught.status, { error: caught.message });
    throw caught;
  }
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  // Gzipped for a caller that asks (compress.ts): the phone's polls through its tunnel. An error body is redacted (secretValues.ts).
  const sent = encodeJson(JSON.stringify(sentBody(status, body)), response.req?.headers["accept-encoding"]);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": sent.body.length,
    "cache-control": "no-store",
    vary: "accept-encoding",
    ...(sent.gzip ? { "content-encoding": "gzip" } : {}),
  });
  response.end(sent.body);
}

// Notifications go to this computer's desktop (push.ts); the recipient list is always the one desktop.
const loadPushTokens = async (): Promise<Recipient[]> => [LOCAL_RECIPIENT];
const dropPushToken = async (_token: string): Promise<void> => undefined;
const push = (recipients: Recipient[], message: PushMessage) => sendPush(recipients, message);


// The agent's own tmux server reads this when it starts (tmuxHost.ts).
ensureTmuxConf();

/**
 * Each minute: a notification at 50%, 80% and 100% of the API lane's
 * monthly cap, once each a month (apiAlerts.ts).
 */
async function apiAlertTick(): Promise<void> {
  const facts = laneFactsNow();
  if (!facts || !facts.policy.enabled) return;
  const status = laneStatus();
  if (!status) return;
  const spent = status.facts.spentUsd;
  const cap = status.facts.policy.monthlyCapUsd;
  const alerts = readAlerts();
  const fresh = newThresholds(spent, cap, alerts, status.facts.month);
  if (fresh.length === 0) return;
  saveAlerts(markSent(alerts, status.facts.month, fresh));
  const text = alertText(Math.max(...fresh), spent, cap, new Date(nextMonthStart(Date.now())), testModeOf(status.facts.policy));
  console.log(`[${SERVICE}] api lane: ${text.title} (${text.body})`);
  const tokens = await loadPushTokens();
  if (tokens.length === 0) return;
  const outcome = await push(tokens, { title: text.title, body: text.body, data: { machine: os.hostname(), kind: "api-lane" } });
  for (const error of outcome.errors) console.log(`[${SERVICE}] push ticket: ${error}`);
  for (const token of outcome.dead) await dropPushToken(token);
}

/** GET /api-lane: the API lane on this computer, for Settings → Claude and the desk. Never the key. */
function apiLaneView(): Record<string, unknown> {
  const status = laneStatus();
  const facts = status?.facts ?? laneFactsNow();
  const policy = facts?.policy ?? { enabled: false, monthlyCapUsd: 0 };
  return {
    machine: computerName(),
    enabled: policy.enabled,
    capUsd: policy.monthlyCapUsd,
    key: facts?.key ?? false,
    workspace: status?.workspace ?? false,
    keptToken: keptTokenAt(CLAUDE_TOKEN_PATH)(),
    gateway: status?.gateway ?? false,
    open: status?.open ?? (facts ? laneState(facts).open : false),
    why: status?.why ?? "the agent has not read the lane yet",
    month: facts?.month ?? "",
    resetsAt: new Date(nextMonthStart(Date.now())).toISOString(),
    here: status?.here ?? { dollars: 0, requests: 0, byRole: {} },
    fleetUsd: facts?.spentUsd ?? 0,
    lastError: status?.lastError ?? null,
    testMode: policy.testMode === true,
    test: testView(),
  };
}

// The test's report reads the whole ledger: kept for 30 s, as Settings polls.
let testViewKept: { at: number; view: Record<string, unknown> | null } | null = null;
function testView(): Record<string, unknown> | null {
  if (testViewKept && Date.now() - testViewKept.at < 30_000) return testViewKept.view;
  const report = currentTestReport();
  const view = report ? { here: testModeOn(), ...report } : null;
  testViewKept = { at: Date.now(), view };
  return view;
}

const limiter = createRateLimiter();

const server = http.createServer((request, response) => {
  // The base is a formality — the agent only ever sees origin-form request
  // targets — but it is what lets the query string be parsed properly.
  const url = new URL(request.url ?? "/", "http://agent.invalid");
  const route = url.pathname;

  void (async () => {
    try {
      // /health stays open so a reachability check never depends on a
      // credential — it reports liveness, not anything sensitive.
      if (route === "/health") return sendJson(response, 200, buildHealth());

      const gate = authorize(request.headers.authorization, route, request.method, config.keys);
      if (!gate.ok) {
        noteRejection(route);
        return sendJson(response, gate.status, {
          error: gate.error ?? (gate.status === 401 ? "unauthorized" : "not allowed for this key"),
          ...(gate.expired ? { expired: true } : {}),
        });
      }
      const caller = gate.caller;
      // When this key stops working, so the desk rotates it in time (keys.ts).
      if (caller.expiresAt !== undefined) response.setHeader(KEY_EXPIRES_HEADER, String(caller.expiresAt));

      // How often each key may call, and how many waits and searches it holds open (rateLimit.ts).
      const admitted = limiter.admit(caller, route);
      if (!admitted.ok) {
        response.setHeader("retry-after", String(admitted.retryAfter));
        return sendJson(response, 429, { error: admitted.error });
      }
      response.once("close", admitted.release);

      // The keys themselves (keyRoutes.ts): the list and a rotation.
      if (route === "/keys" || route === "/keys/rotate") {
        const body = request.method === "POST" ? await readBody(request).catch(() => "") : "";
        const reply = keyRoute(route, request.method, caller, bearer(request.headers.authorization), body, config.keys, os.hostname(), Date.now());
        if (reply.status === 200 && route !== "/keys") console.log(`[${SERVICE}] rotated the key of ${caller.kind} ${caller.name}`);
        return sendJson(response, reply.status, reply.body);
      }

      if (route === "/notices") {
        // What the watcher told you about sessions (notices.ts), for the desk: after= the last seq it read, boot= the run it read it from.
        const after = Number(url.searchParams.get("after") ?? "");
        return sendJson(response, 200, { machine: os.hostname(), ...notices.since(Number.isFinite(after) && url.searchParams.has("after") ? after : null, url.searchParams.get("boot")) });
      }
      if (route === "/events") {
        // What happened here since a time (events.ts), for the daily brief.
        const since = Date.parse(url.searchParams.get("since") ?? "");
        return sendJson(response, 200, { machine: os.hostname(), events: readEvents(Number.isFinite(since) ? since : Date.now() - 24 * 60 * 60_000) });
      }

      // The audit log (auditTrail.ts), read only, for this computer's desk: newest first, a page at a time.
      if (route === "/audit/log") {
        const reply = auditRoute(caller, request.method, url.searchParams);
        return sendJson(response, reply.status, reply.body);
      }

      // Approvals (approvals.ts): what the Lead asked and only you may allow.
      if (route === "/approvals" || route === "/approvals/answer") return await handleApprovals(route, request, response, caller);

      // The owner's permission policy (permissions.ts, policyEdit.ts): Settings → Permissions on the desk.
      if (route === "/policy" || route === "/policy/preview" || route === "/policy/refused") return await handlePolicy(route, caller, request, response);

      // The API lane here (modelGateway.ts): Settings → Claude on the desk.
      if (route === "/api-lane") {
        if (request.method !== "GET") return sendJson(response, 405, { error: "GET only" });
        return sendJson(response, 200, apiLaneView());
      }

      // Local models here and Cobra's check of each (localCheck.ts): Settings → Local models on the desk.
      if (route === "/local" || route === "/local/check") return await handleLocal(route, request, response);

      // The router's rules, benchmarks, windows and picks here (brain/view.ts): Settings → Brain on the desk.
      if (route === "/brain") return await handleBrain(caller, request, response);

      // Which engine each role starts on here (engines.ts): Settings → Engines on the desk.
      if (route === "/settings/engines") return await handleEngines(caller, request, response);

      // Where projects are looked for here (folders.ts): Settings → Projects → Add a folder.
      if (route === "/settings/folders") return await handleFolders(caller, request, response);

      // More than one Claude and Codex account here, and which one is in use (accounts.ts).
      if (route === "/accounts" || route.startsWith("/accounts/")) return await handleAccounts(route, url, request, response);

      // MCP servers for the Lead and Foremen (mcp.ts, mcpRoutes.ts).
      if (route === "/mcp" || route === "/mcp/toggle" || route === "/mcp/verify" || route === "/mcp/connect" || route === "/mcp/disconnect") return await handleMcp(route, caller, request, response);

      // The owner's Cloudflare connection here, for the Website Builder (cloudflare.ts). A phone's or desk's key only.
      if (CLOUDFLARE_ROUTES.has(route)) {
        const body = request.method === "POST" ? await readBody(request).catch(() => "") : "";
        const reply = await handleCloudflare(route, request.method, body, caller, cloudflare);
        return sendJson(response, reply.status, reply.body);
      }

      // Google's connectors as this computer's agents see them, and a project's records: journal and Undo (personRoutes.ts). A desk's key only.
      if (PERSON_ROUTES.has(route)) {
        const body = PERSON_POSTS.has(route) && request.method === "POST" ? await readBody(request).catch(() => "") : "";
        const here = async () => (await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH)).projects.filter((project) => project.machine === os.hostname());
        const reply = await handlePerson(route, request.method, url, body, caller, livePersonDeps(here, tellLine, (line) => console.log(`[${SERVICE}] ${line}`), billsAfterImport));
        return sendJson(response, reply.status, reply.body);
      }

      // Cobra's Notebook (notebook.ts): this computer's memory notes for the desk. A phone's or desk's key only.
      if (NOTEBOOK_ROUTES.has(route)) {
        if (!PERSON_KINDS.has(caller.kind)) return sendJson(response, 403, { error: "only the desk app you linked reads the notebook" });
        const body = request.method === "POST" ? await readBody(request).catch(() => "") : "";
        const reply = handleNotebook({ root: MEMORY_DIR, computer: computerName(), now: Date.now, ticksPath: TICKS_PATH }, route, request.method ?? "GET", url, body);
        return sendJson(response, reply.status, reply.body);
      }

      // Receipts scanned on the phone (receipts.ts): a photo into the Space's receipts folder, then read into Money. A phone's or desk's key only.
      if (route === "/receipts/add" || route === "/receipts/read") {
        if (!PERSON_KINDS.has(caller.kind)) return sendJson(response, 403, { error: "only the desk app you linked sends receipts" });
        if (request.method !== "POST") return sendJson(response, 405, { error: "POST only" });
        const project = url.searchParams.get("project") ?? "";
        if (route === "/receipts/add") {
          const declared = declaredLength(request);
          if (declared !== null && declared > 20 * 1024 * 1024) return sendJson(response, 413, { error: "the photo is over 20 MB" });
          const reply = await addReceipt(project, request, receiptDeps());
          return sendJson(response, reply.status, reply.body);
        }
        let body: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(await readBody(request)) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        } catch {
          return sendJson(response, 400, { error: "send JSON: {project, files}" });
        }
        const reply = startReading(typeof body.project === "string" ? body.project : project, body, receiptDeps());
        return sendJson(response, reply.status, reply.body);
      }

      // All money (allMoney.ts): every Money seat's month here, in one currency. A phone's or desk's key only.
      if (route === "/money/all") {
        if (!PERSON_KINDS.has(caller.kind)) return sendJson(response, 403, { error: "only the desk app you linked reads All money" });
        if (request.method !== "GET") return sendJson(response, 405, { error: "GET only" });
        return sendJson(response, 200, allMoney(liveAllMoneyDeps(os.hostname(), (line) => console.log(`[${SERVICE}] ${line}`)), url.searchParams.get("month"), url.searchParams.get("to")));
      }

      // Bank statements dropped on the Finance tab (statements.ts): a CSV or PDF into the Space's statements folder, then read into Money. A phone's or desk's key only.
      if (route === "/statements/add" || route === "/statements/read") {
        if (!PERSON_KINDS.has(caller.kind)) return sendJson(response, 403, { error: "only the desk app you linked sends statements" });
        if (request.method !== "POST") return sendJson(response, 405, { error: "POST only" });
        const project = url.searchParams.get("project") ?? "";
        if (route === "/statements/add") {
          const declared = declaredLength(request);
          if (declared !== null && declared > STATEMENT_MAX_BYTES) return sendJson(response, 413, { error: "the statement is over 10 MB" });
          const reply = await addStatement(project, url.searchParams.get("name") ?? "", request, statementDeps());
          return sendJson(response, reply.status, reply.body);
        }
        let body: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(await readBody(request)) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        } catch {
          return sendJson(response, 400, { error: "send JSON: {project, file, name?, account_id?}" });
        }
        const reply = await readStatement(typeof body.project === "string" ? body.project : project, body, statementDeps());
        return sendJson(response, reply.status, reply.body);
      }

      // How a Space's Foremen work here, standing or on-call (spaceForemen.ts): the person's desk, signed as above.
      const foremenRoute = SPACE_FOREMEN_ROUTE.exec(route);
      if (foremenRoute) {
        const body = request.method === "POST" ? await readBody(request).catch(() => "") : "";
        const reply = handleSpaceForemen(foremenRoute[1]!, request.method, body, caller, (line) => console.log(`[${SERVICE}] ${line}`));
        return sendJson(response, reply.status, reply.body);
      }

      // The trades here (trades.ts): shipped and defined, for the phone's and the desk's new-project pickers.
      // The morning brief (morning.ts): whether this computer sends it, its hour and on or off, and today's.
      if (route === "/morning") {
        if (!PERSON_KINDS.has(caller.kind)) return sendJson(response, 403, { error: "only the desk app you linked reads or sets the morning brief" });
        if (request.method === "POST") {
          let raw: unknown;
          try {
            raw = JSON.parse(await readBody(request));
          } catch {
            return sendJson(response, 400, { error: "the body is JSON: {enabled?, at?}" });
          }
          const settings = parseSettings(raw, loadSettings());
          if (typeof settings === "string") return sendJson(response, 400, { error: settings });
          saveSettings(settings);
        } else if (request.method !== "GET") return sendJson(response, 405, { error: "GET or POST" });
        return sendJson(response, 200, { sends: sendsMorning(), settings: loadSettings(), latest: loadLatest() });
      }

      if (route === "/trades") {
        if (!PERSON_KINDS.has(caller.kind)) return sendJson(response, 403, { error: "only the desk app you linked reads /trades" });
        if (request.method !== "GET") return sendJson(response, 405, { error: "GET only" });
        return sendJson(response, 200, { trades: allTrades() });
      }

      // A card's branded email drawn for a WebView (emailRoutes.ts): a template draft with sample values, or a send as it will go. A phone's or desk's key only.
      if (PERSON_EMAIL_ROUTES.has(route)) {
        const emailDeps = { approvals: { load: () => loadApprovals(), save: (list: StoredApproval[]) => saveApprovals(list) }, spaceById, place: themePlace, drafts: draftsIn, editDraft: editDraftLive, now: () => Date.now() };
        const reply =
          route === "/email/batch" && request.method === "POST"
            ? handleBatchEdit("POST", await readBody(request).catch(() => ""), caller, emailDeps, PERSON_KINDS)
            : handleEmailPerson(route, request.method ?? "GET", url, caller, emailDeps, PERSON_KINDS);
        return sendJson(response, reply.status, reply.body);
      }

      // Mailboxes with an app password (mailboxes.ts, phase 7): iCloud and Zoho, added on the desk, chosen per Space.
      if (MAILBOX_ROUTES.has(route)) {
        const boxBody = request.method === "POST" ? await readBody(request).catch(() => "") : "";
        const reply = await handleMailboxes(route, request.method ?? "GET", boxBody, caller, { spaces: () => listSpaces().map((space) => ({ id: space.id, name: space.name })), now: () => new Date(), log: (line) => console.log(`[${SERVICE}] ${line}`) }, PERSON_KINDS);
        return sendJson(response, reply.status, reply.body);
      }

      // The desk's email block editor (emailRoutes.ts handleEmailEditor, phase 6): a Space's templates, a live draw, and propose as a template card.
      if (EDITOR_ROUTES.has(route)) {
        const editorBody = EDITOR_POSTS.has(route) && request.method === "POST" ? await readBody(request).catch(() => "") : "";
        const configPath = process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH;
        const deps = liveEmailRouteDeps({
          configPath,
          notify: notifyApproval,
          log: (line) => console.log(`[${SERVICE}] ${line}`),
          approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) },
          project: async (id) => (await loadRegistry(configPath).catch(() => ({ projects: [] as Project[] }))).projects.find((project) => project.id === id),
        });
        const reply = await handleEmailEditor(route, request.method ?? "GET", url, editorBody, caller, deps, PERSON_KINDS);
        return sendJson(response, reply.status, reply.body);
      }

      // The Marketing board (marketing.ts): templates, what goes out next, campaigns, audience, sequences; a preview, Send me a test and Archive.
      if (MARKETING_ROUTES.has(route)) {
        const marketingBody = MARKETING_POSTS.has(route) && request.method === "POST" ? await readBody(request).catch(() => "") : "";
        const configPath = process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH;
        const projects = async () => (await loadRegistry(configPath).catch(() => ({ projects: [] as Project[] }))).projects;
        const deps = marketingDeps({ project: async (id) => (await projects()).find((project) => project.id === id), projects, log: (line) => console.log(`[${SERVICE}] ${line}`) });
        const reply = await handleMarketing(route, request.method ?? "GET", url, marketingBody, caller, deps, PERSON_KINDS);
        return sendJson(response, reply.status, reply.body);
      }

      // Routines (routines.ts, routineRoutes.ts): the list, Pause or Resume, Remove and Run now, for the desk.
      if (PERSON_ROUTINE_ROUTES.has(route)) {
        const body = PERSON_ROUTINE_POSTS.has(route) && request.method === "POST" ? await readBody(request).catch(() => "") : "";
        const reply = await handleRoutinePerson(route, request.method, url, body, caller, routineDeps());
        return sendJson(response, reply.status, reply.body);
      }

      // My Organization (orgRoutes.ts): which company each Foreman works for, for the desk.
      if (PERSON_ORG_ROUTES.has(route)) {
        const body = request.method === "POST" ? await readBody(request).catch(() => "") : "";
        const reply = await handleOrgPerson(route, request.method, body, caller, orgDeps());
        return sendJson(response, reply.status, reply.body);
      }

      // Research runs (webRuns.ts): GET /web/runs?days= lists them with their reads; POST /web/runs/stop {id} ends one. For the desk.
      if (route === "/web/runs" || route === "/web/runs/stop") {
        if (caller.kind !== "desk") return sendJson(response, 403, { error: "only the desk app you linked reads and stops research runs" });
        if (route === "/web/runs") {
          if (request.method !== "GET") return sendJson(response, 405, { error: "GET only" });
          const days = Math.min(14, Math.max(1, Number(url.searchParams.get("days") ?? 7) || 7));
          return sendJson(response, 200, { runs: runsView(loadRuns(), Date.now(), days) });
        }
        if (request.method !== "POST") return sendJson(response, 405, { error: "POST only" });
        let body: { id?: unknown };
        try {
          body = JSON.parse((await readBody(request)) || "{}") as { id?: unknown };
        } catch {
          return sendJson(response, 400, { error: "invalid JSON body" });
        }
        if (typeof body.id !== "string") return sendJson(response, 400, { error: "id is required" });
        const stopped = stopRun({ load: () => loadRuns(), save: (list) => saveRuns(list), tell: tellLine, now: () => Date.now() }, body.id);
        return sendJson(response, stopped.status, stopped.run ? { run: stopped.run } : { error: stopped.error });
      }

      // What Cobra did (decided.ts): everything decided without you this week, each with its Undo; for the desk.
      if (route === "/decided" || route === "/decided/undo") {
        return await handleDecided(route, url, request, response, caller);
      }

      // Trust (actionTrust.ts, trustRoutes.ts): the grants, the keys that always ask and the receipts; Revoke and Clear, for the desk.
      if (PERSON_TRUST_ROUTES.has(route)) {
        const body = PERSON_TRUST_POSTS.has(route) && request.method === "POST" ? await readBody(request).catch(() => "") : "";
        const reply = await handleTrustPerson(route, request.method, url, body, caller, trustDeps());
        return sendJson(response, reply.status, reply.body);
      }

      // A project's Foreman (foreman.ts): start, stop, a new conversation, for the desk.
      if (route === "/foreman" || route === "/foreman/start" || route === "/foreman/stop" || route === "/foreman/clear") {
        return await handleForeman(route, url, request, response);
      }

      // A Foreman's name and look (crew.ts), for the desk.
      if (route === "/crew") return await handleCrew(request, response);
      // The roster and the person's own changes to it (specialists.ts).
      if (route === "/specialists" || route === "/specialists/set") return await handleSpecialists(route, request, response, caller);

      // The Lead (lead.ts): its state, and start and stop, for the desk.
      if (route === "/lead" || route === "/lead/start" || route === "/lead/stop" || route === "/lead/clear") {
        try {
          if (route === "/lead/start" && request.method === "POST") await startLead();
          else if (route === "/lead/stop" && request.method === "POST") await stopLead();
          // A new conversation, as a fresh start so it has today's MCP servers (lead.ts newLeadConversation): its Workers keep running, and status shows them again.
          else if (route === "/lead/clear" && request.method === "POST") {
            // Her thread marks the conversation that starts as one the person asked for (thread.ts).
            thread.markNext("new-conversation");
            await ingestThread();
            // What this conversation left open, read by the next one first (leadRotation.ts).
            const note = await leadHandoff("new-conversation", CLEAR_HANDOFF_MS).catch(() => null);
            if (note) writeHandoff(note);
            try {
              await newLeadConversation(config.port);
            } catch (caught) {
              dropHandoff();
              throw caught;
            }
            console.log(`[${SERVICE}] Lead: new conversation`);
          }
          else if (route !== "/lead") return sendJson(response, 405, { error: "POST only" });
        } catch (caught) {
          if (caught instanceof SessionError) return sendJson(response, caught.status, { error: caught.message });
          throw caught;
        }
        return sendJson(response, 200, { session: LEAD_SESSION, path: leadHome(), running: await leadRunning() });
      }

      // The GitHub launcher's token (mcp.ts githubHandoff): answered here, not in handleOrch, whose answers are redacted.
      if (route === GITHUB_TOKEN_ROUTE) {
        if (request.method !== "GET") return sendJson(response, 405, { error: "GET only" });
        const reply = await githubHandoff(caller);
        console.log(`[${SERVICE}] github token ${reply.status === 200 ? "handed" : "refused"} to ${caller.kind} ${caller.name}`);
        return sendJson(response, reply.status, reply.body);
      }

      if (ORCH_ROUTES.has(route)) {
        return await handleOrch(route, url, request, response, {
          send: sendJson,
          readBody,
          configPath: process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH,
          log: (line) => console.log(`[${SERVICE}] ${line}`),
          caller,
          notify: notifyOrAct,
          announce: announce,
          // A Designer's designs go into the Lead's thread (designer.ts).
          thread: () => thread,
          // Merge on green goes in What Cobra did, and stops at its daily cap (decided.ts).
          decided: (entry) => recordDecided(entry),
          mergeCapLeft: () => underCap(loadDecided(), "merge"),
          tell: tellPerson,
          // The setting where one is written; else on under Instinct, unless a merge to main deploys (instinctActs.ts).
          mergeOnGreen: async (worktree, pr) => {
            const project = (await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH)).projects.find((entry) => entry.id === worktree.id) ?? worktree;
            const where = { computer: computerName(), project: await projectKeyFor(project).catch(() => undefined) };
            const read = readPolicyFile();
            if (read.refused) return false;
            const instinct = loadPolicy(where).escalate;
            // Read only when it would decide: a written setting, no Instinct or a local model's PR needs no git or GitHub.
            const reads = instinct && !pr.local && writtenMergeOnGreen(read.policy, where) === undefined;
            const deploys = reads ? await mergeDeploys(liveDeployReader(project.path), { repo: pr.repo, head: pr.head || undefined }) : null;
            if (deploys) console.log(`[${SERVICE}] ${project.id}: no merge on green under Instinct, since ${deploys}`);
            return mergeOnGreenAt(read.policy, where, instinct, () => deploys !== null, pr.local);
          },
          machineLabel: process.env.COBRA_MACHINE_NAME?.trim() || os.hostname(),
          port: config.port,
          trust: { deps: trustDeps(), carryOut: carryOutAction },
        });
      }

      if (VOICE_ROUTES.has(route)) return await handleVoice(route, url, request, response);

      switch (route) {
        case "/system":
          return sendJson(response, 200, await buildSystemStats());
        case "/tmux":
          return sendJson(response, 200, await collectTmux());
        case "/usage": {
          // With the orchestrator's budget and queue (queue.ts), for the phone's Usage widget.
          const usage = await collectUsage();
          return sendJson(response, 200, {
            ...usage,
            budget: pressures(usage.agents),
            queued: loadQueue().filter((item) => item.state === "waiting").length,
          });
        }
        case "/projects": {
          const collected = await collectProjects(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH);
          // A question Cobra is answering reads "Cobra is answering" in the apps (notifyPolicy.ts).
          const list = { ...collected, projects: markHandled(collected.projects, cobraAnswers) };
          // The API badge: a session whose last request went on the key (modelGateway.ts onKeyNow, by its id or tmux name).
          return sendJson(response, 200, { ...list, projects: list.projects.map((project) => (onKeyNow(project.id) || onKeyNow(project.session) ? { ...project, onKey: true } : project)) });
        }
        case "/history":
          return handleHistory(url, response);
        case "/history/activity":
          return handleActivity(url, response);
        case "/alerts":
          return handleAlerts(response);
        case "/ticket":
          return await handleTicket(request, response);
        case "/session":
          return await handleSession(request, response);
        case "/transcript":
          return await handleTranscript(url, response);
        case "/thread":
          return await handleThread(url, response);
        case "/thread/wait":
          return await handleThreadWait(url, response);
        case "/commands":
          return await handleCommands(url, response);
        case "/dispatch":
          return await handleDispatch(request, response);
        case "/session/new":
          return await handleNewSession(request, response);
        case "/session/attach":
          return await handleAttach(url, request, response);
        case "/templates":
          return await handleTemplates(response);
        case "/capabilities":
          return await handleCapabilities(response);
        case "/repos/local":
          return await handleLocalRepos(response);
        case "/repos/github":
          return await handleGithubRepos(url, response);
        case "/project/create":
          return await handleProjectCreate(request, response);
        case "/project/remove":
          return await handleProjectRemove(request, response);
        case "/git":
          return await handleGit(request, response);
        case "/power":
          return await handlePower(request, response);
        case "/git/repo":
          return await handleGitRepo(url, response);
        case "/git/tidy":
          return await handleGitTidy(response);
        case "/prs":
          return await handlePrs(response);
        case "/worklog":
          return await handleWorkLog(url, response);
        case "/fs/get":
          return await handleBrowse(route, url, request, response);
        default:
          return sendJson(response, 404, { error: "not found", route });
      }
    } catch (error) {
      console.error(`[${SERVICE}] ${route} failed:`, error);
      sendJson(response, 500, {
        error: "collector failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});

// Give the CPU collector a baseline so the first request returns a real
// utilisation figure rather than a zero.
await primeCpu();

// Node's defaults leave connections unbounded. A long poll holds its
// connection up to 300 s, but that is the reply: the request itself (an
// upload included) must arrive within five minutes, its headers within 20 s.
server.maxConnections = 512;
server.headersTimeout = 20_000;
server.requestTimeout = 300_000;

server.listen(config.port, config.bind, () => {
  console.log(
    `[${SERVICE}] ${config.version} listening on http://${config.bind}:${config.port} ` +
      `(host=${os.hostname()}, callers=${config.keys.load().callers.length}, ` +
      `tmux=${TMUX_SOCKET === "default" ? "your server" : `-L ${TMUX_SOCKET}`})`,
  );
  // Which Google connectors the Claude account has, so the Lead's first start already denies the others (connectors.ts).
  void lookForConnectors();
});

// Pushes for this machine's own sessions. Cheap while nobody is registered:
// the first thing a tick does is check for phones, and it stops there.
const stopWatcher = startWatcher({
  collect: () => collectProjects(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH, { git: false }),
  // Grades once a minute: Unpushed and Diverged move slowly, and the git
  // reads behind them are the ones the fast tick deliberately skips.
  collectGit: () => collectProjects(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH),
  gitEveryTicks: 12,
  tokens: loadPushTokens,
  send: push,
  forget: dropPushToken,
  // A permission prompt's push waits a few seconds for its plain-words rewrite.
  explain: (request) => liveExplainer.wait(request, PUSH_WAIT_MS),
  record: (transitions) =>
    recordEvents(
      transitions.map(({ kind, project }) => {
        const line = project.tail?.filter((text) => text.trim()).slice(-1)[0];
        return { kind, projectId: project.id, projectName: project.name, ...(line ? { detail: line.slice(0, 200) } : {}) };
      }),
    ),
  // Who hears of a session's moments (notifyPolicy.ts): the chain under a Lead reports upwards,
  // while the Lead runs; with it stopped, a briefed Foreman's questions reach the person.
  briefed: cobraAnswers,
  relaying: () => finishes.queued().length > 0,
  // What went out, for the desk (GET /notices), which follows the same rules.
  notice: (notice) => void notices.record(notice),
  // A desk alone also wants the charts' history, though it takes no pushes.
  // Notifications go to this computer's own desktop, so the watcher always watches.
  active: () => true,
  observe: async (list) => {
    // The charts' lanes (timeline.ts): a line only when an agent's state changes.
    timeline.recordStates(list.projects, loadQueue().filter((item) => item.state === "waiting"));
  },
  intervalMs: 5000,
  log: (line) => console.log(`[${SERVICE}] ${line}`),
});

/**
 * Samples this machine once a minute: writes the history and evaluates the
 * health conditions off the same reading. Unlike the watcher, this runs whether
 * or not a phone is registered — history is worth keeping on a machine nobody
 * has paired with yet, and the alert state machine has to stay warm so
 * /alerts is accurate the moment someone does pair.
 */
const stopRecorder = startRecorder({
  store,
  system: buildSystemStats,
  projects: () => collectProjects(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH, { git: false }),
  intervalMs: 60_000,
  primeDelayMs: 5_000,
  maintainEveryMs: 6 * 60 * 60_000,
  log: (line) => console.log(`[${SERVICE}] ${line}`),
  onSample: async (stats, at) => {
    // A burst of turned-away requests is worth a line in the log: something on this computer is trying keys.
    if (rejects >= REJECT_WARN_PER_SAMPLE) console.log(`[${SERVICE}] warning: ${rejects} requests turned away since the last sample, mostly ${topRejectedRoute() ?? "?"}`);
    rejects = 0;
    rejectRoutes.clear();

    const firing = new Set([...alertState].filter(([, entry]) => entry.firing).map(([id]) => id));
    const conditions = evaluate({ stats, units: await collectUnits(), firing, containment: containMode() });
    const changes = step(alertState, conditions, at);
    lastConditions = conditions;
    lastCheckedAt = new Date(at).toISOString();
    const serialized = serializeAlertState(alertState);
    if (serialized !== savedAlertState) {
      try {
        saveAlertState(ALERTS_PATH, serialized);
        savedAlertState = serialized;
      } catch (error) {
        console.log(`[${SERVICE}] alerts: could not save ${ALERTS_PATH}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (changes.length === 0) return;

    const tokens = await loadPushTokens();
    for (const change of changes) {
      const level = change.condition.level;
      console.log(`[${SERVICE}] alert ${change.kind}: ${change.condition.id} (${level})`);
      if (tokens.length === 0) continue;
      try {
        const outcome = await push(tokens, composeAlert(stats.host, change));
        for (const error of outcome.errors) console.log(`[${SERVICE}] push ticket: ${error}`);
        for (const token of outcome.dead) await dropPushToken(token);
      } catch (error) {
        console.log(
          `[${SERVICE}] alert push failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  },
});

/**
 * The git standard's timer: fetch every checkout and fast-forward a clean main
 * every ten minutes, so no card reads Behind for longer than that. Runs with
 * or without a phone registered — a stale checkout is stale either way.
 *
 * Optional (COBRA_GIT_SYNC=off, `install.sh --no-git-sync`): the git rules
 * are a policy, not every user's, and a second agent beside another one that
 * already syncs the same checkouts must not race it for git's locks.
 */
const gitSyncOn = process.env.COBRA_GIT_SYNC !== "off";
if (!gitSyncOn) console.log(`[${SERVICE}] git sync is off (COBRA_GIT_SYNC=off)`);
const stopGitSync = !gitSyncOn ? () => {} : startGitSync({
  collect: () => collectProjects(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH, { git: false }),
  intervalMs: 10 * 60_000,
  log: (line) => console.log(`[${SERVICE}] ${line}`),
  // A local land's trailer names its Worker; the record names the branch.
  workerBranches: async () => new Map((await workerRecords()).map((extra) => [extra.id, extra.branch])),
  afterTick: async (list) => {
    // A Worker whose PR merged is ended first, so the tidy below can remove it.
    for (const line of await endMergedWorkers(liveLifecycleDeps())) console.log(`[${SERVICE}] worker ended: ${line}`);
    const parents = list.projects.filter((project) => project.parent === undefined);
    for (const line of await tidyExtras(liveTidyDeps(parents, cachedMergedHeads))) {
      console.log(`[${SERVICE}] git: removed the worktree of ${line}`);
    }
    // A Worker's scope, settings and phase go with its record.
    await pruneWorkerFiles(await loadExtras());
  },
  // A PR that just went green: Merge and Open on the lock screen. Edge-based
  // (see detectPrGreen), so it needs no debounce of its own.
  onPrGreen: async (project, pr) => {
    recordEvents([{ kind: "pr-green", projectId: project.id, projectName: project.name, detail: `#${pr.number} ${pr.title}`.slice(0, 200) }]);
    // A project that merges on green says "Merged … on green" instead (orch.ts); a second push for the same PR is noise.
    const onGreen = loadRoles({ computer: computerName(), project: await projectKeyFor(project).catch(() => undefined) }).foreman.mergeOnGreen;
    if (onGreen) return;
    const tokens = await loadPushTokens();
    if (tokens.length === 0) return;
    const outcome = await push(tokens, {
      category: "pr-green",
      title: `PR #${pr.number} is green`,
      body: `${project.name}: ${pr.title} (${pr.head} → ${pr.base})`,
      // `head`: the commit that went green, which is all the lock-screen Merge may merge.
      data: { machine: os.hostname(), projectId: project.id, session: project.session, path: project.path, git: "pr-green", pr: pr.number, ...(pr.headSha ? { head: pr.headSha } : {}) },
    });
    for (const error of outcome.errors) console.log(`[${SERVICE}] push ticket: ${error}`);
    for (const token of outcome.dead) await dropPushToken(token);
  },
});

// Workers waiting for a place or for the budget (queue.ts): started as soon as both allow.
const queueTimer = setInterval(() => {
  void drainQueue(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH, (line) => console.log(`[${SERVICE}] ${line}`)).catch((error: unknown) =>
    console.log(`[${SERVICE}] queue: ${error instanceof Error ? error.message : String(error)}`),
  );
}, 20_000);

// Each Worker's finished turn, told to its Foreman or the Lead (finishes.ts). Its own
// tick: unlike the watcher's, it runs whether or not the desk is linked.
const relayDeps = liveFinishTickDeps(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH, (line) => console.log(`[${SERVICE}] ${line}`));
// Work a Foreman still has in flight past its Workers at work: a [cobra] line's turn at rest is no news for the Lead until it ends.
relayDeps.busy = async (project) => waitingFor(loadQueue(), project, Date.now()) || emailInFlight(project);

// The session budget (sessionKeeper.ts): it takes the relay's looks
// below, sleeps Cobra's idle Foremen, stops Workers whose work is done and offers your idle sessions.
const ownProjects = async (): Promise<Project[]> =>
  (await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH)).projects.filter((project) => project.machine === os.hostname() && project.parent === undefined);
const keeper = createKeeper({
  activity: { load: () => loadActivity(), save: (activity) => saveActivity(activity) },
  budget: liveBudget,
  // A Worker Cobra started herself reports to her (directWorkers.ts).
  reportRead: (worker) => finishes.unseen([worker.id], worker.startedBy === "lead" ? "lead" : worker.owner).length === 0,
  briefed: (project) => finishes.isBriefed(project),
  waitsOn: (project) => liveWaitsOn(project),
  sleep: async (id) => {
    const project = (await ownProjects()).find((candidate) => candidate.id === id);
    if (!project) return;
    finishes.slept(id, (line) => console.log(`[${SERVICE}] ${line}`));
    await stopForeman(project);
  },
  stopWorker: async (worker) => {
    const extra = (await workerRecords()).find((candidate) => candidate.id === worker.id);
    if (!extra) return;
    markRested(extra.id);
    await endWorker(extra);
  },
  yours: async () =>
    (await collectProjects(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH, { git: false })).projects.filter(
      (state) => state.machine === os.hostname() && !state.lead && !state.foreman && (!state.worker || state.worker.owner === "you") && state.session !== LEAD_SESSION,
    ),
  offer: (states) => {
    const card = closeCard(states, Date.now());
    keepCloseCard(card);
    void notifyApproval(card).catch((caught: unknown) => console.log(`[${SERVICE}] sessions: ${caught instanceof Error ? caught.message : String(caught)}`));
  },
  offered: { load: () => loadOffered(), save: (offered) => saveOffered(offered) },
  now: Date.now,
  log: (line) => console.log(`[${SERVICE}] ${line}`),
});
setForemanRoom((project) => keeper.makeRoom(project));

/** An allowed close-sessions card: each session still at rest is ended, as the card said. */
async function closeIdleSessions(closes: readonly string[]): Promise<void> {
  const states = (await collectProjects(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH, { git: false })).projects;
  for (const session of stillIdle(closes, states)) {
    if (!(await headlessAction(session, "kill", {}))) await runSessionAction("kill", session, {});
    console.log(`[${SERVICE}] sessions: closed ${session}, idle for 2 hours, as you allowed`);
  }
}

let relayWorkers: OrchWorker[] = [];
let relayForemen: OrchForeman[] = [];
// What a Foreman last said keeps its taint until its next conversation ends a turn (taint.ts reportTaint): its hook's Stop, or a headless session's ended turns, named here from the relay's look.
const foremanSessions = new Map<string, string>();
setTurnProbe(liveTurnProbe((project) => foremanSessions.get(project) ?? null));
const finishDeps: FinishTickDeps = {
  ...relayDeps,
  // A [cobra] line with someone's words in it (an email reply): the turn it starts is tainted.
  taint: (owner, source, why) => noteRead(ownerWho(owner), why, [], Date.now(), undefined, source),
  async workers() {
    const seen = await relayDeps.workers();
    relayWorkers = seen.map((entry) => entry.worker);
    return seen;
  },
  async foremen() {
    const seen = (await relayDeps.foremen?.()) ?? [];
    // A failed tmux listing reads as every Foreman stopped: the keeper looks only at a good one.
    if (seen.every((entry) => entry.listed !== false)) {
      relayForemen = seen.map((entry) => entry.foreman);
      for (const foreman of relayForemen) foremanSessions.set(foreman.project, foreman.session);
      keeper.see(relayForemen, relayWorkers);
    }
    return seen;
  },
  // A Foreman the keeper put to sleep gets nothing typed (onCall.ts, Figure 3).
  ...(relayDeps.router ? { router: { ...relayDeps.router, asleep: (project: string) => keeper.isAsleep(project) } } : {}),
};

/**
 * Each finish tick: the taint of a Worker that is gone ends (taint.ts
 * endGone). Workers that cannot be read leave every Worker's taint as it is.
 */
async function sweepTaint(): Promise<void> {
  const ids = await workerRecords()
    .then((extras) => new Set(extras.map((extra) => extra.id)))
    .catch(() => null);
  const ended = endGone((worker) => ids === null || ids.has(worker));
  if (ended.length) console.log(`[${SERVICE}] taint: ended for ${ended.join(", ")}`);
}

/**
 * The on-call Foremen's wakes (onCall.ts), after each finish tick: a plan
 * that ended gets its handoff and one final report, then the Foreman sleeps;
 * a conversation past 100,000 tokens starts afresh from a handoff. Standing
 * Spaces and code projects are never looked at past liveOnCallSpace.
 */
const contextRead = new Map<string, { at: number; tokens: number | null }>();
const restarting = new Set<string>();
async function onCallTick(): Promise<void> {
  if (relayForemen.length === 0) return;
  const projects = await ownProjects();
  const now = Date.now();
  for (const foreman of relayForemen) {
    const project = projects.find((candidate) => candidate.id === foreman.project);
    if (!project || restarting.has(project.id)) continue;
    const space = await liveOnCallSpace(project).catch(() => null);
    if (!space) continue;
    const finish = finishes.lastForeman(project.id);
    const workers = relayWorkers.filter((worker) => worker.owner === project.id && worker.startedBy !== "lead" && worker.activity !== null).length;
    const inFlight = workers > 0 ? `${workers} Worker(s) at work` : (liveWaitsOn(project.id) ?? (emailInFlight(project.id) ? "email still to send" : null));
    // Its context is read once per finished turn, from its transcript's last call.
    let tokens: number | null = null;
    if (foreman.running && finish?.kind === "idle") {
      const read = contextRead.get(project.id);
      if (read?.at === finish.at) tokens = read.tokens;
      else {
        const file = await sessionTranscriptFile(foreman.session).catch(() => null);
        tokens = file ? lastContextTokens(file) : null;
        contextRead.set(project.id, { at: finish.at, tokens });
      }
    }
    const step = onCall.step({
      project: project.id,
      running: foreman.running,
      briefed: finishes.isBriefed(project.id),
      finish: finish ? { kind: finish.kind, at: finish.at } : null,
      inFlight,
      contextTokens: tokens,
      leadReadAt: onCall.leadReadAt(project.id),
      now,
    });
    const log = (line: string) => console.log(`[${SERVICE}] on call: ${line}`);
    if (step === "wrap") {
      finishes.tell(project.id, WRAP_LINE);
      log(`${project.id}'s plan has ended: its Foreman writes its handoff and one final report, then sleeps`);
    } else if (step === "rotate") {
      finishes.tell(project.id, ROTATE_LINE);
      log(`${project.id}'s Foreman passed 100,000 tokens: it writes a handoff, then starts afresh`);
    } else if (step === "sleep") {
      if (await keeper.sleepNow(project.id, "on call: its plan ended and Cobra has its final report")) contextRead.delete(project.id);
    } else if (step === "restart") {
      // Not on the relay's tick: a start waits for its tools and its first line.
      restarting.add(project.id);
      const session = foremanSession(project);
      void (async () => {
        // Its stop is no news for Cobra, and she still hears from the new conversation.
        finishes.slept(project.id, log);
        await newForemanConversation(project, config.port);
        finishes.briefed(project.id);
        await typeBrief(waking(liveDeps(), session, "event", project.id), session, AFRESH_LINE, READY_TIMEOUT_MS);
        log(`${project.id}'s Foreman started afresh from its handoff note`);
      })()
        .catch((caught: unknown) => log(`${project.id}'s Foreman could not start afresh: ${caught instanceof Error ? caught.message : String(caught)}`))
        .finally(() => {
          restarting.delete(project.id);
          contextRead.delete(project.id);
        });
    }
  }
}

/**
 * A light routine's Worker in an on-call Space (routineRoutes.ts, Figure 2):
 * Cobra's own worker_spawn, run here as her local key, so it gets the same
 * start and the same refusals (directWorkers.ts) as one she asks for.
 */
async function routineWorker(project: Project, task: string): Promise<{ worker: string } | { queued: string } | { refused: string }> {
  let reply: { status: number; body: unknown } | null = null;
  const body = JSON.stringify({ project: project.id, task });
  const url = new URL("http://127.0.0.1/orch/worker/spawn");
  const request = { method: "POST", url: url.pathname, headers: {}, on: () => request } as unknown as http.IncomingMessage;
  await handleOrch(url.pathname, url, request, {} as http.ServerResponse, {
    send: (_response, status, sent) => void (reply ??= { status, body: sent }),
    readBody: async () => body,
    configPath: process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH,
    log: (line) => console.log(`[${SERVICE}] ${line}`),
    caller: { id: "lead", kind: "lead", name: "Cobra, for a light routine" },
    notify: notifyOrAct,
    machineLabel: process.env.COBRA_MACHINE_NAME?.trim() || os.hostname(),
    port: config.port,
  });
  const answered = reply as { status: number; body: unknown } | null;
  const sent = (answered?.body ?? {}) as { worker?: { id?: string }; queued?: { id?: string }; error?: string };
  if (answered?.status === 200 && sent.worker?.id) {
    // Its requests are the routine's in the ledger, marked light (wakes.ts).
    wakes.routineWorker(sent.worker.id, { routineLight: true });
    return { worker: sent.worker.id };
  }
  if (answered?.status === 202 && sent.queued?.id) return { queued: sent.queued.id };
  return { refused: `${answered?.status ?? 500} ${sent.error ?? "no answer"}` };
}

/** The nightly sweep (sessionSweep.ts): dead panes and orphan agent sessions ended, old parked Workers named; told in Cobra's thread here. */
async function sweepSessions(): Promise<void> {
  const state = loadSweep();
  if (!sweepDue(new Date(), state.lastRun)) return;
  const sessions = await listTmuxSessions();
  if (!sessions) return;
  const [projects, extras, running] = await Promise.all([ownProjects(), loadExtras(), runningSessions()]);
  const known = new Set([LEAD_SESSION, ...projects.flatMap((project) => [project.session, foremanSession(project)]), ...extras.map((extra) => extra.session)]);
  const plan = sweepPlan(sessions, known, new Set(state.reported));
  const removed: string[] = [];
  for (const { session, why } of plan.remove) {
    await killTmuxSession(session)
      .then(() => {
        removed.push(session);
        console.log(`[${SERVICE}] sweep: ended ${session}: ${why}`);
      })
      .catch((caught: unknown) => console.log(`[${SERVICE}] sweep: could not end ${session}: ${String(caught)}`));
  }
  const now = Date.now();
  const parked = extras.filter((extra) => extra.worker && !running.has(extra.session) && now - Date.parse(extra.createdAt) >= PARKED_REPORT_MS).map((extra) => extra.id);
  const report = sweepReport(plan, removed, parked);
  if (report) threadNotice("Nightly tidy", report);
  saveSweep({ lastRun: now, reported: plan.unknown });
}

let keeperBusy = false;
const keeperTimer = setInterval(() => {
  if (keeperBusy) return;
  keeperBusy = true;
  void keeper
    .tick()
    .then(() => sweepSessions())
    .catch((caught: unknown) => console.log(`[${SERVICE}] sessions: ${caught instanceof Error ? caught.message : String(caught)}`))
    .finally(() => {
      keeperBusy = false;
    });
}, 60_000);
keeperTimer.unref();
let finishBusy = false;
const finishTimer = setInterval(() => {
  if (finishBusy) return;
  finishBusy = true;
  void leadRunning()
    .then((up) => {
      leadUp = up;
      return finishes.tick(finishDeps);
    })
    .then(() => sweepTaint())
    .then(() => onCallTick())
    .catch((error: unknown) => console.log(`[${SERVICE}] finish: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      finishBusy = false;
    });
}, FINISH_TICK_MS);

// Cobra's thread follows her transcript while she runs here (thread.ts).
const threadTimer = setInterval(() => {
  if (leadUp) void ingestThread();
}, FINISH_TICK_MS);
threadTimer.unref();

// Her fresh start after two quiet hours (leadRotation.ts): asked once a minute.
let rotationBusy = false;
const rotationTimer = setInterval(() => {
  if (rotationBusy) return;
  rotationBusy = true;
  void rotateIfQuiet()
    .catch((caught: unknown) => console.log(`[${SERVICE}] Lead: fresh start: ${caught instanceof Error ? caught.message : String(caught)}`))
    .finally(() => {
      rotationBusy = false;
    });
}, 60_000);
rotationTimer.unref();

// Each orchestrator's line to this agent (orchSocket.ts): the Lead's always,
// and each running Foreman's (a Foreman outlives an agent restart), with keys
// minted now that only this process holds. Their expiry is pushed out hourly
// while they are served.
const orchLinesHere = new OrchLines({ port: config.port, keys: config.keys });
useOrchLines(orchLinesHere);
async function openOrchLines(): Promise<void> {
  await orchLinesHere.serve(LEAD_LINE, (now) => mintLead(process.env.COBRA_MACHINE_NAME?.trim() || os.hostname(), now));
  const projects = (await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH).catch(() => ({ projects: [] as Project[] }))).projects;
  for (const project of projects) {
    if (project.machine !== os.hostname() || project.parent !== undefined || project.lead || project.foreman || orchLinesHere.has(foremanLineName(project.id))) continue;
    if (await foremanRunning(project)) await orchLinesHere.serve(foremanLineName(project.id), (now) => mintForeman(project.id, now));
  }
  // The key files from before the lines: every key they held is minted again above or left to expire.
  for (const old of oldComputerFiles()) removePrivateFile(old);
}
void openOrchLines().catch((caught: unknown) => console.log(`[${SERVICE}] orchestrator lines: ${caught instanceof Error ? caught.message : String(caught)}`));
setInterval(() => {
  try {
    orchLinesHere.extendAll();
  } catch (caught) {
    console.log(`[${SERVICE}] orchestrator keys: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}, 60 * 60_000).unref();

// What became of each Worker's PR (merged anywhere, or closed), told to its Foreman once (prNews.ts).
const prNewsDeps = livePrNewsDeps(
  process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH,
  tellLine,
  (project) => finishes.isBriefed(project),
  (line) => console.log(`[${SERVICE}] ${line}`),
);
const stopPrNews = startPrNews(prNewsDeps);

// The Executive Assistant's hourly round-up into the memory repository (ea.ts).
const stopEa = startEa(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH, (line) => console.log(`[${SERVICE}] ${line}`));

// Routines (routines.ts): each minute, a routine whose run has come is typed into its project's Foreman. Off with COBRA_ROUTINES=off.
const stopRoutines = startRoutines(
  liveTickDeps({
    configPath: process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH,
    port: config.port,
    notify: notifyApproval,
    tell: tellLine,
    log: (line) => console.log(`[${SERVICE}] ${line}`),
    briefed: (project) => finishes.briefed(project),
    notifyOnce: routineNotice,
    // On-call Spaces (onCall.ts): with the Foreman asleep, a light routine runs on one Worker of Cobra's.
    onCall: { onCall: (project) => liveOnCallSpace(project), asleep: (project) => keeper.isAsleep(project), direct: routineWorker, log: (line) => console.log(`[${SERVICE}] ${line}`) },
  }),
);

// Branded email (emailLive.ts): every 20 s, at most one due email from the Spaces here goes out through Gmail. Off with COBRA_EMAIL=off.
const stopEmail =
  process.env.COBRA_EMAIL === "off"
    ? () => {}
    : startEmailSender({
        tell: tellLine,
        log: (line) => console.log(`[${SERVICE}] ${line}`),
        // Hooks (emailHooks.ts): a new form entry or payment makes a card, or a send once the template version is trusted.
        hooks: {
          project: async (id) => (await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH)).projects.find((project) => project.id === id && project.machine === os.hostname()),
          notify: notifyApproval,
          trust: { approval: (action, by) => trustedApproval(trustDeps(), action, by), carryOut: carryOutAction },
        },
      });

// Boards' snapshots (spaceBoards.ts snapshotSpaces): each Space here keeps its boards' numbers once a day, checked hourly, after its holdings are priced (prices.ts). Off with COBRA_SNAPSHOTS=off.
const stopSnapshots = (() => {
  if (process.env.COBRA_SNAPSHOTS === "off") return () => {};
  const deps = liveBoardDeps({ approvals: { load: () => loadApprovals(), save: (list) => saveApprovals(list) }, notify: notifyApproval, tell: tellLine, log: (line) => console.log(`[${SERVICE}] ${line}`) });
  const pricesPath = join(STATE_DIR, "prices.json");
  const priceDeps: PriceDeps = {
    spaces: () => listSpaces().filter((space) => seatFor(space.id, "money")).map((space) => space.id),
    open: (space) => openProjectDb(`space-${space}`, SPACE_SCHEMA),
    fetchJson: liveFetchJson,
    load: () => {
      try {
        return JSON.parse(readPrivateFile(pricesPath).text ?? "{}") as Record<string, string>;
      } catch {
        return {};
      }
    },
    save: (state) => writePrivateFile(pricesPath, JSON.stringify(state)),
    now: () => new Date(),
    log: (line) => console.log(`[${SERVICE}] ${line}`),
  };
  const tick = () => {
    // Holdings priced first, so the day's snapshot counts today's values (prices.ts).
    void priceSpaces(priceDeps)
      .catch((caught: unknown) => console.log(`[${SERVICE}] prices: ${caught instanceof Error ? caught.message : String(caught)}`))
      .finally(() => snapshotSpaces(deps));
    void findBillsWeekly(billFinderDeps()).catch((caught: unknown) => console.log(`[${SERVICE}] bills: ${caught instanceof Error ? caught.message : String(caught)}`));
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, 60 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
})();

// Exchange rates (fx.ts): the ECB's once a day, only while a Space here keeps a currency they cover. Off with COBRA_RATES=off.
const stopRates = startRates((line) => console.log(`[${SERVICE}] ${line}`));

// The Gate: Workers' and jobs' policy hooks get their answers here (gate.ts, permissions.ts).
const stopGate = startGate({
  log: (line) => console.log(`[${SERVICE}] ${line}`),
  // A headless Worker out of Cobra's sandbox; one in it asks its own socket.
  // A headless Worker out of the sandbox, or a headless Lead or Foreman (API test mode, orchHeadless.ts).
  permission: (id, req, res) => servePermission(id, req, res, (worker) => (isHeadless(worker) && !containedWorker(worker)) || orchHeadless(worker)),
  // The Lead's and Foremen's web reads, judged under Instinct (orchWeb.ts).
  orch: async (who, event) => {
    const parsed = parseOrchWho(who);
    return parsed ? answerOrchWeb(parsed, event, liveOrchWebDeps) : null;
  },
  // After each page read, whether it is what its address claims (webClaims.ts).
  // A page a Foreman under Cobra read that was not what it claims: Cobra hears of it too.
  // And what a connector's tool gave the Lead or a Foreman taints its turn (orchWeb.ts).
  after: (who, event) => {
    try {
      noteConnectorRead(who, event);
    } catch (caught) {
      console.log(`[${SERVICE}] taint: could not note ${who}'s connector read (${caught instanceof Error ? caught.message : String(caught)})`);
    }
    return answerAfter({ ...liveClaimDeps((line) => console.log(`[${SERVICE}] ${line}`)), tell: claimTeller }, who, event);
  },
  // Each turn's tokens from the Stop hook of the Lead, a Foreman or a Worker out of the sandbox (usageLedger.ts).
  usage: (as, body) => void takeTurn(callerOfAs(as), body),
});
// Contained Workers' sockets (workerProxy.ts) come back with the agent; their sandboxes bind the folder, not the file.
const resumedProxies = resumeWorkerProxies(
  liveProxyDeps((line) => console.log(`[${SERVICE}] ${line}`)),
  undefined,
  (id, dir) => containLayout(id, dir).socket,
);
if (resumedProxies.length) console.log(`[${SERVICE}] serving ${resumedProxies.length} contained Worker socket(s) again`);

// A Worker's Space tools (workerSpace.ts): the Foreman's own route, run here as its owner project's Foreman with the
// Worker named. No trust and no merge on green: each send or file is a card, marked with the Worker that made it.
setSpaceRunner((call) =>
  runSpaceTool(
    call,
    (route, url, request, response, io) =>
      handleOrch(route, url, request, response, {
        ...io,
        configPath: process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH,
        log: (line) => console.log(`[${SERVICE}] ${line}`),
        announce,
        thread: () => thread,
        decided: (entry) => recordDecided(entry),
        tell: tellPerson,
        machineLabel: process.env.COBRA_MACHINE_NAME?.trim() || os.hostname(),
        port: config.port,
      }),
    notifyOrAct,
    { load: () => loadApprovals(), save: (list) => saveApprovals(list) },
  ),
);

// The model gateway (modelGateway.ts): every Claude request Cobra's sessions make,
// on the subscription or the API key, and the fleet's spend added up on the Lead's computer each minute.
if (OLLAMA.refused) console.log(`[${SERVICE}] no local models: ${OLLAMA.refused}`);
else if (OLLAMA.remote) console.log(`[${SERVICE}] local models from ${OLLAMA.url}, off this computer (COBRA_OLLAMA_REMOTE=on)`);
const modelGateway = startModelGateway({ token: () => claudeToken(), log: (line) => console.log(`[${SERVICE}] ${line}`), noteLimitsFile: writeLimits });
// A session receives only a revocable Cobra token. This local-only broker
// verifies it and reads the active Codex sign-in only while forwarding.
const codexBroker = startCodexBroker(CODEX_BROKER_PORT, {
  sessionForToken: liveSessionForToken,
  credential: (mode) => mode === "chatgpt" ? activeCodexCredential() : null,
  upstream: CODEX_UPSTREAMS,
  log: (line) => console.log(`[${SERVICE}] ${line}`),
});
// Memory stays on this computer: its index now.
void liveIndex(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH).catch((caught: unknown) => console.log(`[${SERVICE}] memory: index: ${String(caught)}`));
const apiAlertTimer = setInterval(() => void apiAlertTick().catch((caught) => console.log(`[${SERVICE}] api lane: ${caught instanceof Error ? caught.message : String(caught)}`)), 60_000);
apiAlertTimer.unref();
// Unanswered cards that can be undone, to the judge under Instinct (unanswered.ts).
const unansweredTimer = setInterval(() => void judgeUnansweredCards().catch((caught: unknown) => console.log(`[${SERVICE}] unanswered cards: ${caught instanceof Error ? caught.message : String(caught)}`)), 60_000);
unansweredTimer.unref();
// The morning brief (morning.ts): written from this computer's facts, once a day.
let morningBusy = false;
const morningTimer = setInterval(() => {
  if (morningBusy || !sendsMorning()) return;
  morningBusy = true;
  void morningTick(liveMorningDeps({
    // One computer: no other computer's facts to gather.
    peers: async () => [],
    deliver: async (brief) => {
      notices.record({ kind: "morning", projectId: "", title: "Good morning", body: brief.text });
      // Her first message of the day in her thread (thread.ts).
      thread.append([{ at: new Date().toISOString(), kind: "morning", conversation: thread.current() ?? "", text: brief.text }]);
      const tokens = await loadPushTokens();
      if (tokens.length === 0) return;
      const outcome = await push(tokens, { title: "Good morning", body: brief.text, data: { machine: os.hostname(), kind: "morning" } });
      for (const error of outcome.errors) console.log(`[${SERVICE}] push ticket: ${error}`);
      for (const token of outcome.dead) await dropPushToken(token);
    },
    log: (line) => console.log(`[${SERVICE}] ${line}`),
  }))
    .catch((caught: unknown) => console.log(`[${SERVICE}] morning brief: ${caught instanceof Error ? caught.message : String(caught)}`))
    .finally(() => {
      morningBusy = false;
    });
}, 60_000);
morningTimer.unref();
// Website inquiries (sitePull.ts): each site's form rows from the owner's D1 into its Space's People,
// once now and every 5 minutes. Off with COBRA_SITE_PULL=off.
/** What a website notice opens: the Space's People seat (or any of its seats), the site's own project, else Cobra. */
async function websiteOpens(key: string): Promise<{ projectId: string; session: string; path: string }> {
  const mine = (await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH).catch(() => ({ projects: [] as Project[] }))).projects.filter((project) => project.machine === os.hostname());
  let found: Project | undefined;
  if (key.startsWith("space-")) {
    const space = key.slice("space-".length);
    const seats = mine.map((project) => ({ project, seat: seatOf(project.id) })).filter((entry) => entry.seat?.space === space);
    found = (seats.find((entry) => entry.seat?.role === "people") ?? seats[0])?.project;
  } else if (key.startsWith("project-")) {
    found = mine.find((project) => project.id === key.slice("project-".length));
  }
  return found ? { projectId: found.id, session: found.session, path: found.path } : { projectId: LEAD_SESSION, session: LEAD_SESSION, path: leadHome() };
}
/** A website notice: recorded, in Cobra's thread, and pushed (sitePull.ts, formLinks.ts). */
const websiteNotify = async (notice: PullNotice): Promise<void> => {
  const opens = await websiteOpens(notice.key);
  notices.record({ kind: "website", projectId: opens.projectId, session: opens.session, title: notice.title, body: notice.body });
  threadNotice(notice.title, notice.body);
  const tokens = await loadPushTokens();
  if (tokens.length === 0) return;
  const outcome = await push(tokens, { title: notice.title, body: notice.body, data: { machine: os.hostname(), ...opens } });
  for (const error of outcome.errors) console.log(`[${SERVICE}] push ticket: ${error}`);
  for (const token of outcome.dead) await dropPushToken(token);
};
const pullSites = sitePuller({
  stateDir: STATE_DIR,
  grant: () => cloudflare.grant(),
  fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(60_000) }),
  // The Space's one store, opened by its key (the file its seats share), only when the Space is open here.
  store: (space) => (readSpace(space) ? openProjectDb(`space-${space}`, SPACE_SCHEMA) : null),
  stored: noFollowUp,
  notify: websiteNotify,
  log: (line) => console.log(`[${SERVICE}] ${line}`),
  now: Date.now,
  // Branded email's first clicks into the Space's send ledger (emailLive.ts).
  clicks: (space, clicks) => {
    const queue = queueFor(space);
    for (const c of clicks) queue.click(c.job, c.link, c.at);
  },
});
// Forms on websites Cobra did not build (formLinks.ts): the same 5 minutes and the same switch, read only.
const formStore = (space: string) => (readSpace(space) ? openProjectDb(`space-${space}`, SPACE_SCHEMA) : null);
const pullForms = formPuller({
  dir: FORM_LINKS_DIR,
  grant: () => cloudflare.grant(),
  fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(60_000) }),
  store: formStore,
  stored: noFollowUp,
  notify: websiteNotify,
  log: (line) => console.log(`[${SERVICE}] ${line}`),
});
let formPullBusy = false;
function formPullTick(): void {
  if (formPullBusy || process.env.COBRA_SITE_PULL === "off") return;
  formPullBusy = true;
  void pullForms()
    .catch((caught: unknown) => console.log(`[${SERVICE}] linked forms: ${caught instanceof Error ? caught.message : String(caught)}`))
    .finally(() => {
      formPullBusy = false;
    });
}
let sitePullBusy = false;
const sitePullTick = () => {
  if (sitePullBusy) return;
  sitePullBusy = true;
  void pullSites()
    .catch((caught: unknown) => console.log(`[${SERVICE}] website inquiries: ${caught instanceof Error ? caught.message : String(caught)}`))
    .finally(() => {
      sitePullBusy = false;
    });
};
const sitePullOn = process.env.COBRA_SITE_PULL !== "off";
if (!sitePullOn) console.log(`[${SERVICE}] website inquiries are not pulled (COBRA_SITE_PULL=off)`);
else {
  sitePullTick();
  formPullTick();
}
const sitePullTimer = sitePullOn
  ? setInterval(() => {
      sitePullTick();
      formPullTick();
    }, PULL_EVERY_MS)
  : null;
sitePullTimer?.unref();
// API test mode's switch over (testSwitch.ts): a running Lead or Foreman restarts headless on the key, or back in tmux.
let switchBusy = false;
const testSwitchTimer = setInterval(() => {
  if (switchBusy) return;
  switchBusy = true;
  const mode = async (session: string) => (orchHeadless(session) ? ("headless" as const) : (await tmuxHas(session)) ? ("tmux" as const) : null);
  const mine = async () => (await loadRegistry(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH)).projects.filter((project) => project.machine === os.hostname() && project.parent === undefined);
  void switchTestMode({
    on: liveTestOn,
    note: liveTestNote,
    lead: () => mode(LEAD_SESSION),
    restartLead: () => newLeadConversation(config.port),
    async foremen() {
      const out: Array<{ project: string; mode: "tmux" | "headless" }> = [];
      for (const project of await mine()) {
        const now = await mode(foremanSession(project));
        if (now) out.push({ project: project.id, mode: now });
      }
      return out;
    },
    async restartForeman(id) {
      const project = (await mine()).find((candidate) => candidate.id === id);
      if (project) await newForemanConversation(project, config.port);
    },
    log: (line) => console.log(`[${SERVICE}] ${line}`),
  })
    .catch((caught: unknown) => console.log(`[${SERVICE}] api test: ${caught instanceof Error ? caught.message : String(caught)}`))
    .finally(() => {
      switchBusy = false;
    });
}, 20_000);
testSwitchTimer.unref();
{
  // Said once at start, so a Worker that left Cobra's sandbox, or a harness that moved, shows in the journal.
  const mode = containMode();
  const running = harness();
  console.log(
    `[${SERVICE}] Workers run ${mode.contained ? "contained, in Cobra's sandbox" : containSetting() === "require" ? `nowhere (${mode.reason})` : `uncontained (${mode.reason}), each with its own Claude Code folder`}; ` +
      `Claude Code ${running.version ?? "of unknown version"}${running.pinned ? (running.pinned === running.version ? " (pinned)" : ` (pinned ${running.pinned}: run install.sh again)`) : " (not pinned)"}`,
  );
}

{
  // The sandbox (bubblewrap, sandbox-exec on macOS) probed again every 5 minutes: a sysctl or a
  // kernel update that takes the jail away, or gives it back, shows in the
  // journal now, and with COBRA_CONTAIN=require stops or frees the workforce
  // (contain.ts jailRefusal reads the same cached answer).
  let was = containEnabled() ? containAvailable() : null;
  setInterval(() => {
    if (!containEnabled()) return;
    const now = reprobeContain();
    if (was !== null && now !== was) {
      console.log(`[${SERVICE}] ${sandboxTool()} ${now ? "works again: Workers run in Cobra's sandbox" : `stopped working: ${containMode().reason}`}`);
    }
    was = now;
  }, PROBE_EVERY_MS).unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[${SERVICE}] ${signal} received, shutting down`);
    stopWatcher();
    stopRecorder();
    stopGitSync();
    stopPrNews();
    stopEa();
    stopRoutines();
    stopEmail();
    stopSnapshots();
    stopRates();
    clearInterval(queueTimer);
    clearInterval(finishTimer);
    clearInterval(keeperTimer);
    store.close();
    // A phone's long poll or a socket left open kept server.close waiting
    // until systemd's 90 s kill; contained Workers had no Gate all that time
    // and every tool call came to you (2026-10-11). So: close every
    // connection, and go within a few seconds whatever is left.
    server.close(() => exitNow());
    server.closeAllConnections();
    setTimeout(exitNow, STOP_GRACE_MS).unref();
  });
}

/** How long a stop may take before the agent goes anyway. */
const STOP_GRACE_MS = 3000;

/**
 * Last: the Gate and contained Workers' sockets, so a hook asks up to the
 * moment the agent goes, and the next agent serves them again at once.
 */
function exitNow(): never {
  stopGate();
  codexBroker.close();
  stopAllWorkerProxies();
  modelGateway.close();
  process.exit(0);
}
