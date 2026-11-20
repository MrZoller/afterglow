#!/bin/bash
# Stops Afterglow from starting automatically. Your saved looks and schedules are kept.
set -euo pipefail

LABEL="com.afterglow.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Afterglow no longer starts automatically."
