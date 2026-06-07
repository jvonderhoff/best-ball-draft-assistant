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
from app.database import get_db, get_all_props, get_raw_projections
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

    # ── SL rank: rank by Sleeper proj_pts_ppr ────────────────────────────────
    sl_ranked = sorted(
        [p for p in players if p['proj_pts_ppr'] > 0],
        key=lambda x: -x['proj_pts_ppr']
    )
    for rank, p in enumerate(sl_ranked, 1):
        p['proj_rank'] = rank
    for p in players:
        if 'proj_rank' not in p:
            p['proj_rank'] = None

    # ── FantasyPros season projections (from DB) ─────────────────────────────
    fp_raw = get_raw_projections()   # {player_name: {fpts, pos, ...}}
    fp_norm = {_normalize(k): v for k, v in fp_raw.items()}
    for p in players:
        fp = fp_norm.get(_normalize(p['name']))
        p['fp_pts_ppr'] = round(float(fp['fpts']), 1) if fp and fp.get('fpts') else 0

    # ── FP rank: rank by FantasyPros fp_pts_ppr ──────────────────────────────
    fp_ranked = sorted(
        [p for p in players if p['fp_pts_ppr'] > 0],
        key=lambda x: -x['fp_pts_ppr']
    )
    for rank, p in enumerate(fp_ranked, 1):
        p['fp_rank'] = rank
    for p in players:
        if 'fp_rank' not in p:
            p['fp_rank'] = None

    # ── Consensus rank & PPR (FP + SL average) ───────────────────────────────
    for p in players:
        sl_r  = p.get('proj_rank')
        fp_r  = p.get('fp_rank')
        sl_pt = p['proj_pts_ppr']
        fp_pt = p['fp_pts_ppr']

        if sl_r and fp_r:
            p['consensus_rank'] = round((sl_r + fp_r) / 2, 1)
            p['consensus_ppr']  = round((sl_pt + fp_pt) / 2, 1)
        elif fp_r:
            p['consensus_rank'] = float(fp_r)
            p['consensus_ppr']  = fp_pt
        elif sl_r:
            p['consensus_rank'] = float(sl_r)
            p['consensus_ppr']  = sl_pt
        else:
            p['consensus_rank'] = None
            p['consensus_ppr']  = 0

        # market_delta: positive = market too LOW (undervalued), negative = too HIGH
        adp = p.get('adp')
        cr  = p['consensus_rank']
        p['market_delta'] = round(adp - cr) if adp and cr else None

    # ── Best-ball specific metrics ────────────────────────────────────────────
    import statistics as _stats

    # 1. Position-adjusted Z-score (FP PPR normalised within each position)
    pos_groups = {}
    for pos in SKILL_POSITIONS:
        vals = [p['fp_pts_ppr'] for p in players if p['pos'] == pos and p['fp_pts_ppr'] > 0]
        if len(vals) >= 2:
            pos_groups[pos] = (_stats.mean(vals), _stats.stdev(vals))

    for p in players:
        grp = pos_groups.get(p['pos'])
        if grp and p['fp_pts_ppr'] > 0:
            mean, std = grp
            p['pos_z'] = round((p['fp_pts_ppr'] - mean) / std, 2) if std > 0 else 0.0
        else:
            p['pos_z'] = None

    # 2. Upside score (0–100)
    #    40% position CV (how boom-capable is the position in best-ball)
    #    30% source spread (FP vs SL disagreement — uncertainty = opportunity)
    #    30% upward trajectory (consensus above last year's actual)
    _POS_CV  = {'QB': 0.35, 'RB': 0.55, 'WR': 0.75, 'TE': 0.65}
    _CV_MIN, _CV_MAX = 0.35, 0.75

    spreads = [abs(p['fp_pts_ppr'] - p['proj_pts_ppr'])
               for p in players if p['fp_pts_ppr'] > 0 and p['proj_pts_ppr'] > 0]
    max_spread = max(spreads) if spreads else 1

    for p in players:
        cv       = _POS_CV.get(p['pos'], 0.5)
        cv_score = (cv - _CV_MIN) / (_CV_MAX - _CV_MIN)

        if p['fp_pts_ppr'] > 0 and p['proj_pts_ppr'] > 0:
            spread_score = min(abs(p['fp_pts_ppr'] - p['proj_pts_ppr']) / max_spread, 1.0)
        else:
            spread_score = 0.0

        if p['pts_ppr'] > 0 and p['consensus_ppr'] > 0:
            traj_raw  = (p['consensus_ppr'] - p['pts_ppr']) / p['pts_ppr']
            traj_score = min(max(traj_raw, 0.0), 1.0)
        elif p['consensus_ppr'] > 0:
            traj_score = 0.3   # rookie / no 2025 data — neutral-positive
        else:
            traj_score = 0.0

        p['upside'] = round((cv_score * 0.40 + spread_score * 0.30 + traj_score * 0.30) * 100, 1)

    # 3. Trajectory — % change from 2025 actual to 2026 consensus projection
    for p in players:
        if p['pts_ppr'] > 0 and p['consensus_ppr'] > 0:
            p['trajectory'] = round((p['consensus_ppr'] - p['pts_ppr']) / p['pts_ppr'] * 100, 1)
        else:
            p['trajectory'] = None   # rookie or missing data

    # ── Betting prop lines (from DB, scraped separately) ─────────────────────
    all_props_by_book = get_all_props()   # {book: {player_name: {prop_type: {...}}}}
    dk_props  = all_props_by_book.get('DraftKings', {})
    ud_props  = all_props_by_book.get('Underdog', {})

    # Build normalized-name → raw-name lookups for fuzzy matching
    dk_norm = {_normalize(k): k for k in dk_props}
    ud_norm = {_normalize(k): k for k in ud_props}

    prop_keys = ('rush_yd', 'rec_yd', 'rec', 'rush_td', 'rec_td', 'pass_yd', 'pass_td', 'pass_int')

    for p in players:
        key = _normalize(p['name'])

        # DraftKings props
        dk_raw  = dk_norm.get(key)
        dk_data = dk_props.get(dk_raw, {}) if dk_raw else {}
        for pk in prop_keys:
            entry = dk_data.get(pk, {})
            p[f'dk_{pk}'] = entry.get('line') if isinstance(entry, dict) else None
        p['dk_prop_ppr']     = props_to_fantasy_pts(dk_data) if dk_data else None
        p['dk_updated_at']   = (dk_data.get(next(iter(dk_data), None), {}) or {}).get('updated_at') if dk_data else None

        # Underdog props
        ud_raw  = ud_norm.get(key)
        ud_data = ud_props.get(ud_raw, {}) if ud_raw else {}
        for pk in prop_keys:
            entry = ud_data.get(pk, {})
            p[f'ud_{pk}'] = entry.get('line') if isinstance(entry, dict) else None
        p['ud_prop_ppr']     = props_to_fantasy_pts(ud_data) if ud_data else None
        p['ud_updated_at']   = (ud_data.get(next(iter(ud_data), None), {}) or {}).get('updated_at') if ud_data else None

        # Keep a combined prop_implied_ppr (prefer DK, fall back to UD) for scoring/ranking
        p['prop_implied_ppr'] = p['dk_prop_ppr'] or p['ud_prop_ppr']

        # Legacy aliases so existing template code still works
        for pk in prop_keys:
            p[f'prop_{pk}'] = p[f'dk_{pk}'] or p[f'ud_{pk}']

    # Rank players by DK prop-implied PPR for market delta
    for book_key, ppr_key, rank_key, delta_key in [
        ('dk_prop_ppr', 'dk_prop_ppr', 'dk_prop_rank', 'dk_prop_adp_delta'),
        ('ud_prop_ppr', 'ud_prop_ppr', 'ud_prop_rank', 'ud_prop_adp_delta'),
    ]:
        ranked = sorted(
            [p for p in players if p.get(ppr_key)],
            key=lambda x: -x[ppr_key]
        )
        for rank, p in enumerate(ranked, 1):
            p[rank_key] = rank
        for p in players:
            if rank_key not in p:
                p[rank_key] = None
            adp = p.get('adp')
            rk  = p.get(rank_key)
            p[delta_key] = round(adp - rk) if adp and rk else None

    # Legacy prop_rank / prop_adp_delta (DK preferred)
    for p in players:
        p['prop_rank']      = p.get('dk_prop_rank') or p.get('ud_prop_rank')
        p['prop_adp_delta'] = p.get('dk_prop_adp_delta') or p.get('ud_prop_adp_delta')

    # ── Composite scoring ─────────────────────────────────────────────────────
    # Normalise 2026 projected pts_ppr per position so QB vs RB vs WR are comparable
    pos_max_proj = {}
    for pos in SKILL_POSITIONS:
        vals = [p['proj_pts_ppr'] for p in players if p['pos'] == pos and p['proj_pts_ppr'] > 0]
        pos_max_proj[pos] = max(vals) if vals else 1

    total = len(players)

    for p in players:
        adp  = p.get('adp') or total
        proj = p['proj_pts_ppr']
        gp   = p['gp']
        pos  = p['pos']

        # 1. 2026 projection (position-normalized, 0-1)
        proj_score = (proj / pos_max_proj.get(pos, 1)) if proj > 0 else 0

        # 2. Durability (games played last season, 0-1)
        durability = min(gp / 17, 1.0) if gp > 0 else 0

        # 3. ADP score (inverted rank, 0-1)
        adp_score = max(0, 1 - (adp - 1) / total)

        # 4. Playoff schedule quality (0-1)
        schedule = _playoff_score(p)

        # Composite (weights reflect what matters most in best ball)
        composite = (
            proj_score  * 0.45 +
            adp_score   * 0.30 +
            durability  * 0.15 +
            schedule    * 0.10
        ) * 100

        p['proj_score']     = round(proj_score * 100, 1)
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

    # Add analysis rank (= consensus rank where available, else composite-based order)
    # Re-sort by consensus rank first so analysis_rank reflects consensus
    players.sort(key=lambda p: p['consensus_rank'] if p['consensus_rank'] else 9999)
    for i, p in enumerate(players, 1):
        p['analysis_rank'] = i
        adp = p.get('adp') or 0
        p['value_delta'] = round(adp - i)   # + = undervalued (ADP worse than our score says)

    return players
