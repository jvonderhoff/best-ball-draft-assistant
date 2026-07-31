"""
Player projection layer for the V2 recommender.

The V1 recommender scored players as 1000/adp — a hyperbolic curve that made every
multiplier's effective aggression scale with the player's ADP.  V2 needs a *linear*
points scale so a x1.15 bonus means the same thing in round 2 and round 18.

This module turns the multi-source consensus built in app.analysis into the small,
fast payload the draft page needs:

    proj_dk   season DraftKings points  (full PPR + 100/300-yard bonuses)
    ppg       per-game DK points
    sd        estimated week-to-week standard deviation
    ceiling   ~90th percentile week  (ppg + 1.28 * sd)

Best ball counts the *max* of your roster each week, so `ceiling` — not `ppg` — is
what actually decides who makes your lineup.  The recommender uses both.

DK scoring differs from raw PPR in ways that matter for player valuation:
  +3  for 100+ rushing yards in a game
  +3  for 100+ receiving yards in a game
  +3  for 300+ passing yards in a game
Sleeper/FantasyPros publish season PPR totals without these, so we estimate the
expected number of bonus games from projected per-game yardage.
"""
import json
import math
import os
import time

CACHE_PATH = os.path.join(os.path.dirname(__file__), 'data', 'projection_cache.json')
CACHE_TTL  = 6 * 60 * 60   # 6 hours — projections move slowly

# Week-to-week coefficient of variation for *fantasy points*, by position.
# Drives the ceiling estimate. TE is the spikiest scorer relative to its mean
# (touchdown-dependent), QB the steadiest.
POS_SCORING_CV = {'QB': 0.38, 'RB': 0.58, 'WR': 0.70, 'TE': 0.74}

# Week-to-week CV for *yardage*, used to estimate DK bonus-game frequency.
# Receiving yards are far spikier than passing yards.  Calibrated so the implied
# bonus-game counts land in the observed range — e.g. a 3,650-yard passer gets
# ~2-3 300-yard games, a 1,400-yard receiver ~4-5 100-yard games.
YARDAGE_CV = {'rec_yd': 0.85, 'rush_yd': 0.62, 'pass_yd': 0.42}

# The NFL plays a 17-game season. Sleeper's projected `gp` is 18 (it counts the
# bye), which would deflate every per-game number by ~6%.
MAX_GAMES = 17.0

# Share of games a healthy-entering player at each position misses in a typical
# season.  Projection sources publish an optimistic ~17 games for nearly everyone,
# which would tell the recommender that four running backs cover a whole season.
# They don't — and the cost of being thin lands hardest at RB, which has both the
# highest injury rate and two mandatory weekly starting slots.
POS_INJURY_RATE = {'QB': 0.12, 'RB': 0.18, 'WR': 0.14, 'TE': 0.15}

BONUS_THRESHOLD = {'rec_yd': 100.0, 'rush_yd': 100.0, 'pass_yd': 300.0}
BONUS_POINTS    = 3.0

# ── Betting-prop correction ───────────────────────────────────────────────────
#
# Sportsbooks price season-long yardage and touchdown totals with real money behind
# them, which makes them a sharper read than fantasy projection sites — and one that
# is genuinely independent of the industry consensus that Sleeper, FantasyPros and
# ECR all draw from.
#
# But props CANNOT be used to build a projection.  Neither DraftKings nor Underdog
# posts a season receptions market, so a prop-implied point total for a WR is missing
# the entire PPR reception component — roughly 70-100 of his ~280 points — while an
# RB's or QB's total is nearly complete.  Blending that into a consensus would drag
# every pass-catcher down relative to every runner, invisibly.
#
# So props are applied as a per-COMPONENT correction instead.  Each market line is
# compared against the projected value for that same component and only that
# component moves.  A player with a rec_yd line and nothing else gets his receiving
# yards corrected and nothing else touched.  Missing markets contribute exactly zero,
# so partial coverage degrades gracefully rather than biasing the result.

# DK scoring value of one unit of each component, full PPR.
COMPONENT_POINTS = {
    'rush_yd': 0.1, 'rush_td': 6.0,
    'rec_yd':  0.1, 'rec_td':  6.0, 'rec': 1.0,
    'pass_yd': 0.04, 'pass_td': 4.0, 'pass_int': -2.0,
}

# Receptions are never quoted, but they move with receiving yards — a receiver the
# market has above his projected yardage is almost always seeing more volume too.
# We propagate a damped share of the rec_yd tilt to receptions rather than assuming
# receptions are unchanged (too conservative) or scaling them fully (overconfident,
# since some of a yardage beat is yards-per-catch rather than volume).
RECEPTION_PROPAGATION = 0.5

# Cap on how far props may move a projection, as a fraction of the original. Guards
# against a stale or misparsed line wrecking a player's valuation mid-draft.
MAX_PROP_SHIFT = 0.35

# ~90th percentile week. Best ball rewards the weeks a player wins you the slot,
# not his average, so this is the number that drives lineup share.
CEILING_Z = 1.2816


def _norm_cdf(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def _prob_exceeds(mean: float, cv: float, threshold: float) -> float:
    """
    P(single-game value >= threshold) under a lognormal with the given mean and CV.

    Lognormal is the right family here: yardage is non-negative, right-skewed, and
    occasionally enormous — exactly the shape that produces bonus games. A normal
    approximation would badly undercount the tail for low-mean players.
    """
    if mean <= 0 or threshold <= 0:
        return 0.0
    sigma_sq = math.log(1.0 + cv * cv)
    sigma    = math.sqrt(sigma_sq)
    mu       = math.log(mean) - sigma_sq / 2.0
    z        = (math.log(threshold) - mu) / sigma
    return 1.0 - _norm_cdf(z)


def _dk_bonus_points(player: dict, games: float, scale: float) -> float:
    """
    Expected season points from DK's 100/300-yard game bonuses.

    `scale` rescales Sleeper's yardage (the only source that publishes component
    stats) to match the multi-source consensus points total, so a player the
    consensus likes more than Sleeper gets proportionally more bonus equity.
    """
    if games <= 0:
        return 0.0
    total = 0.0
    for key, cv in YARDAGE_CV.items():
        season_yd = (player.get(f'proj_{key}') or 0) * scale
        if season_yd <= 0:
            continue
        per_game = season_yd / games
        p        = _prob_exceeds(per_game, cv, BONUS_THRESHOLD[key])
        total   += p * games * BONUS_POINTS
    return total


def _market_lines(player: dict) -> dict:
    """
    Best available market line per component, averaging the books when both quote it.

    analysis.py already matched props onto players and exposed them as dk_<key> and
    ud_<key>.  Returns {component: line} containing only components that are actually
    quoted — never a zero placeholder, since a missing market and a line of zero mean
    very different things.
    """
    lines = {}
    for key in COMPONENT_POINTS:
        vals = [player.get(f'{b}_{key}') for b in ('dk', 'ud')]
        vals = [float(v) for v in vals if v is not None]
        if vals:
            lines[key] = sum(vals) / len(vals)
    return lines


def _prop_correction(player: dict, scale: float) -> tuple:
    """
    Points delta implied by moving each projected component onto its market line.

    `scale` rescales Sleeper's components to the consensus total so the correction is
    applied against the same basis as the projection it is adjusting.

    Returns (delta_points, components_corrected).
    """
    lines = _market_lines(player)
    if not lines:
        return 0.0, []

    delta = 0.0
    used  = []

    for key, line in lines.items():
        pts = COMPONENT_POINTS.get(key)
        if pts is None:
            continue
        projected = (player.get(f'proj_{key}') or 0) * scale
        # A component the projection has at zero gives us no basis for comparison —
        # scaling from zero is undefined, and books quote plenty of players Sleeper
        # projects nothing for.
        if projected <= 0:
            continue
        delta += (line - projected) * pts
        used.append(key)

        # Volume spillover into the unquoted receptions market.
        if key == 'rec_yd':
            proj_rec = (player.get('proj_rec') or 0) * scale
            if proj_rec > 0:
                ratio = line / projected
                delta += proj_rec * (ratio - 1.0) * RECEPTION_PROPAGATION * COMPONENT_POINTS['rec']

    return delta, used


def _build(force_refresh: bool = False) -> list:
    from app.analysis import get_analysis_data

    players = get_analysis_data(force_refresh=force_refresh)
    out = []

    for p in players:
        pos = p.get('pos')
        if pos not in POS_SCORING_CV:
            continue

        # Consensus season PPR across whatever sources are populated
        # (Sleeper / FantasyPros / Yahoo). Falls back to Sleeper alone.
        ppr = p.get('consensus_ppr') or p.get('proj_pts_ppr') or 0
        if ppr <= 0:
            out.append({
                'id': p.get('player_id'), 'pos': pos,
                'proj_dk': None, 'ppg': None, 'sd': None, 'ceiling': None,
                'sources': 0,
            })
            continue

        sources = sum(1 for k in ('proj_pts_ppr', 'fp_pts_ppr',
                                  'yahoo_pts_ppr', 'espn_pts_ppr')
                      if (p.get(k) or 0) > 0)

        # Projected games. Sleeper publishes this; fall back to a full season.
        # Clamped to 17 — see MAX_GAMES.
        games = p.get('proj_gp') or 0
        if games <= 0:
            games = MAX_GAMES
        games = min(games, MAX_GAMES)

        # Scale Sleeper's component yardage up/down to the consensus total.
        sleeper_ppr = p.get('proj_pts_ppr') or 0
        scale = (ppr / sleeper_ppr) if sleeper_ppr > 0 else 1.0
        # Guard against a wild ratio when one source is an outlier.
        scale = max(0.5, min(2.0, scale))

        # Market correction, applied to the PPR total before DK bonuses so the bonus
        # estimate is computed off market-corrected yardage.
        prop_delta, prop_used = _prop_correction(p, scale)
        if prop_delta:
            cap        = ppr * MAX_PROP_SHIFT
            prop_delta = max(-cap, min(cap, prop_delta))
            ppr        = max(0.0, ppr + prop_delta)
            # Re-derive the component scale so bonus estimation matches the corrected total.
            scale = max(0.5, min(2.0, (ppr / sleeper_ppr) if sleeper_ppr > 0 else 1.0))

        bonus   = _dk_bonus_points(p, games, scale)
        proj_dk = ppr + bonus

        ppg = proj_dk / games
        sd  = ppg * POS_SCORING_CV[pos]

        out.append({
            'id':          p.get('player_id'),
            'pos':         pos,
            'proj_ppr':    round(ppr, 1),
            'prop_delta':  round(prop_delta, 1),
            'prop_markets': prop_used,
            'dk_bonus':    round(bonus, 1),
            'proj_dk':     round(proj_dk, 1),
            'games':       round(games, 1),
            'ppg':         round(ppg, 2),
            'sd':          round(sd, 2),
            'ceiling':     round(ppg + CEILING_Z * sd, 2),
            # Probability this player is active in a given non-bye week.  Takes the
            # position prior unless the projection itself forecasts a short season
            # (a known injury or suspension), in which case that governs.
            'avail':       round(min(games / MAX_GAMES, 1 - POS_INJURY_RATE[pos]), 3),
            'upside':      p.get('upside'),
            'trajectory':  p.get('trajectory'),
            'consensus_rank':   p.get('consensus_rank'),
            'consensus_label':  p.get('consensus_label'),
            # A market correction is independent evidence, not just another
            # fantasy-industry opinion, so it counts toward source confidence — which
            # is what decides how heavily the recommender leans on ECR as a sanity
            # blend.  Reported separately so the UI can still show true source count.
            'sources':          sources + (1 if prop_used else 0),
            'proj_sources':     sources,
        })

    return out


def get_projections(force_refresh: bool = False) -> dict:
    """
    Return {'players': [...], 'generated_at': ts, 'stale': bool}.

    Cached to disk so a cold process on Render doesn't block the draft page on a
    ~20s Sleeper fetch. Serves stale cache rather than nothing if the fetch fails —
    mid-draft, out-of-date projections beat no projections.
    """
    cached = None
    try:
        with open(CACHE_PATH) as f:
            cached = json.load(f)
    except Exception:
        pass

    fresh = (cached and not force_refresh
             and (time.time() - cached.get('generated_at', 0)) < CACHE_TTL)
    if fresh:
        return {**cached, 'stale': False}

    try:
        players = _build(force_refresh=force_refresh)
        payload = {'players': players, 'generated_at': time.time()}
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
        with open(CACHE_PATH, 'w') as f:
            json.dump(payload, f)
        return {**payload, 'stale': False}
    except Exception as e:
        if cached:
            return {**cached, 'stale': True, 'error': str(e)}
        raise
