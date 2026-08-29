#!/usr/bin/env python3
"""Refresh the committed pool seed — app/data/player_cache.json — and prove it is sane.

**This file is a production input, not a build artifact.** Render's filesystem is
ephemeral, so every deploy and every spin-down wipes the players table and
`_seed_players_if_empty` repopulates it from this committed JSON. Prod then serves
that snapshot until the 6h TTL trips. Its age is therefore the worst ADP any cold
start can show, and it has been the direct cause of two live-draft failures:

  * 2026-08-20  the seed was 92.6h old; a receiver read ADP 78 against DK's 113.
  * 2026-08-29  the seed was 109.7h old; Oronde Gadsden II read 178 against DK's
                184.4, having slid 163.7 -> 184.4 in the days the file sat still.

Refreshing it by hand is three lines, which is exactly why it kept not happening, and
why doing it by hand is the risky version: a refresh REBUILDS every row from DK, so
any field not set in that loop is silently dropped. That is not hypothetical — a
routine refresh once wiped `ecr_rank` from all 400+ players and left the recommender's
rank blend with nothing to blend. Every check below exists because the failure it
guards against is invisible in the resulting file.

The old file is restored and the run exits non-zero if anything fails validation, so a
bad DK response cannot land in the working tree waiting to be committed.

Usage:

    python3 tools/refresh-seed.py            # refresh, validate, report
    python3 tools/refresh-seed.py --check    # report the current file's age only

Commit the result deliberately, on its own. It changes what production serves.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import sys
import time
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED = os.path.join(ROOT, 'app', 'data', 'player_cache.json')
sys.path.insert(0, ROOT)


def load(path):
    with open(path) as f:
        return json.load(f)


def describe(label, d):
    ts = d.get('fetched_at')
    when = datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M') if ts else 'unknown'
    age = f'{(time.time() - ts) / 3600:.1f}h' if ts else '?'
    print(f'  {label:<8} {len(d.get("players") or []):>4} players   {when}   age {age}')


def validate(old, new) -> list[str]:
    """Everything that has to hold for the new file to be committable.

    Returns the failures. Each one corresponds to a way a refresh has produced, or
    could produce, a file that looks fine and is not.
    """
    bad = []
    op, np_ = old.get('players') or [], new.get('players') or []

    # A partial DK response is the realistic bad case — the fetch succeeds, returns a
    # fraction of the pool, and _save_cache writes it without complaint.
    if len(np_) < len(op) * 0.9:
        bad.append(f'player count collapsed: {len(op)} -> {len(np_)}')

    # A refresh rebuilds every row, so a field can vanish wholesale. ecr_rank has
    # actually done this; it feeds the rank blend and its absence does not error.
    ko = {k for p in op for k in p}
    kn = {k for p in np_ for k in p}
    if ko - kn:
        bad.append(f'fields lost from every row: {sorted(ko - kn)}')

    def ecr_rate(ps):
        return sum(1 for p in ps if p.get('ecr_rank')) / len(ps) if ps else 0
    r_old, r_new = ecr_rate(op), ecr_rate(np_)
    if r_new < r_old * 0.8:
        bad.append(f'ECR coverage dropped: {r_old:.0%} -> {r_new:.0%} '
                   '(the FantasyPros merge is non-fatal and fails quietly)')

    ts = new.get('fetched_at')
    if not ts:
        bad.append('no fetched_at — /api/freshness dates the pool by this field and '
                   'would report the age as unknown')
    elif time.time() - ts > 600:
        bad.append(f'fetched_at is {(time.time() - ts) / 60:.0f} minutes old — the '
                   'file was not actually rewritten')
    return bad


def report_moves(old, new) -> None:
    o = {p['id']: p for p in (old.get('players') or []) if p.get('id')}
    n = {p['id']: p for p in (new.get('players') or []) if p.get('id')}
    shared = [k for k in n if k in o and o[k].get('adp') and n[k].get('adp')]
    if not shared:
        return
    moves = sorted(((n[k]['adp'] - o[k]['adp'], n[k]['name'], o[k]['adp'], n[k]['adp'])
                    for k in shared), key=lambda t: -abs(t[0]))
    print(f'\n  {len(set(n) - set(o))} added, {len(set(o) - set(n))} removed, '
          f'{len(shared)} shared')
    print(f'  ADP move across shared ids: median '
          f'{statistics.median(abs(m[0]) for m in moves):.1f}, '
          f'mean abs {statistics.mean(abs(m[0]) for m in moves):.2f}')
    # The mean is reassuring and the tail is the point: on 2026-08-29 the median move
    # was 1.0 while four players had moved 15-28 spots. Averages hide the players a
    # stale seed actually misprices.
    print('  biggest movers:')
    for delta, name, a, b in moves[:8]:
        print(f'    {name:<26} {a:6.1f} -> {b:6.1f}  ({delta:+.1f})')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--check', action='store_true',
                    help="report the committed seed's age without refreshing")
    args = ap.parse_args()

    before = load(SEED)
    print('committed pool seed:')
    describe('current', before)
    if args.check:
        ts = before.get('fetched_at')
        return 0 if ts and time.time() - ts < 24 * 3600 else 1

    backup = SEED + '.bak'
    shutil.copy2(SEED, backup)
    try:
        from app.data.api_fetcher import fetch_players
        print()
        fetch_players(force_refresh=True)
        after = load(SEED)
    except Exception as e:
        shutil.move(backup, SEED)
        print(f'\n  FAILED: {e!r} — old seed restored, nothing changed')
        return 1

    print()
    describe('was', before)
    describe('now', after)

    failures = validate(before, after)
    if failures:
        shutil.move(backup, SEED)
        print('\n  REJECTED — old seed restored, nothing changed:')
        for f in failures:
            print(f'    ✗ {f}')
        return 1

    os.remove(backup)
    report_moves(before, after)
    print('\n  ✓ validated: count, schema, ECR coverage, fetched_at')
    print('\n  Commit it on its own — it changes what production serves:')
    print('    git add app/data/player_cache.json')
    print("    git commit -m 'Refresh the committed pool seed'")
    return 0


if __name__ == '__main__':
    sys.exit(main())
