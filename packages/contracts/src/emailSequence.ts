/**
 * An email sequence: a few allowed
 * templates sent to one person in turn, each a delay after the one before,
 * started by a trigger. The person allows a sequence once on its card; then
 * it runs by itself, with a digest in the morning brief and a pause. Any
 * change is a new version and asks again.
 *
 * Triggers:
 *   form   someone sends a form on the Space website (once per address)
 *   stage  someone is moved to a People stage (each move)
 *   date   a People date field's day comes, `days` before (negative) or after it
 */

export const SEQUENCE_EVENTS = ["form", "stage", "date"] as const;
export type SequenceEvent = (typeof SEQUENCE_EVENTS)[number];

export type SequenceTrigger = { event: "form" } | { event: "stage"; stage: string } | { event: "date"; field: string; days?: number };
export type SequenceDelay = { days?: number; hours?: number };
export type SequenceStep = {
  /** An allowed template's slug; the card pins its latest version. */
  template: string;
  /** After the trigger (the first step) or the step before; none is at once. */
  after?: SequenceDelay;
  /** The template's own fields' values, the same for everyone; People fills the rest per person. */
  values?: Record<string, unknown>;
};
export type EmailSequence = { version: 1; name: string; trigger: SequenceTrigger; steps: SequenceStep[] };

export const SEQUENCE_LIMITS = { name: 80, steps: 10, days: 365, hours: 23 * 24, dateOffset: 60 } as const;

const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 '&/().,-]{0,39}$/;
const HOUR_MS = 60 * 60_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** A step's delay in milliseconds. */
export function delayMs(after: SequenceDelay | undefined): number {
  return ((after?.days ?? 0) * 24 + (after?.hours ?? 0)) * HOUR_MS;
}

/** A delay in words for the card: "at once", "2 days later", "1 day 3 hours later". */
export function delayWords(after: SequenceDelay | undefined): string {
  const parts = [after?.days ? `${after.days} ${after.days === 1 ? "day" : "days"}` : "", after?.hours ? `${after.hours} ${after.hours === 1 ? "hour" : "hours"}` : ""].filter(Boolean);
  return parts.length ? `${parts.join(" ")} later` : "at once";
}

/** The trigger in words for the card. */
export function triggerWords(trigger: SequenceTrigger): string {
  if (trigger.event === "form") return "When someone sends a form on the website (once for each address)";
  if (trigger.event === "stage") return `When someone is moved to the stage ${trigger.stage} in People`;
  const days = trigger.days ?? 0;
  const when = days === 0 ? "on the day" : days < 0 ? `${-days} ${days === -1 ? "day" : "days"} before` : `${days} ${days === 1 ? "day" : "days"} after`;
  return `${when[0]!.toUpperCase()}${when.slice(1)} of each person's ${trigger.field} (People)`;
}

export function validateSequence(value: unknown): { ok: true; sequence: EmailSequence } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(value)) return { ok: false, errors: ["a sequence is an object: {version: 1, name, trigger, steps}"] };
  for (const key of Object.keys(value)) if (!["version", "name", "trigger", "steps"].includes(key)) errors.push(`${key}: not a sequence key`);
  if (value.version !== 1) errors.push("version: must be 1");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > SEQUENCE_LIMITS.name) errors.push(`name: 1 to ${SEQUENCE_LIMITS.name} characters`);
  let trigger: SequenceTrigger | null = null;
  const t = value.trigger;
  if (!isObj(t) || !(SEQUENCE_EVENTS as readonly string[]).includes(String(t.event))) errors.push(`trigger.event: one of ${SEQUENCE_EVENTS.join(", ")}`);
  else if (t.event === "form") {
    if (Object.keys(t).some((k) => k !== "event")) errors.push("trigger: form takes nothing more");
    else trigger = { event: "form" };
  } else if (t.event === "stage") {
    if (typeof t.stage !== "string" || !t.stage.trim() || t.stage.length > 60) errors.push("trigger.stage: the People stage's name");
    else trigger = { event: "stage", stage: t.stage.trim() };
  } else {
    if (typeof t.field !== "string" || !NAME.test(t.field.trim())) errors.push("trigger.field: a People date field's name");
    else if (t.days !== undefined && !whole(t.days, -SEQUENCE_LIMITS.dateOffset, SEQUENCE_LIMITS.dateOffset)) errors.push(`trigger.days: a whole number from -${SEQUENCE_LIMITS.dateOffset} to ${SEQUENCE_LIMITS.dateOffset} (before or after the date)`);
    else trigger = { event: "date", field: t.field.trim(), ...(t.days ? { days: t.days as number } : {}) };
  }
  const steps: SequenceStep[] = [];
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > SEQUENCE_LIMITS.steps) errors.push(`steps: 1 to ${SEQUENCE_LIMITS.steps}`);
  else
    value.steps.forEach((raw, i) => {
      const at = `steps[${i}]`;
      if (!isObj(raw)) return void errors.push(`${at}: {template, after?, values?}`);
      for (const key of Object.keys(raw)) if (!["template", "after", "values"].includes(key)) errors.push(`${at}.${key}: not a step key`);
      if (typeof raw.template !== "string" || !SLUG.test(raw.template)) return void errors.push(`${at}.template: a template's slug`);
      let after: SequenceDelay | undefined;
      if (raw.after !== undefined) {
        const a = raw.after;
        if (!isObj(a) || Object.keys(a).some((k) => k !== "days" && k !== "hours")) return void errors.push(`${at}.after: {days?, hours?}`);
        if (a.days !== undefined && !whole(a.days, 0, SEQUENCE_LIMITS.days)) return void errors.push(`${at}.after.days: 0 to ${SEQUENCE_LIMITS.days}`);
        if (a.hours !== undefined && !whole(a.hours, 0, SEQUENCE_LIMITS.hours)) return void errors.push(`${at}.after.hours: 0 to ${SEQUENCE_LIMITS.hours}`);
        after = { ...(a.days ? { days: a.days as number } : {}), ...(a.hours ? { hours: a.hours as number } : {}) };
      }
      if (i > 0 && delayMs(after) === 0) return void errors.push(`${at}.after: a later step waits at least an hour after the one before`);
      if (raw.values !== undefined && !isObj(raw.values)) return void errors.push(`${at}.values: an object`);
      steps.push({ template: raw.template, ...(after && delayMs(after) > 0 ? { after } : {}), ...(raw.values !== undefined ? { values: raw.values as Record<string, unknown> } : {}) });
    });
  if (errors.length || !trigger) return { ok: false, errors };
  return { ok: true, sequence: { version: 1, name, trigger, steps } };
}
