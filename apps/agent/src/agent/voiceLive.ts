import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { ProjectState, ThreadEntry } from "@cobra/contracts";

import { speakable } from "../../../../packages/contracts/src/voiceCall.ts";

import { laneFactsNow, laneState } from "./apiLane.ts";
import { loadApprovals, settle } from "./approvals.ts";
import { countDigest, digestText, liveDigestSources } from "./digest.ts";
import { nowLine } from "./localTime.ts";
import { gatewayEnv } from "./modelGateway.ts";
import { STATE_DIR } from "./paths.ts";
import { writePrivateFile } from "./private.ts";
import { NOT_YET, summaryPrompt } from "./lateAnswer.ts";
import { loadRoutines, stamp } from "./routines.ts";
import { listSpaces, seatOf, type SpaceRecord } from "./spaces.ts";
import { SPOKEN, VOICE } from "./voice.ts";
import { voiceFrontPrompt, type FrontProcess, type Lane, type ToolAnswer, type ToolReads, type VoiceDeps } from "./voiceFront.ts";
import { claudeToken } from "./workerProxy.ts";
import { stablePath } from "./workers.ts";

/**
 * The voice front's live wiring (voiceFront.ts has the rules): the warm
 * `claude -p` process, the call's own tool socket that voiceMcp.ts posts to,
 * which lane its requests take, and the plain-text status it reads, worded
 * in the person's terms (Spaces, never projects' crew: hidden crew).
 */

export const VOICE_DIR = join(STATE_DIR, "voice");
const MCP_SERVER = "cobra-voice";

/** Claude Code's flags for the voice front (`mcpPath` lists cobra-voice alone). */
export function voiceFrontArgs(mcpPath: string): string[] {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", "haiku",
    "--system-prompt", voiceFrontPrompt(),
    // No built-in tools at all: no shell, files or web. Only cobra-voice's.
    "--tools", "",
    "--mcp-config", mcpPath,
    "--strict-mcp-config",
    "--allowedTools", `mcp__${MCP_SERVER}`,
    "--no-session-persistence",
    "--settings", JSON.stringify({ disableAllHooks: true }),
  ];
}

/**
 * The call's model route: through the model gateway, and on the API key
 * whenever the lane is open (asked for explicitly, as a session started on
 * `api` is), since the key's first words came 0.3 s sooner in V0. Without the
 * gateway, the computer's own sign-in.
 */
export function voiceEnv(call: string): { env: Record<string, string>; lane: Lane } {
  const facts = laneFactsNow();
  const open = facts ? laneState(facts).open : false;
  const env = gatewayEnv({ who: `voice:${call}`, role: "helper", explicit: open }, { persist: false, token: claudeToken, keptToken: () => true });
  return { env: env ?? {}, lane: env && open ? "key" : "subscription" };
}

/**
 * A late answer said short (lateAnswer.ts): one `claude -p` on Haiku with no
 * tools at all, through the gateway as the voice front goes. When it fails,
 * her reply's first two sentences (speakable), so the person still hears it.
 */
export async function summarizeLate(request: string, reply: string, log: (line: string) => void): Promise<string> {
  const fallback = () => speakable(reply).say || "It's done. The details are on your screen.";
  const dir = join(VOICE_DIR, "late");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { env } = voiceEnv("late");
  const args = [
    "-p",
    "--output-format", "text",
    "--model", "haiku",
    "--system-prompt", `You are Cobra, saying on the phone what you just finished for the person. Never mention a helper, a crew or a model.\n\n${VOICE}\n\n${SPOKEN}`,
    "--tools", "",
    "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--strict-mcp-config",
    "--no-session-persistence",
    "--settings", JSON.stringify({ disableAllHooks: true }),
  ];
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(text);
    };
    const child = spawn("claude", args, { cwd: dir, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...env } });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      log("voice: late summary timed out");
      finish(fallback());
    }, 45_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.on("error", (error) => {
      log(`voice: late summary: ${error.message}`);
      finish(fallback());
    });
    child.on("close", (code) => {
      const text = out.trim();
      if (code === 0 && text) return finish(text.includes(NOT_YET) ? NOT_YET : speakable(text, 3).say || fallback());
      log(`voice: late summary ended ${code}`);
      finish(fallback());
    });
    child.stdin.end(summaryPrompt(request, reply));
  });
}

/** Serves the call's tools on its own socket (0600 in its own folder) until closed. */
function serveTools(path: string, tools: (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>, log: (line: string) => void): http.Server {
  const server = http.createServer((request, response) => {
    const send = (status: number, body: ToolAnswer) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "POST" || request.url !== "/tool") return send(404, { text: "not found", error: true });
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 16_384) request.destroy();
    });
    request.on("end", () => {
      let body: { name?: unknown; arguments?: unknown };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        return send(400, { text: "invalid JSON", error: true });
      }
      const name = typeof body.name === "string" ? body.name : "";
      const args = body.arguments && typeof body.arguments === "object" ? (body.arguments as Record<string, unknown>) : {};
      tools(name, args)
        .then((answer) => send(200, answer))
        .catch((caught: unknown) => {
          log(`voice: tool ${name} failed: ${caught instanceof Error ? caught.message : String(caught)}`);
          send(200, { text: "That could not be read just now.", error: true });
        });
    });
  });
  server.listen(path);
  return server;
}

/** Starts the warm process for one call, in its own folder; stop() ends it and removes the folder. */
export function spawnVoiceFront(call: string, route: { env: Record<string, string>; lane: Lane }, tools: (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>, onLine: (line: string) => void, onExit: () => void, log: (line: string) => void): FrontProcess {
  const dir = join(VOICE_DIR, call);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socket = join(dir, "tools.sock");
  const server = serveTools(socket, tools, log);
  const mcpPath = join(dir, "mcp.json");
  const config = {
    mcpServers: {
      [MCP_SERVER]: {
        type: "stdio",
        command: stablePath(process.execPath),
        args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", stablePath(join(import.meta.dirname, "voiceMcp.ts"))],
        env: { COBRA_VOICE_SOCKET: socket },
      },
    },
  };
  writePrivateFile(mcpPath, `${JSON.stringify(config)}\n`);
  const child = spawn("claude", voiceFrontArgs(mcpPath), { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...route.env } });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  createInterface({ input: child.stdout }).on("line", onLine);
  let gone = false;
  const cleanup = () => {
    if (gone) return;
    gone = true;
    server.close();
    rmSync(dir, { recursive: true, force: true });
  };
  child.on("exit", (code) => {
    if (code && stderr.trim()) log(`voice: the voice front exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
    cleanup();
    onExit();
  });
  child.on("error", (error) => {
    log(`voice: the voice front did not start: ${error.message}`);
    cleanup();
    onExit();
  });
  return {
    lane: route.lane,
    write: (event) => {
      if (gone || !child.stdin.writable) throw new Error("the voice front is not running");
      child.stdin.write(`${JSON.stringify(event)}\n`);
    },
    stop: () => {
      child.stdin.end();
      child.kill("SIGTERM");
      cleanup();
    },
  };
}

// --- what it reads ----------------------------------------------------------------------

/** What the status is made from; the live ones are below. */
export type StatusFacts = {
  now: number;
  projects: readonly ProjectState[];
  approvals: ReadonlyArray<{ id: string; title: string; body: string }>;
  spaces: readonly SpaceRecord[];
  /** Which Space a project's seat is in, by the project's id. */
  spaceOf: (project: string) => string | null;
  leadWorking: boolean;
  doneToday: string | null;
};

const unique = (values: string[]) => [...new Set(values)];

const plain = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A project as the person knows it: its Space's name when it has a seat in one, else its own name. */
function placeOf(project: ProjectState, facts: StatusFacts): string {
  const space = facts.spaceOf(project.parent ?? project.id);
  const record = space ? facts.spaces.find((candidate) => candidate.id === space) : undefined;
  return record?.name ?? project.name;
}

/** The status in plain lines: the context of each turn, and the glance tool. */
export function statusText(facts: StatusFacts): string {
  const waiting = [
    ...facts.approvals.map((approval) => `${approval.title} (a card to approve, id ${approval.id}${approval.body.trim() ? `: ${plain(approval.body, 140)}` : ""})`),
    ...unique(facts.projects.filter((project) => project.needsInput && !project.handledBy && !project.lead).map((project) => `a question in ${placeOf(project, facts)}`)),
  ];
  const working = unique([
    ...(facts.leadWorking ? ["I am working on the person's last request"] : []),
    ...facts.projects.filter((project) => !project.lead && (project.activity === "agent-working" || project.handledBy)).map((project) => `work in ${placeOf(project, facts)}`),
  ]);
  const lines = [
    nowLine(facts.now),
    `Waiting on the person: ${waiting.length ? waiting.map((item, n) => `${n + 1}) ${item}`).join(" ") : "nothing"}.`,
    `In progress: ${working.length ? working.join("; ") : "nothing"}.`,
    `Done today: ${facts.doneToday ?? "nothing yet"}`,
    `Spaces: ${facts.spaces.length ? facts.spaces.map((space) => `${space.name} (${space.kind})`).join(", ") : "none yet"}.`,
  ];
  return lines.join("\n");
}

/** Today's digest, from the start of the local day: "3 landed, 2 tasks finished." */
export function doneToday(now: number): string | null {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const text = digestText(countDigest(liveDigestSources, start.getTime(), now));
  // Said by Cobra herself on the call: "I approved 6 myself", never "Cobra approved".
  return text ? text.replace(/^While you were out: /, "").replace(/\bCobra approved (\d+) herself\b/, "I approved $1 myself") : null;
}

export type LiveVoiceInput = {
  /** This computer's projects with the handled ones marked (index.ts: collectProjects without git, then markHandled). */
  projects: () => Promise<ProjectState[]>;
  leadWorking: () => Promise<boolean>;
  /** The newest thread entries, oldest first. */
  recent: (limit: number) => ThreadEntry[];
  thread: VoiceDeps["thread"];
  handOff: VoiceDeps["handOff"];
  handedOff?: VoiceDeps["handedOff"];
  log: (line: string) => void;
};

function pending(now: number) {
  return settle(loadApprovals(), now).filter((approval) => approval.state === "pending" && approval.kind !== "close-sessions");
}

export function liveVoiceDeps(input: LiveVoiceInput): VoiceDeps {
  const facts = async (): Promise<StatusFacts> => {
    const now = Date.now();
    const [projects, leadWorking] = await Promise.all([input.projects(), input.leadWorking().catch(() => false)]);
    return {
      now,
      projects,
      approvals: pending(now).map((approval) => ({ id: approval.id, title: approval.title, body: approval.body })),
      spaces: listSpaces(),
      spaceOf: (project) => seatOf(project)?.space ?? null,
      leadWorking,
      doneToday: doneToday(now),
    };
  };
  const reads: ToolReads = {
    threadRecent: async (limit) => {
      const entries = input.recent(limit).filter((entry) => entry.kind === "you" || entry.kind === "cobra" || entry.kind === "question");
      const lines = entries.map((entry) => `${entry.kind === "you" ? "Person" : "Cobra"}${entry.quick ? " (on the call)" : ""}: ${plain(entry.text, 600)}`);
      const working = await input.leadWorking().catch(() => false);
      return `${lines.join("\n") || "Nothing said yet."}${working ? "\n(The full Cobra is still working on a reply.)" : ""}`;
    },
    glance: async () => statusText(await facts()),
    spaceStatus: async (name) => {
      const wanted = name.toLowerCase().replace(/[^a-z0-9]/g, "");
      const space = listSpaces().find((candidate) => candidate.name.toLowerCase().replace(/[^a-z0-9]/g, "") === wanted || candidate.id === name.toLowerCase());
      if (!space) return `No Space is called ${JSON.stringify(name)}. The Spaces are: ${listSpaces().map((candidate) => candidate.name).join(", ") || "none"}.`;
      const now = Date.now();
      const routines = loadRoutines().filter((routine) => seatOf(routine.project)?.space === space.id);
      const lines = routines.map((routine) => {
        const next = routine.enabled && routine.nextRun ? `next ${stamp(Date.parse(routine.nextRun), now)}` : "paused";
        const last = routine.lastRun ? `, last ${routine.lastRun.outcome} ${stamp(Date.parse(routine.lastRun.at), now)}` : "";
        return `- ${routine.name}: ${next}${last}`;
      });
      const all = await facts();
      const questions = all.projects.filter((project) => project.needsInput && !project.handledBy && seatOf(project.parent ?? project.id)?.space === space.id).length;
      return [`${space.name} (${space.kind}).`, routines.length ? `Routines:\n${lines.join("\n")}` : "No routines yet.", questions ? `${questions} question${questions === 1 ? "" : "s"} waiting on the person here.` : "Nothing here waits on the person."].join("\n");
    },
    pendingCards: async () => {
      const cards = pending(Date.now());
      return cards.length ? cards.map((card) => `- ${card.id}: ${card.title}. ${plain(card.body, 280)}`).join("\n") : "No cards wait on the person.";
    },
    cardTitle: (id) => pending(Date.now()).find((card) => card.id === id)?.title ?? null,
  };
  return {
    now: Date.now,
    spawn: (call, tools, onLine, onExit) => spawnVoiceFront(call, voiceEnv(call), tools, onLine, onExit, input.log),
    context: async () => statusText(await facts()),
    thread: input.thread,
    handOff: input.handOff,
    ...(input.handedOff ? { handedOff: input.handedOff } : {}),
    reads,
    log: input.log,
  };
}
