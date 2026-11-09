// The ASD-STE100 rules Cobra's checker enforces. The check IDs are Cobra's
// own; `section` names the part of the specification each one comes from.
// Rules the checker cannot judge (one topic per sentence, keeping articles)
// live only in the prompt, and the schema enforces that a WARNING or CAUTION
// comes before its step.

export const LIMITS = {
  procedureWords: 20,
  descriptiveWords: 25,
  paragraphSentences: 6,
  nounCluster: 3,
} as const;

export type CheckId = "W1" | "N1" | "V1" | "V2" | "V3" | "P1" | "P2" | "P3" | "D1" | "D2" | "X1";

export type CheckInfo = {
  rule: string;
  section: string;
  /** A heuristic check can flag text that is in fact correct; the model reviews it. */
  heuristic: boolean;
  /** Needs the approved-word dictionary; skipped without one. */
  needsDictionary: boolean;
};

export const CHECKS: Record<CheckId, CheckInfo> = {
  W1: {
    rule: "Use only approved words, in their approved meaning and part of speech.",
    section: "1 Words",
    heuristic: false,
    needsDictionary: true,
  },
  N1: {
    rule: "Do not use noun clusters of more than 3 words.",
    section: "2 Noun clusters",
    heuristic: true,
    needsDictionary: true,
  },
  V1: {
    rule: "Use only the approved forms of a verb.",
    section: "3 Verbs",
    heuristic: false,
    needsDictionary: true,
  },
  V2: {
    rule: "Do not use -ing verb forms, except inside technical names.",
    section: "3 Verbs",
    heuristic: false,
    needsDictionary: false,
  },
  V3: {
    rule: "Use the active voice. Procedures are always active.",
    section: "3 Verbs",
    heuristic: true,
    needsDictionary: false,
  },
  P1: {
    rule: `A procedural sentence has no more than ${LIMITS.procedureWords} words.`,
    section: "5 Procedures",
    heuristic: false,
    needsDictionary: false,
  },
  P2: {
    rule: "Write one instruction per sentence, or two only when you do them at the same time.",
    section: "5 Procedures",
    heuristic: true,
    needsDictionary: false,
  },
  P3: {
    rule: "Write instructions in the imperative.",
    section: "5 Procedures",
    heuristic: false,
    needsDictionary: false,
  },
  D1: {
    rule: `A descriptive sentence has no more than ${LIMITS.descriptiveWords} words.`,
    section: "6 Descriptive writing",
    heuristic: false,
    needsDictionary: false,
  },
  D2: {
    rule: `A paragraph has one topic and no more than ${LIMITS.paragraphSentences} sentences.`,
    section: "6 Descriptive writing",
    heuristic: false,
    needsDictionary: false,
  },
  X1: {
    rule: "A WARNING or CAUTION starts with a simple, clear command, then gives the risk.",
    section: "7 Safety instructions",
    heuristic: true,
    needsDictionary: false,
  },
};
