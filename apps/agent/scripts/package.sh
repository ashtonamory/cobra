#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Build the Cobra agent package for this computer: one .tar.gz, plus a
# .sha256 beside it.
#
#   bash apps/agent/scripts/package.sh            # this computer's target
#   bash apps/agent/scripts/package.sh linux-x64  # must match this computer
#   bash apps/agent/scripts/package.sh darwin-arm64   # on Linux: a Mac test build
#
# Targets: linux-x64, linux-arm64, darwin-arm64, darwin-x64. The release
# workflow builds each on its own kind of computer (one runner per target):
# node-pty's addon and the site template's modules are native.
#
# A Mac package can also be built on Linux, for testing on a Mac before a
# release: every native file it needs is a prebuilt one (node-pty's
# prebuilds, the site template's optional platform packages), so nothing is
# compiled. What a Linux build cannot do: run the bundled Mac Node to load
# pty.node (the file type is still checked), and sign. The result is
# unsigned; docs/mac-test.md says how to open it on the Mac.
#
# On Linux, with COBRA_DESK_APPIMAGE set (the release), it also carries the
# desk app's AppImage, which install.sh installs and links.
#
# Inside: its own Node runtime (pinned and checksum-verified), the agent and
# gateway TypeScript sources (Node runs them directly, so there is no build
# step), the runtime modules (ws, node-pty with its prebuilt addon, the xterm
# page assets), the systemd units and install.sh. Nothing from the target machine is needed but systemd (or
# launchd), tmux and git — no compiler, no npm.
#
# The sources keep their places in the repo (apps/agent/src, packages/ste/src)
# so their relative imports work unchanged, and node_modules sits above both.
#
# node-pty is built on Node-API, so one pty.node loads in any Node; it is
# checked against the bundled runtime before the package is written. Linux
# uses the one built at install (build/Release); macOS uses node-pty's own
# prebuilt one (prebuilds/darwin-<arch>) with its spawn-helper.
#
# The archive is reproducible with GNU tar (gtar on macOS: brew install
# gnu-tar); with another tar it is still correct, only not byte-identical.
# ---------------------------------------------------------------------------
set -euo pipefail

NODE_VERSION=26.8.1
# From https://nodejs.org/dist/v26.8.1/SHASUMS256.txt, the .tar.xz of each.
node_sha256() {
  case $1 in
    linux-x64) echo 3e301118d7df53d563b7e96c1617545f26e2f76f9724be668d6cab65c15dda5d ;;
    linux-arm64) echo 23c1b4d19e2f12a7d06fe8aa3d6e0e4923cf77a47e13c5ccdf32fadaa33960f2 ;;
    darwin-arm64) echo b32047d86467497d3f59b8cf81f422c06938cf5f36ece2b36f6e7c024a0a3e5b ;;
    darwin-x64) echo 977c742754a1fa2425d3d9b4a17ca0ba4809919030432f47880b3dba8260cb6f ;;
    *) return 1 ;;
  esac
}

host_target() {
  local os arch
  case $(uname -s) in Linux) os=linux ;; Darwin) os=darwin ;; *) return 1 ;; esac
  case $(uname -m) in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) return 1 ;; esac
  echo "$os-$arch"
}

HOST=$(host_target) || { echo "This computer is not one Cobra builds for (Linux or macOS, x86_64 or arm64)." >&2; exit 1; }
TARGET=${1:-$HOST}
NODE_SHA256=$(node_sha256 "$TARGET") || { echo "Unknown target $TARGET: linux-x64, linux-arm64, darwin-arm64 or darwin-x64." >&2; exit 1; }
OS=${TARGET%-*}
ARCH=${TARGET#*-}
CROSS=0
if [[ $TARGET != "$HOST" ]]; then
  # Only a Mac package is all prebuilt; a Linux one compiles node-pty here.
  [[ $OS == darwin ]] || { echo "Build $TARGET on a $TARGET computer (this one is $HOST): its native modules are this computer's." >&2; exit 1; }
  CROSS=1
  echo "    (a $TARGET test build on $HOST: unsigned, and pty.node is checked by its file type only)"
fi

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
AGENT=$(cd "$HERE/.." && pwd)
ROOT=$(cd "$AGENT/../.." && pwd)
VERSION=$(node -p "require('$AGENT/package.json').version")
NAME="cobra-agent-$VERSION-$TARGET"
OUT="$AGENT/release"
STAGE="$OUT/$NAME"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/cobra-agent-build"

# sha256sum on Linux, shasum on macOS: the same output.
if command -v sha256sum >/dev/null; then SHA=(sha256sum); else SHA=(shasum -a 256); fi
TAR=tar
command -v gtar >/dev/null && TAR=gtar

echo "==> $NAME"
rm -rf "$STAGE" "$OUT/$NAME.tar.gz" "$OUT/$NAME.tar.gz.sha256"
mkdir -p "$STAGE/bin" "$STAGE/node_modules/@xterm" "$CACHE"

# 1. The Node runtime, verified against the pinned hash.
TARBALL="$CACHE/node-v$NODE_VERSION-$TARGET.tar.xz"
if [[ ! -f $TARBALL ]]; then
  curl -fsSL -o "$TARBALL.part" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$TARGET.tar.xz"
  mv "$TARBALL.part" "$TARBALL"
fi
[[ $("${SHA[@]}" "$TARBALL" | cut -d' ' -f1) == "$NODE_SHA256" ]] || { echo "Node download does not match the pinned hash" >&2; rm -f "$TARBALL"; exit 1; }
tar -xJf "$TARBALL" -C "$CACHE"
cp "$CACHE/node-v$NODE_VERSION-$TARGET/bin/node" "$STAGE/bin/node"
echo "    node $NODE_VERSION (sha256 verified)"

# 2. Sources, without tests, at their repo paths.
for dir in apps/agent/src packages/ste/src; do
  (cd "$ROOT" && find "$dir" -name '*.ts' ! -name '*.test.ts') | while IFS= read -r file; do
    mkdir -p "$STAGE/$(dirname "$file")"
    cp "$ROOT/$file" "$STAGE/$file"
    chmod 644 "$STAGE/$file"
  done
done
# The contracts files the agent runs rather than type-checks (zod-free:
# sessionNames.ts, crew.ts, org.ts, views.ts, website.ts and the rest) are
# copied in step 4's import check, from what the staged sources import.
echo "    $(find "$STAGE/apps" "$STAGE/packages" -name '*.ts' | wc -l) source files"
# The ste-deep Claude Code skill (install.sh --claude-skills). The STE
# dictionary is ASD's copyright and never ships: packages/ste/data stays out.
mkdir -p "$STAGE/apps/agent/skills"
cp -a "$AGENT/skills/." "$STAGE/apps/agent/skills/"
echo "    skills: $(ls "$STAGE/apps/agent/skills" | tr '\n' ' ')"
# The trades' shipped report templates (render.ts): one folder per trade,
# <trade>/<template>/index.html with its sample.json, read at render time.
mkdir -p "$STAGE/apps/agent/templates"
cp -a "$AGENT/templates/." "$STAGE/apps/agent/templates/"
echo "    templates: $(ls "$STAGE/apps/agent/templates" | tr '\n' ' ')"
# The Designer's post templates and the fonts a brand kit chooses from (designer.ts), with their licences.
mkdir -p "$STAGE/apps/agent/designer"
cp -a "$AGENT/designer/." "$STAGE/apps/agent/designer/"
# Cobra's email design standard: its reference email, read by email_design_standard.
mkdir -p "$STAGE/apps/agent/email-standard"
cp -a "$AGENT/email-standard/." "$STAGE/apps/agent/email-standard/"
echo "    designer: $(ls "$STAGE/apps/agent/designer/templates" | wc -l) templates, $(ls "$STAGE/apps/agent/designer/fonts"/*.ttf | wc -l) fonts"
# The Website Builder's template (site.ts builds every Space's site from it),
# beside packages/ as in the repository, with its own production modules
# (Astro and what it runs), installed from its lockfile; never .builds or out.
mkdir -p "$STAGE/site-template"
(cd "$ROOT/site-template" && tar --exclude=./node_modules --exclude=./.builds --exclude=./out --exclude=./.astro --exclude=./coded/node_modules --exclude=./coded/dist --exclude=./coded/.astro -cf - .) | tar -xf - -C "$STAGE/site-template"
if [[ $CROSS == 1 ]]; then
  # The target's optional platform packages, not this computer's. Install
  # scripts are for the computer they run on, so none run here (fsevents,
  # the only one, ships its addon prebuilt).
  (cd "$STAGE/site-template" && npm ci --omit=dev --os="$OS" --cpu="$ARCH" --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null)
  for binding in "@rolldown/binding-$TARGET" "lightningcss-$TARGET" "@img/sharp-$TARGET"; do
    [[ -d $STAGE/site-template/node_modules/$binding ]] || { echo "site-template: $binding is missing" >&2; exit 1; }
  done
  ls -d "$STAGE"/site-template/node_modules/@rolldown/binding-linux-* >/dev/null 2>&1 && { echo "site-template: this computer's rolldown binding came in too" >&2; exit 1; }
else
  (cd "$STAGE/site-template" && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
fi
echo "    site-template: $(du -sh "$STAGE/site-template" | cut -f1)"
# Claude Code hooks: the event script and the settings.json helper.
mkdir -p "$STAGE/apps/agent/hooks"
for hook in claude-hook.mjs claude-settings.mjs codex-notify.mjs codex-config.mjs; do
  cp "$AGENT/hooks/$hook" "$STAGE/apps/agent/hooks/"
  chmod 755 "$STAGE/apps/agent/hooks/$hook"
done

# 3. Runtime modules, resolved the way Node resolves them from the agent's
#    folder — not from the root: the hoisted root copy of ws is React Native's
#    ws 7, and the gateway needs ws 8.
# FROM: the package whose dependency it is (the agent's, unless named).
module_dir() { dirname "$(node -p "require.resolve('$1/package.json', { paths: ['${FROM:-$AGENT}'] })")"; }
copy_module() {
  local name=$1 dest="$STAGE/node_modules/$1" src
  src=$(module_dir "$name") || { echo "$name: not found from ${FROM:-$AGENT}" >&2; exit 1; }
  mkdir -p "$dest"
  shift
  for part in package.json "$@"; do
    [[ -e $src/$part ]] && cp -a "$src/$part" "$dest/"
  done
  [[ -f $src/LICENSE ]] && cp "$src/LICENSE" "$dest/" || true
  echo "    $name $(node -p "require('$src/package.json').version")"
}
copy_module ws index.js wrapper.mjs lib
copy_module @xterm/xterm lib css
copy_module @xterm/addon-fit lib
copy_module node-pty lib
# zod, for ste-check's report schema: the built files only.
FROM="$ROOT/packages/ste" copy_module zod index.js index.cjs v3 v4 v4-mini
if [[ $OS == linux ]]; then
  PTY_DIR=build/Release
else
  # node-pty's prebuilt macOS addon, and the helper it starts each terminal
  # with: shipped without its execute bit, which would fail every terminal.
  PTY_DIR=prebuilds/$TARGET
fi
mkdir -p "$STAGE/node_modules/node-pty/$PTY_DIR"
cp "$(module_dir node-pty)/$PTY_DIR/pty.node" "$STAGE/node_modules/node-pty/$PTY_DIR/"
if [[ $OS == darwin ]]; then
  cp "$(module_dir node-pty)/$PTY_DIR/spawn-helper" "$STAGE/node_modules/node-pty/$PTY_DIR/"
  chmod 755 "$STAGE/node_modules/node-pty/$PTY_DIR/spawn-helper"
fi
case $TARGET in
  linux-x64) KIND="x86-64" ;;
  linux-arm64) KIND="aarch64" ;;
  darwin-arm64) KIND="arm64" ;;
  darwin-x64) KIND="x86_64" ;;
esac
file -b "$STAGE/node_modules/node-pty/$PTY_DIR/pty.node" | grep -q "$KIND" || { echo "pty.node is not $KIND" >&2; exit 1; }
if [[ $CROSS == 1 ]]; then
  echo "    pty.node is $KIND (not loaded: the bundled Node is a Mac one)"
else
  "$STAGE/bin/node" -e "require('$STAGE/node_modules/node-pty').spawn" >/dev/null || { echo "pty.node does not load in the bundled Node" >&2; exit 1; }
  echo "    pty.node is $KIND and loads in the bundled Node"
fi

# The import check: the contracts files the sources import, then every
# relative import in the package must find its file (staged-imports.mjs).
# This computer's node on a cross build: the check reads files, it runs none.
if [[ $CROSS == 1 ]]; then IMPORT_NODE=node; else IMPORT_NODE="$STAGE/bin/node"; fi
"$IMPORT_NODE" "$AGENT/scripts/staged-imports.mjs" "$ROOT" "$STAGE"

# 4. Units, installer, metadata.
# The desk app (Linux), so one download installs everything: the release's
# AppImage for this target, and what puts it on the desktop
# (apps/desk/scripts/install-omarchy.sh and the files it installs, in their
# repo places). install.sh runs it. COBRA_DESK_APPIMAGE names the AppImage;
# without it the package has no desk (a Mac package, or a local build).
if [[ -n ${COBRA_DESK_APPIMAGE:-} ]]; then
  [[ $OS == linux ]] || { echo "COBRA_DESK_APPIMAGE is for a Linux package; the Mac desk is a .dmg of its own" >&2; exit 1; }
  [[ -f $COBRA_DESK_APPIMAGE ]] || { echo "No AppImage at $COBRA_DESK_APPIMAGE" >&2; exit 1; }
  install -Dm755 "$COBRA_DESK_APPIMAGE" "$STAGE/desk/cobra-desktop.AppImage"
  install -Dm755 "$ROOT/apps/desk/scripts/install-omarchy.sh" "$STAGE/apps/desk/scripts/install-omarchy.sh"
  cp -a "$ROOT/apps/desk/omarchy" "$STAGE/apps/desk/omarchy"
  install -Dm644 "$ROOT/apps/desk/app/src-tauri/icons/128x128.png" "$STAGE/apps/desk/app/src-tauri/icons/128x128.png"
  echo "    desk: $(basename "$COBRA_DESK_APPIMAGE")"
fi
cp -a "$AGENT/systemd" "$STAGE/systemd"
cp -a "$AGENT/launchd" "$STAGE/launchd"
cp "$AGENT/install.sh" "$STAGE/install.sh"
chmod 755 "$STAGE/install.sh"
# The one command people run on the computer; install.sh links it into ~/.local/bin.
printf '#!/bin/sh\nhere=$(dirname "$(readlink -f "$0")")\nset -a\n[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/cobra-agent/agent.env" ] && . "${XDG_CONFIG_HOME:-$HOME/.config}/cobra-agent/agent.env"\nset +a\nexec "$here/node" "$here/../apps/agent/src/agent/cli.ts" "$@"\n' > "$STAGE/bin/cobra-agent"
chmod 755 "$STAGE/bin/cobra-agent"
# The STE checker the ste-deep skill runs; install.sh links it beside cobra-agent.
printf '#!/bin/sh\nhere=$(dirname "$(readlink -f "$0")")\nexec "$here/node" "$here/../packages/ste/src/cli.ts" "$@"\n' > "$STAGE/bin/ste-check"
chmod 755 "$STAGE/bin/ste-check"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"
echo "$VERSION" > "$STAGE/VERSION"
# macOS: every native file of ours (pty.node, spawn-helper, the site
# template's addons and tools) signed with the Developer ID, hardened
# runtime and a timestamp, then sent to Apple's notary service, so
# Gatekeeper knows them. Node's own binary is already signed and notarized
# by the Node.js project and is left as it is. Only with the release
# secrets (the release workflow); a local build is unsigned.
#   COBRA_SIGN_IDENTITY  "Developer ID Application: …" in the keychain
#   COBRA_NOTARY_KEY     an App Store Connect API key (.p8) path, with
#   COBRA_NOTARY_KEY_ID and COBRA_NOTARY_ISSUER
if [[ $OS == darwin && $CROSS == 0 && -n ${COBRA_SIGN_IDENTITY:-} ]]; then
  SIGNED=()
  while IFS= read -r -d '' file; do
    file -b "$file" | grep -q "Mach-O" || continue
    codesign --force --options runtime --timestamp --sign "$COBRA_SIGN_IDENTITY" "$file"
    SIGNED+=("$file")
  done < <(find "$STAGE" -type f ! -path "$STAGE/bin/node" -print0)
  codesign --verify --strict "$STAGE/bin/node" || { echo "Node's own signature does not verify" >&2; exit 1; }
  echo "    signed ${#SIGNED[@]} native files"
  if [[ -n ${COBRA_NOTARY_KEY:-} ]]; then
    NOTARY_ZIP="$OUT/$NAME-notary.zip"
    (cd "$STAGE" && printf '%s\n' "${SIGNED[@]#"$STAGE/"}" | zip -q "$NOTARY_ZIP" -@)
    xcrun notarytool submit "$NOTARY_ZIP" --key "$COBRA_NOTARY_KEY" --key-id "$COBRA_NOTARY_KEY_ID" --issuer "$COBRA_NOTARY_ISSUER" --wait --timeout 30m \
      | tee "$OUT/$NAME-notary.log"
    grep -q "status: Accepted" "$OUT/$NAME-notary.log" || { echo "Apple did not accept the native files" >&2; exit 1; }
    rm -f "$NOTARY_ZIP"
    echo "    notarized"
  fi
fi

# What exactly is in this package: a rebuild with the same version is a
# different build, and install.sh unpacks it beside the last one.
(cd "$STAGE" && find . -type f ! -name BUILD -print0 | LC_ALL=C sort -z | xargs -0 "${SHA[@]}" | "${SHA[@]}" | cut -c1-12) > "$STAGE/BUILD"
echo "    build $(cat "$STAGE/BUILD")"
# The sources are ES modules; this stops Node guessing per file.
printf '{\n  "name": "cobra-agent",\n  "version": "%s",\n  "private": true,\n  "type": "module"\n}\n' "$VERSION" > "$STAGE/package.json"

# 5. One reproducible archive: sorted entries, fixed time and owner.
if "$TAR" --version 2>/dev/null | grep -q "GNU tar"; then
  "$TAR" --sort=name --mtime='2026-01-01 00:00Z' --owner=0 --group=0 --numeric-owner \
    -C "$OUT" -czf "$OUT/$NAME.tar.gz" "$NAME"
else
  echo "    (no GNU tar: the archive is correct, but not byte-for-byte reproducible; brew install gnu-tar)"
  COPYFILE_DISABLE=1 tar --uid 0 --gid 0 -C "$OUT" -czf "$OUT/$NAME.tar.gz" "$NAME"
fi
(cd "$OUT" && "${SHA[@]}" "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
rm -rf "$STAGE"
echo "==> $OUT/$NAME.tar.gz ($(du -h "$OUT/$NAME.tar.gz" | cut -f1))"
cat "$OUT/$NAME.tar.gz.sha256"
