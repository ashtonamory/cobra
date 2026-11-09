import type { SteReport } from "./check.ts";

// A report as a printable page, for the PDF a deep answer shares as. Always
// light and black on white, whatever the phone's appearance. Diagrams arrive as
// SVG already drawn (the app's WebView draws them); one that could not be drawn
// prints its Mermaid source instead.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Backticks become <code>; everything else is escaped. */
function inline(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function sentences(list: readonly string[]): string {
  return list.map(inline).join(" ");
}

export type ReportHtmlOptions = {
  /** One entry per diagram, in order; null when it could not be drawn. */
  svgs?: ReadonlyArray<string | null>;
  /** "5 October 2026". */
  date?: string;
  /** The checker's verdict, such as "STE structure ✓". */
  checkLabel?: string;
};

export function reportToHtml(report: SteReport, options: ReportHtmlOptions = {}): string {
  const parts: string[] = [];
  parts.push(`<p class="eyebrow">Cobra · Deep answer${options.date ? ` · ${escapeHtml(options.date)}` : ""}</p>`);
  parts.push(`<h1>${inline(report.title)}</h1>`);
  parts.push(`<h2>Summary</h2><p>${sentences(report.summary)}</p>`);

  if (report.description.length) {
    parts.push(`<h2>Description</h2>`);
    for (const p of report.description) parts.push(`<p>${sentences(p.sentences)}</p>`);
  }

  if (report.procedure.length) {
    parts.push(`<h2>Procedure</h2><ol class="steps">`);
    report.procedure.forEach((step) => {
      for (const b of step.before ?? []) {
        parts.push(`<li class="safety ${b.kind.toLowerCase()}"><b>${b.kind}:</b> ${sentences(b.sentences)}</li>`);
      }
      const result = step.result ? `<span class="result">Result: ${inline(step.result)}</span>` : "";
      parts.push(`<li class="step">${inline(step.text)}${result}</li>`);
      if (step.note?.length) parts.push(`<li class="note"><b>NOTE:</b> ${sentences(step.note)}</li>`);
    });
    parts.push(`</ol>`);
  }

  report.diagrams.forEach((d, i) => {
    const svg = options.svgs?.[i];
    const body = svg ? `<div class="svg">${svg}</div>` : `<pre>${escapeHtml(d.mermaid)}</pre>`;
    parts.push(`<figure><figcaption>Diagram ${i + 1} · ${inline(d.caption)}</figcaption>${body}</figure>`);
  });

  if (report.sources.length) {
    parts.push(`<h2>Sources</h2><ol class="sources">`);
    for (const s of report.sources) {
      const where = s.url ? `<br><span class="url">${escapeHtml(s.url)}</span>` : s.cobra ? ` <span class="url">(Cobra: ${escapeHtml(s.cobra)})</span>` : "";
      parts.push(`<li>${inline(s.title)}${where}</li>`);
    }
    parts.push(`</ol>`);
  }

  if (options.checkLabel) parts.push(`<p class="check">${escapeHtml(options.checkLabel)}</p>`);

  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { margin: 48px 52px; }
body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #000; background: #fff; font-size: 12pt; line-height: 1.45; margin: 0; }
.eyebrow { font-size: 8.5pt; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #6b6b6b; margin: 0 0 6px; }
h1 { font-size: 22pt; font-weight: 800; letter-spacing: -0.02em; line-height: 1.1; margin: 0 0 18px; }
h2 { font-size: 8.5pt; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: #6b6b6b; border-bottom: 1px solid #e8e8e8; padding-bottom: 4px; margin: 22px 0 8px; }
p { margin: 0 0 8px; }
code, pre { font-family: Menlo, monospace; font-size: 10pt; }
code { background: #f2f2f2; padding: 0 3px; border-radius: 3px; }
pre { white-space: pre-wrap; background: #f2f2f2; padding: 8px; border-radius: 6px; }
ol.steps { list-style: none; counter-reset: s; padding: 0; margin: 0; }
ol.steps li { margin: 0 0 8px; break-inside: avoid; }
ol.steps li.step { counter-increment: s; padding-left: 26px; position: relative; }
ol.steps li.step::before { content: counter(s) "."; position: absolute; left: 0; font-weight: 700; }
.result { display: block; color: #6b6b6b; font-size: 10.5pt; }
li.safety { border: 1px solid #000; border-radius: 6px; padding: 6px 9px; }
li.safety.warning { border-color: #d93a2b; }
li.safety.warning b { color: #d93a2b; }
li.note { padding-left: 26px; color: #6b6b6b; }
li.note b { color: #000; }
figure { margin: 18px 0; break-inside: avoid; }
figcaption { font-size: 8.5pt; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: #6b6b6b; margin-bottom: 6px; }
.svg { border: 1px solid #e8e8e8; border-radius: 8px; padding: 10px; text-align: center; }
.svg svg { max-width: 100%; height: auto; }
ol.sources { padding-left: 20px; font-size: 10.5pt; }
ol.sources li { margin-bottom: 4px; }
.url { color: #6b6b6b; word-break: break-all; font-size: 9.5pt; }
.check { margin-top: 24px; font-size: 9pt; color: #6b6b6b; }
</style></head><body>${parts.join("\n")}</body></html>`;
}
