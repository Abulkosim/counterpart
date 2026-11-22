#!/bin/sh
# Installs cpart, the Counterpart command line. Needs Node 24 or newer.
#   curl -fsSL https://raw.githubusercontent.com/Abulkosim/counterpart/main/install.sh | sh
# Run from a checkout (./install.sh), it puts that checkout on your PATH instead.
set -eu
PACKAGE=${CPART_PACKAGE:-@abulkosim/counterpart}  # or a tarball, to try one before it is published

need_node() {
  echo "cpart needs Node 24 or newer$1. Get it from https://nodejs.org, or with nvm: nvm install 24" >&2
  exit 1
}
command -v node >/dev/null || need_node ""
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || need_node "; this is $(node -v)"

# Piped into sh, $0 is the shell, not this file, so there is no checkout.
DIR=
case $0 in */install.sh | install.sh) DIR=$(cd "$(dirname "$0")" && pwd) ;; esac

if [ -n "$DIR" ] && [ -f "$DIR/packages/cli/src/main.ts" ]; then
  cd "$DIR"
  command -v pnpm >/dev/null || npm install -g pnpm@12.16.1
  pnpm install --prod --frozen-lockfile
  BIN=${CPART_BIN_DIR:-$HOME/.local/bin}
  mkdir -p "$BIN"
  printf '#!/bin/sh\nexec node "%s/packages/cli/src/main.ts" "$@"\n' "$DIR" >"$BIN/cpart"
  chmod +x "$BIN/cpart"
  echo "Installed $BIN/cpart, running from $DIR"
else
  # A global prefix this user cannot write to (Node from a system package) would
  # need sudo. Install under ~/.local instead.
  PREFIX=$(npm prefix -g)
  if [ -w "$PREFIX/lib" ] 2>/dev/null || { [ ! -e "$PREFIX/lib" ] && [ -w "$PREFIX" ]; }; then
    npm install -g "$PACKAGE"
    BIN=$PREFIX/bin
  else
    npm install -g --prefix "$HOME/.local" "$PACKAGE"
    BIN=$HOME/.local/bin
  fi
  echo "Installed $BIN/cpart"
fi

case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add it to your PATH:  export PATH=\"$BIN:\$PATH\"" ;; esac
echo "Next:  cpart setup --relay <wss://host>     or, with a code someone sent you:  cpart join <code> <what you call them>"
