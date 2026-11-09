import { checkDraft, type SteReport } from "./check.ts";
import type { Dictionary } from "./dictionary.ts";
import { deepSystemPrompt, parseDraft, repairPrompt, revisionPrompt } from "./prompt.ts";

// One deep answer, start to finish: research, read the JSON (one repair if it
// does not parse), check it against STE, and revise once. The model call is
// injected, so this package stays free of any provider code. (The phone's
// deep lane that called it went with the life app.)

export type DeepSourceFound = { url: string; title: string };

export type DeepCall = {
  text: string;
  model: string;
  searches: number;
  sources: DeepSourceFound[];
  costCents: number;
  truncated: boolean;
};

export type DeepCallRequest = {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** False for the repair and revision passes: they rework text, they do not research. */
  search: boolean;
};

export type DeepStage = "research" | "repair" | "revise";

export type DeepRunInput = {
  question: string;
  /** Recent conversation, oldest first. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  now: string;
  diagrams: number;
  knownNames?: readonly string[];
  dictionary?: Dictionary;
  generate: (request: DeepCallRequest) => Promise<DeepCall>;
  onStage?: (stage: DeepStage) => void;
};

export type DeepRunOutput = {
  report: SteReport;
  model: string;
  costCents: number;
  searches: number;
  /** Pages the research actually found or cited: the report's sources are checked against these. */
  found: DeepSourceFound[];
  calls: number;
};

export class DeepRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepRunError";
  }
}

/** The longest model reply the repair pass quotes back. */
const REPAIR_QUOTE_CHARS = 60_000;

export async function runDeepAnswer(input: DeepRunInput): Promise<DeepRunOutput> {
  const system = deepSystemPrompt({ now: input.now, diagrams: input.diagrams, knownNames: input.knownNames });
  const found = new Map<string, DeepSourceFound>();
  let costCents = 0;
  let searches = 0;
  let calls = 0;
  let model = "";

  const call = async (request: DeepCallRequest, stage: DeepStage): Promise<DeepCall> => {
    input.onStage?.(stage);
    const result = await input.generate(request);
    calls += 1;
    costCents += result.costCents;
    searches += result.searches;
    model = result.model;
    for (const s of result.sources) if (!found.has(s.url)) found.set(s.url, s);
    if (result.truncated) throw new DeepRunError("The answer ran out of room before it finished. Ask a narrower question.");
    return result;
  };

  const research = await call(
    { system, messages: [...(input.history ?? []), { role: "user", content: input.question }], search: true },
    "research",
  );

  let parsed = parseDraft(research.text);
  if (!parsed.ok) {
    const repair = await call(
      {
        system,
        messages: [
          {
            role: "user",
            content: `Question: ${input.question}\n\n${repairPrompt(parsed.error, research.text.slice(0, REPAIR_QUOTE_CHARS))}`,
          },
        ],
        search: false,
      },
      "repair",
    );
    parsed = parseDraft(repair.text);
    if (!parsed.ok) throw new DeepRunError("Cobra could not read the answer. Try again.");
  }

  const options = { dictionary: input.dictionary, technicalNames: input.knownNames };
  let draft = parsed.draft;
  let check = checkDraft(draft, options);
  let revised = false;

  if (check.violations.length > 0) {
    const revision = await call(
      {
        system,
        messages: [{ role: "user", content: `Question: ${input.question}\n\n${revisionPrompt(draft, check.violations)}` }],
        search: false,
      },
      "revise",
    );
    const next = parseDraft(revision.text);
    // A revision that makes things worse, or does not parse, is dropped: the
    // first draft and its count stand.
    if (next.ok) {
      const nextCheck = checkDraft(next.draft, options);
      if (nextCheck.violations.length <= check.violations.length) {
        draft = next.draft;
        check = nextCheck;
        revised = true;
      }
    }
  }

  return { report: { ...draft, check, revised }, model, costCents, searches, found: [...found.values()], calls };
}

/** True when a report's source URL was among the pages the research found. Compares host and path, not query or fragment. */
export function sourceWasFound(url: string, found: readonly DeepSourceFound[]): boolean {
  const key = (u: string) => {
    try {
      const p = new URL(u);
      return `${p.hostname.replace(/^www\./, "")}${p.pathname.replace(/\/$/, "")}`;
    } catch {
      return u;
    }
  };
  const target = key(url);
  return found.some((f) => key(f.url) === target);
}
