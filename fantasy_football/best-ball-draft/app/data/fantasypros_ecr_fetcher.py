"""
Fetch FantasyPros Expert Consensus Rankings (ECR) for best ball PPR.

Endpoint: partners.fantasypros.com/api/v1/consensus-rankings.php
  sport=NFL, type=bestball, scoring=PPR, position=ALL, week=0

Returns 471 players ranked by 43+ experts. Much more differentiated than
ADP for deep players (200+) where draft data gets thin and noisy.

Entry point: fetch_ecr()
Returns: {normalized_name: {'ecr_rank': int, 'pos': str, 'team': str}}
"""

import re
import requests

ECR_URL = 'https://partners.fantasypros.com/api/v1/consensus-rankings.php'
ECR_PARAMS = {
    'sport':    'NFL',
    'year':     '2026',
    'week':     '0',
    'id':       '1',
    'position': 'ALL',
    'type':     'bestball',
    'scoring':  'PPR',
    'experts':  'available',
}

_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    ),
    'Referer': 'https://www.fantasypros.com/',
}

SKILL_POSITIONS = {'QB', 'RB', 'WR', 'TE'}


def _normalize(name: str) -> str:
    """Lowercase, strip suffixes and punctuation for fuzzy matching."""
    name = name.lower()
    name = re.sub(r"\b(jr\.?|sr\.?|ii|iii|iv)\b", '', name)
    name = re.sub(r"[^a-z ]", '', name)
    return ' '.join(name.split())


def fetch_ecr(verbose=True) -> dict:
    """
    Fetch FantasyPros best ball PPR ECR.
    Returns {normalized_name: {'ecr_rank': int, 'pos': str, 'team': str}}
    """
    if verbose:
        print('  [FP ECR] Fetching best ball PPR expert consensus rankings…')
    try:
        resp = requests.get(ECR_URL, params=ECR_PARAMS, headers=_HEADERS, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        if verbose:
            print(f'  [FP ECR] Fetch error: {e}')
        return {}

    players = data.get('players', [])
    result = {}
    for p in players:
        pos = (p.get('player_position_id') or '').upper()
        if pos not in SKILL_POSITIONS:
            continue
        name = (p.get('player_name') or '').strip()
        if not name:
            continue
        ecr_rank = p.get('rank_ecr')
        if ecr_rank is None:
            continue
        team = (p.get('player_team_id') or '').upper()
        result[_normalize(name)] = {'ecr_rank': int(ecr_rank), 'pos': pos, 'team': team}

    if verbose:
        print(f'  [FP ECR] {len(result)} skill-position players ranked')
    return result
