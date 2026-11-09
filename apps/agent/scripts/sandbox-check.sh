#!/usr/bin/env bash
# Checks a Worker's sandbox from inside it: Chromium starts, no host socket
# that would let a shell out can be reached (policy.ts socketDenyRead), and in
# the shared .git only the folders git writes are writable, never its root or
# the files that say where a repository is (policy.ts gitWriteRoots).
#
# Run it from a Worker's shell after the agent is reinstalled:
#
#   bash apps/agent/scripts/sandbox-check.sh
#
# Run it once in your own terminal too, outside any sandbox, as the control:
# there every socket the computer has should say FAIL (connected), which shows
# the check would see one that the sandbox let through.
#
# With --install, run from your own terminal (not a Worker's), it checks the
# agent's dependency install instead (installJail.ts, OV-SEC-VPS-001 F2): a
# throwaway project with a planted preinstall goes through the real contained
# install, and the script must not run nor write outside the project. It
# touches nothing of the agent's.
#
# Prints one line per check and exits 1 when any check fails.

set -u

uid=$(id -u)
fails=0
pass() { printf 'PASS  %-34s %s\n' "$1" "$2"; }
fail() { printf 'FAIL  %-34s %s\n' "$1" "$2"; fails=$((fails + 1)); }
info() { printf 'INFO  %-34s %s\n' "$1" "$2"; }

work=$(mktemp -d "${TMPDIR:-/tmp}/sandbox-check.XXXXXX")
trap 'rm -rf "$work"' EXIT

# --- the dependency install: a planted preinstall must not run ----------------

if [ "${1:-}" = "--install" ]; then
  here=$(cd "$(dirname "$0")" && pwd)
  module="$here/../src/agent/installJail.ts"
  node_bin=${NODE:-$(command -v node || true)}
  npm_bin=$(command -v npm || true)
  if [ -z "$node_bin" ] || [ -z "$npm_bin" ] || [ ! -f "$module" ]; then
    echo "Needs node, npm and $module." >&2
    exit 2
  fi
  # Outside /tmp: the sandbox has a /tmp of its own.
  box=$(mktemp -d /var/tmp/sandbox-check-install.XXXXXX)
  trap 'rm -rf "$work" "$box"' EXIT
  project="$box/project"
  escaped="$box/escaped"
  mkdir -p "$project"
  git init -q -b main "$project"
  printf '{"name":"probe","version":"1.0.0","scripts":{"preinstall":"touch preinstall-ran %s","postinstall":"touch postinstall-ran"}}\n' "$escaped" >"$project/package.json"
  printf '{"name":"probe","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"probe","version":"1.0.0"}}}\n' >"$project/package-lock.json"
  # shellcheck disable=SC2016 # the script is JavaScript
  if out=$("$node_bin" --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --input-type=module -e '
    const [module, tool, worktree] = process.argv.slice(1);
    const jail = await import(module);
    await jail.containedInstall({ tool, args: ["ci", "--prefer-offline", "--ignore-scripts"], worktree, gitCommon: `${worktree}/.git`, agentPath: process.env.PATH ?? "" });
  ' "$module" "$(readlink -f "$npm_bin")" "$project" 2>&1); then
    pass "install: contained npm ci" "ran in the sandbox"
  else
    fail "install: contained npm ci" "$(printf '%s' "$out" | tail -n 1 | cut -c1-160)"
  fi
  if [ -e "$project/preinstall-ran" ] || [ -e "$project/postinstall-ran" ]; then
    fail "install: planted preinstall" "a lifecycle script ran"
  else
    pass "install: planted preinstall" "did not run"
  fi
  if [ -e "$escaped" ]; then fail "install: outside the project" "$escaped was written"; else pass "install: outside the project" "nothing written"; fi
  echo
  if [ "$fails" -eq 0 ]; then echo "All checks passed."; else echo "$fails check(s) failed."; exit 1; fi
  exit 0
fi

# --- how to reach a socket: python3, else socat --------------------------------

if command -v python3 >/dev/null 2>&1; then
  tool=python3
elif command -v socat >/dev/null 2>&1; then
  tool=socat
else
  echo "Needs python3 or socat to try the sockets." >&2
  exit 2
fi
info "probe" "$tool"

# probe <mode> <path>: prints one word for what happened.
#   mode connect: "connected", or the error (ENOENT, ECONNREFUSED, EPERM...)
#   mode http:    the proxy's status line to a CONNECT with no credentials
#   mode socks:   "auth-required" or "no-auth" for a SOCKS5 greeting
# A path starting with @ is an abstract socket.
probe() {
  if [ "$tool" = python3 ]; then
    python3 -I - "$1" "$2" <<'PY'
import errno, socket, sys
mode, path = sys.argv[1], sys.argv[2]
if path.startswith("@"):
    path = "\0" + path[1:]
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
except OSError as e:
    print("socket():" + errno.errorcode.get(e.errno, str(e.errno)))
    sys.exit()
s.settimeout(3)
try:
    s.connect(path)
except OSError as e:
    print(errno.errorcode.get(e.errno, str(e.errno)) if e.errno else type(e).__name__)
    sys.exit()
try:
    if mode == "http":
        s.sendall(b"CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n")
        print((s.recv(200).split(b"\r\n")[0].decode("latin-1") or "no-reply").replace(" ", "_"))
    elif mode == "socks":
        s.sendall(b"\x05\x01\x00")
        reply = s.recv(2)
        print("no-auth" if reply[1:2] == b"\x00" else "auth-required")
    else:
        print("connected")
except OSError as e:
    print("no-reply")
PY
  else
    local target="UNIX-CONNECT:$2" out
    case "$2" in @*) target="ABSTRACT-CONNECT:${2#@}" ;; esac
    case "$1" in
      connect)
        if out=$(socat -T3 - "$target" </dev/null 2>&1); then
          echo connected
        else
          case "$out" in
            *"socket("*"not permitted"*) echo "socket():EPERM" ;;
            *"No such file"*) echo ENOENT ;;
            *"Connection refused"*) echo ECONNREFUSED ;;
            *"Permission denied"*) echo EACCES ;;
            *) echo "${out##*: }" | tr ' ' '_' ;;
          esac
        fi
        ;;
      http)
        out=$(printf 'CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n' | socat -T3 - "$target" 2>&1)
        out=${out%%$'\r'*}
        echo "${out:-no-reply}" | tr ' ' '_'
        ;;
      socks)
        out=$(printf '\005\001\000' | socat -T3 - "$target" 2>/dev/null | od -An -tx1 | tr -d ' \n')
        if [ "$out" = "0500" ]; then echo no-auth; else echo auth-required; fi
        ;;
    esac
  fi
}

# --- Unix sockets at all ------------------------------------------------------

made=$(probe connect "$work/none.sock")
case "$made" in
  socket\(\):*) fail "unix sockets" "socket() refused ($made): this Worker started without allowAllUnixSockets" ;;
  *) pass "unix sockets" "socket() works" ;;
esac

# --- Chromium -----------------------------------------------------------------

chrome=""
for name in chromium chromium-browser google-chrome-stable google-chrome; do
  if command -v "$name" >/dev/null 2>&1; then chrome=$(command -v "$name"); break; fi
done
if [ -z "$chrome" ]; then
  # Playwright's own build, if a project installed one.
  chrome=$(ls -d "$HOME"/.cache/ms-playwright/chromium*/chrome-linux*/chrome 2>/dev/null | sort | tail -n 1)
fi

started=0
if [ -z "$chrome" ]; then
  fail "chromium" "no chromium, chrome or Playwright build found"
else
  info "chromium" "$chrome"
  for flags in "" "--no-sandbox"; do
    label="chromium ${flags:-(its own sandbox)}"
    profile=$(mktemp -d "$work/profile.XXXXXX")
    # In a subshell, so a crash report lands in the log rather than on screen.
    # shellcheck disable=SC2086 # flags is one flag or none
    if (timeout 60 "$chrome" --headless $flags --user-data-dir="$profile" --dump-dom about:blank >"$profile.out"; exit $?) 2>"$profile.err" \
      && grep -q "<html" "$profile.out"; then
      info "$label" "works"
      started=1
    else
      reason=$({ grep -E 'FATAL|ERROR' "$profile.err" || grep -v '^[[:space:]]*$' "$profile.err"; } | head -n 1 | sed 's/^\[[^]]*\] *//' | cut -c1-160)
      info "$label" "does not start: ${reason:-no output}"
    fi
  done
  if [ "$started" = 1 ]; then pass "chromium" "starts headless"; else fail "chromium" "starts in neither mode"; fi
fi

# --- host sockets: each must be out of reach ------------------------------------

runtime=${XDG_RUNTIME_DIR:-/run/user/$uid}
tmux_dir=${TMUX_TMPDIR:-/tmp}/tmux-$uid

seen=" "
check_socket() { # name path
  local got
  case "$seen" in *" $2 "*) return ;; esac
  seen="$seen$2 "
  got=$(probe connect "$2")
  case "$got" in
    connected) fail "$1" "$2 connected" ;;
    *) pass "$1" "$2 refused ($got)" ;;
  esac
}

check_socket "tmux cobra" "$tmux_dir/cobra"
check_socket "tmux default" "$tmux_dir/default"
check_socket "tmux (/tmp)" "/tmp/tmux-$uid/cobra"
check_socket "systemd user bus" "$runtime/bus"
check_socket "systemd user bus (/run)" "/run/user/$uid/bus"
check_socket "systemd user manager" "$runtime/systemd/private"
check_socket "dbus system bus" "/run/dbus/system_bus_socket"
check_socket "dbus system bus (/var)" "/var/run/dbus/system_bus_socket"
check_socket "docker" "/var/run/docker.sock"
check_socket "docker (/run)" "/run/docker.sock"
if [ -n "${SSH_AUTH_SOCK:-}" ]; then
  check_socket "SSH_AUTH_SOCK" "$SSH_AUTH_SOCK"
else
  info "SSH_AUTH_SOCK" "not set here"
fi
check_socket "gpg agent" "$runtime/gnupg/S.gpg-agent"
check_socket "wayland" "$runtime/${WAYLAND_DISPLAY:-wayland-1}"
check_socket "tailscale" "/run/tailscale/tailscaled.sock"
check_socket "ssh over AF_UNIX" "/run/ssh-unix-local/socket"
check_socket "X11" "/tmp/.X11-unix/X0"
# Abstract sockets have no path to hide; the command's own network namespace keeps them out.
check_socket "X11 (abstract)" "@/tmp/.X11-unix/X0"
for sock in /tmp/claude-mcp-browser-bridge-*/*.sock; do
  case "$sock" in *'*'*) continue ;; esac
  check_socket "Claude in Chrome bridge" "$sock"
done
for sock in /tmp/org.chromium.Chromium.*/SingletonSocket /tmp/.org.chromium.Chromium.*/SingletonSocket; do
  case "$sock" in *'*'*) continue ;; esac
  check_socket "a running Chromium" "$sock"
done
if ls -d /tmp/org.chromium.Chromium.* /tmp/.org.chromium.Chromium.* >/dev/null 2>&1; then
  info "running Chromium folders" "visible, but each must be empty above"
fi

# Other sessions' message sockets (Claude Code's cc-socks).
for sock in "$runtime"/cc-socks/*.sock /tmp/cc-socks/*.sock /tmp/cc-socks-*/*.sock; do
  case "$sock" in *'*'*) continue ;; esac
  check_socket "Claude Code messages" "$sock"
done
check_socket "Claude Code messages (env)" "${CLAUDE_CODE_MESSAGING_SOCKET:-$runtime/cc-socks/none.sock}"

# --- Claude Code's proxy bridges: this Worker's own must work -----------------------

# The sandbox reaches its bridge through a proxy on localhost; a hidden bridge
# answers nothing. Any HTTP reply (403 or 407 with no network) means it works.
proxy=${HTTPS_PROXY:-${https_proxy:-}}
port=${proxy##*:}
port=${port%%/*}
if [ -z "$proxy" ] || [ -z "$port" ]; then
  info "own proxy bridge" "no proxy in this shell (not in a sandbox?)"
elif reply=$(timeout 5 bash -c 'exec 3<>"/dev/tcp/127.0.0.1/$1" || exit 1
    printf "CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n" >&3
    IFS= read -r line <&3; printf "%s" "${line%$'"'"'\r'"'"'}"' _ "$port" 2>/dev/null) && [ "${reply#HTTP/}" != "$reply" ]; then
  pass "own proxy bridge" "localhost:$port answers ($reply)"
else
  fail "own proxy bridge" "localhost:$port did not answer: this Worker's bridge is hidden or gone"
fi

# --- Claude Code's proxy bridges: visible, but each asks for its token -------------

# One line for all of them; each one that answers without a token is named.
bridges=0
before=$fails
for sock in /tmp/claude-http-*.sock /tmp/srt-mux-*.sock /tmp/claude-socks-*.sock; do
  case "$sock" in *'*'*) continue ;; esac
  bridges=$((bridges + 1))
  case "$sock" in
    */claude-socks-*)
      got=$(probe socks "$sock")
      [ "$got" = no-auth ] && fail "proxy asks for a token" "$sock lets SOCKS in without one"
      ;;
    *)
      got=$(probe http "$sock")
      case "$got" in
        *_407_* | *_407) ;;
        HTTP*) fail "proxy asks for a token" "$sock answered ${got//_/ }" ;;
      esac
      ;;
  esac
done
if [ "$fails" -eq "$before" ]; then
  pass "proxy bridges" "$bridges in /tmp; none lets a request through without its session's token"
fi

# --- Cobra's sandbox: hardened (OV-SEC-VPS-001 F19) and no git credentials ---------
#
# contain.ts JAIL_HARDENING: no nested user namespace, no capability. Claude
# Code's own sandbox (COBRA_CONTAIN off) is not hardened this way: there
# these lines are INFO only.

if [ "${COBRA_AGENT_SOCKET:-}" = /run/cobra/agent.sock ]; then
  jailed=1
else
  jailed=0
fi
hard() { if [ "$jailed" = 1 ]; then "$@"; else info "$2" "(not in Cobra's sandbox) $3"; fi; }
if unshare -U true 2>/dev/null; then
  hard fail "no nested user namespace" "unshare -U worked"
else
  pass "no nested user namespace" "unshare -U is refused"
fi
caps=$(awk '/^CapBnd:/ { print $2 }' /proc/self/status 2>/dev/null)
if [ -n "$caps" ] && [ "$(printf '%s' "$caps" | tr -d 0)" = "" ]; then
  pass "no capability" "the bounding set is empty"
else
  hard fail "no capability" "CapBnd is ${caps:-unreadable}"
fi
for store in "$HOME/.config/git/credentials" "$HOME/.git-credentials"; do
  if [ -s "$store" ]; then fail "git credentials hidden" "$store can be read"; else pass "git credentials hidden" "$store is empty or not there"; fi
done

# --- the repository's .git: its folders writable, its root and pointers not ---------
#
# policy.ts gitWriteRoots/gitPointerDenies. A file at the root of the shared
# .git (a commondir, a config, a hook) would be read by git in your own
# checkout, outside any sandbox. Probes use a new file of their own name, and
# `: >>` on existing files, which changes nothing even where it is allowed.

if common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
  && own=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) \
  && top=$(git rev-parse --show-toplevel 2>/dev/null) && [ "$common" != "$own" ]; then
  probe_name=".cobra-sandbox-check.$$"
  must_refuse_new() { # name dir
    if (: >"$2/$probe_name") 2>/dev/null; then
      rm -f "$2/$probe_name"
      fail "$1" "a new file could be made in $2"
    else
      pass "$1" "$2 refuses new files"
    fi
  }
  must_refuse_append() { # name file
    [ -e "$2" ] || { info "$1" "$2 does not exist"; return; }
    if (: >>"$2") 2>/dev/null; then fail "$1" "$2 is writable"; else pass "$1" "$2 is read-only"; fi
  }
  must_allow_new() { # name dir
    if (: >"$2/$probe_name") 2>/dev/null; then
      rm -f "$2/$probe_name"
      pass "$1" "$2 takes new files"
    else
      fail "$1" "$2 refuses new files: git cannot commit here"
    fi
  }
  must_refuse_new "git: .git root" "$common"
  must_refuse_new "git: hooks" "$common/hooks"
  must_refuse_new "git: worktrees folder" "$common/worktrees"
  must_refuse_append "git: config" "$common/config"
  must_refuse_append "git: worktree's .git file" "$top/.git"
  must_refuse_append "git: own gitdir" "$own/gitdir"
  must_refuse_append "git: own commondir" "$own/commondir"
  must_refuse_append "git: own config.worktree" "$own/config.worktree"
  for other in "$common"/worktrees/*/; do
    other=${other%/}
    [ "$other" = "$own" ] && continue
    case "$other" in *'*'*) continue ;; esac
    must_refuse_append "git: $(basename "$other") commondir" "$other/commondir"
  done
  # What the local check reads as main (OV-SEC-VPS-001 F5): only the agent's fetch writes origin's refs.
  must_refuse_new "git: refs/remotes" "$common/refs/remotes"
  for remote in "$common"/refs/remotes/*/; do
    remote=${remote%/}
    case "$remote" in *'*'*) continue ;; esac
    must_refuse_new "git: refs/remotes/$(basename "$remote")" "$remote"
    must_refuse_append "git: $(basename "$remote")/HEAD" "$remote/HEAD"
  done
  must_refuse_append "git: packed-refs" "$common/packed-refs"
  must_allow_new "git: refs/heads" "$common/refs/heads"
  must_allow_new "git: objects" "$common/objects"
  must_allow_new "git: refs" "$common/refs"
  must_allow_new "git: logs" "$common/logs"
  must_allow_new "git: own folder" "$own"
else
  info "git" "not in a Worker's linked worktree; the .git checks are skipped"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$fails check(s) failed."
  exit 1
fi
