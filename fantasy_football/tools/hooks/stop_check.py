"""Stop hook: the agent cannot say "done" while a rule or a touched project is red.

Wired in `.claude/settings.json` as a Stop hook. Written 2026-10-15 because
`tools/check_rules.py` and every project's tests only help if somebody remembers to
run them, and "somebody remembers" is the failure the best-ball model hook was built to
remove (see best-ball-draft/tools/hooks/on-model-edit.sh, three regressions in a week
with the lesson already written down).

What it runs, every time the agent stops:
  1. tools/check_rules.py (under a second).
  2. The pytest suite of each project whose Python files CHANGED since this hook last
     ran it (projections ~2s, sleeper ~1s, dfs ~10s on 2026-10-15).

Why changes are found by hashing FILES, not by reading the tool payload: the model
hook's first version keyed on `tool_input.file_path`, and both model changes that week
were made with `sed` and slipped past it. A hash catches an edit however it was made.

Why only red caused IN THIS SESSION blocks: a project that was already red, and that
this session never touched, is not this session's to fix, and blocking on it would
stop every unrelated task. It is still reported.

Why it never blocks twice in a row (`stop_hook_active`): a hook that traps the agent in
a loop is a failure of its own. After one blocked stop it hands the result to the user,
loudly, and lets the turn end.

Exit codes (Claude Code Stop hooks): 0 = let it stop; 2 = block, stderr goes to the
agent as the reason. Anything printed as JSON on stdout with `systemMessage` is shown
to the user.
"""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

# STOP_CHECK_ROOT exists so the hook can be proven against a scratch copy that is
# broken on purpose (tools/hooks/test_stop_check.sh); in use it is never set.
ROOT = Path(os.environ.get('STOP_CHECK_ROOT') or Path(__file__).resolve().parents[2])
STATE = ROOT / '.claude' / 'hook-state' / 'stop_check.json'
TESTED = ['projections', 'sleeper', 'dfs']          # best-ball has no pytest suite
SKIP_DIRS = {'.venv', 'node_modules', '__pycache__', '.git', '.claude'}
TAIL = 25                                           # lines of failure shown to the agent


def tree_hash(project):
    h = hashlib.sha256()
    for p in sorted((ROOT / project).rglob('*.py')):
        rel = p.relative_to(ROOT / project)
        if SKIP_DIRS.intersection(rel.parts):
            continue
        h.update(str(rel).encode())
        h.update(p.read_bytes())
    return h.hexdigest()


def python_for(project):
    py = ROOT / project / '.venv' / 'bin' / 'python'
    return str(py) if py.exists() else None


def run(cmd, cwd):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=240)
    out = (r.stdout + r.stderr).strip().splitlines()
    return r.returncode, out


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        event = {}
    session = event.get('session_id', '')
    retry = bool(event.get('stop_hook_active'))

    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    problems, notes = [], []

    # 1. The umbrella rules. Run with any project's 3.11 venv (it is stdlib only).
    py = next(filter(None, (python_for(p) for p in TESTED)), None)
    if py is None:
        notes.append('no project venv found, so nothing was checked')
    else:
        rc, out = run([py, 'tools/check_rules.py'], ROOT)
        if rc != 0:
            problems.append('tools/check_rules.py FAILED:\n' + '\n'.join(out))

    # 2. Tests, for the projects whose files changed since this hook last tested them.
    # A missing project (a session worktree has none of the nested repos) is said once
    # per session: a skip must be visible, but a banner repeated on every stop is one
    # nobody reads (best-ball-draft/CLAUDE.md, the stale bar).
    absent = [p for p in TESTED if not (ROOT / p).is_dir()]
    if absent and state.get('_absent_told') != session:
        notes.append(f'{", ".join(absent)}: absent here, not tested')
        state['_absent_told'] = session
    for proj in TESTED:
        if proj in absent:
            continue
        h = tree_hash(proj)
        prev = state.get(proj, {})
        if h != prev.get('hash'):
            ppy = python_for(proj)
            if ppy is None:
                notes.append(f'{proj}: changed, but has no .venv to test with')
                continue
            rc, out = run([ppy, '-m', 'pytest', 'tests/', '-q', '-x', '-p', 'no:cacheprovider'],
                          ROOT / proj)
            prev = {'hash': h, 'ok': rc == 0, 'session': session,
                    'summary': out[-1] if out else '', 'tail': out[-TAIL:]}
            state[proj] = prev
            notes.append(f'{proj}: changed, tested: {prev["summary"]}')
        if not prev.get('ok', True):
            if prev.get('session') == session:
                problems.append(f'{proj} tests FAILED (files changed in this session):\n'
                                + '\n'.join(prev.get('tail', [])))
            else:
                notes.append(f'{proj}: red since an earlier session and untouched here, '
                             f'not blocking: {prev.get("summary")}')

    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1))

    if not problems:
        if notes:
            print(json.dumps({'systemMessage': 'stop check: ' + '; '.join(notes)}))
        return 0
    report = '\n\n'.join(problems)
    if retry:
        # Already blocked once this turn: do not loop. Tell the human instead.
        print(json.dumps({'systemMessage': 'STOP CHECK STILL RED after one retry, '
                          'needs you:\n' + report[:2000]}))
        return 0
    print('Not done yet: the stop check is red. Fix this, then finish.\n\n' + report,
          file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())
