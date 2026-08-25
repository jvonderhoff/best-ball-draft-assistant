#!/usr/bin/env python3
"""Pre-draft check: is the deployed app serving current, real data?

Every check here corresponds to something that has ACTUALLY gone wrong in this
project, each one silent at the time — plausible numbers, no error, nothing logged.
That is the pattern worth defending against, and the reason this is a script you run
rather than a paragraph in CLAUDE.md you are supposed to remember:

  * 2026-08-20  A deploy wiped the players table, it reseeded from the committed
                player_cache.json, and /recommend showed a receiver at ADP 78 against
                DK's live 113 mid-draft. /api/freshness called it `ok` because it
                dated the pool by file mtime, which the deploy had just reset.
  * 2026-08-20  The published payload arrived with no sources_meta, so nothing could
                say how old ESPN or props were behind the numbers V2 was scoring.
  * 2026-08-19  Publishing stopped and prod silently reverted to the frozen local
                fallback build. `source` on /api/projections-v2 is the only tell.
  * earlier     A boot that could not reach Postgres left rankings_seed.json — a
                COMMITTED bootstrap file — serving as the live board at 0.55 of every
                valuation, for two months.
  * earlier     projections_hydrated false drops 356 players from two projection
                sources to one and doubles the ECR blend. Every score shifts,
                nothing errors.

Usage:

    python3 tools/preflight.py                       # checks prod
    python3 tools/preflight.py --target http://localhost:8000

Exits non-zero if anything is FAIL, so it can gate a pre-draft routine. WARN is for
states that are legitimate but worth seeing — most often a recent deploy, where prod
correctly serves the committed seed until the 6h TTL trips.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

PROD = 'https://best-ball-draft-assistant.onrender.com'
SEED = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    'app', 'data', 'player_cache.json')

OK, WARN, FAIL = 'OK  ', 'WARN', 'FAIL'
_results: list[tuple[str, str, str]] = []


def check(level: str, name: str, detail: str) -> None:
    _results.append((level, name, detail))


def get(target: str, path: str):
    with urllib.request.urlopen(target.rstrip('/') + path, timeout=45) as r:
        return json.load(r)


def check_freshness(target: str) -> dict:
    """Every row of /api/freshness, with the pool called out separately.

    The pool gets its own line because it is the only source that refreshes on its
    own, so a stale pool means something is wrong rather than something is unrun.
    """
    d = get(target, '/api/freshness')
    items = {i['label'].strip(): i for i in d['items']}

    pool = items.get('DK pool / ADP')
    if pool:
        lvl = {'ok': OK, 'stale': FAIL}.get(pool['state'], WARN)
        # Note the self-healing, because otherwise it reads as a flaky check: the seed
        # comparison below calls /api/players, which trips the 6h TTL and kicks off the
        # background refresh. A genuine FAIL therefore clears on a re-run with nobody
        # having done anything. Saying so beats letting someone conclude the tool
        # is unreliable — and it was a real staleness either way.
        check(lvl, 'DK pool / ADP',
              f"{pool['age_hours']}h old, {pool['rows']} players"
              + ('' if lvl == OK else ' — stale. Running this check triggers a refresh,'
                                      ' so re-run in ~30s and it should clear; if it'
                                      ' does not, the DK fetch itself is failing'))

    if d.get('serving') != 'pushed':
        check(FAIL, 'V2 inputs',
              'serving the LOCAL FALLBACK build — publishing has stopped, and nothing'
              ' else says so. Re-publish from the projections app.')
    else:
        check(OK, 'V2 inputs', 'serving the published payload')

    stale = [k for k, i in items.items() if i['state'] == 'stale' and k != 'DK pool / ADP']
    unknown = [k for k, i in items.items() if i['state'] == 'unknown']
    if stale:
        check(WARN, 'source ages', 'stale: ' + ', '.join(stale))
    if unknown:
        check(WARN, 'source ages', 'age unknown: ' + ', '.join(unknown))
    if not stale and not unknown:
        n = sum(1 for i in items.values() if i['label'].strip().startswith('└'))
        check(OK, 'source ages', f'{n} sources reported, none stale')

    # Handed to check_serving_seed so it can tell "prod IS the seed" from "the seed
    # happens to be current". Returned rather than re-fetched: a second /api/freshness
    # would race the refresh this run's own /api/players call kicks off.
    return items


def check_stores(target: str) -> None:
    """Hydration, which is the difference between a real board and a seed file.

    Counts alone are NOT enough and that is exactly how a two-month-old board went
    unnoticed: by the time anyone calls this endpoint the database has woken up and
    reports a healthy count either way.
    """
    d = get(target, '/api/stores/status')

    if d.get('rankings_hydrated') is True:
        check(OK, 'rankings hydrated', f"{d['external'].get('player_rankings')} ranks from Postgres")
    else:
        check(FAIL, 'rankings hydrated',
              'FALSE — the live board is the committed rankings_seed.json, at 0.55 of'
              ' every valuation. Saving is blocked (409) to protect the real board.')

    ph = d.get('projections_hydrated') or {}
    bad = [k for k, v in ph.items() if v is not True]
    if ph and not bad:
        check(OK, 'projections hydrated', ', '.join(sorted(ph)))
    elif bad:
        check(FAIL, 'projections hydrated',
              f"FALSE for {', '.join(bad)} — V2 may be running on Sleeper alone, with"
              ' the ECR blend doubled. Every score shifts and nothing errors.')

    for key in ('rankings_warning', 'projections_warning'):
        if d.get(key):
            check(WARN, key, str(d[key]))

    if 'UNREACHABLE' in json.dumps(d.get('external', {})):
        check(FAIL, 'Postgres', 'a durable store is UNREACHABLE — writes will not survive a deploy')


def check_serving_seed(target: str, pool_ts: float | None = None) -> None:
    """Is prod serving the committed bootstrap cache rather than a live pool?

    Diagnostic rather than pass/fail: immediately after a deploy this is the CORRECT
    state, because the filesystem is ephemeral and the table reseeds from this file.
    It earns its place by explaining a stale pool instead of leaving it a mystery —
    which is precisely what cost an afternoon on 2026-08-20.
    """
    try:
        with open(SEED) as f:
            seed = json.load(f)
    except Exception as e:
        check(WARN, 'seed comparison', f'could not read the committed cache: {e}')
        return

    seed_players = seed.get('players') or []
    seed_adp = {p['id']: p.get('adp') for p in seed_players if p.get('id')}

    live = get(target, '/api/players')
    live_players = live.get('players') if isinstance(live, dict) else live
    live_adp = {p.get('player_id') or p.get('id'): p.get('adp') for p in live_players}

    shared = [k for k in seed_adp if k in live_adp and seed_adp[k] is not None]
    if not shared:
        check(WARN, 'seed comparison', 'no overlapping ids — cannot compare')
        return
    identical = sum(1 for k in shared if seed_adp[k] == live_adp[k])
    pct = identical / len(shared) * 100

    # **Matching ADPs are NOT enough to conclude prod is serving the seed**, and
    # assuming they were produced a wrong warning the day this was written: a freshly
    # committed seed and a fresh pull agree almost perfectly, because ADP barely moves
    # in a few hours. Identical values have two very different causes and only the
    # TIMESTAMP separates them — if prod's pool was fetched at the same moment the seed
    # was, it IS the seed. Same lesson as rankings_hydrated: check that the thing
    # happened, do not infer it from a signal that looks the same either way.
    seed_ts = seed.get('fetched_at')
    same_fetch = (seed_ts and pool_ts and abs(pool_ts - seed_ts) < 60)

    if same_fetch:
        check(WARN, 'seed comparison',
              f'prod is serving the COMMITTED SEED — its pool has the seed\'s own '
              f'fetch time ({pct:.0f}% of ADPs identical). Normal right after a deploy;'
              ' it clears on the next /api/players call once the 6h TTL trips.')
    elif pct > 95:
        check(OK, 'seed comparison',
              f'{pct:.0f}% of ADPs match the seed, but prod fetched its own pool — the'
              ' seed is simply current too')
    else:
        check(OK, 'seed comparison',
              f'{pct:.0f}% match the committed seed — prod has pulled a live pool')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--target', default=os.environ.get('DRAFT_APP_URL', PROD))
    args = ap.parse_args()

    print(f'preflight: {args.target}\n')
    # check_freshness runs first and hands over the pool timestamp: the seed check
    # needs it, and re-fetching would race the refresh its own /api/players call starts.
    items = {}
    for fn in (check_freshness, check_stores, check_serving_seed):
        try:
            if fn is check_serving_seed:
                pool = (items or {}).get('DK pool / ADP') or {}
                fn(args.target, pool.get('updated_at'))
            else:
                got = fn(args.target)
                if isinstance(got, dict):
                    items = got
        except Exception as e:
            check(FAIL, fn.__name__.replace('check_', ''), f'check itself failed: {e}')

    for level, name, detail in _results:
        print(f'  [{level}] {name:<24} {detail}')

    fails = sum(1 for l, _, _ in _results if l == FAIL)
    warns = sum(1 for l, _, _ in _results if l == WARN)
    print(f'\n{"FAIL" if fails else "PASS"} — {fails} failing, {warns} worth a look')
    if fails:
        print('Do not draft against this until it is resolved.')
    return 1 if fails else 0


if __name__ == '__main__':
    raise SystemExit(main())
