/**
 * Settings → THIS APP: whether the app starts when you sign in, its look, the passcode, whether the
 * crew shows, the picker's shortcut, and the app's own updates.
 */
import { APP_NAME } from "../../lib/appName.ts";
import { useEffect, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { shortNotes, updateLine, type UpdateState } from "../../lib/updates.ts";
import { ask } from "@tauri-apps/plugin-dialog";
import { useApp } from "../../app/context.ts";
import { bridge } from "../../lib/bridge.ts";
import { osOf, pickerShortcut } from "../../lib/appSettings.ts";
import { leadName } from "../../lib/appName.ts";
import { statusLine, type Mode, type PasscodeStatus } from "../../lib/passcode.ts";
import { Button, Switch } from "../ui.tsx";
import { PasscodeDialog } from "../PasscodeAsk.tsx";
import { THEME_CHOICES, readPref, savePref, type ThemePref } from "../../lib/theme.ts";
import { SHOW_CREW_HELP, SHOW_CREW_LABEL, saveShowCrew, useShowCrew } from "../../lib/crewVisibility.ts";
import { FlowRow, Group, Toggles, why } from "./common.tsx";

/** Settings → This app → Passcode: what stands where the phone asks for Face ID (src-tauri/src/passcode.rs). */
function PasscodeGroup() {
  const { toast } = useApp();
  const [status, setStatus] = useState<PasscodeStatus | null>(null);
  const [dialog, setDialog] = useState<Mode | null>(null);
  const read = () => bridge.passcodeStatus().then(setStatus, () => setStatus(null));
  useEffect(() => {
    void read();
    const timer = setInterval(() => void read(), 15_000);
    return () => clearInterval(timer);
  }, []);
  const done = (ok: boolean) => {
    const mode = dialog;
    setDialog(null);
    void read();
    if (ok && mode) toast({ make: "Passcode made", change: "Passcode changed", remove: "Passcode removed", unlock: "Unlocked" }[mode]);
  };
  return (
    <Group title="Passcode" note="This app asks for its passcode before a hidden value is shown, and before an Allow that is yours alone. Forgotten: delete passcode.json in this app's config folder and make a new one."
      footnote="A right passcode unlocks for 5 minutes. Five wrong ones in a row lock it out for a minute.">
      <FlowRow
        main={<div className="col" style={{ gap: 2 }}><span>Passcode</span><span className="dim">{statusLine(status)}</span></div>}
        trailing={
          <div className="row">
            {status && !status.set && <Button kind="primary" onClick={() => setDialog("make")}>Make a passcode…</Button>}
            {status?.set && <Button onClick={() => setDialog("change")}>Change…</Button>}
            {status?.set && <Button kind="flat" disabled={!status.unlocked} onClick={() => void bridge.passcodeLock().then(read)}>Lock now</Button>}
            {status?.set && <Button kind="flat" onClick={() => setDialog("remove")}>Remove…</Button>}
          </div>
        } />
      {dialog && <PasscodeDialog mode={dialog} done={done} />}
    </Group>
  );
}

/** Settings → This app → Updates: a check when you ask, an install when you click (lib/updates.ts). */
function UpdatesGroup() {
  const [current, setCurrent] = useState<string | null>(null);
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [update, setUpdate] = useState<Update | null>(null);
  useEffect(() => {
    getVersion().then(setCurrent, () => setCurrent(null));
  }, []);
  const look = async () => {
    setState({ kind: "checking" });
    try {
      const found = await check();
      setUpdate(found);
      setState(found ? { kind: "ready", version: found.version, notes: shortNotes(found.body) } : { kind: "current" });
    } catch (e) {
      setState({ kind: "failed", why: why(e) });
    }
  };
  const install = async () => {
    if (!update) return;
    if (!(await ask(`Install ${APP_NAME} ${update.version} and restart the app? The agent and your sessions keep running.`, { title: "Update", kind: "info" }))) return;
    let done = 0;
    let total: number | null = null;
    setState({ kind: "installing", version: update.version, done, total });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? null;
        if (event.event === "Progress") done += event.data.chunkLength;
        setState({ kind: "installing", version: update.version, done, total });
      });
      await relaunch();
    } catch (e) {
      setState({ kind: "failed", why: why(e) });
    }
  };
  const busy = state.kind === "checking" || state.kind === "installing";
  return (
    <Group title="Updates" note="Each update is signed. The app checks the signature before it installs one, and refuses one that does not match.">
      <FlowRow
        main={<div className="col" style={{ gap: 2 }}><span>{APP_NAME} desktop app</span><span className="dim">{updateLine(state, current)}</span>
          {state.kind === "ready" && state.notes && <span className="dim">{state.notes}</span>}</div>}
        trailing={
          <div className="row">
            {state.kind === "ready"
              ? <Button kind="primary" onClick={() => void install()}>Install and restart…</Button>
              : <Button disabled={busy} onClick={() => void look()}>Check for updates</Button>}
          </div>
        } />
    </Group>
  );
}

export function ThisAppSection() {
  const { toast } = useApp();
  const [theme, setTheme] = useState<ThemePref>(readPref);
  const showCrew = useShowCrew();
  const os = osOf(navigator.userAgent);
  const [autostart, setAutostart] = useState<boolean | null>(null);

  useEffect(() => {
    isEnabled().then(setAutostart, () => setAutostart(false));
  }, []);

  const flip = async (on: boolean) => {
    setAutostart(on);
    try {
      if (on) await enable();
      else await disable();
      toast(on ? `${APP_NAME} starts when you sign in` : `${APP_NAME} no longer starts when you sign in`);
    } catch (e) {
      setAutostart(!on);
      toast(`Not changed: ${why(e)}`);
    }
  };

  return (
    <>
      <Group title="Starting">
        <FlowRow
          main={<div className="col" style={{ gap: 2 }}><span>Start {APP_NAME} when you sign in</span>
            <span className="dim">It starts in the tray, watching the agent, with the window closed.</span></div>}
          trailing={<Switch checked={!!autostart} disabled={autostart === null} onChange={flip} />} />
      </Group>

      <Group title="Appearance" note="System follows the light or dark setting of this computer.">
        <FlowRow
          main={<div className="col" style={{ gap: 2 }}><span>Theme</span><span className="dim">Every window of {APP_NAME} changes together.</span></div>}
          trailing={<Toggles options={THEME_CHOICES.map(([key, label]) => ({ key, label }))} active={theme}
            onPick={(key) => { const pref = key as ThemePref; setTheme(pref); savePref(pref); }} />} />
      </Group>

      <PasscodeGroup />

      <Group title="Developer" note={`Off, you talk only to ${leadName()}: Spaces show their skills, and what needs you names the Space.`}>
        <FlowRow
          main={<div className="col" style={{ gap: 2 }}><span>{SHOW_CREW_LABEL}</span><span className="dim">{SHOW_CREW_HELP}</span></div>}
          trailing={<Switch checked={showCrew} onChange={(on) => saveShowCrew(on)} />} />
      </Group>

      <UpdatesGroup />

      <Group title="Find a session">
        <FlowRow
          main={<div className="col" style={{ gap: 2 }}><span>Open the picker from anywhere</span>
            <span className="dim">Every session, to jump to or answer.</span></div>}
          trailing={<span className="mono keycap">{pickerShortcut(os)}</span>} />
      </Group>

    </>
  );
}
