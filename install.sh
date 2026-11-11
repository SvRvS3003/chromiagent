#!/usr/bin/env bash
# Chromiagent installer, by SvRvS.
#   install:    curl -fsSL https://raw.githubusercontent.com/SvRvS3003/chromiagent/main/install.sh | bash
#   uninstall:  curl -fsSL https://raw.githubusercontent.com/SvRvS3003/chromiagent/main/install.sh | bash -s -- --uninstall
set -euo pipefail

REPO="https://github.com/SvRvS3003/chromiagent.git"
DIR="${CHROMIAGENT_DIR:-$HOME/.chromiagent}"
LABEL="uz.svrvs.chromiagent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$DIR"
  say "Removed. Also remove the extension in chrome://extensions."
  exit 0
fi

[ "$(uname)" = "Darwin" ] || die "Chromiagent currently supports macOS only."
command -v git >/dev/null || die "git is required. Run: xcode-select --install"
NODE="$(command -v node)" || die "Node.js 22.13+ is required: https://nodejs.org"
"$NODE" -e 'process.exit(typeof require("node:module").stripTypeScriptTypes === "function" ? 0 : 1)' 2>/dev/null \
  || die "Node.js 22.13+ is required for TypeScript code mode (found $("$NODE" -v))."
command -v claude >/dev/null || say "Claude Code was not found. Install it before using the panel: npm install -g @anthropic-ai/claude-code"

say "Downloading to $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q --ff-only; else git clone -q --depth 1 "$REPO" "$DIR"; fi

say "Installing dependencies"
(cd "$DIR" && npm install --omit=dev --no-audit --no-fund --silent)
# npm may skip install scripts; node-pty's helper must be executable or the terminal cannot start.
chmod +x "$DIR"/node_modules/node-pty/prebuilds/*/spawn-helper "$DIR"/host/*.sh

say "Starting the local host (starts again automatically at login)"
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/host/server.js</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>SHELL</key><string>/bin/zsh</string>
    <key>HOME</key><string>$HOME</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/chromiagent.log</string>
  <key>StandardErrorPath</key><string>/tmp/chromiagent.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  nc -z 127.0.0.1 17371 2>/dev/null && break
  sleep 0.5
done
nc -z 127.0.0.1 17371 2>/dev/null || die "Host did not start. See /tmp/chromiagent.log"

printf '%s' "$DIR/extension" | pbcopy
osascript -e 'tell application "Google Chrome" to activate' -e 'tell application "Google Chrome" to open location "chrome://extensions/"' >/dev/null 2>&1 || true

cat <<DONE

$(printf '\033[1;32m')Chromiagent host is running.$(printf '\033[0m') Last step, in the Chrome tab that just opened:

  1. Turn on "Developer mode" (top right).
  2. Click "Load unpacked", press Cmd+Shift+G, paste (Cmd+V), press Enter, then "Select".
     Folder (already copied): $DIR/extension
  3. Click the puzzle icon in the toolbar and pin "Chromiagent".

Click the sparkle icon (or press Alt+A) to open the agent panel.
DONE
