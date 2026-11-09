import { realpathSync } from "node:fs";

import { DEFINED_DIR } from "./definedTrades.ts";
import { liveRenderDeps } from "./render.ts";

/**
 * Where worker_import may copy from besides your home folder: the shipped
 * trades' templates and the ones Cobra defined, resolved, since a file's
 * own path is compared once its links are followed.
 */
export function importSources(): string[] {
  return [liveRenderDeps().shippedTemplates, DEFINED_DIR].map((path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  });
}
