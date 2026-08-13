#!/usr/bin/env python3
"""Export real DK draft boards as harness field rosters.

The harness builds its 1,089-team final out of ADP bots, which §9.2 calls its
biggest structural weakness: sharpening the field *widened* V2's edge (§5.3), so
field quality changes the answer rather than merely scaling it. The fix is real
opponents, and DK hands us twelve of them per draft.

Writes tools/.field-cache/real-rosters.json:

    {"generated_at": ..., "source_drafts": N, "rosters": [[player_id, ...], ...]}

Deliberately flat. The harness needs a bag of rosters to add to its candidate
pool, not draft structure — selectFinalField flattens pods into candidates
anyway, and keeping the shape simple means no coupling to how drafts are stored.

YOUR OWN SEAT IS EXCLUDED by default. A field made partly of your own rosters
measures you against yourself, which is the one opponent whose behaviour your
edge cannot be estimated against. --include-mine overrides it for portfolio work,
where that is the whole point.

Only boards with more than one seat are usable: drafts imported before
`include_opponents` landed hold your ~20 picks alone, and those are the rosters
we most need to leave out. Run the backfill first — this reports how many drafts
qualified so the difference is visible rather than silent.

Usage:
  python3 tools/export-real-rosters.py
  python3 tools/export-real-rosters.py --min-roster 18 --include-mine
  DATABASE_URL=postgres://... python3 tools/export-real-rosters.py
"""
import argparse
import json
import os
import sys
import time
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

OUT_DIR = os.path.join(ROOT, 'tools', '.field-cache')
OUT_PATH = os.path.join(OUT_DIR, 'real-rosters.json')

# A best-ball roster is 20 picks. Allow a couple of unresolvable players — a name
# that has drifted, or someone dropped from the pool since — before discarding
# the roster. Below this it is a different team from the one that was drafted.
DEFAULT_MIN_ROSTER = 18


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--min-roster', type=int, default=DEFAULT_MIN_ROSTER,
                    help=f'drop rosters with fewer resolvable players (default {DEFAULT_MIN_ROSTER})')
    ap.add_argument('--include-mine', action='store_true',
                    help='keep your own seat too (default: opponents only)')
    ap.add_argument('--out', default=OUT_PATH)
    args = ap.parse_args()

    from app.database import get_all_drafts

    drafts = get_all_drafts(include_opponents=True)
    if not drafts:
        print('No drafts in history. Nothing to export.', file=sys.stderr)
        return 1

    # The harness resolves players by id against its own pool, so anything not in
    # the current pool is dead weight. Filter here rather than there, so the count
    # this prints is the count the harness will actually use.
    pool_path = os.path.join(ROOT, 'app', 'data', 'player_cache.json')
    with open(pool_path) as f:
        raw = json.load(f)
    pool = {p['id'] for p in (raw['players'] if isinstance(raw, dict) else raw)}

    rosters = []
    stats = defaultdict(int)
    full_boards = 0

    for d in drafts:
        picks = d.get('picks') or []
        # Group by seat. draft_picks has no seat column — it does not need one,
        # because a snake draft's seat is recoverable from the pick number, and
        # that is true of any 12-team board however it was imported.
        n_teams = d.get('num_teams') or 12
        by_seat = defaultdict(list)
        for p in picks:
            pn = p.get('pick_number')
            if not pn:
                continue
            rnd = (pn - 1) // n_teams
            idx = (pn - 1) % n_teams
            seat = idx if rnd % 2 == 0 else n_teams - 1 - idx
            by_seat[seat].append(p)

        if len(by_seat) <= 1:
            stats['drafts_own_picks_only'] += 1
            continue
        full_boards += 1

        for seat, seat_picks in by_seat.items():
            is_mine = any(p.get('mine') in (1, True) for p in seat_picks)
            if is_mine and not args.include_mine:
                stats['rosters_skipped_mine'] += 1
                continue
            ids = [p['player_id'] for p in seat_picks
                   if p.get('player_id') and p['player_id'] in pool]
            if len(ids) < args.min_roster:
                stats['rosters_too_thin'] += 1
                continue
            rosters.append(ids)
            stats['rosters_kept'] += 1

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(args.out, 'w') as f:
        json.dump({'generated_at': time.time(),
                   'source_drafts': full_boards,
                   'include_mine': args.include_mine,
                   'rosters': rosters}, f)

    print(f'drafts in history:        {len(drafts)}')
    print(f'  with a full board:      {full_boards}')
    print(f'  own picks only:         {stats["drafts_own_picks_only"]}  '
          f'(imported before opponent seats were retained — re-import to use)')
    print(f'rosters kept:             {stats["rosters_kept"]}')
    print(f'  skipped (yours):        {stats["rosters_skipped_mine"]}')
    print(f'  skipped (< {args.min_roster} players): {stats["rosters_too_thin"]}')
    print(f'\nwrote {args.out}')
    if not rosters:
        print('\nNo usable rosters. Re-import your drafts with opponent seats first.',
              file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
