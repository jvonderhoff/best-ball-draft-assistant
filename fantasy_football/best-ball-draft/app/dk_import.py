"""Pull completed drafts from DraftKings and save them into history.

One core path serves two callers:
  • import_dk_history.py — bulk-import your past drafts (one-off backfill)
  • POST /api/drafts/sync-from-dk — pull a freshly-finished draft on demand

DK's board endpoint returns every team's picks tagged with whether they're
yours (username set when the slot's userKey matches your GUID). We keep only
your picks, enrich ADP + playoff weeks from the local players table (DK doesn't
return those), and hand them to save_draft — which write-throughs to the durable
external store (Neon) just like a normal import.

Requires working DK auth: cookies + a cached user GUID. Without the GUID, DK
picks can't be attributed to you, so nothing imports.
"""
from __future__ import annotations
import os
import logging

_log = logging.getLogger('app')

# A best-ball roster is 18–20 picks. Treat a draft with at least this many of
# YOUR picks as complete; fewer means it's still in progress → skip.
DEFAULT_MIN_PICKS = 18


def _norm(name: str) -> str:
    return (name or '').strip().lower()


def players_by_name():
    """{normalized name: {player_id, pos, team, adp, week15, week16, week17}} from the players table."""
    from app.database import get_db
    out = {}
    with get_db() as conn:
        for r in conn.execute(
            "SELECT player_id, name, pos, team, adp, week15, week16, week17 FROM players"
        ).fetchall():
            out[_norm(r['name'])] = {
                'player_id': r['player_id'], 'pos': r['pos'], 'team': r['team'], 'adp': r['adp'],
                'week15': r['week15'], 'week16': r['week16'], 'week17': r['week17'],
            }
    return out


def build_my_picks(raw_picks, name_map):
    """Filter a DK board to your picks and enrich into save_draft's pick shape.

    Pure/testable: takes the raw DK pick list + a name→enrichment map.
    Your picks are the ones DK tagged with a non-empty username (userKey matched
    your GUID). Returns picks sorted by overall pick number.
    """
    mine = [p for p in raw_picks if p.get('username')]
    mine.sort(key=lambda p: p.get('pick_number') or 0)
    out = []
    for p in mine:
        enr = name_map.get(_norm(p.get('player_name', ''))) or {}
        did = p.get('draftable_id')
        out.append({
            'id':          enr.get('player_id') or (f'dk_{did}' if did else None),
            'name':        p.get('player_name'),
            'pos':         enr.get('pos') or p.get('pos', ''),
            'team':        enr.get('team') or p.get('team', ''),
            'adp':         enr.get('adp') or 0,
            'pick_number': p.get('pick_number'),
            'week15':      enr.get('week15'),
            'week16':      enr.get('week16'),
            'week17':      enr.get('week17'),
        })
    return out


def import_one_draft(contest_id, entry_id=None, name=None, entry_fee=None,
                     min_picks=DEFAULT_MIN_PICKS, name_map=None, fetch_fn=None):
    """Pull one draft from DK and save it. Returns a result dict.

    status ∈ {imported, duplicate, incomplete, no_picks, error}
    """
    contest_id = str(contest_id)
    try:
        if fetch_fn is None:
            from app.data.api_fetcher import fetch_dk_draft_picks as fetch_fn
        result = fetch_fn(contest_id, entry_id=entry_id)
        if not result:
            return {'contest_id': contest_id, 'status': 'no_picks', 'my_picks': 0,
                    'reason': 'DK returned no board (auth/cookies or unknown draft)'}

        if name_map is None:
            name_map = players_by_name()
        my_picks = build_my_picks(result.get('picks', []), name_map)
        if len(my_picks) < min_picks:
            return {'contest_id': contest_id, 'status': 'incomplete', 'my_picks': len(my_picks),
                    'reason': f'{len(my_picks)} of your picks (< {min_picks}); draft not complete'}

        from app.database import save_draft
        saved_id = save_draft(
            num_teams=12,
            my_position=result.get('my_position') or 0,
            picks=my_picks,
            contest=name or f'Draft #{contest_id}',
            dk_draft_id=contest_id,
            entry_fee=entry_fee,
            drafted_at=(result.get('drafted_at') or '')[:10] or None,  # YYYY-MM-DD, drop time
        )
        if saved_id is None:
            return {'contest_id': contest_id, 'status': 'duplicate', 'my_picks': len(my_picks),
                    'reason': 'already in history'}
        return {'contest_id': contest_id, 'status': 'imported', 'my_picks': len(my_picks),
                'draft_id': saved_id}
    except Exception as e:
        _log.warning(f'[dk-import] {contest_id} failed: {e!r}')
        return {'contest_id': contest_id, 'status': 'error', 'my_picks': 0, 'reason': repr(e)}


def import_many(items, min_picks=DEFAULT_MIN_PICKS):
    """items: iterable of {id, entry_id?, name?, entry_fee?}. Imports each; returns result list."""
    name_map = players_by_name()
    results = []
    for it in items:
        results.append(import_one_draft(
            it.get('id'), entry_id=it.get('entry_id'), name=it.get('name'),
            entry_fee=it.get('entry_fee'), min_picks=min_picks, name_map=name_map,
        ))
    return results


def import_completed_contests(min_picks=DEFAULT_MIN_PICKS, include_incomplete=False):
    """Discover the user's contests via My Contests, then board-import the completed ones.

    This is the primary History sync: discovery yields contest_id + entry_id for
    every entered contest (live and finished), and the board path preserves real
    pick numbers and draft position — unlike the lineup-roster path. Completed =
    a populated LineupId; in-progress drafts are skipped unless include_incomplete.
    """
    from app.data.api_fetcher import fetch_my_dk_contests
    contests = fetch_my_dk_contests()
    targets = [c for c in contests if include_incomplete or c.get('lineup_id')]
    items = [{'id': c['contest_id'], 'entry_id': c['entry_id'], 'name': c['name'],
              'entry_fee': c.get('entry_fee')} for c in targets]
    return import_many(items, min_picks=min_picks)


