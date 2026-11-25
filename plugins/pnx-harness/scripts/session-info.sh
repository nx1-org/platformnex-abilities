#!/usr/bin/env bash
# SessionStart hook. Prints a short notice each time Claude Code opens or resumes, so a developer sees what is
# left to set up. It never blocks and always exits 0. Because it runs from this plugin, seeing it also tells you
# the plugin's hooks are loaded; if it does not appear, the plugin is not enabled for you.
#
# Checks, each cheap and each bounded in time:
#   pnx installed, new enough for `pnx dev setup`, and signed in
#   kubectl's current context is not a production cluster
#   this repository (only an nx1-org or ivedha-tech one) has the harness files the Improve check looks for
#
# Test seams: PNX_BIN, PNX_CONFIG, KUBECTL_BIN, PNX_HARNESS_ORG, CLAUDE_PROJECT_DIR.
set -uo pipefail

GUIDE="https://github.com/nx1-org/platformnex-abilities/blob/main/engineering-harness/docs/06-developer-setup.md"
orgs="${PNX_HARNESS_ORG:-nx1-org ivedha-tech}"
root="${CLAUDE_PROJECT_DIR:-$PWD}"
todo=()

tmpf="$(mktemp 2>/dev/null || echo /dev/null)"
trap 'rm -f "$tmpf" "$tmpf.timeout"' EXIT

# with_timeout <seconds> <command...>: the command's stdout in $tmpf, the command and its children killed after the
# time, and status 124 when that happened (a timeout is "couldn't tell", never a verdict). Output goes to a file,
# not a pipe, so a child that outlives the kill cannot hold this script up. macOS has no `timeout`.
with_timeout() {
  local secs="$1"; shift
  rm -f "$tmpf.timeout"
  "$@" >"$tmpf" 2>/dev/null </dev/null &
  local pid=$!
  ( sleep "$secs"; : > "$tmpf.timeout"; pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 </dev/null &
  local killer=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill "$killer" 2>/dev/null
  wait "$killer" 2>/dev/null
  if [ -e "$tmpf.timeout" ]; then rm -f "$tmpf.timeout"; return 124; fi
  return $rc
}

# --- pnx ---
pnx="${PNX_BIN:-pnx}"
if ! command -v "$pnx" >/dev/null 2>&1; then
  todo+=("pnx isn’t installed. It needs Node 20 or later (nvm install 22 && nvm alias default 22); the pnx-fast-dev plugin then installs it when Claude Code starts.")
else
  with_timeout 3 "$pnx" help; prc=$?
  help="$(cat "$tmpf" 2>/dev/null)"
  if [ "$prc" -ne 124 ] && ! printf '%s' "$help" | grep -q 'pnx dev setup'; then
    todo+=("pnx is too old for pnx dev (no ‘pnx dev setup’). Use Node 20 or later, then restart Claude Code so pnx-fast-dev updates it.")
  fi
  cfg="${PNX_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/pnx/config.json}"
  if [ ! -f "$cfg" ]; then
    todo+=("pnx isn’t signed in: pnx login --catalog-url https://<portal host>/api/catalog (a personal API key from Account › API keys).")
  fi
fi

# --- kubectl ---
kc="${KUBECTL_BIN:-kubectl}"
if command -v "$kc" >/dev/null 2>&1; then
  with_timeout 2 "$kc" config current-context || true
  ctx="$(head -1 "$tmpf" 2>/dev/null)"
  # "prod" but not "nonprod" or "non-prod": the non-production contexts must not be flagged.
  lc="$(printf '%s' "$ctx" | tr '[:upper:]' '[:lower:]')"; lc="${lc//nonprod/}"; lc="${lc//non-prod/}"
  case "$lc" in
    *prod*) todo+=("kubectl points at a production cluster ($ctx). Switch: kubectl config use-context <a non-production context>") ;;
  esac
fi

# --- this repository ---
if git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
  origin="$(git -C "$root" remote get-url origin 2>/dev/null || true)"
  ours=""
  for o in $orgs; do case "$origin" in *github.com[:/]"$o"/*) ours=1 ;; esac; done
  case "$ours" in
    1)
      top="$(git -C "$root" rev-parse --show-toplevel 2>/dev/null || echo "$root")"
      missing=0
      [ -f "$top/scripts/check-gates.sh" ] || missing=$((missing + 1))
      [ -d "$top/docs/specs" ] || missing=$((missing + 1))
      [ -d "$top/docs/adr" ] || missing=$((missing + 1))
      [ -f "$top/.claude/settings.json" ] || missing=$((missing + 1))
      [ -n "$(find "$top" "$top/.github" "$top/docs" -maxdepth 1 -iname 'pull_request_template*' 2>/dev/null | head -1)" ] || missing=$((missing + 1))
      grep -qi 'which skill when' "$top/CLAUDE.md" 2>/dev/null || missing=$((missing + 1))
      owners=""
      for f in .github/CODEOWNERS CODEOWNERS docs/CODEOWNERS; do [ -f "$top/$f" ] && { owners="$top/$f"; break; }; done
      { [ -n "$owners" ] && grep -v '^[[:space:]]*#' "$owners" 2>/dev/null | grep -q 'CLAUDE\.md'; } || missing=$((missing + 1))
      if [ "$missing" -gt 0 ]; then
        todo+=("This repository is missing $missing of 7 harness items. In PlatformNEX, open the component’s Improve tab and use Fix this on “Set up for the engineering harness” (the check must be switched on in Administration › Scorecards).")
      fi
      ;;
  esac
fi

if [ "${#todo[@]}" -eq 0 ]; then
  echo "pnx-harness is on: guard hooks are active and your setup looks complete."
else
  echo "pnx-harness is on: guard hooks are active. Still to set up:"
  for t in "${todo[@]}"; do echo "  - $t"; done
  echo "Guide: $GUIDE"
fi
exit 0
