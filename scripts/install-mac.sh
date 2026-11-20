#!/bin/bash
# Makes Afterglow start automatically when you log in to this Mac, and restart if it stops.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LABEL="com.afterglow.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js was not found. Install it first, for example with: brew install node" >&2
  exit 1
fi
if [ ! -f "$ROOT/dist/server.js" ]; then
  echo "Afterglow has not been built yet. Run 'npm install' and 'npm run build' first." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/dist/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$ROOT/data/afterglow.log</string>
  <key>StandardErrorPath</key>
  <string>$ROOT/data/afterglow.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Afterglow is running and will start whenever you log in."
echo "Open http://localhost:${PORT:-4680} (the port in .env, if you changed it)."
echo "Log file: $ROOT/data/afterglow.log"
