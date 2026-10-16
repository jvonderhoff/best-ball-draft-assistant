"""Drift: where the docs, the map and memory have stopped describing the code.

Every doc here states facts that age: test counts, scheduled jobs, file paths. None
of them is wrong the day it is written, and nothing says when it becomes wrong. On
2026-10-15 the map was 24 DFS tests behind, and each README's count was a month old.
This finds that, so a person or an agent can fix it before someone acts on it.

    projections/.venv/bin/python tools/drift.py          # from fantasy_football/

Read-only and never fetches. Exits 1 when it finds drift, 0 when it finds none. Each
finding names the file to edit. Meant to be run on a schedule (see CLAUDE.md), not
as a gate: drift is a chore, not a broken build, so it is not in the Stop hook.

What it checks:
  test-counts   the map's <span data-tests="X">N</span> and each README's
                "N tests, collected DATE" against `pytest --collect-only`
  launchd       the com.bba.* / com.dfs.* jobs the map names against the plists
                installed in ~/Library/LaunchAgents, both directions
  dead-paths    full paths (`a/b.py`) in the CLAUDE.md files, DECISIONS.md files
                and memory that resolve nowhere; a line that says the thing was
                deleted, removed or moved is history, not drift
  memory-index  MEMORY.md links whose file is missing, and memory files no line
                of MEMORY.md points to
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

TESTED = ['projections', 'sleeper', 'dfs']
PROJECTS = TESTED + ['best-ball-draft']
HISTORY = re.compile(r'\b(deleted|removed|moved|retired|was|were|used to|folded)\b', re.I)
# Paths that are real but not on this disk: an Artifact's published files.
NOT_LOCAL = ('files/', 'datasets/')
DOMAIN = re.compile(r'^[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|app|org|io|net|dev)/')


def collected(root, proj):
    py = root / proj / '.venv' / 'bin' / 'python'
    if not py.exists():
        return None
    r = subprocess.run([str(py), '-m', 'pytest', 'tests/', '--collect-only', '-q',
                        '-p', 'no:cacheprovider'], cwd=root / proj,
                       capture_output=True, text=True, timeout=120)
    m = re.search(r'(\d+) tests? collected', r.stdout)
    return int(m.group(1)) if m else None


def check_test_counts(root):
    found, skipped = [], []
    actual = {p: collected(root, p) for p in TESTED if (root / p).is_dir()}
    for p in TESTED:
        if actual.get(p) is None:
            skipped.append(p)
    mp = root / 'docs' / 'architecture.html'
    if mp.exists():
        # Every tagged copy, not one per project: the map states each count twice (its
        # page and the health table), and on 2026-10-15 those two copies of the DFS
        # count already disagreed with each other (426 and 422) as well as with the code.
        stated = re.findall(r'<span data-tests="([a-z-]+)">(\d+)</span>', mp.read_text())
        for p, n in actual.items():
            if n is None:
                continue
            mine = [int(s) for q, s in stated if q == p]
            if not mine:
                found.append(f'docs/architecture.html has no <span data-tests="{p}"> '
                             f'(actual {n}); tag the count so it can be checked')
            for s in sorted(set(mine) - {n}):
                found.append(f'docs/architecture.html says {p} has {s} tests '
                             f'({mine.count(s)} place(s)), it has {n}: edit the span, then '
                             f'republish the pinned map')
    for p, n in actual.items():
        rd = root / p / 'README.md'
        if n is None or not rd.exists():
            continue
        for m in re.finditer(r'(\d+) tests, collected (\d{4}-\d{2}-\d{2})', rd.read_text()):
            if int(m.group(1)) != n:
                found.append(f'{p}/README.md says "{m.group(1)} tests, collected '
                             f'{m.group(2)}", it has {n}: update the count and the date')
    return found, skipped


def check_launchd(root, agents):
    mp = root / 'docs' / 'architecture.html'
    if not mp.exists() or not agents.is_dir():
        return [], ['map or LaunchAgents not present']
    named = set(re.findall(r'\b(com\.(?:bba|dfs)\.[a-z0-9]+)\b', mp.read_text()))
    installed = {p.stem for p in agents.glob('com.bba.*.plist')} | \
                {p.stem for p in agents.glob('com.dfs.*.plist')}
    found = [f'the map names {j}, but no {j}.plist is installed: remove it from the '
             f'map, or reinstall it' for j in sorted(named - installed)]
    found += [f'{j}.plist is installed but the map never mentions it: add it to the '
              f'schedule page of docs/architecture.html' for j in sorted(installed - named)]
    return found, []


def docs_to_scan(root, memory):
    yield from (root / p for p in ['CLAUDE.md', 'docs/DECISIONS.md',
                                   'best-ball-draft/CLAUDE.md', 'best-ball-draft/docs/DECISIONS.md'])
    if memory and memory.is_dir():
        yield from sorted(memory.glob('*.md'))


def resolves(path, doc, root):
    bases = [doc.parent, root, root.parent, Path.home()] + [root / p for p in PROJECTS]
    return any((b / path).exists() for b in bases)


def check_dead_paths(root, memory):
    found = []
    pat = re.compile(r'`([A-Za-z0-9_.~-]+/[A-Za-z0-9_./~-]*[A-Za-z0-9_])(?::\d+)?`')
    for doc in docs_to_scan(root, memory):
        if not doc.exists():
            continue
        for n, line in enumerate(doc.read_text().splitlines(), 1):
            # History is not drift, and a web address is not a path. Both were the
            # false positives of this check's first run on 2026-10-15; a detector that
            # cries wolf gets ignored, which is worse than no detector.
            if HISTORY.search(line) or re.search(r'\bURLs?\b|https?://', line):
                continue
            for path in pat.findall(line):
                if path.startswith(NOT_LOCAL) or '<' in path or DOMAIN.match(path):
                    continue
                p = path.replace('~/', '')
                if not resolves(p, doc, root):
                    found.append(f'{doc.name}:{n} points at `{path}`, which does not exist')
    return found, []


def check_memory_index(memory):
    idx = memory / 'MEMORY.md' if memory else None
    if not idx or not idx.exists():
        return [], ['no memory index']
    linked = set(re.findall(r'\]\(([^)]+\.md)\)', idx.read_text()))
    files = {p.name for p in memory.glob('*.md')} - {'MEMORY.md'}
    found = [f'MEMORY.md links {f}, which does not exist' for f in sorted(linked - files)]
    found += [f'memory/{f} is not in MEMORY.md, so no session will ever see it'
              for f in sorted(files - linked)]
    return found, []


def main(argv=None):
    here = Path(__file__).resolve().parents[1]
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--root', type=Path, default=here)
    ap.add_argument('--memory', type=Path, default=Path.home() /
                    '.claude/projects/-Users-jvonderhoff-Development-projects/memory')
    ap.add_argument('--launch-agents', type=Path, default=Path.home() / 'Library/LaunchAgents')
    a = ap.parse_args(argv)
    checks = [('test-counts', lambda: check_test_counts(a.root)),
              ('launchd', lambda: check_launchd(a.root, a.launch_agents)),
              ('dead-paths', lambda: check_dead_paths(a.root, a.memory)),
              ('memory-index', lambda: check_memory_index(a.memory))]
    total = 0
    for name, fn in checks:
        found, skipped = fn()
        total += len(found)
        status = 'DRIFT' if found else ('SKIP ' if skipped and not found else 'OK   ')
        extra = f'  (not checked: {", ".join(skipped)})' if skipped else ''
        print(f'{status} {name}: {len(found)} finding(s){extra}')
        for f in found:
            print(f'      - {f}')
    print(f'\n{total} finding(s).' if total else '\nNo drift found.')
    return 1 if total else 0


if __name__ == '__main__':
    sys.exit(main())
