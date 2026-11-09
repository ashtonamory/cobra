import { verifyChain, type Anchor } from "./auditLog.ts";
import { AUDIT_LOG, readAudit } from "./auditTrail.ts";

/**
 * `cobra-agent audit`: the audit log (auditTrail.ts), from the command line.
 *
 *   cobra-agent audit verify      check the chain across every kept file and this computer's daily anchors;
 *                                 exit 1 at the first broken link, named by file and line
 *   cobra-agent audit tail [n]    the newest n entries (20 by default), oldest of them first, in plain words;
 *                                 --all keeps the policy's decisions on Workers' tool calls
 *
 * `cobra-agent policy-log verify` is the old name of `audit verify`: the
 * policy's decisions are in the same log.
 */
export type AuditCliDeps = {
  path?: string;
  /** This computer's daily anchors (memory.ts), read only when verify needs them. */
  anchors: () => Anchor[];
  write: (line: string) => void;
};

/** Runs one command; returns the exit code. */
export function auditCommand(args: readonly string[], deps: AuditCliDeps): number {
  const path = deps.path ?? AUDIT_LOG;
  const say = (line: string) => deps.write(`${line}\n`);
  if (args[0] === "verify") {
    const anchors = deps.anchors();
    const report = verifyChain(path, anchors);
    const files = report.files.length === 0 ? "no log yet" : report.files.join(", ");
    if (report.broken) {
      say(`broken: ${report.broken.file}${report.broken.line > 0 ? ` line ${report.broken.line}` : ""} ${report.broken.why}`);
      say(`read: ${files}`);
      return 1;
    }
    say(`ok: ${report.chained} chained record${report.chained === 1 ? "" : "s"}${report.unchained > 0 ? `, after ${report.unchained} older one${report.unchained === 1 ? "" : "s"} from before the chain (not checked)` : ""}`);
    say(`read: ${files}`);
    say(`anchors: ${anchors.length === 0 ? "none (no memory folder, or no fold yet)" : `${report.anchors} of ${anchors.length} still in the kept files, all present`}`);
    if (report.head) say(`head: ${report.head}${report.headAt ? ` (${new Date(report.headAt).toString()})` : ""}`);
    return 0;
  }
  if (args[0] === "tail") {
    const counted = args.slice(1).find((arg) => /^\d+$/.test(arg));
    const limit = counted ? Math.max(1, Math.min(200, Number(counted))) : 20;
    const { entries } = readAudit({ limit, actions: !args.includes("--all") }, path);
    if (entries.length === 0) {
      say("Nothing in the audit log yet.");
      return 0;
    }
    for (const entry of [...entries].reverse()) {
      const where = [entry.subject?.project, entry.subject?.card].filter(Boolean).join(" ");
      say(`${new Date(entry.at).toISOString().replace("T", " ").slice(0, 19)}  ${entry.text}${where ? `  [${where}]` : ""}`);
    }
    return 0;
  }
  say("cobra-agent audit verify | tail [n] [--all]");
  return 1;
}
