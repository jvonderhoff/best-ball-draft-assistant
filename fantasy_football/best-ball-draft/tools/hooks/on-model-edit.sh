#!/usr/bin/env bash
#
# PostToolUse hook: when a scoring file is edited, diff every player's score.
#
# Wired in .claude/settings.json. The point is that it does NOT depend on anyone
# remembering to run it — three regressions in one week shipped with the lesson
# already written down in V2_DESIGN and STATUS, so a doc was demonstrably not enough.
#
# Reads the tool payload on stdin and does nothing unless the edited file is one that
# can change a recommendation. Emits its output as `additionalContext` so the diff
# lands in the model's context rather than only in the transcript.
set -uo pipefail

f=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)
[[ -z "$f" ]] && exit 0

case "$f" in
  */best-ball-draft/static/recommender-v2.js|*/best-ball-draft/static/recommender.js)
    root="${f%/static/*}" ;;
  */projections/analysis/payload.py)
    root="${f%/projections/analysis/payload.py}/best-ball-draft" ;;
  *) exit 0 ;;
esac

[[ -x "$root/tools/check-model-change.js" || -f "$root/tools/check-model-change.js" ]] || exit 0

# Never fail the edit. A verification tool that can block work gets disabled, and then
# it verifies nothing — the same fate as a warning that cries wolf.
out=$(cd "$root" && node tools/check-model-change.js 2>&1 | tail -60) || true
[[ -z "$out" ]] && exit 0

jq -n --arg o "$out" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ("A scoring file changed. Every player was re-scored on real boards:\n\n"
      + $o
      + "\n\nCheck that every mover is one you intended. If a change meant for a few players moved hundreds, it is re-weighting something else — that is how the sigma regression shipped.")
  }
}'
