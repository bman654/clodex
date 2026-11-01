#!/usr/bin/env bash
# launchd entry point for the clodex patch canary. Mirrors my-pr-queue-cron.sh.
set -euo pipefail

# uncomment this line to temporarily disable the canary
#exit 0

# launchd clobbers HOME to match WorkingDirectory on macOS; force it back.
export HOME="/Users/brandon"
export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

# launchd appends to this file forever and rotates nothing.
# Truncate in place rather than renaming: launchd opened this path before starting us and keeps
# writing to that inode, so a `mv` would send this run's entire output to an unlinked file.
LAUNCHD_LOG="$HOME/Library/Logs/clodex-patch-canary.log"
if [ -f "$LAUNCHD_LOG" ] && [ "$(stat -f %z "$LAUNCHD_LOG")" -gt 5242880 ]; then
  if tail -c 1048576 "$LAUNCHD_LOG" > "$LAUNCHD_LOG.tmp"; then
    cat "$LAUNCHD_LOG.tmp" > "$LAUNCHD_LOG"
  fi
  rm -f "$LAUNCHD_LOG.tmp"
fi

echo "[$(date -Iseconds)] clodex-patch-canary starting (HOME=$HOME PWD=$PWD)"
exec "$HOME/.local/bin/clodex-patch-canary.sh" "$@"
