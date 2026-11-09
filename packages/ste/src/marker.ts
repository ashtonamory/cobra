// The marker a normal chat reply ends with when the model thinks a deep answer
// would help. It follows the life chat's [Card: …] style and is always
// stripped before the reply is shown.
//
//   [Deep: This has a boot sequence and a fix with a risk | diagrams=1]

export type DeepProposal = {
  reason: string;
  diagrams: number;
};

const DEEP_MARKER_RE = /\[Deep:\s*([^\]|]*?)\s*(?:\|\s*diagrams\s*=\s*(\d+)\s*)?\]/gi;

export function parseDeepMarker(text: string): DeepProposal | null {
  let last: DeepProposal | null = null;
  for (const m of text.matchAll(DEEP_MARKER_RE)) {
    const reason = (m[1] ?? "").trim();
    if (reason) last = { reason, diagrams: Math.min(Number(m[2] ?? 0), 4) };
  }
  return last;
}

export function stripDeepMarkers(text: string): string {
  return text.replace(DEEP_MARKER_RE, " ").replace(/[ \t]{2,}/g, " ").trim();
}
