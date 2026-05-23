"""
Player analysis module.
Pulls from the Sleeper API:
  - 2025 actual season stats (performance baseline)
  - 2026 season projections (market consensus expectation)
Combines with our 2026 DK ADP + playoff schedule data to produce:
  - Composite "season potential" score
  - Market delta: where projections say a player should go vs their DK ADP
Scoring is full PPR.
"""
import re
import requests
from app.database import get_db, get_all_props
from app.data.betting_fetcher import props_to_fantasy_pts

SLEEPER_STATS_URL       = 'https://api.sleeper.app/v1/stats/nfl/regular/2025'
SLEEPER_PLAYERS_URL     = 'https://api.sleeper.app/v1/players/nfl'
SLEEPER_PROJ_URL        = 'https://api.sleeper.app/v1/projections/nfl/regular/2026'
SKILL_POSITIONS = {'QB', 'RB', 'WR', 'TE'}

_sleeper_cache = {}   # module-level cache so we only fetch once per process


def _normalize(name: str) -> str:
    """Lowercase, strip punctuation/suffixes for fuzzy name matching."""
    name = name.lower()
    name = re.sub(r"['\-\.]", '', name)
    name = re.sub(r'\s+(jr|sr|ii|iii|iv|v)\s*$', '', name)
    return name.strip()


def _fetch_sleeper():
    """Return (stats_dict, meta_dict, projections_dict) from Sleeper API, cached."""
    if _sleeper_cache:
        return (_sleeper_cache.get('stats', {}),
                _sleeper_cache.get('meta', {}),
                _sleeper_cache.get('projections', {}))
    try:
        rs = requests.get(SLEEPER_STATS_URL,   timeout=12)
        rm = requests.get(SLEEPER_PLAYERS_URL,  timeout=20)
        rp = requests.get(SLEEPER_PROJ_URL,     timeout=20)
        stats       = rs.json() if rs.ok else {}
        meta        = rm.json() if rm.ok else {}
        projections = rp.json() if rp.ok else {}
        # Filter meta to skill positions only
        meta = {k: v for k, v in meta.items()
                if v.get('position') in SKILL_POSITIONS}
        _sleeper_cache['stats']       = stats
        _sleeper_cache['meta']        = meta
        _sleeper_cache['projections'] = projections
        print(f'  [Analysis] Sleeper stats: {len(stats)} rows | '
              f'players: {len(meta)} skill | projections: {len(projections)}')
    except Exception as e:
        print(f'  [Analysis] Sleeper fetch error: {e}')
        stats, meta, projections = {}, {}, {}
    return stats, meta, projections


def _build_sleeper_lookup(stats, meta):
    """
    Build a normalized-name → stat dict for quick lookups.
    Only includes players with meaningful fantasy points.
    Also returns a sleeper_id → name_key mapping for projection matching.
    """
    lookup = {}
    id_to_key = {}
    for pid, m in meta.items():
        s = stats.get(pid, {})
        pts = s.get('pts_ppr') or 0
        gp  = s.get('gp') or 0
        if pts < 10:   # skip kickers, practice squad, etc.
            continue
        name_key = _normalize(m.get('full_name') or m.get('search_full_name') or '')
        if not name_key:
            continue
        obj = {
            'sleeper_id':  pid,
            'pts_ppr':     round(float(pts), 1),
            'gp':          int(gp),
            'rush_yd':     int(s.get('rush_yd') or 0),
            'rush_td':     int(s.get('rush_td') or 0),
            'rec_yd':      int(s.get('rec_yd') or 0),
            'rec_td':      int(s.get('rec_td') or 0),
            'rec':         int(s.get('rec') or 0),
            'pass_yd':     int(s.get('pass_yd') or 0),
            'pass_td':     int(s.get('pass_td') or 0),
            'pass_int':    int(s.get('pass_int') or 0),
            'pos_rank':    int(s.get('pos_rank_half_ppr') or 999),
        }
        # If a name appears twice, keep the higher-scoring one
        if name_key not in lookup or obj['pts_ppr'] > lookup[name_key]['pts_ppr']:
            lookup[name_key] = obj
            id_to_key[pid] = name_key
    return lookup, id_to_key


def _playoff_score(player: dict) -> float:
    """
    Simple 0-1 score based on how many playoff weeks have games scheduled.
    Having all three weeks = 1.0, two = 0.67, one = 0.33, none = 0.
    """
    return sum(1 for w in ('week15', 'week16', 'week17') if player.get(w)) / 3.0


def get_analysis_data(force_refresh: bool = False):
    """
    Return a list of player dicts enriched with 2025 actuals, 2026 projections,
    composite scores, and market delta. Sorted by composite_score descending.
    """
    if force_refresh:
        _sleeper_cache.clear()

    stats, meta, projections = _fetch_sleeper()
    sl_lookup, id_to_key     = _build_sleeper_lookup(stats, meta)

    # Pull players + custom rankings from DB
    with get_db() as conn:
        rows = conn.execute("""
            SELECT p.player_id, p.name, p.pos, p.team, p.adp,
                   p.week15, p.week16, p.week17,
                   r.custom_rank
            FROM players p
            LEFT JOIN player_rankings r ON p.player_id = r.player_id
            WHERE p.pos IN ('QB','RB','WR','TE')
            ORDER BY p.adp
        """).fetchall()

    players = [dict(r) for r in rows]

    # ── Match 2025 actuals by normalized name ─────────────────────────────────
    for p in players:
        key = _normalize(p['name'])
        sl  = sl_lookup.get(key)
        if sl:
            p.update(sl)
        else:
            p.update({
                'sleeper_id': None, 'pts_ppr': 0, 'gp': 0,
                'rush_yd': 0, 'rush_td': 0, 'rec_yd': 0, 'rec_td': 0,
                'rec': 0, 'pass_yd': 0, 'pass_td': 0, 'pass_int': 0,
                'pos_rank': 999,
            })

    # ── Match 2026 projections by Sleeper player ID ───────────────────────────
    # Build a name → sleeper_id map from the full meta (includes players with
    # low 2025 stats who may still have 2026 projections, e.g. rookies).
    name_to_pid = {}
    for pid, m in meta.items():
        nk = _normalize(m.get('full_name') or m.get('search_full_name') or '')
        if nk and nk not in name_to_pid:
            name_to_pid[nk] = pid

    for p in players:
        sid = p.get('sleeper_id')
        # Fall back to name lookup for players not matched via stats
        if not sid:
            sid = name_to_pid.get(_normalize(p['name']))

        proj = projections.get(sid, {}) if sid else {}
        p['proj_pts_ppr']  = round(float(proj.get('pts_ppr')  or 0), 1)
        p['proj_rush_yd']  = int(proj.get('rush_yd')  or 0)
        p['proj_rec_yd']   = int(proj.get('rec_yd')   or 0)
        p['proj_rec']      = int(proj.get('rec')       or 0)
        p['proj_rush_td']  = int(proj.get('rush_td')  or 0)
        p['proj_rec_td']   = int(proj.get('rec_td')   or 0)
        p['proj_pass_yd']  = int(proj.get('pass_yd')  or 0)
        p['proj_pass_td']  = int(proj.get('pass_td')  or 0)
        p['proj_gp']       = round(float(proj.get('gp') or 0), 1)

    # ── Market delta: projected rank vs DK ADP ────────────────────────────────
    # Rank all players who have projections by proj_pts_ppr (position-agnostic
    # overall rank, since DK ADP is also overall).
    proj_players = sorted(
        [p for p in players if p['proj_pts_ppr'] > 0],
        key=lambda x: -x['proj_pts_ppr']
    )
    for rank, p in enumerate(proj_players, 1):
        p['proj_rank'] = rank

    for p in players:
        if 'proj_rank' not in p:
            p['proj_rank'] = None
        # market_delta: positive = market is too LOW (undervalued by DK ADP)
        #               negative = market is too HIGH (overvalued)
        if p['proj_rank'] and p.get('adp'):
            p['market_delta'] = round(p['adp'] - p['proj_rank'])
        else:
            p['market_delta'] = None

    # ── Betting prop lines (from DB, scraped separately) ─────────────────────
    all_props = get_all_props()   # {player_name: {prop_type: {line, ...}}}

    # Build a normalized-name → raw-name lookup for fuzzy matching
    props_norm = {_normalize(k): k for k in all_props}

    for p in players:
        key = _normalize(p['name'])
        raw_key = props_norm.get(key)
        pdata = all_props.get(raw_key, {}) if raw_key else {}

        # Flatten lines into player dict
        prop_keys = ('rush_yd', 'rec_yd', 'rec', 'rush_td', 'rec_td', 'pass_yd', 'pass_td', 'pass_int')
        for pk in prop_keys:
            entry = pdata.get(pk, {})
            p[f'prop_{pk}'] = entry.get('line') if isinstance(entry, dict) else None
        p['prop_over_odds']  = None  # reserved for future display
        p['prop_updated_at'] = (pdata.get(list(pdata.keys())[0], {}) or {}).get('updated_at') if pdata else None

        # Implied full-PPR points from the prop lines
        p['prop_implied_ppr'] = props_to_fantasy_pts(pdata) if pdata else None

    # Rank players by prop-implied PPR (where available) for market delta
    prop_ranked = sorted(
        [p for p in players if p.get('prop_implied_ppr')],
        key=lambda x: -x['prop_implied_ppr']
    )
    for rank, p in enumerate(prop_ranked, 1):
        p['prop_rank'] = rank

    for p in players:
        if 'prop_rank' not in p:
            p['prop_rank'] = None
        if p.get('prop_rank') and p.get('adp'):
            p['prop_adp_delta'] = round(p['adp'] - p['prop_rank'])  # + = market too low
        else:
            p['prop_adp_delta'] = None

    # ── Composite scoring ─────────────────────────────────────────────────────
    # Normalise 2025 pts_ppr per position so QB vs RB vs WR are comparable
    pos_max = {}
    for pos in SKILL_POSITIONS:
        vals = [p['pts_ppr'] for p in players if p['pos'] == pos and p['pts_ppr'] > 0]
        pos_max[pos] = max(vals) if vals else 1

    total = len(players)

    for p in players:
        adp   = p.get('adp') or total
        pts   = p['pts_ppr']
        gp    = p['gp']
        pos   = p['pos']

        # 1. Last-season performance (position-normalized, 0-1)
        perf_score = (pts / pos_max.get(pos, 1)) if pts > 0 else 0

        # 2. Durability bonus (played full 17-game season = 1.0)
        durability = min(gp / 17, 1.0) if gp > 0 else 0

        # 3. ADP score (inverted rank, 0-1)
        adp_score = max(0, 1 - (adp - 1) / total)

        # 4. Playoff schedule quality (0-1)
        schedule = _playoff_score(p)

        # Composite (weights reflect what matters most in best ball)
        composite = (
            perf_score  * 0.45 +
            adp_score   * 0.30 +
            durability  * 0.15 +
            schedule    * 0.10
        ) * 100

        p['perf_score']     = round(perf_score * 100, 1)
        p['adp_score']      = round(adp_score  * 100, 1)
        p['durability']     = round(durability  * 100, 1)
        p['schedule_score'] = round(schedule    * 100, 1)
        p['composite']      = round(composite, 1)

        # Tier label
        if composite >= 65:   p['tier'] = 'Elite'
        elif composite >= 45: p['tier'] = 'Strong'
        elif composite >= 28: p['tier'] = 'Solid'
        elif composite >= 15: p['tier'] = 'Speculative'
        else:                 p['tier'] = 'Flier'

    # Sort by composite score
    players.sort(key=lambda p: -p['composite'])

    # Add analysis rank and delta vs ADP
    for i, p in enumerate(players, 1):
        p['analysis_rank'] = i
        adp = p.get('adp') or 0
        p['value_delta'] = round(adp - i)   # + = undervalued (ADP worse than our score says)

    return players
