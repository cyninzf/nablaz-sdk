#!/usr/bin/env bash
# Reader env-names guard: the reader's four RPC env names live in one place, packages/reader/src/chains.ts
# (CHAINS[<id>].rpcEnv and .groundingRpcEnv); everything else imports them from there.
# Fails on any literal occurrence of one of the four names in a tracked *.ts, *.mts, *.mjs, *.js or *.sh file
# (comments included), outside:
#   - packages/reader/src/chains.ts, the canonical module;
#   - scripts/reader-start.sh, the one allowlisted file: shell cannot import the module, and its fail-closed
#     ${VAR:?} checks on the four names are the production start path.
# *.md files and the workflow (.github/workflows/ci.yml maps the Actions secrets into the names) are not scanned.
# The canonical module must still hold all four names.
#   scripts/check-env-names.sh
#   scripts/check-env-names.sh --self-test
set -euo pipefail

# A pattern, not a literal: this file must pass its own check.
NAMES='READER_(ARBITRUM|BASE)(_GROUNDING)?_RPC_URL'
CANONICAL='packages/reader/src/chains.ts'
ALLOW=("$CANONICAL" 'scripts/reader-start.sh')

# Run in a git work tree; prints every offending line and returns 1 on any.
check() {
  local bad=0 hits files f skip a
  files=$(git ls-files -- '*.ts' '*.mts' '*.mjs' '*.js' '*.sh')
  for f in $files; do
    skip=0
    for a in "${ALLOW[@]}"; do [ "$f" = "$a" ] && skip=1; done
    [ "$skip" -eq 1 ] && continue
    hits=$(grep -nE "$NAMES" -- "$f" || true)
    if [ -n "$hits" ]; then
      sed "s|^|$f:|" <<<"$hits"
      bad=1
    fi
  done
  if [ ! -f "$CANONICAL" ] || [ "$(grep -oE "$NAMES" -- "$CANONICAL" | sort -u | wc -l)" -ne 4 ]; then
    echo "$CANONICAL no longer holds the four reader RPC env names"
    bad=1
  fi
  if [ "$bad" -ne 0 ]; then
    echo "env-names guard: import the reader RPC env names from $CANONICAL (CHAINS[<id>].rpcEnv / .groundingRpcEnv) instead of writing them out"
    return 1
  fi
  echo "env-names guard: no literal reader RPC env name outside $CANONICAL and the allowlist"
}

if [ "${1:-}" = "--self-test" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  git -C "$tmp" init -q
  mkdir -p "$tmp/packages/reader/src" "$tmp/scripts" "$tmp/lib"
  # The four names, assembled so that no literal appears in this file.
  n() { printf 'READER_%s_RPC_URL' "$1"; }
  {
    for x in ARBITRUM ARBITRUM_GROUNDING BASE BASE_GROUNDING; do printf 'export const e = "%s";\n' "$(n "$x")"; done
  } >"$tmp/packages/reader/src/chains.ts"
  printf ': "${%s:?}"\n' "$(n BASE)" >"$tmp/scripts/reader-start.sh"
  printf 'export const ok = CHAINS[8453]!.rpcEnv;\n' >"$tmp/lib/clean.ts"
  printf '# %s\n' "$(n BASE)" >"$tmp/README.md"
  git -C "$tmp" add -A
  (cd "$tmp" && check >/dev/null) || { echo "self-test: a clean tree was flagged"; exit 1; }
  for planted in "lib/a.ts:const u = process.env.$(n BASE_GROUNDING);" "lib/b.mjs:// set $(n ARBITRUM) first" "scripts/c.sh:echo \"\$$(n BASE)\""; do
    file="${planted%%:*}"
    printf '%s\n' "${planted#*:}" >"$tmp/$file"
    git -C "$tmp" add -A
    if (cd "$tmp" && check >/dev/null); then echo "self-test: a literal in $file was not flagged"; exit 1; fi
    git -C "$tmp" rm -q -f "$file"
  done
  sed -i '1d' "$tmp/packages/reader/src/chains.ts"
  git -C "$tmp" add -A
  if (cd "$tmp" && check >/dev/null); then echo "self-test: a canonical module missing a name was not flagged"; exit 1; fi
  echo "env-names guard self-test: ok"
  exit 0
fi

check
