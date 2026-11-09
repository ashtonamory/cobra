#!/usr/bin/env bash
# API lane spike, live: real Claude Code sessions through proxy.ts, on the
# subscription and on an API key. Spends real API credits (well under $1).
#
#   bash run-live.sh          every scenario
#   bash run-live.sh D        only the ones named (any of ABCD)
#
# The key is read from COBRA_SPIKE_API_KEY, else
# ~/.config/cobra-agent/anthropic-api-key (0600, the key alone). Each
# session gets its own empty Claude Code folder; yours is never touched.
#
#   A  api         one turn entirely on the key: does the API take the request
#                  Claude Code shapes for a subscription (its beta flags)?
#   B  alternate   one turn of several tool calls, each request on the other
#                  lane: does a session survive moving mid-turn, thinking
#                  blocks included?
#   C  hold-after  a turn that fails over to the key part-way, then a resumed
#                  turn: the plan's overflow, as a session meets it
#   D  alternate   a turn that thinks before its tool call, so the request on
#                  the key carries a thinking block the subscription's reply
#                  made: are thinking blocks bound to the credential?
set -uo pipefail

only="${1:-ABCD}"
here="$(cd "$(dirname "$0")" && pwd)"
out="${TMPDIR:-/tmp}/cobra-lane-spike-$(date +%s)"
mkdir -p "$out"
chmod 700 "$out"
port=8898
node=(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON)

if [ -z "${COBRA_SPIKE_API_KEY:-}" ] && [ ! -s "$HOME/.config/cobra-agent/anthropic-api-key" ]; then
  echo "No API key: set COBRA_SPIKE_API_KEY or write ~/.config/cobra-agent/anthropic-api-key (chmod 600)." >&2
  exit 1
fi

proxy_pid=""
start_proxy() {
  "${node[@]}" "$here/proxy.ts" --port "$port" --mode "$1" --log "$out/$2.jsonl" 2>>"$out/proxy.err" &
  proxy_pid=$!
  sleep 1
}
stop_proxy() {
  [ -n "$proxy_pid" ] && kill "$proxy_pid" 2>/dev/null
  wait "$proxy_pid" 2>/dev/null
  proxy_pid=""
}
trap stop_proxy EXIT

# claude through the proxy, holding only the placeholder.
lane_claude() {
  local name="$1"
  shift
  mkdir -p "$out/$name/config" "$out/$name/work"
  (cd "$out/$name/work" && env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
    ANTHROPIC_BASE_URL="http://127.0.0.1:$port/anthropic" \
    CLAUDE_CODE_OAUTH_TOKEN=cobra-contained-placeholder \
    CLAUDE_CONFIG_DIR="$out/$name/config" \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    timeout 300 claude -p "$@")
}

if [[ $only == *A* ]]; then
echo "== A: every request on the API key"
start_proxy api A
echo "Run the shell command: echo lane-check. Then reply with just the word done." |
  lane_claude A --model haiku --allowedTools Bash >"$out/A.out" 2>&1
stop_proxy
fi

if [[ $only == *B* ]]; then
echo "== B: requests take turns between the lanes, mid-turn"
start_proxy alternate B
echo "Think it through first. Create notes.txt with three short lines about tides, show it with cat, count its lines with wc -l, then reply with only the count." |
  lane_claude B --model sonnet --allowedTools Bash Write Read >"$out/B.out" 2>&1
stop_proxy
fi

if [[ $only == *C* ]]; then
echo "== C: the subscription refuses part-way, then the session goes on"
start_proxy hold-after=1 C
session="$(echo "Run: echo first. Then reply with just: ok" |
  lane_claude C --model sonnet --allowedTools Bash --output-format json 2>"$out/C.err" |
  "${node[@]}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).session_id??"")}catch{}})')"
if [ -n "$session" ]; then
  echo "Run: echo second. Then reply with just: ok again" |
    lane_claude C --model sonnet --allowedTools Bash --resume "$session" >"$out/C.out" 2>&1
else
  echo "(no session id from the first turn; see $out/C.err)" | tee "$out/C.out"
fi
stop_proxy
fi

if [[ $only == *D* ]]; then
echo "== D: a thinking block from the subscription, sent back on the key"
start_proxy alternate D
# "ultrathink" makes Claude Code ask for thinking; the sum makes it worth doing.
echo "ultrathink. A farmer has 17 sheep; all but 9 run away, then he buys 4 for every 3 he still has. Work out how many he has, then run the shell command: echo <that number>. Then reply with only the number." |
  lane_claude D --model sonnet --allowedTools Bash >"$out/D.out" 2>&1
stop_proxy
fi

"${node[@]}" "$here/summarize.ts" "$out"
echo "Everything is in $out"
