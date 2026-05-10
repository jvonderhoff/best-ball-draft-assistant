"""
Fetches NFL player data from the Sleeper API.
Docs: https://docs.sleeper.com/
"""
import json
import os
import requests

CACHE_PATH = os.path.join(os.path.dirname(__file__), 'player_cache.json')
SLEEPER_STATE_URL = 'https://api.sleeper.app/v1/state/nfl'
SLEEPER_PLAYERS_URL = 'https://api.sleeper.app/v1/players/nfl'

SKILL_POSITIONS = {'QB', 'RB', 'WR', 'TE'}

# TODO: update with official 2026 bye weeks once the NFL schedule is released.
# Sleeper's /schedule/nfl/regular/2026 endpoint returns 404 until then.
BYE_WEEKS_2026 = {
    'ARI': 11, 'ATL': 12, 'BAL': 14, 'BUF': 12,
    'CAR': 11, 'CHI': 7,  'CIN': 12, 'CLE': 10,
    'DAL': 7,  'DEN': 9,  'DET': 5,  'GB': 6,
    'HOU': 14, 'IND': 14, 'JAX': 12, 'KC': 6,
    'LAC': 5,  'LAR': 6,  'LV': 8,   'MIA': 6,
    'MIN': 14, 'NE': 14,  'NO': 11,  'NYG': 11,
    'NYJ': 12, 'PHI': 5,  'PIT': 9,  'SEA': 10,
    'SF': 9,   'TB': 11,  'TEN': 5,  'WAS': 14,
}

# Season projection ranges by position (top-1 to depth cutoff), DK PPR scoring
_PROJ_RANGES = {
    'QB':  (380, 120),
    'RB':  (290,  30),
    'WR':  (250,  25),
    'TE':  (190,  20),
}


def fetch_nfl_season() -> str:
    """Return the current NFL season year from Sleeper (e.g. '2026')."""
    try:
        resp = requests.get(SLEEPER_STATE_URL, timeout=10)
        resp.raise_for_status()
        return resp.json().get('season', '2026')
    except Exception:
        return '2026'


def _estimate_projection(pos_rank: int, pos: str) -> int:
    """Estimate season DK PPR points from position rank using a power-law decay."""
    top, floor = _PROJ_RANGES.get(pos, (200, 20))
    decay = 0.88  # ~12% drop per rank step
    raw = top * (decay ** (pos_rank - 1))
    return round(max(floor, raw))


def _load_cache():
    try:
        with open(CACHE_PATH) as f:
            data = json.load(f)
        return data.get('players')
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        pass
    return None


def _save_cache(players, season):
    with open(CACHE_PATH, 'w') as f:
        json.dump({'season': season, 'players': players}, f)


def _fetch_players():
    resp = requests.get(SLEEPER_PLAYERS_URL, timeout=15)
    resp.raise_for_status()
    return resp.json()


def fetch_players(force_refresh=False):
    """Return cached players, or fetch from Sleeper API if force_refresh=True or no cache exists."""
    cached = _load_cache()
    if cached and not force_refresh:
        return cached

    season = fetch_nfl_season()
    raw_players = _fetch_players()

    players = []
    for pid, p in raw_players.items():
        pos = p.get('position', '')
        if pos not in SKILL_POSITIONS:
            continue
        status = p.get('status', '')
        if status not in ('Active', 'Injured_Reserve', ''):
            continue
        team = p.get('team') or 'FA'
        if team == 'FA':
            continue

        first = p.get('first_name', '')
        last = p.get('last_name', '')
        name = f"{first} {last}".strip()
        if not name:
            continue

        search_rank = p.get('search_rank') or 9999
        try:
            adp = int(search_rank)
        except (TypeError, ValueError):
            adp = 9999

        players.append({
            'id': f"sleeper_{pid}",
            'name': name,
            'pos': pos,
            'team': team,
            'bye': BYE_WEEKS_2026.get(team, 0),
            'adp': adp,
            'dk_proj': 0,  # filled in below
            'season': season,
        })

    # Sort by raw ADP first so pos_rank is meaningful
    players.sort(key=lambda p: p['adp'])

    # Assign sequential ADP and position-based projection
    pos_counters = {pos: 0 for pos in SKILL_POSITIONS}
    for i, p in enumerate(players, 1):
        p['adp'] = i
        pos_counters[p['pos']] += 1
        p['dk_proj'] = _estimate_projection(pos_counters[p['pos']], p['pos'])

    _save_cache(players, season)
    return players
