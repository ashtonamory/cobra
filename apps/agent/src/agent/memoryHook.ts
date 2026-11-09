// The SessionStart hook of the Lead, a Foreman and a Worker: the memory brief
// for its role (memoryAccess.ts briefFor), added to the session's context at
// startup and after /clear or a compaction. The Lead's also carries the
// handoff from her conversation before (handoff.ts), the once it waits, and
// an on-call Foreman's its start note (onCall.ts), from its own folder.
//
//   node memoryHook.ts --dir <memory folder> --role lead|foreman|worker [--key <owner/repo>] [--handoff <folder>]
//
// It reads files only, never the network. Anything wrong (no memory yet, a bad
// argument, a crash) prints nothing and exits 0: a session never fails to
// start for want of memory.
import { briefFor, hookOutput, type MemoryRole } from "./memoryAccess.ts";
import { takeHandoff } from "./handoff.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

try {
  const dir = option("--dir");
  const role = option("--role");
  if (dir && (role === "lead" || role === "foreman" || role === "worker")) {
    const brief = briefFor(dir, role as MemoryRole, option("--key") ?? null);
    // Cobra's handoff from the conversation before (leadRotation.ts), once, above her brief.
    // An on-call Foreman's start note (onCall.ts): its handoff note and what came while it slept, once, above its brief.
    const folder = option("--handoff");
    let handoff = "";
    if (role === "lead" || (role === "foreman" && folder)) {
      try {
        handoff = role === "lead" ? takeHandoff() : takeHandoff(folder);
      } catch {
        // Nothing: it starts with its brief alone.
      }
    }
    const output = hookOutput([handoff, brief].filter(Boolean).join("\n\n"));
    if (output) process.stdout.write(`${output}\n`);
  }
} catch {
  // Nothing: the session starts without memory.
}
process.exit(0);
