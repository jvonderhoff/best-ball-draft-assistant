#!/usr/bin/env python3
"""Score v2SurvivalProb against real completed drafts.

The model predicts, from ADP, whether a player is still on the board at your next
pick. This checks that prediction against what actually happened — every seat of
every complete board in drafts.db, not just yours, and not a simulation. ADP is the
model's INPUT; the truth is the real pick number.

Written 2026-08-24, when it turned out nobody had ever checked. Two defects:

  * the probability was UNCONDITIONAL. It ignored the one thing you always know when
    you ask — that the player is still available right now. A player whose ADP passed
    ten picks ago and is still there has revealed the room does not want him, and the
    old form kept predicting he was about to go, every pick, forever.
  * V2_ADP_SIGMA_RATIO was 0.30 by judgement. The boards say 2-5x too wide.

        model                     ratio   calib err   Brier
        unconditional (old)        0.30      0.093   0.0588
        CONDITIONAL                0.30      0.037   0.0521
        CONDITIONAL                0.10      0.008   0.0387

Both shipped. Re-run this as more drafts finish — 33 boards is enough to establish
the direction and not enough to defend a third decimal place.

    python3 tools/calibrate-survival.py
    python3 tools/calibrate-survival.py --sweep

Needs full boards, so the drafts must have been imported with --include-opponents:

    xargs .venv/bin/python import_dk_history.py --include-opponents --ids < ids.txt
"""
from __future__ import annotations

import argparse
import math
import os
import sqlite3
from collections import defaultdict

DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'drafts.db')

# Kept in step with static/recommender-v2.js by hand. If they drift, this script is
# scoring a model the app does not run — check both when either changes.
SIGMA_FLOOR = 5.0
SIGMA_RATIO = 0.10


def _ncdf(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def _seat(pick: int, teams: int) -> int:
    """Snake seat, 0-based. Verified against the `mine` flag: 5037/5037 on first run."""
    rnd, idx = (pick - 1) // teams, (pick - 1) % teams
    return (teams - 1 - idx) if rnd % 2 else idx


def load_decisions(db: str = DB) -> list:
    """(adp, from_pick, to_pick, survived) for every seat's consecutive pick pair.

    Only boards with opponents are usable — a 20-pick row set is your picks alone and
    cannot say whether anyone else was still available.
    """
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    meta = {r['id']: dict(r) for r in conn.execute('SELECT * FROM drafts')}
    picks_by = defaultdict(list)
    for r in conn.execute('SELECT * FROM draft_picks WHERE adp IS NOT NULL '
                          'ORDER BY draft_id, pick_number'):
        picks_by[r['draft_id']].append(r)

    out = []
    for did, picks in picks_by.items():
        if len(picks) < 200:
            continue
        teams = (meta.get(did) or {}).get('num_teams') or 12
        taken = {p['player_id']: p['pick_number'] for p in picks}
        seats = defaultdict(list)
        for p in picks:
            seats[_seat(p['pick_number'], teams)].append(p['pick_number'])
        for nums in seats.values():
            nums.sort()
            for i in range(len(nums) - 1):
                a, b = nums[i], nums[i + 1]
                for pl in picks:
                    tp = taken[pl['player_id']]
                    if tp <= a:
                        continue          # already gone; not a live decision
                    out.append((pl['adp'], a, b, 1 if tp > b else 0))
    return out


def score(decisions: list, ratio: float, conditional: bool, floor: float = SIGMA_FLOOR):
    """Mean |calibration error| over 10% bins, plus Brier. Returns (err, brier, bins)."""
    bins = defaultdict(lambda: [0.0, 0, 0])
    brier = 0.0
    for adp, a, b, hit in decisions:
        sigma = max(floor, ratio * adp)
        s_to = 1 - _ncdf((b - adp) / sigma)
        if conditional:
            s_now = 1 - _ncdf((a - adp) / sigma)
            pr = min(1.0, s_to / s_now) if s_now > 1e-9 else 1.0
        else:
            pr = s_to
        brier += (pr - hit) ** 2
        k = min(int(pr * 10), 9)
        bins[k][0] += pr
        bins[k][1] += 1
        bins[k][2] += hit
    err = n = 0.0
    for p, cnt, hits in bins.values():
        if cnt < 50:
            continue
        err += abs(p / cnt - hits / cnt) * cnt
        n += cnt
    return (err / n if n else float('nan')), brier / len(decisions), bins


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--sweep', action='store_true', help='try a range of sigma ratios')
    args = ap.parse_args()

    d = load_decisions()
    if not d:
        print('no full boards in drafts.db — import with --include-opponents first')
        return 1
    print(f'{len(d):,} real decisions from complete boards\n')

    if args.sweep:
        print(f"  {'model':<16}{'ratio':>7}{'calib err':>11}{'Brier':>9}")
        for cond in (False, True):
            for ratio in (0.30, 0.20, 0.15, 0.12, 0.10, 0.08, 0.06):
                e, b, _ = score(d, ratio, cond)
                print(f"  {'conditional' if cond else 'unconditional':<16}"
                      f"{ratio:>7.2f}{e:>11.3f}{b:>9.4f}")
        return 0

    old_e, old_b, _ = score(d, 0.30, False)
    new_e, new_b, bins = score(d, SIGMA_RATIO, True)
    print(f'  old (unconditional, 0.30):  calib err {old_e:.3f}   Brier {old_b:.4f}')
    print(f'  live (conditional, {SIGMA_RATIO}):    calib err {new_e:.3f}   Brier {new_b:.4f}\n')
    print(f"  {'predicted':<12}{'n':>10}{'pred':>8}{'ACTUAL':>9}{'err':>8}")
    for k in sorted(bins):
        p, cnt, hits = bins[k]
        if cnt < 50:
            continue
        print(f"  {f'{k*10}-{k*10+10}%':<12}{cnt:>10,}{p/cnt:>8.3f}{hits/cnt:>9.3f}"
              f"{p/cnt - hits/cnt:>+8.3f}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
