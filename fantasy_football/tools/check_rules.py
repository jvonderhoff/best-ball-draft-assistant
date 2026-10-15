"""The umbrella rules that a machine can check, checked.

`CLAUDE.md` states rules that hold across all four projects. A rule in prose can be
read and still broken, and the ones below break SILENTLY: nothing raises, the numbers
stay plausible, and the first sign is a player who quietly went missing. Each check
here exists because its rule is (a) mechanically checkable, (b) silent when broken,
and (c) was enforced by nothing else when this was written (2026-10-15).

    projections/.venv/bin/python tools/check_rules.py        # from fantasy_football/

Stdlib only, so any project's 3.11 venv runs it. Exits non-zero on any FAIL. Every
failure says what to do, because the reader is as likely to be an agent as a person.

A project that is absent (a session worktree does not carry the nested repos) is
reported as SKIP, never as a pass: a check that ran on nothing must not look like a
check that found nothing (bug class 1).
"""
import argparse
import ast
import sys
from pathlib import Path

PROJECTS = ['projections', 'sleeper', 'dfs', 'best-ball-draft']

# Top-level packages that belong to exactly one project. `cli`, `tools`, `web` and
# `tests` exist in several, so an import of them proves nothing and is not checked.
OWN_PACKAGES = {
    'projections': {'pipeline', 'analysis'},
    'sleeper': {'leagues'},
    'dfs': {'dfs'},
    'best-ball-draft': {'app'},
}

NAMES_COPIES = ['best-ball-draft/app/data/names.py', 'projections/pipeline/core/names.py']

SKIP_DIRS = {'.venv', 'node_modules', '__pycache__', '.git', '.claude'}


def py_files(project_dir):
    for p in project_dir.rglob('*.py'):
        if not SKIP_DIRS.intersection(p.relative_to(project_dir).parts):
            yield p


def below_header(path):
    """Source after the module docstring: the part that must be byte-identical."""
    src = path.read_text()
    doc = ast.get_docstring(ast.parse(src), clean=False)
    if doc is None:
        return src
    return src[src.index(doc) + len(doc) + 3:]


def check_names_identical(root):
    copies = [root / c for c in NAMES_COPIES]
    missing = [str(c.relative_to(root)) for c in copies if not c.exists()]
    if missing:
        return 'SKIP', f'not present here: {", ".join(missing)}'
    a, b = (below_header(c) for c in copies)
    if a == b:
        return 'PASS', f'{len(a)} bytes identical below the header in both copies'
    la, lb = a.splitlines(), b.splitlines()
    first = next((i for i, (x, y) in enumerate(zip(la, lb)) if x != y), min(len(la), len(lb)))
    return 'FAIL', (
        f'the two names.py copies differ below their headers (first difference at body line {first + 1}).\n'
        f'    They must agree on what a name reduces to, or the crosswalk resolves a player\n'
        f'    the draft app cannot, with no error on either side.\n'
        f'    FIX: make the same edit in both {NAMES_COPIES[0]} and {NAMES_COPIES[1]},\n'
        f'    then run projections\' crosswalk tests. Rule: CLAUDE.md, "Identity".')


def check_names_single_home(root):
    """normalize_name / NICKNAMES live in the two copies and nowhere else."""
    homes = {(root / c).resolve() for c in NAMES_COPIES}
    offenders, scanned, present = [], 0, []
    for proj in PROJECTS:
        d = root / proj
        if not d.is_dir():
            continue
        present.append(proj)
        for p in py_files(d):
            scanned += 1
            if p.resolve() in homes:
                continue
            try:
                tree = ast.parse(p.read_text())
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                defines = (isinstance(node, ast.FunctionDef) and node.name == 'normalize_name') or \
                          (isinstance(node, ast.Assign) and any(
                              isinstance(t, ast.Name) and t.id == 'NICKNAMES' for t in node.targets))
                # sleeper/ does no name matching at all, so even USING names.py there is wrong
                uses = proj == 'sleeper' and (
                    (isinstance(node, ast.ImportFrom) and node.module and node.module.split('.')[-1] == 'names') or
                    (isinstance(node, ast.Name) and node.id == 'normalize_name'))
                if defines or uses:
                    offenders.append(f'{p.relative_to(root)}:{node.lineno}')
    if not present:
        return 'SKIP', 'no project directories found'
    if not offenders:
        return 'PASS', f'{scanned} files across {", ".join(present)}: no third matcher'
    return 'FAIL', (
        'name matching found outside its two homes:\n' +
        ''.join(f'      {o}\n' for o in sorted(set(offenders))) +
        '    A second rule for what a name reduces to will disagree with names.py somewhere,\n'
        '    silently: that is how five salaried DFS players vanished on 2026-09-12.\n'
        '    FIX: delete the need for it. A consumer of the props export joins on the\n'
        '    `match_keys` the exporter ships; anything that RENAMES a player goes in\n'
        '    names.py (both copies). Rule: CLAUDE.md, "Identity"; history: docs/DECISIONS.md.')


def check_seam_imports(root):
    """No project imports another project's code: the seam is data, not a library."""
    offenders, scanned, present = [], 0, []
    for proj in PROJECTS:
        d = root / proj
        if not d.is_dir():
            continue
        present.append(proj)
        foreign = set().union(*(v for k, v in OWN_PACKAGES.items() if k != proj)) - OWN_PACKAGES[proj]
        siblings = [s for s in PROJECTS if s != proj]
        for p in py_files(d):
            scanned += 1
            try:
                tree = ast.parse(p.read_text())
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                mods = []
                if isinstance(node, ast.Import):
                    mods = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    mods = [node.module]
                for m in mods:
                    if m.split('.')[0] in foreign:
                        offenders.append(f'{p.relative_to(root)}:{node.lineno}  import {m}')
                # sys.path.insert/append(...) with a sibling project's name in a literal
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                        and node.func.attr in ('insert', 'append') \
                        and isinstance(node.func.value, ast.Attribute) and node.func.value.attr == 'path':
                    for lit in ast.walk(node):
                        if isinstance(lit, ast.Constant) and isinstance(lit.value, str) \
                                and any(s in lit.value for s in siblings):
                            offenders.append(f'{p.relative_to(root)}:{node.lineno}  sys.path -> {lit.value!r}')
    if not present:
        return 'SKIP', 'no project directories found'
    if not offenders:
        return 'PASS', f'{scanned} files across {", ".join(present)}: no cross-project imports'
    return 'FAIL', (
        'code imported across the seam:\n' +
        ''.join(f'      {o}\n' for o in sorted(set(offenders))) +
        '    Four projects with separate venvs and deploy cadences would be coupled by it.\n'
        '    FIX: have the owning project WRITE what you need (an export under its data/,\n'
        '    or the crosswalk read-only) and read the file. If the code itself is an\n'
        '    application, it belongs in the app, not in projections/.\n'
        '    Rule: CLAUDE.md, "Sharing is a data seam, not a code library".')


CHECKS = [
    ('names.py copies agree', check_names_identical),
    ('name matching has one home', check_names_single_home),
    ('no imports across the seam', check_seam_imports),
]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1],
                    help='the fantasy_football directory (default: this file\'s parent)')
    args = ap.parse_args(argv)
    statuses = []
    for title, fn in CHECKS:
        status, detail = fn(args.root)
        print(f'{status:4}  {title}: {detail}')
        statuses.append(status)
    if 'SKIP' in statuses:
        print(f'\n{statuses.count("SKIP")} check(s) skipped: they did not run, which is not the same as passing.')
    return 1 if 'FAIL' in statuses else 0


if __name__ == '__main__':
    sys.exit(main())
