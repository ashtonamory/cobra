import { z } from "zod";

/**
 * MCP servers for the Lead and the Foremen (agent mcp.ts): a registry of entries, each on or off, merged
 * into their Claude config at each start. Never a Worker's or a job's.
 *
 * Strings where a list of values would be tempting (transport, role, secret,
 * preset): an enum here could never grow while an older app is in the field.
 */

/**
 * The github-mcp-server binary the `github` preset runs, pinned when you
 * allowed it. At each start the agent and the launcher check the file at
 * `path` still hashes to `sha256`; anything else and the preset is left out.
 */
export const McpPin = z.object({
  /** The binary's real path (no symlinks), as it was when pinned. */
  path: z.string(),
  /** Hex sha256 of the file. */
  sha256: z.string(),
  /** What the binary said `--version` was. */
  version: z.string(),
  /** The release tag whose official archive holds this exact binary, or null when that could not be shown. */
  release: z.string().nullable(),
  verifiedAt: z.string(),
  /**
   * Installed by the agent from the release its own code names, checked
   * against the hash written there. Absent on a
   * binary you verified yourself, which the agent never replaces.
   */
  managed: z.boolean().optional(),
});
export type McpPin = z.infer<typeof McpPin>;

export const McpEntry = z.object({
  /** ^[a-z0-9-]{1,32}$, unique; "cobra-orch" is reserved. */
  name: z.string(),
  /** Presets only ("github"): the command is resolved at each start. */
  preset: z.string().optional(),
  /** "stdio" | "http". */
  transport: z.string(),
  /** stdio custom entries only: an absolute command. */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** http custom entries only: https. */
  url: z.string().optional(),
  /** "lead" | "foreman". */
  roles: z.array(z.string()),
  /** Presets: fixed by the preset. Custom: what you declared; read-only tools run without a prompt. */
  readOnly: z.boolean(),
  enabled: z.boolean(),
  /**
   * Where a credential comes from, never a value: "github-pat" (your token
   * file) is the only one, and only the github preset names it. An agent from
   * before 2026-10-10 said "gh-token".
   */
  secret: z.string().optional(),
  /** The github preset's pinned binary, once you allowed one. */
  pin: McpPin.optional(),
  /** Would merge at a start now. */
  available: z.boolean(),
  /** Why not, when not: "no GitHub token: put a fine-grained personal access token in …". */
  why: z.string().optional(),
});
export type McpEntry = z.infer<typeof McpEntry>;

/**
 * The fine-grained personal access token the github preset runs with, kept
 * by you in the agent's config folder (`github-pat`). Never the token itself.
 */
export const McpToken = z.object({
  /** The file is there, private, and holds one token. */
  present: z.boolean(),
  /** Whose token it is, as GitHub says (`GET /user`, checked every few minutes); null when unknown. */
  login: z.string().nullable(),
  /** Why it is not present, or why the login is unknown (GitHub refused it, or could not be reached). */
  why: z.string().optional(),
});
export type McpToken = z.infer<typeof McpToken>;

/** A device code waiting for you on GitHub. The agent keeps the device code itself; this is what you type. */
export const McpSignIn = z.object({
  userCode: z.string(),
  verificationUri: z.string(),
  expiresAt: z.string(),
});
export type McpSignIn = z.infer<typeof McpSignIn>;

/**
 * One integration as Settings → Integrations draws it:
 * the agent works out `state`, so the desk only put words to it.
 */
export const McpIntegration = z.object({
  /** The preset: "github". */
  id: z.string(),
  title: z.string(),
  /**
   * "not-connected" | "signing-in" | "installing" | "needs-repos" |
   * "attention" | "off" | "connected", as a string: an app that meets a state
   * it does not know shows `why` and Connect.
   */
  state: z.string(),
  /** Whose account it reads, once known. */
  account: z.string().nullable(),
  /** What is wrong or what is happening, in words to show. */
  why: z.string().optional(),
  enabled: z.boolean(),
  /** How it can be connected here: "device" (sign in with GitHub), "token" (paste one). */
  methods: z.array(z.string()),
  /** While state is "signing-in". */
  signIn: McpSignIn.optional(),
  /** Where you choose what it may read (a GitHub App's install page). */
  manageUrl: z.string().optional(),
  /** Where you would create a token to paste. */
  tokenUrl: z.string().optional(),
});
export type McpIntegration = z.infer<typeof McpIntegration>;

export const McpStatus = z.object({
  machine: z.string(),
  /**
   * For apps from before the token file: the agent no longer asks gh, and
   * fills this from the token (`authed` is `token.present`, `user` its
   * login). Read `github.token` instead.
   */
  gh: z.object({ installed: z.boolean(), authed: z.boolean(), user: z.string().nullable() }).optional(),
  github: z.object({
    /** A github-mcp-server found on this computer, to offer for pinning; never run unless pinned. */
    binary: z.string().nullable(),
    pin: McpPin.nullable(),
    /** Absent from an agent from before 2026-10-10, which used gh's login. */
    token: McpToken.optional(),
  }),
  entries: z.array(McpEntry),
  /** Settings → Integrations. Absent from an agent from before 2026-10-11. */
  integrations: z.array(McpIntegration).optional(),
  /** The registry file was refused, and why. */
  refused: z.string().optional(),
});
export type McpStatus = z.infer<typeof McpStatus>;

export const McpToggle = z.object({
  name: z.string(),
  enabled: z.boolean(),
  roles: z.array(z.string()).optional(),
});
export type McpToggle = z.infer<typeof McpToggle>;

export const McpVerify = z.object({ name: z.string() });
export type McpVerify = z.infer<typeof McpVerify>;

/** POST /mcp/connect: "device" asks GitHub for a code; "token" carries one to keep. */
export const McpConnect = z.object({ id: z.string(), method: z.string(), token: z.string().optional() });
export type McpConnect = z.infer<typeof McpConnect>;

export const McpDisconnect = z.object({ id: z.string() });
export type McpDisconnect = z.infer<typeof McpDisconnect>;

/** What /mcp/connect and /mcp/disconnect answer. */
export const McpIntegrationAnswer = z.object({ integration: McpIntegration });
export type McpIntegrationAnswer = z.infer<typeof McpIntegrationAnswer>;

/** Not in v1 (custom servers are deferred); kept so the shape is ready. */
export const McpAdd = z.object({
  name: z.string(),
  transport: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  roles: z.array(z.string()),
  readOnly: z.boolean(),
});
export type McpAdd = z.infer<typeof McpAdd>;
