#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Install or update the Cobra agent for the current user.
#
#   ./install.sh                      # ports 8787 (agent) and 8789 (model gateway), or the next free pair
#   ./install.sh --agent-port 8797    # the model gateway is the agent's port + 2
#   ./install.sh --name laptop        # the short name for this computer's wip/ branches
#   ./install.sh --no-git-sync        # no fetch and fast-forward timer (another agent has it)
#   ./install.sh --git-sync           # git sync back on (undoes a kept --no-git-sync)
#   ./install.sh --widget-engine      # removes the old life-sync engine link (life sync has ended)
#   ./install.sh --claude-hooks       # Claude Code tells the agent its state (~/.claude/settings.json)
#   ./install.sh --claude-skills      # Claude Code gets the ste-deep skill (~/.claude/skills)
#   ./install.sh --codex-notify       # Codex tells the agent when a turn finishes (~/.codex/config.toml)
#   ./install.sh --orchestrator-engine codex  # run the Lead and Foremen on Codex (claude to switch back)
#   ./install.sh --ollama-url http://127.0.0.1:11500  # where Ollama is, if not its default port (default: back to it)
#   ./install.sh --ollama-url http://gpu-box:11434 --allow-remote-ollama  # an Ollama off this computer, on purpose
#   ./install.sh --no-remote-ollama   # an Ollama off this computer is refused again (the default)
#   ./install.sh --tmux-socket default  # sessions on your own tmux server, not the agent's (-L cobra)
#   ./install.sh --tmux-socket cobra   # sessions back on the agent's own tmux server
#   ./install.sh --no-contain         # Workers in Claude Code's sandbox only, not Cobra's (contain.ts)
#   ./install.sh --contain            # Workers in Cobra's sandbox (the default where bubblewrap, or sandbox-exec on macOS, works)
#   ./install.sh --contain require    # the same, and nothing of the workforce starts while the sandbox does not work
#   ./install.sh --reset-config       # forget agent.env's settings: built-in defaults, then flags
#   ./install.sh --print-config       # print the settings this run would use, and change nothing
#   ./install.sh --print-env          # print the agent.env this run would write, and change nothing
#   ./install.sh --no-systemd         # lay out files only (tests, other inits); --no-services is the same
#   ./install.sh --no-desk            # the agent only, not the desk app (a computer with no screen)
#
# The desk app (Linux): a package that carries it (desk/cobra-desktop.AppImage,
# the release's) installs it too, linked to this agent: ~/.local/bin/cobra-desktop,
# the launcher entry and its user service, and on Omarchy the Hyprland rules
# and the bar widget (apps/desk/scripts/install-omarchy.sh). It updates itself
# after that (Settings → This app → Updates).
#
# An update keeps this computer's settings. The ports, the name, git sync,
# the tmux socket and contain are read back from agent.env (as data,
# never sourced) and stay as they are; a flag given now changes only its own
# setting. Any other COBRA_* line there (COBRA_AGENT_BIND, COBRA_EA=off...)
# is kept as it is, when its value is plain enough to be sourced safely.
# (--memory-repo and --no-memory-repo are still accepted, and ignored: memory
# stays on each computer, and a saved COBRA_MEMORY_REPO line is dropped.
# --term-port is the same: Cobra serves no terminal now, and a saved
# COBRA_TERM_PORT line is dropped.)
#
# Ports: with no --agent-port and none saved, the first install looks before
# it chooses. The agent and the model gateway (the agent's port + 2) need two
# loopback ports. When 8787 or 8789 is taken by anything but this install's
# own agent, it takes the next free pair (8797 and 8799, ...). It says what it
# chose and why.
#
# Everything listens on loopback only: Cobra is reached from this computer
# alone, by the desk app.
#
# Claude Code is pinned: agent.env's PATH names the version folder `claude`
# resolves to now (mise's 2.1.296, never its `latest` link), so a Claude Code
# update changes nothing under Workers until this script runs again. To move
# Workers to a new Claude Code: install it (`mise up claude`), then run the
# package's install.sh again.
#
# Runs from the unpacked package. Needs no root: the agent runs as you, from
# your own folders, as systemd user units on Linux and launchd user agents on
# macOS (launchd/*.plist, in ~/Library/LaunchAgents). On Linux the only root
# step is enabling linger once, so the agent starts at boot without a login;
# the script tells you the exact command when it is missing and never runs
# sudo itself. On macOS the agent starts when you log in.
#
# macOS ships bash 3.2, which this script cannot run on: it starts itself
# again with Homebrew's bash (brew install bash) when that is there.
#
# An update installs the new version beside the old one and moves a
# `current` link, so a failed update is one `ln` away from the last version.
# The agent is restarted, never stopped: a stop ends every tmux session on
# the machine (see systemd/cobra-agent.service).
#
# Cobra once ran a second service, cobra-term (a terminal in a web page). An
# update takes it out: see retire_term below for why that is done with care.
# ---------------------------------------------------------------------------
set -euo pipefail

if ((BASH_VERSINFO[0] < 4)); then
  for newer in /opt/homebrew/bin/bash /usr/local/bin/bash; do
    [[ -x $newer ]] && exec "$newer" "$0" "$@"
  done
  echo "This installer needs bash 4 or later. On a Mac: brew install bash, then run it again." >&2
  exit 1
fi

OS=$(uname -s)
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$*"; }
todo() { printf '    \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '    \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/cobra-agent"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/cobra-agent"
if [[ $OS == Darwin ]]; then
  UNIT_DIR="$HOME/Library/LaunchAgents"
else
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
fi

# Flags first, into ARG_*: empty means not given.
ARG_AGENT_PORT=
ARG_MACHINE_NAME=
ARG_GIT_SYNC=
ARG_TMUX_SOCKET=
ARG_CONTAIN=
ARG_ORCHESTRATOR_ENGINE=
ARG_OLLAMA_URL=
ARG_OLLAMA_REMOTE=
WIDGET_ENGINE=0
CLAUDE_HOOKS=0
CLAUDE_SKILLS=0
CODEX_NOTIFY=0
SYSTEMD=1
DESK=1
RESET_CONFIG=0
PRINT_CONFIG=0
PRINT_ENV=0

while (($#)); do
  case "$1" in
    --agent-port) ARG_AGENT_PORT=${2:?--agent-port needs a value}; shift 2 ;;
    # Gone: Cobra serves no terminal. Accepted, so older command lines still run.
    --term-port) echo "note: --term-port is ignored; Cobra serves no terminal now" >&2; shift; if [[ $# -gt 0 && $1 != --* ]]; then shift; fi ;;
    --name) ARG_MACHINE_NAME=${2:?--name needs a value}; shift 2 ;;
    --no-git-sync) ARG_GIT_SYNC=0; shift ;;
    --git-sync) ARG_GIT_SYNC=1; shift ;;
    --widget-engine) WIDGET_ENGINE=1; shift ;;
    --claude-hooks) CLAUDE_HOOKS=1; shift ;;
    --claude-skills) CLAUDE_SKILLS=1; shift ;;
    --codex-notify) CODEX_NOTIFY=1; shift ;;
    --orchestrator-engine) ARG_ORCHESTRATOR_ENGINE=${2:?--orchestrator-engine needs claude or codex}; shift 2 ;;
    # Gone: memory stays on each computer. Accepted, so older command lines still run.
    --memory-repo) echo "note: --memory-repo is ignored; memory stays on each computer now" >&2; shift; if [[ $# -gt 0 && $1 != --* ]]; then shift; fi ;;
    --no-memory-repo) echo "note: --no-memory-repo is ignored; memory stays on each computer now" >&2; shift ;;
    --tmux-socket) ARG_TMUX_SOCKET=${2:?--tmux-socket needs a name, or default}; shift 2 ;;
    --ollama-url) ARG_OLLAMA_URL=${2:?--ollama-url needs a URL, or default}; shift 2 ;;
    --allow-remote-ollama) ARG_OLLAMA_REMOTE=1; shift ;;
    --no-remote-ollama) ARG_OLLAMA_REMOTE=0; shift ;;
    # --contain require: nothing starts out of Cobra's sandbox. --contain on is --contain.
    --contain)
      case ${2:-} in
        require) ARG_CONTAIN=2; shift 2 ;;
        on) ARG_CONTAIN=1; shift 2 ;;
        *) ARG_CONTAIN=1; shift ;;
      esac ;;
    --no-contain) ARG_CONTAIN=0; shift ;;
    --reset-config) RESET_CONFIG=1; shift ;;
    --print-config) PRINT_CONFIG=1; shift ;;
    --print-env) PRINT_ENV=1; shift ;;
    --no-systemd | --no-services) SYSTEMD=0; shift ;;
    --no-desk) DESK=0; shift ;;
    -h | --help) sed -n '2,/^# ---/p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# This computer's saved settings. agent.env is read line by line as data and
# never sourced: the keys below are settings, any other COBRA_* key is kept
# as it is (EXTRA), and anything else in it is skipped. An update with one
# flag once rewrote it from the built-in defaults and moved a computer off its
# ports and its own tmux server; another dropped COBRA_CONTAIN=on, and
# Workers left Cobra's sandbox without a word.
declare -A SAVED=()
declare -A EXTRA=()
EXTRA_KEYS=()
DROPPED=()
SETTING_KEY='^(COBRA_AGENT_PORT|COBRA_MACHINE_NAME|COBRA_GIT_SYNC|COBRA_TMUX_SOCKET|COBRA_CONTAIN|COBRA_ORCHESTRATOR_ENGINE)$'
MEMORY_REPO_DROPPED=0
TERM_PORT_DROPPED=0
# A first install (no agent.env yet) ends with the Workers' Claude token as a next step.
FIRST_INSTALL=1
[[ -f $CONFIG/agent.env ]] && FIRST_INSTALL=0
if ((!RESET_CONFIG)) && [[ -f $CONFIG/agent.env ]]; then
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(COBRA_[A-Z0-9_]+)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    value=${value#"${value%%[![:space:]]*}"}
    value=${value%"${value##*[![:space:]]}"}
    [[ $value =~ ^\"(.*)\"$ || $value =~ ^\'(.*)\'$ ]] && value=${BASH_REMATCH[1]}
    if [[ $key =~ $SETTING_KEY ]]; then
      SAVED[$key]=$value
    elif [[ $key == COBRA_CLAUDE_VERSION || $key == COBRA_CODEX_VERSION || $key == COBRA_PI_BIN || $key == COBRA_PI_VERSION ]]; then
      : # Written fresh below, from the harnesses this run pins.
    elif [[ $key == COBRA_TERM_PORT ]]; then
      TERM_PORT_DROPPED=1 # Nothing reads it since Cobra stopped serving a terminal.
    elif [[ $key == COBRA_MEMORY_REPO ]]; then
      MEMORY_REPO_DROPPED=1 # Nothing reads it since memory moved onto each computer.
    elif [[ $value =~ ^[A-Za-z0-9._:/@%+,-]*$ ]]; then
      # The cobra-agent command sources agent.env, so only a plain value is kept.
      [[ -n ${EXTRA[$key]+x} ]] || EXTRA_KEYS+=("$key")
      EXTRA[$key]=$value
    else
      DROPPED+=("$key")
    fi
  done < "$CONFIG/agent.env"
fi

# Codex is pinned the same way as Claude Code. Its mise layout has a `bin`
# folder beneath the version, so keep that folder on the service PATH too.
CODEX_BIN=$(command -v codex || true)
CODEX_REAL=
CODEX_PIN=
CODEX_VERSION=
if [[ -n $CODEX_BIN ]]; then
  CODEX_REAL=$(readlink -f "$CODEX_BIN" || true)
  if [[ ${CODEX_REAL##*/} == mise ]] && command -v mise >/dev/null; then
    CODEX_REAL=$(readlink -f "$(mise which codex 2>/dev/null || true)" || true)
  fi
  codex_dir=$(dirname "$CODEX_REAL")
  version_re='^[0-9]+\.[0-9]+\.[0-9]+$'
  if [[ ${CODEX_REAL##*/} == codex && ${codex_dir##*/} == bin && $(basename "$(dirname "$codex_dir")") =~ $version_re ]]; then
    CODEX_PIN=$codex_dir
    CODEX_VERSION=$(basename "$(dirname "$codex_dir")")
  elif [[ ${CODEX_REAL##*/} == codex && ${codex_dir##*/} =~ $version_re ]]; then
    CODEX_PIN=$codex_dir
    CODEX_VERSION=${codex_dir##*/}
  fi
fi

# Each setting: the flag if given, else agent.env's value, else the default.
KEPT=()
setting() { # setting <var> <flag value> <agent.env key> <label> <default>
  if [[ -n $2 ]]; then
    printf -v "$1" '%s' "$2"
  elif [[ -n ${SAVED[$3]+x} ]]; then
    printf -v "$1" '%s' "${SAVED[$3]}"
    KEPT+=("$4")
  else
    printf -v "$1" '%s' "$5"
  fi
}
setting AGENT_PORT "$ARG_AGENT_PORT" COBRA_AGENT_PORT "agent port" 8787
setting MACHINE_NAME "$ARG_MACHINE_NAME" COBRA_MACHINE_NAME "name" ""
setting TMUX_SOCKET "$ARG_TMUX_SOCKET" COBRA_TMUX_SOCKET "tmux socket" cobra
# The switch means what the agent reads it as: git sync is on unless "off".
if [[ -n ${SAVED[COBRA_GIT_SYNC]+x} ]]; then
  [[ ${SAVED[COBRA_GIT_SYNC]} == off ]] && SAVED[COBRA_GIT_SYNC]=0 || SAVED[COBRA_GIT_SYNC]=1
fi
setting GIT_SYNC "$ARG_GIT_SYNC" COBRA_GIT_SYNC "git sync" 1
setting ORCHESTRATOR_ENGINE "$ARG_ORCHESTRATOR_ENGINE" COBRA_ORCHESTRATOR_ENGINE "orchestrator engine" "claude"

# Contain (contain.ts): Workers and jobs in Cobra's own sandbox. The agent
# reads "on" and "require" as on (CONTAIN 1 and 2 here); with require nothing
# of the workforce starts while bubblewrap does not work. With no flag and
# nothing saved it is on wherever bubblewrap can make the namespaces it needs
# (the agent's own probe, containAvailable, hardening included), and left
# unwritten where it cannot, so a later install turns it on once bubblewrap
# works. Off is written, so it is kept. On macOS the sandbox is sandbox-exec
# (seatbelt.ts), which every Mac has; the agent probes the full profile.
bwrap_works() {
  if [[ $OS == Darwin ]]; then
    /usr/bin/sandbox-exec -p '(version 1)(deny default)(allow process-exec)(allow process-fork)(allow file-read*)(allow sysctl-read)(allow mach-lookup)' /usr/bin/true >/dev/null 2>&1
    return
  fi
  command -v bwrap >/dev/null && bwrap --ro-bind / / --unshare-all --unshare-user --disable-userns --cap-drop ALL --new-session --die-with-parent -- true >/dev/null 2>&1
}
SANDBOX_TOOL=bubblewrap
[[ $OS == Darwin ]] && SANDBOX_TOOL=sandbox-exec
if [[ -n ${SAVED[COBRA_CONTAIN]+x} ]]; then
  case ${SAVED[COBRA_CONTAIN]} in
    require) SAVED[COBRA_CONTAIN]=2 ;;
    on) SAVED[COBRA_CONTAIN]=1 ;;
    *) SAVED[COBRA_CONTAIN]=0 ;;
  esac
fi
CONTAIN_DEFAULT=
[[ -n $ARG_CONTAIN || -n ${SAVED[COBRA_CONTAIN]+x} ]] || { bwrap_works && CONTAIN_DEFAULT=1; }
setting CONTAIN "$ARG_CONTAIN" COBRA_CONTAIN "contain" "$CONTAIN_DEFAULT"
if [[ -n $ARG_CONTAIN ]]; then
  CONTAIN_WHY="--$( ((CONTAIN)) || echo no-)contain"
  ((CONTAIN != 2)) || CONTAIN_WHY+=" require"
elif [[ -n ${SAVED[COBRA_CONTAIN]+x} ]]; then
  CONTAIN_WHY="kept from agent.env"
elif [[ -n $CONTAIN_DEFAULT ]]; then
  CONTAIN_WHY="the default: $SANDBOX_TOOL works here"
else
  CONTAIN_WHY="$SANDBOX_TOOL cannot make its sandbox here"
fi

# A kept value is checked like a flag, and the refusal says where it came from.
from() { # from <label> <flag>
  local kept
  for kept in "${KEPT[@]}"; do
    [[ $kept == "$1" ]] && { echo " (kept from $CONFIG/agent.env: pass $2, or --reset-config)"; return; }
  done
}
[[ $TMUX_SOCKET =~ ^[A-Za-z0-9_-]{1,40}$ ]] || fail "--tmux-socket takes letters, digits, - and _ (or default), not \"$TMUX_SOCKET\"$(from "tmux socket" --tmux-socket)"
# agent.env is also sourced by the cobra-agent command: no spaces or quotes.
[[ -z $MACHINE_NAME || $MACHINE_NAME =~ ^[A-Za-z0-9._-]{1,63}$ ]] || fail "--name takes letters, digits, ., - and _, not \"$MACHINE_NAME\"$(from name --name)"
[[ $ORCHESTRATOR_ENGINE == claude || $ORCHESTRATOR_ENGINE == codex ]] || fail "--orchestrator-engine takes claude or codex, not \"$ORCHESTRATOR_ENGINE\"$(from "orchestrator engine" --orchestrator-engine)"
[[ $AGENT_PORT =~ ^[0-9]{1,5}$ ]] && ((10#$AGENT_PORT > 1023 && 10#$AGENT_PORT < 65536)) || fail "Port $AGENT_PORT is not a user port (1024-65535)$(from "agent port" --agent-port)."
AGENT_PORT=$((10#$AGENT_PORT))

# Where Ollama is (the agent's ollama.ts): kept as plain COBRA_* lines, so
# only a flag changes them. One off this computer also needs
# --allow-remote-ollama, or the agent refuses it.
extra_set() { [[ -n ${EXTRA[$1]+x} ]] || EXTRA_KEYS+=("$1"); EXTRA[$1]=$2; }
extra_unset() { unset "EXTRA[$1]"; }
if [[ $ARG_OLLAMA_URL == default ]]; then
  extra_unset COBRA_OLLAMA_URL
elif [[ -n $ARG_OLLAMA_URL ]]; then
  [[ $ARG_OLLAMA_URL =~ ^https?://[A-Za-z0-9.:_-]+(/[A-Za-z0-9._/-]*)?$ ]] || fail "--ollama-url takes http(s)://host[:port], with no credentials, not \"$ARG_OLLAMA_URL\""
  extra_set COBRA_OLLAMA_URL "${ARG_OLLAMA_URL%/}"
fi
case $ARG_OLLAMA_REMOTE in
  1) extra_set COBRA_OLLAMA_REMOTE on ;;
  0) extra_unset COBRA_OLLAMA_REMOTE ;;
esac
SET_EXTRA=()
for key in "${EXTRA_KEYS[@]}"; do [[ -z ${EXTRA[$key]+x} ]] || SET_EXTRA+=("$key"); done
EXTRA_KEYS=("${SET_EXTRA[@]}")

# Who listens on a loopback port now, as ss says it (empty: nobody), and
# whether that is this install's own agent (an update, or a
# re-run with --reset-config): its command line runs from $PREFIX.
# macOS has no ss: lsof's listener, written as ss writes it (users:(("name",pid=N))).
port_owner() {
  if [[ $OS == Darwin ]]; then
    local pid= name= field
    while IFS= read -r field; do
      case $field in p*) pid=${field#p} ;; c*) name=${field#c}; break ;; esac
    done < <(lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fpc 2>/dev/null)
    [[ -z $pid ]] || echo "LISTEN users:((\"$name\",pid=$pid))"
  else
    ss -Hltnp "sport = :$1" 2>/dev/null | head -1
  fi
}
command_of() { # command_of <pid>: its command line
  if [[ $OS == Darwin ]]; then ps -o command= -p "$1" 2>/dev/null; else tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null; fi
}
ours() { # ours <ss line>
  local pid command
  [[ $1 =~ pid=([0-9]+) ]] || return 1
  pid=${BASH_REMATCH[1]}
  command=$(command_of "$pid") || return 1
  [[ $command == *"$PREFIX/"* ]]
}
port_tool() { command -v ss >/dev/null || command -v lsof >/dev/null; }
taken_by() { # taken_by <port>: what holds it, or nothing when it is free or ours
  local owner
  owner=$(port_owner "$1")
  [[ -z $owner ]] && return 0
  ours "$owner" && return 0
  [[ $owner =~ users:\(\(\"([^\"]+)\" ]] && { echo "${BASH_REMATCH[1]}"; return 0; }
  echo "another account's program"
}
# The model gateway sits two above the agent (modelGateway.ts), unless COBRA_MODEL_PORT says.
model_port() { echo "${EXTRA[COBRA_MODEL_PORT]:-$(($1 + 2))}"; }

# With no port given and none saved, look before choosing.
PORTS_WHY=
if [[ -z $ARG_AGENT_PORT && -z ${SAVED[COBRA_AGENT_PORT]+x} ]] && port_tool; then
  busy=()
  FIRST_BUSY=
  for base in 8787 8797 8807 8817 8827 8837 8847 8857 8867 8877; do
    busy=()
    for pair in "agent:$base" "model gateway:$(model_port "$base")"; do
      holder=$(taken_by "${pair#*:}")
      [[ -z $holder ]] || busy+=("${pair#*:} ($holder)")
    done
    if ((${#busy[@]} == 0)); then
      if ((base != 8787)); then
        AGENT_PORT=$base
        PORTS_WHY="the usual ports are taken: ${FIRST_BUSY}; using $AGENT_PORT and $(model_port "$AGENT_PORT") instead"
      fi
      break
    fi
    if [[ -z $FIRST_BUSY ]]; then FIRST_BUSY=$(printf '%s, ' "${busy[@]}"); FIRST_BUSY=${FIRST_BUSY%, }; fi
  done
  ((${#busy[@]} == 0)) || PORTS_WHY="8787 to 8879 are all taken; pick a port with --agent-port"
fi
MODEL_PORT=$(model_port "$AGENT_PORT")

if ((PRINT_CONFIG)); then
  printf 'AGENT_PORT=%s\nMODEL_PORT=%s\nMACHINE_NAME=%s\nGIT_SYNC=%s\nTMUX_SOCKET=%s\n' \
    "$AGENT_PORT" "$MODEL_PORT" "$MACHINE_NAME" "$GIT_SYNC" "$TMUX_SOCKET"
  printf 'CONTAIN=%s\n' "$CONTAIN"
  (IFS=,; printf 'KEPT=%s\nEXTRA=%s\nDROPPED=%s\n' "${KEPT[*]}" "${EXTRA_KEYS[*]}" "${DROPPED[*]}")
  printf 'PORTS_WHY=%s\n' "$PORTS_WHY"
  exit 0
fi

# Claude Code, pinned: the folder of the version `claude` resolves to now.
# mise's `latest` (and `2`, `2.1`) are links that move on `mise up`; the
# version folder they point at does not. A mise shim is asked which claude it
# runs. The native installer keeps each version as one file in a folder of
# them all, which no PATH entry can name alone: it is left as it is, and said.
CLAUDE_BIN=$(command -v claude || true)
CLAUDE_REAL=
CLAUDE_PIN=
CLAUDE_VERSION=
if [[ -n $CLAUDE_BIN ]]; then
  CLAUDE_REAL=$(readlink -f "$CLAUDE_BIN" || true)
  if [[ ${CLAUDE_REAL##*/} == mise ]] && command -v mise >/dev/null; then
    CLAUDE_REAL=$(readlink -f "$(mise which claude 2>/dev/null || true)" || true)
  fi
  version_re='^[0-9]+\.[0-9]+\.[0-9]+$'
  claude_dir=$(dirname "$CLAUDE_REAL")
  if [[ ${CLAUDE_REAL##*/} == claude && ${claude_dir##*/} =~ $version_re ]]; then
    CLAUDE_PIN=$claude_dir
    CLAUDE_VERSION=${claude_dir##*/}
  elif [[ ${CLAUDE_REAL##*/} == claude && ${claude_dir##*/} == bin && $(basename "$(dirname "$claude_dir")") =~ $version_re ]]; then
    CLAUDE_PIN=$claude_dir
    CLAUDE_VERSION=$(basename "$(dirname "$claude_dir")")
  elif [[ ${CLAUDE_REAL##*/} =~ $version_re ]]; then
    CLAUDE_VERSION=${CLAUDE_REAL##*/}
  fi
fi

# Pi (pi.dev), the harness for local models:
# pinned by its real file, which the agent runs by path in Cobra's sandbox,
# and the version folder above it (mise's installs/pi/1.2.0/pi/pi). Too old,
# or none: no Pi, and local sessions run on Claude Code.
PI_MIN=1.2.0
PI_BIN=
PI_VERSION=
PI_FOUND=$(command -v pi || true)
if [[ -n $PI_FOUND ]]; then
  PI_REAL=$(readlink -f "$PI_FOUND" || true)
  if [[ ${PI_REAL##*/} == mise ]] && command -v mise >/dev/null; then
    PI_REAL=$(readlink -f "$(mise which pi 2>/dev/null || true)" || true)
  fi
  pi_dir=$(dirname "$PI_REAL")
  for part in "${pi_dir##*/}" "$(basename "$(dirname "$pi_dir")")"; do
    if [[ $part =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then PI_VERSION=$part; break; fi
  done
  if [[ -n $PI_VERSION && -x $PI_REAL && $(printf '%s\n%s\n' "$PI_MIN" "$PI_VERSION" | sort -V | head -1) == "$PI_MIN" ]]; then
    PI_BIN=$PI_REAL
  else
    PI_VERSION=
  fi
fi

# agent.env, for the unit and the `cobra-agent` command (which sources it:
# every value here is plain). Without --name, the hostname names this
# computer's wip/ branches.
agent_env() {
  printf 'COBRA_AGENT_PORT=%s\n' "$AGENT_PORT"
  [[ -z $MACHINE_NAME ]] || printf 'COBRA_MACHINE_NAME=%s\n' "$MACHINE_NAME"
  ((GIT_SYNC)) || printf 'COBRA_GIT_SYNC=off\n'
  [[ $ORCHESTRATOR_ENGINE == claude ]] || printf 'COBRA_ORCHESTRATOR_ENGINE=%s\n' "$ORCHESTRATOR_ENGINE"
  printf 'COBRA_TMUX_SOCKET=%s\n' "$TMUX_SOCKET"
  case $CONTAIN in
    2) printf 'COBRA_CONTAIN=require\n' ;;
    1) printf 'COBRA_CONTAIN=on\n' ;;
    0) printf 'COBRA_CONTAIN=off\n' ;;
  esac
  # What the PATH below pins, for the agent to show beside what it runs.
  [[ -z $CLAUDE_VERSION ]] || printf 'COBRA_CLAUDE_VERSION=%s\n' "$CLAUDE_VERSION"
  [[ -z $CODEX_VERSION ]] || printf 'COBRA_CODEX_VERSION=%s\n' "$CODEX_VERSION"
  [[ -z $PI_BIN ]] || printf 'COBRA_PI_BIN=%s\nCOBRA_PI_VERSION=%s\n' "$PI_BIN" "$PI_VERSION"
  local key
  for key in "${EXTRA_KEYS[@]}"; do printf '%s=%s\n' "$key" "${EXTRA[$key]}"; done
  # The agent's tmux server starts with the service's PATH, so a dispatched
  # `claude` must be on it: the pinned version's folder first, else claude's
  # folder when systemd's PATH lacks it.
  local sys_path=
  if [[ $OS == Darwin ]]; then
    # launchd starts agents with only /usr/bin:/bin:/usr/sbin:/sbin: Homebrew's tmux, git and node are added.
    sys_path=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
  elif ((SYSTEMD)); then
    sys_path=$(systemctl --user show-environment 2>/dev/null | sed -n 's/^PATH=//p' || true)
  fi
  sys_path=${sys_path:-/usr/local/bin:/usr/bin:/bin}
  if [[ -n $CLAUDE_PIN || -n $CODEX_PIN ]]; then
    local rest=":$sys_path:"
    [[ -z $CLAUDE_PIN ]] || rest=${rest//":$CLAUDE_PIN:"/:}
    [[ -z $CODEX_PIN ]] || rest=${rest//":$CODEX_PIN:"/:}
    rest=${rest#:}
    local pins=
    [[ -z $CLAUDE_PIN ]] || pins=$CLAUDE_PIN
    [[ -z $CODEX_PIN ]] || pins=${pins:+$pins:}$CODEX_PIN
    printf 'PATH=%s:%s\n' "$pins" "${rest%:}"
  elif [[ -n $CLAUDE_BIN ]] && ((SYSTEMD)) && [[ ":$sys_path:" != *":$(dirname "$CLAUDE_BIN"):"* ]]; then
    printf 'PATH=%s:%s\n' "$(dirname "$CLAUDE_BIN")" "$sys_path"
  elif [[ $OS == Darwin ]]; then
    printf 'PATH=%s\n' "$sys_path"
  fi
}

if ((PRINT_ENV)); then
  agent_env
  exit 0
fi

VERSION=$(cat "$HERE/VERSION")
BUILD=$(cat "$HERE/BUILD" 2>/dev/null || echo unbuilt)
# One folder per build, not per version: a rebuild must land, and the last
# build stays beside it for a one-`ln` rollback.
RELEASE="$VERSION-$BUILD"

[[ $(id -u) -ne 0 ]] || fail "Run this as your own user, not root. The agent must not run as root."
case "$OS-$(uname -m)" in
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64) TARGET=linux-arm64 ;;
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  *) fail "Unsupported computer: $OS $(uname -m). Cobra runs on Linux and macOS, x86_64 or arm64." ;;
esac
[[ $HERE == *"$TARGET"* ]] || fail "This package is not for this computer; it needs the $TARGET package."

# A port held by something other than our own units is a refusal, not a
# surprise at start: another program may already hold 8787. The
# model gateway's port too: the agent starts without it, and every Cobra
# session's Claude request then fails.
[[ $PORTS_WHY != *"all taken"* ]] || fail "Ports 8787 to 8879 are all in use. Pick a free one with --agent-port (the model gateway takes that port + 2)."
updating=0
if [[ $OS == Darwin ]]; then
  launchctl print "gui/$(id -u)/app.cobra.agent" 2>/dev/null | grep -q "state = running" && updating=1
else
  systemctl --user is-active --quiet cobra-agent 2>/dev/null && updating=1
fi
for port in "$AGENT_PORT" "$MODEL_PORT"; do
  owner=$(port_owner "$port")
  if [[ -n $owner ]] && ((updating == 0)) && ! ours "$owner"; then
    what="Port $port"
    [[ $port == "$MODEL_PORT" ]] && what="Port $port (the model gateway: the agent's port + 2)"
    fail "$what is in use (${owner//$'\n'/ }). Pick another with --agent-port$( ((${#KEPT[@]})) && echo ", or --reset-config")."
  fi
done

say "Installing Cobra agent $VERSION (build $BUILD)"
mkdir -p "$PREFIX"
PREVIOUS=$(readlink "$PREFIX/current" 2>/dev/null || true)
if [[ -d $PREFIX/$RELEASE ]]; then
  ok "build $RELEASE is already unpacked"
else
  rm -rf "$PREFIX/.$RELEASE.tmp"
  cp -a "$HERE" "$PREFIX/.$RELEASE.tmp"
  mv "$PREFIX/.$RELEASE.tmp" "$PREFIX/$RELEASE"
  ok "unpacked to $PREFIX/$RELEASE"
fi
ln -sfn "$RELEASE" "$PREFIX/.current.tmp"
# Over the old link in one step: GNU mv -T, BSD mv -h.
if [[ $OS == Darwin ]]; then mv -fh "$PREFIX/.current.tmp" "$PREFIX/current"; else mv -T "$PREFIX/.current.tmp" "$PREFIX/current"; fi
ok "current → $RELEASE"
# Keep this build and the one before it (a one-`ln` rollback); each carries
# its own Node runtime, so older ones only fill the disk. A Worker in Cobra's
# sandbox (contain.ts) runs its hooks from the build it started on, bound in by
# that build's own folder, so a build any Worker's settings still name stays
# until the Worker is gone (a deleted folder cannot come back into a running
# sandbox; its hooks would stop and every tool call would ask you).
WORKERS="${COBRA_AGENT_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/cobra-agent}/workers"
in_use=$(cat "$WORKERS"/*.settings.json 2>/dev/null | grep -o "$PREFIX/[0-9][^/\"]*" | sed "s|^$PREFIX/||" | sort -u || true)
for dir in "$PREFIX"/[0-9]*; do
  [[ -d $dir ]] || continue
  name=$(basename "$dir")
  [[ $name == "$RELEASE" || $name == "$PREVIOUS" ]] && continue
  if grep -qxF "$name" <<<"$in_use"; then
    ok "kept build $name: a running Worker's hooks use it"
    continue
  fi
  rm -rf "$dir"
  ok "removed old build $name"
done

"$PREFIX/current/bin/node" -e "process.exit(0)" \
  || fail "The bundled Node does not run on this machine. Report it with: uname -a"
ok "bundled Node $("$PREFIX/current/bin/node" --version) runs"

say "Configuration"
umask 077
mkdir -p "$CONFIG"
chmod 700 "$CONFIG"
agent_env > "$CONFIG/agent.env"
rm -f "$CONFIG/ports.env"
ok "agent.env: agent $AGENT_PORT, model gateway $MODEL_PORT${MACHINE_NAME:+, name $MACHINE_NAME}$( ((GIT_SYNC)) || echo ", git sync off"), tmux $( [[ $TMUX_SOCKET == default ]] && echo "on your own server" || echo "-L $TMUX_SOCKET")$(
  if ((${#KEPT[@]})); then kept=$(printf '%s, ' "${KEPT[@]}"); echo " (kept from agent.env: ${kept%, })"
  elif ((RESET_CONFIG)); then echo " (--reset-config: agent.env's old settings not read)"; fi)"
[[ -z $PORTS_WHY ]] || ok "ports: $PORTS_WHY"
if ((${#EXTRA_KEYS[@]})); then extra=$(printf '%s, ' "${EXTRA_KEYS[@]}"); ok "agent.env: kept ${extra%, }"; fi
((MEMORY_REPO_DROPPED == 0)) || ok "agent.env: dropped COBRA_MEMORY_REPO; memory stays on each computer now"
((TERM_PORT_DROPPED == 0)) || ok "agent.env: dropped COBRA_TERM_PORT; Cobra serves no terminal now"
if ((${#DROPPED[@]})); then dropped=$(printf '%s, ' "${DROPPED[@]}"); todo "agent.env: dropped ${dropped%, }: only letters, digits and ._:/@%+,- are kept in a value"; fi
if [[ -n $CLAUDE_PIN ]]; then
  ok "Claude Code pinned at $CLAUDE_VERSION ($CLAUDE_PIN). To move on: mise up claude, then run this install.sh again"
elif [[ -n $CLAUDE_BIN ]]; then
  todo "Claude Code ${CLAUDE_VERSION:+$CLAUDE_VERSION }at $CLAUDE_REAL is not pinned: it is not a version folder of its own (mise's is); it changes when it updates itself"
else
  todo "claude is not on your PATH; Workers and the Lead need Claude Code"
fi
if [[ -n $PI_BIN ]]; then
  ok "Pi pinned at $PI_VERSION ($PI_BIN): local models run on it, in Cobra's sandbox. To move on: mise up pi, then run this install.sh again"
else
  ok "no Pi $PI_MIN or newer on your PATH: local models run on Claude Code (for Pi, the faster harness for them: mise use -g pi, then run this install.sh again)"
fi
# There is no shared token any more: the desk has its own key
# (cobra-agent desk).
if [[ -e $CONFIG/token ]]; then
  rm -f "$CONFIG/token"
  ok "removed the old shared token; the desk has its own key now"
fi
mkdir -p "$HOME/.local/bin"
ln -sfn "$PREFIX/current/bin/cobra-agent" "$HOME/.local/bin/cobra-agent"
ok "cobra-agent command in ~/.local/bin"
# Older packages have no checker; never leave a link to nothing.
if [[ -x "$PREFIX/current/bin/ste-check" ]]; then
  ln -sfn "$PREFIX/current/bin/ste-check" "$HOME/.local/bin/ste-check"
  ok "ste-check command in ~/.local/bin"
fi
[[ ":$PATH:" == *":$HOME/.local/bin:"* ]] || todo "~/.local/bin is not on your PATH; run $HOME/.local/bin/cobra-agent, or add it"

# The terminal service (cobra-term) of an install made before Cobra stopped
# serving a terminal. Taking it out needs care on Linux: when that service
# started the tmux server, the server lives in its cgroup, and tmux ties each
# pane to the service that held the server when the pane was made (the
# pane's tmux-spawn scope is PartOf it). A stop of the service then ends the
# server or those panes: the Lead, the Foremen and the Workers with them.
# So it is stopped only when it holds nothing. When it holds sessions it is
# disabled and its file removed, and it runs on until the next restart of
# this computer; nothing can use it by then, since the agent gives out no
# tickets and the key they were signed with is deleted.
term_holds_sessions() {
  local main cgroup pid scope
  main=$(systemctl --user show -p MainPID --value cobra-term.service 2>/dev/null) || return 0
  cgroup=$(systemctl --user show -p ControlGroup --value cobra-term.service 2>/dev/null) || return 0
  # Not readable: it cannot be shown to hold nothing, so it is left alone.
  [[ -n $cgroup && -r /sys/fs/cgroup$cgroup/cgroup.procs ]] || return 0
  while IFS= read -r pid; do
    [[ $pid == "$main" ]] || return 0
  done < "/sys/fs/cgroup$cgroup/cgroup.procs"
  while IFS= read -r scope; do
    [[ -n $scope ]] || continue
    [[ $(systemctl --user show -p PartOf --value "$scope" 2>/dev/null) != *cobra-term.service* ]] || return 0
  done < <(systemctl --user list-units --type=scope --state=active --no-legend --plain 'tmux-spawn-*' 2>/dev/null | cut -d' ' -f1)
  return 1
}
retire_term() {
  if [[ $OS == Darwin ]]; then
    local plist="$UNIT_DIR/app.cobra.term.plist"
    [[ -e $plist ]] || { rm -f "$CONFIG/ticket.key"; return 0; }
    # bootout stops its node only: tmux and its sessions are left as they are (the plist's AbandonProcessGroup).
    launchctl bootout "gui/$(id -u)/app.cobra.term" >/dev/null 2>&1 || true
    rm -f "$plist" "$CONFIG/ticket.key"
    ok "removed the old terminal service (Cobra serves no terminal now)"
    return 0
  fi
  local file="$UNIT_DIR/cobra-term.service" running=0
  systemctl --user is-active --quiet cobra-term.service 2>/dev/null && running=1
  [[ -e $file || $running == 1 ]] || { rm -f "$CONFIG/ticket.key"; return 0; }
  systemctl --user disable cobra-term.service >/dev/null 2>&1 || true
  if ((running)) && term_holds_sessions; then
    rm -f "$file" "$CONFIG/ticket.key"
    systemctl --user daemon-reload
    todo "the old terminal service is switched off but still running: Cobra's sessions run under it, and stopping it would end them. It goes at the next restart of this computer; nothing can use it until then"
  else
    systemctl --user stop cobra-term.service >/dev/null 2>&1 || true
    rm -f "$file" "$CONFIG/ticket.key"
    systemctl --user daemon-reload
    ok "removed the old terminal service (Cobra serves no terminal now)"
  fi
}

if ((SYSTEMD)); then
  if [[ $OS == Darwin ]]; then say "launchd user agents"; else say "systemd user units"; fi
  mkdir -p "$UNIT_DIR"
  if [[ $OS == Darwin ]]; then
    mkdir -p "$HOME/Library/Logs"
    sed -e "s|@PREFIX@|$PREFIX|g" -e "s|@CONFIG@|$CONFIG|g" -e "s|@HOME@|$HOME|g" -e "s|@AGENT_PORT@|$AGENT_PORT|g" \
      "$PREFIX/current/launchd/app.cobra.agent.plist" > "$UNIT_DIR/app.cobra.agent.plist"
  else
    sed -e "s|@PREFIX@|$PREFIX|g" -e "s|@CONFIG@|$CONFIG|g" -e "s|@AGENT_PORT@|$AGENT_PORT|g" \
      "$PREFIX/current/systemd/cobra-agent.service" > "$UNIT_DIR/cobra-agent.service"
  fi
  # The vault seals the secret files (vault.ts): its key in the keychain when
  # there is one; else the person sets a passphrase (a next step below).
  if "$PREFIX/current/bin/cobra-agent" vault init --keychain-only >/dev/null 2>&1; then
    ok "vault: secret files sealed ($("$PREFIX/current/bin/cobra-agent" vault status 2>/dev/null | head -1 | cut -d. -f1))"
  else
    todo "vault: no keychain took the key, so secret files are kept as plain text"
    VAULT_PASSPHRASE=1
  fi
  if [[ $OS == Darwin ]]; then
    # bootout stops node only (AbandonProcessGroup keeps tmux and its sessions); bootstrap loads the new plist and starts it.
    launchctl bootout "gui/$(id -u)/app.cobra.agent" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$UNIT_DIR/app.cobra.agent.plist"
  else
    systemctl --user daemon-reload
    systemctl --user enable cobra-agent.service >/dev/null 2>&1
    # restart, never stop: see the header.
    systemctl --user restart cobra-agent.service
  fi
  ok "cobra-agent on 127.0.0.1:$AGENT_PORT"
  retire_term
fi

# The desk app, when this package carries it: linked first (cobra-agent desk
# --into writes its key straight into the desk's computers.json, never to the
# screen; a link that still works stays), then put on the desktop.
# What is left for the person, numbered at the end.
NEXT=()
next_step() { NEXT+=("$1"); }

DESK_DONE=0
DESK_APPIMAGE="$PREFIX/current/desk/cobra-desktop.AppImage"
DESK_SCRIPT="$PREFIX/current/apps/desk/scripts/install-omarchy.sh"
if ((SYSTEMD && DESK)) && [[ $OS == Linux && -f $DESK_APPIMAGE && -f $DESK_SCRIPT ]]; then
  say "The desk app"
  DESK_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/app.cobra.desktop/computers.json"
  if linked=$("$PREFIX/current/bin/cobra-agent" desk --into "$DESK_FILE" --name "${MACHINE_NAME:-$(uname -n)} desktop" 2>&1); then
    ok "$linked"
  else
    todo "the desk app is not linked yet: ${linked//$'\n'/ }"
    next_step "Open Cobra and press Settings → This computer → Link the agent"
  fi
  desk_flags=(--binary "$DESK_APPIMAGE")
  if [[ -d ${OMARCHY_PATH:-/usr/share/omarchy} ]] && command -v hyprctl >/dev/null; then
    DESK_WHERE="Omarchy: the launcher, SUPER+P and the bar"
  else
    desk_flags+=(--no-omarchy)
    DESK_WHERE="your app launcher"
  fi
  if desk_log=$(bash "$DESK_SCRIPT" "${desk_flags[@]}" 2>&1); then
    DESK_DONE=1
    ok "Cobra (the desk app) installed and running: $DESK_WHERE"
  elif [[ -x $HOME/.local/bin/cobra-desktop ]]; then
    DESK_DONE=1
    todo "the desk app is installed but did not start here (no desktop session?); it starts at your next login"
  else
    todo "the desk app was not installed: $(tail -1 <<<"$desk_log")"
  fi
fi

if ((WIDGET_ENGINE)); then
  # Life sync ended with the life app (October 2026): the companion's engine no
  # longer ships. The flag is still accepted so older install commands work; it
  # removes the link the Omarchy widget ran the engine through, when it is ours.
  ENGINE_LINK="${XDG_DATA_HOME:-$HOME/.local/share}/cobra/engine"
  if [[ -L $ENGINE_LINK && $(readlink "$ENGINE_LINK") == "$PREFIX/"* ]]; then
    rm -f "$ENGINE_LINK"
    ok "widget engine removed (life sync has ended)"
  else
    ok "widget engine: nothing to do (life sync has ended)"
  fi
fi

if ((CLAUDE_SKILLS)); then
  # Each skill is a folder of our own under ~/.claude/skills; an update
  # replaces only those folders, never anything else there.
  mkdir -p "$HOME/.claude/skills"
  for skill in "$PREFIX/current/apps/agent/skills"/*/; do
    name=$(basename "$skill")
    rm -rf "$HOME/.claude/skills/$name"
    cp -a "$skill" "$HOME/.claude/skills/$name"
    ok "Claude Code skill $name in ~/.claude/skills (new sessions see it)"
  done
fi

if ((CLAUDE_HOOKS)); then
  # Session state from Claude Code itself instead of the screen. Only our own
  # entries are added; the file keeps a copy as settings.json.before-cobra.
  SETTINGS="$HOME/.claude/settings.json"
  mkdir -p "$HOME/.claude"
  if "$PREFIX/current/bin/node" "$PREFIX/current/apps/agent/hooks/claude-settings.mjs" add "$SETTINGS" \
      "$PREFIX/current/bin/node $PREFIX/current/apps/agent/hooks/claude-hook.mjs" \
      && grep -q "claude-hook.mjs" "$SETTINGS"; then
    ok "Claude Code hooks in $SETTINGS (new sessions use them)"
  else
    todo "Claude Code hooks were not added; the agent keeps reading the screen"
  fi
fi

if ((CODEX_NOTIFY)); then
  # Codex says when a turn finishes. Codex has one notify program: one of
  # your own stays as it is, and the agent reads Codex's screen instead.
  CODEX_CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"
  mkdir -p "$(dirname "$CODEX_CONFIG")"
  if "$PREFIX/current/bin/node" "$PREFIX/current/apps/agent/hooks/codex-config.mjs" add "$CODEX_CONFIG" \
      "$PREFIX/current/bin/node" "$PREFIX/current/apps/agent/hooks/codex-notify.mjs" \
      && grep -q "codex-notify.mjs" "$CODEX_CONFIG"; then
    ok "Codex notify in $CODEX_CONFIG (new Codex sessions use it)"
  else
    todo "Codex notify was not added; the agent reads Codex's screen"
  fi
fi


say "Checks"
if [[ $OS == Darwin ]]; then
  ok "the agent starts when you log in (launchd)"
elif [[ $(loginctl show-user "$USER" -p Linger --value 2>/dev/null) == yes ]]; then
  ok "linger is on: the agent starts at boot"
else
  todo "linger is off, so the agent stops when you log out"
  next_step "Let the agent start at boot: sudo loginctl enable-linger $USER"
fi
# What to run for a missing tool: Homebrew on a Mac, the package manager on Linux.
get() { if [[ $OS == Darwin ]]; then echo "brew install $1"; else echo "install $1 with your package manager"; fi; }
if command -v tmux >/dev/null; then ok "tmux $(tmux -V | cut -d' ' -f2)"; else todo "tmux is missing; sessions need it"; next_step "Install tmux: $(get tmux)"; fi
# Where Workers run, and why: an off that nobody chose is what this line is for.
if ((CONTAIN)) && bwrap_works; then
  ok "Workers run contained, in Cobra's sandbox (COBRA_CONTAIN=$( ((CONTAIN == 2)) && echo require || echo on): $CONTAIN_WHY)"
elif ((CONTAIN == 2)); then
  todo "Nothing of the workforce starts: COBRA_CONTAIN=require, but bubblewrap cannot make its namespaces here (install bubblewrap 0.8 or later, allow unprivileged user namespaces); the agent probes again every 5 minutes"
elif ((CONTAIN)); then
  todo "Workers run uncontained: COBRA_CONTAIN=on, but bubblewrap cannot make its namespaces here (install bubblewrap, allow unprivileged user namespaces)"
else
  todo "Workers run uncontained, in Claude Code's sandbox only ($CONTAIN_WHY); each still gets its own Claude Code folder. --contain turns Cobra's sandbox on"
fi
if command -v git >/dev/null; then ok "git"; else todo "git is missing; git health needs it"; next_step "Install git: $(get git)"; fi

# Workers in Cobra's sandbox never see your ~/.claude: they use a kept token,
# else Claude Code's own access token, which Cobra never refreshes.
if ((FIRST_INSTALL)) && [[ ! -s $CONFIG/claude-token ]] && ! compgen -G "$CONFIG/accounts/*/claude-token" >/dev/null; then
  next_step "Give Workers a lasting Claude sign-in: claude setup-token (it prints a token), then cobra-agent claude-token (paste it, Enter, Ctrl-D)"
fi
((${VAULT_PASSPHRASE:-0})) && next_step "Seal secret files with a passphrase (no keychain here): cobra-agent vault init"
if ((DESK_DONE)); then
  next_step "Open Cobra from your app launcher and say hello to your Lead"
else
  next_step "Open the desk app; it makes its own key with: cobra-agent desk"
fi

say "Done"
echo "    Next:"
n=0
for step in "${NEXT[@]}"; do
  n=$((n + 1))
  printf '    %d. %s\n' "$n" "$step"
done
if [[ $OS == Darwin ]]; then echo "    Logs: tail -f ~/Library/Logs/cobra-agent.log"; else echo "    Logs: journalctl --user -u cobra-agent -f"; fi
