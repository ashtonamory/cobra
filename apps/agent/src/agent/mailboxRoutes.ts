import { NO_BOX } from "../../../../packages/contracts/src/mailboxes.ts";

import { addMailbox, loadMailboxes, MAILBOX_PROVIDERS, MAILBOXES_PATH, MailboxError, PROVIDER_WORDS, publicMailbox, removeMailbox, setSpaceMailbox, ZOHO_REGIONS, type BoxChecks } from "./mailboxes.ts";

/**
 * The person's mailboxes, for the
 * phone's and the desk's Settings: the boxes added here (never their
 * passwords), add one (both logins checked first), remove one, and the box
 * each Space's email goes from. A phone's or desk's key only: a Foreman
 * never sees or changes a mailbox.
 */

export const MAILBOX_ROUTES = new Set(["/email/mailboxes", "/email/mailboxes/remove", "/email/mailboxes/space"]);

type Reply = { status: number; body: unknown };
export type MailboxRouteDeps = { spaces: () => { id: string; name: string }[]; now: () => Date; log: (line: string) => void; path?: string; checks?: BoxChecks };

const bad = (status: number, error: string): Reply => ({ status, body: { error } });

function listed(deps: MailboxRouteDeps): Reply {
  const file = loadMailboxes(deps.path ?? MAILBOXES_PATH);
  return {
    status: 200,
    body: {
      boxes: file.boxes.map((box) => publicMailbox(box, file)),
      providers: MAILBOX_PROVIDERS.map((id) => ({ id, ...PROVIDER_WORDS[id] })),
      regions: ZOHO_REGIONS,
      spaces: deps.spaces().map((space) => ({ id: space.id, name: space.name, box: file.spaces[space.id] ?? NO_BOX })),
    },
  };
}

export async function handleMailboxes(route: string, method: string, body: string, caller: { kind: string }, deps: MailboxRouteDeps, personKinds: ReadonlySet<string>): Promise<Reply> {
  if (!personKinds.has(caller.kind)) return bad(403, "only the desk app you linked sees or changes mailboxes");
  if (method !== "GET" && method !== "POST") return bad(405, "POST only");
  let input: Record<string, unknown> = {};
  if (method === "POST") {
    try {
      input = JSON.parse(body || "{}") as Record<string, unknown>;
    } catch {
      return bad(400, "the body is JSON");
    }
  }
  const path = deps.path ?? MAILBOXES_PATH;
  try {
    // A refused mailboxes.json (mailboxes.ts loadMailboxes) is a 500 that says the fix, here as on every change.
    if (route === "/email/mailboxes" && method === "GET") return listed(deps);
    if (method !== "POST") return bad(405, "POST only");
    switch (route) {
      case "/email/mailboxes": {
        const box = await addMailbox(input, deps.now(), path, deps.checks);
        deps.log(`mailbox ${box.provider} ${box.address} added`);
        return { status: 200, body: { box } };
      }
      case "/email/mailboxes/remove":
        removeMailbox(String(input.id ?? ""), path);
        deps.log(`mailbox ${String(input.id)} removed`);
        return listed(deps);
      case "/email/mailboxes/space": {
        const space = String(input.space ?? "");
        if (!deps.spaces().some((s) => s.id === space)) return bad(404, "no such Space here");
        setSpaceMailbox(space, String(input.box ?? ""), path);
        deps.log(`space ${space} sends from ${String(input.box)}`);
        return listed(deps);
      }
    }
  } catch (caught) {
    if (caught instanceof MailboxError) return bad(caught.status, caught.message);
    throw caught;
  }
  return bad(404, `no route ${route}`);
}
