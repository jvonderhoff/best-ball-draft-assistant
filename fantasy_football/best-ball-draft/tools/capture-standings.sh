#!/bin/bash
#
# Capture this week's best-ball standings and push them to /season. What launchd runs.
#
#   tools/capture-standings.sh            # capture and push now
#   tools/capture-standings.sh --quiet    # what launchd calls
#
# Same shape as ../projections/tools/news-push.sh, and the same two traps:
#
#   * BBA_API_KEY lives in ~/.zshrc, which only an INTERACTIVE shell reads. The plist
#     runs this through `zsh -ic`; `zsh -lc` will not do it.
#   * `durable=False` means Postgres refused the write. The page works right now and
#     loses the week at the next deploy or spin-down, so it exits like a failure.
#
# A missing key does NOT skip the capture. DK only ever shows standings as of now, so
# the week is archived locally either way and only the push is refused — a broken push
# path costs a stale page, not a hole in the history.
#
# What it can change in production is narrow by construction: /api/season/upload
# writes `season_snapshots` and nothing else, and nothing the recommender scores with
# reads that table.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

DRAFT_APP_URL="${DRAFT_APP_URL:-https://best-ball-draft-assistant.onrender.com}"
export DRAFT_APP_URL

QUIET=()
[[ "${1:-}" == "--quiet" ]] && QUIET=(--quiet)
stamp="$(date '+%Y-%m-%d %H:%M:%S %Z')"

if [[ -z "${BBA_API_KEY:-}" ]]; then
  echo "capture-standings $stamp: BBA_API_KEY absent — capturing to the archive only."
  echo "  Under launchd this means the plist is not invoking zsh -ic."
  .venv/bin/python tools/capture-standings.py "${QUIET[@]}"
  exit 2
fi

out="$(.venv/bin/python tools/capture-standings.py --push "${QUIET[@]}" 2>&1)"
rc=$?
echo "$out"

if grep -q 'durable=False' <<<"$out"; then
  echo "capture-standings $stamp: pushed but NOT DURABLE — Postgres unreachable; this week will not survive a deploy."
  exit 1
fi
exit $rc
