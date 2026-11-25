#!/usr/bin/env bash
# Test for the start-up notice (scripts/session-info.sh). Fake pnx and kubectl, throwaway git repositories, no network.
#   bash plugins/pnx-harness/scripts/test-session-info.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/session-info.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0
count=0

# fakes
cat > "$tmp/pnx-new" <<'E'
#!/bin/sh
echo "pnx dev setup <system>"
E
cat > "$tmp/pnx-old" <<'E'
#!/bin/sh
echo "pnx login"
E
cat > "$tmp/pnx-slow" <<'E'
#!/bin/sh
sleep 10
echo "pnx dev setup"
E
cat > "$tmp/kube-nonprod" <<'E'
#!/bin/sh
echo "gke_acme-nonprod_us-central1_dev"
E
cat > "$tmp/kube-prod" <<'E'
#!/bin/sh
echo "gke_acme-prod_us-central1_main"
E
chmod +x "$tmp"/pnx-* "$tmp"/kube-*
: > "$tmp/signed-in.json"

repo() { # repo <dir> <origin-url> [all]  : a git repo, optionally with every harness item
  local d="$tmp/$1"
  mkdir -p "$d" && git -C "$d" init -q -b main && git -C "$d" remote add origin "$2"
  if [ "${3:-}" = all ]; then
    mkdir -p "$d/scripts" "$d/docs/specs" "$d/docs/adr" "$d/.claude" "$d/.github"
    : > "$d/scripts/check-gates.sh"; echo '{}' > "$d/.claude/settings.json"; : > "$d/.github/PULL_REQUEST_TEMPLATE.md"
    printf '# api\n\n## Which skill when\n' > "$d/CLAUDE.md"
    printf '* @acme/team\n/CLAUDE.md @acme/team\n' > "$d/.github/CODEOWNERS"
  fi
  echo "$d"
}
good_repo="$(repo good git@github.com:nx1-org/api.git all)"
bare_repo="$(repo bare git@github.com:ivedha-tech/api.git)"
other_repo="$(repo other git@github.com:someone/else.git)"
mkdir -p "$tmp/nogit"

run() { # run <label> <env...>  -> sets $out, $rc
  PNX_BIN="$tmp/pnx-new" PNX_CONFIG="$tmp/signed-in.json" KUBECTL_BIN="$tmp/kube-nonprod" CLAUDE_PROJECT_DIR="$good_repo" env "${@:2}" bash "$script" > "$tmp/out.txt" 2>&1
  rc=$?
  out="$(cat "$tmp/out.txt")"
}
has() { printf '%s' "$out" | grep -qF -- "$1"; }
check() { # check <label> <condition result 0|1>
  count=$((count + 1))
  if [ "$2" -eq 0 ]; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s\n' "$1"; printf '%s\n' "$out" | sed 's/^/        /'; fail=1; fi
}

run base
has 'looks complete'; check "everything set up: one line, says it is complete" $?
[ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1 ]; check "everything set up: exactly one line" $?
has 'guard hooks are active'; check "says the guard hooks are active" $?
! has 'Guide:'; check "no guide link when nothing is missing" $?
[ $rc -eq 0 ]; check "exits 0" $?

run missing-pnx PNX_BIN="$tmp/does-not-exist"
has 'pnx isn’t installed'; check "pnx missing is named" $?
has 'Guide: https://github.com/nx1-org/platformnex-abilities'; check "a missing item adds the guide link" $?
[ $rc -eq 0 ]; check "still exits 0" $?

run old-pnx PNX_BIN="$tmp/pnx-old"
has 'too old'; check "an old pnx is named" $?

run signed-out PNX_CONFIG="$tmp/nope.json"
has 'isn’t signed in'; check "no pnx login is named" $?
! has 'isn’t installed'; check "…and only that" $?

run prod KUBECTL_BIN="$tmp/kube-prod"
has 'production cluster (gke_acme-prod_us-central1_main)'; check "a production kubectl context is named with its name" $?
has 'use-context'; check "…with the command to leave it" $?

for name in gke_ivedha-mgmt-env-nonprod_us-central1_mgmt-nonprod connectgateway_ivedha-workload-env-nonprod_global_workload-nonprod gke_prj-dev-platform-next_us-central1-a_platformnex-dev-gke gke_acme-non-prod_eu_x; do
  printf '#!/bin/sh\necho "%s"\n' "$name" > "$tmp/kube-named"; chmod +x "$tmp/kube-named"
  run "ctx-$name" KUBECTL_BIN="$tmp/kube-named"
  ! has 'production cluster'; check "a non-production context is not flagged: $name" $?
done
for name in gke_ivedha-mgmt-env-prod_us-central1_mgmt-prod connectgateway_ivedha-workload-env-prod_global_workload-prod GKE_Acme_PROD; do
  printf '#!/bin/sh\necho "%s"\n' "$name" > "$tmp/kube-named"; chmod +x "$tmp/kube-named"
  run "ctx-$name" KUBECTL_BIN="$tmp/kube-named"
  has 'production cluster'; check "a production context is flagged: $name" $?
done

run no-kubectl KUBECTL_BIN="$tmp/does-not-exist"
has 'looks complete'; check "no kubectl is not a problem" $?

run bare CLAUDE_PROJECT_DIR="$bare_repo"
has 'missing 7 of 7 harness items'; check "an ivedha-tech repo with nothing is missing 7 of 7" $?
has 'Improve tab'; check "…and says where to fix it" $?

mkdir -p "$bare_repo/docs/specs" "$bare_repo/docs/adr" "$bare_repo/scripts"; : > "$bare_repo/scripts/check-gates.sh"
run partial CLAUDE_PROJECT_DIR="$bare_repo"
has 'missing 4 of 7 harness items'; check "partway: gate script and two folders in place, 4 of 7 missing" $?

run other-org CLAUDE_PROJECT_DIR="$other_repo"
has 'looks complete'; check "a repository outside the organisation gets no repository advice" $?

run no-git CLAUDE_PROJECT_DIR="$tmp/nogit"
has 'looks complete'; check "a folder that is not a git repository gets none either" $?

printf '# api\n\n## Which skill when\n' > "$good_repo/CLAUDE.md"; printf '# nothing\n* @acme/team\n# /CLAUDE.md @acme/team\n' > "$good_repo/.github/CODEOWNERS"
run commented-rule
has 'missing 1 of 7 harness items'; check "a CODEOWNERS rule for CLAUDE.md that is only a comment does not count" $?

run everything-wrong PNX_BIN="$tmp/does-not-exist" KUBECTL_BIN="$tmp/kube-prod" CLAUDE_PROJECT_DIR="$bare_repo"
[ "$(printf '%s\n' "$out" | grep -c '^  - ')" -ge 3 ]; check "several problems are listed as separate bullets" $?
[ $rc -eq 0 ]; check "exits 0 even when everything is wrong" $?

start=$(date +%s)
run slow PNX_BIN="$tmp/pnx-slow"
elapsed=$(( $(date +%s) - start ))
[ "$elapsed" -le 6 ]; check "a hung pnx cannot hold Claude Code up (took ${elapsed}s)" $?
! has 'too old'; check "…and is not called old, since we could not tell" $?
! has 'isn’t installed'; check "…or missing" $?

if [ $fail -eq 0 ]; then echo "All $count notice tests passed."; else echo "Some notice tests FAILED."; fi
exit $fail
