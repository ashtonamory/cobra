import { isAbsolute, resolve } from "node:path";

import type { ToolCall } from "./policy.ts";

/**
 * Turns Codex PreToolUse events into the ToolCalls Cobra already knows how
 * to judge. This is deliberately an adapter, not a second policy engine:
 * Locked must mean the same thing for Claude and Codex.
 *
 * A null return means the event could not be interpreted safely. The Codex
 * hook path treats that as deny; it must never let an unreadable command or
 * patch bypass the Gate.
 */

const SHELL_TOOLS = new Set(["Bash", "exec_command", "shell", "shell_command", "local_shell", "container.exec"]);
const PATCH_TOOLS = new Set(["apply_patch", "Edit", "Write"]);
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/;

/** Quote one POSIX shell word only when it needs quoting. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command text policy.ts evaluates. Codex may send a string or argv. A
 * shell's `-c` payload is the command policy needs to inspect, not merely an
 * argument to a shell binary.
 */
export function commandText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((word) => typeof word === "string")) return null;
  const argv = raw as string[];
  const [program = "", flag = "", script] = argv;
  if (argv.length === 3 && /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh$/.test(program) && /^-l?c$/.test(flag) && script !== undefined) return script;
  return argv.map(shellQuote).join(" ");
}

/** Extract apply_patch text from the shapes Codex versions have emitted. */
export function patchText(input: Record<string, unknown>): string | null {
  for (const key of ["input", "patch", "command"]) {
    const value = input[key];
    if (typeof value === "string" && value.includes("*** Begin Patch")) return value;
    if (Array.isArray(value)) {
      const found = value.find((part): part is string => typeof part === "string" && part.includes("*** Begin Patch"));
      if (found) return found;
    }
  }
  return null;
}

/** List every file an apply_patch operation names, rooted at the event cwd. */
export function patchFiles(patch: string, cwd: string): string[] | null {
  const files: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = PATCH_FILE.exec(line);
    const name = (match?.[1] ?? match?.[2])?.trim();
    if (!name) continue;
    const path = isAbsolute(name) ? resolve(name) : resolve(cwd, name);
    if (!files.includes(path)) files.push(path);
  }
  return files.length > 0 ? files : null;
}

/**
 * One Codex operation can represent several policy-relevant edits. Every
 * returned call must be allowed. Unknown operation types remain visible to
 * the existing policy as-is, where containment remains the hard boundary.
 */
export function codexCalls(call: ToolCall): ToolCall[] | null {
  const { tool_name: tool, tool_input: input, cwd } = call;
  if (SHELL_TOOLS.has(tool)) {
    const command = commandText(input.command ?? input.cmd);
    if (command === null) return null;
    const workdir = typeof input.workdir === "string" && isAbsolute(input.workdir) ? input.workdir : cwd;
    return [{ tool_name: "Bash", tool_input: { command }, cwd: workdir }];
  }
  if (PATCH_TOOLS.has(tool)) {
    if (tool !== "apply_patch" && typeof input.file_path === "string") return [call];
    const patch = patchText(input);
    const files = patch ? patchFiles(patch, cwd) : null;
    if (!files) return null;
    return files.map((file_path) => ({ tool_name: "Edit", tool_input: { file_path }, cwd }));
  }
  return [call];
}
