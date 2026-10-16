"""Grade a /tuesday waivers report against the board state it was built from.

An eval of the AGENT, not of the scripts: `sleeper/tests` prove the waiver maths. What
nothing checked is the report the user bids off on Tuesday night, written by a model
following `.claude/commands/tuesday.md` ("The report") plus the scheduled task's prompt.
This one has money on it: in week 5 the columns said 9-12% for Shipley, he went for $55
and $100, and the user's $10 and $16 lost. Built 2026-10-15, after the /startsit eval
found its report drifting because the task prompt contradicted the skill.

    projections/.venv/bin/python evals/tuesday/grade.py <report.md> <tuesday.json>

Exits 1 if any check fails. Each check is a promise the skill (or the task) makes:

  sections            Claims, Decisions (optional), Lineup flags, Trades, Inputs, in order
  claims-first        nothing before the claims table but a title, and the task's
                      "LateRound NOT recaptured" line when (only when) it was skipped
  every-league        a claims row for every league, including the ones with no claim
  faab-header         the league cell carries the FAAB left ($N), or says no FAAB
  no-claim-why        a no-claim row says why
  waiver-order        rows ordered by when each league's waivers run, earliest first
  claim-is-free       a claim names a player on that league's wire, not one you own
  never-out           no claim on a player who is OUT / IR / season-ending
  bid-range           FAAB bid is a dollar RANGE, never one number; else priority/free
  bid-source          a FAAB range says what it was drawn from (columns' %, BID, most-bid)
  contested-priced    a CONTESTED claim reaches the league's most-bid line (its median
                      win), not the columns' %: the week-5 Shipley loss
  drop-named          every claim names a real player on your roster to drop
  drop-active         the drop holds an active spot: never IR or taxi (frees nothing)
  drop-not-only       the drop is not a position's only healthy starter, after the add
  decisions-yes-no    every numbered decision is a question
  trades-brevity      at most three lines per league under Trades
  dynasty-age         the dynasty board's age is named once it is past three weeks
  inputs-complete     Inputs covers LateRound weekly + ROS, columns, market, QB line
  unmatched-named     every unmatched player on an input's coverage line is named
                      (lists over UNMATCHED_NAME_MAX may be a count and where)
  inputs-last         nothing after Inputs but the task's footer (Usage & luck, push)
  no-raw-paste        no pasted command output (code fences)
  before-deadline     the run finished before the earliest league's waivers ran

NOT checked, because a script cannot judge them: whether the Don't list catches what the
boards got wrong, whether a lineup flag is caused by a claim or an injury, whether a
trade's "roster need" is a rest-of-season hole rather than a one-week absence.

The JSON is what `sleeper/cli.py waivers --json PATH` writes (since 2026-10-16). Runs
before then had their file assembled from the printed board, and their NOTE.md says so.
`waiver_run` is MEASURED from when the league's claims were processed, with
`waiver_run_basis` saying so; the settings-derived hour is a late bound and only a
labelled fallback. The CLI cannot know whether LateRound was recaptured that day, so the
task adds `lateround_recaptured` itself (absent reads as recaptured). Shape:

  {"finished_at": ISO-with-offset, "lateround_recaptured": bool,
   "dynasty_board_age_days": float | null,
   "unmatched": {source: [names] | null},          # null = count only, names not shown
   "leagues": [{"name", "faab_left": int | null, "waiver_run": ISO-with-offset,
                "most_bid_wins": [int],             # the board's most-bid line, oldest first
                "slots": {pos: dedicated starters}, # flex slots excluded
                "roster": [{"name", "pos", "slot": active|ir|taxi, "status"}],
                "free_agents": [{"name", "pos", "status", "contested"}],
                "aliases": {"MIN DEF": "Minnesota Vikings"}}]}

Real runs (inputs + report) live in evals/tuesday/runs/<date>/, which is gitignored:
the parent repo is public and they hold league ids and rosters.
"""
import json
import re
import statistics
import sys
from datetime import datetime
from pathlib import Path

SECTIONS = [('claims', 'claims'), ('decisions', 'decisions'), ('lineup', 'lineup'),
            ('trades', 'trades'), ('inputs', 'inputs')]
OPTIONAL = {'decisions'}
OUT = {'out', 'ir', 'pup', 'sus', 'season'}       # a claim on any of these is wasted money
MAX_TRADE_LINES = 3
DYNASTY_AGE_WARN_DAYS = 21
UNMATCHED_NAME_MAX = 10
# The scheduled task appends these after Inputs; they are run metadata, not report.
FOOTER = re.compile(r'usage\s*&\s*luck|push|notification|^>|eval:', re.I)
RANGE = re.compile(r'\$\s*(\d+)\s*[–—-]\s*\$?\s*(\d+)')
BID_SOURCE = re.compile(r'column|%|\bBID\b|most-bid|contested', re.I)


def key(league_name):
    return league_name.lower().split()[0]          # "Haters Club Dynasty" -> "haters"


def norm(name):
    """Fold punctuation and suffixes so 'Mike Washington Jr.' finds 'Mike Washington'."""
    n = re.sub(r"[.'’]", '', name.lower())
    n = re.sub(r'[^a-z0-9 ]', ' ', n)                 # markup, commas, parentheses
    n = re.sub(r'\b(jr|sr|ii|iii|iv)\b', '', n)
    return re.sub(r'\s+', ' ', n).strip()


def names_in(text, people, aliases=None):
    """Which of `people` (dicts with 'name') the free text mentions."""
    t = ' ' + norm(text) + ' '
    for alias, real in (aliases or {}).items():
        if norm(alias) in t:
            t += ' ' + norm(real) + ' '
    return [p for p in people if ' ' + norm(p['name']) + ' ' in t]


def split_sections(report):
    """{section id: [lines]}, plus the lines before the first numbered section."""
    out, cur, pre, order = {}, None, [], []
    for line in report.splitlines():
        if line.startswith('## '):
            head = line[3:].lower()
            sid = next((s for s, word in SECTIONS if word in head), None)
            if sid:
                cur = sid
                out[cur] = []
                order.append(sid)
                continue
        if cur is None:
            pre.append(line)
        else:
            out[cur].append(line)
    return out, pre, order


def table(lines):
    """Rows of the first markdown table as dicts keyed by lower-cased header label."""
    rows, head = [], None
    for l in lines:
        s = l.strip()
        if not s.startswith('|'):
            if head:
                break
            continue
        cells = [c.strip() for c in s.strip('|').split('|')]
        if head is None:
            head = [re.sub(r'\s*\(.*', '', c).lower() for c in cells]
        elif set(''.join(cells)) <= set('-: '):
            continue
        else:
            rows.append(dict(zip(head, cells + [''] * (len(head) - len(cells)))))
    return rows


def is_no_claim(row):
    c = re.sub(r'[*_]', '', row.get('claim', '')).strip().lower()
    return not c or c in {'—', '-', '–'} or 'no claim' in c


def when(iso):
    return datetime.fromisoformat(iso)


def grade(report, data):
    results = []

    def check(name, ok, detail=''):
        results.append((name, 'PASS' if ok else 'FAIL', detail))

    secs, pre, order = split_sections(report)
    want = [s for s, _ in SECTIONS if s in secs or s not in OPTIONAL]
    check('sections', order == want,
          f'found {order or "none"}, want {want} (Decisions may be left out)')

    pre_text = [l for l in pre if l.strip() and not l.startswith('# ')]
    skipped = not data.get('lateround_recaptured', True)
    flag = [l for l in pre_text if 'lateround not recaptured' in l.lower()]
    stray = [l for l in pre_text if l not in flag]
    check('claims-first', not stray and (skipped or not flag),
          f'{len(stray)} line(s) before the claims table'
          + ('; says NOT recaptured but it was' if flag and not skipped else ''))
    if skipped:
        check('lr-skip-flagged', bool(pre_text) and pre_text[0] in flag,
              'recapture was skipped: the first line must say "LateRound NOT recaptured"')

    rows = table(secs.get('claims', []))
    leagues = data['leagues']
    first_row = {}
    for L in leagues:
        name, k = L['name'], key(L['name'])
        mine = [r for r in rows if k in r.get('league', '').lower()]
        check(f'every-league: {name}', bool(mine), 'no row in the claims table')
        if not mine:
            continue
        first_row[name] = rows.index(mine[0])
        head = mine[0]['league']
        if L.get('faab_left') is not None:
            check(f'faab-header: {name}', f"${L['faab_left']}" in head.replace(' ', ''),
                  f"league cell does not show ${L['faab_left']} left")
        else:
            check(f'faab-header: {name}', 'no faab' in head.lower(),
                  'non-FAAB league not marked "no FAAB"')

        for r in mine:
            if is_no_claim(r):
                check(f'no-claim-why: {name}', len(r.get('why', '').strip()) > 3,
                      'a no-claim row with no reason')
                continue
            claimed = names_in(r.get('claim', ''), L['free_agents'], L.get('aliases'))
            owned = names_in(r.get('claim', ''), L['roster'], L.get('aliases'))
            label = re.sub(r'[*_]', '', r.get('claim', ''))[:30]
            check(f'claim-is-free: {name}: {label}', bool(claimed) and not owned,
                  'claims a player you already roster' if owned
                  else 'claimed player is not on this league\'s wire')
            bad = [p['name'] for p in claimed if (p.get('status') or '').lower() in OUT]
            check(f'never-out: {name}: {label}', not bad, f'claims {", ".join(bad)}')

            bid = r.get('bid', '')
            m = RANGE.search(bid)
            if 'free' in bid.lower():
                ok_bid = True                      # a free add before kickoff, no claim
            elif L.get('faab_left') is not None:
                ok_bid = bool(m) and int(m.group(1)) < int(m.group(2))
            else:
                ok_bid = 'priority' in bid.lower()
            check(f'bid-range: {name}: {label}', ok_bid,
                  f'bid "{bid[:40]}" is not a $range' if L.get('faab_left') is not None
                  else f'bid "{bid[:40]}" is not "priority claim"')
            if m and L.get('faab_left') is not None:
                check(f'bid-source: {name}: {label}', bool(BID_SOURCE.search(bid + r.get('why', ''))),
                      'the range does not say what it was drawn from')
                wins = L.get('most_bid_wins') or []
                if any(p.get('contested') for p in claimed) and wins:
                    need = statistics.median(wins)
                    check(f'contested-priced: {name}: {label}', int(m.group(2)) >= need,
                          f'CONTESTED, top of range ${m.group(2)} is under the most-bid '
                          f'line\'s median win ${need:g} ({wins})')

            drops = names_in(r.get('drop', ''), L['roster'], L.get('aliases'))
            check(f'drop-named: {name}: {label}', bool(drops),
                  f'drop "{r.get("drop", "")[:30]}" is not a player on your roster')
            frozen = [d['name'] for d in drops if d.get('slot') in ('ir', 'taxi')]
            check(f'drop-active: {name}: {label}', not frozen,
                  f'{", ".join(frozen)} sits in IR/taxi: cutting him frees nothing')
            short = []
            for d in drops:
                pos = d['pos']
                need = (L.get('slots') or {}).get(pos, 0)
                healthy = [p for p in L['roster'] if p['pos'] == pos and p not in drops
                           and p.get('slot') == 'active'
                           and (p.get('status') or '').lower() not in OUT]
                healthy += [p for p in claimed if p['pos'] == pos]
                if need and len(healthy) < need:
                    short.append(f'{d["name"]} ({pos}: {len(healthy)} healthy left, {need} start)')
            check(f'drop-not-only: {name}: {label}', not short, '; '.join(short))

    seen = [L for L in leagues if L['name'] in first_row]
    by_row = sorted(seen, key=lambda L: first_row[L['name']])
    by_time = sorted(seen, key=lambda L: (when(L['waiver_run']), first_row[L['name']]))
    check('waiver-order', by_row == by_time,
          f'rows {[L["name"] for L in by_row]}, waivers run {[L["name"] for L in by_time]}')

    if 'decisions' in secs:
        items = [l for l in secs['decisions'] if re.match(r'\s*\d+\.', l)]
        # "Yes or no." is a question in all but punctuation; the real Oct 13 run wrote it.
        not_q = [l.strip()[:40] for l in items if '?' not in l and 'yes or no' not in l.lower()]
        check('decisions-yes-no', items and not not_q,
              f'not a question: {not_q}' if items else 'section present but no numbered items')

    trades = [l for l in secs.get('trades', []) if l.strip()]
    long_ = [L['name'] for L in leagues
             if sum(key(L['name']) in l.lower() for l in trades) > MAX_TRADE_LINES]
    check('trades-brevity', not long_, f'over {MAX_TRADE_LINES} lines: {long_}')
    age = data.get('dynasty_board_age_days')
    if age is not None and age > DYNASTY_AGE_WARN_DAYS:
        check('dynasty-age', any(re.search(r'\d+\s*(days?|weeks?)\b', l) for l in trades),
              f'dynasty board is {age:g} days old and Trades does not say so')

    inp = secs.get('inputs', [])
    itext = '\n'.join(inp).lower()
    need = {'LateRound weekly': 'weekly', 'LateRound ROS': 'ros', 'waiver columns': 'column',
            'market coverage': 'market', 'QB line': 'qb'}
    missing = [k for k, w in need.items() if not re.search(r'\b' + w, itext)]
    check('inputs-complete', not missing, f'Inputs never mentions: {missing}')
    for source, names in (data.get('unmatched') or {}).items():
        if names is None or len(names) > UNMATCHED_NAME_MAX:
            continue
        # A surname is a name: the Oct 13 report listed "Prentice, Ricard, Luepke, Okonkwo".
        words = set(norm(itext).split())
        unnamed = [n for n in names if norm(n) not in norm(itext) and norm(n).split()[-1] not in words]
        check(f'unmatched-named: {source}', not unnamed, f'unmatched but not named: {unnamed}')
    # Inputs is bullets; a non-bullet line after them is past the end of the report.
    after = [l for l in inp if l.strip() and not re.match(r'\s*([-*]|\d+\.)\s', l)]
    tail = [l.strip()[:40] for l in after if not FOOTER.search(l)]
    check('inputs-last', 'inputs' in secs and order[-1:] == ['inputs'] and not tail,
          f'after Inputs: {tail}' if tail else 'Inputs is not the last section')

    check('no-raw-paste', '```' not in report, 'a code fence: command output pasted raw')
    deadline = min(when(L['waiver_run']) for L in leagues)
    check('before-deadline', when(data['finished_at']) < deadline,
          f'finished {data["finished_at"]}, first waivers ran {deadline.isoformat()}')
    return results


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    if len(argv) != 2:
        print(__doc__)
        return 2
    report = Path(argv[0]).read_text()
    data = json.loads(Path(argv[1]).read_text())
    res = grade(report, data)
    for name, status, detail in res:
        print(f'{status}  {name}' + (f'  ({detail})' if status == 'FAIL' else ''))
    fails = sum(1 for _, s, _ in res if s == 'FAIL')
    print(f'\n{len(res) - fails}/{len(res)} checks passed.')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
