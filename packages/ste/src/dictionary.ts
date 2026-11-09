import { z } from "zod";

// The ASD-STE100 dictionary as the checker reads it. The data comes from your
// own copy of the specification (see data/README.md); ASD holds its copyright,
// so it is never published or bundled into anything that leaves this repo.

export const PartOfSpeech = z.enum([
  "noun",
  "verb",
  "adjective",
  "adverb",
  "preposition",
  "conjunction",
  "pronoun",
  "article",
]);
export type PartOfSpeech = z.infer<typeof PartOfSpeech>;

export const DictionaryEntry = z.object({
  /** Base form, lower case. May be several words ("make sure"). */
  word: z.string().min(1),
  pos: PartOfSpeech,
  approved: z.boolean(),
  /** The other approved forms: a verb's -s, past and participle; an adjective's comparison. */
  forms: z.array(z.string()).optional(),
  /** The one approved meaning. */
  meaning: z.string().optional(),
  /** For a word that is not approved: the approved words to use. */
  use: z.array(z.string()).optional(),
});
export type DictionaryEntry = z.infer<typeof DictionaryEntry>;

export type Dictionary = {
  size: number;
  /** Every entry this exact form belongs to, approved or not. */
  lookup(form: string): DictionaryEntry[];
  /** An approved verb this form is an inflection of, when the form itself is not approved. */
  verbOf(form: string): DictionaryEntry | undefined;
  /** Multi-word entries, longest first, as lists of words. */
  phrases: { words: string[]; entry: DictionaryEntry }[];
};

/** The regular inflections of a base word, used to catch "ensured" for "ensure" or "starting" for "start". */
export function inflections(base: string): string[] {
  const out = [`${base}s`, `${base}es`, `${base}ed`, `${base}d`, `${base}ing`];
  if (base.endsWith("e")) out.push(`${base.slice(0, -1)}ing`);
  if (base.endsWith("y")) out.push(`${base.slice(0, -1)}ies`, `${base.slice(0, -1)}ied`);
  if (/[^aeiou][aeiou][bdgklmnprt]$/.test(base)) {
    const doubled = base + base.slice(-1);
    out.push(`${doubled}ed`, `${doubled}ing`);
  }
  return out;
}

function plurals(noun: string): string[] {
  if (/(s|x|z|ch|sh)$/.test(noun)) return [`${noun}es`];
  if (/[^aeiou]y$/.test(noun)) return [`${noun.slice(0, -1)}ies`];
  return [`${noun}s`];
}

export function buildDictionary(entries: readonly DictionaryEntry[]): Dictionary {
  const byForm = new Map<string, DictionaryEntry[]>();
  const verbs = new Map<string, DictionaryEntry>();
  const phrases: Dictionary["phrases"] = [];
  const add = (form: string, entry: DictionaryEntry) => {
    const key = form.toLowerCase();
    const list = byForm.get(key);
    if (list) {
      if (!list.includes(entry)) list.push(entry);
    } else byForm.set(key, [entry]);
  };

  for (const entry of entries) {
    const word = entry.word.toLowerCase();
    if (word.includes(" ")) {
      phrases.push({ words: word.split(/\s+/), entry });
      continue;
    }
    add(word, entry);
    for (const form of entry.forms ?? []) add(form, entry);
    if (entry.approved && entry.pos === "noun") for (const p of plurals(word)) add(p, entry);
  }

  // A word that is not approved is not approved in any form either.
  for (const entry of entries) {
    if (entry.approved || entry.word.includes(" ")) continue;
    for (const form of inflections(entry.word.toLowerCase())) {
      if (!byForm.get(form)?.some((e) => e.approved)) add(form, entry);
    }
  }

  // Inflections of approved verbs that the dictionary does not allow.
  for (const entry of entries) {
    if (!entry.approved || entry.pos !== "verb" || entry.word.includes(" ")) continue;
    for (const form of inflections(entry.word.toLowerCase())) {
      if (!byForm.has(form) && !verbs.has(form)) verbs.set(form, entry);
    }
  }

  phrases.sort((a, b) => b.words.length - a.words.length);
  return {
    size: entries.length,
    lookup: (form) => byForm.get(form.toLowerCase()) ?? [],
    verbOf: (form) => verbs.get(form.toLowerCase()),
    phrases,
  };
}

/** Reads dictionary data (an array of entries) and builds the lookup. Throws on a malformed file. */
export function parseDictionary(data: unknown): Dictionary {
  return buildDictionary(z.array(DictionaryEntry).parse(data));
}
