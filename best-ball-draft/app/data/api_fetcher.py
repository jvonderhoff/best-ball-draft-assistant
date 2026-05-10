"""
Fetches NFL player data from the Sleeper API, with ADP from FantasyPros best ball table
(DraftKings column, falling back to consensus AVG for players DK hasn't ranked).
"""
import json
import os
import re
import requests
from html.parser import HTMLParser

CACHE_PATH = os.path.join(os.path.dirname(__file__), 'player_cache.json')
SLEEPER_STATE_URL = 'https://api.sleeper.app/v1/state/nfl'
SLEEPER_PLAYERS_URL = 'https://api.sleeper.app/v1/players/nfl'
FP_BEST_BALL_URL = 'https://www.fantasypros.com/nfl/adp/best-ball-overall.php'

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


class _TableParser(HTMLParser):
    """Extracts rows from the first HTML table encountered."""
    def __init__(self):
        super().__init__()
        self.in_table = False
        self.in_tr = False
        self.in_cell = False
        self.rows = []
        self._row = []
        self._cell = ''

    def handle_starttag(self, tag, attrs):
        if tag == 'table':
            self.in_table = True
        if self.in_table and tag == 'tr':
            self.in_tr = True
            self._row = []
        if self.in_tr and tag in ('td', 'th'):
            self.in_cell = True
            self._cell = ''

    def handle_endtag(self, tag):
        if tag == 'table':
            self.in_table = False
        if self.in_table and tag == 'tr':
            self.in_tr = False
            if self._row:
                self.rows.append(self._row[:])
        if self.in_tr and tag in ('td', 'th'):
            self.in_cell = False
            self._row.append(self._cell.strip())

    def handle_data(self, data):
        if self.in_cell:
            self._cell += data


def _fetch_fp_adp(season: str) -> dict:
    """
    Scrape FantasyPros best ball ADP page.
    Returns a dict keyed by normalized player name -> adp float.
    Uses DraftKings column; falls back to consensus AVG for unranked players.
    Falls back to empty dict on failure.
    """
    try:
        resp = requests.get(FP_BEST_BALL_URL, timeout=15, headers={
            'User-Agent': 'Mozilla/5.0',
            'Referer': 'https://www.fantasypros.com/',
        })
        resp.raise_for_status()
        parser = _TableParser()
        parser.feed(resp.text)
        if not parser.rows:
            return {}
        header = parser.rows[0]
        try:
            dk_col  = header.index('DraftKings')
            avg_col = header.index('AVG')
            name_col = header.index('Player Team')
        except ValueError:
            return {}
        result = {}
        for row in parser.rows[1:]:
            if len(row) <= max(dk_col, avg_col, name_col):
                continue
            # "Bijan Robinson ATL" — strip trailing team abbreviation
            raw_name = re.sub(r'\s+[A-Z]{2,3}$', '', row[name_col]).strip()
            dk_val  = row[dk_col].strip()
            avg_val = row[avg_col].strip()
            adp_str = dk_val if dk_val and dk_val not in ('-', 'N/A', '') else avg_val
            try:
                result[_normalize_name(raw_name)] = float(adp_str)
            except (ValueError, TypeError):
                pass
        return result
    except Exception:
        return {}


def _normalize_name(name: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace for fuzzy name matching."""
    name = name.lower()
    name = re.sub(r"['\.\-]", '', name)
    return re.sub(r'\s+', ' ', name).strip()


def fetch_players(force_refresh=False):
    """Return cached players, or fetch from Sleeper + FantasyPros if force_refresh=True or no cache exists."""
    cached = _load_cache()
    if cached and not force_refresh:
        return cached

    season = fetch_nfl_season()
    raw_players = _fetch_players()
    fp_adp = _fetch_fp_adp(season)

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

        players.append({
            'id': f"sleeper_{pid}",
            'name': name,
            'pos': pos,
            'team': team,
            'bye': BYE_WEEKS_2026.get(team, 0),
            'adp': None,
            'dk_proj': 0,
            'season': season,
        })

    # Merge real ADP from FantasyPros best ball where available
    for p in players:
        key = _normalize_name(p['name'])
        if key in fp_adp:
            p['adp'] = fp_adp[key]

    # Players without FantasyPros ADP get synthetic fallback from Sleeper search_rank
    sleeper_lookup = {
        f"{v.get('first_name', '')} {v.get('last_name', '')}".strip(): v.get('search_rank') or 9999
        for v in raw_players.values()
    }
    max_fp_adp = max((p['adp'] for p in players if p['adp'] is not None), default=250)
    for p in players:
        if p['adp'] is None:
            sr = sleeper_lookup.get(p['name'], 9999)
            p['adp'] = max_fp_adp + sr

    # Sort by ADP, then assign sequential integers and position-based projections
    players.sort(key=lambda p: p['adp'])
    pos_counters = {pos: 0 for pos in SKILL_POSITIONS}
    for i, p in enumerate(players, 1):
        p['adp'] = i
        pos_counters[p['pos']] += 1
        p['dk_proj'] = _estimate_projection(pos_counters[p['pos']], p['pos'])

    _save_cache(players, season)
    return players
