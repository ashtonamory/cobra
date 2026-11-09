/**
 * Files Cobra writes into a Codex runtime home. The home contains only a
 * per-run placeholder credential; the real account credential remains with
 * the agent-side broker when that launch path is enabled.
 */

export type CodexAuthMode = "chatgpt" | "api";
export type CodexMcpServer =
  | { type?: "stdio"; command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }
  | { type: "http"; url: string };

const b64url = (text: string): string => Buffer.from(text).toString("base64url");

/**
 * auth.json in the shape Codex expects, but with no usable credential. The
 * ChatGPT id token is structurally valid so Codex does not attempt to refresh
 * a token from inside a contained Worker.
 */
export function placeholderAuth(mode: CodexAuthMode, placeholder: string, now = new Date()): string {
  if (mode === "api") return `${JSON.stringify({ OPENAI_API_KEY: placeholder })}\n`;
  const account = "cobra-placeholder";
  const claims = {
    exp: 4_102_444_800,
    iat: 1_700_000_000,
    "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "plus" },
  };
  const idToken = `${b64url('{"alg":"none","typ":"JWT"}')}.${b64url(JSON.stringify(claims))}.placeholder`;
  return `${JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: idToken, access_token: placeholder, refresh_token: placeholder, account_id: account },
    last_refresh: now.toISOString(),
  })}\n`;
}

/**
 * Read-only config for a contained Codex Worker. Codex's own sandbox is not
 * the boundary here: Cobra contains the entire process. This config limits
 * Codex's product capabilities and sends model traffic to Cobra's local
 * broker; the broker and outer containment enforce those limits.
 */
export function containedCodexConfig(options: {
  mode: CodexAuthMode;
  port: number;
  roots: readonly string[];
  model?: string;
  instructions: string;
  notify?: readonly string[];
  /** MCP is declared in this private runtime home, never read from a project. */
  mcpServers?: Readonly<Record<string, CodexMcpServer>>;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
}): string {
  const auth = options.mode === "api" ? 'env_key = "OPENAI_API_KEY"' : "requires_openai_auth = true";
  const projects = [...new Set(options.roots)].map((root) => `[projects.${JSON.stringify(root)}]\ntrust_level = "untrusted"`);
  const mcp = Object.entries(options.mcpServers ?? {}).flatMap(([name, server]) => {
    const table = `[mcp_servers.${JSON.stringify(name)}]`;
    if (server.type === "http") return [table, `url = ${JSON.stringify(server.url)}`, 'default_tools_approval_mode = "approve"', ""];
    return [
      table,
      `command = ${JSON.stringify(server.command)}`,
      // Cobra writes only its pinned orchestration and read-only registry
      // servers here. With the role's non-interactive policy, Codex must be
      // told that those managed MCP calls are pre-approved or it refuses them.
      'default_tools_approval_mode = "approve"',
      // worker_wait and job_run wait up to five minutes; Codex's default is 60 s.
      "tool_timeout_sec = 360.0",
      ...(server.args?.length ? [`args = [${server.args.map((arg) => JSON.stringify(arg)).join(", ")}]`] : []),
      ...(server.env && Object.keys(server.env).length ? [`env = { ${Object.entries(server.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(", ")} }`] : []),
      "",
    ];
  });
  return [
    "# Written by the Cobra agent for a contained Codex Worker. Read-only inside.",
    ...(options.model ? [`model = ${JSON.stringify(options.model)}`] : []),
    `developer_instructions = ${JSON.stringify(options.instructions)}`,
    ...(options.notify?.length ? [`notify = [${options.notify.map((part) => JSON.stringify(part)).join(", ")}]`] : []),
    'model_provider = "cobra"',
    'approval_policy = "never"',
    `sandbox_mode = ${JSON.stringify(options.sandboxMode ?? "danger-full-access")}`,
    'web_search = "disabled"',
    'cli_auth_credentials_store = "file"',
    "check_for_update_on_startup = false",
    "",
    "[model_providers.cobra]",
    'name = "Cobra"',
    `base_url = "http://127.0.0.1:${options.port}/codex"`,
    'wire_api = "responses"',
    auth,
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[features]",
    "apps = false",
    "plugins = false",
    "",
    ...mcp,
    ...projects.flatMap((project) => [project, ""]),
  ].join("\n");
}
