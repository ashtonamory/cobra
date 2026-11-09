/**
 * Small pieces of Python's behaviour the ports lean on, kept exact where a test can tell:
 * round() (half to even, on the double's exact value), "{:.2f}", str(), dict.get with a
 * default, sorted() order and json.dumps(sort_keys=True). Pure.
 */
import type { Dict, Json } from "./json.ts";

/** Python's round(x, ndigits): ties go to the even digit, judged on the exact binary value. */
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x)) return x;
  if (ndigits === 0) {
    const floor = Math.floor(x);
    const diff = x - floor;
    if (diff > 0.5) return floor + 1;
    if (diff < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Number(pyFixed(x, ndigits));
}

/** Python's f"{x:.{n}f}": correctly rounded, ties to even. */
export function pyFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return x > 0 ? "inf" : x < 0 ? "-inf" : "nan";
  const abs = Math.abs(x);
  if (abs >= 1e21) return x.toFixed(digits);
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  // toFixed rounds on the exact value but sends ties up; a tie can only be a value with exactly
  // digits+1 decimals ending in 5, which toFixed(100) shows exactly.
  const exact = abs.toFixed(100);
  const [whole, frac] = exact.split(".");
  const tie = frac[digits] === "5" && /^0*$/.test(frac.slice(digits + 1));
  let out: string;
  if (tie) {
    const down = digits > 0 ? `${whole}.${frac.slice(0, digits)}` : whole;
    const last = Number(down[down.length - 1]);
    out = last % 2 === 0 ? down : abs.toFixed(digits);
  } else {
    out = abs.toFixed(digits);
  }
  return sign + out;
}

/** str(value) for the values agent payloads carry. Numbers print as JS does (3, not 3.0). */
export function pyStr(v: Json): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
    return String(v);
  }
  return JSON.stringify(v);
}

/** dict.get(key, default): the default only when the key is missing, not when it holds None. */
export function pyGet(d: Dict | null | undefined, key: string, dflt: Json = null): Json {
  if (!d || !Object.prototype.hasOwnProperty.call(d, key)) return dflt;
  const v = d[key];
  return v === undefined ? dflt : v;
}

/** Python's ordering of strings (by code point) and numbers, for sort comparators. */
export function pyCmp(a: Json, b: Json): number {
  if (typeof a === "string" && typeof b === "string") {
    const x = Array.from(a);
    const y = Array.from(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
      if (d !== 0) return d;
    }
    return x.length - y.length;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const d = pyCmp(a[i], b[i]);
      if (d !== 0) return d;
    }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** sorted(xs, key=...), stable. */
export function pySorted<T>(xs: readonly T[], key: (x: T) => Json = (x) => x, reverse = false): T[] {
  const out = [...xs];
  out.sort((a, b) => (reverse ? pyCmp(key(b), key(a)) : pyCmp(key(a), key(b))));
  return out;
}

/** Python's ==, for scalars, lists and dicts (True == 1, 0 == False). */
export function pyEq(a: Json, b: Json): boolean {
  const scalar = (v: Json) => typeof v === "number" || typeof v === "boolean";
  if (scalar(a) && scalar(b)) return Number(a) === Number(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && pyEq(a[k], b[k]));
  }
  return (a ?? null) === (b ?? null);
}

/** json.dumps(value, sort_keys=True), for comparing two payloads. */
export function canonicalJson(value: Json): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Dict = {};
      for (const k of Object.keys(v).sort((a, b) => pyCmp(a, b))) sorted[k] = v[k];
      return sorted;
    }
    return v;
  });
}

/** urllib.parse.quote(value, safe=""): every byte but A-Z a-z 0-9 _ . - ~ percent-encoded. */
export function pyQuote(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
