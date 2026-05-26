from flask import Flask, render_template, jsonify, request, redirect, url_for
from flask_cors import CORS
from app.draft import DraftState
from app.database import init_db, save_draft, get_all_drafts, get_exposure, delete_draft, get_rankings, save_rankings, save_props, get_all_props
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
CORS(app)

init_db()
draft_state = DraftState()


@app.route('/')
def index():
    return redirect(url_for('analysis_page'))

@app.route('/draft')
def draft():
    return render_template('index.html')


@app.route('/history')
def history():
    return render_template('history.html')


# ── Draft state ───────────────────────────────────────────────────────────────

@app.route('/api/draft/state', methods=['GET'])
def get_draft_state():
    exposure = get_exposure()
    draft_state._exposure = exposure.get('players', {})
    state = draft_state.get_draft_state()
    state['available_players'] = draft_state.get_available_players()
    state['exposure'] = exposure
    return jsonify(state)


@app.route('/api/draft/setup', methods=['POST'])
def setup_draft():
    global draft_state
    data = request.get_json()
    num_teams  = int(data.get('num_teams', 12))
    my_position = int(data.get('my_position', 1))
    draft_state = DraftState()
    draft_state.setup(num_teams, my_position)
    return jsonify({'success': True, 'draft_state': draft_state.get_draft_state()})


@app.route('/api/draft/pick/<player_id>', methods=['POST'])
def pick_player(player_id):
    try:
        if draft_state.is_draft_complete():
            return jsonify({'error': 'Draft already complete'}), 400
        player = draft_state.draft_player(player_id)
        return jsonify({'success': True, 'player': player, 'draft_state': draft_state.get_draft_state()})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/draft/taken/<player_id>', methods=['POST'])
def mark_taken(player_id):
    try:
        player = draft_state.mark_taken(player_id)
        return jsonify({'success': True, 'player': player, 'draft_state': draft_state.get_draft_state()})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/draft/autopick', methods=['GET'])
def get_autopick():
    try:
        if draft_state.is_draft_complete():
            return jsonify({'error': 'Draft already complete'}), 400
        suggestion = draft_state.get_autopick_suggestion()
        if suggestion:
            return jsonify({'player': suggestion['player'], 'reason': suggestion['reason']})
        return jsonify({'error': 'No players available'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/draft/reset', methods=['POST'])
def reset_draft():
    global draft_state
    draft_state = DraftState()
    return jsonify({'success': True})


# ── Draft history ─────────────────────────────────────────────────────────────

@app.route('/api/drafts/save', methods=['POST'])
def save_draft_route():
    data = request.get_json()
    try:
        draft_id = save_draft(
            num_teams   = draft_state.num_teams,
            my_position = draft_state.my_position,
            picks       = draft_state.my_team,
            contest     = data.get('contest', ''),
            dk_draft_id = data.get('dk_draft_id'),
        )
        if draft_id is None:
            return jsonify({'success': True, 'draft_id': None, 'duplicate': True})
        return jsonify({'success': True, 'draft_id': draft_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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

@app.route('/api/search-players', methods=['GET'])
def search_players():
    query      = request.args.get('q', '').lower()
    pos_filter = request.args.get('pos', '').upper()
    results    = draft_state.get_available_players()
    if pos_filter:
        results = [p for p in results if p['pos'] == pos_filter]
    if query:
        results = [p for p in results if query in p['name'].lower() or query in p['team'].lower()]
    results.sort(key=lambda p: p['adp'])
    return jsonify(results[:50])


@app.route('/api/players/refresh', methods=['POST'])
def refresh_players():
    global draft_state
    try:
        from app.data.api_fetcher import fetch_players
        players = fetch_players(force_refresh=True)
        draft_state = DraftState()
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


# ── DK cookie store & proxy ───────────────────────────────────────────────────
# Stores the last cookie string the user sent from their DK browser session.
_dk_session = {
    'cookie': None,       # raw Cookie header string
    'updated_at': None,
}
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
    if _dk_session['cookie']:
        h['Cookie'] = _dk_session['cookie']
    if extra:
        h.update(extra)
    return h


def _parse_picks_from_response(data):
    """Extract a flat list of {player_name, pos, team, pick_number, username} from any DK API shape."""
    candidates = [
        data.get('picks'), data.get('draftPicks'), data.get('selections'),
        data.get('draftSelections'),
        (data.get('data') or {}).get('picks'),
        (data.get('payload') or {}).get('picks'),
        (data.get('draft') or {}).get('picks'),
        data.get('entries'), data.get('roster'),
    ]
    for lst in candidates:
        if not isinstance(lst, list) or not lst:
            continue
        first = lst[0]
        # Must look like a pick object
        if not any(k in first for k in ('displayName', 'firstName', 'playerName',
                                         'name', 'lastName')):
            continue
        picks = []
        for p in lst:
            name = (p.get('displayName') or
                    f"{p.get('firstName','')} {p.get('lastName','')}".strip() or
                    p.get('playerName') or p.get('name') or '')
            picks.append({
                'player_name': name,
                'pick_number':  p.get('pickNumber') or p.get('pick_number') or p.get('overallPickNumber'),
                'username':     (p.get('username') or p.get('entryName') or
                                 p.get('teamName') or p.get('draftTeamName') or ''),
                'pos':  p.get('position') or p.get('pos') or '',
                'team': p.get('teamAbbreviation') or p.get('team') or '',
            })
        return picks
    return None


def _fetch_dk_draft(draft_id):
    """
    Try multiple DK endpoints and return raw picks list, or None on failure.
    Stores result in _dk_pick_cache[draft_id].
    """
    id_str = str(draft_id)
    endpoints = [
        f'https://api.draftkings.com/lineups/v1/lineups?draftGroupId={id_str}',
        f'https://api.draftkings.com/lineups/v2/lineups?draftGroupId={id_str}',
        f'https://api.draftkings.com/draftgroups/v1/draftgroups/{id_str}',
        f'https://api.draftkings.com/draftgroups/v2/draftgroups/{id_str}',
        f'https://api.draftkings.com/draft/v1/draftgroups/{id_str}',
    ]
    h = _dk_headers()
    last_status = None
    for url in endpoints:
        try:
            r = req_lib.get(url, headers=h, timeout=10)
            last_status = r.status_code
            if r.status_code != 200:
                continue
            data = r.json()

            # Try to extract picks
            picks = _parse_picks_from_response(data)
            if picks is not None:
                _dk_pick_cache[id_str] = {
                    'picks': picks,
                    'overall_pick': max((p.get('pick_number') or 0 for p in picks), default=0) + 1,
                    'updated_at': time.time(),
                    'source': url,
                    'error': None,
                }
                return picks

            # Even without picks, store metadata
            _dk_pick_cache[id_str] = _dk_pick_cache.get(id_str) or {}
            _dk_pick_cache[id_str].update({'updated_at': time.time(), 'source': url})

        except Exception as e:
            last_status = f'err:{e}'
            continue

    # No successful endpoint found
    if id_str not in _dk_pick_cache:
        _dk_pick_cache[id_str] = {}
    _dk_pick_cache[id_str]['error'] = f'All endpoints failed (last status: {last_status})'
    _dk_pick_cache[id_str]['updated_at'] = time.time()
    return None


@app.route('/api/dk-auth', methods=['POST'])
def dk_auth():
    """Receive DK cookie string from the user's browser (bookmarklet/snippet)."""
    data = request.get_json(silent=True) or {}
    cookie = data.get('cookie', '').strip()
    if not cookie:
        return jsonify({'error': 'No cookie provided'}), 400
    _dk_session['cookie'] = cookie
    _dk_session['updated_at'] = time.time()
    # Show which readable tokens we got
    keys = [part.split('=')[0].strip() for part in cookie.split(';') if '=' in part]
    return jsonify({'ok': True, 'cookie_keys': keys})


@app.route('/api/dk-auth/status', methods=['GET'])
def dk_auth_status():
    """Check whether we have a DK cookie stored."""
    if not _dk_session['cookie']:
        return jsonify({'authenticated': False})
    age = round(time.time() - (_dk_session['updated_at'] or 0))
    keys = [p.split('=')[0].strip() for p in _dk_session['cookie'].split(';') if '=' in p]
    return jsonify({'authenticated': True, 'age_seconds': age, 'cookie_keys': keys})


@app.route('/api/dk-draft-state/<draft_id>', methods=['GET'])
def dk_draft_state_proxy(draft_id):
    """
    Fetch current pick state for a DK snake draft.
    Returns picks + metadata suitable for the /recommend page.
    """
    if not _dk_session['cookie']:
        return jsonify({'error': 'Not authenticated — send DK cookie first', 'needs_auth': True}), 401

    picks = _fetch_dk_draft(draft_id)
    cached = _dk_pick_cache.get(str(draft_id), {})

    return jsonify({
        'draft_id': draft_id,
        'picks': picks or [],
        'overall_pick': cached.get('overall_pick', 1),
        'updated_at': cached.get('updated_at'),
        'source': cached.get('source'),
        'error': cached.get('error'),
        'pick_count': len(picks) if picks else 0,
    })


@app.route('/dk-setup')
def dk_setup():
    """Setup page: shows user how to send their DK cookie to Flask."""
    return render_template('dk_setup.html')


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
    _live_drafts[draft_id] = {
        'draft_id':    draft_id,
        'overall_pick': int(data.get('overall_pick', 1)),
        'my_position':  data.get('my_position'),
        'num_teams':    int(data.get('num_teams', 12)),
        'my_team':      data.get('my_team', []),
        'taken_ids':    data.get('taken_ids', []),
        'updated_at':   time.time(),
    }
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
    """Return all players from players.js (the extension's player cache)."""
    import re
    players_js = os.path.join(basedir, '..', 'best-ball-extension', 'players.js')
    players_js = os.path.normpath(players_js)
    try:
        with open(players_js) as f:
            content = f.read()
        m = re.search(r'const PLAYERS\s*=\s*(\[.*\]);', content, re.DOTALL)
        if not m:
            return jsonify({'error': 'Could not parse players.js'}), 500
        players = json.loads(m.group(1))
        return jsonify(players)
    except FileNotFoundError:
        return jsonify({'error': 'players.js not found — run generate_players.py'}), 404


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


if __name__ == '__main__':
    app.run(debug=True, port=5000)
