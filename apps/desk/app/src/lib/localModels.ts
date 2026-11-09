/**
 * Settings → LOCAL MODELS in words: what each computer's
 * Ollama has, how each model did in the agent's check (the agent's localCheck.ts, `GET /local`), and
 * the next policy when a helper is set to use one. A port of the desk's localmodels.py (itself the
 * phone's src/localModelsRules.ts): change them together. Pure.
 */
import { APP_NAME } from "./appName.ts";
import { truthy, type Dict, type Json } from "./json.ts";
import { pyGet, pyRound, pyStr } from "./py.ts";

export const BLURB =
  `Models this computer's Ollama runs, and how each did in ${APP_NAME}'s check: it asks the model to ` +
  "call a tool and use the answer, then times it. A check loads the model onto the GPU, so it " +
  "runs only when you press Check or a session first starts on it.";

export const VERDICT_LABELS: Readonly<Record<string, string>> = {
  ready: "Ready",
  slow: "Slower",
  unchecked: "Not checked",
  "no-tools": "Can't use tools",
  failed: "Didn't pass",
};

export const UNCHECKED_DETAIL = "Not checked yet. Check loads it onto the GPU for up to a minute.";
export const NO_TOOLS_DETAIL = "Ollama says it cannot call tools, and every session needs them.";
export const NONE_LABEL = "None (Claude only)";
export const USE_FOOTER =
  "On that computer only, each helper turns to its local model as your plan nears its limit " +
  "(titles and explanations at 80%, the rest at the limit). A change goes to every computer.";

const has = (d: object, key: string) => Object.prototype.hasOwnProperty.call(d, key);

export function verdictLabel(verdict: string | null | undefined): string {
  const key = verdict || "";
  return has(VERDICT_LABELS, key) ? VERDICT_LABELS[key] : "Not checked";
}

/** The row's one status word: Checking… while a check runs, else its verdict. */
export function rowWord(row: Dict): string {
  if (truthy(row.checking)) return "Checking…";
  return verdictLabel(rowVerdict(row));
}

/** Its check's verdict; "no-tools" for one Ollama says cannot call tools (nothing to check); else
 * "unchecked". */
export function rowVerdict(row: Dict): string {
  const check: Json = row.check;
  if (truthy(check) && truthy(check.verdict)) return check.verdict;
  return truthy(pyGet(row, "tools", true)) ? "unchecked" : "no-tools";
}

/** common.status tone: ink for ready, muted for slower, failed or checking, dim otherwise. Nothing
 * here waits on you, so never signal. */
export function rowTone(row: Dict): string {
  if (truthy(row.checking)) return "muted";
  const tones: Record<string, string> = { ready: "ink", slow: "muted", failed: "muted" };
  const verdict = rowVerdict(row);
  return has(tones, verdict) ? tones[verdict] : "dim";
}

export function contextLabel(tokens: number): string {
  return `${pyRound(tokens / 1024)}k context`;
}

/** How long ago, from a span in milliseconds. */
export function agoLabel(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

/** The line under a model's name: speed, context and when it was checked, then why (if anything) on
 * a second line. `now` is in milliseconds, as the agent's `checkedAt` is. */
export function modelDetail(row: Dict, now: number): string {
  const check: Json = row.check;
  if (!truthy(check)) return truthy(pyGet(row, "tools", true)) ? UNCHECKED_DETAIL : NO_TOOLS_DETAIL;
  const parts: string[] = [];
  if (check.decodeTps !== null && check.decodeTps !== undefined) parts.push(`${pyRound(check.decodeTps)} tok/s`);
  if (check.contextTokens !== null && check.contextTokens !== undefined) parts.push(contextLabel(check.contextTokens));
  if (check.checkedAt !== null && check.checkedAt !== undefined) parts.push(`checked ${agoLabel(now - check.checkedAt)}`);
  const line = parts.join(" · ");
  const reason: Json = check.reason ?? null;
  return truthy(reason) && line ? `${line}\n${pyStr(reason)}` : truthy(reason) ? reason : line;
}

/** urlparse(url).hostname: the host of a scheme://host URL, lowercased, without port or brackets. */
function hostname(url: string): string | null {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(url);
  if (!m) return null;
  let netloc = m[1];
  const at = netloc.lastIndexOf("@");
  if (at >= 0) netloc = netloc.slice(at + 1);
  let host: string;
  if (netloc.startsWith("[")) {
    const end = netloc.indexOf("]");
    host = end >= 0 ? netloc.slice(1, end) : netloc.slice(1);
  } else {
    const colon = netloc.indexOf(":");
    host = colon >= 0 ? netloc.slice(0, colon) : netloc;
  }
  return host ? host.toLowerCase() : null;
}

export function ollamaLine(status: Dict): string {
  const ollama: Dict = status.ollama || {};
  if (truthy(ollama.refused)) return "Ollama setting refused";
  if (!truthy(ollama.running)) return "Ollama isn't answering";
  const n = (status.models || []).length;
  const version = truthy(ollama.version) ? pyStr(ollama.version) : "";
  let line = `Ollama ${version} · ${n} model${n === 1 ? "" : "s"}`.replaceAll("Ollama  ·", "Ollama ·");
  if (truthy(ollama.remote) && truthy(ollama.url)) {
    const host = hostname(ollama.url) || ollama.url;
    line += ` · on ${host}`;
  }
  return line;
}

export function fixLine(status: Dict): string | null {
  return truthy(status.fix) ? status.fix : null;
}

export function anyChecking(status: Dict | null): boolean {
  return ((status || {}).models || []).some((row: Dict) => truthy(row.checking));
}

/** What a helper role may fall back to here: none, then each model that passed (ready or slower) or
 * can call tools and has not been checked yet. */
export function useOptions(status: Dict): { model: string | null; label: string }[] {
  const out: { model: string | null; label: string }[] = [{ model: null, label: NONE_LABEL }];
  for (const row of (status.models || []) as Dict[]) {
    const check: Json = row.check;
    const verdict: Json = truthy(check) ? check.verdict ?? null : null;
    if (verdict === "ready" || verdict === "slow" || (truthy(row.tools) && !truthy(check))) {
      out.push({ model: row.name, label: `${pyStr(row.name)} — ${verdictLabel(truthy(verdict) ? verdict : "unchecked")}` });
    }
  }
  return out;
}

export function useLabel(use: Dict): string {
  return truthy(use.model) ? use.model : NONE_LABEL;
}

/** dict.setdefault(key, {}). */
function setdefault(d: Dict, key: string): Json {
  if (!has(d, key)) d[key] = {};
  return d[key];
}

/** The policy with `role` falling back to `model` (null: no local model) on `computer` only. The
 * revision is left as it is: the review and apply flow sets the next one. */
export function nextPolicyWithLocal(policy: Dict, computer: string, role: string, model: string | null,
  resolvedChain: string[]): Dict {
  const out: Dict = structuredClone(policy);
  const level: Dict = setdefault(setdefault(out, "computers"), computer);
  const local = truthy(model) ? `local:${model}` : null;
  if (role === "judge") {
    level.judge = { ...(level.judge || {}), fallback: local };
    const chain: Json = ((level.models || {}).fallbacks || {}).judge;
    if (Array.isArray(chain)) {
      const kept = chain.filter((entry) => !pyStr(entry).startsWith("local:"));
      level.models.fallbacks.judge = [...kept, ...(local ? [local] : [])];
    }
    return out;
  }
  const chain = (resolvedChain || []).filter((entry) => !pyStr(entry).startsWith("local:"));
  const fallbacks: Dict = setdefault(setdefault(level, "models"), "fallbacks");
  fallbacks[role] = [...chain, ...(local ? [local] : [])];
  return out;
}

// -- local slots (phase 4) ------------------------------------------------------

export const SLOTS_LABEL = "Local sessions at once";
export const SLOTS_HINT =
  "How many sessions and Workers on a local model may run at once on this computer. One keeps a " +
  "small GPU from juggling two. Over the limit, a Worker waits its turn and a session of yours asks first.";
export const SLOTS_MIN = 1;
export const SLOTS_MAX = 8;

/** How many local-model sessions run there now, from GET /local's `slots`. */
export function slotsLine(slots: Dict | null): string {
  const running = Math.trunc(Number((slots || {}).running || 0));
  return running === 0 ? "None running now" : `${running} running now`;
}

/** The policy with `computer`'s local-model slots set (1 to 8), that computer only. The revision is
 * left as it is: the review and apply flow sets the next one. */
export function nextPolicyWithSlots(policy: Dict, computer: string, slots: number): Dict {
  const out: Dict = structuredClone(policy);
  const level: Dict = setdefault(setdefault(out, "computers"), computer);
  level.local = { ...(level.local || {}), slots: Math.max(SLOTS_MIN, Math.min(SLOTS_MAX, Math.trunc(slots))) };
  return out;
}
