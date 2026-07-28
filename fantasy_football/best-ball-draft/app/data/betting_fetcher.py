"""
Fetch 2026 NFL season player prop O/U lines from DraftKings Sportsbook via
direct calls to the sportsbook-nash API (no browser automation required).

Each prop type (passing yards, rushing TDs, etc.) lives under its own
"subcategory" on DK's player-futures page. There's no discovery endpoint for
these IDs — they're grabbed by opening the page in a browser, filtering
DevTools Network on "leagueSubcategory", clicking each tab, and reading the
second number out of the `templateVars=<leagueId>,<subCategoryId>` param.
Update SUBCATEGORY_IDS the same way if DK adds a tab (e.g. Receptions,
Interceptions aren't posted yet as of writing) or changes IDs season to season.

API response structure:
  markets[]   → {id, name:"NFL 2026/27 - PlayerName Regular Season Stat",
                   marketType:{name:"Regular Season Stat OU"}}
  selections[] → {marketId, label:"Over 1050.5", outcomeType:"Over"/"Under",
                   displayOdds:{american:"-110"}}

Entry point: fetch_season_props()
Returns: {player_name: {prop_type: {line, over_odds, under_odds}}}
"""

import re
import requests

DK_NASH_URL = (
    'https://sportsbook-nash.draftkings.com/sites/US-SB/api/sportscontent/'
    'controldata/league/leagueSubcategory/v1/markets'
)
DK_REFERER = (
    'https://sportsbook.draftkings.com/leagues/football/nfl'
    '?category=futures&subcategory=player-futures'
)
NFL_LEAGUE_ID = '88808'

# prop key → DK subCategoryId (from templateVars=88808,<id> on the player-futures page)
SUBCATEGORY_IDS = {
    'pass_yd':  '17147',
    'pass_td':  '17148',
    'rec_yd':   '17314',
    'rec_td':   '17315',
    'rush_yd':  '17223',
    'rush_td':  '17224',
    # 'rec':      None,  # Receptions — not posted by DK yet
    # 'pass_int': None,  # Interceptions — not posted by DK yet
}

# marketType.name → our prop key (kept for matching within each subcategory's response)
MARKET_TYPE_MAP = {
    'passing yards':       'pass_yd',
    'passing touchdowns':  'pass_td',
    'passing tds':         'pass_td',
    'rushing yards':       'rush_yd',
    'rushing touchdowns':  'rush_td',
    'rushing tds':         'rush_td',
    'receiving yards':     'rec_yd',
    'receiving touchdowns':'rec_td',
    'receiving tds':       'rec_td',
    'receptions':          'rec',
    'interceptions':       'pass_int',
}

_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    ),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': DK_REFERER,
    'Origin': 'https://sportsbook.draftkings.com',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
}


def _prop_type_from_market(market_type_name: str):
    t = market_type_name.lower()
    for keyword, prop in MARKET_TYPE_MAP.items():
        if keyword in t:
            return prop
    return None


def _player_from_market_name(name: str):
    """Extract player name from 'NFL 2026/27 - John Doe Regular Season ...' """
    m = re.search(r'[-–]\s*(.+?)\s+Regular Season', name)
    if m:
        return m.group(1).strip()
    # Fallback: strip prefix
    name = re.sub(r'^NFL \d{4}/\d{2,4}\s*[-–]\s*', '', name).strip()
    return name


def _parse_line_from_label(label: str):
    """'Over 1050.5' → 1050.5"""
    m = re.search(r'([\d]+\.?\d*)\s*$', label)
    return float(m.group(1)) if m else None


def _parse_response(body: dict, props: dict):
    """
    body keys: sports, leagues, events, markets, selections
    Build market_id → {player_name, prop_type} then walk selections for lines.
    """
    markets = body.get('markets', [])
    selections = body.get('selections', [])

    market_map = {}   # id → {player_name, prop_type}
    for m in markets:
        mt_name = m.get('marketType', {}).get('name', '')
        prop_type = _prop_type_from_market(mt_name)
        if not prop_type:
            continue
        player_name = _player_from_market_name(m.get('name', ''))
        if not player_name:
            continue
        market_map[m['id']] = {'player_name': player_name, 'prop_type': prop_type}

    for sel in selections:
        mid = sel.get('marketId')
        info = market_map.get(mid)
        if not info:
            continue

        label = sel.get('label', '')
        line = _parse_line_from_label(label)
        if line is None:
            continue

        outcome = (sel.get('outcomeType') or '').lower()
        odds = sel.get('displayOdds', {}).get('american', '')

        pn = info['player_name']
        pt = info['prop_type']
        if pn not in props:
            props[pn] = {}
        if pt not in props[pn]:
            props[pn][pt] = {'line': line, 'over_odds': None, 'under_odds': None}

        # Both over and under share the same line; just assign odds
        if 'over' in outcome:
            props[pn][pt]['over_odds'] = odds
            props[pn][pt]['line'] = line        # prefer over label's line
        elif 'under' in outcome:
            props[pn][pt]['under_odds'] = odds


def _fetch_subcategory(sub_id: str, session: requests.Session) -> dict:
    params = {
        'isBatchable': 'false',
        'templateVars': f'{NFL_LEAGUE_ID},{sub_id}',
        'eventsQuery': (
            f"$filter=leagueId eq '{NFL_LEAGUE_ID}' AND "
            f"clientMetadata/Subcategories/any(s: s/Id eq '{sub_id}')"
        ),
        'marketsQuery': (
            f"$filter=clientMetadata/subCategoryId eq '{sub_id}' AND "
            f"tags/all(t: t ne 'SportcastBetBuilder')"
        ),
        'include': 'Events',
        'entity': 'events',
    }
    resp = session.get(DK_NASH_URL, params=params, headers=_HEADERS, timeout=15)
    resp.raise_for_status()
    return resp.json()


def props_to_fantasy_pts(player_props: dict) -> float:
    """Convert season O/U lines to implied full-PPR fantasy points."""
    def get_line(key):
        entry = player_props.get(key, {})
        return entry.get('line', 0) if isinstance(entry, dict) else 0

    rush_pts = get_line('rush_yd') * 0.1 + get_line('rush_td') * 6
    rec_pts  = get_line('rec_yd') * 0.1 + get_line('rec') * 1.0 + get_line('rec_td') * 6
    pass_pts = get_line('pass_yd') * 0.04 + get_line('pass_td') * 4 - get_line('pass_int') * 2
    return round(rush_pts + rec_pts + pass_pts, 1)


def fetch_season_props(verbose=True) -> dict:
    """
    Fetch DK Sportsbook season player prop O/U lines via direct API calls.
    Returns {player_name: {prop_type: {line, over_odds, under_odds}}}
    """
    props = {}
    session = requests.Session()

    for prop_type, sub_id in SUBCATEGORY_IDS.items():
        if verbose:
            print(f'  [Betting] Fetching {prop_type}…')
        try:
            body = _fetch_subcategory(sub_id, session)
            _parse_response(body, props)
        except Exception as e:
            if verbose:
                print(f'  [Betting] {prop_type} fetch error: {e}')

    if verbose:
        print(f'  [Betting] {len(props)} players with prop lines')

    return props
