"""
Fetch 2026 NFL season player prop O/U lines from Underdog Fantasy.

API endpoint: https://api.underdogfantasy.com/beta/v5/over_under_lines
Returns all props in a single JSON call — no scraping needed.

Response structure:
  players[]     → {id, first_name, last_name, sport_id}
  appearances[] → {id, player_id, ...}
  over_under_lines[] → {
      stat_value,
      over_under: {
          appearance_stat: {appearance_id, stat, display_stat},
          title
      },
      options: [{choice: 'higher'/'lower', american_price}]
  }

Entry point: fetch_season_props()
Returns: {player_name: {prop_type: {line, over_odds, under_odds}}}
"""

import requests

UNDERDOG_URL = 'https://api.underdogfantasy.com/beta/v5/over_under_lines'

HEADERS = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
}

# Underdog stat key → our internal prop key
STAT_MAP = {
    'season_pass_yards':      'pass_yd',
    'season_pass_tds':        'pass_td',
    'season_rush_yards':      'rush_yd',
    'season_rush_tds':        'rush_td',
    'season_receiving_yards': 'rec_yd',
    'season_rec_tds':         'rec_td',
    'season_receptions':      'rec',
    'season_pass_ints':       'pass_int',
    'season_interceptions':   'pass_int',
}


def fetch_season_props(verbose=True) -> dict:
    """
    Fetch Underdog Fantasy 2026 NFL season prop O/U lines.
    Returns {player_name: {prop_type: {line, over_odds, under_odds}}}
    """
    if verbose:
        print('  [Underdog] Fetching season props…')

    try:
        resp = requests.get(UNDERDOG_URL, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        if verbose:
            print(f'  [Underdog] Fetch error: {e}')
        return {}

    players     = {p['id']: p for p in data.get('players', []) if p.get('sport_id') == 'NFL'}
    appearances = {a['id']: a for a in data.get('appearances', []) if a.get('player_id') in players}

    props = {}

    for line in data.get('over_under_lines', []):
        ou       = line.get('over_under') or {}
        app_stat = ou.get('appearance_stat') or {}
        app_id   = app_stat.get('appearance_id', '')

        if app_id not in appearances:
            continue

        stat_key  = app_stat.get('stat', '')
        prop_type = STAT_MAP.get(stat_key)
        if not prop_type:
            continue

        app      = appearances[app_id]
        player   = players.get(app['player_id'], {})
        name     = f"{player.get('first_name', '')} {player.get('last_name', '')}".strip()
        if not name:
            continue

        line_val = float(line.get('stat_value', 0) or 0)

        if name not in props:
            props[name] = {}
        if prop_type not in props[name]:
            props[name][prop_type] = {'line': line_val, 'over_odds': None, 'under_odds': None}

        for opt in line.get('options', []):
            choice = opt.get('choice', '').lower()
            price  = opt.get('american_price')
            if choice == 'higher':
                props[name][prop_type]['over_odds'] = price
            elif choice == 'lower':
                props[name][prop_type]['under_odds'] = price

    if verbose:
        print(f'  [Underdog] {len(props)} players with prop lines')

    return props
