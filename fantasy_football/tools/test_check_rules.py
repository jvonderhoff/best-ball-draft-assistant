"""Each check in check_rules.py must FAIL when its rule is broken.

A check that has only ever passed proves nothing (bug class 3: check the known-good
control first). These build a minimal four-project tree, confirm it passes, then
break one rule at a time and confirm that exactly its check fails.

    projections/.venv/bin/python -m pytest tools/ -q        # from fantasy_football/
"""
import check_rules as cr

HEADER_A = '"""Draft app copy."""\n'
HEADER_B = '"""Projections copy, with a longer header that is allowed to differ."""\n'
BODY = "NICKNAMES = {'kenny': 'kenneth'}\n\ndef normalize_name(n):\n    return n\n"


def tree(tmp_path):
    for proj, pkg in [('projections', 'pipeline'), ('sleeper', 'leagues'),
                      ('dfs', 'dfs'), ('best-ball-draft', 'app')]:
        (tmp_path / proj / pkg).mkdir(parents=True)
        (tmp_path / proj / pkg / '__init__.py').write_text('')
    (tmp_path / 'best-ball-draft/app/data').mkdir()
    (tmp_path / 'best-ball-draft/app/data/names.py').write_text(HEADER_A + BODY)
    (tmp_path / 'projections/pipeline/core').mkdir()
    (tmp_path / 'projections/pipeline/core/names.py').write_text(HEADER_B + BODY)
    return tmp_path


def statuses(root):
    return [fn(root)[0] for _, fn in cr.CHECKS]


def test_control_passes(tmp_path):
    assert statuses(tree(tmp_path)) == ['PASS', 'PASS', 'PASS']
    assert cr.main(['--root', str(tmp_path)]) == 0


def test_one_names_copy_edited(tmp_path):
    root = tree(tmp_path)
    (root / 'projections/pipeline/core/names.py').write_text(
        HEADER_B + BODY.replace("'kenneth'", "'ken'"))
    assert statuses(root) == ['FAIL', 'PASS', 'PASS']
    assert cr.main(['--root', str(root)]) == 1


def test_third_matcher(tmp_path):
    root = tree(tmp_path)
    (root / 'dfs/dfs/props.py').write_text('def normalize_name(n):\n    return n.lower()\n')
    assert statuses(root) == ['PASS', 'FAIL', 'PASS']


def test_sleeper_does_no_name_matching(tmp_path):
    root = tree(tmp_path)
    (root / 'sleeper/leagues/x.py').write_text('from .names import normalize_name\n')
    assert statuses(root)[1] == 'FAIL'


def test_import_across_the_seam(tmp_path):
    root = tree(tmp_path)
    (root / 'dfs/dfs/props.py').write_text('from pipeline import td\n')
    assert statuses(root) == ['PASS', 'PASS', 'FAIL']


def test_sys_path_into_a_sibling(tmp_path):
    root = tree(tmp_path)
    (root / 'sleeper/leagues/x.py').write_text('import sys\nsys.path.insert(0, "../dfs")\n')
    assert statuses(root)[2] == 'FAIL'


def test_own_package_import_is_fine(tmp_path):
    root = tree(tmp_path)
    (root / 'projections/pipeline/x.py').write_text('from pipeline.core import names\n')
    assert statuses(root) == ['PASS', 'PASS', 'PASS']


def test_absent_project_is_skip_not_pass(tmp_path):
    root = tree(tmp_path)
    import shutil
    shutil.rmtree(root / 'best-ball-draft')
    assert statuses(root)[0] == 'SKIP'
