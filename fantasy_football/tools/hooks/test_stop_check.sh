#!/usr/bin/env bash
#
# Proves stop_check.py blocks on red and lets green through, against a scratch copy
# of sleeper/ (the fastest suite) that is broken on purpose. A broken hook and a quiet
# one look identical from inside a session, so "it ran without complaint" proves
# nothing; each case below asserts the exit code AND what was said.
#
#   tools/hooks/test_stop_check.sh          # from fantasy_football/; ~10s
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
real="$(cd "$here/../.." && pwd)"
S="$(mktemp -d)"; trap 'rm -rf "$S"' EXIT
mkdir -p "$S/tools/hooks"
cp "$real/tools/check_rules.py" "$S/tools/"
cp "$real/tools/hooks/stop_check.py" "$S/tools/hooks/"
rsync -a --exclude=.venv --exclude=.git --exclude=__pycache__ "$real/sleeper/" "$S/sleeper/"
ln -s "$real/sleeper/.venv" "$S/sleeper/.venv"
PY="$real/sleeper/.venv/bin/python"

pass=0; fail=0
hook() {  # hook <session> <stop_hook_active> -> sets rc, out, err
    out="$(printf '{"session_id":"%s","stop_hook_active":%s}' "$1" "$2" \
        | STOP_CHECK_ROOT="$S" "$PY" "$S/tools/hooks/stop_check.py" 2>"$S/err")"; rc=$?
    err="$(cat "$S/err")"
}
expect() {  # expect <name> <want rc> <grep pattern> <in: out|err>
    local hay; [ "$4" = err ] && hay="$err" || hay="$out"
    if [ "$rc" = "$2" ] && grep -q -- "$3" <<<"$hay"; then pass=$((pass+1)); echo "ok    $1"
    else fail=$((fail+1)); echo "FAIL  $1 (rc=$rc, wanted $2 and /$3/ in $4)"; echo "      out: ${out:0:300}"; echo "      err: ${err:0:300}"; fi
}

hook s1 false; expect "first stop: sleeper is new, tested, green"        0 'sleeper: changed, tested' out
hook s1 false; expect "nothing changed: no tests rerun, quiet"            0 '' out
[ -z "$out" ] || { fail=$((fail+1)); echo "FAIL  ...but it printed: $out"; }

printf '\n\ndef test_deliberately_broken():\n    assert 1 == 2\n' >> "$S/sleeper/tests/test_weekly.py"
hook s1 false; expect "broken this session: BLOCKS, reason to the agent" 2 'sleeper tests FAILED' err
hook s1 true;  expect "still red on the retry: hands off to the user"    0 'STILL RED' out
hook s2 false; expect "other session, untouched: reported, not blocking" 0 'red since an earlier session' out

"$PY" - "$S/sleeper/tests/test_weekly.py" <<'EOF'
import sys; p = sys.argv[1]; s = open(p).read()
open(p, 'w').write(s[:s.index('\n\ndef test_deliberately_broken')] + '\n')
EOF
hook s2 false; expect "fixed: retested, green, lets it stop"             0 'sleeper: changed, tested' out

printf '\ndef normalize_name(n):\n    return n\n' >> "$S/sleeper/leagues/__init__.py"
hook s2 false; expect "an umbrella rule broken: BLOCKS"                  2 'check_rules.py FAILED' err

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
