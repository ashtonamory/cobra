#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Fail if the tracked files contain anything private.
#
# Two lists:
#   - generic patterns, here: private artifact links and tailnet addresses;
#   - personal terms (names, handles, business names), never in this
#     repository: one per line in $COBRA_PRIVATE_TERMS (CI: a repository
#     secret) or in ~/.config/cobra-dev/private-terms. Matched as fixed
#     strings, ignoring case.
#
#   scripts/check-private.sh            # check the tracked and new files
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

GENERIC='claude\.ai/(code/)?artifact/|\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b'
# Example data that looks like a match on purpose.
ALLOW='100\.64\.0\.10|100\.101\.1\.2'

# Tracked files and new ones not yet added (but not ignored ones), so a check before a commit sees what it will hold.
files() { git ls-files -z --cached --others --exclude-standard -- . ':!pnpm-lock.yaml' ':!**/package-lock.json' ':!**/Cargo.lock' ':!scripts/check-private.sh'; }

found=0
if hits=$(files | xargs -0 grep -nIE "$GENERIC" 2>/dev/null | grep -vE "$ALLOW"); then
  echo "Private-looking text in tracked files:"
  echo "$hits"
  found=1
fi

terms=""
if [[ -n "${COBRA_PRIVATE_TERMS:-}" ]]; then
  terms=$COBRA_PRIVATE_TERMS
elif [[ -r "$HOME/.config/cobra-dev/private-terms" ]]; then
  terms=$(cat "$HOME/.config/cobra-dev/private-terms")
fi
if [[ -n "$terms" ]]; then
  list=$(mktemp)
  trap 'rm -f "$list"' EXIT
  printf '%s\n' "$terms" | sed '/^[[:space:]]*$/d' >"$list"
  # Print only file:line, never the term, so a CI log does not leak it.
  if hits=$(files | xargs -0 grep -nIiF -f "$list" 2>/dev/null | cut -d: -f1,2); then
    echo "Personal terms in tracked files (term not shown):"
    echo "$hits"
    found=1
  fi
else
  echo "check-private: no personal terms set (COBRA_PRIVATE_TERMS or ~/.config/cobra-dev/private-terms); generic check only."
fi

exit "$found"
