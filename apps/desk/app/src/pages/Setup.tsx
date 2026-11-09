/**
 * The first thing a new desktop shows: the agent is not linked yet. The agent
 * runs on this computer, installed by its own `install.sh`: the checks are its
 * CLI, its systemd unit (Linux) and the port its agent.env names. When they
 * pass, Link asks it for a desk key (`cobra-agent desk`), kept in
 * computers.json; the desk then talks to it on loopback only.
 */
import { APP_NAME } from "../lib/appName.ts";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../app/context.ts";
import { bridge, type HostState } from "../lib/bridge.ts";
import { setupAdvice, setupSteps } from "../lib/setupSteps.ts";
import { Button, Card, GroupTitle } from "../components/ui.tsx";

export function SetupPage() {
  return (
    <div className="page">
      <div className="page-narrow col" style={{ gap: 18, maxWidth: 720 }}>
        <div>
          <h1 className="mono" style={{ margin: "8px 0 4px", letterSpacing: 1 }}>Welcome to {APP_NAME}</h1>
          <div className="dim">
            {APP_NAME} runs your work and life from this computer. Its agent runs here; link it to begin.
          </div>
        </div>
        <AgentSetup />
      </div>
    </div>
  );
}

/** The setup checklist and Link; also Settings → This computer. */
export function AgentSetup() {
  const { reloadMachines, toast } = useApp();
  const [host, setHost] = useState<HostState | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setHost(await bridge.hostState());
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    check();
  }, [check]);

  const link = async () => {
    setBusy(true);
    setError("");
    try {
      toast(await bridge.linkAgent());
      await reloadMachines();
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const steps = host ? setupSteps(host) : [];
  const ready = host?.agentInstalled && host?.agentAnswering;

  return (
    <div className="col" style={{ gap: 14 }}>
      <GroupTitle>This computer{host ? ` · ${host.hostname}` : ""}</GroupTitle>
      <Card>
        {!host ? (
          <div className="dim">Looking…</div>
        ) : (
          <>
            {steps.map(([title, ok, note]) => (
              <div className="row" key={title} style={{ alignItems: "flex-start" }}>
                <span className="mono" style={{ color: ok ? "var(--green)" : "var(--signal)", width: 18 }}>{ok ? "✓" : "○"}</span>
                <div className="col grow" style={{ gap: 0 }}>
                  <span>{title}</span>
                  {note && <span className="dim">{note}</span>}
                </div>
              </div>
            ))}
            <div className="wrap" style={{ marginTop: 6 }}>
              {ready ? (
                <Button kind="primary" disabled={busy} onClick={() => link()}>
                  {busy ? "Linking…" : "Link the agent"}
                </Button>
              ) : (
                <span className="dim">{setupAdvice(host)}</span>
              )}
              <Button kind="flat" disabled={checking} onClick={check}>{checking ? "Checking…" : "Check again"}</Button>
            </div>
          </>
        )}
      </Card>
      {error && <div className="needs-card selectable" style={{ whiteSpace: "pre-wrap" }}>{error}</div>}
    </div>
  );
}
