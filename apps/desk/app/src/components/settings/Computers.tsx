/**
 * Settings → THIS COMPUTER: the agent this desktop talks to (computers.json's one entry), with
 * Unlink behind a confirm, then the same checks and Link the welcome page shows (pages/Setup.tsx
 * AgentSetup). Linking again replaces the desk key and revokes the old one.
 */
import { APP_NAME } from "../../lib/appName.ts";
import { useState } from "react";
import { useApp, useFleet } from "../../app/context.ts";
import { bridge } from "../../lib/bridge.ts";
import * as config from "../../lib/config.ts";
import { AgentSetup } from "../../pages/Setup.tsx";
import { Confirm } from "../Verbs.tsx";
import { Board, BoardRow, Button } from "../ui.tsx";
import { Group, why } from "./common.tsx";

export function ComputersSection() {
  const { reloadMachines, toast, machinesVersion } = useApp();
  const fleet = useFleet();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  void machinesVersion; // drawn again when it is linked or unlinked
  const m = config.agent();

  const unlink = async () => {
    setBusy(true);
    try {
      const said = await bridge.unlinkAgent();
      if (said) toast(said);
      await reloadMachines();
    } catch (e) {
      toast(`Couldn't unlink: ${why(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Group title="The agent" note={m ? undefined : "Not linked yet: check this computer below, then Link."}>
        {m && (
          <Board>
            <BoardRow time={null} title={m.label} machine={m.machine}
              word={fleet.reachable.has(m.machine) ? "answering" : "local"} tone="ink"
              detail={[m.machine.toLowerCase() === m.label.toLowerCase() ? "" : `hostname ${m.machine}`, m.base].filter(Boolean).join(" · ")}
              actions={
                <Button kind="flat" small disabled={busy} onClick={() => setAsking(true)}>
                  {busy ? "Unlinking…" : "Unlink"}
                </Button>
              } />
          </Board>
        )}
      </Group>
      <AgentSetup />
      {asking && m && (
        <Confirm
          title="Unlink the agent?"
          body={`This desktop forgets its key for ${m.label}, and the agent revokes it. ${APP_NAME}'s agent keeps running; link it again to see it here.`}
          yes="Unlink"
          danger
          onYes={() => unlink()}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
}
