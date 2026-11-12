import { createKeyStore, KEYS_PATH } from "./keys.ts";

/**
 * Cobra runs on one computer and is never reachable from another: the agent
 * listens on loopback only. COBRA_AGENT_BIND may pick IPv6 loopback ("::1");
 * any other value is refused at startup rather than quietly exposing the API.
 */
function resolveBind(): string {
  const requested = process.env.COBRA_AGENT_BIND?.trim();
  if (!requested || requested === "127.0.0.1" || requested === "localhost") return "127.0.0.1";
  if (requested === "::1") return "::1";
  console.error(`[cobra-agent] COBRA_AGENT_BIND=${requested} refused: Cobra listens on loopback only (127.0.0.1 or ::1).`);
  process.exit(1);
}

const bind = resolveBind();
const loopbackOnly = bind === "127.0.0.1" || bind === "::1";

/**
 * Stop on a refused key file rather than carrying on. A refusal (a symlink,
 * another owner, a mode others can read) is a misconfiguration someone needs
 * to see at startup, not a machine that 401s every request while looking
 * healthy.
 */
const keys = createKeyStore();
const keysRead = keys.load();
if (keysRead.refused) {
  console.error(
    `[cobra-agent] refusing to read ${KEYS_PATH}: ${keysRead.refused}.\n` +
      `           Fix it with: chmod 600 ${KEYS_PATH}\n` +
      `           If others could change it, delete it and link the desk app again (Settings → This computer → Link the agent).`,
  );
  process.exit(1);
}

export const config = {
  port: Number(process.env.COBRA_AGENT_PORT ?? 8787),
  bind,
  keys,
  loopbackOnly,
  version: "0.3.0",
} as const;
