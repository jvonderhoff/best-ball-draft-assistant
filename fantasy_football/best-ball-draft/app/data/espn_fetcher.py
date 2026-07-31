"""
Fetch ESPN season projections for QB/RB/WR/TE.

Endpoint (public, unauthenticated):
  lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{year}/segments/0/leaguedefaults/3
  ?view=kona_player_info      + an x-fantasy-filter header controlling paging/sort

`leaguedefaults/3` is ESPN's full-PPR default league, which matches DraftKings
scoring on receptions.  DK's 100/300-yard game bonuses are not included here — those
are estimated downstream in app/projections.py from the component yardage.

Why ESPN: FantasyPros gated free season projections to a 10-player-per-position
teaser (the rest is no longer in the page at all), and their partners API exposes
only consensus *rankings*, never points.  ESPN is free, complete, and — critically —
publishes projected RECEPTIONS, which no sportsbook quotes.  In full PPR that is
~1 point each and roughly a third of a receiver's total, so it is the one gap the
betting-prop correction cannot cover.

Entry point: fetch_espn_projections()
Returns: {player_name: {'fpts', 'pos', 'pass_yd', 'pass_td', 'pass_int',
                        'rush_yd', 'rush_td', 'rec', 'rec_yd', 'rec_td'}}
"""

import json

import requests

BASE_URL = ('https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/'
            'seasons/{year}/segments/0/leaguedefaults/3')

# ESPN's numeric stat ids on the projection row.
STAT_IDS = {
    3:  'pass_yd',
    4:  'pass_td',
    20: 'pass_int',
    24: 'rush_yd',
    25: 'rush_td',
    42: 'rec_yd',
    43: 'rec_td',
    53: 'rec',
}

POSITION_IDS = {1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE'}

# statSourceId 1 = projected (0 = actual); statSplitTypeId 0 = full season (1 = weekly)
PROJECTED_SOURCE = 1
SEASON_SPLIT     = 0

_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    ),
    'Referer': 'https://fantasy.espn.com/',
    'Accept': 'application/json',
}


def _filter_header(limit: int, offset: int) -> str:
    return json.dumps({
        'players': {
            'limit':  limit,
            'offset': offset,
            'sortDraftRanks': {
                'sortPriority': 100,
                'sortAsc': True,
                'value': 'PPR',
            },
        }
    })


def fetch_espn_projections(year: int = 2026, limit: int = 300, pages: int = 3,
                           verbose: bool = True) -> dict:
    """
    Fetch ESPN full-PPR season projections for skill positions.

    Pages through the player list in draft-rank order.  Returns {} on total failure;
    partial pages are kept, since a short board still beats no second source.
    """
    result = {}
    url = BASE_URL.format(year=year)

    for page in range(pages):
        offset = page * limit
        if verbose:
            print(f'  [ESPN] Fetching projections {offset}-{offset + limit}…')
        try:
            resp = requests.get(
                url,
                params={'view': 'kona_player_info'},
                headers={**_HEADERS, 'x-fantasy-filter': _filter_header(limit, offset)},
                timeout=30,
            )
            resp.raise_for_status()
            payload = resp.json()
        except Exception as e:
            if verbose:
                print(f'  [ESPN] page {page} failed: {e}')
            break

        entries = payload.get('players') or []
        if not entries:
            break

        for entry in entries:
            p = entry.get('player') or {}
            pos = POSITION_IDS.get(p.get('defaultPositionId'))
            if not pos:
                continue
            name = (p.get('fullName') or '').strip()
            if not name:
                continue

            row = None
            for s in p.get('stats') or []:
                if (s.get('seasonId') == year
                        and s.get('statSourceId') == PROJECTED_SOURCE
                        and s.get('statSplitTypeId') == SEASON_SPLIT):
                    row = s
                    break
            if not row:
                continue

            fpts = row.get('appliedTotal')
            if not fpts or fpts <= 0:
                continue

            stats = row.get('stats') or {}
            rec = {'fpts': round(float(fpts), 1), 'pos': pos}
            for stat_id, key in STAT_IDS.items():
                rec[key] = round(float(stats.get(str(stat_id)) or 0), 1)

            # Keep the higher projection if a name appears twice.
            if name not in result or rec['fpts'] > result[name]['fpts']:
                result[name] = rec

    if verbose:
        print(f'  [ESPN] {len(result)} skill-position players projected')
    return result
