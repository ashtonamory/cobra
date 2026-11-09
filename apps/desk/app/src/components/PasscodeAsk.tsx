/**
 * The desk's passcode, drawn (src-tauri/src/passcode.rs; words and rules in lib/passcode.ts): the dialog
 * that stands where the phone asks for Face ID, and the hook a screen asks it through.
 *
 *   const gate = usePasscodeAsk();
 *   if (!(await gate.ask("Show a hidden value"))) return;   // unlocked, or cancelled
 *   ...{gate.node}                                          // render once
 *
 * Unlocked already: `ask` answers at once. No passcode yet: the dialog makes one first, so the first Show
 * is also when it is set. Settings → This app uses the same dialog to make, change and remove it.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { bridge } from "../lib/bridge.ts";
import { askMode, fields, problem, type Mode } from "../lib/passcode.ts";
import { Button, Dialog } from "./ui.tsx";

const TITLES: Record<Mode, string> = { make: "Make a passcode", unlock: "Passcode", change: "Change the passcode", remove: "Remove the passcode" };
const LEDE: Record<Mode, string> = {
  make: "It is asked for before a hidden value is shown and before a person-only Allow. At least 8 characters. It stays on this computer, kept as a hash.",
  unlock: "It stays unlocked for 5 minutes.",
  change: "",
  remove: "Hidden values stay hidden, and a person-only Allow waits, until you make a new one.",
};
const SEND: Record<Mode, string> = { make: "Make passcode", unlock: "Unlock", change: "Change", remove: "Remove" };
const msg = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e));

/** One dialog for the four things a passcode does. `done(true)` when it worked, `done(false)` when closed. */
export function PasscodeDialog({ mode, reason, done }: { mode: Mode; reason?: string; done: (ok: boolean) => void }) {
  const [typed, setTyped] = useState<Partial<Record<"current" | "code" | "next" | "again", string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const wrong = problem(mode, typed);
    if (wrong) return setError(wrong);
    setBusy(true);
    setError(null);
    try {
      if (mode === "make") await bridge.passcodeSet(typed.next!);
      else if (mode === "change") await bridge.passcodeSet(typed.next!, typed.current!);
      else if (mode === "unlock") await bridge.passcodeUnlock(typed.code!);
      else await bridge.passcodeClear(typed.code!);
      done(true);
    } catch (e) {
      setError(msg(e));
      setBusy(false);
      setTyped({});
    }
  };
  const rows = fields(mode);
  return (
    <Dialog title={TITLES[mode]} onClose={() => done(false)} buttons={<>
      <Button onClick={() => done(false)}>Cancel</Button>
      <Button kind={mode === "remove" ? "danger" : "primary"} onClick={() => void send()} disabled={busy}>{busy ? "Checking…" : SEND[mode]}</Button>
    </>}>
      {reason && <p>{reason}</p>}
      {LEDE[mode] && <p className="dim">{LEDE[mode]}</p>}
      {rows.map(([field, label], i) => (
        <label key={field} className="dash-form-field">
          <span className="dim">{label}</span>
          <input className="entry" type="password" autoComplete="off" autoFocus={i === 0} value={typed[field] ?? ""}
            onChange={(e) => setTyped((t) => ({ ...t, [field]: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void send()} />
        </label>
      ))}
      {error && <div className="dash-error" role="alert">{error}</div>}
    </Dialog>
  );
}

export interface PasscodeAsk {
  /** Resolves true when the desk is unlocked (already, or by the dialog), false when it is closed. */
  ask: (reason: string) => Promise<boolean>;
  node: ReactNode;
}

export function usePasscodeAsk(): PasscodeAsk {
  const [open, setOpen] = useState<{ mode: Mode; reason: string } | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const ask = useCallback(async (reason: string): Promise<boolean> => {
    let mode: ReturnType<typeof askMode>;
    try {
      mode = askMode(await bridge.passcodeStatus());
    } catch {
      return false;
    }
    if (mode === "open") return true;
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpen({ mode, reason });
    });
  }, []);
  const finish = (ok: boolean) => {
    setOpen(null);
    resolver.current?.(ok);
    resolver.current = null;
  };
  return { ask, node: open ? <PasscodeDialog mode={open.mode} reason={open.reason} done={finish} /> : null };
}
