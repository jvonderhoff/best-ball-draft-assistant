"""The grader must pass a report written to the skill's spec, and fail each way of
breaking it -- each broken variant fails exactly the check it breaks. Synthetic leagues
and made-up players only: this repo is public, and real runs (league ids, rosters) stay
in the gitignored runs/ folder.

    projections/.venv/bin/python -m pytest evals/ -q        # from fantasy_football/
"""
import copy
import importlib.util
from pathlib import Path

# Loaded by path under its own name: evals/startsit has a grade.py too, and a bare
# `import grade` would hand whichever test ran second the other one's grader.
_spec = importlib.util.spec_from_file_location('tuesday_grade', Path(__file__).with_name('grade.py'))
grade = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(grade)


def p(name, pos, slot='active', status=None, contested=False):
    return {'name': name, 'pos': pos, 'slot': slot, 'status': status, 'contested': contested}


DATA = {
    'finished_at': '2026-10-13T14:40:00-05:00',
    'lateround_recaptured': True,
    'dynasty_board_age_days': 11,
    'unmatched': {'LateRound weekly': ['Hal Unkeyed'], 'market': [], 'baselines': None},
    'leagues': [
        {'name': 'Alpha League', 'faab_left': 80, 'waiver_run': '2026-10-14T02:10:00-05:00',
         'most_bid_wins': [8, 20, 50, 60],
         'slots': {'QB': 1, 'RB': 2, 'WR': 2, 'TE': 1, 'K': 1},
         'roster': [p('Quinn Arbor', 'QB'), p('Rae Flint', 'RB'), p('Rory Dunn', 'RB'),
                    p('Russ Spare', 'RB'), p('Wes Rook', 'WR'), p('Will Nash', 'WR'),
                    p('Wade Lone', 'WR'), p('Ty Endo', 'TE'), p('Kip Foote', 'K'),
                    p('Iggy Hurt', 'RB', 'ir', 'IR'), p('Taz Young', 'WR', 'taxi')],
         'free_agents': [p('Dash Comet', 'RB', contested=True), p('Mo Quiet', 'WR'),
                         p('Otis Gone', 'WR', status='Out')],
         'aliases': {}},
        {'name': 'Bravo Dynasty', 'faab_left': 55, 'waiver_run': '2026-10-14T07:00:00-05:00',
         'most_bid_wins': [5, 9],
         'slots': {'QB': 1, 'RB': 2, 'WR': 2, 'TE': 1},
         'roster': [p('Cal Vance', 'QB'), p('Rex Pace', 'RB'), p('Ron Pike', 'RB'),
                    p('Wyn Gale', 'WR'), p('Walt Reed', 'WR'), p('Tad Ober', 'TE')],
         'free_agents': [p('Dash Comet', 'RB', contested=True)], 'aliases': {}},
        {'name': 'Charlie Club', 'faab_left': None, 'waiver_run': '2026-10-14T11:00:00-05:00',
         'most_bid_wins': [],
         'slots': {'QB': 1, 'RB': 2, 'WR': 3, 'TE': 1, 'DEF': 1},
         'roster': [p('Cy Arm', 'QB'), p('Rob Lane', 'RB'), p('Ray Moss', 'RB'),
                    p('Ray Third', 'RB'), p('Wil Ash', 'WR'), p('Wil Birch', 'WR'),
                    p('Wil Cedar', 'WR'), p('Tom Elm', 'TE'), p('Gotham Owls', 'DEF')],
         'free_agents': [p('Dash Comet', 'RB', contested=True), p('Metro Hawks', 'DEF')],
         'aliases': {'GOT DEF': 'Gotham Owls', 'MET DEF': 'Metro Hawks'}},
    ],
}

# The control: exactly the shape "The report" in .claude/commands/tuesday.md asks for.
GOOD = """# Tuesday waivers: week 6

## 1. Claims to make

| League (FAAB left, runs) | Claim | Bid | Drop | Why |
|---|---|---|---|---|
| Alpha League ($80, Wed 02:10) | **Dash Comet** RB | $50–65 (contested; most-bid line wk3 $50, wk4 $60) | Russ Spare | starter hurt; 3 of 3 columns, 2.1M adds |
| Alpha League (same run) | Mo Quiet WR | $4–8 (columns 3–6%) | Wade Lone | slot role grew; 1 column |
| Bravo Dynasty ($55, Wed 07:00) | — no claim | | | every ranked player owned; trade instead |
| Charlie Club (no FAAB, Wed 11:00) | Dash Comet RB | priority claim | Ray Third | same job change |
| Charlie Club, free add now | Metro Hawks DEF | free (before kickoff) | GOT DEF | Gotham on bye |

**Don't:**
- Don't drop Rae Flint: he is this week's hot add elsewhere.

## 2. Decisions only you can make
1. Is Dash Comet worth $50–65 of your $80? Yes or no.

## 3. This week's lineup flags
- Alpha League: start Dash Comet over Rory Dunn if he lands.

## 4. Trades
- Alpha League: SELL Will Nash; Nash for a same-position WR fits.
- Bravo Dynasty: SELL Ron Pike. The dynasty board is 11 days old.

## 5. Inputs
- LateRound weekly: 170 ranked, 1 unmatched (Hal Unkeyed). ROS: 150 ranked, 0 unmatched.
- Waiver columns: 40 of 40 rows matched, three sources, all dated after Sunday's games.
- Market: 5/9 starters priced (thin, as usual on a Tuesday).
- QB check, week 5: passing-yards bias +3, Spearman 0.5.

**Usage & luck tab: refreshed for weeks 1–5.**
"""


def failed(report, data=DATA):
    return sorted(n for n, s, _ in grade.grade(report, data) if s == 'FAIL')


def test_control_passes_every_check():
    res = grade.grade(GOOD, DATA)
    assert [r for r in res if r[1] == 'FAIL'] == []
    assert len(res) >= 30          # every promise actually ran, not skipped


def sub(old, new, report=GOOD):
    assert old in report, old
    return report.replace(old, new)


def test_preamble_before_claims():
    bad = sub('## 1. Claims', 'LateRound was recaptured; ROS uses the morning file.\n\n## 1. Claims')
    assert failed(bad) == ['claims-first']


def test_skipped_recapture_must_lead():
    data = copy.deepcopy(DATA)
    data['lateround_recaptured'] = False
    assert failed(GOOD, data) == ['lr-skip-flagged']
    flagged = sub('# Tuesday waivers: week 6\n', '# Tuesday waivers: week 6\n'
                  'LateRound NOT recaptured — last capture 7 days old\n')
    assert failed(flagged, data) == []
    # ...and saying it when it WAS recaptured is wrong too.
    assert failed(flagged) == ['claims-first']


def test_sections_out_of_order():
    bad = sub('## 4. Trades', '## 4b. moved').replace('## 2. Decisions', '## 4. Trades\n## 2. Decisions')
    bad = bad.replace('## 4b. moved', '')
    assert failed(bad) == ['sections']


def test_decisions_may_be_left_out():
    no_dec = sub('## 2. Decisions only you can make\n1. Is Dash Comet worth $50–65 of your $80? Yes or no.\n\n', '')
    assert failed(no_dec) == []


def test_league_missing():
    bad = sub('| Bravo Dynasty ($55, Wed 07:00) | — no claim | | | every ranked player owned; trade instead |\n', '')
    assert failed(bad) == ['every-league: Bravo Dynasty']


def test_faab_left_missing():
    assert failed(sub('Alpha League ($80, Wed 02:10)', 'Alpha League (Wed 02:10)')) == ['faab-header: Alpha League']
    assert failed(sub('Charlie Club (no FAAB, Wed 11:00)', 'Charlie Club (Wed 11:00)')) == ['faab-header: Charlie Club']


def test_no_claim_without_why():
    bad = sub('| — no claim | | | every ranked player owned; trade instead |', '| — no claim | | | |')
    assert failed(bad) == ['no-claim-why: Bravo Dynasty']


def test_out_of_waiver_order():
    bravo = '| Bravo Dynasty ($55, Wed 07:00) | — no claim | | | every ranked player owned; trade instead |\n'
    bad = sub(bravo, '').replace('| Alpha League ($80', bravo + '| Alpha League ($80', 1)
    assert failed(bad) == ['waiver-order']


def test_claim_of_owned_player():
    bad = sub('| Mo Quiet WR | $4–8', '| Will Nash WR | $4–8')
    assert failed(bad) == ['claim-is-free: Alpha League: Will Nash WR']


def test_claim_of_out_player():
    bad = sub('| Mo Quiet WR | $4–8', '| Otis Gone WR | $4–8')
    assert failed(bad) == ['never-out: Alpha League: Otis Gone WR']


def test_one_number_bid():
    bad = sub('$4–8 (columns 3–6%)', '$6 (columns 3–6%)')
    assert failed(bad) == ['bid-range: Alpha League: Mo Quiet WR']


def test_non_faab_bid_in_dollars():
    bad = sub('| priority claim |', '| $10–15 |')
    assert failed(bad) == ['bid-range: Charlie Club: Dash Comet RB']


def test_range_without_source():
    bad = sub('$4–8 (columns 3–6%) | Wade Lone | slot role grew; 1 column |',
              '$4–8 | Wade Lone | slot role grew |')
    assert failed(bad) == ['bid-source: Alpha League: Mo Quiet WR']


def test_contested_priced_off_columns():
    # The week-5 Shipley loss, written down: columns' % for a contested add.
    bad = sub('$50–65 (contested; most-bid line wk3 $50, wk4 $60)', '$10–16 (columns 9–12%)')
    assert failed(bad) == ['contested-priced: Alpha League: Dash Comet RB']


def test_claim_without_drop():
    bad = sub('| Wade Lone |', '| — |')
    assert failed(bad) == ['drop-named: Alpha League: Mo Quiet WR']


def test_drop_from_ir_or_taxi():
    assert failed(sub('| Wade Lone |', '| Iggy Hurt |')) == ['drop-active: Alpha League: Mo Quiet WR']
    assert failed(sub('| Wade Lone |', '| Taz Young |')) == ['drop-active: Alpha League: Mo Quiet WR']


def test_drop_only_healthy_starter():
    bad = sub('| Wade Lone |', '| Quinn Arbor |')
    assert failed(bad) == ['drop-not-only: Alpha League: Mo Quiet WR']


def test_swap_at_same_position_is_fine():
    # Dropping your only DEF for a DEF leaves one healthy: the add counts.
    assert 'drop-not-only: Charlie Club: Metro Hawks DEF' not in failed(GOOD)


def test_decision_not_a_question():
    bad = sub('1. Is Dash Comet worth $50–65 of your $80? Yes or no.', '1. Bid $50–65 on Dash Comet.')
    assert failed(bad) == ['decisions-yes-no']


def test_too_many_trade_lines():
    extra = '\n'.join(f'- Alpha League: idea {i}.' for i in range(3))
    bad = sub('## 5. Inputs', extra + '\n\n## 5. Inputs')
    assert failed(bad) == ['trades-brevity']


def test_stale_dynasty_board_must_be_named():
    data = copy.deepcopy(DATA)
    data['dynasty_board_age_days'] = 30
    assert failed(GOOD, data) == []          # the control names "11 days old"
    bad = sub(' The dynasty board is 11 days old.', '')
    assert failed(bad, data) == ['dynasty-age']
    assert failed(bad) == []                 # under three weeks it need not be said


def test_inputs_missing_qb_line():
    bad = sub('- QB check, week 5: passing-yards bias +3, Spearman 0.5.\n', '')
    assert failed(bad) == ['inputs-complete']


def test_yes_or_no_without_question_mark_is_a_question():
    ok = sub('1. Is Dash Comet worth $50–65 of your $80? Yes or no.', '1. Dash Comet at $50–65 of your $80. Yes or no.')
    assert failed(ok) == []


def test_unmatched_named_by_surname():
    assert failed(sub('1 unmatched (Hal Unkeyed)', '1 unmatched (Unkeyed)')) == []


def test_unmatched_buried():
    bad = sub('1 unmatched (Hal Unkeyed)', '1 unmatched')
    assert failed(bad) == ['unmatched-named: LateRound weekly']


def test_long_unmatched_list_may_be_a_count():
    data = copy.deepcopy(DATA)
    data['unmatched']['baselines'] = [f'Nobody {i}' for i in range(40)]
    assert failed(GOOD, data) == []


def test_commentary_after_inputs():
    bad = GOOD + '\nOverall a quiet week; I would hold FAAB for the bye weeks.\n'
    assert failed(bad) == ['inputs-last']


def test_footer_is_not_report():
    footed = GOOD + "\nThe phone push didn't go out.\n> Eval: 30/30 checks passed\n"
    assert failed(footed) == []


def test_pasted_command_output():
    bad = sub('## 5. Inputs', '```\nPOS PLAYER TM\nRB  Dash Comet\n```\n\n## 5. Inputs')
    assert failed(bad) == ['no-raw-paste']


def test_report_after_deadline():
    data = copy.deepcopy(DATA)
    data['finished_at'] = '2026-10-14T03:00:00-05:00'
    assert failed(GOOD, data) == ['before-deadline']


def test_cli_exit_codes(tmp_path):
    import json
    r, d = tmp_path / 'r.md', tmp_path / 'd.json'
    d.write_text(json.dumps(DATA))
    r.write_text(GOOD)
    assert grade.main([str(r), str(d)]) == 0
    r.write_text(GOOD + '\nstray commentary\n')
    assert grade.main([str(r), str(d)]) == 1


# -- the needs checks: the report starts from the roster (2026-10-20) --------

NEEDS = {'week': 6, 'leagues': [
    {'name': 'Alpha League', 'needs': [{'kind': 'short', 'pos': 'RB', 'week': None},
                                       {'kind': 'upgrade', 'pos': 'WR', 'week': None}]},
    {'name': 'Bravo Dynasty', 'needs': [{'kind': 'short', 'pos': 'TE', 'week': None}]},
    {'name': 'Charlie Club', 'needs': [{'kind': 'this_week', 'pos': 'DEF', 'week': 6},
                                       {'kind': 'short', 'pos': 'RB', 'week': None}]}]}

GOOD_N = (GOOD
          .replace('## 1. Claims to make\n\n',
                   '## 1. Needs and claims\n\n'
                   '- **Alpha League**: RB short for the season (3 of 4).\n'
                   '- **Bravo Dynasty**: TE short (1 of 2); nothing ranked free, trade.\n'
                   '- **Charlie Club**: DEF this week (Gotham bye); RB short.\n\n')
          .replace('| League (FAAB left, runs) | Claim |', '| League (FAAB left, runs) | Need | Claim |')
          .replace('|---|---|---|---|---|', '|---|---|---|---|---|---|')
          .replace('| Alpha League ($80, Wed 02:10) |', '| Alpha League ($80, Wed 02:10) | RB short |')
          .replace('| Alpha League (same run) |', '| Alpha League (same run) | WR upgrade |')
          .replace('| Bravo Dynasty ($55, Wed 07:00) |', '| Bravo Dynasty ($55, Wed 07:00) | TE short |')
          .replace('| Charlie Club (no FAAB, Wed 11:00) |', '| Charlie Club (no FAAB, Wed 11:00) | RB short |')
          .replace('| Charlie Club, free add now |', '| Charlie Club, free add now | DEF this week |'))


def failed_n(report, needs=NEEDS):
    return sorted(n for n, s, _ in grade.grade(report, DATA, needs) if s == 'FAIL')


def test_needs_control_passes():
    res = grade.grade(GOOD_N, DATA, NEEDS)
    assert [r for r in res if r[1] == 'FAIL'] == []
    assert sum(1 for r in res if r[0].startswith(('needs-line', 'claim-need'))) == 3 + 4


def test_needs_checks_skip_without_needs_json():
    # Runs before 2026-10-20 have no needs.json and must still grade clean.
    assert not [r for r in grade.grade(GOOD, DATA) if r[0].startswith('needs-line')]


def test_a_league_with_no_needs_line():
    bad = sub('- **Bravo Dynasty**: TE short (1 of 2); nothing ranked free, trade.\n', '', GOOD_N)
    assert failed_n(bad) == ['needs-line: Bravo Dynasty']


def test_a_needs_line_that_skips_this_weeks_hole():
    # Justice League, 2026-10-20: the empty DEF slot was the one real hole.
    bad = sub('DEF this week (Gotham bye); RB short.', 'RB short.', GOOD_N)
    assert failed_n(bad) == ['needs-line: Charlie Club']


def test_a_claim_that_fills_no_need_must_say_why():
    # Ridley, 2026-10-20: the board's top "gain" at a position the roster was not short of.
    bad = sub('| Alpha League (same run) | WR upgrade |', '| Alpha League (same run) | QB depth |', GOOD_N)
    assert failed_n(bad) == ['claim-need: Alpha League: Mo Quiet WR']
    ok = sub('| Alpha League (same run) | WR upgrade |',
             '| Alpha League (same run) | none — contested handcuff, block the rival |', GOOD_N)
    assert failed_n(ok) == []
    bare = sub('| Alpha League (same run) | WR upgrade |', '| Alpha League (same run) | none |', GOOD_N)
    assert failed_n(bare) == ['claim-need: Alpha League: Mo Quiet WR']


def test_no_need_column_at_all():
    fails = failed_n(GOOD.replace('## 1. Claims to make\n\n', '## 1. Claims to make\n\n'
                                  '- **Alpha League**: RB short.\n- **Bravo Dynasty**: TE short.\n'
                                  '- **Charlie Club**: DEF this week; RB short.\n\n'))
    assert fails and all(f.startswith('claim-need') for f in fails)


def test_needs_json_beside_the_input_is_picked_up(tmp_path):
    import json
    r, d = tmp_path / 'r.md', tmp_path / 'tuesday.json'
    d.write_text(json.dumps(DATA))
    r.write_text(GOOD)                       # no needs line, no Need column
    assert grade.main([str(r), str(d)]) == 0
    (tmp_path / 'needs.json').write_text(json.dumps(NEEDS))
    assert grade.main([str(r), str(d)]) == 1
    r.write_text(GOOD_N)
    assert grade.main([str(r), str(d)]) == 0
