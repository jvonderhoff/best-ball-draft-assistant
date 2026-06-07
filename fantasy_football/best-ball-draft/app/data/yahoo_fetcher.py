"""
Yahoo Fantasy Sports API integration.

OAuth 2.0 flow:
  1. GET  /api/yahoo/auth      → redirects user to Yahoo login
  2. GET  /api/yahoo/callback  → exchanges code for tokens, stores them
  3. Tokens auto-refresh on expiry (1hr TTL, refresh_token is long-lived)

Data fetched:
  - NFL player analyst rankings (AR sort) across QB/RB/WR/TE
  - Projected season PPR points per player
  - Returns {player_name: {'fpts': float, 'pos': str, 'yahoo_rank': int}}
"""

import os
import json
import time
import base64
import requests
import re
from urllib.parse import urlencode

# Credentials — set as Render env vars: YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET
CLIENT_ID     = os.environ.get('YAHOO_CLIENT_ID', '')
CLIENT_SECRET = os.environ.get('YAHOO_CLIENT_SECRET', '')

AUTH_URL  = 'https://api.login.yahoo.com/oauth2/request_auth'
TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token'
API_BASE  = 'https://fantasysports.yahooapis.com/fantasy/v2'

_TOKEN_FILE = os.path.join(os.path.dirname(__file__), '.yahoo_tokens.json')

_token_cache = {}   # in-memory cache so we don't hit disk on every request


# ── Token persistence ─────────────────────────────────────────────────────────

def _load_tokens():
    global _token_cache
    if _token_cache:
        return _token_cache
    # 1. Disk
    try:
        with open(_TOKEN_FILE) as f:
            _token_cache = json.load(f)
            return _token_cache
    except Exception:
        pass
    # 2. Env var (survives Render redeploys)
    env = os.environ.get('YAHOO_TOKENS', '')
    if env:
        try:
            _token_cache = json.loads(env)
            return _token_cache
        except Exception:
            pass
    return {}


def _save_tokens(tokens: dict):
    global _token_cache
    _token_cache = tokens
    try:
        with open(_TOKEN_FILE, 'w') as f:
            json.dump(tokens, f)
    except Exception as e:
        print(f'[Yahoo] Could not save tokens to disk: {e}')


# ── OAuth helpers ─────────────────────────────────────────────────────────────

def get_auth_url(redirect_uri: str) -> str:
    params = {
        'client_id':     CLIENT_ID,
        'redirect_uri':  redirect_uri,
        'response_type': 'code',
    }
    return f"{AUTH_URL}?{urlencode(params)}"


def exchange_code(code: str, redirect_uri: str) -> dict:
    """Exchange an auth code for access + refresh tokens."""
    creds = base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
    r = requests.post(TOKEN_URL, data={
        'grant_type':   'authorization_code',
        'code':         code,
        'redirect_uri': redirect_uri,
    }, headers={
        'Authorization': f'Basic {creds}',
        'Content-Type':  'application/x-www-form-urlencoded',
    }, timeout=15)
    r.raise_for_status()
    tokens = r.json()
    tokens['expires_at'] = time.time() + tokens.get('expires_in', 3600)
    _save_tokens(tokens)
    return tokens


def _refresh_tokens(tokens: dict) -> dict:
    creds = base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
    r = requests.post(TOKEN_URL, data={
        'grant_type':    'refresh_token',
        'refresh_token': tokens['refresh_token'],
        'redirect_uri':  'oob',
    }, headers={
        'Authorization': f'Basic {creds}',
        'Content-Type':  'application/x-www-form-urlencoded',
    }, timeout=15)
    r.raise_for_status()
    new_tokens = r.json()
    new_tokens['expires_at'] = time.time() + new_tokens.get('expires_in', 3600)
    _save_tokens(new_tokens)
    return new_tokens


def _get_access_token() -> str | None:
    tokens = _load_tokens()
    if not tokens.get('access_token'):
        return None
    # Refresh if within 60s of expiry
    if time.time() > tokens.get('expires_at', 0) - 60:
        try:
            tokens = _refresh_tokens(tokens)
        except Exception as e:
            print(f'[Yahoo] Token refresh failed: {e}')
            return None
    return tokens['access_token']


def is_authenticated() -> bool:
    return bool(_load_tokens().get('access_token'))


# ── API wrapper ───────────────────────────────────────────────────────────────

def _api_get(path: str, params: dict = None) -> dict | None:
    token = _get_access_token()
    if not token:
        return None
    p = dict(params or {})
    p['format'] = 'json'
    try:
        r = requests.get(
            f"{API_BASE}{path}",
            headers={'Authorization': f'Bearer {token}'},
            params=p,
            timeout=20,
        )
        if r.status_code == 401:
            print('[Yahoo] 401 — token may be expired')
            return None
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f'[Yahoo] API error {path}: {e}')
        return None


# ── NFL game key ──────────────────────────────────────────────────────────────

_nfl_game_key_cache = None

def _get_nfl_game_key() -> str | None:
    global _nfl_game_key_cache
    if _nfl_game_key_cache:
        return _nfl_game_key_cache

    # Try with draft filter first, then without (pre-season the draft flag may be unset)
    for path in [
        '/games;game_codes=nfl;is_available_for_league_type=full_draft',
        '/games;game_codes=nfl',
    ]:
        data = _api_get(path)
        if not data:
            print(f'[Yahoo] No response from {path}')
            continue
        try:
            games = data['fantasy_content']['games']
            count = games.get('count', 0)
            print(f'[Yahoo] game_key search {path}: count={count}')
            # Pick the game with the highest game_key (most recent season)
            best_key = None
            for i in range(count):
                g = games.get(str(i), {}).get('game', [{}])
                key = g[0].get('game_key') if g else None
                season = g[0].get('season') if g else None
                print(f'[Yahoo]   game {i}: key={key} season={season}')
                if key and (best_key is None or int(key) > int(best_key)):
                    best_key = key
            if best_key:
                _nfl_game_key_cache = best_key
                print(f'[Yahoo] Using NFL game key: {best_key}')
                return best_key
        except Exception as e:
            print(f'[Yahoo] game_key parse error ({path}): {e}')
    return None


# ── Player data ───────────────────────────────────────────────────────────────

def _normalize(name: str) -> str:
    name = name.lower()
    name = re.sub(r"['\-\.]", '', name)
    name = re.sub(r'\s+(jr|sr|ii|iii|iv|v)\s*$', '', name)
    return name.strip()


def _parse_player_block(player_list: list) -> dict | None:
    """
    Yahoo wraps player info as: [{ player fields... }, { player_stats: {...} }]
    Extract name, position, projected points.
    """
    if not player_list or not isinstance(player_list, list):
        return None

    info = player_list[0] if isinstance(player_list[0], list) else []
    stats_block = player_list[1] if len(player_list) > 1 else {}

    # info is a list of dicts like [{'player_key': ...}, {'full_name': ...}, ...]
    field_map = {}
    for item in info:
        if isinstance(item, dict):
            field_map.update(item)

    name = field_map.get('full_name', '')
    pos_data = field_map.get('display_position', '') or field_map.get('primary_position', '')
    pos = pos_data.split(',')[0].strip().upper() if pos_data else ''
    if pos not in ('QB', 'RB', 'WR', 'TE'):
        return None

    # Extract projected points from stats
    fpts = 0.0
    if isinstance(stats_block, dict):
        player_stats = stats_block.get('player_stats', {})
        stats = player_stats.get('stats', [])
        for stat in stats:
            if isinstance(stat, dict):
                s = stat.get('stat', {})
                # stat_id 1073 = projected PPR points in Yahoo
                if str(s.get('stat_id', '')) == '1073':
                    try:
                        fpts = float(s.get('value', 0) or 0)
                    except ValueError:
                        pass

    return {'name': name, 'pos': pos, 'fpts': fpts} if name else None


def fetch_yahoo_projections(verbose: bool = True) -> dict:
    """
    Fetch Yahoo Fantasy NFL season projections for QB/RB/WR/TE.
    Returns {player_name: {'fpts': float, 'pos': str, 'yahoo_rank': int}}
    Falls back gracefully — returns {} on auth/API failure.
    """
    if not is_authenticated():
        print('[Yahoo] Not authenticated — skipping')
        return {}

    game_key = _get_nfl_game_key()
    if not game_key:
        print('[Yahoo] Could not determine NFL game key')
        return {}

    result = {}
    positions = ['QB', 'RB', 'WR', 'TE']

    for pos in positions:
        if verbose:
            print(f'  [Yahoo] Fetching {pos} projections…')
        start = 0
        pos_rank = 1
        while True:
            data = _api_get(
                f'/game/{game_key}/players;position={pos};sort=AR;start={start};count=25/stats;type=projected_season_stats',
            )
            if not data:
                break
            try:
                content = data['fantasy_content']['game']
                # content[0] = game info dict, content[1] = players dict
                players_block = content[1].get('players', {}) if len(content) > 1 else {}
                count = players_block.get('count', 0)
                if not count:
                    break
                for i in range(count):
                    p_data = players_block.get(str(i), {}).get('player')
                    parsed = _parse_player_block(p_data)
                    if parsed:
                        parsed['yahoo_rank'] = pos_rank
                        result[parsed['name']] = {
                            'fpts':       parsed['fpts'],
                            'pos':        parsed['pos'],
                            'yahoo_rank': pos_rank,
                        }
                        pos_rank += 1
                if verbose:
                    print(f'  [Yahoo] {pos}: {count} players (start={start})')
                if count < 25:
                    break
                start += 25
            except Exception as e:
                print(f'  [Yahoo] Parse error for {pos} start={start}: {e}')
                break

    if verbose:
        print(f'  [Yahoo] Total: {len(result)} players')
    return result
