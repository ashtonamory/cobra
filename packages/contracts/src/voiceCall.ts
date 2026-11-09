/**
 * Talk and Call (plan kept privately): the words and shapes the phone, the desk and
 * the agent share for Cobra's spoken voice.
 *
 * "Voice" in voice.ts means how Cobra words a reply; here it is the sound.
 * Zod-free: the agent runs this file by path (package.sh ships it).
 */

/** What Talk puts before the person's spoken words when it sends them to the Lead (`/session` say). */
export const VOICE_PREFIX = "[voice] ";

/** A message the person spoke (Talk), as the Lead's transcript holds it. */
export function isVoiceText(text: string): boolean {
  return text.trimStart().startsWith(VOICE_PREFIX.trim());
}

/** The person's words without the prefix. */
export function stripVoice(text: string): string {
  const trimmed = text.trimStart();
  return isVoiceText(trimmed) ? trimmed.slice(VOICE_PREFIX.trim().length).trimStart() : text;
}

/**
 * What the voice front's hand_to_cobra puts before the person's words when
 * it gives them to the Lead: spoken (so SPOKEN holds) and from a call, whose
 * voice front already wrote them in the thread, so her transcript's copy is
 * left out (agent thread.ts).
 */
export const CALL_PREFIX = "[voice] [call] ";

/** A message the voice front handed to the Lead during a call. */
export function isCallHandOff(text: string): boolean {
  return text.trimStart().startsWith(CALL_PREFIX.trim());
}

/** POST /voice/call/start: the call, and when it ends on the subscription (null on the API lane, whose cap rules instead). */
export type CallStart = {
  call: string;
  startedAt: string;
  endsAt: string | null;
  warnAt: string | null;
};

/** Why a call ended. */
export type CallEnd = "goodbye" | "time" | "idle" | "person" | "error";

/**
 * POST /voice/turn, and GET /voice/turn/next: what the voice front has said
 * so far in one turn. `parts` are whole clauses or sentences in order, from
 * index `from`; read the rest with next?after=`from + parts.length`.
 */
/** GET /voice/call/news: what Cobra finished during the call, to say when the person is quiet. */
export type CallNews = { news: string[]; ended?: CallEnd };

/** The push of a late answer: its Play action reads `spoken` aloud (phase V5). */
export const LATE_ANSWER_CATEGORY = "late-answer";

export type TurnReply = {
  call: string;
  turn: number;
  from: number;
  parts: string[];
  /** The turn is over: no more parts come. */
  done: boolean;
  /** She gave the request to the full Cobra (hand_to_cobra): its id, for the answer that comes later. */
  handedOff?: string;
  /** A card the voice front put on the person's screen (show_card), to approve with Face ID. */
  card?: string;
  /** The call ended with this turn. */
  ended?: CallEnd;
  /** Said once, near the subscription's limit: "One minute left on this call." */
  notice?: string;
};

/** Said when a call on the subscription has one minute left. */
export const CALL_WARNING = "One minute left on this call.";
/** Said when a call reaches CALL_MAX_MINUTES. */
export const CALL_TIME_UP = "That's our ten minutes. Call me again any time.";

/** The five states of a call (Figure 2). */
export const CALL_STATES = ["listen", "think", "speak", "card", "ended"] as const;
export type CallState = (typeof CALL_STATES)[number];

/** On the subscription a call stops after this many minutes; Cobra warns a minute before. With the API lane on, its monthly cap rules instead. */
export const CALL_MAX_MINUTES = 10;
export const CALL_WARN_MINUTES = 9;

/** The line a spoken reply ends with when more of it is on the screen. */
export const MORE_ON_SCREEN = "The rest is on your screen.";

/** The tag the apps put on a reply of the voice front, and what a tap on it says. */
export const QUICK_TAG = "Quick answer";
export const QUICK_NOTE = "A lighter version of me answered this so it came fast. Ask me to look into it for a full answer.";

export type Speakable = {
  /** What the voice reads aloud. Empty when nothing in the reply can be spoken. */
  say: string;
  /** Some of the reply was left out (more sentences, a list, a link, code or a table): `say` ends with MORE_ON_SCREEN. */
  more: boolean;
};

/**
 * A reply made fit to read aloud: markdown, links, code and tables out, cut
 * to the first `sentences` sentences. A reply with only a list keeps its
 * first items as sentences. The phone and the desk both use it, so a reply
 * sounds the same on each.
 */
export function speakable(text: string, sentences = 2): Speakable {
  let dropped = false;
  let body = text.replace(/\r\n?/g, "\n");
  // Code blocks and tables say nothing aloud.
  body = body.replace(/```[\s\S]*?(```|$)/g, () => {
    dropped = true;
    return "\n";
  });
  const lines: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) {
      lines.push("");
      continue;
    }
    if (/^\|.*\|$/.test(line) || /^[-:| ]+$/.test(line) && line.includes("-") && line.includes("|")) {
      dropped = true;
      continue;
    }
    const item = /^(?:[-*+•]|\d{1,2}[.)])\s+(.*)$/.exec(line);
    if (item) {
      // A list item reads as a sentence of its own.
      const words = item[1]!.trim();
      lines.push(/[.!?:]$/.test(words) ? words : `${words}.`);
      lines.push("");
      continue;
    }
    lines.push(line.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, ""));
  }
  let flat = lines
    .join("\n")
    .split(/\n{2,}/)
    .map((block) => block.replace(/\n/g, " ").trim())
    .filter(Boolean)
    .map((block) => (/[.!?]$/.test(block) ? block : `${block.replace(/:$/, "")}.`))
    .join(" ");
  flat = flat
    // Images, then links: keep a link's words, drop its address.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, () => {
      dropped = true;
      return "";
    })
    .replace(/\[([^\]]+)\]\([^)]*\)/g, (_, words: string) => {
      dropped = true;
      return words;
    })
    .replace(/<?https?:\/\/[^\s)>]+>?/g, () => {
      dropped = true;
      return "";
    })
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/\s+([.,!?:;])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const all = splitSentences(flat).filter((sentence) => /[\p{L}\p{N}]/u.test(sentence));
  const kept = all.slice(0, Math.max(1, sentences));
  const more = dropped || all.length > kept.length;
  if (kept.length === 0) return { say: more ? MORE_ON_SCREEN : "", more };
  const say = kept.join(" ").replace(/:$/, ".");
  return { say: more ? `${say} ${MORE_ON_SCREEN}` : say, more };
}

/** Splits at . ! or ? before a space and a capital, a digit or a quote, so "$25.00" and "e.g. this" stay whole. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?]["”’)]?)\s+(?=["“‘(]?[\p{Lu}\p{N}])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}
