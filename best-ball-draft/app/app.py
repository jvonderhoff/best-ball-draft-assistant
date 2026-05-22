from flask import Flask, render_template, jsonify, request
from flask_cors import CORS
from app.draft import DraftState
from app.database import init_db, save_draft, get_all_drafts, get_exposure, delete_draft, get_rankings, save_rankings
import json
import os

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
