import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api.ts";
import { mergeThread, parseThreadPage, type ThreadEntry } from "../lib/threadRules.ts";

/** How often her thread is asked what is new while her pane is shown. */
const THREAD_POLL_MS = 30_000;

export interface Thread {
  entries: ThreadEntry[];
  /** The conversation running now, or null when the hub does not say. */
  current: string | null;
  /** Reads the page before the oldest entry. Resolves true when it brought something. */
  older: () => Promise<boolean>;
  /** Reads what is new now (after a New conversation, a message). */
  refresh: () => void;
}

/**
 * Cobra's thread on the hub (agent thread.ts, `GET /thread`; rules in lib/threadRules.ts), the
 * phone's useThread.ts: the newest page when her pane shows, what is new every 30 s while it stays,
 * and older pages as you scroll up. A computer that keeps no thread (404 `not-hub`, or an agent
 * from before it) leaves the pane drawing her transcript alone. Keyed by the computer.
 */
export function useThread(machine: string | null): Thread {
  const [entries, setEntries] = useState<ThreadEntry[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const kept = useRef<ThreadEntry[]>([]);
  kept.current = entries;
  const more = useRef(false);
  const busy = useRef(false);

  const read = useCallback(async (query: { before?: number; after?: number }): Promise<boolean> => {
    if (!machine || busy.current) return false;
    busy.current = true;
    try {
      const page = parseThreadPage(await api.thread(machine, query));
      if (!page) return false;
      setCurrent(page.current);
      // `more` speaks of what is older than the page, so a read of what is new leaves it as it was.
      if (query.after === undefined) more.current = page.more;
      setEntries((existing) => mergeThread(existing, page.entries));
      return page.entries.length > 0;
    } catch (e) {
      // 404: no thread here; anything else waits for the next read.
      if (e instanceof api.ApiError && e.status === 404) {
        setEntries([]);
        setCurrent(null);
      }
      return false;
    } finally {
      busy.current = false;
    }
  }, [machine]);

  const refresh = useCallback(() => {
    const last = kept.current[kept.current.length - 1];
    void read(last ? { after: last.id } : {});
  }, [read]);

  useEffect(() => {
    setEntries([]);
    setCurrent(null);
    more.current = false;
    if (!machine) return;
    refresh();
    const timer = setInterval(refresh, THREAD_POLL_MS);
    return () => clearInterval(timer);
  }, [machine, refresh]);

  const older = useCallback(async () => {
    const oldest = kept.current[0];
    return oldest && more.current ? read({ before: oldest.id }) : false;
  }, [read]);

  return { entries, current, older, refresh };
}
