#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${0:A:h}"
ELECTRON_APP="$PROJECT_DIR/node_modules/electron/dist/Electron.app"

if [[ ! -d "$ELECTRON_APP" ]]; then
  print -u2 "Electron is not installed. Run: cd \"$PROJECT_DIR\" && npm install"
  exit 1
fi

open -n "$ELECTRON_APP" --args "$PROJECT_DIR"
