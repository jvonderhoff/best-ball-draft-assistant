"""Each drift check must find planted drift, and stay quiet on history and URLs.

A detector that has only ever reported clean proves nothing (bug class 3), and one that
reports noise gets ignored. Both directions are tested here.

    projections/.venv/bin/python -m pytest tools/ -q        # from fantasy_football/
"""
import drift


def make(tmp_path, map_html='', readme=''):
    (tmp_path / 'docs').mkdir()
    (tmp_path / 'docs/architecture.html').write_text(map_html)
    for p in drift.TESTED:
        (tmp_path / p).mkdir()
    (tmp_path / 'dfs/README.md').write_text(readme)
    return tmp_path


def counts(monkeypatch, **n):
    monkeypatch.setattr(drift, 'collected', lambda root, p: n.get(p))


def test_map_count_matches(tmp_path, monkeypatch):
    counts(monkeypatch, dfs=450)
    root = make(tmp_path, '<span data-tests="dfs">450</span> tests')
    assert drift.check_test_counts(root)[0] == []


def test_map_count_stale(tmp_path, monkeypatch):
    counts(monkeypatch, dfs=450)
    root = make(tmp_path, '<span data-tests="dfs">426</span> tests')
    [f] = drift.check_test_counts(root)[0]
    assert '426' in f and '450' in f


def test_every_copy_is_checked_not_just_one(tmp_path, monkeypatch):
    # The map's DFS page said 426 and its health table 422 (2026-10-15): one right
    # copy must not hide a wrong one.
    counts(monkeypatch, dfs=450)
    root = make(tmp_path, '<span data-tests="dfs">450</span> ... <span data-tests="dfs">422</span>')
    [f] = drift.check_test_counts(root)[0]
    assert '422' in f


def test_untagged_count_is_reported_not_guessed(tmp_path, monkeypatch):
    counts(monkeypatch, dfs=450)
    root = make(tmp_path, 'Health: 426 tests')
    [f] = drift.check_test_counts(root)[0]
    assert 'no <span data-tests="dfs">' in f


def test_readme_count_stale(tmp_path, monkeypatch):
    counts(monkeypatch, dfs=450)
    root = make(tmp_path, '<span data-tests="dfs">450</span>', '218 tests, collected 2026-09-17.')
    [f] = drift.check_test_counts(root)[0]
    assert 'dfs/README.md' in f and '218' in f


def test_no_venv_is_a_skip(tmp_path, monkeypatch):
    counts(monkeypatch)
    found, skipped = drift.check_test_counts(make(tmp_path))
    assert found == [] and set(skipped) == set(drift.TESTED)


def test_launchd_both_directions(tmp_path):
    root = make(tmp_path, 'com.dfs.sunday and com.bba.gone')
    agents = tmp_path / 'agents'
    agents.mkdir()
    for j in ['com.dfs.sunday', 'com.dfs.monday']:
        (agents / f'{j}.plist').write_text('')
    found = drift.check_launchd(root, agents)[0]
    assert len(found) == 2
    assert any('com.bba.gone' in f and 'no com.bba.gone.plist' in f for f in found)
    assert any('com.dfs.monday' in f and 'never mentions' in f for f in found)


def test_dead_path_found_but_history_and_urls_ignored(tmp_path):
    root = make(tmp_path)
    (root / 'dfs/real.py').write_text('')
    (root / 'CLAUDE.md').write_text(
        'Read `dfs/real.py`.\n'
        'Then `dfs/missing.py`.\n'
        '`old/thing.py` was deleted 2026-09-08.\n'
        'Its history is at `github.com/someone/repo`.\n'
        'Fetched from a public `wp-content/uploads` URL.\n')
    [f] = drift.check_dead_paths(root, None)[0]
    assert 'dfs/missing.py' in f and 'CLAUDE.md:2' in f


def test_memory_index(tmp_path):
    mem = tmp_path / 'memory'
    mem.mkdir()
    (mem / 'MEMORY.md').write_text('- [A](a.md) — x\n- [Gone](gone.md) — y\n')
    (mem / 'a.md').write_text('')
    (mem / 'orphan.md').write_text('')
    found = drift.check_memory_index(mem)[0]
    assert any('gone.md' in f for f in found)
    assert any('orphan.md' in f for f in found)
    assert len(found) == 2
