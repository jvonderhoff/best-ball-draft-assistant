from flask import Flask, render_template, jsonify, request, redirect, url_for
from flask_cors import CORS
from app.database import init_db, save_draft, get_all_drafts, get_exposure, delete_draft, get_rankings, save_rankings, save_props, get_all_props, save_projections, get_raw_projections, projections_meta, save_yahoo_projections, get_yahoo_projections, yahoo_projections_meta
import json
import os
import re
import time
import threading
import requests as req_lib

basedir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

app = Flask(__name__,
    template_folder=os.path.join(basedir, 'templates'),
    static_folder=os.path.join(basedir, 'static')
)
app.secret_key = 'best-ball-secret-key-2024'
CORS(app, resources={r"/*": {"origins": "*"}})

@app.after_request
def add_pna_header(response):
    """Chrome Private Network Access — allow requests from public sites to this LAN server."""
    if request.method == 'OPTIONS':
        response.headers['Access-Control-Allow-Private-Network'] = 'true'
    return response

init_db()

# ── Player name index (built at startup) ──────────────────────────────────────
# Used by the DOM-text endpoint to match player names found on the DK page.
_PLAYERS_BY_NAME  = {}   # lowercase full name → player dict
_PLAYERS_BY_LAST  = {}   # lowercase "last pos" → [player dict, …]
_PLAYERS_BY_ABBR  = {}   # "A_lastname_POS" → player dict  (single, first-write/low-ADP wins)
_PLAYERS_BY_ABBR_MULTI = {}  # "A_lastname_POS" → [player, …]  (all candidates; for collision disambiguation)
_PLAYERS_BY_ID    = {}   # "dk_42775000" → player dict  (for extension taken_ids lookup)

def _load_players_index():
    """Parse players.js and build fast lookup dicts."""
    ext_dir = os.path.join(basedir, '..', 'best-ball-extension')
    js_path  = os.path.join(ext_dir, 'players.js')
    if not os.path.exists(js_path):
        js_path = os.path.join(basedir, 'static', 'players.js')
    try:
        with open(js_path) as f:
            text = f.read()
        m = re.search(r'const PLAYERS\s*=\s*(\[.*?\]);', text, re.DOTALL)
        if not m:
            # Try without semicolon
            m = re.search(r'const PLAYERS\s*=\s*(\[.*\])', text, re.DOTALL)
        if m:
            players = json.loads(m.group(1))
            for p in players:
                name = p.get('name', '')
                if not name:
                    continue
                lname = name.lower()
                _PLAYERS_BY_NAME[lname] = p
                parts = name.split()
                pos = p.get('pos', '')
                if len(parts) >= 2:
                    # "lastname_pos" index
                    key = f"{parts[-1].lower()}_{pos}"
                    _PLAYERS_BY_LAST.setdefault(key, []).append(p)
                    # "Initial_lastname_pos" index for DK abbreviated names ("J. Gibbs RB")
                    initial = parts[0][0].upper()
                    # Use the LAST significant word as lastname (skip Jr./Sr./II/III/IV)
                    suffixes = {'jr', 'sr', 'ii', 'iii', 'iv', 'v'}
                    last = parts[-1].lower().rstrip('.')
                    if last in suffixes and len(parts) >= 3:
                        last = parts[-2].lower().rstrip('.')
                    abbr_key = f"{initial}_{last}_{pos}"
                    # Single-entry dict: first write (lowest ADP) wins for quick lookup
                    _PLAYERS_BY_ABBR.setdefault(abbr_key, p)
                    _PLAYERS_BY_ABBR.setdefault(f"{initial}_{last}", p)
                    # Multi-entry list: ALL candidates stored for round-based disambiguation
                    _PLAYERS_BY_ABBR_MULTI.setdefault(abbr_key, []).append(p)
                    _PLAYERS_BY_ABBR_MULTI.setdefault(f"{initial}_{last}", []).append(p)
                # ID index — DK IDs are "dk_XXXXXXX"
                pid = p.get('id', '')
                if pid:
                    _PLAYERS_BY_ID[pid] = p
            print(f"[Players] Loaded {len(_PLAYERS_BY_NAME)} players, {len(_PLAYERS_BY_ABBR)} abbr keys, {len(_PLAYERS_BY_ID)} id keys")
    except Exception as e:
        print(f"[Players] Could not load index: {e}")

_load_players_index()


@app.route('/')
def index():
    return redirect(url_for('recommend_page'))

@app.route('/history')
def history():
    return render_template('history.html')


# ── Draft history ─────────────────────────────────────────────────────────────

@app.route('/api/drafts/import', methods=['POST'])
def import_draft():
    """
    Import a completed draft directly from the extension.
    Body: { dk_draft_id, my_position, picks: [{id,name,pos,team,adp},...] }
    """
    data = request.get_json()
    picks = data.get('picks', [])
    if not picks:
        return jsonify({'error': 'No picks provided'}), 400
    try:
        draft_id = save_draft(
            num_teams   = 12,
            my_position = data.get('my_position', 0),
            picks       = picks,
            contest     = data.get('contest', ''),
            dk_draft_id = data.get('dk_draft_id'),
        )
        if draft_id is None:
            return jsonify({'success': True, 'draft_id': None, 'duplicate': True})
        return jsonify({'success': True, 'draft_id': draft_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/drafts', methods=['GET'])
def list_drafts():
    return jsonify(get_all_drafts())


@app.route('/api/drafts/exposure', methods=['GET'])
def exposure():
    return jsonify(get_exposure())


@app.route('/api/drafts/<int:draft_id>', methods=['DELETE'])
def delete_draft_route(draft_id):
    delete_draft(draft_id)
    return jsonify({'success': True})


# ── Player data ───────────────────────────────────────────────────────────────

@app.route('/api/players/refresh', methods=['POST'])
def refresh_players():
    try:
        from app.data.api_fetcher import fetch_players
        from app.database import refresh_players as db_refresh_players
        players = fetch_players(force_refresh=True)
        db_refresh_players(players)
        return jsonify({'success': True, 'player_count': len(players)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Player rankings ───────────────────────────────────────────────────────────

@app.route('/rankings')
def rankings_page():
    return render_template('rankings.html')


@app.route('/api/rankings', methods=['GET'])
def get_rankings_route():
    return jsonify(get_rankings())


@app.route('/api/rankings/save', methods=['POST'])
def save_rankings_route():
    data = request.get_json()
    rankings = data.get('rankings', [])
    if not isinstance(rankings, list):
        return jsonify({'error': 'rankings must be a list'}), 400
    count = save_rankings(rankings)
    return jsonify({'ok': True, 'saved': count})


@app.route('/api/rankings/export', methods=['POST'])
def export_rankings_to_extension():
    """
    Regenerate best-ball-extension/players.js using custom ranks as the ADP
    for ranked players; unranked players keep their DK ADP (offset past ranked ones).
    """
    players = get_rankings()
    if not players:
        return jsonify({'error': 'no players in DB'}), 400

    ranked   = [p for p in players if p['custom_rank'] is not None]
    unranked = [p for p in players if p['custom_rank'] is None]

    ranked.sort(key=lambda p: p['custom_rank'])
    unranked.sort(key=lambda p: p['adp'] or 9999)

    ordered = ranked + unranked
    output = []
    for i, p in enumerate(ordered, 1):
        output.append({
            'id':     p['player_id'],
            'name':   p['name'],
            'pos':    p['pos'],
            'team':   p['team'],
            'adp':    i,
            'season': '2026',
            'week15': p.get('week15'),
            'week16': p.get('week16'),
            'week17': p.get('week17'),
        })

    ext_path = os.path.join(basedir, '..', 'best-ball-extension', 'players.js')
    ext_path = os.path.normpath(ext_path)
    try:
        with open(ext_path, 'w') as f:
            f.write(f'// Auto-generated by rankings export — {len(output)} players, season 2026\n')
            f.write('// Source: custom rankings from best-ball-draft/rankings\n')
            f.write('// Re-run: use the Export button on the Rankings page\n')
            f.write('const PLAYERS = ')
            json.dump(output, f, separators=(',', ':'))
            f.write(';\n')
        return jsonify({'ok': True, 'players': len(output), 'path': ext_path})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Betting props ─────────────────────────────────────────────────────────────

@app.route('/api/props', methods=['GET'])
def get_props():
    return jsonify(get_all_props())


@app.route('/api/projections', methods=['GET'])
def get_projections():
    """
    Return { player_id: { mean, weekly_stddev, source } } keyed by DK player ID.

    Priority:
      1. FantasyPros season projections (player_projections table) — full PPR fpts
      2. DK prop lines (player_props table) — converted to PPR fpts
      (ADP-based fallback handled client-side for remaining players)

    Weekly stddev = position CV × weekly mean (WR 0.75, TE 0.65, RB 0.55, QB 0.35).
    """
    _suffixes = {'jr', 'sr', 'ii', 'iii', 'iv', 'v'}
    def normalize(name):
        n = re.sub(r'[.\']', '', name.lower()).strip()
        parts = n.split()
        if parts and parts[-1] in _suffixes:
            parts = parts[:-1]
        return ' '.join(parts)

    pos_cv = {'QB': 0.35, 'RB': 0.55, 'WR': 0.75, 'TE': 0.65}

    # Load FantasyPros projections (keyed by player_name as stored)
    fp_raw = get_raw_projections()
    fp_by_norm = {normalize(k): v for k, v in fp_raw.items()}

    # Load prop lines as fallback
    from app.database import get_db
    with get_db() as conn:
        prop_rows = conn.execute('SELECT player_name, prop_type, line FROM player_props').fetchall()
    props_by_name = {}
    for r in prop_rows:
        props_by_name.setdefault(r['player_name'].lower(), {})[r['prop_type']] = r['line']
    props_by_norm = {normalize(k): v for k, v in props_by_name.items()}

    result = {}
    for raw_name, player in _PLAYERS_BY_NAME.items():
        pid = player.get('id')
        pos = player.get('pos', 'WR')
        if not pid:
            continue

        norm = normalize(raw_name)
        mean = source = None

        # 1. FantasyPros
        fp = fp_raw.get(raw_name) or fp_by_norm.get(norm)
        if fp and fp.get('fpts'):
            mean   = fp['fpts']
            source = 'fp'

        # 2. Prop lines
        if mean is None:
            p = props_by_name.get(raw_name) or props_by_norm.get(norm)
            if p:
                mean = (
                    p.get('pass_yd', 0) * 0.04 +
                    p.get('pass_td', 0) * 4 +
                    p.get('rush_yd', 0) * 0.1 +
                    p.get('rush_td', 0) * 6 +
                    p.get('rec_yd',  0) * 0.1 +
                    p.get('rec_yd',  0) / 9 +
                    p.get('rec_td',  0) * 6
                )
                source = 'props'

        if mean and mean > 0:
            weekly_mean = mean / 17
            result[pid] = {
                'mean':          round(mean, 1),
                'weekly_stddev': round(weekly_mean * pos_cv.get(pos, 0.5), 2),
                'source':        source,
            }

    return jsonify(result)


@app.route('/api/projections/refresh', methods=['POST'])
def refresh_projections():
    """Scrape fresh FantasyPros PPR projections and store them."""
    try:
        from app.data.fantasypros_fetcher import fetch_projections
        projections = fetch_projections(verbose=True)
        if not projections:
            return jsonify({'ok': False, 'error': 'No projections returned — FantasyPros may require JS rendering or the page structure changed'}), 200
        count = save_projections(projections)
        return jsonify({'ok': True, 'players': count, 'source': 'FantasyPros'})
    except Exception as e:
        import traceback
        return jsonify({'ok': False, 'error': str(e), 'trace': traceback.format_exc()}), 500


@app.route('/api/projections/meta', methods=['GET'])
def get_projections_meta():
    meta = projections_meta()
    return jsonify(meta or {'count': 0, 'last_updated': None})


# ── Yahoo Fantasy OAuth ───────────────────────────────────────────────────────

def _yahoo_redirect_uri():
    """Detect whether we're on Render or localhost and return the right callback URL."""
    host = request.host
    if 'render.com' in host or 'onrender.com' in host:
        return f"https://{host}/api/yahoo/callback"
    return f"http://{host}/api/yahoo/callback"


@app.route('/api/yahoo/auth')
def yahoo_auth():
    """Redirect user to Yahoo OAuth login page."""
    from app.data.yahoo_fetcher import get_auth_url, CLIENT_ID
    if not CLIENT_ID:
        return (
            "<h2>Yahoo not configured</h2>"
            "<p>Set <code>YAHOO_CLIENT_ID</code> and <code>YAHOO_CLIENT_SECRET</code> "
            "as environment variables on Render, then redeploy.</p>", 500
        )
    redirect_uri = _yahoo_redirect_uri()
    url = get_auth_url(redirect_uri)
    print(f'[Yahoo] Auth redirect → {url}')
    print(f'[Yahoo] Redirect URI: {redirect_uri}')
    # ?debug=1 shows the URL instead of redirecting — useful for troubleshooting
    if request.args.get('debug'):
        return f"<pre>Auth URL:\n{url}\n\nRedirect URI:\n{redirect_uri}\n\nClient ID:\n{CLIENT_ID[:20]}...</pre>"
    return redirect(url)


@app.route('/api/yahoo/auth/debug')
def yahoo_auth_debug():
    """Show OAuth URL without redirecting — for troubleshooting."""
    from app.data.yahoo_fetcher import get_auth_url, CLIENT_ID
    redirect_uri = _yahoo_redirect_uri()
    url = get_auth_url(redirect_uri)
    return f"<pre>Auth URL:\n{url}\n\nRedirect URI:\n{redirect_uri}\n\nClient ID (first 20 chars):\n{CLIENT_ID[:20]}...</pre>"


@app.route('/api/yahoo/callback')
def yahoo_callback():
    """Handle Yahoo OAuth callback — exchange code for tokens."""
    # Yahoo sends error details if the user denied or something went wrong
    error = request.args.get('error')
    error_desc = request.args.get('error_description', '')
    if error:
        return (
            f"<h2>Yahoo OAuth error: {error}</h2>"
            f"<p>{error_desc}</p>"
            f"<p>Full params: {dict(request.args)}</p>"
            f"<a href='/setup'>← Back to Setup</a>", 400
        )

    code = request.args.get('code')
    if not code:
        return (
            f"<h2>No code received from Yahoo</h2>"
            f"<p>Params received: {dict(request.args)}</p>"
            f"<a href='/setup'>← Back to Setup</a>", 400
        )
    try:
        from app.data.yahoo_fetcher import exchange_code
        tokens = exchange_code(code, _yahoo_redirect_uri())
        print(f"[Yahoo] Token exchange successful, expires_in={tokens.get('expires_in')}")
        return redirect('/setup?yahoo=connected')
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"[Yahoo] Token exchange failed: {e}\n{tb}")
        return (
            f"<h2>Yahoo token exchange failed</h2>"
            f"<pre>{e}</pre>"
            f"<a href='/setup'>← Back to Setup</a>", 500
        )


@app.route('/api/yahoo/status')
def yahoo_status():
    from app.data.yahoo_fetcher import is_authenticated, _load_tokens, CLIENT_ID
    from app.database import kv_get
    tokens = _load_tokens()
    expires_at = tokens.get('expires_at')
    # Check each token source independently
    db_raw = kv_get('yahoo_tokens')
    import os
    from app.data.yahoo_fetcher import _TOKEN_FILE
    disk_exists = os.path.exists(_TOKEN_FILE)
    env_set = bool(os.environ.get('YAHOO_TOKENS', ''))
    return jsonify({
        'authenticated': is_authenticated(),
        'configured': bool(CLIENT_ID),
        'redirect_uri': _yahoo_redirect_uri(),
        'expires_at': expires_at,
        'token_in_db': bool(db_raw),
        'token_on_disk': disk_exists,
        'token_in_env': env_set,
        'has_access_token': bool(tokens.get('access_token')),
    })


@app.route('/api/yahoo/raw-test')
def yahoo_raw_test():
    """Dump raw Yahoo API response for debugging."""
    from app.data.yahoo_fetcher import _get_access_token, _get_nfl_game_key, API_BASE
    import requests as req
    game_key = _get_nfl_game_key()
    path = request.args.get('path', f'/game/{game_key}/players;position=QB;sort=AR;start=0;count=3/stats;type=projected_season_stats')
    token = _get_access_token()
    if not token:
        return jsonify({'error': 'no token', 'game_key': game_key})
    try:
        r = req.get(
            f"{API_BASE}{path}",
            headers={'Authorization': f'Bearer {token}'},
            params={'format': 'json'},
            timeout=20,
        )
        return jsonify({
            'path': path,
            'game_key': game_key,
            'status_code': r.status_code,
            'response': r.json() if r.headers.get('content-type', '').startswith('application/json') else r.text[:2000],
        })
    except Exception as e:
        return jsonify({'path': path, 'game_key': game_key, 'error': str(e)})


@app.route('/api/yahoo/projections/refresh', methods=['POST'])
def refresh_yahoo_projections():
    """Fetch Yahoo Fantasy player projections and store them."""
    try:
        from app.data.yahoo_fetcher import fetch_yahoo_projections, is_authenticated, _get_nfl_game_key, _load_tokens
        tokens = _load_tokens()
        auth = bool(tokens.get('access_token'))
        if not auth:
            return jsonify({'ok': False, 'error': 'Not authenticated — connect Yahoo first', 'tokens_found': bool(tokens)}), 200
        game_key = _get_nfl_game_key()
        if not game_key:
            return jsonify({'ok': False, 'error': 'Could not determine NFL game key — check Render logs for details'}), 200
        projections = fetch_yahoo_projections(verbose=True)
        if not projections:
            return jsonify({'ok': False, 'error': f'No projections returned from Yahoo (game_key={game_key})'}), 200
        count = save_yahoo_projections(projections)
        return jsonify({'ok': True, 'players': count, 'source': 'Yahoo', 'game_key': game_key})
    except Exception as e:
        import traceback
        return jsonify({'ok': False, 'error': str(e), 'trace': traceback.format_exc()}), 500


@app.route('/api/props/refresh', methods=['POST'])
def refresh_props():
    try:
        from app.data.betting_fetcher import fetch_season_props as fetch_dk
        props = fetch_dk(verbose=True)
        if not props:
            return jsonify({'ok': False, 'error': 'No props scraped — DK Sportsbook may have changed or season props not yet posted'}), 200
        count = save_props(props, book='DraftKings')
        return jsonify({'ok': True, 'book': 'DraftKings', 'players': len(props), 'rows': count})
    except Exception as e:
        import traceback
        return jsonify({'ok': False, 'error': str(e), 'trace': traceback.format_exc()}), 500


@app.route('/api/props/refresh/underdog', methods=['POST'])
def refresh_props_underdog():
    try:
        from app.data.underdog_fetcher import fetch_season_props as fetch_ud
        props = fetch_ud(verbose=True)
        if not props:
            return jsonify({'ok': False, 'error': 'No props returned from Underdog'}), 200
        count = save_props(props, book='Underdog')
        return jsonify({'ok': True, 'book': 'Underdog', 'players': len(props), 'rows': count})
    except Exception as e:
        import traceback
        return jsonify({'ok': False, 'error': str(e), 'trace': traceback.format_exc()}), 500


# ── DK intercept store ────────────────────────────────────────────────────────
# Receives pick data intercepted by the bookmarklet running on the DK draft page.
# The bookmarklet patches window.fetch + WebSocket on the DK page and forwards
# DK's own authenticated API responses here — no cookie proxy needed.
_dk_intercept = {}      # draft_id -> { picks, raw_responses, updated_at, sources }
_dk_known_drafts = {}  # draft_id -> { label, registered_at } — found on contests page but not yet scanned

def _store_intercept(draft_id, url, data):
    """Parse and store pick data from an intercepted DK API call."""
    id_str = str(draft_id)
    if id_str not in _dk_intercept:
        _dk_intercept[id_str] = {
            'picks': [],
            'raw_responses': [],
            'updated_at': time.time(),
            'sources': [],
        }
    entry = _dk_intercept[id_str]
    entry['updated_at'] = time.time()
    # Store raw for debugging (keep last 5 responses per draft)
    entry['raw_responses'] = (entry['raw_responses'] + [{'url': url, 'keys': list(data.keys()) if isinstance(data, dict) else str(data)[:200]}])[-5:]

    picks = _parse_picks_from_response(data)
    if picks:
        entry['picks'] = picks
        entry['overall_pick'] = max((p.get('pick_number') or 0 for p in picks), default=0) + 1
        entry['sources'].append(url)
        return len(picks)
    return 0


# ── DK cookie store & proxy (legacy — used for probe/debug only) ──────────────
_DK_SESSION_FILE = os.path.join(basedir, '.dk_session.json')

_dk_session = {
    'cookie':    None,   # raw Cookie header string (from document.cookie)
    'ls_tokens': {},     # JWT tokens from localStorage keyed by their key name
    'updated_at': None,
}

# Load persisted session from disk on startup
def _load_dk_session():
    try:
        if os.path.exists(_DK_SESSION_FILE):
            with open(_DK_SESSION_FILE) as f:
                data = json.load(f)
            if data.get('cookie'):
                _dk_session['cookie']     = data['cookie']
                _dk_session['ls_tokens']  = data.get('ls_tokens', {})
                _dk_session['updated_at'] = data.get('updated_at')
                print(f"[DK] Loaded persisted session ({len(data['cookie'])} bytes)")
    except Exception as e:
        print(f"[DK] Could not load session: {e}")

def _save_dk_session():
    try:
        with open(_DK_SESSION_FILE, 'w') as f:
            json.dump({
                'cookie':     _dk_session['cookie'],
                'ls_tokens':  _dk_session['ls_tokens'],
                'updated_at': _dk_session['updated_at'],
            }, f)
    except Exception as e:
        print(f"[DK] Could not save session: {e}")

_load_dk_session()

# Cache of draft_id -> { picks, overall_pick, my_username, updated_at }
_dk_pick_cache = {}
_dk_poll_threads = {}   # draft_id -> threading.Thread


def _dk_headers(extra=None):
    h = {
        'User-Agent': (
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
            'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
        ),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.draftkings.com/',
        'Origin': 'https://www.draftkings.com',
    }
    if _dk_session.get('cookie'):
        h['Cookie'] = _dk_session['cookie']
    # If localStorage had a JWT, try it as Authorization Bearer
    ls_tokens = _dk_session.get('ls_tokens') or {}
    if ls_tokens:
        # Use the first JWT found (common keys: 'access_token', 'id_token', etc.)
        first_jwt = next(iter(ls_tokens.values()))
        h['Authorization'] = f'Bearer {first_jwt}'
    if extra:
        h.update(extra)
    return h


def _normalize_pick(p):
    """
    Normalize a single pick object to {player_name, pos, team, pick_number, username}.
    Handles:
      - Direct: {displayName, position, teamAbbreviation, pickNumber, entryName}
      - Nested:  {player: {displayName, ...}, draftTeam: {entryName, ...}, pickNumber}
      - React fiber: same as above with varying key names
    """
    if not isinstance(p, dict):
        return None
    # Player sub-object (DK often nests it)
    po = p.get('player') or p.get('draftPlayer') or p
    # Team sub-object
    to = p.get('draftTeam') or p.get('team') or {}
    if isinstance(to, str):
        to = {'teamAbbreviation': to}

    name = (po.get('displayName') or
            ' '.join(filter(None, [po.get('firstName',''), po.get('lastName','')])).strip() or
            po.get('playerName') or po.get('name') or
            p.get('displayName') or p.get('playerName') or p.get('name') or '')

    if not name:
        return None

    pos = (po.get('position') or po.get('pos') or
           p.get('position') or p.get('pos') or '')
    team = (po.get('teamAbbreviation') or po.get('nflTeamAbbreviation') or po.get('team') or
            p.get('teamAbbreviation') or p.get('nflTeamAbbreviation') or
            (to.get('teamAbbreviation') if isinstance(to, dict) else '') or '')
    pick_num = (p.get('pickNumber') or p.get('pick_number') or p.get('overallPickNumber') or
                p.get('draftPickNumber') or None)
    username = (p.get('username') or p.get('entryName') or p.get('draftTeamName') or
                (to.get('entryName') or to.get('name') if isinstance(to, dict) else '') or
                p.get('teamName') or '')

    return {
        'player_name': name,
        'pick_number': pick_num,
        'username':    username,
        'pos':         pos,
        'team':        team,
    }


def _parse_picks_from_response(data):
    """
    Extract a flat list of normalized picks from any DK API response shape.
    Searches common field names and nested structures recursively (up to depth 4).
    """
    if not isinstance(data, dict):
        # If data itself is a list, try it directly
        if isinstance(data, list) and data:
            results = [_normalize_pick(p) for p in data]
            results = [r for r in results if r and r['player_name']]
            if results:
                return results
        return None

    # Field names that typically contain the picks array
    pick_fields = ['picks', 'draftPicks', 'selections', 'draftSelections',
                   'roster', 'entries', 'draftSelections', 'board', 'participants',
                   'draftBoard', 'lineups', 'players']

    def search(obj, depth):
        if depth > 4 or not isinstance(obj, dict):
            return None
        for field in pick_fields:
            lst = obj.get(field)
            if isinstance(lst, list) and lst and isinstance(lst[0], dict):
                # Check if items look like picks (have a name somewhere)
                sample = lst[0]
                po = sample.get('player') or sample.get('draftPlayer') or sample
                if any(k in po for k in ('displayName', 'firstName', 'playerName', 'name')):
                    results = [_normalize_pick(p) for p in lst]
                    results = [r for r in results if r and r['player_name']]
                    if results:
                        return results
        # Recurse into nested dicts
        for v in obj.values():
            if isinstance(v, dict):
                r = search(v, depth + 1)
                if r:
                    return r
        return None

    return search(data, 0)


def _fetch_dk_draft(draft_id):
    """
    Try multiple DK endpoints and return raw picks list, or None on failure.
    Stores result in _dk_pick_cache[draft_id].
    """
    id_str = str(draft_id)
    # Best-ball / snake draft endpoints (ordered most-likely first)
    endpoints = [
        # Snake draft board — most direct
        f'https://api.draftkings.com/lineups/v1/draftselections?draftGroupId={id_str}',
        f'https://api.draftkings.com/draft/v1/draftgroups/{id_str}/draftboard',
        f'https://api.draftkings.com/draft/v1/draftgroups/{id_str}/selections',
        f'https://api.draftkings.com/draft/v2/draftgroups/{id_str}/selections',
        # Generic contest/lineup endpoints
        f'https://api.draftkings.com/lineups/v1/lineups?draftGroupId={id_str}',
        f'https://api.draftkings.com/lineups/v2/lineups?draftGroupId={id_str}',
        f'https://api.draftkings.com/draftgroups/v1/draftgroups/{id_str}',
        f'https://api.draftkings.com/draftgroups/v2/draftgroups/{id_str}',
        # www endpoints
        f'https://www.draftkings.com/lineup/getdraftboard?draftGroupId={id_str}',
        f'https://www.draftkings.com/api/lineup/getpicks?draftGroupId={id_str}',
    ]
    h = _dk_headers()
    last_status = None
    for url in endpoints:
        try:
            r = req_lib.get(url, headers=h, timeout=10)
            last_status = r.status_code
            if r.status_code not in (200, 201):
                continue
            try:
                data = r.json()
            except Exception:
                continue

            # Try to extract picks
            picks = _parse_picks_from_response(data)
            if picks is not None:
                _dk_pick_cache[id_str] = {
                    'picks': picks,
                    'overall_pick': max((p.get('pick_number') or 0 for p in picks), default=0) + 1,
                    'updated_at': time.time(),
                    'source': url,
                    'raw': data,   # keep raw for debugging
                    'error': None,
                }
                return picks

            # 200 but no picks yet — store raw for probe inspection
            _dk_pick_cache[id_str] = _dk_pick_cache.get(id_str) or {}
            _dk_pick_cache[id_str].update({'updated_at': time.time(), 'source': url, 'raw_keys': list(data.keys()) if isinstance(data, dict) else str(data)[:200]})

        except Exception as e:
            last_status = f'err:{e}'
            continue

    # No successful endpoint found
    if id_str not in _dk_pick_cache:
        _dk_pick_cache[id_str] = {}
    _dk_pick_cache[id_str]['error'] = f'All endpoints failed (last status: {last_status})'
    _dk_pick_cache[id_str]['updated_at'] = time.time()
    return None


def _fetch_my_dk_drafts():
    """Try to fetch the user's active/upcoming snake drafts from DK."""
    h = _dk_headers()
    results = {}

    # Endpoints the extension was known to hit successfully (ordered most likely first)
    for url in [
        'https://www.draftkings.com/api/lineups/getentries?sport=1',
        'https://www.draftkings.com/api/lineups/getentries',
        'https://www.draftkings.com/api/contests/getentries',
        'https://api.draftkings.com/lineups/v1/lineups?sport=1&statuses=live',
        'https://api.draftkings.com/entries/v1/entries?sport=1',
        'https://api.draftkings.com/entries/v1/entries?statuses=InProgress,Upcoming&sport=1',
    ]:
        try:
            r = req_lib.get(url, headers=h, timeout=8, allow_redirects=False)
            if r.status_code == 200:
                try:
                    data = r.json()
                    results[url] = {'status': 200, 'keys': list(data.keys()) if isinstance(data, dict) else str(data)[:300]}
                    # DK wraps response: {data: {entries: [...]}} or flat {entries: [...]}
                    inner = data.get('data') or data
                    entries = (inner.get('entries') or inner.get('lineups') or
                               inner.get('contests') or inner.get('results') or [])
                    if isinstance(entries, list) and entries:
                        drafts = []
                        for e in entries:
                            dg_id = (e.get('draftGroupId') or e.get('draftGroup', {}).get('draftGroupId')
                                     or e.get('contestId') or e.get('id'))
                            name  = (e.get('contestName') or e.get('draftGroupTag')
                                     or e.get('name') or e.get('gameType') or '')
                            if dg_id:
                                drafts.append({'id': str(dg_id), 'name': name})
                        if drafts:
                            return {'source': url, 'drafts': drafts, 'raw': results}
                except Exception:
                    results[url] = {'status': 200, 'body': r.text[:300]}
            else:
                results[url] = {'status': r.status_code}
        except Exception as e:
            results[url] = {'error': str(e)}

    return {'source': None, 'drafts': [], 'raw': results}


@app.route('/api/dk-intercept', methods=['POST'])
def dk_intercept():
    """
    Receive an intercepted DK API response from the bookmarklet.
    The bookmarklet patches window.fetch on the DK draft page and forwards
    any draft-related API response here. Browser handles all auth transparently.
    """
    body = request.get_json(silent=True) or {}
    url      = body.get('url', '')
    draft_id = str(body.get('draft_id', '') or '').strip()
    data     = body.get('data', {})

    if not draft_id or not isinstance(data, dict):
        return jsonify({'ok': False, 'error': 'missing draft_id or data'})

    n = _store_intercept(draft_id, url, data)

    # Also store in the old pick cache so dk_draft_state_proxy can see it
    if n > 0:
        _dk_pick_cache[draft_id] = {
            'picks':       _dk_intercept[draft_id]['picks'],
            'overall_pick': _dk_intercept[draft_id].get('overall_pick', 1),
            'updated_at':  time.time(),
            'source':      url,
            'error':       None,
        }
        print(f"[DK intercept] draft={draft_id} url=…{url[-50:]} picks={n}")
    else:
        print(f"[DK intercept] draft={draft_id} url=…{url[-50:]} no picks — raw keys: {list(data.keys())[:10]}")

    return jsonify({'ok': True, 'picks_found': n, 'draft_id': draft_id})


@app.route('/api/dk-picks-direct', methods=['POST'])
def dk_picks_direct():
    """
    Receive a raw list of pick objects scraped directly from React state.
    The bookmarklet walks the React fiber tree and sends whatever it finds.
    We normalize and store it exactly like an intercepted API response.
    """
    body = request.get_json(silent=True) or {}
    draft_id = str(body.get('draft_id', '') or '').strip()
    raw_picks = body.get('picks', [])
    source    = body.get('source', 'react-fiber')

    if not draft_id or not isinstance(raw_picks, list):
        return jsonify({'ok': False, 'error': 'missing draft_id or picks'})

    # Normalize each pick
    normalized = [_normalize_pick(p) for p in raw_picks]
    normalized = [p for p in normalized if p and p['player_name']]

    if normalized:
        id_str = draft_id
        if id_str not in _dk_intercept:
            _dk_intercept[id_str] = {'picks': [], 'raw_responses': [], 'updated_at': time.time(), 'sources': []}
        entry = _dk_intercept[id_str]
        entry['picks']      = normalized
        entry['overall_pick'] = max((p.get('pick_number') or 0 for p in normalized), default=0) + 1
        entry['updated_at'] = time.time()
        entry['sources'].append(source)
        entry['raw_responses'] = (entry['raw_responses'] + [{'url': source, 'count': len(normalized)}])[-5:]

        # Mirror to pick cache
        _dk_pick_cache[id_str] = {
            'picks': normalized, 'overall_pick': entry['overall_pick'],
            'updated_at': time.time(), 'source': source, 'error': None,
        }
        print(f"[DK direct] draft={draft_id} source={source} picks={len(normalized)}")

    return jsonify({'ok': True, 'picks_stored': len(normalized), 'draft_id': draft_id})


@app.route('/api/dk-ws-message', methods=['POST'])
def dk_ws_message():
    """Receive an intercepted DK WebSocket message from the bookmarklet."""
    body = request.get_json(silent=True) or {}
    draft_id = str(body.get('draft_id', '') or '').strip()
    url      = body.get('url', '')
    data     = body.get('data', {})

    if not draft_id:
        return jsonify({'ok': False, 'error': 'missing draft_id'})

    n = _store_intercept(draft_id, f'ws:{url}', data)
    print(f"[DK WS] draft={draft_id} url=…{url[-40:]} picks={n}")
    return jsonify({'ok': True, 'picks_found': n})


@app.route('/api/dk-dom-text', methods=['POST'])
def dk_dom_text():
    """
    Receive raw DOM text from the DK draft page.
    The bookmarklet sends document.body.innerText; we match known player names
    from our PLAYERS index and store the result as picks.
    """
    body     = request.get_json(silent=True) or {}
    draft_id = str(body.get('draft_id', '') or '').strip()
    text     = body.get('text', '')

    if not draft_id or not text:
        return jsonify({'ok': False, 'error': 'missing draft_id or text'})

    if not _PLAYERS_BY_NAME:
        return jsonify({'ok': False, 'error': 'player index not loaded'})

    board_only  = body.get('board_only', False)
    board_text  = body.get('board_text', False)   # True = DK board textContent (abbreviated names)
    my_picks    = body.get('my_picks', False)     # True = text is only the user's own column
    column_idx  = body.get('column_idx')          # int or None — 0-based draft-board column index

    found = {}  # player_name → {'player': player dict, 'round': int}

    # ── Strategy 1: Abbreviated name regex (DK board format: "J. Gibbs RB DET") ──
    # DK's draft board shows picks as: {round}.{pick_in_round}{overall?}{Name}{Pos}{Team}
    # e.g. "1.11J. GibbsRBDET" or "2.1224N. CollinsWRHOU"
    # Require the round.pick prefix to distinguish DRAFTED picks from the player pool.
    if board_text or _PLAYERS_BY_ABBR:
        # Anchored pattern: captures round, team, and name for full disambiguation.
        pick_pat = re.compile(
            r'(\d{1,2})\.\d{1,2}'                        # group(1): round number
            r'\d{0,3}'                                    # optional overall pick digits
            r'([A-Z]\. [A-Za-z][A-Za-z\'\-\.\s]{0,30}?)' # group(2): abbreviated name
            r'(QB|RB|WR|TE|K|DEF|DST)'                   # group(3): position
            r'([A-Z]{2,4})?'                              # group(4): optional team abbr
        )
        for m in pick_pat.finditer(text):
            round_num = int(m.group(1))
            abbr_name = m.group(2).strip()
            pos       = m.group(3)
            team_abbr = (m.group(4) or '').upper()
            nm = re.match(r'([A-Z])\. (.+)', abbr_name)
            if not nm:
                continue
            initial    = nm.group(1)
            name_parts = nm.group(2).strip().split()
            suffixes   = {'jr', 'sr', 'ii', 'iii', 'iv', 'v', 'jr.', 'sr.'}
            last = ''
            for part in reversed(name_parts):
                if part.lower().rstrip('.') not in suffixes:
                    last = part.lower().rstrip('.')
                    break
            if not last:
                continue

            # ── Candidate resolution with round-based disambiguation ──────────
            abbr_key = f"{initial}_{last}_{pos}"
            candidates = list(_PLAYERS_BY_ABBR_MULTI.get(abbr_key) or
                               _PLAYERS_BY_ABBR_MULTI.get(f"{initial}_{last}") or [])

            # Filter by team if we have it and it narrows the field
            if team_abbr and candidates:
                team_filtered = [c for c in candidates if c.get('team', '').upper() == team_abbr]
                if team_filtered:
                    candidates = team_filtered

            if not candidates:
                continue

            if len(candidates) == 1:
                player = candidates[0]
            else:
                # Multiple players share initial+last+pos (e.g. Bijan & Brian Robinson RB ATL).
                # Pick whichever player's expected draft round is closest to the actual round.
                num_teams = 12
                def expected_round(c):
                    adp = c.get('adp', 999)
                    return max(1, (adp - 1) // num_teams + 1)
                player = min(candidates, key=lambda c: abs(expected_round(c) - round_num))

            if player and player['name'] not in found:
                found[player['name']] = {'player': player, 'round': round_num}

        print(f"[DK DOM abbr] draft={draft_id} pick-anchored matched={len(found)}")

    # ── Strategy 2: Full-name substring scan (fallback / supplement) ──
    if not board_text:
        # Only apply cutoff for non-board scans (board text has no player pool section)
        cutoff_markers = [
            'available players', 'player pool', 'search players',
            'add to watchlist', 'player rankings', 'all players',
        ]
        text_lower_full = text.lower()
        cutoff_idx = len(text)
        for marker in cutoff_markers:
            idx = text_lower_full.find(marker)
            if 0 < idx < cutoff_idx:
                cutoff_idx = idx
        if cutoff_idx < len(text):
            text = text[:cutoff_idx]

        text_lower = text.lower()
        matches = []
        for lname, player in _PLAYERS_BY_NAME.items():
            idx = text_lower.find(lname)
            if idx >= 0:
                matches.append((idx, player))
        matches.sort(key=lambda x: x[0])

        max_picks = 250
        pm = re.search(r'overall\s+pick\s+(\d+)', text_lower)
        if pm:
            max_picks = min(int(pm.group(1)) + 24, 250)

        for _, player in matches:
            name = player['name']
            if name not in found:
                found[name] = {'player': player, 'round': None}
            if len(found) >= max_picks:
                break

    if not found:
        print(f"[DK DOM] draft={draft_id} — no player names matched in {len(text)} chars")
        return jsonify({'ok': True, 'picks_found': 0, 'text_length': len(text)})

    # Build normalized picks (no pick_number since DOM order isn't reliable)
    picks = []
    for entry in found.values():
        player = entry['player']
        pick = {
            'player_name': player['name'],
            'player_id':   player.get('id', ''),   # direct ID so mobile skips name lookup
            'pick_number': None,
            'round':       entry['round'],           # parsed from pick cell (e.g. "1.99" → 1)
            'username':    'jvonderhoff' if my_picks else '',  # tag as user's pick if my_picks column
            'pos':         player.get('pos', ''),
            'team':        player.get('team', ''),
        }
        if column_idx is not None:
            pick['column_idx'] = int(column_idx)
        picks.append(pick)

    # Store in intercept cache
    id_str = draft_id
    if id_str not in _dk_intercept:
        _dk_intercept[id_str] = {'picks': [], 'raw_responses': [], 'updated_at': time.time(), 'sources': []}
    entry = _dk_intercept[id_str]

    if my_picks:
        # my_picks = only user's column — update username on any already-stored picks
        my_names = {p['player_name'].lower() for p in picks}
        for ep in entry['picks']:
            if ep['player_name'].lower() in my_names and not ep.get('username'):
                ep['username'] = 'jvonderhoff'
        # Add any not yet in the list
        existing_names = {p['player_name'].lower() for p in entry['picks']}
        new_picks = [p for p in picks if p['player_name'].lower() not in existing_names]
    else:
        # Per-column scan — update column_idx on existing picks, add new picks
        if column_idx is not None:
            col_names = {p['player_name'].lower() for p in picks}
            for ep in entry['picks']:
                if ep['player_name'].lower() in col_names and ep.get('column_idx') is None:
                    ep['column_idx'] = int(column_idx)
        existing_names = {p['player_name'].lower() for p in entry['picks']}
        new_picks = [p for p in picks if p['player_name'].lower() not in existing_names]
    entry['picks'] = entry['picks'] + new_picks
    entry['updated_at'] = time.time()
    entry['sources'].append('dom-text')
    entry['raw_responses'] = (entry['raw_responses'] + [{'url': 'dom-text', 'count': len(picks)}])[-5:]

    # Compute overall_pick: use max pick_number if available, else estimate from count
    numbered = [p.get('pick_number') or 0 for p in entry['picks'] if p.get('pick_number')]
    overall_pick = (max(numbered) + 1) if numbered else (len(entry['picks']) + 1)
    entry['overall_pick'] = overall_pick

    # Mirror to pick cache
    _dk_pick_cache[id_str] = {
        'picks': entry['picks'],
        'overall_pick': overall_pick,
        'updated_at': time.time(),
        'source': 'dom-text',
        'error': None,
    }

    print(f"[DK DOM] draft={draft_id} matched={len(picks)} new={len(new_picks)} total={len(entry['picks'])}")
    return jsonify({'ok': True, 'picks_found': len(picks), 'new_picks': len(new_picks), 'total': len(entry['picks'])})


@app.route('/api/dk-known-drafts', methods=['POST'])
def dk_known_drafts():
    """Register draft IDs found on the DK contests page (before the draft room is opened)."""
    body     = request.get_json(silent=True) or {}
    raw_ids  = body.get('draft_ids', [])
    added = []
    for raw_id in raw_ids:
        did = str(raw_id).strip()
        if not did:
            continue
        if did not in _dk_intercept and did not in _dk_known_drafts:
            _dk_known_drafts[did] = {'label': body.get('label', ''), 'registered_at': time.time()}
            added.append(did)
        elif did in _dk_known_drafts and body.get('label'):
            _dk_known_drafts[did]['label'] = body['label']
    print(f"[DK KNOWN] registered {len(added)} new draft IDs: {added}")
    return jsonify({'ok': True, 'added': added, 'total_known': len(_dk_known_drafts)})


@app.route('/api/drafts/list', methods=['GET'])
def drafts_list():
    """Return all draft IDs the server knows about, with their pick counts and recency."""
    drafts = []
    # Drafts with pick data
    for draft_id, entry in _dk_intercept.items():
        picks = entry.get('picks', [])
        updated = entry.get('updated_at', 0)
        age = round(time.time() - updated) if updated else None
        pos_counts = {}
        for p in picks:
            pos = p.get('pos', '?')
            pos_counts[pos] = pos_counts.get(pos, 0) + 1
        my_col = entry.get('my_column_idx')
        drafts.append({
            'draft_id':    draft_id,
            'pick_count':  len(picks),
            'overall_pick': entry.get('overall_pick', len(picks) + 1),
            'updated_at':  updated,
            'age_seconds': age,
            'pos_counts':  pos_counts,
            'label':       _dk_known_drafts.get(draft_id, {}).get('label', ''),
            'scanned':     True,
            'my_position': (my_col + 1) if my_col is not None else None,
            'num_teams':   12,
        })
    # Known drafts not yet scanned
    for draft_id, info in _dk_known_drafts.items():
        if draft_id not in _dk_intercept:
            drafts.append({
                'draft_id': draft_id,
                'pick_count': 0,
                'overall_pick': 1,
                'updated_at': info.get('registered_at'),
                'age_seconds': None,
                'pos_counts': {},
                'label': info.get('label', ''),
                'scanned': False,
            })
    # Sort by most recently updated
    drafts.sort(key=lambda d: d.get('updated_at') or 0, reverse=True)
    return jsonify({'drafts': drafts, 'total': len(drafts)})


@app.route('/api/dk-my-column', methods=['POST'])
def dk_my_column():
    """Store the 0-based column index of the user's own team (detected by DK CSS class)."""
    body     = request.get_json(silent=True) or {}
    draft_id = str(body.get('draft_id', '') or '').strip()
    col_idx  = body.get('my_column_idx')
    if not draft_id or col_idx is None:
        return jsonify({'ok': False, 'error': 'missing draft_id or my_column_idx'})
    col_idx = int(col_idx)
    if draft_id not in _dk_intercept:
        _dk_intercept[draft_id] = {'picks': [], 'raw_responses': [], 'updated_at': time.time(), 'sources': []}
    _dk_intercept[draft_id]['my_column_idx'] = col_idx
    # Backfill username on any picks already stored with this column_idx
    for pk in _dk_intercept[draft_id]['picks']:
        if pk.get('column_idx') == col_idx and not pk.get('username'):
            pk['username'] = 'jvonderhoff'
    print(f"[DK MY-COL] draft={draft_id} my_column_idx={col_idx} (position {col_idx + 1})")
    return jsonify({'ok': True, 'my_column_idx': col_idx, 'my_position': col_idx + 1})


@app.route('/api/dk-reset', methods=['POST', 'GET'])
def dk_reset():
    """Clear all stored picks for a draft so a fresh scan can rebuild the list."""
    draft_id = str(request.args.get('draft_id') or (request.get_json(silent=True) or {}).get('draft_id', '') or '').strip()
    if not draft_id:
        return jsonify({'ok': False, 'error': 'missing draft_id'})
    prev = len((_dk_intercept.get(draft_id) or {}).get('picks', []))
    _dk_intercept.pop(draft_id, None)
    _dk_pick_cache.pop(draft_id, None)
    print(f"[DK RESET] draft={draft_id} cleared {prev} picks")
    return jsonify({'ok': True, 'draft_id': draft_id, 'cleared': prev})


@app.route('/api/dk-ws-url', methods=['POST'])
def dk_ws_url():
    """Record a WebSocket URL captured when DK establishes a new WS connection."""
    body = request.get_json(silent=True) or {}
    url  = body.get('url', '')
    draft_id = str(body.get('draft_id', '') or '').strip()
    print(f"[DK WS URL] draft={draft_id} url={url}")
    return jsonify({'ok': True, 'ws_url': url})


@app.route('/api/dk-globals', methods=['POST'])
def dk_globals():
    """Receive window globals (React/__NEXT_DATA__/etc) captured from the DK draft page."""
    body = request.get_json(silent=True) or {}
    draft_id = str(body.get('draft_id', '') or '').strip()
    globals_ = body.get('globals', {})
    print(f"[DK globals] draft={draft_id} keys={list(globals_.keys())}")
    # Try to parse each global for pick data
    n_total = 0
    for k, v in globals_.items():
        try:
            data = json.loads(v) if isinstance(v, str) else v
            if isinstance(data, dict):
                n = _store_intercept(draft_id, f'global:{k}', data)
                n_total += n
        except Exception:
            pass
    return jsonify({'ok': True, 'picks_found': n_total})


@app.route('/api/dk-intercept/status', methods=['GET'])
def dk_intercept_status():
    """Return a summary of all drafts we have intercepted pick data for."""
    drafts = []
    for draft_id, entry in _dk_intercept.items():
        drafts.append({
            'draft_id':    draft_id,
            'pick_count':  len(entry.get('picks', [])),
            'updated_at':  entry.get('updated_at', 0),
            'sources':     entry.get('sources', [])[-3:],
            'raw_responses': entry.get('raw_responses', []),
        })
    drafts.sort(key=lambda x: x['updated_at'], reverse=True)
    return jsonify({'drafts': drafts})


@app.route('/api/dk-auth', methods=['POST'])
def dk_auth():
    """Receive DK cookie string + localStorage from the user's browser (bookmarklet/snippet)."""
    data = request.get_json(silent=True) or {}
    cookie = data.get('cookie', '').strip()
    ls_raw = data.get('ls') or data.get('storage') or '{}'

    if not cookie:
        return jsonify({'error': 'No cookie provided'}), 400

    # Parse localStorage for any JWT / auth tokens DK stores there
    try:
        ls = json.loads(ls_raw) if isinstance(ls_raw, str) else (ls_raw or {})
    except Exception:
        ls = {}

    # Build an augmented cookie string: start with document.cookie, then append
    # any JWT-like values found in localStorage as synthetic cookies so our
    # API calls can try them as Bearer tokens or extra cookie values.
    jwt_keys = [k for k, v in ls.items()
                if isinstance(v, str) and v.startswith('eyJ')]

    _dk_session['cookie'] = cookie
    _dk_session['ls_tokens'] = {k: ls[k] for k in jwt_keys}
    _dk_session['updated_at'] = time.time()
    _save_dk_session()

    cookie_keys = [p.split('=')[0].strip() for p in cookie.split(';') if '=' in p]
    return jsonify({
        'ok': True,
        'cookie_keys': cookie_keys,
        'ls_jwt_keys': jwt_keys,
    })


@app.route('/api/dk-auth/status', methods=['GET'])
def dk_auth_status():
    """Check whether we have DK cookies available (synced or local session)."""
    from app.data.api_fetcher import _synced_cookies
    if _synced_cookies:
        age = round(time.time() - (os.path.getmtime(_COOKIES_FILE) if os.path.exists(_COOKIES_FILE) else 0))
        return jsonify({'authenticated': True, 'age_seconds': age,
                        'cookie_keys': list(_synced_cookies.keys())[:5]})
    if _dk_session.get('cookie'):
        age = round(time.time() - (_dk_session['updated_at'] or 0))
        keys = [p.split('=')[0].strip() for p in _dk_session['cookie'].split(';') if '=' in p]
        return jsonify({'authenticated': True, 'age_seconds': age, 'cookie_keys': keys})
    return jsonify({'authenticated': False})


@app.route('/api/my-dk-drafts', methods=['GET'])
def my_dk_drafts():
    """Return the user's active/upcoming DK drafts.
    Priority: 1) user-saved draft IDs  2) direct API auto-discover via drafts/live
    """
    # Always include user-saved drafts (most reliable, persisted)
    saved = []
    for did, info in _saved_draft_ids.items():
        entry = {'id': did, 'name': info.get('name', f'Draft #{did}'), 'saved_at': info.get('saved_at')}
        # Enrich with cached pick data if available
        cache = _dk_pick_cache.get(str(did), {})
        if cache.get('overall_pick'):
            entry['overall_pick'] = cache['overall_pick']
            entry['pick_count'] = len(cache.get('picks', []))
            entry['updated_at'] = cache.get('updated_at')
            # Derive user's draft position from their round-1 pick number
            my_rd1 = next((p for p in (cache.get('picks') or [])
                           if p.get('round') == 1 and p.get('username') == 'jvonderhoff'), None)
            if my_rd1:
                entry['my_position'] = my_rd1.get('pick_number')
        saved.append(entry)
    saved.sort(key=lambda d: d.get('saved_at') or 0, reverse=True)
    if saved:
        return jsonify({'drafts': saved, 'source': 'saved'})

    # Auto-discover via direct API call
    from app.data.api_fetcher import fetch_my_dk_drafts
    drafts = fetch_my_dk_drafts()
    if drafts:
        # Auto-save discovered drafts so next call is instant
        for d in drafts:
            did = d['id']
            _saved_draft_ids[did] = {
                'name': d.get('name', f'Draft #{did}'),
                'entry_id': d.get('entry_id'),
                'saved_at': time.time(),
            }
        _persist_saved_drafts()
        return jsonify({'drafts': drafts, 'source': 'direct_api'})

    return jsonify({'drafts': [], 'source': 'none',
                    'message': 'No drafts found. Go to Setup and paste your DK draft URL.'})


@app.route('/api/dk-draft/queue/<draft_id>', methods=['POST'])
def dk_draft_queue(draft_id):
    """Add a player to the DK draft queue via direct API call."""
    from app.data.api_fetcher import _dk_session
    data = request.get_json(silent=True) or {}
    draftable_id = data.get('draftable_id')
    if not draftable_id:
        return jsonify({'error': 'draftable_id required'}), 400

    entry_id = (_saved_draft_ids.get(str(draft_id)) or {}).get('entry_id')
    if not entry_id:
        # Try getting it from pick cache
        cache = _dk_pick_cache.get(str(draft_id), {})
        my_picks = [p for p in cache.get('picks', []) if p.get('username') == 'jvonderhoff']
        # entry_id not directly in cache - fall back to live drafts
        if not entry_id:
            from app.data.api_fetcher import _load_user_guid
            guid = _load_user_guid()
            if guid:
                session = _dk_session(referer=f'https://www.draftkings.com/draft/snake/{draft_id}')
                if session:
                    try:
                        r = session.get(f'https://api.draftkings.com/drafts/v1/users/{guid}/drafts/live?format=json', timeout=10)
                        if r.ok:
                            for ud in r.json().get('userDrafts', []):
                                if str(ud.get('contestId')) == str(draft_id):
                                    entry_id = str(ud.get('entryId', ''))
                                    _saved_draft_ids[str(draft_id)]['entry_id'] = entry_id
                                    _persist_saved_drafts()
                                    break
                    except Exception:
                        pass

    if not entry_id:
        return jsonify({'error': 'Could not find entry_id for this draft'}), 400

    session = _dk_session(referer=f'https://www.draftkings.com/draft/snake/{draft_id}')
    if not session:
        return jsonify({'error': 'No DK cookies — run sync_cookies.py'}), 401

    try:
        url = f'https://api.draftkings.com/drafts/v1/snake/{draft_id}/entries/{entry_id}/draftPreferences/queue/players?format=json'
        r = session.post(url, json={'draftableId': int(draftable_id)}, timeout=10)
        if r.ok:
            return jsonify({'ok': True, 'response': r.json()})
        return jsonify({'error': f'DK returned {r.status_code}', 'body': r.text[:200]}), r.status_code
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/dk-draft/pull/<draft_id>', methods=['POST'])
def dk_draft_pull(draft_id):
    """Fetch current picks via direct DK API calls."""
    from app.data.api_fetcher import fetch_dk_draft_picks

    # entry_id stored when draft was saved/discovered
    entry_id = (_saved_draft_ids.get(str(draft_id)) or {}).get('entry_id')

    result = fetch_dk_draft_picks(draft_id, entry_id=entry_id)
    if result:
        picks       = result.get('picks', [])
        my_position = result.get('my_position')
        _dk_pick_cache[str(draft_id)] = {
            'picks': picks,
            'overall_pick': max((p.get('pick_number') or 0 for p in picks), default=0) + 1,
            'updated_at': time.time(),
            'source': 'direct_api',
            'my_position': my_position,
            'error': None,
        }
        resp = {
            'draft_id':    draft_id,
            'picks':       picks,
            'pick_count':  len(picks),
            'overall_pick': _dk_pick_cache[str(draft_id)]['overall_pick'],
            'source':      'direct_api',
            'error':       None,
            'updated_at':  _dk_pick_cache[str(draft_id)]['updated_at'],
        }
        if my_position:
            resp['my_position'] = my_position
        return jsonify(resp)

    # Strategy 2 — requests with stored cookies (may fail on HttpOnly-gated endpoints)
    if _dk_session.get('cookie'):
        _fetch_dk_draft(draft_id)
        cached = _dk_pick_cache.get(str(draft_id), {})
        picks = cached.get('picks', [])
        if picks:
            return jsonify({
                'draft_id':    draft_id,
                'picks':       picks,
                'pick_count':  len(picks),
                'overall_pick': cached.get('overall_pick', 1),
                'source':      cached.get('source'),
                'error':       None,
                'updated_at':  cached.get('updated_at'),
            })

    return jsonify({
        'draft_id':  draft_id,
        'picks':     [],
        'pick_count': 0,
        'error':     'Could not fetch picks — make sure Firefox is open and logged in to DraftKings',
        'needs_auth': True,
    }), 200


@app.route('/setup')
def setup_page():
    return render_template('setup.html')


@app.route('/api/dk-draft/refresh-from-dk', methods=['POST'])
def refresh_drafts_from_dk():
    """Auto-discover all current live drafts from DK and add any new ones."""
    from app.data.api_fetcher import fetch_my_dk_drafts
    drafts = fetch_my_dk_drafts()
    if not drafts:
        return jsonify({'ok': False, 'error': 'Could not reach DraftKings — check auth'}), 400
    added = []
    for d in drafts:
        did = str(d['id'])
        if did not in _saved_draft_ids:
            _saved_draft_ids[did] = {
                'name': d.get('name', f'Draft #{did}'),
                'entry_id': d.get('entry_id'),
                'saved_at': time.time(),
            }
            added.append(did)
        else:
            # Update entry_id if we now have it
            if d.get('entry_id'):
                _saved_draft_ids[did]['entry_id'] = d['entry_id']
    _persist_saved_drafts()
    return jsonify({'ok': True, 'total': len(drafts), 'added': added})


# ── Saved draft IDs (user-entered, persisted to disk) ─────────────────────────
_SAVED_DRAFTS_FILE = os.path.join(basedir, '.saved_drafts.json')
_saved_draft_ids = {}   # draft_id -> {name, saved_at}

def _load_saved_drafts():
    # 1 — disk file
    try:
        if os.path.exists(_SAVED_DRAFTS_FILE):
            with open(_SAVED_DRAFTS_FILE) as f:
                data = json.load(f)
            _saved_draft_ids.update(data)
            print(f'[Drafts] Loaded {len(_saved_draft_ids)} saved draft IDs from disk')
            return
    except Exception as e:
        print(f'[Drafts] Disk load error: {e}')
    # 2 — environment variable
    env_drafts = os.environ.get('DK_SAVED_DRAFTS', '')
    if env_drafts:
        try:
            data = json.loads(env_drafts)
            _saved_draft_ids.update(data)
            print(f'[Drafts] Loaded {len(_saved_draft_ids)} saved draft IDs from env var')
        except Exception as e:
            print(f'[Drafts] Env var parse error: {e}')

def _persist_saved_drafts():
    try:
        with open(_SAVED_DRAFTS_FILE, 'w') as f:
            json.dump(_saved_draft_ids, f)
    except Exception as e:
        print(f'[Drafts] Could not save drafts: {e}')

_load_saved_drafts()


@app.route('/api/dk-draft/save-id', methods=['POST'])
def save_draft_id():
    """Save a user-supplied draft ID (from DK notification URL) persistently."""
    data = request.get_json(silent=True) or {}
    raw = str(data.get('draft_id') or data.get('url') or '').strip()
    if not raw:
        return jsonify({'error': 'draft_id required'}), 400
    # Accept a full URL like https://www.draftkings.com/draft/snake/12345678
    import re as _re
    m = _re.search(r'(\d{6,})', raw)
    if not m:
        return jsonify({'error': 'Could not find a draft ID (6+ digit number) in the input'}), 400
    draft_id = m.group(1)
    name = data.get('name') or f'Draft #{draft_id}'
    _saved_draft_ids[draft_id] = {'name': name, 'saved_at': time.time()}
    _persist_saved_drafts()
    print(f'[Drafts] Saved draft ID {draft_id} — {name}')
    return jsonify({'ok': True, 'draft_id': draft_id, 'name': name})


@app.route('/api/dk-draft/saved-ids', methods=['GET'])
def get_saved_draft_ids():
    """Return all user-saved draft IDs."""
    drafts = [
        {'id': did, 'name': info.get('name', f'Draft #{did}'), 'saved_at': info.get('saved_at')}
        for did, info in _saved_draft_ids.items()
    ]
    drafts.sort(key=lambda d: d.get('saved_at') or 0, reverse=True)
    return jsonify({'drafts': drafts})


@app.route('/api/dk-draft/delete-id/<draft_id>', methods=['DELETE'])
def delete_saved_draft_id(draft_id):
    """Remove a user-saved draft ID."""
    _saved_draft_ids.pop(str(draft_id), None)
    _persist_saved_drafts()
    return jsonify({'ok': True})


@app.route('/api/dk-draft-state/<draft_id>', methods=['GET'])
def dk_draft_state_proxy(draft_id):
    """
    Return current pick state for a DK draft.
    Priority: 1) bookmarklet intercept cache  2) cookie-proxy cache  3) fresh proxy fetch
    """
    id_str = str(draft_id)

    def _num_teams_from_picks(picks):
        """Infer draft size from the highest pick_number in round 1."""
        rd1 = [p.get('pick_number') or 0 for p in picks if (p.get('round') or 0) == 1]
        return max(rd1) if len(rd1) >= 4 else None

    # 1. Check intercept cache (bookmarklet running on DK page) — preferred
    intercepted = _dk_intercept.get(id_str)
    if intercepted and intercepted.get('picks'):
        age = time.time() - intercepted.get('updated_at', 0)
        picks = intercepted['picks']
        resp = {
            'draft_id':    draft_id,
            'picks':       picks,
            'overall_pick': intercepted.get('overall_pick', 1),
            'updated_at':  intercepted.get('updated_at'),
            'source':      'bookmarklet_intercept',
            'age_seconds': round(age),
            'error':       None,
            'pick_count':  len(picks),
            'num_teams':   intercepted.get('num_teams') or _num_teams_from_picks(picks),
        }
        if intercepted.get('my_column_idx') is not None:
            resp['my_column_idx'] = intercepted['my_column_idx']
            resp['my_position']   = intercepted['my_column_idx'] + 1
        return jsonify(resp)

    # 2. Check cookie-proxy cache (old approach, fallback)
    cached = _dk_pick_cache.get(id_str, {})
    if cached.get('picks'):
        picks = cached['picks']
        resp = {
            'draft_id':    draft_id,
            'picks':       picks,
            'overall_pick': cached.get('overall_pick', 1),
            'updated_at':  cached.get('updated_at'),
            'source':      cached.get('source', 'cookie_proxy'),
            'error':       None,
            'pick_count':  len(picks),
            'num_teams':   _num_teams_from_picks(picks),
        }
        if cached.get('my_position'):
            resp['my_position'] = cached['my_position']
        return jsonify(resp)

    # 3. No data yet — tell client to run bookmarklet
    debug = {
        'intercept_raw': (intercepted or {}).get('raw_responses', []),
        'cache_raw_keys': cached.get('raw_keys'),
    }
    return jsonify({
        'draft_id':    draft_id,
        'picks':       [],
        'overall_pick': 1,
        'updated_at':  None,
        'source':      None,
        'error':       'No pick data yet — tap BBA Live bookmarklet on your DK draft page.',
        'needs_bookmarklet': True,
        'pick_count':  0,
        'debug':       debug,
    })


# ── Live draft state (pushed from desktop extension) ─────────────────────────
# Holds the latest push per draft_id.  Keyed by dk draft ID string.
_live_drafts = {}  # { draft_id: { overall_pick, my_position, num_teams, my_team, taken_ids, updated_at } }


@app.route('/api/live-draft/push', methods=['POST'])
def live_draft_push():
    """Receive a state snapshot from the desktop extension content script."""
    data = request.get_json(silent=True) or {}
    draft_id = str(data.get('draft_id', '')).strip()
    if not draft_id:
        return jsonify({'error': 'draft_id required'}), 400
    import time
    raw_taken = data.get('taken_ids', [])
    _live_drafts[draft_id] = {
        'draft_id':    draft_id,
        'overall_pick': int(data.get('overall_pick', 1)),
        'my_position':  data.get('my_position'),
        'num_teams':    int(data.get('num_teams', 12)),
        'my_team':      data.get('my_team', []),
        'taken_ids':    raw_taken,
        'updated_at':   time.time(),
    }

    # ── Merge extension taken_ids into _dk_intercept ───────────────────────────
    # The extension sends DK-internal player IDs (e.g. 42775000).
    # Our player index uses "dk_42775000" format — just prepend "dk_" to match.
    # This supplements the DOM scan for picks it may have missed (name format issues).
    if raw_taken and _PLAYERS_BY_ID:
        id_str = draft_id
        if id_str not in _dk_intercept:
            _dk_intercept[id_str] = {'picks': [], 'raw_responses': [], 'updated_at': time.time(), 'sources': []}
        entry = _dk_intercept[id_str]
        existing_ids = {p.get('player_id', '') for p in entry['picks']}
        new_picks = []
        for raw_id in raw_taken:
            dk_id = f"dk_{raw_id}" if not str(raw_id).startswith('dk_') else str(raw_id)
            if dk_id in existing_ids:
                continue
            player = _PLAYERS_BY_ID.get(dk_id)
            if player:
                new_picks.append({
                    'player_name': player['name'],
                    'player_id':   dk_id,
                    'pick_number': None,
                    'username':    '',
                    'pos':         player.get('pos', ''),
                    'team':        player.get('team', ''),
                })
        if new_picks:
            entry['picks'].extend(new_picks)
            entry['updated_at'] = time.time()
            entry['sources'].append('extension')
            numbered = [p.get('pick_number') or 0 for p in entry['picks'] if p.get('pick_number')]
            entry['overall_pick'] = (max(numbered) + 1) if numbered else (len(entry['picks']) + 1)
            print(f"[EXT MERGE] draft={draft_id} added {len(new_picks)} missing picks, total={len(entry['picks'])}")

    return jsonify({'ok': True})


@app.route('/api/live-draft/state', methods=['GET'])
def live_draft_state():
    """Return latest state for a given draft_id (polled by mobile /recommend page)."""
    import time
    draft_id = request.args.get('draft_id', '').strip()
    if draft_id:
        entry = _live_drafts.get(draft_id)
    else:
        # No specific ID requested — return the most recently updated draft
        entry = max(_live_drafts.values(), key=lambda x: x['updated_at'], default=None)

    if not entry:
        return jsonify({'connected': False})

    age = time.time() - entry['updated_at']
    return jsonify({
        'connected':    age < 60,   # stale after 60 s of no pushes
        'age_seconds':  round(age),
        **entry,
    })


@app.route('/api/live-draft/list', methods=['GET'])
def live_draft_list():
    """List all active (recently updated) draft IDs."""
    import time
    now = time.time()
    active = [
        {'draft_id': v['draft_id'], 'age_seconds': round(now - v['updated_at'])}
        for v in _live_drafts.values()
        if now - v['updated_at'] < 300
    ]
    active.sort(key=lambda x: x['age_seconds'])
    return jsonify(active)


# ── Mobile recommender ────────────────────────────────────────────────────────

@app.route('/recommend')
def recommend_page():
    return render_template('recommend.html')


@app.route('/api/players', methods=['GET'])
def get_players():
    """Return all players — from player_cache.json (primary) or players.js (legacy extension file)."""
    import re
    # Primary: player_cache.json committed to repo
    cache_path = os.path.join(basedir, 'data', 'player_cache.json')
    try:
        with open(cache_path) as f:
            data = json.load(f)
        players = data if isinstance(data, list) else data.get('players', [])
        if players:
            return jsonify(players)
    except Exception:
        pass
    # Fallback: legacy extension players.js
    players_js = os.path.normpath(os.path.join(basedir, '..', 'best-ball-extension', 'players.js'))
    try:
        with open(players_js) as f:
            content = f.read()
        m = re.search(r'const PLAYERS\s*=\s*(\[.*\]);', content, re.DOTALL)
        if m:
            return jsonify(json.loads(m.group(1)))
    except Exception:
        pass
    return jsonify({'error': 'No player data found'}), 404


# ── Analysis ──────────────────────────────────────────────────────────────────

@app.route('/analysis')
def analysis_page():
    return render_template('analysis.html')


@app.route('/api/analysis', methods=['GET'])
def get_analysis():
    try:
        from app.analysis import get_analysis_data
        force = request.args.get('refresh', '').lower() in ('1', 'true', 'yes')
        players = get_analysis_data(force_refresh=force)
        return jsonify({'ok': True, 'players': players, 'count': len(players)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Cookie sync (Mac → Render) ─────────────────────────────────────────────────
_COOKIES_FILE = os.path.join(basedir, '.synced_cookies.json')

def _load_synced_cookies():
    """
    Load DK cookies into api_fetcher on startup.
    Priority: 1) disk file (written by /api/sync-cookies)
              2) DK_COOKIES environment variable (persists across Render deploys)
    """
    from app.data.api_fetcher import set_synced_cookies, _save_user_guid

    # 1 — disk file
    try:
        if os.path.exists(_COOKIES_FILE):
            with open(_COOKIES_FILE) as f:
                cookies = json.load(f)
            if cookies:
                set_synced_cookies(cookies)
                print(f'[Cookies] Loaded {len(cookies)} DK cookies from disk')
                return
    except Exception as e:
        print(f'[Cookies] Disk load error: {e}')

    # 2 — environment variable (survives Render redeploys)
    env_cookies = os.environ.get('DK_COOKIES', '')
    if env_cookies:
        try:
            cookies = json.loads(env_cookies)
            if cookies:
                set_synced_cookies(cookies)
                print(f'[Cookies] Loaded {len(cookies)} DK cookies from DK_COOKIES env var')
        except Exception as e:
            print(f'[Cookies] Env var parse error: {e}')

    # Also restore GUID from env var
    env_guid = os.environ.get('DK_USER_GUID', '')
    if env_guid:
        _save_user_guid(env_guid)
        print(f'[Cookies] Restored GUID from DK_USER_GUID env var')

_load_synced_cookies()


@app.route('/api/sync-cookies', methods=['POST'])
def sync_cookies():
    """
    Accept DK cookies pushed from the Mac (via sync_cookies.py).
    Protected by BBA_API_KEY env var — set this in Render's environment.
    """
    api_key = request.headers.get('X-Api-Key') or (request.json or {}).get('api_key', '')
    expected = os.environ.get('BBA_API_KEY', '')
    if expected and api_key != expected:
        return jsonify({'error': 'Unauthorized'}), 401

    body = request.json or {}
    cookies = body.get('cookies', {})
    if not cookies:
        return jsonify({'error': 'No cookies provided'}), 400

    # Push cookies into api_fetcher and persist to disk
    from app.data.api_fetcher import set_synced_cookies
    set_synced_cookies(cookies)
    try:
        with open(_COOKIES_FILE, 'w') as f:
            json.dump(cookies, f)
    except Exception as e:
        print(f'[Cookies] Could not persist cookies: {e}')
    print(f'[Cookies] Synced {len(cookies)} DK cookies')

    # Sync GUID if provided
    guid = body.get('guid', '')
    if guid:
        from app.data.api_fetcher import _save_user_guid
        _save_user_guid(guid)
        print(f'[Cookies] Synced user GUID: {guid[:8]}…')

    # Sync saved draft IDs if provided
    synced_drafts = body.get('saved_drafts', {})
    if synced_drafts:
        for did, info in synced_drafts.items():
            if did not in _saved_draft_ids:
                _saved_draft_ids[did] = info
        _persist_saved_drafts()
        print(f'[Cookies] Synced {len(synced_drafts)} saved draft ID(s)')

    return jsonify({'ok': True, 'count': len(cookies)})


@app.route('/api/db/download', methods=['GET'])
def download_db():
    """Download the live drafts.db — protected by BBA_API_KEY."""
    from flask import send_file
    api_key = request.headers.get('X-Api-Key') or request.args.get('api_key', '')
    expected = os.environ.get('BBA_API_KEY', '')
    if expected and api_key != expected:
        return jsonify({'error': 'Unauthorized'}), 401
    db_path = os.path.join(basedir, 'drafts.db')
    return send_file(db_path, as_attachment=True, download_name='drafts.db',
                     mimetype='application/x-sqlite3')


@app.route('/api/sync-cookies/status', methods=['GET'])
def sync_cookies_status():
    """Check whether cookies have been synced and how many."""
    from app.data.api_fetcher import _synced_cookies
    return jsonify({
        'synced': bool(_synced_cookies),
        'count': len(_synced_cookies),
    })


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    app.run(host='0.0.0.0', port=port)


@app.route('/api/dk-probe/<draft_id>')
def dk_probe(draft_id):
    """Debug: try many DK endpoints and return raw status + first 500 chars of each."""
    if not _dk_session.get('cookie'):
        return jsonify({'error': 'not authenticated — run bookmarklet first'}), 401
    h = _dk_headers()
    results = []
    endpoints = [
        # ── Snake draft specific (www.draftkings.com) ──
        f'https://www.draftkings.com/draft/snake/{draft_id}/picks',
        f'https://www.draftkings.com/draft/snake/{draft_id}/state',
        f'https://www.draftkings.com/api/draft/snake/{draft_id}',
        f'https://www.draftkings.com/api/snake/{draft_id}/picks',
        f'https://www.draftkings.com/api/snake/draft/{draft_id}/board',
        f'https://www.draftkings.com/api/lineup/getpicks?draftGroupId={draft_id}',
        f'https://www.draftkings.com/lineup/getpicks?draftGroupId={draft_id}',
        # ── api.draftkings.com endpoints ──
        f'https://api.draftkings.com/lineups/v1/draftselections?draftGroupId={draft_id}',
        f'https://api.draftkings.com/draft/v1/draftgroups/{draft_id}/draftboard',
        f'https://api.draftkings.com/draft/v1/draftgroups/{draft_id}/selections',
        f'https://api.draftkings.com/draftgroups/v2/draftgroups/{draft_id}',
        f'https://api.draftkings.com/lineups/v1/lineups?draftGroupId={draft_id}',
        f'https://api.draftkings.com/entries/v1/entries?draftGroupId={draft_id}',
        # ── User context (no draft_id) ──
        'https://api.draftkings.com/entries/v1/entries?sport=1',
        'https://www.draftkings.com/mycontests',
    ]
    for url in endpoints:
        try:
            r = req_lib.get(url, headers=h, timeout=8, allow_redirects=False)
            path = url.split('draftkings.com')[1] if 'draftkings.com' in url else url
            if r.status_code == 200:
                try:
                    j = r.json()
                    body = json.dumps(j)[:600]
                except Exception:
                    body = r.text[:300]
            else:
                body = r.text[:150]
            results.append({'url': path, 'status': r.status_code, 'body': body})
        except Exception as e:
            results.append({'url': url, 'status': 'err', 'body': str(e)})
    return jsonify(results)
