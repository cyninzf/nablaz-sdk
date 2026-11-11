#!/usr/bin/env bash
# Devcontainer bootstrap (R-S213-3), run once by `postCreateCommand` in .devcontainer/devcontainer.json when the
# Codespace is created. The pattern is nablaz-protocol's .devcontainer/setup.sh. It installs the tools a session
# needs: Claude Code, Foundry pinned to 1.5.1, flyctl, then the workspace's packages.
#
# Sign-in is a human step: this script never runs `claude` login, `flyctl auth`, or anything that asks for or
# stores a credential. Secrets arrive as Codespace secrets, never from here.
#
# Idempotent: safe to re-run by hand. Each step skips when its effect is already present.
set -euo pipefail
cd "$(dirname "$0")/.."

# Step a: Claude Code, installed globally.
if ! command -v claude >/dev/null 2>&1; then
  npm install -g @anthropic-ai/claude-code
fi

# Step b: Foundry pinned to 1.5.1, the version the fork tests and CI use.
if ! "$HOME/.foundry/bin/forge" --version 2>/dev/null | grep -q '^forge Version: 1\.5\.1-'; then
  [ -x "$HOME/.foundry/bin/foundryup" ] || curl -L https://foundry.paradigm.xyz | bash
  "$HOME/.foundry/bin/foundryup" -i 1.5.1
fi

# Step c: prepend ~/.foundry/bin to PATH in ~/.bashrc, once, so the pinned forge, cast and anvil win over any other.
PREPEND_LINE='export PATH="$HOME/.foundry/bin:$PATH"'
if ! grep -qF "$PREPEND_LINE" "$HOME/.bashrc" 2>/dev/null; then
  echo "$PREPEND_LINE" >> "$HOME/.bashrc"
fi

# Step d: flyctl, at ~/.fly/bin/flyctl (the path docs/runbooks/hosted-read.md uses). Install only: no `flyctl auth`.
if [ ! -x "$HOME/.fly/bin/flyctl" ]; then
  curl -L https://fly.io/install.sh | sh
fi

# Step e: the workspace's packages, exactly as locked (patches/ applied by pnpm).
pnpm install --frozen-lockfile
