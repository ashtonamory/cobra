// What an Allow all sends: the ids of the rows the person reviewed.
import type { Args, MutationContext } from "../dbTypes.ts";

/** A batch's `ids`: whole numbers, comma separated, 1 to 200 of them, each once. */
export function batchIds(ctx: MutationContext, args: Args): number[] {
  const raw = String(args.ids ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const ids = [...new Set(raw.map(Number))];
  if (!ids.length || ids.some((id) => !Number.isInteger(id) || id < 1)) ctx.refuse("ids must be whole numbers, comma separated");
  if (ids.length > 200) ctx.refuse("ids takes at most 200 at a time");
  return ids;
}
