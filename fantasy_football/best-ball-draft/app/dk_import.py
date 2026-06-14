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


def import_one_draft(contest_id, entry_id=None, name=None, min_picks=DEFAULT_MIN_PICKS,
                     name_map=None, fetch_fn=None):
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
    """items: iterable of {id, entry_id?, name?}. Imports each; returns result list."""
    name_map = players_by_name()
    results = []
    for it in items:
        results.append(import_one_draft(
            it.get('id'), entry_id=it.get('entry_id'), name=it.get('name'),
            min_picks=min_picks, name_map=name_map,
        ))
    return results


# ── Completed drafts via the lineup endpoint ──────────────────────────────────
# DK drops finished drafts off /drafts/live, but getlineupswithplayersforuser
# returns their full 20-man rosters directly (keyed by LineupId, no entry_id).
# This is the canonical source for completed-draft history.

def build_lineup_picks(lineup, name_map):
    """Enrich a normalised lineup's players into save_draft's pick shape.

    No true draft order is available, so pick_number is the roster index.
    """
    out = []
    for i, p in enumerate(lineup.get('players', [])):
        enr = name_map.get(_norm(p.get('name', ''))) or {}
        out.append({
            'id':          enr.get('player_id') or (f"dk_{p.get('pdkid')}" if p.get('pdkid') else None),
            'name':        p.get('name'),
            'pos':         enr.get('pos') or p.get('pos', ''),
            'team':        enr.get('team') or p.get('team', ''),
            'adp':         enr.get('adp') or 0,
            'pick_number': i + 1,
            'week15':      enr.get('week15'),
            'week16':      enr.get('week16'),
            'week17':      enr.get('week17'),
        })
    return out


def import_lineups(lineups=None, min_picks=DEFAULT_MIN_PICKS):
    """Import completed-draft rosters from the lineup endpoint.

    Keyed by LineupId (as dk_draft_id) so it dedups independently of the live
    contest path. Returns a result list shaped like import_many.
    """
    if lineups is None:
        from app.data.api_fetcher import fetch_my_dk_lineups
        lineups = fetch_my_dk_lineups()
    name_map = players_by_name()
    from app.database import save_draft
    results = []
    for L in lineups:
        lid = L.get('lineup_id')
        picks = build_lineup_picks(L, name_map)
        if len(picks) < min_picks:
            results.append({'contest_id': lid, 'status': 'incomplete', 'my_picks': len(picks),
                            'reason': f'{len(picks)} players (< {min_picks})'})
            continue
        try:
            saved_id = save_draft(num_teams=12, my_position=0, picks=picks,
                                  contest=L.get('name') or f'Lineup {lid}', dk_draft_id=lid)
            if saved_id is None:
                results.append({'contest_id': lid, 'status': 'duplicate', 'my_picks': len(picks),
                                'reason': 'already in history'})
            else:
                results.append({'contest_id': lid, 'status': 'imported', 'my_picks': len(picks),
                                'draft_id': saved_id})
        except Exception as e:
            _log.warning(f'[dk-import] lineup {lid} failed: {e!r}')
            results.append({'contest_id': lid, 'status': 'error', 'my_picks': len(picks), 'reason': repr(e)})
    return results
