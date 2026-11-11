#!/usr/bin/env bash
# Chromiagent installer for macOS and Linux, by SvRvS. (Windows: install.ps1)
#   install:    curl -fsSL https://raw.githubusercontent.com/SvRvS3003/chromiagent/main/install.sh | bash
#   uninstall:  curl -fsSL https://raw.githubusercontent.com/SvRvS3003/chromiagent/main/install.sh | bash -s -- --uninstall
set -euo pipefail

REPO="https://github.com/SvRvS3003/chromiagent.git"
DIR="${CHROMIAGENT_DIR:-$HOME/.chromiagent}"
LABEL="uz.svrvs.chromiagent"
OS="$(uname)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT="$HOME/.config/systemd/user/chromiagent.service"
LOG="${TMPDIR:-/tmp}/chromiagent.log"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

stop_host() {
  if [ "$OS" = "Darwin" ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  else
    systemctl --user disable --now chromiagent 2>/dev/null || true
    pkill -f "$DIR/host/server.js" 2>/dev/null || true
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  stop_host
  rm -f "$PLIST" "$UNIT"
  rm -rf "$DIR"
  say "Removed. Also remove the extension on your browser's extensions page."
  exit 0
fi

case "$OS" in Darwin|Linux) ;; *) die "Use install.ps1 on Windows." ;; esac
command -v git >/dev/null || die "git is required."
NODE="$(command -v node)" || die "Node.js 22.13+ is required: https://nodejs.org"
"$NODE" -e 'process.exit(typeof require("node:module").stripTypeScriptTypes === "function" ? 0 : 1)' 2>/dev/null \
  || die "Node.js 22.13+ is required (found $("$NODE" -v))."
command -v claude >/dev/null || say "Claude Code was not found. Install it before using the panel: npm install -g @anthropic-ai/claude-code"

say "Downloading to $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q --ff-only; else git clone -q --depth 1 "$REPO" "$DIR"; fi

say "Installing dependencies"
(cd "$DIR" && npm install --omit=dev --no-audit --no-fund --silent)
PREBUILD="$DIR/node_modules/node-pty/prebuilds/$("$NODE" -p 'process.platform + "-" + process.arch')"
if [ -d "$PREBUILD" ]; then
  # npm may skip install scripts; the helper must be executable or the terminal cannot start.
  chmod +x "$PREBUILD/spawn-helper" 2>/dev/null || true
else
  say "Building the terminal module for $(uname -m) (needs make, a C++ compiler and python3)"
  (cd "$DIR/node_modules/node-pty" && npx --yes node-gyp rebuild >/dev/null) \
    || die "Build failed. Install build tools (Debian/Ubuntu: sudo apt install build-essential python3) and run again."
fi

say "Starting the local host (starts again automatically at login)"
stop_host
if [ "$OS" = "Darwin" ]; then
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/host/server.js</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>SHELL</key><string>${SHELL:-/bin/zsh}</string>
    <key>HOME</key><string>$HOME</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PLIST
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
elif command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<UNIT
[Unit]
Description=Chromiagent local host (by SvRvS)

[Service]
ExecStart=$NODE $DIR/host/server.js
Environment=SHELL=${SHELL:-/bin/bash}
Environment=PATH=$PATH
Restart=always

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now chromiagent
else
  nohup "$NODE" "$DIR/host/server.js" >"$LOG" 2>&1 &
  say "No systemd user session: the host runs now, but will not start at login. Re-run this installer after reboot."
fi

ok=""
for _ in $(seq 1 20); do
  if "$NODE" -e 'require("net").connect(17371, "127.0.0.1").on("connect", () => process.exit(0)).on("error", () => process.exit(1))'; then ok=1; break; fi
  sleep 0.5
done
[ -n "$ok" ] || die "Host did not start. See $LOG"

EXT="$DIR/extension"
copied=""
if command -v pbcopy >/dev/null; then printf '%s' "$EXT" | pbcopy && copied=" (copied)"
elif command -v wl-copy >/dev/null; then printf '%s' "$EXT" | wl-copy && copied=" (copied)"
elif command -v xclip >/dev/null; then printf '%s' "$EXT" | xclip -selection clipboard && copied=" (copied)"
fi
if [ "$OS" = "Darwin" ] && [ -d "/Applications/Google Chrome.app" ]; then
  osascript -e 'tell application "Google Chrome" to activate' -e 'tell application "Google Chrome" to open location "chrome://extensions/"' >/dev/null 2>&1 || true
fi

cat <<DONE

$(printf '\033[1;32m')Chromiagent host is running.$(printf '\033[0m') Last step, in your browser:

  1. Open the extensions page: chrome://extensions  (Edge: edge://extensions, Brave: brave://extensions)
  2. Turn on "Developer mode".
  3. Click "Load unpacked" and choose this folder$copied:
     $EXT
  4. Pin "Chromiagent" from the puzzle icon in the toolbar.

Click the sparkle icon (or press Alt+A) to open the agent panel.
DONE
