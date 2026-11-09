/** The agents' answers, read as loosely as the desk's Python reads them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
export type Dict = Record<string, Json>;

/** Python's truthiness, for ports that lean on it: "", 0, [], {} and null are false. */
export function truthy(v: Json): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

export function isDict(v: Json): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Seconds since the epoch, as Python's time.time(). Every port keeps seconds. */
export function nowS(): number {
  return Date.now() / 1000;
}
