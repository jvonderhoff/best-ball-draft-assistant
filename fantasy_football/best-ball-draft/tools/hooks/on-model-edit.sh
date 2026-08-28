#!/usr/bin/env bash
#
# PostToolUse hook: when a scoring file changes, diff every player's score.
#
# Wired in .claude/settings.json. The point is that it does NOT depend on anyone
# remembering to run it — three regressions in one week shipped with the lesson
# already written down in V2_DESIGN and STATUS, so a doc was demonstrably not enough.
#
# ── Why this watches FILES rather than the tool payload (2026-08-27) ─────────────────
#
# The first version keyed off `.tool_input.file_path` and matched only Write|Edit. That
# has a hole big enough to drive both of this week's model changes through: an edit made
# with `sed`, or a python heredoc, or any other shell command arrives as a Bash payload
# with no file_path at all. On 2026-08-26 BOTH scoring files were changed that way — the
# reach-penalty fix and the component basis — and this hook never fired once. The diff
# got run by hand, which is exactly the "somebody remembers" failure the hook exists to
# remove.
#
# Adding Bash to the matcher alone does not fix it, because there is still nothing in
# the payload to key on: `sed -i '' -e '...' f.js` names its file in a string this hook
# has no business parsing. So the payload is ignored entirely and the FILES are hashed
# instead. Any mechanism that changes them — a tool, a shell command, a git checkout, an
# editor outside the session — is caught by construction, and no new tool needs a new
# case here.
set -uo pipefail

# Repo root, derived from this script's own location rather than CLAUDE_PROJECT_DIR, so
# it is correct no matter which directory the hook is invoked from.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

# Everything that can change a recommendation. payload.py lives in the OTHER repo and
# belongs here anyway: it produces the six fields V2 scores with, so a change there moves
# every score without touching a line of this one.
files=(
  "$root/static/recommender-v2.js"
  "$root/static/recommender.js"
  "$root/../projections/analysis/payload.py"
)

# Test seam. `test-on-model-edit.sh` points these at throwaway files so it can prove the
# hook fires on a change without editing real scoring code to do it — the alternative is
# a test that mutates the thing it is protecting, which is how you end up committing a
# scoring change you meant to revert. Unset in normal use.
if [[ -n "${BBA_MODEL_FILES:-}" ]]; then
  IFS=':' read -r -a files <<< "$BBA_MODEL_FILES"
  run_diff="${BBA_DIFF_CMD:-echo test-diff}"
else
  run_diff=""
fi

# State lives outside both repos: .claude/ here is tracked, and a state file that shows
# up in `git status` after every edit is one that gets committed by accident or
# gitignored by a pattern that then hides something else.
state_dir="${XDG_CACHE_HOME:-$HOME/.cache}/best-ball-draft"
state="$state_dir/model-hashes"
mkdir -p "$state_dir" 2>/dev/null || exit 0

current=""
for f in "${files[@]}"; do
  [[ -f "$f" ]] || continue
  current+="$(md5 -q "$f" 2>/dev/null || md5sum "$f" 2>/dev/null | cut -d' ' -f1)  $f"$'\n'
done
[[ -z "$current" ]] && exit 0

# Strip the trailing newline before it is ever compared or stored. `$(cat "$state")`
# strips trailing newlines and `$current` has one, so comparing them directly can never
# match — the hook fired on EVERY Bash call, ran the full diff each time, and reported
# "none moved". Harmless-looking output, twenty wasted seconds a command, and the
# fastest possible route to someone turning the hook off.
current="${current%$'\n'}"

# First run records a baseline and says nothing. Without this the hook would fire on the
# next command after a fresh clone or a cleared cache, reporting a diff nobody made.
if [[ ! -f "$state" ]]; then
  printf '%s' "$current" > "$state"
  exit 0
fi

if [[ "$current" == "$(cat "$state" 2>/dev/null)" ]]; then
  exit 0                      # nothing that scores a player has moved
fi
printf '%s' "$current" > "$state"

# Never fail the edit. A verification tool that can block work gets disabled, and then
# it verifies nothing — the same fate as a warning that cries wolf.
if [[ -n "$run_diff" ]]; then
  out=$($run_diff 2>&1 | tail -60) || true
else
  [[ -f "$root/tools/check-model-change.js" ]] || exit 0
  out=$(cd "$root" && node tools/check-model-change.js 2>&1 | tail -60) || true
fi
[[ -z "$out" ]] && exit 0

jq -n --arg o "$out" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ("A scoring file changed. Every player was re-scored on real boards:\n\n"
      + $o
      + "\n\nCheck that every mover is one you intended. If a change meant for a few players moved hundreds, it is re-weighting something else — that is how the sigma regression shipped.")
  }
}'
