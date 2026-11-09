#!/usr/bin/env bash
# Install Cobra's desk (cobra-desktop) on this Omarchy computer. Re-run
# after any change; every step is safe to repeat.
#
#   apps/desk/scripts/install-omarchy.sh [--no-build | --binary <path>]
#   apps/desk/scripts/install-omarchy.sh --uninstall
#   apps/desk/scripts/install-omarchy.sh --binary <path> --no-omarchy
#
# From a checkout it builds the release binary (`npm run tauri build --
# --no-bundle`). With a binary built elsewhere, pass --binary <path> (no node,
# no cargo needed). It puts these in place, touching nothing else of yours:
#
#   ~/.local/bin/cobra-desktop                         the app
#   ~/.local/bin/cobra-launch                          opens a terminal on a session's tmux
#   ~/.local/share/applications/cobra-desktop.desktop  the launcher entry (+ its icon)
#   ~/.config/systemd/user/cobra-desktop.service       enabled and (re)started: `cobra-desktop --hidden`
#   ~/.config/hypr/cobra.lua                           window rules and the SUPER+P bind,
#                                                      loaded by one line added to ~/.config/hypr/hyprland.lua
#   ~/.config/omarchy/plugins/cobra.desk/              the bar's mark and count, in the bar's right
#                                                      section in ~/.config/omarchy/shell.json
#
# --binary <path> takes a file copied from elsewhere as it is: one that lost
# its execute bit on the way is installed 0755 all the same. The agent
# package's install.sh passes the release's AppImage here; installed as
# ~/.local/bin/cobra-desktop it keeps its window class and updates itself.
#
# --no-omarchy (a Linux desktop that is not Omarchy): the app, the launcher
# entry and the service only; no Hyprland file and no bar.
#
# --uninstall undoes everything above and leaves the app's own folder
# (~/.config/app.cobra.desktop: computers.json with the agent's desk key) so a
# reinstall finds the agent.
#
# Every file it edits (hyprland.lua, shell.json) is backed up beside itself
# first, as <name>.bak.cobra-<time>.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
app="$here/app"
src="$here/omarchy"

config="${XDG_CONFIG_HOME:-$HOME/.config}"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
cache="${XDG_CACHE_HOME:-$HOME/.cache}"
bin="$HOME/.local/bin"
units="$config/systemd/user"
hypr="$config/hypr"
plugins="$config/omarchy/plugins"
shell_json="$config/omarchy/shell.json"
apps="$data/applications"
icons="$data/icons/hicolor/128x128/apps"
omarchy_path="${OMARCHY_PATH:-/usr/share/omarchy}"

unit=cobra-desktop.service
plugin_id=cobra.desk
require_line='require("hypr.cobra")'
require_note='-- Cobra desktop (apps/desk/scripts/install-omarchy.sh): window rules and SUPER+P.'

uninstall=0
omarchy=1
build=1
binary=""
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) uninstall=1 ;;
    --no-build) build=0 ;;
    --no-omarchy) omarchy=0 ;;
    --binary) build=0; binary="${2:?--binary needs a path}"; shift ;;
    -h|--help) awk 'NR > 1 && !/^#/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install-omarchy: unknown option $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf 'install-omarchy: %s\n' "$*"; }
die() { printf 'install-omarchy: %s\n' "$*" >&2; exit 1; }
backup() { [ -f "$1" ] && cp -p "$1" "$1.bak.cobra-$(date +%s)" && say "backed up $1"; return 0; }
have() { command -v "$1" >/dev/null 2>&1; }
rm_said() { [ -e "$1" ] || [ -L "$1" ] || return 0; rm -rf -- "$1"; say "removed $1"; }

# Over SSH there is no HYPRLAND_INSTANCE_SIGNATURE; the one running instance is found by its folder.
if [ -z "${HYPRLAND_INSTANCE_SIGNATURE:-}" ] && [ -d "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/hypr" ]; then
  mapfile -t found < <(ls -1 "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/hypr" 2>/dev/null)
  [ "${#found[@]}" = 1 ] && export HYPRLAND_INSTANCE_SIGNATURE="${found[0]}"
fi
hypr_live() { [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ] && have hyprctl; }

# Hyprland re-reads its config on save; after an edit of ours, make it say so.
hypr_reload() {
  hypr_live || { say "Hyprland not reachable from here; it reloads by itself when its files change"; return 0; }
  hyprctl reload >/dev/null 2>&1 || true
  local errors
  errors="$(hyprctl configerrors 2>/dev/null || true)"
  if [ -n "$errors" ] && [ "$errors" != "no errors" ]; then
    say "Hyprland reports config errors (hyprctl configerrors):"
    printf '%s\n' "$errors"
  else
    say "Hyprland reloaded, no config errors"
  fi
}

in_bar() { [ -f "$shell_json" ] && have jq && jq -e --arg id "$1" '[.bar.layout[]?[]? | select(.id == $id)] | length > 0' "$shell_json" >/dev/null 2>&1; }

remove_from_bar() {
  in_bar "$1" || return 0
  backup "$shell_json"
  local tmp
  tmp="$(mktemp "$shell_json.XXXXXX")"
  jq --arg id "$1" '.bar.layout |= with_entries(.value |= map(select(.id != $id)))' "$shell_json" > "$tmp" && mv "$tmp" "$shell_json"
  say "removed $1 from the bar in $shell_json"
}

# Remove a require line (and the comment line an installer wrote above it) from hyprland.lua.
remove_require() {
  local line="$1" note="$2"
  [ -f "$hypr/hyprland.lua" ] && grep -qF "$line" "$hypr/hyprland.lua" || return 0
  backup "$hypr/hyprland.lua"
  local tmp
  tmp="$(mktemp "$hypr/hyprland.lua.XXXXXX")"
  grep -vF -e "$line" -e "$note" "$hypr/hyprland.lua" > "$tmp" || true
  mv "$tmp" "$hypr/hyprland.lua"
  say "removed $line from $hypr/hyprland.lua"
}

# -- uninstall ----------------------------------------------------------------------------------------

if [ "$uninstall" = 1 ]; then
  if systemctl --user cat "$unit" >/dev/null 2>&1; then
    systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
    say "stopped and disabled $unit"
  fi
  if [ -f "$units/$unit" ]; then rm -f "$units/$unit"; systemctl --user daemon-reload; say "removed $units/$unit"; fi
  for f in "$bin/cobra-desktop" "$bin/cobra-launch" "$apps/cobra-desktop.desktop" "$icons/cobra-desktop.png"; do
    rm_said "$f"
  done
  have update-desktop-database && update-desktop-database "$apps" >/dev/null 2>&1 || true
  rm_said "$plugins/$plugin_id"
  remove_from_bar "$plugin_id"
  remove_require "$require_line" "$require_note"
  rm_said "$hypr/cobra.lua"
  hypr_reload
  rm_said "$cache/cobra-desktop"
  say "done. Kept: $config/app.cobra.desktop (the agent and its desk key); remove it yourself to forget them."
  exit 0
fi

# -- install -------------------------------------------------------------------------------------------

[ "$omarchy" = 0 ] || have jq || die "jq is needed to edit $shell_json (omarchy pkg add jq)"
have systemctl || die "systemd --user is needed"

if [ "$build" = 1 ]; then
  [ -d "$app/node_modules/@tauri-apps" ] || (cd "$app" && say "installing npm packages (npm ci)" && npm ci --no-audit --no-fund >/dev/null)
  say "building the release binary (a few minutes the first time)"
  (cd "$app" && npm run tauri build -- --no-bundle)
  binary="$app/src-tauri/target/release/cobra-desktop"
elif [ -z "$binary" ]; then
  binary="$app/src-tauri/target/release/cobra-desktop"
fi
# A binary copied here (scp, a USB stick) often arrives without its execute
# bit; `install -m755` below gives the installed copy one either way, so only
# a missing file is refused.
if [ ! -e "$binary" ]; then
  die "no binary at $binary (build it, or pass --binary <path>)"
elif [ ! -f "$binary" ]; then
  die "$binary is not a file (pass --binary <path> to the cobra-desktop binary itself)"
elif [ ! -x "$binary" ]; then
  say "$binary is not executable (copied without its execute bit?); it is installed 0755 all the same"
fi
for f in "$src/bin/cobra-launch" "$src/systemd/$unit" "$src/hypr/cobra.lua" "$src/bar/manifest.json" "$app/src-tauri/icons/128x128.png"; do
  [ -f "$f" ] || die "missing $f: copy the whole apps/desk folder (only node_modules and target can stay behind)"
done

# The desktop is a binary of its own: a dev instance running from the checkout
# would take the second launch's words and exit, and systemd would see a
# unit that quit at once.
if pgrep -x cobra-desktop >/dev/null 2>&1 && ! systemctl --user is-active -q "$unit" 2>/dev/null; then
  say "note: a cobra-desktop is already running (a dev instance?). The service start below will only reach it; quit it, then: systemctl --user restart $unit"
fi

install -Dm755 "$binary" "$bin/cobra-desktop" && say "installed $bin/cobra-desktop"
install -Dm755 "$src/bin/cobra-launch" "$bin/cobra-launch" && say "installed $bin/cobra-launch"
install -Dm644 "$src/applications/cobra-desktop.desktop" "$apps/cobra-desktop.desktop" && say "installed $apps/cobra-desktop.desktop"
install -Dm644 "$app/src-tauri/icons/128x128.png" "$icons/cobra-desktop.png" && say "installed $icons/cobra-desktop.png"
have update-desktop-database && update-desktop-database "$apps" >/dev/null 2>&1 || true

install -Dm644 "$src/systemd/$unit" "$units/$unit" && say "installed $units/$unit"
systemctl --user daemon-reload
systemctl --user enable "$unit" >/dev/null 2>&1 && say "enabled $unit"

if [ "$omarchy" = 1 ]; then
# Hyprland: the rules and the bind in a file of their own, loaded after the
# user's files so it has the last word on SUPER+P.
install -Dm644 "$src/hypr/cobra.lua" "$hypr/cobra.lua" && say "installed $hypr/cobra.lua"
if [ -f "$hypr/hyprland.lua" ]; then
  if grep -qF "$require_line" "$hypr/hyprland.lua"; then
    say "$hypr/hyprland.lua already loads hypr.cobra"
  else
    backup "$hypr/hyprland.lua"
    printf '\n%s\n%s\n' "$require_note" "$require_line" >> "$hypr/hyprland.lua"
    say "added $require_line to $hypr/hyprland.lua"
  fi
else
  say "warning: no $hypr/hyprland.lua; add $require_line to your Hyprland config yourself"
fi

# The bar: the plugin folder, then the layout. Omarchy's shell hot-reloads
# both on save.
for f in BarWidget.qml mark.svg manifest.json; do
  install -Dm644 "$src/bar/$f" "$plugins/$plugin_id/$f"
done
say "installed $plugins/$plugin_id"
if [ ! -f "$shell_json" ]; then
  install -Dm644 "$omarchy_path/config/omarchy/shell.json" "$shell_json" && say "made $shell_json from Omarchy's default"
fi
if ! in_bar "$plugin_id"; then
  backup "$shell_json"
  tmp="$(mktemp "$shell_json.XXXXXX")"
  # After the tray on the right, or first on the right when there is no tray.
  jq --arg id "$plugin_id" '
    .bar.layout.right //= [] |
    (.bar.layout.right | map(.id == "omarchy.tray") | index(true)) as $i |
    .bar.layout.right |= (if $i == null then [{id: $id}] + . else .[:$i+1] + [{id: $id}] + .[$i+1:] end)' "$shell_json" > "$tmp"
  mv "$tmp" "$shell_json"
  say "added $plugin_id to the bar's right section in $shell_json"
else
  say "$shell_json already shows $plugin_id"
fi
have omarchy-shell && omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true

hypr_reload
fi

systemctl --user restart "$unit"
sleep 2
if systemctl --user is-active -q "$unit"; then
  say "$unit running (pid $(systemctl --user show -p MainPID --value "$unit"))"
else
  say "$unit is not running: journalctl --user -u cobra-desktop -n 50" >&2
  exit 1
fi

if [ "$omarchy" = 1 ]; then
  say "done. SUPER+P finds a session; the mark in the bar opens Cobra (right-click: the picker)."
else
  say "done. Cobra is in your app launcher."
fi
if [ -s "$config/app.cobra.desktop/computers.json" ]; then
  say "the agent: $config/app.cobra.desktop/computers.json"
else
  say "Next: open Cobra (cobra-desktop) and press Link the agent."
fi
