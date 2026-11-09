import { join } from "node:path";

import { CONFIG_DIR } from "./paths.ts";

/**
 * Sign in with GitHub for the github preset: GitHub's device flow, run by this computer's agent.
 *
 * Connect asks GitHub for a device code and gives the phone or the desk only
 * the short user code and the page to type it on. The agent keeps the device
 * code and polls GitHub until the person approves, refuses, or the code runs
 * out. The token GitHub then hands over goes to `save` (the token file, 0600)
 * and nowhere else: it never reaches the phone, a log line or the agent's
 * environment.
 *
 * The App's client ID is public (device flow uses no client secret). A test
 * or another build that passes an empty one gets sign-in off, and the apps
 * offer only "paste a token".
 */
export const GITHUB_APP = {
  // Cobra's own GitHub App (github.com/apps/cobra-agents): device flow on, user tokens that do not expire, read-only repository permissions.
  clientId: process.env.COBRA_GITHUB_APP_CLIENT_ID?.trim() || "Iv23liaZHHuD7LO6HCbl",
  slug: process.env.COBRA_GITHUB_APP_SLUG?.trim() || "cobra-agents",
};

export const DEVICE_CODE_URL = "https://github.com/login/device/code";
export const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
/** How a sign-in's token is remembered: `{source: "app", expiresAt}`, beside the token file. Never the token. */
export const GITHUB_AUTH = join(CONFIG_DIR, "github-auth.json");
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** Where you choose what the App may read: its install page. */
export function appInstallUrl(slug: string): string | undefined {
  return slug ? `https://github.com/apps/${slug}/installations/new` : undefined;
}

export type SignInView =
  | { state: "idle" }
  | { state: "waiting"; userCode: string; verificationUri: string; expiresAt: number }
  | { state: "failed"; why: string };

export type SignInDeps = {
  clientId: string;
  /** GitHub's two endpoints, answered as JSON. Never follows a redirect. */
  post: (url: string, body: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown> }>;
  now: () => number;
  /** Waits `ms`, or rejects once `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Keeps the token GitHub handed over. `expiresAt` is null for a token that does not expire. */
  save: (token: string, expiresAt: number | null) => void;
  log: (line: string) => void;
};

export type SignIn = {
  view: () => SignInView;
  /** A code to type: the one already waiting, else a new one from GitHub. Throws with words to show. */
  start: () => Promise<Extract<SignInView, { state: "waiting" }>>;
  /** Stops waiting. The code GitHub gave stays valid until it runs out, but nothing polls it. */
  cancel: () => void;
};

/** A token as GitHub's token endpoint returns it: letters, digits and underscores. */
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

async function postJson(url: string, body: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "cobra-agent" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("cancelled"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });
}

/** Words for GitHub's device-flow errors (RFC 8628 and GitHub's own). */
function errorWords(code: unknown): string {
  switch (code) {
    case "expired_token":
      return "The code ran out before it was approved. Connect again.";
    case "access_denied":
      return "Sign-in was cancelled on GitHub.";
    case "device_flow_disabled":
      return "Sign in with GitHub is turned off for this app on GitHub. Paste a token instead.";
    case "incorrect_client_credentials":
      return "This agent's GitHub app is not set up right. Paste a token instead.";
    default:
      return "GitHub did not finish the sign-in. Connect again.";
  }
}

export function signInManager(deps: Partial<SignInDeps> & Pick<SignInDeps, "save">): SignIn {
  const d: SignInDeps = { clientId: GITHUB_APP.clientId, post: postJson, now: Date.now, sleep, log: (line) => console.log(line), ...deps };
  let view: SignInView = { state: "idle" };
  let stop: AbortController | null = null;

  const fail = (why: string) => {
    view = { state: "failed", why };
    d.log(`[cobra-agent] github sign-in: ${why}`);
  };

  async function poll(deviceCode: string, interval: number, expiresAt: number, signal: AbortSignal): Promise<void> {
    let wait = interval;
    while (!signal.aborted) {
      try {
        await d.sleep(wait * 1000, signal);
      } catch {
        return;
      }
      if (d.now() >= expiresAt) return fail(errorWords("expired_token"));
      let answer: { status: number; body: Record<string, unknown> };
      try {
        answer = await d.post(ACCESS_TOKEN_URL, { client_id: d.clientId, device_code: deviceCode, grant_type: DEVICE_GRANT });
      } catch {
        // GitHub not reached this time: try again at the next interval, until the code runs out.
        continue;
      }
      if (signal.aborted) return;
      const { body } = answer;
      if (typeof body.access_token === "string") {
        if (!TOKEN.test(body.access_token)) return fail("GitHub answered with something that is not a token.");
        const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : null;
        try {
          d.save(body.access_token, expiresIn === null ? null : d.now() + expiresIn * 1000);
        } catch (caught) {
          return fail(`The token could not be kept: ${caught instanceof Error ? caught.message : String(caught)}`);
        }
        view = { state: "idle" };
        d.log("[cobra-agent] github sign-in: connected");
        return;
      }
      if (body.error === "authorization_pending") continue;
      if (body.error === "slow_down") {
        wait = typeof body.interval === "number" ? body.interval : wait + 5;
        continue;
      }
      return fail(errorWords(body.error));
    }
  }

  return {
    view: () => {
      if (view.state === "waiting" && d.now() >= view.expiresAt) {
        stop?.abort();
        fail(errorWords("expired_token"));
      }
      return view;
    },
    start: async () => {
      if (!d.clientId) throw new Error("Sign in with GitHub is not set up in this agent. Paste a token instead.");
      if (view.state === "waiting" && d.now() < view.expiresAt) return view;
      stop?.abort();
      let answer: { status: number; body: Record<string, unknown> };
      try {
        answer = await d.post(DEVICE_CODE_URL, { client_id: d.clientId });
      } catch {
        throw new Error("Could not reach GitHub to start the sign-in.");
      }
      const { body } = answer;
      if (answer.status !== 200 || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
        throw new Error(body.error ? errorWords(body.error) : `GitHub answered ${answer.status} when asked for a sign-in code.`);
      }
      const verificationUri = typeof body.verification_uri === "string" && body.verification_uri.startsWith("https://github.com/") ? body.verification_uri : "https://github.com/login/device";
      const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 900;
      const interval = typeof body.interval === "number" && body.interval > 0 ? body.interval : 5;
      const waiting = { state: "waiting" as const, userCode: body.user_code, verificationUri, expiresAt: d.now() + expiresIn * 1000 };
      view = waiting;
      stop = new AbortController();
      void poll(body.device_code, interval, waiting.expiresAt, stop.signal);
      return waiting;
    },
    cancel: () => {
      stop?.abort();
      stop = null;
      view = { state: "idle" };
    },
  };
}
