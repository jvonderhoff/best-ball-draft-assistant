"""
Scrape 2026 NFL season player prop O/U lines from DraftKings Sportsbook.

DK API structure (per response):
  markets[]   → {id, name:"NFL 2026/27 - PlayerName Regular Season Stat",
                   marketType:{name:"Regular Season Stat OU"}}
  selections[] → {marketId, label:"Over 1050.5", outcomeType:"Over"/"Under",
                   displayOdds:{american:"-110"}}

Entry point: fetch_season_props()
Returns: {player_name: {prop_type: {line, over_odds, under_odds}}}
"""

import asyncio
import re
from playwright.async_api import async_playwright

DK_NFL_URL = 'https://sportsbook.draftkings.com/leagues/football/nfl'

# marketType.name → our prop key
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

# On-page tab labels → same map (for clicking)
SUBCAT_TABS = [
    'PASS YARDS', 'PASS TDS', 'REC YARDS', 'REC TDS',
    'RUSH YARDS', 'RUSH TDS', 'RECEPTIONS', 'INTERCEPTIONS',
]


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

    # Build market lookup
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

    # Parse selections
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


async def _run_scraper(verbose=True):
    props = {}
    captured = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/124.0.0.0 Safari/537.36'
            ),
            viewport={'width': 1280, 'height': 900},
        )
        page = await context.new_page()

        async def on_response(response):
            if response.status != 200:
                return
            if 'json' not in response.headers.get('content-type', ''):
                return
            if 'sportsbook-nash' not in response.url:
                return
            try:
                body = await response.json()
                if body.get('markets'):
                    captured.append(body)
            except Exception:
                pass

        page.on('response', on_response)

        # Load player-futures page
        if verbose:
            print('  [Betting] Loading DK Sportsbook player futures…')
        try:
            await page.goto(
                f'{DK_NFL_URL}?category=futures&subcategory=player-futures',
                wait_until='networkidle',
                timeout=30000,
            )
        except Exception as e:
            if verbose:
                print(f'  [Betting] Load warning: {e}')
        await page.wait_for_timeout(2000)

        # Click through each subcategory tab
        for tab in SUBCAT_TABS:
            if verbose:
                print(f'  [Betting] Fetching {tab}…')
            try:
                el = page.get_by_text(tab, exact=True).first
                if not await el.is_visible():
                    el = page.get_by_text(tab, exact=False).first
                await el.click()
                await page.wait_for_timeout(2500)
            except Exception:
                pass

        await browser.close()

    if verbose:
        print(f'  [Betting] {len(captured)} API responses captured')

    for body in captured:
        _parse_response(body, props)

    if verbose:
        print(f'  [Betting] {len(props)} players with prop lines')

    return props


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
    Scrape DK Sportsbook season player prop O/U lines.
    Returns {player_name: {prop_type: {line, over_odds, under_odds}}}
    """
    return asyncio.run(_run_scraper(verbose=verbose))
