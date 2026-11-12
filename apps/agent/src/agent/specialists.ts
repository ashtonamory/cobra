import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Project } from "@cobra/contracts";
import type { ApprovalSpecialist, SpecialistView } from "@cobra/contracts";

import { audit } from "./auditTrail.ts";
import { CLAUDE_MODELS } from "./brain/catalog.ts";
import { crewFor } from "./crew.ts";
import { CONFIG_DIR, STATE_DIR } from "./paths.ts";
import { readPrivateFile, writePrivateFile } from "./private.ts";

/**
 * A specialist is a project's Foreman as the person owns it: beside its name
 * and look (crew.ts), a one-line title that says what it is for, the
 * person's standing instructions for it, and the model it runs on. The id is
 * the project's id.
 *
 * Its instructions go into the Foreman's own prompt, so they change only two
 * ways: the person sets them (POST /specialists/set), or the Lead proposes
 * them on a card that shows every word (specialistRoutes.ts) and the person
 * allows it. Never from a conversation that read text from outside.
 *
 * A change applies to the Foreman's next conversation; one that runs keeps
 * what it started with.
 */

export const SPECIALISTS_PATH = process.env.COBRA_SPECIALISTS ?? join(CONFIG_DIR, "specialists.json");
/** The Lead's proposals not yet answered, each by its approval's id. */
export const SPECIALIST_PROPOSALS_DIR = join(STATE_DIR, "specialist-proposals");

export const TITLE_MAX = 120;
export const INSTRUCTIONS_MAX = 8000;
/** How many repositories one specialist may be attached to: enough for a person's projects, few enough to keep track of. */
export const REPOS_MAX = 8;

/** The models a Foreman may run on: Claude Code's own names. A Codex Foreman keeps the Codex account's model. */
export const SPECIALIST_MODELS: readonly string[] = CLAUDE_MODELS;

export type SpecialistRecord = {
  /** Absent: its trade's name. */
  title?: string;
  /** Absent: none. */
  instructions?: string;
  /** Absent: the Foremen's own (orchModels.ts). */
  model?: string;
  /**
   * The repositories it is attached to besides its own project, by project
   * id (specialistAttach.ts). Its Workers may live there and it reads their
   * files; nothing else of those projects is its own.
   */
  repos?: string[];
  updatedAt: string;
  updatedBy: "person" | "lead";
};

/** What a change may set. `null` or "" takes a field back to its default. */
export type SpecialistChange = { title?: string; instructions?: string; model?: string };

type SpecialistFile = { specialists: Record<string, SpecialistRecord> };

function isRecord(value: unknown): value is SpecialistRecord {
  const v = value as Partial<SpecialistRecord> | null;
  if (!v || typeof v !== "object" || typeof v.updatedAt !== "string") return false;
  if (v.updatedBy !== "person" && v.updatedBy !== "lead") return false;
  if (v.title !== undefined && (typeof v.title !== "string" || v.title.length > TITLE_MAX)) return false;
  if (v.instructions !== undefined && (typeof v.instructions !== "string" || v.instructions.length > INSTRUCTIONS_MAX)) return false;
  if (v.repos !== undefined && (!Array.isArray(v.repos) || v.repos.length > REPOS_MAX || v.repos.some((repo) => typeof repo !== "string" || !repo))) return false;
  return v.model === undefined || typeof v.model === "string";
}

/** Every kept record. A file that is missing, unreadable or open to others gives none: each Foreman then runs as it ships. */
export function loadSpecialists(path = SPECIALISTS_PATH): SpecialistFile {
  const file: SpecialistFile = { specialists: {} };
  try {
    const read = readPrivateFile(path);
    if (read.refused) {
      console.error(`[cobra-agent] refusing to read ${path}: ${read.refused}; no specialist has instructions until it is fixed`);
      return file;
    }
    const parsed = JSON.parse(read.text ?? "{}") as { specialists?: Record<string, unknown> };
    for (const [id, value] of Object.entries(parsed.specialists ?? {})) if (isRecord(value)) file.specialists[id] = value;
  } catch {
    // Not there yet, or not JSON: nobody has been customized.
  }
  return file;
}

export function readSpecialist(id: string, path = SPECIALISTS_PATH): SpecialistRecord | null {
  return loadSpecialists(path).specialists[id] ?? null;
}

/** A title as kept: one line, tidied. An error in words when it cannot be one. */
export function cleanTitle(raw: unknown): { title: string } | { error: string } {
  if (typeof raw !== "string") return { error: "title is one line of text" };
  const title = raw.replace(/\s+/g, " ").trim();
  if (title.length > TITLE_MAX) return { error: `title is at most ${TITLE_MAX} characters; this one is ${title.length}` };
  return { title };
}

/** Instructions as kept: the person's words, with line ends made plain and no control characters. */
export function cleanInstructions(raw: unknown): { instructions: string } | { error: string } {
  if (typeof raw !== "string") return { error: "instructions is text" };
  // eslint-disable-next-line no-control-regex
  const instructions = raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (instructions.length > INSTRUCTIONS_MAX) return { error: `instructions are at most ${INSTRUCTIONS_MAX} characters; these are ${instructions.length}` };
  return { instructions };
}

export function cleanModel(raw: unknown): { model: string } | { error: string } {
  if (raw === null || raw === "") return { model: "" };
  if (typeof raw !== "string" || !SPECIALIST_MODELS.includes(raw)) return { error: `model is one of ${SPECIALIST_MODELS.join(", ")}, or empty for the usual one` };
  return { model: raw };
}

/**
 * A change read from a request: only the fields it names, each checked. An
 * empty title, empty instructions or an empty model means "back to the
 * default". An error in words when a field is wrong or nothing was named.
 */
export function parseChange(raw: unknown): SpecialistChange | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "send the fields to change: title, instructions, model";
  const body = raw as Record<string, unknown>;
  const change: SpecialistChange = {};
  if (body.title !== undefined) {
    const title = cleanTitle(body.title ?? "");
    if ("error" in title) return title.error;
    change.title = title.title;
  }
  if (body.instructions !== undefined) {
    const instructions = cleanInstructions(body.instructions ?? "");
    if ("error" in instructions) return instructions.error;
    change.instructions = instructions.instructions;
  }
  if (body.model !== undefined) {
    const model = cleanModel(body.model);
    if ("error" in model) return model.error;
    change.model = model.model;
  }
  if (Object.keys(change).length === 0) return "send at least one of title, instructions, model";
  return change;
}

/** The record a change leaves: a field set to "" is dropped, so it reads as its default again. */
export function withChange(current: SpecialistRecord | null, change: SpecialistChange, by: SpecialistRecord["updatedBy"], now: number): SpecialistRecord {
  const merged = { title: current?.title, instructions: current?.instructions, model: current?.model, ...change };
  return {
    ...(merged.title ? { title: merged.title } : {}),
    ...(merged.instructions ? { instructions: merged.instructions } : {}),
    ...(merged.model ? { model: merged.model } : {}),
    // Not a field a change sets: attaching has its own routes and its own card (specialistAttach.ts).
    ...(current?.repos?.length ? { repos: current.repos } : {}),
    updatedAt: new Date(now).toISOString(),
    updatedBy: by,
  };
}

/**
 * Keeps a change for one specialist, and writes the audit line: who, which
 * fields and how long, never the words themselves.
 */
export function setSpecialist(id: string, change: SpecialistChange, by: SpecialistRecord["updatedBy"], actor: string, now = Date.now(), path = SPECIALISTS_PATH): SpecialistRecord {
  const file = loadSpecialists(path);
  const next = withChange(file.specialists[id] ?? null, change, by, now);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFile(path, `${JSON.stringify({ specialists: { ...file.specialists, [id]: next } }, null, 2)}\n`);
  audit("specialist.set", {
    actor,
    subject: { project: id },
    detail: {
      by,
      fields: Object.keys(change).sort().join(","),
      titleChars: next.title?.length ?? 0,
      instructionsChars: next.instructions?.length ?? 0,
      model: next.model ?? "",
    },
  });
  return next;
}

/** A project that can have a specialist, or be attached to one: a repository here, never a session under one. */
export function isRepository(project: Pick<Project, "parent" | "lead" | "foreman">): boolean {
  return project.parent === undefined && !project.lead && !project.foreman;
}

/**
 * The repositories a specialist is attached to, as they are now: each id
 * that is still a repository here and not its own project. One whose project
 * is gone is left out, so it gives nothing.
 */
export function attachedRepos<T extends Pick<Project, "id" | "parent" | "lead" | "foreman">>(id: string, projects: readonly T[], path = SPECIALISTS_PATH): T[] {
  const ids = readSpecialist(id, path)?.repos ?? [];
  if (ids.length === 0) return [];
  return ids.flatMap((repo) => {
    const project = repo === id ? undefined : projects.find((candidate) => candidate.id === repo && isRepository(candidate));
    return project ? [project] : [];
  });
}

/**
 * Attaches or detaches one repository, and writes the audit line (ids only).
 * `known` is every repository here: an id no longer among them is dropped
 * from the list on this write. Throws in words when the list would be over
 * REPOS_MAX; attaching one already there, or detaching one that is not,
 * changes nothing and still answers the record.
 */
export function setAttached(
  id: string,
  repo: string,
  attach: boolean,
  known: ReadonlySet<string>,
  by: SpecialistRecord["updatedBy"],
  actor: string,
  now = Date.now(),
  path = SPECIALISTS_PATH,
): SpecialistRecord {
  if (attach && repo === id) throw new Error("a specialist already works on its own project");
  const file = loadSpecialists(path);
  const current = file.specialists[id] ?? null;
  const kept = [...new Set(current?.repos ?? [])].filter((other) => other !== id && other !== repo && known.has(other));
  const repos = attach ? [...kept, repo] : kept;
  if (repos.length > REPOS_MAX) throw new Error(`a specialist is attached to at most ${REPOS_MAX} projects: detach one first`);
  const next: SpecialistRecord = {
    ...(current?.title ? { title: current.title } : {}),
    ...(current?.instructions ? { instructions: current.instructions } : {}),
    ...(current?.model ? { model: current.model } : {}),
    ...(repos.length ? { repos } : {}),
    updatedAt: new Date(now).toISOString(),
    updatedBy: by,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFile(path, `${JSON.stringify({ specialists: { ...file.specialists, [id]: next } }, null, 2)}\n`);
  audit(attach ? "specialist.attach" : "specialist.detach", { actor, subject: { project: id }, detail: { by, repo, attached: repos.length } });
  return next;
}

/** The model a Foreman starts on: its record's when Claude Code can run it, else null (the Foremen's own). */
const warned = new Set<string>();
export function specialistModel(id: string, path = SPECIALISTS_PATH, log: (line: string) => void = (line) => console.log(line)): string | null {
  const model = readSpecialist(id, path)?.model;
  if (!model) return null;
  if (SPECIALIST_MODELS.includes(model)) return model;
  if (!warned.has(`${id}\0${model}`)) {
    warned.add(`${id}\0${model}`);
    log(`[cobra-agent] ${id}'s model "${model}" is not one a Foreman runs on (${SPECIALIST_MODELS.join(", ")}); it starts on the usual one`);
  }
  return null;
}

/** What a specialist is for when nobody said: its trade's name as the person reads it, or nothing. */
export function defaultTitle(trade: string | undefined, tradeName: (id: string) => string | undefined): string {
  return trade ? (tradeName(trade) ?? "") : "";
}

/** The roster: every repository's Foreman with its name and look (crew.ts) and its record. */
export function specialistViews(
  projects: readonly Project[],
  tradeName: (id: string) => string | undefined,
  options: { path?: string; crewPath?: string; companyOf?: (project: Project) => { id: string; name: string } | undefined } = {},
): SpecialistView[] {
  const repositories = projects.filter(isRepository);
  const crews = crewFor(repositories, options.crewPath);
  const records = loadSpecialists(options.path).specialists;
  return repositories.flatMap((project) => {
    const crew = crews[project.id];
    if (!crew) return [];
    const record = records[project.id];
    const company = options.companyOf?.(project);
    return [
      {
        id: project.id,
        project: project.name,
        name: crew.name,
        look: crew.look,
        hat: crew.hat,
        title: record?.title ?? defaultTitle(project.foremanTemplate, tradeName),
        instructions: record?.instructions ?? "",
        ...(record?.model ? { model: record.model } : {}),
        ...(project.foremanTemplate ? { trade: project.foremanTemplate } : {}),
        ...(company ? { company } : {}),
        repos: (record?.repos ?? []).flatMap((repo) => {
          const attached = repo === project.id ? undefined : repositories.find((candidate) => candidate.id === repo);
          return attached ? [{ id: attached.id, name: attached.name, path: attached.path }] : [];
        }),
        ...(record ? { updatedAt: record.updatedAt, updatedBy: record.updatedBy } : {}),
      },
    ];
  });
}

/**
 * Each repository's crew with what it is for, as the desk draws it beside the
 * name. Sessions under a repository keep the crew they wear, untitled.
 */
export function withTitles<T extends Project>(projects: T[], tradeName: (id: string) => string | undefined, path = SPECIALISTS_PATH): T[] {
  const records = loadSpecialists(path).specialists;
  return projects.map((project) => {
    if (!project.crew || project.parent !== undefined) return project;
    const title = records[project.id]?.title ?? defaultTitle(project.foremanTemplate, tradeName);
    return title ? { ...project, crew: { ...project.crew, title } } : project;
  });
}

// --- the Lead's proposal, on a card ---------------------------------------------------

/** What a card was made from: the specialist and exactly the fields it would set. */
export type SpecialistProposal = { id: string; change: SpecialistChange };

/** The hash Allow checks: the card applies exactly this, or nothing. */
export function proposalHash(proposal: SpecialistProposal): string {
  const { title, instructions, model } = proposal.change;
  return createHash("sha256").update(JSON.stringify({ id: proposal.id, title: title ?? null, instructions: instructions ?? null, model: model ?? null })).digest("hex");
}

const shown = (text: string | undefined, none: string): string => (text ? text : none);

/**
 * The card in words: every field the Lead would set, whole, and what each
 * replaces, whole. Nothing is summed up: the person allows what they read.
 */
export function describeProposal(
  proposal: SpecialistProposal,
  who: { name: string; project: string },
  current: { title: string; instructions: string; model: string },
): { specialist: ApprovalSpecialist; title: string; body: string } {
  const { change } = proposal;
  const lines: string[] = [`Cobra wants to change ${who.name}, who works on ${who.project}. Nothing changes until you allow it, and then from ${who.name}'s next conversation.`];
  if (change.title !== undefined) {
    lines.push("", "What it is for, now:", shown(change.title, "(the usual one for its job)"), "", "Before:", shown(current.title, "(none)"));
  }
  if (change.model !== undefined) {
    lines.push("", "Model, now:", shown(change.model, "(the usual one)"), "", "Before:", shown(current.model, "(the usual one)"));
  }
  if (change.instructions !== undefined) {
    lines.push("", "Your standing instructions for it, now:", shown(change.instructions, "(none)"), "", "Before:", shown(current.instructions, "(none)"));
  }
  return {
    specialist: {
      id: proposal.id,
      name: who.name,
      project: who.project,
      ...(change.title !== undefined ? { title: change.title } : {}),
      ...(change.instructions !== undefined ? { instructions: change.instructions } : {}),
      ...(change.model !== undefined ? { model: change.model } : {}),
      was: current,
      sha256: proposalHash(proposal),
    },
    title: `Change ${who.name}?`,
    body: lines.join("\n"),
  };
}

export function keepSpecialistProposal(approvalId: string, proposal: SpecialistProposal, dir = SPECIALIST_PROPOSALS_DIR): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateFile(join(dir, `${approvalId}.json`), JSON.stringify(proposal));
}

/** The proposal a card is for, or null when it is gone; removed once read. */
export function takeSpecialistProposal(approvalId: string, dir = SPECIALIST_PROPOSALS_DIR): SpecialistProposal | null {
  if (!/^ap_[A-Za-z0-9_-]+$/.test(approvalId)) return null;
  const path = join(dir, `${approvalId}.json`);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SpecialistProposal;
    rmSync(path, { force: true });
    return typeof parsed?.id === "string" && parsed.change && typeof parsed.change === "object" ? parsed : null;
  } catch {
    return null;
  }
}
