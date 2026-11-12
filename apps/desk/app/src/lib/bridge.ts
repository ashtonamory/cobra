/**
 * The Rust side (src-tauri/src/lib.rs), one typed function per command. The
 * only file that calls `invoke`, so a page reads as intent.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Machine } from "./config.ts";
import type { Json } from "./json.ts";
import type { PasscodeStatus } from "./passcode.ts";

export interface HostState {
  os: string;
  hostname: string;
  agentInstalled: boolean;
  /** Where the agent's CLI was looked for, or found. */
  agentPath: string;
  /** The port its agent.env names (8787 when it does not). */
  agentPort: number;
  /** The tmux socket its agent.env names. */
  tmuxSocket: string;
  /** Linux: whether `cobra-agent.service` is active. Null elsewhere. */
  agentService: boolean | null;
  agentAnswering: boolean;
}

export const bridge = {
  computers: () => invoke<Machine[]>("computers"),
  api: (machine: string, method: string, path: string, body?: Json, timeoutMs?: number) =>
    invoke<Json>("api", { machine, method, path, body: body ?? null, timeoutMs: timeoutMs ?? null }),
  /** `api` for a write that is the person's alone: the Rust side passes it only while the passcode is unlocked (passcode.rs). */
  apiOwner: (machine: string, method: string, path: string, body?: Json, timeoutMs?: number) =>
    invoke<Json>("api_owner", { machine, method, path, body: body ?? null, timeoutMs: timeoutMs ?? null }),
  passcodeStatus: () => invoke<PasscodeStatus>("passcode_status"),
  passcodeSet: (next: string, current?: string) => invoke<void>("passcode_set", { new: next, old: current ?? null }),
  passcodeUnlock: (code: string) => invoke<void>("passcode_unlock", { code }),
  passcodeLock: () => invoke<void>("passcode_lock"),
  passcodeClear: (code: string) => invoke<void>("passcode_clear", { code }),
  apiUpload: (machine: string, path: string, file: string) => invoke<Json>("api_upload", { machine, path, file }),
  /** A design shown in the Lead's thread, as a `data:` URL. */
  designImage: (machine: string, path: string) => invoke<string>("design_image", { machine, path }),
  /** That design saved into Pictures/Cobra; where it went. */
  designSave: (machine: string, path: string, name: string) => invoke<string>("design_save", { machine, path, name }),
  pins: () => invoke<string[]>("pins"),
  togglePin: (key: string) => invoke<boolean>("toggle_pin", { key }),
  settings: () => invoke<Record<string, Json>>("settings"),
  setSetting: (key: string, value: Json) => invoke<void>("set_setting", { key, value }),
  deskName: () => invoke<string>("desk_name"),
  /** Asks the agent what it goes by (/health) and keeps a new name; 1 when it changed. */
  learnNames: () => invoke<number>("learn_names"),
  /** A desk key from this computer's agent (`cobra-agent desk`), kept in computers.json. */
  linkAgent: () => invoke<string>("link_agent"),
  /** Revokes this desktop's key on the agent and forgets it here. */
  unlinkAgent: () => invoke<string>("unlink_agent"),
  hostState: () => invoke<HostState>("host_state"),
  showMain: (page?: string) => invoke<void>("show_main", { page: page ?? null }),
  togglePicker: () => invoke<void>("toggle_picker"),
  popupLayout: (height: number) => invoke<void>("popup_layout", { height }),
  setTray: (needs: number, working: number, alerts: number) => invoke<void>("set_tray", { needs, working, alerts }),
  quit: () => invoke<void>("quit"),
};
