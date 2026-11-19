#!/usr/bin/env bash
# Cold-reboot restage in one command (S224; hosted-read.md, "Cold reboot"). Idempotent: run it again any time.
#
#   scripts/arm.sh [<out-dir>]      default <out-dir>: /workspaces/captures/<UTC date>
#
# 1. Restores the user-level Claude Code attribution setting ({"commit": "", "pr": ""}) and `.claude/` in
#    .git/info/exclude, both lost with a deleted Codespace.
# 2. Checks: origin/main fetched and printed; FLY_API_TOKEN present (repo secret, re-injected at creation; never
#    printed); flyctl installed and authenticated (installs flyctl if missing); the READER_* names present, by name.
# 3. Arms the two pollers under nohup, unless already running from this <out-dir>:
#      scripts/fly-log-poll.mjs  -> <out-dir>/log.txt, <out-dir>/caller.log   (the log / UA poller, R-S221-6)
#      scripts/ready-watch.mjs   -> <out-dir>/ready.log                        (public /ready edges)
#    with their pids in <out-dir>/*.pid and their stderr in <out-dir>/*.err.
#
# NOT load-bearing (hosted-read.md, "Non-terminal-resident check"): everything this arms dies with the Codespace.
# The READY edge of record is the Sentry uptime monitor; a capture window that a Codespace loss interrupts is a
# GAP, stated with its bounds, never stitched.
set -euo pipefail

repo=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
cd "$repo"
dir=${1:-/workspaces/captures/$(date -u +%Y-%m-%d)}
mkdir -p "$dir"

# 1. attribution + exclude
settings="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"
node -e '
const fs = require("fs"); const f = process.argv[1];
const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
j.attribution = { commit: "", pr: "" };
fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");' "$settings"
grep -qx '.claude/' .git/info/exclude 2>/dev/null || echo '.claude/' >> .git/info/exclude
echo "attribution restored in $settings; .claude/ excluded"

# 2. checks
git fetch -q origin && echo "origin/main $(git rev-parse origin/main)"
if [ -n "${FLY_API_TOKEN:-}" ]; then echo "FLY_API_TOKEN present"; else echo "FLY_API_TOKEN MISSING: stop" >&2; exit 1; fi
if [ ! -x "$HOME/.fly/bin/flyctl" ]; then curl -fsSL https://fly.io/install.sh | sh >/dev/null; fi
"$HOME/.fly/bin/flyctl" version | head -1
"$HOME/.fly/bin/flyctl" auth whoami >/dev/null && echo "flyctl authenticated (token)"
echo "READER_* names: $(env | grep -o '^READER_[A-Z0-9_]*' | sort | tr '\n' ' ')"

# 3. pollers
arm() { # name script
  local pidf="$dir/$1.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then echo "$1 already running (pid $(cat "$pidf"))"; return; fi
  nohup node "$2" "$dir" >/dev/null 2>>"$dir/$1.err" &
  echo $! > "$pidf"
  echo "$1 armed (pid $!) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
arm fly-log-poll scripts/fly-log-poll.mjs
arm ready-watch scripts/ready-watch.mjs
echo "out-dir $dir: log.txt caller.log ready.log"
