// The live parts of opening a Space (spaceCreate.ts takes them as deps so it
// can be tested without a computer): the org file, the project registry, a
// the folders list and the company brain.
import * as os from "node:os";

import { ensureFolder, readFolders, writeFolders } from "./folders.ts";
import { computerName, MEMORY_DIR, memoryPaths, readMemoryFile, writeMemoryFile } from "./memory.ts";
import { loadOrg, saveOrg } from "./orgRoutes.ts";
import { DEFAULT_CONFIG_PATH } from "./collect/projects.ts";
import { loadRegistry } from "./registry.ts";
import type { SpaceDeps } from "./spaceCreate.ts";
import { SPACES_DIR } from "./spaces.ts";

type Inputs = Pick<SpaceDeps, "approvals" | "notify" | "tell" | "log"> & {
  configPath?: string;
};

export function liveSpaceDeps(input: Inputs): SpaceDeps {
  const machine = os.hostname();
  const configPath = input.configPath ?? process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH;
  return {
    machine,
    spacesRoot: SPACES_DIR,
    org: { load: () => loadOrg(), save: (org) => saveOrg(org) },
    approvals: input.approvals,
    notify: input.notify,
    tell: input.tell,
    log: input.log,
    now: Date.now,
    // The Spaces folder becomes a place projects may be made in, once: a seat's project goes in <root>/<space>/<seat>. It is made first, since the first Space is what makes it.
    addRoot: async () => {
      const registry = await loadRegistry(configPath);
      await ensureFolder(SPACES_DIR, readFolders(), registry.roots, writeFolders);
    },
    // This computer is the Lead's and the Space's home, so it holds the brain whether or not the company is Sensitive.
    seedBrain: (company, text) => {
      const path = memoryPaths.brain(computerName(), company.id);
      if (readMemoryFile(MEMORY_DIR, path) === null) writeMemoryFile(MEMORY_DIR, path, text);
    },
  };
}
