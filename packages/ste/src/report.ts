import { z } from "zod";

// What a deep run produces. The model writes an SteDraft as JSON; Cobra checks
// it and stores an SteReport, which adds the check. Text stays in arrays of
// sentences so the checker can hold each one to the limit for its kind.

const Sentences = z.array(z.string().min(1));

export const SafetyBlock = z.object({
  kind: z.enum(["WARNING", "CAUTION"]),
  /** The first sentence is a command; the rest give the risk. */
  sentences: Sentences.min(1),
});
export type SafetyBlock = z.infer<typeof SafetyBlock>;

export const Step = z.object({
  /** One instruction, in the imperative. */
  text: z.string().min(1),
  /** What you see when the step worked. */
  result: z.string().min(1).optional(),
  /** Safety blocks come before the step they apply to, so they live on it. */
  before: z.array(SafetyBlock).optional(),
  note: Sentences.optional(),
});
export type Step = z.infer<typeof Step>;

export const Diagram = z.object({
  kind: z.enum(["flowchart", "sequence", "state"]),
  caption: z.string().min(1),
  mermaid: z.string().min(1),
});
export type Diagram = z.infer<typeof Diagram>;

export const Source = z
  .object({
    title: z.string().min(1),
    url: z.string().url().optional(),
    /** A pointer into Cobra's own data, such as "Routines → Evening reset". */
    cobra: z.string().min(1).optional(),
  })
  .refine((s) => s.url !== undefined || s.cobra !== undefined, "a source needs a url or a Cobra pointer");
export type Source = z.infer<typeof Source>;

export const SteDraft = z.object({
  title: z.string().min(1),
  summary: Sentences.min(1),
  description: z.array(z.object({ sentences: Sentences.min(1) })),
  procedure: z.array(Step),
  diagrams: z.array(Diagram),
  sources: z.array(Source),
  /** Technical names the answer uses (STE allows them); the checker accepts these words. */
  technicalNames: z.array(z.string().min(1)).default([]),
  /** Technical verbs, such as "tap" for a phone screen. */
  technicalVerbs: z.array(z.string().min(1)).default([]),
});
export type SteDraft = z.infer<typeof SteDraft>;
