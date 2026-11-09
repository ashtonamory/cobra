import { testModeHere, noteTestMode } from "./apiTest.ts";

/**
 * API test mode's switch over (apiTest.ts): a tick that moves a running Lead
 * or Foreman to the mode wanted, by a fresh conversation (stop, then start,
 * which picks headless or tmux by the switch). A stopped one is left stopped;
 * running Workers finish where they are. Nothing moves before the gateway's
 * first read, so an agent restart never restarts them.
 */

export type OrchMode = "tmux" | "headless";

export type SwitchDeps = {
  /** Test mode here, or null while not known yet. */
  on: () => boolean | null;
  note: (on: boolean) => void;
  /** How the Lead runs now, or null when it does not. */
  lead: () => Promise<OrchMode | null>;
  restartLead: () => Promise<void>;
  /** Each running Foreman, by project, and how it runs. */
  foremen: () => Promise<Array<{ project: string; mode: OrchMode }>>;
  restartForeman: (project: string) => Promise<void>;
  log: (line: string) => void;
};

/** One tick; returns how many were moved. */
export async function switchTestMode(deps: SwitchDeps): Promise<number> {
  const on = deps.on();
  if (on === null) return 0;
  deps.note(on);
  const want: OrchMode = on ? "headless" : "tmux";
  const why = on ? "API test mode is on: it runs headless on the API key" : "API test mode is off: it runs in tmux again";
  let moved = 0;
  const lead = await deps.lead();
  if (lead !== null && lead !== want) {
    try {
      await deps.restartLead();
      moved++;
      deps.log(`api test: restarted the Lead (${why})`);
    } catch (caught) {
      deps.log(`api test: could not restart the Lead: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  for (const foreman of await deps.foremen()) {
    if (foreman.mode === want) continue;
    try {
      await deps.restartForeman(foreman.project);
      moved++;
      deps.log(`api test: restarted the Foreman for ${foreman.project} (${why})`);
    } catch (caught) {
      deps.log(`api test: could not restart the Foreman for ${foreman.project}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  return moved;
}

export const liveNote = (on: boolean) => void noteTestMode(on);
export const liveOn = () => testModeHere();
