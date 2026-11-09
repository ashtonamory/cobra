/** A managed Codex hook declaration, written only by the Cobra agent. */
export type CodexHook = {
  event: "PreToolUse" | "PostToolUse" | "SessionStart" | "UserPromptSubmit" | "PermissionRequest" | "Stop" | "SessionEnd";
  matcher?: string;
  command: string;
  timeout: number;
};

/** The system location Codex uses for enforceable requirements. */
export const CODEX_ETC = "/etc/codex";

/** Requirements for one contained Codex run: no self-approved tools or web access. */
export function codexRequirements(options: { mode: "chatgpt" | "api"; hooks?: readonly CodexHook[] }): string {
  const lines = [
    "# Written by the Cobra agent for one contained Codex run; read-only at /etc/codex.",
    "allow_managed_hooks_only = true",
    'allowed_sandbox_modes = ["read-only", "danger-full-access"]',
    'allowed_approval_policies = ["never"]',
    'allowed_web_search_modes = ["disabled"]',
    `allowed_login_methods = [${JSON.stringify(options.mode)}]`,
  ];
  for (const hook of options.hooks ?? []) {
    lines.push(
      "",
      `[[hooks.${hook.event}]]`,
      ...(hook.matcher ? [`matcher = ${JSON.stringify(hook.matcher)}`] : []),
      "",
      `[[hooks.${hook.event}.hooks]]`,
      'type = "command"',
      `command = ${JSON.stringify(hook.command)}`,
      `timeout = ${Math.max(1, Math.round(hook.timeout))}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The PreToolUse command that sends every Codex tool call to the Gate. */
export function codexPolicyHook(paths: { node: string; policyHook: string }, id: string): CodexHook {
  const command = [quoteArg(paths.node), "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", quoteArg(paths.policyHook), id, "--engine", "codex"].join(" ");
  return { event: "PreToolUse", matcher: "*", command, timeout: 30 };
}
