#!/usr/bin/env bash
# Puts `cpart` on your PATH, running from this checkout.
#   ./install.sh            then: cpart setup --relay <wss://host>, or cpart join <code> <name>
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(pwd)
command -v node >/dev/null || { echo "cpart needs Node 24 or newer: https://nodejs.org" >&2; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "cpart needs Node 24 or newer; this is $(node -v)" >&2; exit 1; }
command -v pnpm >/dev/null || npm install -g pnpm@12.16.1
pnpm install --prod --frozen-lockfile
BIN=${CPART_BIN:-$HOME/.local/bin}
mkdir -p "$BIN"
printf '#!/bin/sh\nexec node "%s/packages/cli/src/main.ts" "$@"\n' "$ROOT" >"$BIN/cpart"
chmod +x "$BIN/cpart"
echo "Installed $BIN/cpart"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add it to your PATH:  export PATH=\"$BIN:\$PATH\"" ;; esac
echo "Next:  cpart setup --relay <wss://host>     or, with a code someone sent you:  cpart join <code> <what you call them>"
