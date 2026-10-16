"""The grader must pass a report written to the skill's spec, and fail each way of
breaking it. Synthetic leagues and made-up players only: this repo is public, and real
runs (league ids, rosters) stay in the gitignored runs/ folder.

    projections/.venv/bin/python -m pytest evals/ -q        # from fantasy_football/
"""
import copy

import grade


def player(name, pos='WR', points=10.0, source='market'):
    return {'name': name, 'pos': pos, 'points': points, 'source': source}


DATA = {
    'not_weekly': False,
    'leagues': [
        {'name': 'Alpha League', 'empty_slots': [],
         'slots': [{'slot': 'QB', 'player': player('Quinn Arbor', 'QB', 20.1)},
                   {'slot': 'WR', 'player': player('Wes Rook', 'WR', 14.2)},
                   {'slot': 'FLEX', 'player': player('Rae Flint', 'RB', 11.0)}],
         'out': [player('Otto Benched', 'RB', None, 'out')], 'ir': []},
        {'name': 'Bravo Dynasty', 'empty_slots': [],
         'slots': [{'slot': 'QB', 'player': player('Cal Vance', 'QB', 18.4)},
                   {'slot': 'TE', 'player': player('Ty Endo', 'TE', 7.3, 'season')}],
         'out': [], 'ir': [player('Ivan Reserve', 'WR', None, 'out')]},
    ],
}

# The control: exactly the shape .claude/commands/startsit.md asks for.
GOOD = """### Alpha League  —  45.3 proj, 3/3 market

| Slot | Player | Pts | LR | |
|---|---|--:|---|---|
| QB | Quinn Arbor | 20.1 | QB8 t3 | |
| WR | Wes Rook | 14.2 | WR20 t6 | |
| FLEX | Rae Flint | 11.0 | RB30 t8 | **IN** |

**Bench:** Otto Benched (out)

### Bravo Dynasty  —  25.7 proj, 1/2 market

| Slot | Player | Pts | LR | |
|---|---|--:|---|---|
| QB | Cal Vance | 18.4 | QB11 t4 | |
| TE | Ty Endo | 7.3 | TE18 t7 | baseline |

**Bench:** nobody changes

- Re-run after the 10:45 export if Ty Endo's game gets a market.
"""


def statuses(report, data=DATA):
    return {n: s for n, s, _ in grade.grade(report, data)}


def failed(report, data=DATA):
    return sorted(n for n, s in statuses(report, data).items() if s == 'FAIL')


def test_control_passes_every_check():
    assert failed(GOOD) == []


def test_footer_is_not_commentary():
    footed = GOOD + '\n> Dashboard: refreshed\n> Eval: 13/13 checks passed\n'
    assert failed(footed) == []


def test_prose_report_fails_tables_and_brevity():
    # The shape of the real Oct 11 report: right calls, bulleted prose, no tables.
    prose = ('### Alpha League — no changes\n'
             '- Keep Quinn Arbor, Wes Rook and Rae Flint; the market priced all three.\n'
             '- Otto Benched is out.\n'
             '### Bravo Dynasty — no changes\n'
             '- Cal Vance and Ty Endo start; Ty Endo is a season baseline.\n'
             '- Ivan Reserve is on IR.\n')
    f = failed(prose)
    assert 'tables: Alpha League' in f and 'tables: Bravo Dynasty' in f
    assert 'brevity' in f
    assert not any(n.startswith('never-out') or n.startswith('starters') for n in f)


def test_out_player_in_the_lineup():
    bad = GOOD.replace('| FLEX | Rae Flint |', '| FLEX | Otto Benched |')
    assert 'never-out: Alpha League' in failed(bad)


def test_ir_player_in_the_lineup():
    bad = GOOD.replace('| TE | Ty Endo |', '| TE | **Ivan Reserve** |')
    assert 'never-out: Bravo Dynasty' in failed(bad)


def test_missing_starter_unless_explained():
    dropped = GOOD.replace('| WR | Wes Rook | 14.2 | WR20 t6 | |\n', '')
    assert 'starters: Alpha League' in failed(dropped)
    explained = dropped.replace('- Re-run', '- Benching Wes Rook: questionable, no market.\n- Re-run')
    assert 'starters: Alpha League' not in failed(explained)


def test_missing_league_section():
    only_alpha = GOOD.split('### Bravo Dynasty')[0]
    assert 'every-league: Bravo Dynasty' in failed(only_alpha)


def test_empty_slot_must_be_called_out():
    data = copy.deepcopy(DATA)
    data['leagues'][1]['empty_slots'] = ['K']
    assert 'empty-flagged: Bravo Dynasty' in failed(GOOD, data)
    flagged = GOOD.replace('| TE | Ty Endo | 7.3 | TE18 t7 | baseline |',
                           '| TE | Ty Endo | 7.3 | TE18 t7 | baseline |\n| K | *nobody eligible* | — | | **empty** |')
    assert 'empty-flagged: Bravo Dynasty' not in failed(flagged, data)


def test_broken_seam_must_refuse_the_lineup():
    data = dict(DATA, not_weekly=True)
    assert failed(GOOD, data) == ['weekly-gate']
    refusal = '**NOT A WEEKLY LINEUP.** No starter took a market price in any league; fix the props seam before reading a lineup.\n'
    assert failed(refusal, data) == []


def test_crying_broken_seam_when_it_is_fine():
    assert 'weekly-gate' in failed('NOT A WEEKLY LINEUP\n' + GOOD)
