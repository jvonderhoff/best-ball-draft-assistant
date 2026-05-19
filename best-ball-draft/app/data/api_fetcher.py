"""
Fetches NFL player data from DraftKings rankings page.
Primary source: https://www.draftkings.com/draft/rankings/NFL/<DK_RANKINGS_ID>
Fallback ADP:  FantasyPros best ball (DraftKings column)

Update DK_RANKINGS_ID each season — find it in the URL of the DK best ball rankings page.
"""
import csv
import io
import json
import os
import re
import requests
from html.parser import HTMLParser

CACHE_PATH = os.path.join(os.path.dirname(__file__), 'player_cache.json')
FP_BEST_BALL_URL = 'https://www.fantasypros.com/nfl/adp/best-ball-overall.php'

# ── DraftKings rankings config ─────────────────────────────────────────────────
# Update this ID each season — taken from the URL on DK's rankings page.
DK_RANKINGS_ID = '146136'

# Candidates tried in order when fetching player data from DK.
# The lineup CSV works when the ID is a draft-group ID; the rankings CSV and
# page HTML are tried when it's a ranking-type ID.
_DK_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    ),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': 'https://www.draftkings.com/',
}

SKILL_POSITIONS = {'QB', 'RB', 'WR', 'TE'}

# ── Static 2026 schedule data ──────────────────────────────────────────────────

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

# Playoff schedule weeks 15, 16, 17 — opponent abbreviation.
# Source: official 2026 NFL schedule (released May 2026).
PLAYOFF_SCHEDULE_2026 = {
    'ARI': ('NYJ', 'NO',  'LV' ),
    'ATL': ('WAS', 'TB',  'NO' ),
    'BAL': ('PIT', 'CLE', 'CIN'),
    'BUF': ('CHI', 'DEN', 'MIA'),
    'CAR': ('CIN', 'PIT', 'SEA'),
    'CHI': ('BUF', 'GB',  'DET'),
    'CIN': ('CAR', 'IND', 'BAL'),
    'CLE': ('NYG', 'BAL', 'IND'),
    'DAL': ('LAR', 'JAX', 'NYG'),
    'DEN': ('LV',  'BUF', 'NE' ),
    'DET': ('MIN', 'NYG', 'CHI'),
    'GB':  ('MIA', 'CHI', 'HOU'),
    'HOU': ('JAX', 'PHI', 'GB' ),
    'IND': ('TEN', 'CIN', 'CLE'),
    'JAX': ('HOU', 'DAL', 'WAS'),
    'KC':  ('NE',  'SF',  'LAC'),
    'LAC': ('SF',  'MIA', 'KC' ),
    'LAR': ('DAL', 'SEA', 'TB' ),
    'LV':  ('DEN', 'TEN', 'ARI'),
    'MIA': ('GB',  'LAC', 'BUF'),
    'MIN': ('DET', 'WAS', 'NYJ'),
    'NE':  ('KC',  'NYJ', 'DEN'),
    'NO':  ('TB',  'ARI', 'ATL'),
    'NYG': ('CLE', 'DET', 'DAL'),
    'NYJ': ('ARI', 'NE',  'MIN'),
    'PHI': ('SEA', 'HOU', 'SF' ),
    'PIT': ('BAL', 'CAR', 'TEN'),
    'SEA': ('PHI', 'LAR', 'CAR'),
    'SF':  ('LAC', 'KC',  'PHI'),
    'TB':  ('NO',  'ATL', 'LAR'),
    'TEN': ('IND', 'LV',  'PIT'),
    'WAS': ('ATL', 'MIN', 'JAX'),
}

# ── Cache helpers ──────────────────────────────────────────────────────────────

def _load_cache():
    try:
        with open(CACHE_PATH) as f:
            data = json.load(f)
        return data.get('players')
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return None


def _save_cache(players, season):
    with open(CACHE_PATH, 'w') as f:
        json.dump({'season': season, 'players': players}, f)


# ── DraftKings CSV parsers ─────────────────────────────────────────────────────

def _parse_dk_lineup_csv(text: str) -> list:
    """
    Parse DK's available-players lineup CSV.
    Expected columns: Position, Name + ID, Name, ID, Roster Position,
                      Salary, Game Info, TeamAbbrev, AvgPointsPerGame

    DK uses Salary as an inverse ADP proxy: salary=1 is the #1 overall pick,
    higher salary = lower-ranked player.  We sort ascending by Salary so that
    adp=1 (assigned after sort) corresponds to the top overall pick.
    Free-agent players (TeamAbbrev == 'FA' or empty) are excluded.
    """
    rows = []
    try:
        reader = csv.DictReader(io.StringIO(text))
        for row in reader:
            pos  = (row.get('Position') or '').strip().upper()
            name = (row.get('Name') or '').strip()
            team = (row.get('TeamAbbrev') or '').strip().upper()
            if pos not in SKILL_POSITIONS or not name or not team or team == 'FA':
                continue
            try:
                salary = int(row.get('Salary') or 9999)
            except (ValueError, TypeError):
                salary = 9999
            # Extract stable DK player ID from "Name (ID)" or "Name (ID) (LOCKED)" field
            name_id_field = row.get('Name + ID') or row.get('ID') or ''
            id_match = re.search(r'\((\d{6,})\)', name_id_field)
            dk_id = f'dk_{id_match.group(1)}' if id_match else None
            rows.append({'name': name, 'pos': pos, 'team': team, 'salary': salary, 'dk_id': dk_id})
    except Exception as e:
        print(f'  [DK CSV] lineup parse error: {e}')
        return []

    # Sort ascending — salary 1 is the best player
    rows.sort(key=lambda r: r['salary'])
    players = []
    for rank, r in enumerate(rows, 1):
        players.append({
            'name': r['name'],
            'pos':  r['pos'],
            'team': r['team'],
            'adp':  float(rank),
            'dk_id': r.get('dk_id'),
        })
    return players


def _parse_dk_rankings_csv(text: str) -> list:
    """
    Parse DK's rankings/export CSV (column names may vary).
    Looks for name, position, and team columns by keyword matching.
    """
    players = []
    try:
        reader = csv.DictReader(io.StringIO(text))
        headers = reader.fieldnames or []
        # Identify columns by fuzzy header match
        name_col = next((h for h in headers if re.search(r'name|player', h, re.I)), None)
        pos_col  = next((h for h in headers if re.search(r'\bpos', h, re.I)), None)
        team_col = next((h for h in headers if re.search(r'team', h, re.I)), None)
        rank_col = next((h for h in headers if re.search(r'rank|adp|overall', h, re.I)), None)
        if not name_col or not pos_col or not team_col:
            print(f'  [DK CSV] rankings: could not identify columns. headers={headers}')
            return []
        print(f'  [DK CSV] rankings columns: name={name_col}, pos={pos_col}, team={team_col}, rank={rank_col}')
        for row in reader:
            name = (row.get(name_col) or '').strip()
            pos  = (row.get(pos_col) or '').strip().upper()
            team = (row.get(team_col) or '').strip().upper()
            adp  = None
            if rank_col:
                try:
                    adp = float(row[rank_col])
                except (ValueError, TypeError):
                    pass
            if pos not in SKILL_POSITIONS or not name or not team:
                continue
            players.append({'name': name, 'pos': pos, 'team': team, 'adp': adp})
    except Exception as e:
        print(f'  [DK CSV] rankings parse error: {e}')
    return players


# ── DraftKings JSON extraction (React/Next.js pages) ──────────────────────────

def _dk_obj_to_player(obj: dict):
    """Convert a DK JSON object to a minimal player dict, or return None."""
    if not isinstance(obj, dict):
        return None
    # Name
    name = (
        obj.get('displayName') or obj.get('playerName') or
        obj.get('name') or obj.get('fullName') or ''
    ).strip()
    if not name:
        first = obj.get('firstName', '')
        last  = obj.get('lastName', '')
        name  = f'{first} {last}'.strip()
    if not name:
        return None
    # Position
    pos = (
        obj.get('position') or obj.get('playerPosition') or obj.get('pos') or ''
    ).strip().upper()
    if pos not in SKILL_POSITIONS:
        return None
    # Team
    team = (
        obj.get('teamAbbreviation') or obj.get('teamAbbrev') or
        obj.get('team') or obj.get('teamShort') or ''
    ).strip().upper()
    if not team or team in ('FA', 'N/A'):
        return None
    # ADP / rank
    adp = None
    rank = obj.get('rank') or obj.get('ranking') or obj.get('overallRank')
    if rank:
        try:
            adp = float(rank)
        except (ValueError, TypeError):
            pass
    return {'name': name, 'pos': pos, 'team': team, 'adp': adp}


def _walk_dk_json(data, depth=0) -> list:
    """Recursively walk a parsed JSON object for arrays of player-like objects."""
    if depth > 10:
        return []
    if isinstance(data, list) and len(data) > 5:
        players = [p for p in (_dk_obj_to_player(item) for item in data) if p]
        if len(players) > 10:
            return players
    if isinstance(data, dict):
        for v in data.values():
            result = _walk_dk_json(v, depth + 1)
            if result:
                return result
    return []


def _extract_dk_json_players(html: str) -> list:
    """
    Hunt for player data embedded in DK's React/Next.js page HTML.
    Tries __NEXT_DATA__, window.__PRELOADED_STATE__, and raw JSON blobs.
    """
    # Next.js data island
    m = re.search(r'<script[^>]*id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', html, re.DOTALL)
    if m:
        try:
            players = _walk_dk_json(json.loads(m.group(1)))
            if players:
                print(f'  [DK JSON] found {len(players)} players in __NEXT_DATA__')
                return players
        except Exception:
            pass

    # window.__PRELOADED_STATE__
    m = re.search(r'window\.__PRELOADED_STATE__\s*=\s*({.+?})\s*;?\s*(?:</script>|window\.)', html, re.DOTALL)
    if m:
        try:
            players = _walk_dk_json(json.loads(m.group(1)))
            if players:
                print(f'  [DK JSON] found {len(players)} players in __PRELOADED_STATE__')
                return players
        except Exception:
            pass

    # Any script tag containing player-like JSON arrays
    for script_m in re.finditer(r'<script[^>]*>(.*?)</script>', html, re.DOTALL):
        content = script_m.group(1)
        if '"position"' not in content and '"pos"' not in content:
            continue
        # Find all JSON-like arrays in this script block
        for arr_m in re.finditer(r'\[(\{[^\[\]]+\}(?:,\{[^\[\]]+\})*)\]', content):
            try:
                arr = json.loads('[' + arr_m.group(1) + ']')
                players = [p for p in (_dk_obj_to_player(item) for item in arr) if p]
                if len(players) > 10:
                    print(f'  [DK JSON] found {len(players)} players in inline script array')
                    return players
            except Exception:
                pass

    return []


# ── DraftKings fetch orchestrator ──────────────────────────────────────────────

def fetch_dk_players(ranking_id: str = DK_RANKINGS_ID) -> list:
    """
    Fetch the DK player pool from their rankings page.
    Tries several strategies in order:
      1. Lineup available-players CSV  (works if ID is a draft-group ID)
      2. Rankings export CSV           (works if DK exposes a CSV export)
      3. JSON embedded in the rankings page HTML
    Returns a list of dicts with keys: name, pos, team, adp (adp may be None).
    Returns [] on total failure — caller should fall back to FantasyPros.
    """
    session = requests.Session()
    session.headers.update(_DK_HEADERS)

    # Strategy 1 — lineup CSV (draft-group ID path)
    url = f'https://www.draftkings.com/lineup/getavailableplayerscsv?draftGroupId={ranking_id}'
    print(f'  [DK] trying lineup CSV: {url}')
    try:
        r = session.get(url, timeout=15)
        if r.ok and len(r.text) > 200 and ',' in r.text[:500]:
            players = _parse_dk_lineup_csv(r.text)
            if players:
                print(f'  [DK] lineup CSV: {len(players)} players')
                return players
            print(f'  [DK] lineup CSV returned data but parsed 0 skill-pos players')
            print(f'  [DK] first 300 chars: {r.text[:300]}')
    except Exception as e:
        print(f'  [DK] lineup CSV error: {e}')

    # Strategy 2 — rankings export CSV
    url = f'https://www.draftkings.com/rankings/get-rankings-csv?rankingTypeId={ranking_id}'
    print(f'  [DK] trying rankings CSV: {url}')
    try:
        r = session.get(url, timeout=15)
        if r.ok and len(r.text) > 200 and ',' in r.text[:500]:
            players = _parse_dk_rankings_csv(r.text)
            if players:
                print(f'  [DK] rankings CSV: {len(players)} players')
                return players
            print(f'  [DK] rankings CSV first 300 chars: {r.text[:300]}')
    except Exception as e:
        print(f'  [DK] rankings CSV error: {e}')

    # Strategy 3 — scrape the rankings page and extract embedded JSON
    url = f'https://www.draftkings.com/draft/rankings/NFL/{ranking_id}'
    print(f'  [DK] trying rankings page HTML: {url}')
    try:
        r = session.get(url, timeout=20)
        if r.ok:
            players = _extract_dk_json_players(r.text)
            if players:
                print(f'  [DK] page JSON: {len(players)} players')
                return players
            # Dump a snippet to help diagnose
            print(f'  [DK] no player JSON found — page title: '
                  f'{re.search(r"<title>(.*?)</title>", r.text, re.I) and re.search(r"<title>(.*?)</title>", r.text, re.I).group(1)}')
            print(f'  [DK] page length: {len(r.text)} bytes')
        else:
            print(f'  [DK] rankings page returned HTTP {r.status_code}')
    except Exception as e:
        print(f'  [DK] rankings page error: {e}')

    return []


# ── FantasyPros fallback (ADP only) ───────────────────────────────────────────

class _TableParser(HTMLParser):
    """Extracts rows from the first HTML table encountered."""
    def __init__(self):
        super().__init__()
        self.in_table = self.in_tr = self.in_cell = False
        self.rows = []
        self._row = []
        self._cell = ''

    def handle_starttag(self, tag, attrs):
        if tag == 'table':
            self.in_table = True
        if self.in_table and tag == 'tr':
            self.in_tr = True; self._row = []
        if self.in_tr and tag in ('td', 'th'):
            self.in_cell = True; self._cell = ''

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


def _normalize_name(name: str) -> str:
    name = name.lower()
    name = re.sub(r"['\.\-]", '', name)
    return re.sub(r'\s+', ' ', name).strip()


def _fetch_fp_adp() -> dict:
    """
    Scrape FantasyPros best ball ADP page.
    Returns dict: normalized_name -> adp float.
    Uses DraftKings column; falls back to consensus AVG.
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
        # Column headers change slightly (e.g. "Player Team" vs "Player Team (Bye)")
        # so find them by prefix/substring match instead of exact equality.
        def _find_col(headers, *keywords):
            for kw in keywords:
                for i, h in enumerate(headers):
                    if kw.lower() in h.lower():
                        return i
            return None

        dk_col   = _find_col(header, 'DraftKings')
        avg_col  = _find_col(header, 'AVG')
        name_col = _find_col(header, 'Player Team', 'Player')
        if dk_col is None or avg_col is None or name_col is None:
            print(f'  [FP] could not identify columns: {header}')
            return {}
        result = {}
        for row in parser.rows[1:]:
            if len(row) <= max(dk_col, avg_col, name_col):
                continue
            # "Bijan Robinson ATL (11)" — strip trailing bye "(N)" then team abbreviation
            raw_name = row[name_col]
            raw_name = re.sub(r'\s*\(\d+\)\s*$', '', raw_name)      # strip "(11)"
            raw_name = re.sub(r'\s+[A-Z]{2,3}$', '', raw_name).strip()  # strip "ATL"
            dk_val   = row[dk_col].strip()
            avg_val  = row[avg_col].strip()
            adp_str  = dk_val if dk_val and dk_val not in ('-', 'N/A', '') else avg_val
            try:
                result[_normalize_name(raw_name)] = float(adp_str)
            except (ValueError, TypeError):
                pass
        return result
    except Exception:
        return {}


# ── Public API ─────────────────────────────────────────────────────────────────

def fetch_players(force_refresh=False):
    """
    Return player list.  Uses cache unless force_refresh=True or no cache exists.

    Data pipeline:
      1. Fetch players + salary rank from DraftKings lineup CSV (names/teams are exact
         matches to what DK renders on the draft board)
      2. Merge in FantasyPros DK best-ball ADP — this is the actual ADP shown on the
         DK rankings page, expressed as float pick numbers (e.g. 12.3).
         Players not ranked by FP fall back to DK salary rank.
      3. Sort by merged ADP, then assign sequential integer ADP (1 = best).
      4. Enrich with bye week + playoff schedule from static 2026 tables.
    """
    cached = _load_cache()
    if cached and not force_refresh:
        return cached

    print('Fetching player data from DraftKings...')
    dk_players = fetch_dk_players()

    if not dk_players:
        print('  ERROR: DraftKings fetch failed — cannot continue.')
        return cached or []

    print(f'  ✓ DraftKings: {len(dk_players)} players (sorted by DK salary rank)')

    # Build normalized name → FP ADP lookup
    print('Fetching ADP from FantasyPros (DraftKings column)...')
    fp_adp = _fetch_fp_adp()
    fp_matched = 0
    if fp_adp:
        print(f'  ✓ FantasyPros: {len(fp_adp)} players with DK ADP')
    else:
        print('  FantasyPros ADP unavailable — using DK salary rank as ADP')

    players = []
    for dk_p in dk_players:
        team     = dk_p['team']
        schedule = PLAYOFF_SCHEDULE_2026.get(team, (None, None, None))
        player_id = dk_p.get('dk_id') or f'dk_{int(dk_p["adp"])}'

        # Try to find a real ADP from FantasyPros using normalized name matching.
        # DK names ("Brian Robinson Jr.") and FP names ("Brian Robinson") can differ
        # slightly, so try the full name first, then drop generation suffix.
        adp = dk_p['adp']  # default: DK salary rank
        if fp_adp:
            norm = _normalize_name(dk_p['name'])
            if norm in fp_adp:
                adp = fp_adp[norm]
                fp_matched += 1
            else:
                # Try without Jr./Sr./II/III suffix
                norm_no_suffix = re.sub(r'\s+(?:jr|sr|ii|iii|iv|v)$', '', norm).strip()
                if norm_no_suffix in fp_adp:
                    adp = fp_adp[norm_no_suffix]
                    fp_matched += 1

        players.append({
            'id':     player_id,
            'name':   dk_p['name'],
            'pos':    dk_p['pos'],
            'team':   team,
            'bye':    BYE_WEEKS_2026.get(team, 0),
            'adp':    adp,
            'season': '2026',
            'week15': schedule[0],
            'week16': schedule[1],
            'week17': schedule[2],
        })

    if fp_adp:
        print(f'  ✓ ADP merged: {fp_matched}/{len(players)} players have FantasyPros DK ADP')

    # Sort by ADP ascending, then re-number as sequential integers
    players.sort(key=lambda p: p['adp'])
    for i, p in enumerate(players, 1):
        p['adp'] = i

    _save_cache(players, '2026')
    return players
