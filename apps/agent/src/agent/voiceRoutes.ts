import { VoiceError, type VoiceCalls } from "./voiceFront.ts";

/**
 * The call routes (phase V4), a phone's or
 * desk's key (POST is act, GET read), on the hub only:
 *
 *   POST /voice/call/start                       → CallStart
 *   POST /voice/turn {call, text}                → TurnReply, as soon as the first part is whole
 *   GET  /voice/turn/next?call=&turn=&after=     → TurnReply, the parts after `after`, held up to 20 s
 *   POST /voice/turn/cancel {call, turn}         → TurnReply (the person spoke over her)
 *   POST /voice/call/end {call}                  → {ok}
 *   GET  /voice/call/news?call=                  → {news, ended?}: late answers to say when the person is quiet, held up to 20 s
 */

export const VOICE_ROUTES: ReadonlySet<string> = new Set(["/voice/call/start", "/voice/turn", "/voice/turn/next", "/voice/turn/cancel", "/voice/call/end", "/voice/call/news"]);

export type Reply = { status: number; body: unknown };

const CALL_ID = /^[A-Za-z0-9_-]{8,32}$/;

function callOf(value: unknown): string {
  if (typeof value !== "string" || !CALL_ID.test(value)) throw new VoiceError(400, "call is the id /voice/call/start gave");
  return value;
}

function count(value: unknown, what: string, min: number): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min) throw new VoiceError(400, `${what} is a whole number from ${min}`);
  return n;
}

/** One request to a call route; `body` is the parsed JSON of a POST (or {}). */
export async function voiceRoute(calls: VoiceCalls, route: string, method: string, query: URLSearchParams, body: Record<string, unknown>): Promise<Reply> {
  const post = method === "POST";
  try {
    switch (route) {
      case "/voice/call/start":
        if (!post) return { status: 405, body: { error: "POST only" } };
        return { status: 200, body: await calls.start() };
      case "/voice/turn":
        if (!post) return { status: 405, body: { error: "POST only" } };
        return { status: 200, body: await calls.turn(callOf(body.call), typeof body.text === "string" ? body.text : "") };
      case "/voice/turn/next":
        if (method !== "GET") return { status: 405, body: { error: "GET only" } };
        return { status: 200, body: await calls.next(callOf(query.get("call")), count(query.get("turn"), "turn", 1), count(query.get("after"), "after", 0)) };
      case "/voice/turn/cancel":
        if (!post) return { status: 405, body: { error: "POST only" } };
        return { status: 200, body: calls.cancel(callOf(body.call), count(body.turn, "turn", 1)) };
      case "/voice/call/end":
        if (!post) return { status: 405, body: { error: "POST only" } };
        calls.end(callOf(body.call));
        return { status: 200, body: { ok: true } };
      case "/voice/call/news":
        if (method !== "GET") return { status: 405, body: { error: "GET only" } };
        return { status: 200, body: await calls.news(callOf(query.get("call"))) };
      default:
        return { status: 404, body: { error: "not found", route } };
    }
  } catch (caught) {
    if (caught instanceof VoiceError) return { status: caught.status, body: { error: caught.message } };
    throw caught;
  }
}
