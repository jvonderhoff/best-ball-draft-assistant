"""Playoff best ball, server side: validate the pushed inputs, join DK's playoff
pool and live picks to the projections export. docs/PLAYOFF_DESIGN.md step 3.

The simulator and recommender run in the browser (static/playoff-sim.js,
static/recommender-playoff.js). This module exists so that the two joins that
need NAME MATCHING happen here, through app/data/names.py, the one matcher this
repo is allowed (../CLAUDE.md, checked by tools/check_rules.py) -- not in a
third copy in JavaScript.

Join order, both joins: dk_player_id, then normalize_name + team, then
normalize_name alone if that is unique. Anything else is UNMATCHED and returned
as such: a DK player the export does not know cannot be valued, and saying so
beats scoring him as a generic body (the failure V2 had, CLAUDE.md "Name
matching").
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from app.data.names import normalize_name

MIRROR = Path(__file__).resolve().parent / 'data' / 'pushed_playoff.json'
REQUIRED_BRACKET = ('season', 'seeds', 'ratings', 'hfa', 'sigma', 'reach')
REQUIRED_PLAYERS = ('meta', 'params', 'team_implied', 'players')


def validate(payload: dict) -> str | None:
    """A reason to refuse, or None. Refused rather than stored, because a bad
    payload produces plausible recommendations rather than an error."""
    if not isinstance(payload, dict):
        return 'body must be a JSON object'
    br, pl = payload.get('bracket'), payload.get('players')
    if not isinstance(br, dict) or not isinstance(pl, dict):
        return 'body needs {"bracket": ..., "players": ...}'
    for k in REQUIRED_BRACKET:
        if k not in br:
            return f'bracket missing {k!r}'
    for k in REQUIRED_PLAYERS:
        if k not in pl:
            return f'players missing {k!r}'
    if br['season'] != pl['meta'].get('season'):
        return f"bracket is season {br['season']}, players are {pl['meta'].get('season')}"
    if br.get('mode') == 'season_sim':
        # Mid-season (projections pipeline/season_sim.py): every team can still
        # get in, so all 32 are exported, and the seeds that matter are the
        # sampled ones -- each of which must itself be a whole bracket.
        teams = set(br.get('conf') or {})
        if len(teams) != 32:
            return f'season-sim bracket lists {len(teams)} teams, not 32'
        seasons = br.get('seasons') or []
        if not seasons:
            return 'season-sim bracket has no simulated seasons'
        if any(len(s.get('t', [])) not in (12, 14) or len(set(s['t'])) != len(s['t'])
               or len(s.get('d', [])) != len(s['t']) for s in seasons):
            return 'a simulated season is not a whole bracket'
    else:
        teams = {t for c in br['seeds'].values() for t in c}
        if len(teams) not in (12, 14):
            return f'bracket has {len(teams)} distinct seeded teams'
    if set(pl['meta'].get('teams') or []) != teams:
        return 'players were exported for a different bracket (team sets differ)'
    if not pl['players']:
        return 'no players'
    starters = {}
    for p in pl['players']:
        if p.get('role') == 'starter':
            starters[p['team']] = starters.get(p['team'], 0) + 1
    bad = sorted(t for t in teams if starters.get(t) != 1)
    if bad:
        # A team with no starting QB passes nobody; with two, both are simulated
        # starting every game. Either is silent downstream.
        return f'not exactly one starting QB: {bad}'
    return None


def store(payload: dict) -> dict:
    from app import playoff_store
    payload = {**payload, 'uploaded_at': time.time()}
    durable = playoff_store.save(payload)
    MIRROR.write_text(json.dumps(payload))
    return {'durable': durable, 'uploaded_at': payload['uploaded_at']}


def load() -> tuple[dict | None, str]:
    """(payload, source). Postgres when reachable -- the mirror may be another
    instance's leftover -- else the disk mirror, else nothing."""
    from app import playoff_store
    stored = playoff_store.load()
    if stored:
        MIRROR.write_text(json.dumps(stored))
        return stored, 'postgres'
    if MIRROR.exists():
        try:
            return json.loads(MIRROR.read_text()), 'disk' if stored is None else 'disk (postgres empty)'
        except ValueError:
            pass
    return None, 'none'


def _index(players: list):
    by_dk, by_name_team, by_name = {}, {}, {}
    for p in players:
        if p.get('dk_player_id'):
            by_dk[str(p['dk_player_id'])] = p
        k = normalize_name(p['name'])
        by_name_team[(k, p['team'])] = p
        by_name.setdefault(k, []).append(p)
    return by_dk, by_name_team, by_name


def _match(idx, dk_id, name, team):
    by_dk, by_name_team, by_name = idx
    if dk_id and str(dk_id) in by_dk:
        return by_dk[str(dk_id)], 'id'
    k = normalize_name(name)
    if (k, team) in by_name_team:
        return by_name_team[(k, team)], 'name+team'
    cands = by_name.get(k, [])
    if len(cands) == 1:
        return cands[0], 'name'
    return None, None


def join_pool(pool: list, players: list) -> dict:
    """DK pool rows {name, pos, team, adp, dk_id} -> each with the export's gsis_id.

    Only QB/RB/WR/TE are joined; DK may list others and the simulator has no model
    for them. Unmatched skill players are returned by name, not dropped.
    """
    idx = _index(players)
    rows, unmatched, how = [], [], {}
    for r in pool:
        if r.get('pos') not in ('QB', 'RB', 'WR', 'TE'):
            continue
        p, via = _match(idx, r.get('dk_id'), r.get('name'), r.get('team'))
        if not p:
            unmatched.append({'name': r.get('name'), 'team': r.get('team'),
                              'pos': r.get('pos'), 'adp': r.get('adp')})
            continue
        how[via] = how.get(via, 0) + 1
        rows.append({'gsis_id': p['gsis_id'], 'dk_id': r.get('dk_id'), 'name': r.get('name'),
                     'pos': r.get('pos'), 'team': r.get('team'), 'adp': r.get('adp')})
    return {'players': rows, 'unmatched': unmatched, 'matched_by': how}


def map_picks(picks: list, players: list) -> dict:
    """Live DK picks -> each with gsis_id (None if unmatched, and listed)."""
    idx = _index(players)
    out, unmatched = [], []
    for pk in picks:
        p, via = _match(idx, None, pk.get('player_name'), pk.get('team'))
        out.append({**pk, 'gsis_id': p['gsis_id'] if p else None, 'matched_by': via})
        if not p:
            unmatched.append(pk.get('player_name'))
    return {'picks': out, 'unmatched': unmatched}
