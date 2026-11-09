import { z } from "zod";

/**
 * A Claude Code session as a conversation, not as a screen.
 *
 * Claude Code writes every turn to a JSONL transcript under
 * ~/.claude/projects/<cwd>/<session>.jsonl as it happens — the text it says,
 * the tools it calls, what they returned, and the questions it asks with
 * their options fully structured. The terminal is one rendering of that; this
 * is the other, and the one a phone should show. The screen reader in
 * pane.ts still decides whether something is *waiting* (that never reaches
 * the transcript until it is answered); the transcript says what it is.
 */
export const QuestionOption = z.object({
  label: z.string(),
  description: z.string().optional(),
  /**
   * A drawing Claude attached to the option (AskUserQuestion's `preview`):
   * monospace, often box-drawing characters, drawn as it is.
   */
  preview: z.string().optional(),
});

export const Question = z.object({
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(QuestionOption),
});

const Base = { id: z.string(), at: z.string() };

export const TranscriptMessage = z.discriminatedUnion("kind", [
  /** Something typed by a person, or said by Claude. */
  z.object({ ...Base, kind: z.literal("text"), role: z.enum(["user", "assistant"]), text: z.string() }),
  /** A tool call — "Bash · pnpm test" — with the full question for AskUserQuestion. */
  z.object({
    ...Base,
    kind: z.literal("tool"),
    name: z.string(),
    summary: z.string(),
    detail: z.string().optional(),
    questions: z.array(Question).optional(),
  }),
  /**
   * A slash command run in the session. Claude Code logs these as user text
   * wrapped in <command-name>/<local-command-stdout>, which reads as XML
   * rather than as conversation; parsed out, it is the one thing the phone
   * most needs to see after tapping a command.
   */
  z.object({
    ...Base,
    kind: z.literal("command"),
    /** Without the leading slash. */
    name: z.string(),
    /** Everything after the name, when the command took arguments. */
    args: z.string().optional(),
    /** What the command printed, for the ones that answer immediately (/model). */
    output: z.string().optional(),
  }),
  /** What a tool call came back with; links to the call by its id. */
  z.object({
    ...Base,
    kind: z.literal("result"),
    toolUseId: z.string(),
    ok: z.boolean(),
    preview: z.string(),
    /** For an answered AskUserQuestion: question text → chosen answer. */
    answers: z.record(z.string()).optional(),
  }),
]);

/**
 * The question drawn on screen right now, as the pane reader sees it. The
 * transcript is not guaranteed to carry the AskUserQuestion call while the
 * dialog is up — one Claude Code run wrote it before, another only after the
 * answer — so this is what the app draws its buttons from when the
 * transcript has not caught up. One question at a time, as Claude shows it.
 */
export const ScreenQuestion = z.object({
  text: z.string(),
  header: z.string().nullable(),
  rows: z.array(
    z.object({
      /** The digit that selects the row. */
      n: z.number().int(),
      label: z.string(),
      description: z.string().nullable(),
      /** Null on a single-select; the checkbox on a multi-select. */
      checked: z.boolean().nullable(),
    }),
  ),
  multiSelect: z.boolean(),
  /** The "Ready to submit your answers?" review at the end of a multi-question dialog. */
  submit: z.boolean(),
  /**
   * The options carry previews, drawn in a box beside the list. Such a
   * question has no "Type something" row, and a digit only moves the
   * highlight. Optional: an older agent does not send it.
   */
  previews: z.boolean().optional(),
});

/**
 * The /model picker as drawn (capture of 2026-09-21). Unlike an
 * AskUserQuestion this dialog has no tab strip and its rows carry no
 * checkbox; the model in use is marked with a "✔" on its label, and the
 * effort row underneath changes with the highlighted row.
 */
export const ModelScreen = z.object({
  rows: z.array(
    z.object({
      /** The digit that selects the row. */
      n: z.number().int(),
      /** "Opus", "Haiku", "Default (recommended)". */
      label: z.string(),
      /** "Opus 5 · Best for everyday, complex tasks". */
      description: z.string().nullable(),
      /** The "✔" row: what the session is using now. */
      current: z.boolean(),
      /** The "❯" row: where the cursor sits, which is what the arrows move. */
      selected: z.boolean(),
    }),
  ),
  /** The effort line, when the highlighted model supports it. */
  effort: z.string().nullable(),
});

/**
 * A permission prompt, whole and in plain words (agent permissionRequest.ts).
 * From the policy hook's copy of the call for a Worker, else from the dialog
 * as drawn, its wrapped lines joined back. Every field is a string, so `by`
 * may grow without breaking an older reader.
 */
export const PermissionRequest = z.object({
  /** A few words: "Install packages", "Edit a file". */
  headline: z.string(),
  /** One or two plain sentences on what will happen, for someone who does not read code. */
  plain: z.string(),
  /** Why it came to you: the policy's rule, or Claude Code's own prompt. */
  why: z.string(),
  /** The request as asked, untrimmed: the whole command, the file and the edit. At most about 20,000 characters. */
  exact: z.string(),
  /** Who wrote `plain`: "ai" (a short Haiku run) or "template". */
  by: z.string(),
  /**
   * The dialog this was read from, as a hash (agent pane.ts dialogKey). Allow
   * sends it back as `dialogKey`, and the agent presses Enter only while the
   * same dialog is up. Optional: an older agent does not send it.
   */
  key: z.string().optional(),
  /**
   * What else an Allow may cover (agent allowScopes.ts), absent when once is
   * all: `scopes` among once, task, project, always (free strings, so a new
   * one never fails an older app's parse); the hosts, MCP tool or package
   * tool it would stand for; the project as the policy names it (owner/repo),
   * for a project allowlist write; `suggest`, the scope Cobra suggests after
   * several clean Allows. Allow sends the chosen one back as `scope`.
   */
  allow: z
    .object({
      scopes: z.array(z.string()),
      hosts: z.array(z.string()).optional(),
      tool: z.string().optional(),
      install: z.string().optional(),
      project: z.string().optional(),
      suggest: z.string().optional(),
    })
    .optional(),
});

/** What the pane reader sees right now, so one poll answers "and what is it doing?". */
export const Screen = z.object({
  recognised: z.boolean(),
  working: z.boolean(),
  needsInput: z.boolean(),
  dialog: z.enum(["permission", "question", "trust", "model"]).nullable(),
  /** The lines under a dialog — the command a permission prompt is about. */
  tail: z.array(z.string()),
  question: ScreenQuestion.nullable().optional(),
  /** The model picker in detail, when the dialog is one. */
  model: ModelScreen.nullable().optional(),
  /** The permission prompt on screen in full, when the dialog is one. Optional: an older agent does not send it. */
  request: PermissionRequest.optional(),
});

export const Transcript = z.object({
  session: z.string(),
  /** The directory the agent runs in, which is where its transcript is found. */
  path: z.string(),
  /** Null when no transcript exists yet — a shell, or Claude not started. */
  file: z.string().nullable(),
  /** Byte offset to pass back as `after` for the next incremental read. */
  offset: z.number().int(),
  /** Claude Code's own title for the session, when it has written one. */
  title: z.string().nullable(),
  messages: z.array(TranscriptMessage),
  screen: Screen.nullable(),
  /**
   * The model the session is answering with, as the last assistant turn
   * recorded it ("claude-opus-5"). Null before Claude has said anything —
   * a fresh session has no turn to read it off.
   */
  model: z.string().nullable(),
  /** That turn's effort ("high"), which the transcript records alongside. */
  effort: z.string().nullable(),
  /**
   * The AskUserQuestion call on screen, as the agent's Claude Code hook
   * copied it when it was asked — with descriptions and previews, which the
   * transcript does not have until it is answered. Only while the screen
   * shows one of these questions; optional, as an older agent sends nothing.
   */
  asking: z.array(Question).nullable().optional(),
});

/** One answer per question, matched by the question's text. */
export const Answer = z.object({
  question: z.string(),
  /** 1-based, as the options are numbered on screen. */
  option: z.number().int().positive().optional(),
  options: z.array(z.number().int().positive()).optional(),
  /** Free text, for the "Type something" row. */
  text: z.string().optional(),
});

export type QuestionOption = z.infer<typeof QuestionOption>;
export type Question = z.infer<typeof Question>;
export type TranscriptMessage = z.infer<typeof TranscriptMessage>;
export type ScreenQuestion = z.infer<typeof ScreenQuestion>;
export type ModelScreen = z.infer<typeof ModelScreen>;
export type Screen = z.infer<typeof Screen>;
export type PermissionRequest = z.infer<typeof PermissionRequest>;
export type Transcript = z.infer<typeof Transcript>;
export type Answer = z.infer<typeof Answer>;
