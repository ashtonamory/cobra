import { z } from "zod";

/**
 * What one machine exposes, and how that compares with what it is supposed to.
 *
 * The shape mirrors the split the agent makes: observations first, then the
 * subset of them that nobody has accounted for. `sockets` is every listener;
 * `undeclared` is the ones missing from config/exposure.json. Showing both is
 * the point — the phone should be able to answer "what is open on this machine"
 * as readily as "what is wrong with it".
 */

/** Who can reach a socket. Not what address it is on — that is `address`. */
export const Scope = z.enum(["loopback", "tailnet", "lan"]);
export type Scope = z.infer<typeof Scope>;

export const Socket = z.object({
  proto: z.enum(["tcp", "udp"]),
  address: z.string(),
  port: z.number(),
  scope: Scope,
  /** Null when the socket belongs to another account. Never guessed. */
  process: z.string().nullable(),
  /** The owner's executable (`/proc/<pid>/exe`); null when unreadable, absent from older agents. */
  exe: z.string().nullable().optional(),
});
export type Socket = z.infer<typeof Socket>;

export const Peer = z.object({
  host: z.string(),
  online: z.boolean(),
  /** Null when the node key does not expire. */
  expiresAt: z.string().nullable(),
});
export type Peer = z.infer<typeof Peer>;

export const ServeHandler = z.object({ path: z.string(), target: z.string() });
export type ServeHandler = z.infer<typeof ServeHandler>;

export const TailnetView = z.object({
  /** False when tailscaled did not answer. Absence of data, not a clean bill. */
  ok: z.boolean(),
  /** Tracked apart from `ok`: an empty serve config and a failed query differ. */
  serveOk: z.boolean(),
  self: Peer.nullable(),
  peers: z.array(Peer),
  /** Non-empty means this machine is published past the tailnet. */
  funnelOn: z.array(z.string()),
  serve: z.array(ServeHandler),
});
export type TailnetView = z.infer<typeof TailnetView>;

export const SecretFile = z.object({
  label: z.string(),
  present: z.boolean(),
  /** Octal string, e.g. "600". Null when absent. */
  mode: z.string().nullable(),
  loose: z.boolean(),
});
export type SecretFile = z.infer<typeof SecretFile>;

export const Login = z.object({
  user: z.string(),
  from: z.string(),
  tsUser: z.string(),
  node: z.string(),
});
export type Login = z.infer<typeof Login>;

export const Finding = z.object({
  id: z.string(),
  level: z.enum(["warn", "critical"]),
  body: z.string(),
});
export type Finding = z.infer<typeof Finding>;

/**
 * How this computer runs Workers and jobs: in Cobra's sandbox or not, and
 * on which Claude Code (F5 and F14 of the 2026-10-12 security audit).
 */
export const WorkerHarness = z.object({
  /** In Cobra's sandbox (COBRA_CONTAIN=on or require, and bubblewrap works here). */
  contained: z.boolean(),
  /** Why not, when not. */
  reason: z.string().nullable(),
  /** The Claude Code version `claude` on the agent's PATH resolves to ("2.1.296"), or null. */
  version: z.string().nullable(),
  /** Its real file, or null when there is no claude on the PATH. */
  path: z.string().nullable(),
  /** What install.sh pinned (agent.env COBRA_CLAUDE_VERSION), or null when nothing is. */
  pinned: z.string().nullable(),
  /** Pi, the harness for local models, as install.sh pinned it; null when there is none. Missing from older agents. */
  pi: z.object({ version: z.string(), path: z.string() }).nullable().optional(),
});
export type WorkerHarness = z.infer<typeof WorkerHarness>;

export const Posture = z.object({
  host: z.string(),
  /** Null until the first sample lands, a few seconds after the agent starts. */
  checkedAt: z.string().nullable(),
  /** False when this machine has no entry in config/exposure.json at all. */
  declared: z.boolean(),
  sockets: z.array(Socket),
  undeclared: z.array(Socket),
  /**
   * Declared only by a legacy name rule (`process`, no `exe`), which any
   * program can match by calling itself that. Allowing one again pins it to
   * its executable. Absent from older agents.
   */
  legacy: z.array(Socket).optional(),
  tailnet: TailnetView,
  secrets: z.array(SecretFile),
  authorizedKeys: z.array(z.string()),
  logins: z.array(Login),
  /** False when the journal could not be read. */
  logReadable: z.boolean(),
  rejects: z.number(),
  findings: z.array(Finding),
  /** Absent from an agent older than it. */
  harness: WorkerHarness.optional(),
});
export type Posture = z.infer<typeof Posture>;
