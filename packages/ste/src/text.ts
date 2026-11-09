// Splitting text into sentences and words the way the checker counts them.
//
// A code span, a quoted label, a number and a path or file name each count as
// one word, and none of them is looked up in the dictionary. Citation markers
// such as [1] do not count at all.

export type TokenKind = "word" | "number" | "code" | "name";

export type Token = {
  text: string;
  kind: TokenKind;
  /** First letter is upper case. A capitalized word after the first is a proper name. */
  capitalized: boolean;
};

const CODE_RE = /`[^`]*`/g;
const QUOTE_RE = /"[^"]*"|“[^”]*”/g;
const CITE_RE = /\[\d+(?:\s*[,–-]\s*\d+)*\]/g;
const HELD_RE = /\u0000(\d+)\u0000/g;
const TOKEN_RE = /\u0000(\d+)\u0000|[$€£]?\d[\d.,:]*%?|[A-Za-z$][A-Za-z0-9'’_./=+-]*[A-Za-z0-9]|[A-Za-z]/g;

type Held = { text: string; kind: "code" | "name" };

function hold(text: string): { masked: string; held: Held[] } {
  const held: Held[] = [];
  const masked = text
    .replace(CODE_RE, (m) => `\u0000${held.push({ text: m, kind: "code" }) - 1}\u0000`)
    .replace(QUOTE_RE, (m) => `\u0000${held.push({ text: m, kind: "name" }) - 1}\u0000`);
  return { masked, held };
}

function restore(text: string, held: Held[]): string {
  return text.replace(HELD_RE, (_, i: string) => held[Number(i)]?.text ?? "");
}

/** The sentences in one string. Code spans and quoted labels never split a sentence. */
export function splitSentences(text: string): string[] {
  const { masked, held } = hold(text.trim());
  if (!masked) return [];
  return masked
    .split(/(?<=[.!?])\s+(?=\S)/)
    .map((s) => restore(s, held).trim())
    .filter((s) => s.length > 0);
}

export function tokenize(sentence: string): Token[] {
  const { masked, held } = hold(sentence.replace(CITE_RE, " "));
  const tokens: Token[] = [];
  for (const match of masked.matchAll(TOKEN_RE)) {
    const heldIndex = match[1];
    if (heldIndex !== undefined) {
      const h = held[Number(heldIndex)];
      if (h) tokens.push({ text: h.text, kind: h.kind, capitalized: false });
      continue;
    }
    const text = match[0].replace(/[.,:]+$/, "");
    if (!text) continue;
    let kind: TokenKind = "word";
    if (/^[$€£]?\d/.test(text)) kind = "number";
    else if (text.startsWith("$") || /[./=_+]/.test(text)) kind = "code";
    tokens.push({ text, kind, capitalized: /^[A-Z]/.test(text) });
  }
  return tokens;
}

export function wordCount(sentence: string): number {
  return tokenize(sentence).length;
}

/** The form a word is looked up by: lower case, curly apostrophes straightened, possessive dropped. */
export function lookupForm(word: string): string {
  return word.toLowerCase().replace(/’/g, "'").replace(/'s$/, "");
}
