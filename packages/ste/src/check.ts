import type { Dictionary, DictionaryEntry } from "./dictionary.ts";
import { inflections } from "./dictionary.ts";
import type { SteDraft } from "./report.ts";
import { CHECKS, LIMITS, type CheckId } from "./rules.ts";
import { lookupForm, splitSentences, tokenize, type Token } from "./text.ts";

export type SteViolation = {
  check: CheckId;
  /** Where in the draft, such as "procedure[2].text". */
  where: string;
  sentence: string;
  word?: string;
  message: string;
  /** Approved words to use instead, when the dictionary gives them. */
  use?: string[];
  heuristic: boolean;
};

export type SteCheck = {
  violations: SteViolation[];
  sentences: number;
  /** False when no dictionary was loaded, so W1, V1 and N1 did not run. */
  dictionary: boolean;
};

export type SteReport = SteDraft & { check: SteCheck; revised: boolean };

export type CheckOptions = {
  dictionary?: Dictionary;
  /** Names Cobra always accepts: computers, screens, people in your data. */
  technicalNames?: readonly string[];
  technicalVerbs?: readonly string[];
};

/** How a sentence is held to the rules. */
type Kind = "step" | "safety" | "descriptive";

// Without a dictionary, these words confirm that a step starts with a command.
// A step that starts with a word on neither list is not flagged.
const COMMON_IMPERATIVES = new Set(
  (
    "add adjust apply attach check clean clear close connect copy cut do drag enter find get give go hold " +
    "install keep let look make move open paste press pull push put read record remove replace restart run " +
    "save select send set show start stop switch tap touch turn type use wait write"
  ).split(" "),
);
const NOT_IMPERATIVE = new Set(
  "a an the this that these those it its you your we our they their he she there here i my".split(" "),
);
const CONDITION_STARTS = new Set("if when before after while until as for on in at to".split(" "));
const BE = new Set("is are was were be been being am".split(" "));
const BETWEEN_BE_AND_PARTICIPLE = new Set("not also then always never fully only all".split(" "));
const IRREGULAR_PARTICIPLES = new Set(
  (
    "begun broken brought built chosen done drawn driven eaten fallen found forgotten frozen given gone " +
    "held hidden kept known laid left lost made meant paid put read run said seen sent set shown shut " +
    "sold spoken stolen struck taken taught told thought thrown torn understood won worn written"
  ).split(" "),
);
// -ing words that are not verb forms, for when there is no dictionary to ask.
const ING_NOT_VERB = new Set(
  "bring during thing nothing something anything everything string spring ring king sing sling sting swing wing morning evening ceiling".split(
    " ",
  ),
);

type Allow = { phrases: string[][]; verbs: Set<string> };

function phraseList(names: readonly string[]): string[][] {
  return names
    .map((n) => tokenize(n).map((t) => lookupForm(t.text)))
    .filter((w) => w.length > 0)
    .sort((a, b) => b.length - a.length);
}

function matchesAt(words: string[], at: number, phrase: string[]): boolean {
  return phrase.every((w, i) => words[at + i] === w);
}

function onlyUnapproved(entries: DictionaryEntry[]): boolean {
  return entries.length > 0 && entries.every((e) => !e.approved);
}

export function checkDraft(draft: SteDraft, options: CheckOptions = {}): SteCheck {
  const dict = options.dictionary;
  const violations: SteViolation[] = [];
  let sentences = 0;

  // A declared technical name that the dictionary marks as not approved is
  // refused: "ensure" does not become allowed by calling it technical.
  const declare = (names: readonly string[], where: string): string[] =>
    names.filter((name) => {
      if (!dict || name.trim().includes(" ")) return true;
      if (!onlyUnapproved(dict.lookup(lookupForm(name)))) return true;
      violations.push({
        check: "W1",
        where,
        sentence: name,
        word: name,
        message: `"${name}" is not an approved word, so it cannot be a technical name.`,
        use: dict.lookup(lookupForm(name))[0]?.use,
        heuristic: false,
      });
      return false;
    });
  const names = [...(options.technicalNames ?? []), ...declare(draft.technicalNames, "technicalNames")];
  const verbs = [...(options.technicalVerbs ?? []), ...declare(draft.technicalVerbs, "technicalVerbs")];
  const allow: Allow = {
    phrases: phraseList([...names, ...verbs]),
    verbs: new Set(verbs.flatMap((v) => [lookupForm(v), ...inflections(lookupForm(v))].filter((f) => !f.endsWith("ing")))),
  };

  const flag = (check: CheckId, where: string, sentence: string, message: string, extra: Partial<SteViolation> = {}) =>
    violations.push({ check, where, sentence, message, heuristic: CHECKS[check].heuristic, ...extra });

  const isVerbBase = (word: string): boolean | undefined => {
    const form = lookupForm(word);
    if (allow.verbs.has(form)) return true;
    if (dict) return dict.lookup(form).some((e) => e.approved && e.pos === "verb" && e.word === form);
    if (COMMON_IMPERATIVES.has(form)) return true;
    if (NOT_IMPERATIVE.has(form)) return false;
    return undefined;
  };

  /** The tokens of the instruction itself, after a leading condition ("Before you log in,") and "Do not". */
  const instruction = (sentence: string): Token[] => {
    let tokens = tokenize(sentence);
    const first = tokens[0] ? lookupForm(tokens[0].text) : "";
    const comma = sentence.indexOf(",");
    if (CONDITION_STARTS.has(first) && comma > 0) tokens = tokenize(sentence.slice(comma + 1));
    const [a, b] = tokens;
    if (a && b && lookupForm(a.text) === "do" && lookupForm(b.text) === "not") tokens = tokens.slice(2);
    return tokens;
  };

  const checkImperative = (check: "P3" | "X1", where: string, sentence: string) => {
    const tokens = instruction(sentence);
    const head = tokens[0];
    if (!head) return;
    const words = tokens.map((t) => lookupForm(t.text));
    const verbPhrase =
      allow.phrases.some((p) => p.length > 1 && matchesAt(words, 0, p) && allow.verbs.has(p.join(" "))) ||
      (dict?.phrases.some((p) => p.entry.approved && p.entry.pos === "verb" && matchesAt(words, 0, p.words)) ?? false);
    if (verbPhrase) return;
    if (head.kind === "word" && isVerbBase(head.text) === false) {
      flag(check, where, sentence, `Start with a command. "${head.text}" is not an approved verb in the imperative.`, {
        word: head.text,
      });
    } else if (head.kind !== "word") {
      flag(check, where, sentence, "Start with a command.");
    }
  };

  const checkOneInstruction = (where: string, sentence: string) => {
    const tokens = instruction(sentence);
    for (let i = 1; i < tokens.length - 1; i += 1) {
      const joiner = lookupForm(tokens[i]!.text);
      const next = tokens[i + 1]!;
      if ((joiner === "and" || joiner === "then") && next.kind === "word" && isVerbBase(next.text) === true) {
        flag("P2", where, sentence, `"${next.text}" starts a second instruction. Make it a separate step.`, {
          word: next.text,
        });
        return;
      }
    }
  };

  const checkWords = (where: string, sentence: string, tokens: Token[]) => {
    const words = tokens.map((t) => lookupForm(t.text));
    const allowed = new Array<boolean>(tokens.length).fill(false);

    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i]!;
      if (t.kind !== "word") allowed[i] = true;
      else if (t.capitalized && i > 0) allowed[i] = true; // a proper name
      if (allowed[i]) continue;
      const phrase = allow.phrases.find((p) => matchesAt(words, i, p));
      if (phrase) for (let j = 0; j < phrase.length; j += 1) allowed[i + j] = true;
    }

    // -ing forms (V2) need no dictionary.
    tokens.forEach((t, i) => {
      if (allowed[i] || t.kind !== "word") return;
      const form = words[i]!.split("-").pop()!;
      if (!form.endsWith("ing") || form.length < 5) return;
      const known = dict ? dict.lookup(form).some((e) => e.approved) : ING_NOT_VERB.has(form);
      // Without a dictionary an -ing noun ("setting") looks the same as a verb form.
      if (!known) {
        flag("V2", where, sentence, `"${t.text}" is an -ing form. Use another verb form or a noun.`, {
          word: t.text,
          heuristic: !dict,
        });
      }
      allowed[i] = true;
    });

    // Passive voice (V3): a form of "be", then a past participle.
    for (let i = 0; i < tokens.length - 1; i += 1) {
      if (!BE.has(words[i]!)) continue;
      let j = i + 1;
      while (j < tokens.length && (BETWEEN_BE_AND_PARTICIPLE.has(words[j]!) || words[j]!.endsWith("ly"))) j += 1;
      const p = words[j];
      if (!p || tokens[j]!.kind !== "word") continue;
      const participle = (p.endsWith("ed") && p.length > 3) || IRREGULAR_PARTICIPLES.has(p);
      const adjective = dict?.lookup(p).some((e) => e.approved && e.pos === "adjective") ?? false;
      if (participle && !adjective) {
        flag("V3", where, sentence, `"${tokens[i]!.text} ${tokens[j]!.text}" looks passive. Say who or what does the action.`, {
          word: tokens[j]!.text,
        });
      }
    }

    if (!dict) return;

    // Approved words (W1) and verb forms (V1).
    for (let i = 0; i < tokens.length; i += 1) {
      if (allowed[i]) continue;
      const phrase = dict.phrases.find((p) => matchesAt(words, i, p.words));
      if (phrase) {
        if (!phrase.entry.approved) {
          flag("W1", where, sentence, `"${phrase.words.join(" ")}" is not approved.`, {
            word: phrase.words.join(" "),
            use: phrase.entry.use,
          });
        }
        for (let j = 0; j < phrase.words.length; j += 1) allowed[i + j] = true;
        continue;
      }
      const form = words[i]!;
      const entries = dict.lookup(form);
      if (entries.some((e) => e.approved)) continue;
      const unapproved = entries.find((e) => !e.approved);
      if (unapproved) {
        flag("W1", where, sentence, `"${tokens[i]!.text}" is not approved.`, { word: tokens[i]!.text, use: unapproved.use });
        continue;
      }
      const verb = dict.verbOf(form);
      if (verb) {
        const approvedForms = [verb.word, ...(verb.forms ?? [])].join(", ");
        flag("V1", where, sentence, `"${tokens[i]!.text}" is not an approved form of "${verb.word}" (${approvedForms}).`, {
          word: tokens[i]!.text,
        });
        continue;
      }
      flag("W1", where, sentence, `"${tokens[i]!.text}" is not in the dictionary. Use an approved word, or declare it as a technical name.`, {
        word: tokens[i]!.text,
      });
    }

    // Noun clusters (N1): more than 3 nouns, adjectives or names in a row.
    let run = 0;
    for (let i = 0; i <= tokens.length; i += 1) {
      const t = tokens[i];
      const nominal =
        t !== undefined &&
        (t.kind === "code" ||
          t.kind === "name" ||
          (t.kind === "word" && (i > 0 && t.capitalized)) ||
          (t.kind === "word" &&
            (() => {
              const approved = dict.lookup(words[i]!).filter((e) => e.approved);
              return approved.length > 0 && approved.every((e) => e.pos === "noun" || e.pos === "adjective");
            })()));
      if (nominal) {
        run += 1;
        continue;
      }
      if (run > LIMITS.nounCluster) {
        const cluster = tokens.slice(i - run, i).map((x) => x.text).join(" ");
        flag("N1", where, sentence, `"${cluster}" is a noun cluster of ${run} words. Break it up with a preposition.`, {
          word: cluster,
        });
      }
      run = 0;
    }
  };

  const checkSentence = (kind: Kind, where: string, sentence: string, first: boolean) => {
    sentences += 1;
    const tokens = tokenize(sentence);
    const procedural = kind === "step" || (kind === "safety" && first);
    const limit = procedural ? LIMITS.procedureWords : LIMITS.descriptiveWords;
    if (tokens.length > limit) {
      flag(procedural ? "P1" : "D1", where, sentence, `${tokens.length} words. The limit is ${limit}.`);
    }
    if (kind === "step") {
      checkImperative("P3", where, sentence);
      checkOneInstruction(where, sentence);
    } else if (kind === "safety" && first) {
      checkImperative("X1", where, sentence);
    }
    checkWords(where, sentence, tokens);
  };

  const paragraph = (kind: Kind, where: string, items: readonly string[]) => {
    let count = 0;
    items.forEach((item, i) => {
      const at = `${where}[${i}]`;
      const parts = splitSentences(item);
      if (kind === "step" && parts.length > 1) {
        flag("P2", at, item, `A step has ${parts.length} sentences. Give each instruction its own step.`);
      }
      parts.forEach((s, k) => checkSentence(kind, at, s, count + k === 0));
      count += parts.length;
    });
    if (kind === "descriptive" && count > LIMITS.paragraphSentences) {
      flag("D2", where, items.join(" "), `${count} sentences. A paragraph has no more than ${LIMITS.paragraphSentences}.`);
    }
  };

  paragraph("descriptive", "summary", draft.summary);
  draft.description.forEach((p, i) => paragraph("descriptive", `description[${i}].sentences`, p.sentences));
  draft.procedure.forEach((step, i) => {
    const at = `procedure[${i}]`;
    step.before?.forEach((b, j) => paragraph("safety", `${at}.before[${j}].sentences`, b.sentences));
    paragraph("step", `${at}`, [step.text]);
    if (step.result) paragraph("descriptive", `${at}.result`, [step.result]);
    if (step.note) paragraph("descriptive", `${at}.note`, step.note);
  });
  draft.diagrams.forEach((d, i) => paragraph("descriptive", `diagrams[${i}].caption`, [d.caption]));

  // `paragraph` indexes single items as "[0]"; tidy those paths for steps and results.
  for (const v of violations) {
    v.where = v.where.replace(/^(procedure\[\d+\])\[0\]$/, "$1.text").replace(/\.(result|caption)\[0\]$/, ".$1");
  }
  return { violations, sentences, dictionary: dict !== undefined };
}
