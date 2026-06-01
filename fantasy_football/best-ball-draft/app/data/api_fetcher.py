"""
Fetches NFL player data from DraftKings rankings page.
Primary source: https://www.draftkings.com/draft/rankings/NFL/<DK_RANKINGS_ID>
  - Uses Playwright to load the JS-rendered page and intercept API responses
  - Falls back to the DK lineup CSV (salary rank as proxy ADP)

Update DK_RANKINGS_ID each season — find it in the URL of the DK best ball rankings page.
"""
import csv
import io
import json
import os
import re
import requests

CACHE_PATH = os.path.join(os.path.dirname(__file__), 'player_cache.json')

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
    # Sourced from DK draft board (BYE week shown per player pick cell), May 2026
    'ARI': 14, 'ATL': 11, 'BAL': 13, 'BUF': 7,
    'CAR': 5,  'CHI': 10, 'CIN': 6,  'CLE': 11,
    'DAL': 14, 'DEN': 10, 'DET': 6,  'GB':  11,
    'HOU': 8,  'IND': 13, 'JAX': 7,  'KC':  5,
    'LAC': 7,  'LAR': 11, 'LV':  13, 'MIA': 6,
    'MIN': 6,  'NE':  11, 'NO':  8,  'NYG': 8,
    'NYJ': 13, 'PHI': 10, 'PIT': 9,  'SEA': 11,
    'SF':  8,  'TB':  10, 'TEN': 9,  'WAS': 7,
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
    # ADP / rank — try every field name DK might use
    adp = None
    for key in ('adp', 'avgDraftPosition', 'averageDraftPosition',
                'rank', 'ranking', 'overallRank', 'draftPosition', 'pickNumber'):
        val = obj.get(key)
        if val is not None:
            try:
                adp = float(val)
                break
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


# ── DraftKings Playwright scraper ─────────────────────────────────────────────

def _get_firefox_dk_cookies() -> list:
    """
    Read DraftKings session cookies from Firefox's SQLite cookie store.
    Returns Playwright-compatible cookie dicts so the browser loads DK authenticated.
    Copies the DB before opening it since Firefox may have it locked.
    """
    import glob, shutil, sqlite3, tempfile
    patterns = [
        '~/Library/Application Support/Firefox/Profiles/*.default-release*/cookies.sqlite',
        '~/Library/Application Support/Firefox/Profiles/*.default/cookies.sqlite',
        '~/.mozilla/firefox/*.default-release*/cookies.sqlite',
        '~/.mozilla/firefox/*.default/cookies.sqlite',
    ]
    db_path = None
    for pat in patterns:
        matches = glob.glob(os.path.expanduser(pat))
        if matches:
            db_path = matches[0]
            break
    if not db_path:
        print('  [Playwright] Firefox cookie DB not found')
        return []

    tmp = tempfile.mktemp(suffix='.sqlite')
    try:
        shutil.copy2(db_path, tmp)
        conn = sqlite3.connect(tmp)
        rows = conn.execute(
            'SELECT name, value, host, path, expiry, isSecure, isHttpOnly '
            'FROM moz_cookies WHERE host LIKE "%draftkings%"'
        ).fetchall()
        conn.close()
    except Exception as e:
        print(f'  [Playwright] cookie read error: {e}')
        return []
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass

    cookies = []
    for name, value, domain, path, expiry, secure, http_only in rows:
        cookies.append({
            'name': name, 'value': value,
            'domain': domain if domain.startswith('.') else f'.{domain}',
            'path': path or '/',
            # Firefox stores expiry in ms; Playwright wants seconds
            'expires': int(expiry / 1000) if expiry and expiry > 0 else -1,
            'secure': bool(secure),
            'httpOnly': bool(http_only),
            'sameSite': 'None',
        })
    print(f'  [Playwright] loaded {len(cookies)} DK cookies from Firefox')
    return cookies


def _parse_dk_api_responses(responses: dict) -> list:
    """
    Parse the two key DK API responses captured from the rankings page:
      - rankings/v1/.../playerpool  → averageDraftPosition, rank, name, pos
      - draftgroups/v1/.../draftables → teamAbbreviation, draftableId, playerId

    Merges them by playerId, deduplicates (draftables has one row per roster slot),
    and returns {id, name, pos, team, adp} dicts sorted by adp.
    """
    # playerPool is a dict {draftablePlayers: [...]}, not a list directly
    playerpool = (responses.get('playerpool', {})
                           .get('playerPool', {})
                           .get('draftablePlayers', []))
    draftables_list = responses.get('draftables', {}).get('draftables', [])

    if not playerpool:
        return []

    # Build draftableId → {pos, team} and playerId → draftableId from draftables.
    # draftables has one entry per roster slot per player; we deduplicate by playerId.
    draftable_map = {}  # draftableId → {pos, team, playerId}
    pid_to_did    = {}  # playerId    → first draftableId seen
    pid_to_team   = {}  # playerId    → teamAbbreviation
    for d in draftables_list:
        did = d.get('draftableId')
        pid = d.get('playerId')
        pos = (d.get('position') or '').strip().upper()
        team = (d.get('teamAbbreviation') or d.get('teamAbbrev') or '').strip().upper()
        if did:
            draftable_map[did] = {'pos': pos, 'team': team, 'pid': pid}
        if pid:
            pid_to_team.setdefault(pid, team)
            pid_to_did.setdefault(pid, did)

    players = []
    seen = set()
    for p in playerpool:
        pid = p.get('playerId')
        if not pid or pid in seen:
            continue
        seen.add(pid)

        name = (p.get('displayName') or
                f"{p.get('firstName','')} {p.get('lastName','')}".strip())
        if not name:
            continue

        # Position comes from draftables via the draftableId in draftableRosterPositions.
        # draftableRosterPositions is a list of dicts: [{draftableId, rosterPositionId, ...}]
        pos = None
        for slot in (p.get('draftableRosterPositions') or []):
            did = slot.get('draftableId') if isinstance(slot, dict) else None
            if did and draftable_map.get(did, {}).get('pos') in SKILL_POSITIONS:
                pos = draftable_map[did]['pos']
                break
        # Fallback: look up by playerId directly
        if not pos:
            did = pid_to_did.get(pid)
            if did:
                pos = draftable_map.get(did, {}).get('pos', '')
        if pos not in SKILL_POSITIONS:
            continue

        team = pid_to_team.get(pid, '').upper()
        if not team or team in ('FA', 'N/A', ''):
            continue

        adp = p.get('averageDraftPosition') or p.get('rank')
        try:
            adp = float(adp) if adp is not None else None
        except (ValueError, TypeError):
            adp = None

        did = pid_to_did.get(pid)
        dk_id = f'dk_{did}' if did else f'dk_{pid}'
        players.append({'name': name, 'pos': pos, 'team': team, 'adp': adp, 'dk_id': dk_id})

    players_with_adp = [p for p in players if p['adp'] is not None]
    if players_with_adp:
        players_with_adp.sort(key=lambda p: p['adp'])
        return players_with_adp
    return players


def _fetch_dk_rankings_playwright(ranking_id: str = DK_RANKINGS_ID) -> list:
    """
    Load DK's rankings page with Playwright (authenticated via Firefox cookies).
    Intercepts the playerpool API response (real ADP) and draftables (team info).
    Returns {name, pos, team, adp, dk_id} dicts sorted by adp, or [] on failure.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('  [Playwright] not installed — run: pip install playwright && playwright install chromium')
        return []

    url = f'https://www.draftkings.com/draft/rankings/NFL/{ranking_id}'
    print(f'  [Playwright] loading {url}')

    dk_cookies = _get_firefox_dk_cookies()
    responses = {}  # keyed by 'playerpool' and 'draftables'

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            )
        )
        if dk_cookies:
            context.add_cookies(dk_cookies)

        page = context.new_page()

        def _on_response(response):
            url_lower = response.url.lower()
            ct = response.headers.get('content-type', '')
            if 'json' not in ct:
                return
            try:
                if 'playerpool' in url_lower:
                    responses['playerpool'] = response.json()
                    print(f'  [Playwright] captured playerpool ({len(response.body())} bytes)')
                elif 'draftables' in url_lower and 'draftables' not in responses:
                    responses['draftables'] = response.json()
                    print(f'  [Playwright] captured draftables ({len(response.body())} bytes)')
            except Exception:
                pass

        page.on('response', _on_response)

        try:
            page.goto(url, wait_until='domcontentloaded', timeout=20000)
            page.wait_for_timeout(6000)
        except Exception as e:
            print(f'  [Playwright] navigation warning: {e}')

        browser.close()

    if not responses:
        print('  [Playwright] no API responses captured — is Firefox logged in to DK?')
        return []

    players = _parse_dk_api_responses(responses)
    if players:
        has_adp = sum(1 for p in players if p['adp'] is not None)
        print(f'  [Playwright] ✓ {len(players)} players, {has_adp} with ADP')
    else:
        print('  [Playwright] parsing returned no players')
    return players


def _discover_rankings_id():
    """
    Navigate to DK's NFL rankings page and capture the current rankings ID from the URL.
    Returns the ID string (e.g. '146136') or None on failure.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None

    dk_cookies = _get_firefox_dk_cookies()
    found_id = None

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            )
        )
        if dk_cookies:
            context.add_cookies(dk_cookies)
        page = context.new_page()
        try:
            page.goto('https://www.draftkings.com/draft/rankings/NFL',
                      wait_until='domcontentloaded', timeout=15000)
            url = page.url
            m = re.search(r'/rankings/NFL/(\d+)', url)
            if m:
                found_id = m.group(1)
                print(f'  [Playwright] discovered rankings ID: {found_id}')
        except Exception as e:
            print(f'  [Playwright] rankings ID discovery error: {e}')
        browser.close()

    return found_id


def _normalize_pick(p):
    if not isinstance(p, dict):
        return None
    po = p.get('player') or p.get('draftPlayer') or p
    to = p.get('draftTeam') or p.get('team') or {}
    if isinstance(to, str):
        to = {'teamAbbreviation': to}
    name = (po.get('displayName') or
            ' '.join(filter(None, [po.get('firstName', ''), po.get('lastName', '')])).strip() or
            po.get('playerName') or po.get('name') or
            p.get('displayName') or p.get('playerName') or p.get('name') or '')
    if not name:
        return None
    pos = po.get('position') or po.get('pos') or p.get('position') or p.get('pos') or ''
    team = (po.get('teamAbbreviation') or po.get('nflTeamAbbreviation') or po.get('team') or
            p.get('teamAbbreviation') or p.get('nflTeamAbbreviation') or
            (to.get('teamAbbreviation') if isinstance(to, dict) else '') or '')
    pick_num = (p.get('pickNumber') or p.get('pick_number') or p.get('overallPickNumber') or
                p.get('draftPickNumber') or None)
    username = (p.get('username') or p.get('entryName') or p.get('draftTeamName') or
                (to.get('entryName') or to.get('name') if isinstance(to, dict) else '') or
                p.get('teamName') or '')
    return {'player_name': name, 'pick_number': pick_num, 'username': username,
            'pos': pos, 'team': team}


def fetch_dk_draft_picks(contest_id, entry_id=None):
    """
    Fetch the current draft board for a best ball contest by navigating to the draft page.
    Intercepts /draftStatus and /draftables XHR calls which fire automatically.
    Maps draftableId → player info for human-readable pick names.
    Returns normalized pick list or None on failure.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('  [Playwright] not installed')
        return None

    dk_cookies = _get_firefox_dk_cookies()
    if not dk_cookies:
        print('  [Playwright] no Firefox DK cookies')
        return None

    _UA = (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    )

    status_data = [None]    # draftStatus response
    draftable_map = {}      # draftableId -> {name, pos, team}
    live_data = {}          # live drafts response (to discover entry_id if needed)
    found_entry_id = [entry_id]
    found_guid = [_load_user_guid()]

    def _on_response(response):
        try:
            url = response.url
            ct = response.headers.get('content-type', '')
            if 'json' not in ct:
                return
            if 'draftStatus' in url and str(contest_id) in url:
                status_data[0] = response.json()
            elif 'draftables' in url:
                for d in (response.json().get('draftables') or []):
                    did = d.get('draftableId')
                    if did:
                        draftable_map[did] = {
                            'name': d.get('displayName') or
                                    f"{d.get('firstName','')} {d.get('lastName','')}".strip(),
                            'pos': (d.get('position') or '').upper(),
                            'team': (d.get('teamAbbreviation') or '').upper(),
                        }
            elif 'drafts/live' in url:
                live_data.update(response.json())
                m = re.search(r'/users/([0-9a-f\-]{36})/drafts/live', url)
                if m:
                    found_guid[0] = m.group(1)
                # Resolve entry_id for this contest
                if not found_entry_id[0]:
                    for ud in (live_data.get('userDrafts') or []):
                        if str(ud.get('contestId')) == str(contest_id):
                            found_entry_id[0] = str(ud.get('entryId', ''))
                            break
        except Exception:
            pass

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(user_agent=_UA)
        context.add_cookies(dk_cookies)
        page = context.new_page()
        page.on('response', _on_response)

        try:
            page.goto(
                f'https://www.draftkings.com/draft/snake/{contest_id}',
                wait_until='domcontentloaded', timeout=25000
            )
            page.wait_for_timeout(6000)
        except Exception as e:
            print(f'  [Playwright] nav error: {e}')

        browser.close()

    if found_guid[0]:
        _save_user_guid(found_guid[0])

    if not status_data[0]:
        print(f'  [Playwright] no draftStatus captured for contest {contest_id}')
        return None

    draft_board = status_data[0].get('draftBoard') or []
    if not draft_board:
        print('  [Playwright] draftBoard is empty')
        return None

    print(f'  [Playwright] draftables: {len(draftable_map)} players, draftBoard: {len(draft_board)} picks')

    # Normalize picks — identify user's picks by their userKey == GUID
    # Skip entries with null draftableId (unfilled future pick slots)
    user_guid = found_guid[0] or ''
    picks = []
    for entry in draft_board:
        did = entry.get('draftableId')
        if not did:  # skip empty future slots
            continue
        player_info = draftable_map.get(did, {})
        name = player_info.get('name') or f'Player #{did}'
        pos = player_info.get('pos', '')
        team = player_info.get('team', '')
        pick_num = entry.get('overallSelectionNumber')
        user_key = entry.get('userKey', '')
        username = 'jvonderhoff' if (user_guid and user_key == user_guid) else ''
        picks.append({
            'player_name': name,
            'pick_number': pick_num,
            'username': username,
            'pos': pos,
            'team': team,
            'round': entry.get('roundNumber'),
            'draftable_id': str(did),
        })

    print(f'  [Playwright] ✓ {len(picks)} picks for contest {contest_id}')
    return picks if picks else None


# Path to cache the user's DK GUID so we can call the live-drafts endpoint directly
_USER_GUID_FILE = os.path.join(os.path.dirname(__file__), '.dk_user_guid')


def _load_user_guid():
    try:
        with open(_USER_GUID_FILE) as f:
            return f.read().strip()
    except Exception:
        return None


def _save_user_guid(guid):
    try:
        with open(_USER_GUID_FILE, 'w') as f:
            f.write(guid)
    except Exception:
        pass


def _parse_live_drafts(data):
    """Parse the /drafts/live XHR response into our standard draft list."""
    drafts = []
    for ud in (data.get('userDrafts') or []):
        cid = ud.get('contestId')
        eid = ud.get('entryId')
        if cid and eid:
            drafts.append({
                'id': str(cid),
                'entry_id': str(eid),
                'name': ud.get('contestName', f'Draft #{cid}'),
                'picks_until_clock': ud.get('picksUntilOnTheClock'),
                'round': ud.get('currentRound'),
                'draft_group_id': str(ud.get('draftGroupId', '')),
            })
    return drafts


def fetch_my_dk_drafts(nav_draft_id=None):
    """
    Discover the user's active best ball drafts by navigating to any DK draft page.
    Intercepts /drafts/live XHR which DK fires automatically on all draft pages.
    nav_draft_id: an existing draft ID to navigate to (helps trigger the XHR).
    Returns list of {id, entry_id, name, picks_until_clock, round} dicts.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return []

    dk_cookies = _get_firefox_dk_cookies()
    if not dk_cookies:
        return []

    _UA = (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    )

    live_data = {}
    found_guid = [None]
    status_data = {}  # contestId -> draftStatus response

    def _on_response(response):
        try:
            url = response.url
            ct = response.headers.get('content-type', '')
            if 'json' not in ct:
                return
            if 'drafts/live' in url:
                data = response.json()
                live_data.update(data)
                m = re.search(r'/users/([0-9a-f\-]{36})/drafts/live', url)
                if m:
                    found_guid[0] = m.group(1)
            elif 'draftStatus' in url:
                m = re.search(r'/drafts/v1/(\d+)/entries/', url)
                if m:
                    status_data[m.group(1)] = response.json()
        except Exception:
            pass

    # If no explicit nav_draft_id, try to find one from the saved drafts file
    if not nav_draft_id:
        saved_ids_path = os.path.normpath(os.path.join(
            os.path.dirname(os.path.dirname(__file__)), '..', '.saved_drafts.json'
        ))
        try:
            import json as _json
            with open(saved_ids_path) as f:
                saved = _json.load(f)
            if saved:
                nav_draft_id = next(iter(saved))
        except Exception:
            pass

    nav_url = (f'https://www.draftkings.com/draft/snake/{nav_draft_id}'
               if nav_draft_id else 'https://www.draftkings.com/draft/snake')

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(user_agent=_UA)
        context.add_cookies(dk_cookies)
        page = context.new_page()
        page.on('response', _on_response)
        try:
            page.goto(nav_url, wait_until='domcontentloaded', timeout=20000)
            page.wait_for_timeout(5000)
        except Exception as e:
            print(f'  [Playwright] nav error: {e}')
        browser.close()

    if found_guid[0]:
        _save_user_guid(found_guid[0])

    if live_data:
        drafts = _parse_live_drafts(live_data)
        print(f'  [Playwright] ✓ {len(drafts)} live drafts discovered')
        return drafts

    print('  [Playwright] no live drafts XHR captured — ensure Firefox is logged in to DK')
    return []


def _extract_picks_from_data(data: dict) -> list:
    """Pull a raw picks list out of various DK API response shapes."""
    if not isinstance(data, dict):
        return []
    # Try common wrapper keys
    for key in ('draftSelections', 'selections', 'picks', 'draftboard',
                 'draftBoard', 'results', 'data'):
        val = data.get(key)
        if isinstance(val, list) and val:
            return val
        if isinstance(val, dict):
            for inner_key in ('draftSelections', 'selections', 'picks'):
                inner = val.get(inner_key)
                if isinstance(inner, list) and inner:
                    return inner
    return []


# ── DraftKings fetch orchestrator ──────────────────────────────────────────────

def fetch_dk_players(ranking_id: str = DK_RANKINGS_ID) -> list:
    """
    Fetch the DK player pool with real ADP from the rankings page.
    Strategy 1: Playwright — auto-discovers current ID, loads JS-rendered page
    Strategy 2: Lineup CSV — salary rank used as ADP proxy (no Playwright needed)
    Returns list of {name, pos, team, adp} dicts, adp may be None on full failure.
    """
    # Auto-discover the current season's rankings ID
    discovered_id = _discover_rankings_id()
    if discovered_id and discovered_id != ranking_id:
        print(f'  [DK] rankings ID updated: {ranking_id} → {discovered_id}')
        ranking_id = discovered_id

    # Strategy 1 — Playwright (real ADP from DK's rankings page)
    players = _fetch_dk_rankings_playwright(ranking_id)
    if players:
        return players

    # Strategy 2 — lineup CSV with salary rank as ADP proxy
    session = requests.Session()
    session.headers.update(_DK_HEADERS)
    url = f'https://www.draftkings.com/lineup/getavailableplayerscsv?draftGroupId={ranking_id}'
    print(f'  [DK] falling back to lineup CSV: {url}')
    try:
        r = session.get(url, timeout=15)
        if r.ok and len(r.text) > 200 and ',' in r.text[:500]:
            players = _parse_dk_lineup_csv(r.text)
            if players:
                print(f'  [DK] lineup CSV: {len(players)} players (salary rank as ADP)')
                return players
    except Exception as e:
        print(f'  [DK] lineup CSV error: {e}')

    return []


# ── Public API ─────────────────────────────────────────────────────────────────

def fetch_players(force_refresh=False):
    """
    Return player list.  Uses cache unless force_refresh=True or no cache exists.

    Data pipeline:
      1. Playwright loads DK's JS-rendered rankings page and intercepts the API
         response — gives real DK best ball ADP directly from the source.
      2. Falls back to DK lineup CSV (salary rank as ADP proxy) if Playwright fails.
      3. Sort by ADP ascending, assign sequential integer ADP (1 = best).
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

    print(f'  ✓ {len(dk_players)} players fetched')

    players = []
    for i, dk_p in enumerate(dk_players, 1):
        team     = dk_p['team']
        schedule = PLAYOFF_SCHEDULE_2026.get(team, (None, None, None))
        player_id = dk_p.get('dk_id') or f'dk_{i}'
        adp = dk_p.get('adp') or i

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

    # Sort by ADP ascending, then re-number as sequential integers
    players.sort(key=lambda p: p['adp'])
    for i, p in enumerate(players, 1):
        p['adp'] = i

    _save_cache(players, '2026')
    return players
