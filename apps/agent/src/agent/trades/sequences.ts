/**
 * Email sequences in People: the
 * sequences the owner allowed, each with its state. The agent writes one
 * when its card is allowed (`sequence_set`); anyone may pause one at once
 * (`sequence_pause`: a Foreman when someone asks, the owner on the
 * dashboard); only the owner starts it again (`sequence_resume`). The runs
 * themselves are in the agent's own email database (emailSequences.ts).
 *
 * Append only, as people.ts.
 */
import type { Args, Mutation, MutationContext, Row, TableSpec } from "../dbTypes.ts";

export const SEQUENCE_STATES = ["active", "paused"] as const;
const STAMPS = "id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL";

export const SEQUENCES_MIGRATION = `
CREATE TABLE email_sequences (
  ${STAMPS},
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  steps INTEGER NOT NULL,
  state TEXT NOT NULL,
  approval TEXT,
  paused_at TEXT
);
CREATE UNIQUE INDEX email_sequences_slug ON email_sequences (slug);
`;

export const SEQUENCE_TABLES: Record<string, TableSpec> = {
  email_sequences: {
    describe: "The email sequences the owner allowed (a welcome series, a reminder): which version runs, what starts it, and whether it is paused. The agent sends each step; sequence_pause stops the next ones.",
    columns: {
      slug: { kind: "text", required: true, describe: "The sequence's slug in the Space's email folder" },
      name: { kind: "text", required: true, describe: "As the owner reads it" },
      version: { kind: "integer", required: true, describe: "The allowed version that runs" },
      trigger: { kind: "text", required: true, describe: "What starts it, in words" },
      steps: { kind: "integer", required: true, describe: "How many emails in it" },
      state: { kind: "text", required: true, describe: SEQUENCE_STATES.join(" or ") },
      approval: { kind: "text", describe: "The card that allowed this version" },
      paused_at: { kind: "text", describe: "ISO time it was paused; null while it runs" },
    },
  },
};

function text(ctx: MutationContext, args: Args, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) ctx.refuse(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "string") return ctx.refuse(`${name} must be text`);
  return value.trim();
}
function sequence(ctx: MutationContext, args: Args): Row {
  const id = args.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return ctx.refuse("id must be a sequence's id");
  return ctx.get("SELECT * FROM email_sequences WHERE id = ?", [id]) ?? ctx.refuse(`no sequence with id ${id}`);
}

export const SEQUENCE_MUTATIONS: Record<string, Mutation> = {
  sequence_set: {
    describe: "The agent's: a sequence version the owner allowed on its card, running.",
    args: {
      slug: { kind: "text", required: true, describe: "The slug" },
      name: { kind: "text", required: true, describe: "The name" },
      version: { kind: "integer", required: true, describe: "The allowed version" },
      trigger: { kind: "text", required: true, describe: "What starts it, in words" },
      steps: { kind: "integer", required: true, describe: "How many emails" },
      approval: { kind: "text", describe: "The card's id" },
    },
    agentOnly: true,
    run(ctx, args) {
      const slug = text(ctx, args, "slug", true) as string;
      const fields = {
        name: (text(ctx, args, "name", true) as string).slice(0, 80),
        version: args.version as number,
        trigger: (text(ctx, args, "trigger", true) as string).slice(0, 200),
        steps: args.steps as number,
        state: "active",
        approval: text(ctx, args, "approval") ?? null,
        paused_at: null,
      };
      const before = ctx.get("SELECT * FROM email_sequences WHERE slug = ?", [slug]);
      if (before) ctx.update("email_sequences", Number(before.id), fields);
      else ctx.insert("email_sequences", { slug, ...fields });
      return `${fields.name} v${fields.version} runs`;
    },
  },
  sequence_pause: {
    describe: "Pauses a sequence: nobody gets its next email until the owner resumes it. Anyone may pause one, at once, when someone asks.",
    args: { id: { kind: "integer", required: true, describe: "The sequence's id" } },
    run(ctx, args) {
      const row = sequence(ctx, args);
      if (row.state === "paused") return `${String(row.name)} was paused already`;
      ctx.update("email_sequences", Number(row.id), { state: "paused", paused_at: ctx.now });
      return `Paused ${String(row.name)}`;
    },
  },
  sequence_resume: {
    describe: "The owner's: a paused sequence runs again; the emails it held go out, each checked again first.",
    args: { id: { kind: "integer", required: true, describe: "The sequence's id" } },
    personOnly: true,
    run(ctx, args) {
      const row = sequence(ctx, args);
      ctx.update("email_sequences", Number(row.id), { state: "active", paused_at: null });
      return `${String(row.name)} runs again`;
    },
  },
};
