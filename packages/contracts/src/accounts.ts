import { z } from "zod";

/**
 * More than one Claude and Codex account on a computer, and which one is in
 * use there (agent accounts.ts). `provider` stays a
 * string so a new one never fails an older app's parse.
 */
export const Account = z.object({
  id: z.string(),
  provider: z.string(),
  label: z.string(),
  email: z.string().optional(),
  ref: z.string().optional(),
  addedAt: z.string(),
  active: z.boolean(),
});
export type Account = z.infer<typeof Account>;

export const AccountsView = z.object({
  accounts: z.array(Account),
  /** What each provider uses with none of the saved accounts picked: the computer's own sign-in. */
  computer: z.object({
    claude: z.object({ email: z.string().optional(), active: z.boolean() }),
    codex: z.object({ email: z.string().optional(), saved: z.boolean() }),
  }),
});
export type AccountsView = z.infer<typeof AccountsView>;

/** A Codex device sign-in: the link and one-time code to show, then done or failed. */
export const CodexLogin = z.object({
  id: z.string(),
  state: z.string(),
  url: z.string().optional(),
  code: z.string().optional(),
  why: z.string().optional(),
  account: Account.omit({ active: true }).optional(),
});
export type CodexLogin = z.infer<typeof CodexLogin>;
