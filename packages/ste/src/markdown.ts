import type { SteCheck } from "./check.ts";
import type { SteDraft } from "./report.ts";

// A report as markdown with Mermaid fences: what the Claude Code skill writes,
// and what renders in the phone's computer chat.

export function reportToMarkdown(report: SteDraft, check?: SteCheck): string {
  const out: string[] = [`# ${report.title}`, "", "## Summary", "", report.summary.join(" ")];

  if (report.description.length) {
    out.push("", "## Description");
    for (const p of report.description) out.push("", p.sentences.join(" "));
  }

  if (report.procedure.length) {
    out.push("", "## Procedure", "");
    report.procedure.forEach((step, i) => {
      for (const b of step.before ?? []) {
        out.push(`> **${b.kind}:** ${b.sentences.join(" ")}`, "");
      }
      out.push(`${i + 1}. ${step.text}`);
      if (step.result) out.push(`   *Result:* ${step.result}`);
      if (step.note) out.push("", `   **NOTE:** ${step.note.join(" ")}`);
      out.push("");
    });
    out.pop();
  }

  report.diagrams.forEach((d, i) => {
    out.push("", `## Diagram ${i + 1}: ${d.caption}`, "", "```mermaid", d.mermaid.trim(), "```");
  });

  if (report.sources.length) {
    out.push("", "## Sources", "");
    report.sources.forEach((s, i) => {
      const where = s.url ? ` <${s.url}>` : s.cobra ? ` (Cobra: ${s.cobra})` : "";
      out.push(`${i + 1}. ${s.title}${where}`);
    });
  }

  if (check) {
    const n = check.violations.length;
    const status = n === 0 ? "no violations" : `${n} violation${n === 1 ? "" : "s"} left`;
    const dict = check.dictionary ? "" : ", dictionary not loaded";
    out.push("", `---`, `STE check: ${status}${dict}.`);
  }
  return `${out.join("\n")}\n`;
}
