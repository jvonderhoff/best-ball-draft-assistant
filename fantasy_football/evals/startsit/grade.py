"""Grade a /startsit report against the start/sit JSON it was built from.

An eval of the AGENT, not of the script: `sleeper/tests` already prove the lineup
maths. What nothing checked is the report a person reads on Sunday morning, which is
written by a model following `.claude/commands/startsit.md`. Built 2026-10-15, when the
first real report graded here (Oct 11) turned out to have the judgment right and the
format wrong: prose bullets where the skill demands one table per league, the exact
"too much info to digest" failure the skill's format rule was written to stop.

    projections/.venv/bin/python evals/startsit/grade.py <report.md> <startsit.json>

Exits 1 if any check fails. Each check is a promise the skill makes in its own words:

  weekly-gate    zero market-priced starters -> say NOT A WEEKLY LINEUP, show no lineup
  every-league   one section per league in the JSON
  tables         each section carries the lineup as a table (Slot | Player | ...)
  starters       every starter is in the table, or named in the section as overruled
  never-out      no OUT or IR player appears in a lineup table
  empty-flagged  an unfilled slot is called out as empty
  brevity        at most three short lines of commentary outside the tables

Real runs (inputs + report) live in evals/startsit/runs/<date>/, which is gitignored:
the parent repo is public and they hold league ids and rosters.
"""
import json
import re
import sys
from pathlib import Path

MAX_PROSE_LINES = 3          # "at most three short lines under the tables"
MAX_LINE_CHARS = 220


def sections(report):
    """Split on ### headings: {heading text: [lines]}."""
    out, cur = {}, None
    for line in report.splitlines():
        if line.startswith('### '):
            cur = line[4:].strip()
            out[cur] = []
        elif cur is not None:
            out[cur].append(line)
    return out


def section_for(league, secs):
    want = league['name'].lower().split()[0]       # "Haters Club Dynasty" -> "haters"
    return next((lines for head, lines in secs.items() if want in head.lower()), None)


def table_names(lines):
    """Player names in the lineup table: column 2 of each row, markup stripped."""
    names = []
    for l in lines:
        cells = [c.strip() for c in l.strip().strip('|').split('|')]
        if len(cells) < 2 or set(cells[0]) <= set('-: ') or cells[0].lower() == 'slot':
            continue
        if l.strip().startswith('|'):
            names.append(re.sub(r'[*_]', '', cells[1]).strip())
    return names


def has_table(lines):
    return any(l.strip().startswith('|') and 'slot' in l.lower() and 'player' in l.lower()
               for l in lines)


def prose_lines(report):
    # `>` lines are the run's footer (dashboard status, this eval's own score), which
    # the Sunday task appends after grading; they are metadata, not commentary.
    return [l for l in report.splitlines()
            if l.strip() and not l.strip().startswith(('|', '#', '**Bench', '>'))]


def grade(report, data):
    results = []

    def check(name, ok, detail=''):
        results.append((name, 'PASS' if ok else 'FAIL', detail))

    secs = sections(report)
    any_table = any(l.strip().startswith('|') for l in report.splitlines())

    if data.get('not_weekly'):
        check('weekly-gate', 'NOT A WEEKLY LINEUP' in report.upper() and not any_table,
              'no starter took a market price: the report must say so and show no lineup')
        return results       # nothing else is meaningful on a broken seam
    check('weekly-gate', 'NOT A WEEKLY LINEUP' not in report.upper(),
          'the seam was fine, but the report claims it was not')

    for L in data['leagues']:
        lines = section_for(L, secs)
        name = L['name']
        check(f'every-league: {name}', lines is not None, 'no ### section for this league')
        if lines is None:
            continue
        text = '\n'.join(lines)
        check(f'tables: {name}', has_table(lines), 'lineup is not a table (Slot | Player | ...)')
        in_table = set(table_names(lines))
        starters = [s['player']['name'] for s in L['slots'] if s.get('player')]
        # An overrule is explained in the lines UNDER the tables, which follow the last
        # league's section, so look for the name in any commentary, not just this one.
        notes = '\n'.join(prose_lines(report))
        unexplained = [p for p in starters if p not in in_table and p not in text and p not in notes]
        check(f'starters: {name}', not unexplained,
              f'missing and never mentioned: {", ".join(unexplained)}')
        blocked = [p['name'] for p in L.get('out', []) + L.get('ir', [])]
        started = sorted(set(blocked) & in_table)
        check(f'never-out: {name}', not started, f'OUT/IR player in the lineup: {", ".join(started)}')
        if L.get('empty_slots'):
            check(f'empty-flagged: {name}', 'empty' in text.lower(),
                  f'unfilled {", ".join(map(str, L["empty_slots"]))} not called out')

    prose = prose_lines(report)
    long_ = [l for l in prose if len(l) > MAX_LINE_CHARS]
    check('brevity', len(prose) <= MAX_PROSE_LINES and not long_,
          f'{len(prose)} lines of commentary (max {MAX_PROSE_LINES}), '
          f'{len(long_)} over {MAX_LINE_CHARS} chars')
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
