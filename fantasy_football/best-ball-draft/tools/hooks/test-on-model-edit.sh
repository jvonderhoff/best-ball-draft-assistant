#!/usr/bin/env bash
#
# Tests for on-model-edit.sh. Run it: tools/hooks/test-on-model-edit.sh
#
# This repo has no test suite and says so on purpose — verification is by running the
# thing. That holds for the model, where the harness IS the test. It does not hold for a
# hook, because a hook has no output when it is working correctly, so a broken one and a
# quiet one look identical. Both bugs below were written and shipped inside one sitting
# on 2026-08-27, and neither raised anything:
#
#   * the comparison could never match, so the hook fired on EVERY Bash call, ran a
#     20-second diff, and reported "none moved" every time
#   * the first manual test appeared to pass while comparing a file against itself
#
# Uses BBA_MODEL_FILES so it never touches real scoring code, and its own
# XDG_CACHE_HOME so it cannot clobber the live state file.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hook="$here/on-model-edit.sh"

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export XDG_CACHE_HOME="$tmp/cache"
watched="$tmp/scoring.js"
export BBA_MODEL_FILES="$watched"
export BBA_DIFF_CMD="echo SIMULATED-DIFF"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
run() { echo '{}' | bash "$hook" 2>/dev/null; }

echo "const x = 1;" > "$watched"

# 1 — first run records a baseline and stays quiet. Without this the hook fires on the
#     next command after a fresh clone, reporting a change nobody made.
[[ -z "$(run)" ]] && ok "first run is silent (records a baseline)" \
                  || bad "first run should be silent"

# 2 — the bug that would have got the hook switched off inside a day.
[[ -z "$(run)" ]] && ok "unchanged file is silent" || bad "fired with nothing changed"
[[ -z "$(run)" ]] && ok "still silent on a third run" || bad "fired on a repeat run"

# 3 — the hole this rewrite exists to close: a change made by any means at all. No
#     file_path in the payload, no tool name, just different bytes on disk.
echo "const x = 2;" > "$watched"
out=$(run)
[[ -n "$out" ]] && ok "fires on a content change with nothing in the payload" \
                || bad "MISSED a changed file — this is the original bug"
grep -q SIMULATED-DIFF <<<"$out" && ok "carries the diff output" || bad "no diff in output"
python3 -c "import json,sys; json.load(sys.stdin)" <<<"$out" >/dev/null 2>&1 \
  && ok "emits valid JSON" || bad "output is not valid JSON"

# 4 — having reported once, it must settle. A hook that keeps reporting the same change
#     is the crying-wolf failure with extra steps.
[[ -z "$(run)" ]] && ok "silent again once the change is reported" \
                  || bad "re-reported the same change"

# 5 — a deleted or missing watched file must not wedge it.
rm -f "$watched"
run >/dev/null 2>&1; [[ $? -eq 0 ]] && ok "exits 0 when a watched file is missing" \
                                    || bad "non-zero exit on a missing file"

echo
echo "  $pass passed, $fail failed"
[[ $fail -eq 0 ]]
