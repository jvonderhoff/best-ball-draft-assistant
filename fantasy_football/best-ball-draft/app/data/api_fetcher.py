"""
Fetches NFL player data and draft picks from DraftKings via direct API calls.
Primary source: api.draftkings.com endpoints (discovered via network inspection).
  - Firefox cookies used for authentication (read from SQLite cookie store)
  - No browser automation required

Update DK_RANKINGS_ID each season — find it in the URL of the DK best ball rankings page.
"""
import csv
import io
import json
import os
import re
import time
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
            if pos not in SKILL_POSITIONS or not name:
                continue
            if not team:
                team = 'FA'
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
        # Keep FA players — DK includes free agents in best ball drafts
        if not team:
            team = 'FA'

        adp = p.get('averageDraftPosition')
        try:
            adp = float(adp) if adp is not None else None
        except (ValueError, TypeError):
            adp = None

        did = pid_to_did.get(pid)
        dk_id = f'dk_{did}' if did else f'dk_{pid}'
        players.append({'name': name, 'pos': pos, 'team': team, 'adp': adp, 'dk_id': dk_id})

    # Keep all players — assign a high ADP to undrafted ones so they sort last
    for p in players:
        if p['adp'] is None:
            p['adp'] = 9999.0
    players.sort(key=lambda p: p['adp'])
    return players



# Cookies pushed from the Mac via /api/sync-cookies (used when Firefox isn't local)
_synced_cookies: dict = {}

def set_synced_cookies(cookies: dict):
    """Called by app.py when /api/sync-cookies is hit."""
    global _synced_cookies
    _synced_cookies = cookies


def _get_firefox_dk_cookies_dict():
    """
    Return DK cookies as {name: value}.
    Priority: synced cookies (pushed from Mac) → local Firefox SQLite.
    """
    if _synced_cookies:
        return _synced_cookies

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
        return {}
    tmp = tempfile.mktemp(suffix='.sqlite')
    try:
        shutil.copy2(db_path, tmp)
        conn = sqlite3.connect(tmp)
        rows = conn.execute(
            'SELECT name, value FROM moz_cookies WHERE host LIKE "%draftkings%"'
        ).fetchall()
        conn.close()
    except Exception as e:
        print(f'  [DK] cookie read error: {e}')
        return {}
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass
    return {name: value for name, value in rows}


def _dk_session(referer=None):
    """Build a requests.Session with DK Firefox cookies and browser-like headers."""
    cookies = _get_firefox_dk_cookies_dict()
    if not cookies:
        return None
    s = requests.Session()
    s.headers.update({
        'User-Agent': (
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
            'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        ),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.draftkings.com',
        'Referer': referer or 'https://www.draftkings.com/',
    })
    s.cookies.update(cookies)
    return s


# Cache draftables per draft group — 4.7 MB, refreshed at most once per hour
_draftables_cache = {}   # draftGroupId -> (fetched_at, {draftableId: {name, pos, team}})
_DRAFTABLES_TTL = 3600


def _fetch_draftables(session, draft_group_id=DK_RANKINGS_ID):
    """Fetch (and cache) the full player pool for a draft group."""
    cached = _draftables_cache.get(str(draft_group_id))
    if cached and (time.time() - cached[0]) < _DRAFTABLES_TTL:
        return cached[1]
    try:
        r = session.get(
            f'https://api.draftkings.com/draftgroups/v1/draftgroups/{draft_group_id}/draftables?format=json',
            timeout=20,
        )
        r.raise_for_status()
        dmap = {}
        for d in (r.json().get('draftables') or []):
            did = d.get('draftableId')
            if did:
                dmap[did] = {
                    'name': d.get('displayName') or
                            f"{d.get('firstName','')} {d.get('lastName','')}".strip(),
                    'pos':  (d.get('position') or '').upper(),
                    'team': (d.get('teamAbbreviation') or '').upper(),
                }
        _draftables_cache[str(draft_group_id)] = (time.time(), dmap)
        print(f'  [DK] draftables fetched: {len(dmap)} players (group {draft_group_id})')
        return dmap
    except Exception as e:
        print(f'  [DK] draftables fetch error: {e}')
        return cached[1] if cached else {}


def fetch_dk_draft_picks(contest_id, entry_id=None, draft_group_id=None):
    """
    Fetch the current draft board using direct API calls via direct DK API calls.
    Uses Firefox cookies + api.draftkings.com endpoints discovered via network inspection.
    Returns normalized pick list or None on failure.
    """
    session = _dk_session(referer=f'https://www.draftkings.com/draft/snake/{contest_id}')
    if not session:
        print('  [DK] No Firefox DK cookies found')
        return None

    user_guid = _load_user_guid()

    # Resolve entry_id (and draft_group_id) from drafts/live if not supplied
    if (not entry_id or not draft_group_id) and user_guid:
        try:
            r = session.get(
                f'https://api.draftkings.com/drafts/v1/users/{user_guid}/drafts/live?format=json',
                timeout=10,
            )
            if r.ok:
                for ud in (r.json().get('userDrafts') or []):
                    if str(ud.get('contestId')) == str(contest_id):
                        entry_id    = entry_id    or str(ud.get('entryId', ''))
                        draft_group_id = draft_group_id or str(ud.get('draftGroupId', ''))
                        break
        except Exception as e:
            print(f'  [DK] drafts/live lookup error: {e}')

    if not entry_id:
        print(f'  [DK] No entry_id for contest {contest_id} — cannot fetch picks')
        return None

    # Fetch pick state
    try:
        r = session.get(
            f'https://api.draftkings.com/drafts/v1/{contest_id}/entries/{entry_id}/draftStatus?format=json',
            timeout=10,
        )
        r.raise_for_status()
        draft_board = r.json().get('draftBoard') or []
    except Exception as e:
        print(f'  [DK] draftStatus error: {e}')
        return None

    if not draft_board:
        print('  [DK] draftBoard is empty')
        return None

    # Fetch player name/pos/team (cached — only hits the network once per hour)
    dg_id = draft_group_id or DK_RANKINGS_ID
    draftable_map = _fetch_draftables(session, dg_id)
    print(f'  [DK] draftables: {len(draftable_map)} players, draftBoard: {len(draft_board)} slots')

    # Scan ALL entries (including unfilled future slots) to detect user's draft position
    # Round-1 slots have userKey set even before the pick is made
    my_position = None
    if user_guid:
        for entry in draft_board:
            if entry.get('roundNumber') == 1 and entry.get('userKey') == user_guid:
                pick_num = entry.get('overallSelectionNumber')
                if pick_num:
                    my_position = int(pick_num)
                    print(f'  [DK] Detected my_position={my_position} from round-1 slot')
                    break

    picks = []
    for entry in draft_board:
        did = entry.get('draftableId')
        if not did:
            continue   # unfilled future slot — skip for picks list
        player_info = draftable_map.get(did, {})
        name     = player_info.get('name') or f'Player #{did}'
        pos      = player_info.get('pos', '')
        team     = player_info.get('team', '')
        pick_num = entry.get('overallSelectionNumber')
        user_key = entry.get('userKey', '')
        username = 'jvonderhoff' if (user_guid and user_key == user_guid) else ''
        picks.append({
            'player_name': name,
            'pick_number': pick_num,
            'username':    username,
            'pos':         pos,
            'team':        team,
            'round':       entry.get('roundNumber'),
            'draftable_id': str(did),
        })

    print(f'  [DK] ✓ {len(picks)} picks for contest {contest_id}, my_position={my_position}')
    return {'picks': picks, 'my_position': my_position} if picks or my_position else None


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
    Discover the user's active best ball drafts via direct API call.
    Requires a cached user GUID (written on first pick fetch).
    Returns list of {id, entry_id, name, picks_until_clock, round} dicts.
    """
    user_guid = _load_user_guid()
    if not user_guid:
        print('  [DK] No cached user GUID — cannot fetch live drafts')
        return []

    session = _dk_session()
    if not session:
        print('  [DK] No Firefox DK cookies found')
        return []

    try:
        r = session.get(
            f'https://api.draftkings.com/drafts/v1/users/{user_guid}/drafts/live?format=json',
            timeout=10,
        )
        r.raise_for_status()
        drafts = _parse_live_drafts(r.json())
        print(f'  [DK] ✓ {len(drafts)} live drafts discovered (direct API)')
        return drafts
    except Exception as e:
        print(f'  [DK] fetch_my_dk_drafts error: {e}')
        return []


# ── DraftKings fetch orchestrator ──────────────────────────────────────────────

def _discover_rankings_id_direct() -> str:
    """
    Get the current DK rankings ID via direct API call — fast alternative to
    direct API. Reads the draftGroup list
    for NFL best-ball and returns the active group ID, or None on failure.
    """
    session = _dk_session(referer='https://www.draftkings.com/draft/rankings/NFL')
    if not session:
        return None
    try:
        # The draftgroup info endpoint confirms the ID is still valid
        r = session.get(
            f'https://api.draftkings.com/sites/US-DK/draftgroups/v3/draftgroups/{DK_RANKINGS_ID}?format=json',
            timeout=10,
        )
        if r.ok:
            groups = r.json().get('draftGroups', [])
            if groups:
                gid = str(groups[0].get('draftGroupId', ''))
                if gid:
                    return gid
    except Exception:
        pass
    return None


def _fetch_dk_rankings_direct(ranking_id: str = DK_RANKINGS_ID) -> list:
    """
    Fetch DK player pool + real ADP via direct API calls via direct DK API calls.
    Uses the same endpoints the rankings page fires, discovered via network capture.
    Returns {name, pos, team, adp, dk_id} dicts sorted by adp, or [] on failure.
    """
    session = _dk_session(referer=f'https://www.draftkings.com/draft/rankings/NFL/{ranking_id}')
    if not session:
        return []

    responses = {}
    try:
        r = session.get(
            f'https://api.draftkings.com/rankings/v1/draftgroups/{ranking_id}/playerpool?format=json',
            timeout=20,
        )
        r.raise_for_status()
        responses['playerpool'] = r.json()
        count = len(responses['playerpool'].get('playerPool', {}).get('draftablePlayers', []))
        print(f'  [DK] playerpool: {count} players')
    except Exception as e:
        print(f'  [DK] playerpool fetch error: {e}')
        return []

    try:
        r = session.get(
            f'https://api.draftkings.com/draftgroups/v1/draftgroups/{ranking_id}/draftables?format=json',
            timeout=20,
        )
        r.raise_for_status()
        responses['draftables'] = r.json()
    except Exception as e:
        print(f'  [DK] draftables fetch error (continuing without team/pos): {e}')

    players = _parse_dk_api_responses(responses)
    if players:
        has_adp = sum(1 for p in players if p['adp'] is not None)
        print(f'  [DK] ✓ {len(players)} players, {has_adp} with ADP (direct API)')
    return players


def fetch_dk_players(ranking_id: str = DK_RANKINGS_ID) -> list:
    """
    Fetch the DK player pool with real ADP from the rankings page.
    Strategy 1: Direct API (fast)
    Strategy 2: Lineup CSV — salary rank as ADP proxy (fallback)
    Returns list of {name, pos, team, adp} dicts, adp may be None on full failure.
    """
    # Auto-discover the current season's rankings ID
    discovered_id = _discover_rankings_id_direct()
    if discovered_id and discovered_id != ranking_id:
        print(f'  [DK] rankings ID updated: {ranking_id} → {discovered_id}')
        ranking_id = discovered_id

    # Strategy 1 — Direct API (fast)
    players = _fetch_dk_rankings_direct(ranking_id)
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
      1. Direct API calls to api.draftkings.com (playerpool + draftables)
         response — gives real DK best ball ADP directly from the source.
      2. Falls back to DK lineup CSV (salary rank as ADP proxy) on failure.
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
