import type { Caller } from "./keys.ts";

/**
 * How much each caller may ask of this agent.
 *
 * Every route bounds its own body, but that does not bound how often a key
 * may call or how many long polls it holds open. One window that reconnects
 * in a loop could hold hundreds of five-minute waits and starve the agent.
 * So each caller id gets:
 *
 * - a token bucket of requests: `perMinute` refilled evenly, at most `burst`
 *   saved up;
 * - at most `waits` long polls open at once (a route ending in /wait: the
 *   Lead's /orch/worker/wait and /orch/foreman/wait hold up to 300 s).
 *
 * Over either the request is answered 429 with Retry-After, before its body
 * is read. A refused request costs no token.
 *
 * The numbers per kind of key. The desk gets 180 a minute: its own polls add
 * up to some 40 a minute on its home pages, and a conversation that is being
 * answered polls every 0.8 s (75 a minute) on top. The Lead and the Foremen
 * share this HTTP server through /orch/*; their bucket is much larger, since
 * a run of tool calls comes in bursts and none of them should wait on a
 * limit meant for a leaked key.
 */

export type Limits = { perMinute: number; burst: number; waits: number };

export const PERSON_LIMITS: Limits = { perMinute: 180, burst: 90, waits: 4 };
export const ORCH_LIMITS: Limits = { perMinute: 600, burst: 300, waits: 16 };

export function limitsFor(caller: Pick<Caller, "kind">): Limits {
  return caller.kind === "lead" ? ORCH_LIMITS : PERSON_LIMITS;
}

/** A long poll: held open until something happens or its time runs out. */
export function isLongPoll(route: string): boolean {
  return route.endsWith("/wait");
}

export type Admission = { ok: true; release: () => void } | { ok: false; retryAfter: number; error: string };

type State = { tokens: number; at: number; waits: number };

export interface RateLimiter {
  /** Lets a request in, or says how long to wait; `release` is called once when its reply is done. */
  admit(caller: Pick<Caller, "id" | "kind">, route: string): Admission;
}

export function createRateLimiter(options: { now?: () => number; limits?: (caller: Pick<Caller, "kind">) => Limits } = {}): RateLimiter {
  const now = options.now ?? Date.now;
  const limits = options.limits ?? limitsFor;
  const states = new Map<string, State>();

  return {
    admit(caller, route) {
      const limit = limits(caller);
      const at = now();
      let state = states.get(caller.id);
      if (!state) states.set(caller.id, (state = { tokens: limit.burst, at, waits: 0 }));
      const perMs = limit.perMinute / 60_000;
      state.tokens = Math.min(limit.burst, state.tokens + Math.max(0, at - state.at) * perMs);
      state.at = at;
      const wait = isLongPoll(route);
      if (state.tokens < 1) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - state.tokens) / perMs / 1000)), error: `Too many requests from this key: at most ${limit.perMinute} a minute. Wait a moment.` };
      }
      if (wait && state.waits >= limit.waits) {
        return { ok: false, retryAfter: 5, error: `This key already holds ${limit.waits} waits open here. Let one finish first.` };
      }
      state.tokens -= 1;
      if (wait) state.waits += 1;
      const held = state;
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          if (wait) held.waits -= 1;
        },
      };
    },
  };
}
