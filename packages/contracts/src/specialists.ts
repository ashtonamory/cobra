import { z } from "zod";

/**
 * A specialist: a project's Foreman as the person owns it. Its name and look
 * are the crew's (crew.ts); its title says what it is for, its instructions
 * are the person's standing words for it, and its model is the one it runs
 * on. The id is the project's id.
 */
export const SpecialistView = z.object({
  /** The project's id. */
  id: z.string(),
  /** The project's name. */
  project: z.string(),
  name: z.string(),
  look: z.number().int(),
  hat: z.number().int(),
  /** One line, at most 120 characters: what it is for. Its trade's name until someone sets one; may be "". */
  title: z.string(),
  /** The person's standing instructions for it, at most 8,000 characters; "" when none. */
  instructions: z.string(),
  /** The model it runs on (opus, sonnet…); absent means the usual one. A string, so a new model never fails an older app. */
  model: z.string().optional(),
  trade: z.string().optional(),
  /** The Space or company it works for, when it has one. */
  company: z.object({ id: z.string(), name: z.string() }).optional(),
  /**
   * The projects it is attached to besides its own: it reads their files and
   * its Workers may change them. Absent from an older agent reads as none.
   */
  repos: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() })).default([]),
  updatedAt: z.string().optional(),
  /** "person" or "lead" (the Lead proposed it and the person allowed it). */
  updatedBy: z.string().optional(),
});
export type SpecialistView = z.infer<typeof SpecialistView>;

/** GET /specialists. */
export const SpecialistList = z.object({
  specialists: z.array(SpecialistView),
  /** The models a specialist may be set to. */
  models: z.array(z.string()),
});
export type SpecialistList = z.infer<typeof SpecialistList>;

/**
 * POST /specialists/set: the person's own change, with no card. Only the
 * fields sent change; "" (or null for name and model) takes one back to its
 * default.
 */
export const SpecialistSetRequest = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  title: z.string().optional(),
  instructions: z.string().optional(),
  model: z.string().nullable().optional(),
});
export type SpecialistSetRequest = z.infer<typeof SpecialistSetRequest>;

/**
 * POST /specialists/attach and /specialists/detach: the person's own act,
 * with no card. `id` is the specialist, `project` the repository.
 */
export const SpecialistAttachRequest = z.object({ id: z.string(), project: z.string() });
export type SpecialistAttachRequest = z.infer<typeof SpecialistAttachRequest>;

/**
 * On a card of kind `specialist-attach`: the Lead proposes to attach one
 * specialist to one project the person already has. Allow attaches exactly
 * that pair, the one whose hash is `sha256`.
 */
export const ApprovalSpecialistAttach = z.object({
  /** The specialist: its project's id. */
  id: z.string(),
  name: z.string(),
  repo: z.object({ id: z.string(), name: z.string(), path: z.string() }),
  sha256: z.string(),
});
export type ApprovalSpecialistAttach = z.infer<typeof ApprovalSpecialistAttach>;

/**
 * On a card of kind `specialist`: the change the Lead proposed, whole, and
 * what it replaces, whole. Allow applies exactly the change whose hash is
 * `sha256`. A field that is absent stays as it is.
 */
export const ApprovalSpecialist = z.object({
  id: z.string(),
  name: z.string(),
  project: z.string(),
  title: z.string().optional(),
  instructions: z.string().optional(),
  model: z.string().optional(),
  was: z.object({ title: z.string(), instructions: z.string(), model: z.string() }),
  sha256: z.string(),
});
export type ApprovalSpecialist = z.infer<typeof ApprovalSpecialist>;
