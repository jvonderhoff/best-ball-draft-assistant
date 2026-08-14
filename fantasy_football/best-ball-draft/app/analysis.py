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
from app.database import get_db, get_all_props, get_raw_projections, get_yahoo_projections, get_espn_projections
from app.data.betting_fetcher import props_to_fantasy_pts
# Static team -> 2026 bye week. Lives in the DK fetcher because that is where the
# pool is enriched; the players TABLE has no bye column, so reading the constant
# directly is what avoids a schema migration for a display-only field.
from app.data.api_fetcher import BYE_WEEKS_2026

SLEEPER_STATS_URL       = 'https://api.sleeper.app/v1/stats/nfl/regular/2025'
SLEEPER_PLAYERS_URL     = 'https://api.sleeper.app/v1/players/nfl'
SLEEPER_PROJ_URL        = 'https://api.sleeper.app/v1/projections/nfl/regular/2026'
SKILL_POSITIONS = {'QB', 'RB', 'WR', 'TE'}

_sleeper_cache = {}   # module-level cache so we only fetch once per process


def _normalize(name: str) -> str:
    """Cross-source name key. See app.data.names for why nicknames matter."""
    from app.data.names import normalize_name
    return normalize_name(name)


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
            # Raw opportunity inputs. Carried through untouched so the derived
            # share metrics in _attach_opportunity have something to divide, and
            # so the underlying counts stay inspectable when a share looks wrong.
            'rec_tgt':     int(s.get('rec_tgt')     or 0),
            'rec_air_yd':  int(s.get('rec_air_yd')  or 0),
            'rec_rz_tgt':  int(s.get('rec_rz_tgt')  or 0),
            'rush_att':    int(s.get('rush_att')    or 0),
            'rush_rz_att': int(s.get('rush_rz_att') or 0),
            'rec_drop':    int(s.get('rec_drop')    or 0),
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


# ── Opportunity, regression and context ───────────────────────────────────────
#
# Everything below is derived from the SAME two Sleeper calls the module already
# makes.  No new source, no scraping, nothing that can be blocked by IP — the raw
# fields were simply being dropped on the floor.
#
# Read all of it as 2025 ACTUALS.  These describe the role a player held last
# season; they are not a 2026 forecast, and rookies and team-changers have none.
# Their value is as a cross-check on the projection columns: a projection that
# disagrees with an established role is either an insight or an error, and this is
# what lets you tell which.

def _team_totals(stats: dict, meta: dict) -> dict:
    """
    Per-team 2025 totals for the denominators of every share metric.

    Summed over EVERY skill player Sleeper has on the team, deliberately not over
    the DK pool: a share has to be denominated in the whole offence or it inflates
    for teams whose depth is undrafted.  Sleeper does publish team-level rows, but
    summing players keeps numerator and denominator on one basis — the same reason
    `rec_share` in app/projections.py divides by Sleeper's own total.
    """
    totals = {}
    for pid, m in meta.items():
        team = m.get('team')
        if not team or m.get('position') not in SKILL_POSITIONS:
            continue
        s = stats.get(pid)
        if not s:
            continue
        t = totals.setdefault(team, {'tgt': 0.0, 'air_yd': 0.0, 'rush_att': 0.0,
                                     'rz_tgt': 0.0, 'rz_att': 0.0})
        t['tgt']      += float(s.get('rec_tgt')     or 0)
        t['air_yd']   += float(s.get('rec_air_yd')  or 0)
        t['rush_att'] += float(s.get('rush_att')    or 0)
        t['rz_tgt']   += float(s.get('rec_rz_tgt')  or 0)
        t['rz_att']   += float(s.get('rush_rz_att') or 0)
    return totals


def _build_context_lookup(meta: dict) -> dict:
    """
    name_key -> {age, years_exp, depth_chart_order, injury_status}.

    Built from the FULL meta rather than from the stats lookup, which drops anyone
    under 10 points last season.  Rookies are exactly the players with no stats and
    exactly the players whose age and depth-chart slot you most want to see, so
    reusing the stats-filtered map here would blank the useful cases.
    """
    out = {}
    for pid, m in meta.items():
        if m.get('position') not in SKILL_POSITIONS:
            continue
        key = _normalize(m.get('full_name') or m.get('search_full_name') or '')
        if not key or key in out:
            continue
        out[key] = {
            'age':          m.get('age'),
            'years_exp':    m.get('years_exp'),
            'depth_order':  m.get('depth_chart_order'),
            # Sleeper leaves this None for healthy players; '' would render as a
            # blank cell that looks like missing data rather than good news.
            'injury':       m.get('injury_status') or None,
        }
    return out


def _league_td_rates(stats: dict, meta: dict) -> tuple:
    """
    League-wide touchdowns per red-zone target and per red-zone carry, measured
    from this season's data rather than hardcoded.

    Constants in this project get measured where measuring is possible (see
    CLAUDE.md), and this one is free to measure: the same rows that supply a
    player's red-zone usage supply the league rate to price it against.  It also
    means the number self-corrects if the league's scoring environment moves,
    which a literal copied off an article would not.
    """
    rz_tgt = rz_att = rec_td = rush_td = 0.0
    for pid, m in meta.items():
        if m.get('position') not in SKILL_POSITIONS:
            continue
        s = stats.get(pid)
        if not s:
            continue
        rz_tgt  += float(s.get('rec_rz_tgt')  or 0)
        rz_att  += float(s.get('rush_rz_att') or 0)
        rec_td  += float(s.get('rec_td')      or 0)
        rush_td += float(s.get('rush_td')     or 0)
    # Fall back to roughly league-average rates if a fetch came back empty, so a
    # bad API day degrades to approximate numbers instead of dividing by zero.
    per_tgt = (rec_td  / rz_tgt) if rz_tgt > 0 else 0.20
    per_att = (rush_td / rz_att) if rz_att > 0 else 0.12
    return per_tgt, per_att


def _attach_opportunity(players: list, team_tot: dict, ctx_lookup: dict,
                        td_per_rz_tgt: float, td_per_rz_att: float) -> None:
    """
    Attach share, efficiency, red-zone and context columns to each player in place.

    NO aDOT AND NO WOPR HERE, DELIBERATELY, AND DO NOT ADD THEM FROM THIS SOURCE.
    Both are defined on *intended* air yards — how far downfield a throw was aimed,
    counted on every target including incompletions.  Sleeper's `rec_air_yd` is
    COMPLETED air yards: receiving yards minus yards after catch, on catches only.
    Checked rather than assumed — across the 122 players with 50+ targets in 2025,
    `rec_air_yd` exceeds `rec_yd` exactly ZERO times, which cannot happen for an
    intended-air-yards figure (a receiver targeted 20 yards downfield 100 times has
    ~2,000 intended air yards and nowhere near that many receiving yards).

    Dividing completed air yards by targets therefore does not give aDOT; it gives a
    number contaminated by catch rate and quarterback accuracy that lands about half
    where aDOT should (Ja'Marr Chase 4.2 against a real aDOT near 9).  Publishing it
    under the name "aDOT" would be worse than omitting it, because the reader would
    compare it against every other site's aDOT and quietly conclude the player had
    changed role.  Same for WOPR, whose air-yards term is intended by definition.

    What IS honest from this data: target share (a target is a target), completed
    air yards per reception, catch rate, and the red-zone counts.  Real aDOT/WOPR
    need play-by-play — nflfastR publishes `air_yards` per play, free — which is a
    new pipeline rather than a new column.
    """
    for p in players:
        # No 2025 stat row means a rookie or a player who did not register — every
        # column below has to read "—", NOT zero.  A 0.0% target share renders as a
        # measurement ("he played and got nothing") when the truth is an absence of
        # data, and the players it would libel are exactly the rookies whose ADP is
        # most speculative.  Same reason `rec_share` treats null as unknown rather
        # than as a back who never catches the ball.
        has_2025 = p.get('sleeper_id') is not None

        # Receiving opportunity is a PASS CATCHER's metric. Without this gate a
        # quarterback with one trick-play reception for −9 yards posts an AY/Rec of
        # −9.0, and the leaderboard of "catches furthest behind the line" fills up
        # with Mahomes and Rodgers. There is no such thing as a QB's target share.
        is_catcher = p.get('pos') in ('RB', 'WR', 'TE')

        # Rate stats need a sample. Ten targets is a floor against the same class of
        # noise one rung down: a backup with 3 targets and 3 catches is not a 100%
        # catch-rate receiver, and sorting by that column should not hand him the
        # top of it. Counting stats (targets, red-zone looks) are shown unfiltered
        # because a count of 3 is honestly a count of 3.
        MIN_TGT = 10

        tot = team_tot.get(p.get('team')) or {}
        tgt   = float(p.get('rec_tgt')     or 0)
        air   = float(p.get('rec_air_yd')  or 0)
        rec   = float(p.get('rec')         or 0)
        catch_tot = float(tot.get('tgt')    or 0)
        air_tot   = float(tot.get('air_yd') or 0)

        # Gated on the player having targets, not just on the denominator existing.
        # A quarterback's target share is not 0% — it is undefined, and printing a
        # zero in that cell puts a number where there is no concept.
        ok = has_2025 and is_catcher and tgt >= MIN_TGT
        tgt_share = (tgt / catch_tot) if (ok and catch_tot > 0) else None

        # THE headline opportunity number, and the one metric here that is exactly
        # what it says: share of his own offence's targets. Volume is the most
        # persistent thing about a pass catcher year to year — far more so than
        # efficiency — which is why this belongs next to the projections.
        p['tgt_share'] = round(100 * tgt_share, 1) if tgt_share is not None else None

        # NO air-yards SHARE, and this is a second, separate reason from the aDOT
        # one above. Completed air yards go NEGATIVE for a player whose catches
        # happen behind the line of scrimmage — De'Von Achane ran −12.8% of his
        # team's, which is correct arithmetic and a meaningless share, since a
        # share needs a non-negative numerator to be a share at all. Per-reception
        # the same negative number is fine and in fact informative, so that is the
        # form kept.

        # Completed air yards per RECEPTION — how far downfield his catches
        # actually happen. Divided by receptions, not targets, because the
        # numerator only counts caught balls; per-target would mix a
        # catches-only numerator with an all-targets denominator and mean nothing.
        p['ay_per_rec'] = round(air / rec, 1) if (ok and rec > 0) else None
        p['catch_rate'] = round(100 * rec / tgt, 1) if ok else None
        # The raw count behind the share, shown because a share hides its own
        # sample size — 20% of a team that threw 400 times is not 20% of one that
        # threw 700, and the reader deserves to see which.
        p['tgt'] = int(tgt) if (has_2025 and is_catcher) else None

        # ── Red zone and touchdown regression ─────────────────────────────────
        rz_tgt = float(p.get('rec_rz_tgt')  or 0)
        rz_att = float(p.get('rush_rz_att') or 0)
        p['rz_tgt'] = int(rz_tgt) if has_2025 else None
        p['rz_att'] = int(rz_att) if has_2025 else None
        p['rz_opp'] = int(rz_tgt + rz_att) if has_2025 else None

        # Expected TDs from red-zone usage, against what he actually scored.
        # POSITIVE td_delta = outscored his usage, a regression-DOWN candidate
        # (sell); negative = the usage was there and the touchdowns were not
        # (buy).  This is a statement about last season's luck, not a forecast —
        # it flags where the market may be pricing variance as skill.
        actual_td = float(p.get('rec_td') or 0) + float(p.get('rush_td') or 0)
        if has_2025 and rz_tgt + rz_att > 0:
            xtd = rz_tgt * td_per_rz_tgt + rz_att * td_per_rz_att
            p['xtd']      = round(xtd, 1)
            p['td_delta'] = round(actual_td - xtd, 1)
        else:
            p['xtd'] = None
            p['td_delta'] = None

        # ── Context ───────────────────────────────────────────────────────────
        c = ctx_lookup.get(_normalize(p['name'])) or {}
        p['age']         = c.get('age')
        p['years_exp']   = c.get('years_exp')
        p['depth_order'] = c.get('depth_order')
        p['injury']      = c.get('injury')
        p['bye']         = BYE_WEEKS_2026.get(p.get('team')) or None


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
                   p.ecr_rank, p.ecr_std,
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
                'rec_tgt': 0, 'rec_air_yd': 0, 'rec_rz_tgt': 0,
                'rush_att': 0, 'rush_rz_att': 0, 'rec_drop': 0,
            })

    # ── Opportunity, red-zone regression and context (2025 actuals) ───────────
    # Placed here, straight after the actuals are matched, because every input it
    # needs is a 2025 stat and none of it depends on any projection source.
    team_tot   = _team_totals(stats, meta)
    ctx_lookup = _build_context_lookup(meta)
    td_per_rz_tgt, td_per_rz_att = _league_td_rates(stats, meta)
    _attach_opportunity(players, team_tot, ctx_lookup, td_per_rz_tgt, td_per_rz_att)

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

    # ── Yahoo projections (from DB) ───────────────────────────────────────────
    yahoo_raw  = get_yahoo_projections()   # {player_name: {fpts, pos, yahoo_rank, ...}}
    yahoo_norm = {_normalize(k): v for k, v in yahoo_raw.items()}
    for p in players:
        yp = yahoo_norm.get(_normalize(p['name']))
        p['yahoo_pts_ppr'] = round(float(yp['fpts']), 1) if yp and yp.get('fpts') else 0
        p['yahoo_rank']    = yp.get('yahoo_rank') if yp else None

    # ── ESPN projections (from DB) ────────────────────────────────────────────
    # ESPN is the practical replacement for FantasyPros season projections, which
    # are now paywalled down to a 10-per-position teaser.  It also carries component
    # stats — notably projected receptions, which no sportsbook quotes — so it backs
    # the betting-prop correction in app/projections.py.
    espn_raw  = get_espn_projections()
    espn_norm = {_normalize(k): v for k, v in espn_raw.items()}
    espn_components = ('pass_yd', 'pass_td', 'pass_int', 'rush_yd', 'rush_td',
                       'rec', 'rec_yd', 'rec_td')
    for p in players:
        ep = espn_norm.get(_normalize(p['name']))
        p['espn_pts_ppr'] = round(float(ep['fpts']), 1) if ep and ep.get('fpts') else 0
        for c in espn_components:
            p[f'espn_{c}'] = (ep or {}).get(c) or 0

    # ── Consensus PPR (average of available PPR point sources) ────────────────
    for p in players:
        pts = [v for v in (p['proj_pts_ppr'], p['fp_pts_ppr'],
                           p['yahoo_pts_ppr'], p['espn_pts_ppr']) if v > 0]
        p['consensus_ppr'] = round(sum(pts) / len(pts), 1) if pts else 0

    # ── Positional ranks per source (used for rank-based consensus) ───────────
    for pos in SKILL_POSITIONS:
        # SL positional rank
        sl_sorted = sorted(
            [p for p in players if p['pos'] == pos and p['proj_pts_ppr'] > 0],
            key=lambda x: -x['proj_pts_ppr']
        )
        for rank, p in enumerate(sl_sorted, 1):
            p['sl_pos_rank'] = rank

        # FP positional rank
        fp_sorted = sorted(
            [p for p in players if p['pos'] == pos and p['fp_pts_ppr'] > 0],
            key=lambda x: -x['fp_pts_ppr']
        )
        for rank, p in enumerate(fp_sorted, 1):
            p['fp_pos_rank'] = rank

    for p in players:
        p.setdefault('sl_pos_rank', None)
        p.setdefault('fp_pos_rank', None)

    # ── Positional consensus rank — average available positional ranks ─────────
    # Uses: FP rank, SL rank, Yahoo AR rank (all positional, lower = better)
    # This lets Yahoo contribute even when PPR projections aren't yet published.
    for pos in SKILL_POSITIONS:
        pos_players = [p for p in players if p['pos'] == pos]
        ranked = []
        for p in pos_players:
            ranks = [r for r in (p['fp_pos_rank'], p['sl_pos_rank'], p.get('yahoo_rank')) if r]
            if ranks:
                p['_avg_rank'] = sum(ranks) / len(ranks)
                ranked.append(p)
        ranked.sort(key=lambda x: x['_avg_rank'])
        for rank, p in enumerate(ranked, 1):
            p['consensus_rank'] = rank
            p['consensus_label'] = f"{pos}{rank}"

    for p in players:
        if 'consensus_rank' not in p:
            p['consensus_rank'] = None
            p['consensus_label'] = None

    # ── Overall consensus rank for market delta (rank all players by consensus_ppr)
    overall_ranked = sorted(
        [p for p in players if p['consensus_ppr'] > 0],
        key=lambda x: -x['consensus_ppr']
    )
    for rank, p in enumerate(overall_ranked, 1):
        p['consensus_overall'] = rank
    for p in players:
        if 'consensus_overall' not in p:
            p['consensus_overall'] = None

        # market_delta: positive = market too LOW (undervalued), negative = too HIGH
        adp = p.get('adp')
        co  = p.get('consensus_overall')
        p['market_delta'] = round(adp - co) if adp and co else None

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
