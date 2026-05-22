"""
Player analysis module.
Pulls 2025 season stats from the Sleeper API and combines them with
our 2026 DK ADP + playoff schedule data to produce a composite
"season potential" score for each player.
"""
import re
import requests
from app.database import get_db

SLEEPER_STATS_URL  = 'https://api.sleeper.app/v1/stats/nfl/regular/2025'
SLEEPER_PLAYERS_URL = 'https://api.sleeper.app/v1/players/nfl'
SKILL_POSITIONS = {'QB', 'RB', 'WR', 'TE'}

_sleeper_cache = {}   # module-level cache so we only fetch once per process


def _normalize(name: str) -> str:
    """Lowercase, strip punctuation/suffixes for fuzzy name matching."""
    name = name.lower()
    name = re.sub(r"['\-\.]", '', name)
    name = re.sub(r'\s+(jr|sr|ii|iii|iv|v)\s*$', '', name)
    return name.strip()


def _fetch_sleeper():
    """Return (stats_dict, meta_dict) from Sleeper API, cached after first call."""
    if _sleeper_cache:
        return _sleeper_cache.get('stats', {}), _sleeper_cache.get('meta', {})
    try:
        rs = requests.get(SLEEPER_STATS_URL,  timeout=12)
        rm = requests.get(SLEEPER_PLAYERS_URL, timeout=20)
        stats = rs.json() if rs.ok else {}
        meta  = rm.json() if rm.ok else {}
        # Filter meta to skill positions only to keep size manageable
        meta = {k: v for k, v in meta.items()
                if v.get('position') in SKILL_POSITIONS}
        _sleeper_cache['stats'] = stats
        _sleeper_cache['meta']  = meta
        print(f'  [Analysis] Sleeper: {len(stats)} stat rows, {len(meta)} skill players')
    except Exception as e:
        print(f'  [Analysis] Sleeper fetch error: {e}')
        stats, meta = {}, {}
    return stats, meta


def _build_sleeper_lookup(stats, meta):
    """
    Build a normalized-name → stat dict for quick lookups.
    Only includes players with meaningful fantasy points.
    """
    lookup = {}
    for pid, m in meta.items():
        s = stats.get(pid, {})
        pts = s.get('pts_half_ppr') or 0
        gp  = s.get('gp') or 0
        if pts < 10:   # skip kickers, practice squad, etc.
            continue
        name_key = _normalize(m.get('full_name') or m.get('search_full_name') or '')
        if not name_key:
            continue
        obj = {
            'sleeper_id':    pid,
            'pts_half_ppr':  round(float(pts), 1),
            'gp':            int(gp),
            'rush_yd':       int(s.get('rush_yd') or 0),
            'rush_td':       int(s.get('rush_td') or 0),
            'rec_yd':        int(s.get('rec_yd') or 0),
            'rec_td':        int(s.get('rec_td') or 0),
            'rec':           int(s.get('rec') or 0),
            'pass_yd':       int(s.get('pass_yd') or 0),
            'pass_td':       int(s.get('pass_td') or 0),
            'pass_int':      int(s.get('pass_int') or 0),
            'pos_rank':      int(s.get('pos_rank_half_ppr') or 999),
        }
        # If a name appears twice, keep the higher-scoring one
        if name_key not in lookup or obj['pts_half_ppr'] > lookup[name_key]['pts_half_ppr']:
            lookup[name_key] = obj
    return lookup


def _playoff_score(player: dict) -> float:
    """
    Simple 0-1 score based on how many playoff weeks have games scheduled.
    Having all three weeks = 1.0, two = 0.67, one = 0.33, none = 0.
    """
    return sum(1 for w in ('week15', 'week16', 'week17') if player.get(w)) / 3.0


def get_analysis_data(force_refresh: bool = False):
    """
    Return a list of player dicts enriched with 2025 stats and composite scores.
    Sorted by composite_score descending.
    """
    if force_refresh:
        _sleeper_cache.clear()

    stats, meta = _fetch_sleeper()
    sl_lookup   = _build_sleeper_lookup(stats, meta)

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

    # Match to Sleeper stats by normalized name
    for p in players:
        key = _normalize(p['name'])
        sl  = sl_lookup.get(key)
        if sl:
            p.update(sl)
        else:
            # Zero-fill so every player has the same keys
            p.update({
                'sleeper_id': None, 'pts_half_ppr': 0, 'gp': 0,
                'rush_yd': 0, 'rush_td': 0, 'rec_yd': 0, 'rec_td': 0,
                'rec': 0, 'pass_yd': 0, 'pass_td': 0, 'pass_int': 0,
                'pos_rank': 999,
            })

    # ── Scoring ────────────────────────────────────────────────────────────────
    # Normalise pts_half_ppr per position so QB vs RB vs WR are comparable
    pos_max = {}
    for pos in SKILL_POSITIONS:
        vals = [p['pts_half_ppr'] for p in players if p['pos'] == pos and p['pts_half_ppr'] > 0]
        pos_max[pos] = max(vals) if vals else 1

    total = len(players)

    for p in players:
        adp   = p.get('adp') or total
        pts   = p['pts_half_ppr']
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
