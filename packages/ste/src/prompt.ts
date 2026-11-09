import type { SteViolation } from "./check.ts";
import { SteDraft } from "./report.ts";
import { LIMITS } from "./rules.ts";

// The words the model sees. Provider-agnostic: the Claude Code skill quotes
// the same rules.

/** Added to the normal chat prompt so the model can offer a deep answer. */
export const PROPOSAL_INSTRUCTION = `When a question needs more than a short reply (several steps that depend on each other, a failure path, a decision with trade-offs, or facts you would need to look up), answer it briefly first. Then end your reply with one marker on its own line:
[Deep: <one sentence: why a deep answer would help> | diagrams=<0 to 3>]
Do not add the marker for small talk, for simple facts, or when you already answered fully. Never mention the marker.`;

export const STE_RULES = `Write in ASD-STE100 Simplified Technical English:
- Use only approved words, in their approved meaning and part of speech. You can use technical names (names of things, programs, screens) and technical verbs (such as "tap"). List every one you use in "technicalNames" or "technicalVerbs".
- Use only these verb forms: imperative, infinitive, simple present, simple past, future, and the past participle as an adjective. Do not use -ing forms.
- Use the active voice. Procedures are always active.
- Do not make noun clusters of more than ${LIMITS.nounCluster} words.
- One topic per sentence. Keep "the", "a" and other short words that make a sentence clear.
- A procedure step is one instruction in the imperative, with no more than ${LIMITS.procedureWords} words. Two instructions go in one step only when you do them at the same time.
- A descriptive sentence has no more than ${LIMITS.descriptiveWords} words. A paragraph has one topic and no more than ${LIMITS.paragraphSentences} sentences.
- A WARNING (risk to people) or CAUTION (risk to data or equipment) starts with a simple, clear command, then gives the risk. Attach it to the step it comes before.
- Put commands, file names and code in backticks. Put labels that you see on a screen in double quotes.`;

/** The JSON shape of a report, as the model is told it. */
export const REPORT_FORMAT = `Reply with one JSON object and nothing else:
{
  "title": string,                       // a short name for the answer
  "summary": [string],                   // 1 to 3 descriptive sentences
  "description": [{ "sentences": [string] }],  // paragraphs
  "procedure": [{
    "text": string,                      // one instruction
    "result"?: string,                   // what the user sees when it worked
    "before"?: [{ "kind": "WARNING" | "CAUTION", "sentences": [string] }],
    "note"?: [string]
  }],                                    // empty when there is nothing to do
  "diagrams": [{ "kind": "flowchart" | "sequence" | "state", "caption": string, "mermaid": string }],
  "sources": [{ "title": string, "url"?: string, "cobra"?: string }],
  "technicalNames": [string],
  "technicalVerbs": [string]
}
Cite sources inline with [1], [2] in the order of "sources". A source from the user's own data uses "cobra" (for example "Routines → Evening reset") and no url.
Diagrams use Mermaid syntax. Keep node labels short, and put a label in double quotes when it has punctuation. Do not set colors or themes.`;

export type DeepPromptOptions = {
  /** For example "Monday 5 October 2026, 21:40". */
  now: string;
  diagrams: number;
  /** Names Cobra already knows: computers, screens, routines. The model may use them freely. */
  knownNames?: readonly string[];
};

export function deepSystemPrompt(options: DeepPromptOptions): string {
  const names = options.knownNames?.length
    ? `\nThese names are already technical names: ${options.knownNames.join(", ")}.`
    : "";
  return `You are Cobra, giving a deep answer: researched, careful and complete. It is ${options.now}.
Think it through, and search the web when facts could be out of date or you are not sure. Prefer primary sources, such as manuals and official documentation.
Include ${options.diagrams > 0 ? `${options.diagrams} diagram${options.diagrams === 1 ? "" : "s"}` : "a diagram only if a flow or a sequence makes the answer clearer"}.

${STE_RULES}${names}

${REPORT_FORMAT}`;
}

/** The follow-up message for the one revision pass. */
export function revisionPrompt(draft: SteDraft, violations: readonly SteViolation[]): string {
  const lines = violations.map((v) => {
    const use = v.use?.length ? ` Use: ${v.use.join(" / ")}.` : "";
    const check = v.heuristic ? " (possible; keep the sentence if it is correct STE)" : "";
    return `- ${v.where} [${v.check}]${check}: ${v.message}${use}\n  "${v.sentence}"`;
  });
  return `A checker found these STE problems in your answer:
${lines.join("\n")}

Fix each one. Do not change the facts, the sources or the diagrams' meaning. Reply with the whole corrected JSON object and nothing else.

${JSON.stringify(draft)}`;
}

/** The follow-up when the first reply is not a valid report. */
export function repairPrompt(error: string, reply: string): string {
  return `Your answer below is not a valid report. ${error}
Reply with the whole report as one JSON object in the format you were given, and nothing else. Keep the content.

${reply}`;
}

export type ParsedDraft = { ok: true; draft: SteDraft } | { ok: false; error: string };

/** Reads the model's reply: plain JSON, or JSON in a code fence, with text around it. */
export function parseDraft(reply: string): ParsedDraft {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? reply;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "The reply has no JSON object." };
  let data: unknown;
  try {
    data = JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    return { ok: false, error: `The JSON does not parse: ${(error as Error).message}` };
  }
  const result = SteDraft.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, error: `The JSON is not a valid report: ${issue?.path.join(".") || "root"}: ${issue?.message}` };
  }
  return { ok: true, draft: result.data };
}
