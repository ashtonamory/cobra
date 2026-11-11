import type { Caller } from "./keys.ts";

/**
 * How much each caller may ask of this agent (OV-SEC-VPS-001 F9).
 *
 * Every route bounds its own body, but until this nothing bounded how often a
 * key may call, how many long polls it holds open, or how many file-name
 * searches it runs at once. On a small VM a few phones, or one web tab that
 * reconnects in a loop, could hold hundreds of five-minute waits and parallel
 * searches and starve the agent. So each caller id gets:
 *
 * - a token bucket of requests: `perMinute` refilled evenly, at most `burst`
 *   saved up;
 * - at most `waits` long polls open at once (a route ending in /wait: the
 *   Lead's /orch/worker/wait and /orch/foreman/wait hold up to 300 s, a
 *   phone's /thread/wait 25 s);
 * - at most `searches` /fs/search walks at once (each may take 3 s of CPU).
 *
 * Over any of them the request is answered 429 with Retry-After, before its
 * body is read. A refused request costs no token.
 *
 * The numbers per kind of key. A phone or a desktop gets 180 a minute: the
 * phone's own polls add up to some 40 a minute on its home pages, and a
 * conversation that is being answered polls every 0.8 s (75 a minute) on
 * top, so the 60 a minute the review suggested would refuse the app's own
 * screens. A peer (your own hub dropping files here, one request a file,
 * retried with backoff when refused) gets the same. A widget (and a stored
 * `api` key, a kind nothing mints any more) gets the review's 60. The Lead
 * and the Foremen share this HTTP server
 * through /orch/*; their bucket is much larger, since a run of tool calls
 * comes in bursts and none of them should wait on a limit meant for a
 * leaked key.
 */

export type Limits = { perMinute: number; burst: number; waits: number; searches: number };

export const PERSON_LIMITS: Limits = { perMinute: 180, burst: 90, waits: 4, searches: 2 };
export const SMALL_LIMITS: Limits = { perMinute: 60, burst: 30, waits: 4, searches: 2 };
export const ORCH_LIMITS: Limits = { perMinute: 600, burst: 300, waits: 16, searches: 2 };

export function limitsFor(caller: Pick<Caller, "kind">): Limits {
  switch (caller.kind) {
    case "phone":
    case "desk":
    case "peer":
      return PERSON_LIMITS;
    case "lead":
      return ORCH_LIMITS;
    default:
      return SMALL_LIMITS;
  }
}

/** A long poll: held open until something happens or its time runs out. */
export function isLongPoll(route: string): boolean {
  return route.endsWith("/wait");
}

export const SEARCH_ROUTE = "/fs/search";

export type Admission = { ok: true; release: () => void } | { ok: false; retryAfter: number; error: string };

type State = { tokens: number; at: number; waits: number; searches: number };

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
      if (!state) states.set(caller.id, (state = { tokens: limit.burst, at, waits: 0, searches: 0 }));
      const perMs = limit.perMinute / 60_000;
      state.tokens = Math.min(limit.burst, state.tokens + Math.max(0, at - state.at) * perMs);
      state.at = at;
      const wait = isLongPoll(route);
      const search = route === SEARCH_ROUTE;
      if (state.tokens < 1) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - state.tokens) / perMs / 1000)), error: `Too many requests from this key: at most ${limit.perMinute} a minute. Wait a moment.` };
      }
      if (wait && state.waits >= limit.waits) {
        return { ok: false, retryAfter: 5, error: `This key already holds ${limit.waits} waits open here. Let one finish first.` };
      }
      if (search && state.searches >= limit.searches) {
        return { ok: false, retryAfter: 2, error: `This key already runs ${limit.searches} searches here. Let one finish first.` };
      }
      state.tokens -= 1;
      if (wait) state.waits += 1;
      if (search) state.searches += 1;
      const held = state;
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          if (wait) held.waits -= 1;
          if (search) held.searches -= 1;
        },
      };
    },
  };
}
