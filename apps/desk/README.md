# Desk

Cobra's desktop app for **Linux** (Omarchy first) and **macOS**: a Tauri 2
app over the Cobra agent running on the same computer. It talks only to that
agent, on loopback (`http://127.0.0.1:8787`). There is no cloud relay, no
sign-in, no phone and no second computer.

What it shows: Home (the lead's conversation, the morning brief, what needs
you, today), Org, Projects, All money, Notebook and Settings; one popup that
lists what is waiting on you, with Allow and Deny on each item; a session
picker (SUPER+P on Omarchy); the box, to message the lead from anywhere
(SUPER+SHIFT+J); and a tray icon or, on Omarchy, a count in the bar.

The agent sends the desktop notifications for needs-you items and alerts
itself; the desk shows them in its popup and its sidebar.

## Layout

- `app/` — the Tauri app. `src/` is the React/TypeScript web side; it imports
  `packages/contracts` by relative path. `src-tauri/` is the Rust side, which
  holds the agent's desk key and makes every request to the agent.
- `omarchy/` — the Hyprland rules (`hypr/cobra.lua`), the systemd user unit
  (`cobra-desktop.service`), the `.desktop` entry, the bar plugin
  (`cobra.desk`) and `cobra-launch`, which opens a terminal on a session's
  tmux (socket `cobra`).
- `scripts/install-omarchy.sh` — builds and installs all of that.

It is outside the pnpm workspace and keeps its own npm lockfile
(`app/package-lock.json`).

## Linking the agent

Settings → This computer → **Link the agent** runs `cobra-agent desk --name
<this computer>`, which mints a desk key and prints one line
(`{"machine","label","loopback","tmuxSocket","id","key"}`). The desk keeps it in
`computers.json` in its config folder (`app.cobra.desktop`), mode 0600. The
key rotates by itself through `/keys/rotate` before it expires (the agent says
when, in `x-cobra-key-expires`). **Unlink** forgets it.

## Identity

| What | Name |
| --- | --- |
| Bundle id (config, data and webview folders) | `app.cobra.desktop` |
| `productName` | Cobra |
| Binary, Cargo package, window class | `cobra-desktop` |
| systemd user unit | `cobra-desktop.service` |
| Hyprland file | `~/.config/hypr/cobra.lua` |
| Bar plugin id | `cobra.desk` |
| Bar state | `~/.cache/cobra-desktop/state.json` |

`APP_NAME` (`app/src/lib/appName.ts`, `app/src-tauri/src/lib.rs`) is the name
people read; `LEAD_NAME` is the assistant's name in the UI.

## Develop

```sh
cd app
npm ci
npm run typecheck
npm test                      # vitest
npm run tauri dev
(cd src-tauri && cargo test)
```

## Install

On Omarchy: `scripts/install-omarchy.sh` (`--uninstall` to remove;
`--binary <path>` to install a binary built elsewhere). On macOS:
`cd app && npm run tauri build`, which makes a `.app` and a `.dmg`.
