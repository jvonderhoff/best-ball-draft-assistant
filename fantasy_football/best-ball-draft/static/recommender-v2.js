// Draft recommendation engine — V2 (projection-based)
//
// V1 (recommender.js) scores players as 1000/adp and layers ~8 hand-tuned multipliers
// on top.  Two structural problems drove this rewrite:
//
//   1. The 1000/adp curve is hyperbolic, so a multiplier's real-world aggression
//      scales with ADP.  A x1.55 stack bonus moves a player 7 picks at ADP 20 but
//      71 picks at ADP 200.  Early rounds were near-pure ADP; late rounds were
//      almost entirely stack/need-driven.  That was an accident of the curve.
//   2. Nothing in V1 knew how many points anyone was projected to score.
//
// V2 works on a linear points-per-week scale, so every adjustment means the same
// thing in round 2 as in round 18, and every number below is interpretable as
// "expected DK points per week."
//
// ── The objective ────────────────────────────────────────────────────────────
// DK Best Ball Millions is two different contests bolted together:
//
//   Weeks 1-14   cumulative points, top 2 of 12 advance   -> accumulation
//   Week 15      single week, top 1 of 12 advances        -> spike
//   Week 16      single week, top 1 of 12 advances        -> spike
//   Week 17      single week, 1,089-team final, $3M       -> extreme spike
//
// The first phase rewards a high floor across 14 weeks.  The last three reward
// being the single highest score in your pod on one specific Sunday, which is a
// ceiling problem — the mean barely matters.  V2 scores both and blends them.
//
// ── The core idea ────────────────────────────────────────────────────────────
// Best ball counts the MAX of your roster at each slot every week.  So a player's
// value is not his projection — it's how much he raises your weekly optimum above
// what you already have.  For a candidate with weekly mean m and SD s competing
// against a current slot-holder worth c:
//
//     marginal gain = s * phi(z) + (m - c) * Phi(z),   z = (m - c) / s
//
// That single formula (the expectation of max(X, c) minus c) replaces V1's QB
// emergency boost, TE targets, position caps and over-allocation penalties.  It
// falls out automatically:
//   - 0 QBs rostered -> c = 0 -> gain is the QB's full weekly output (huge)
//   - 3 elite WRs rostered -> c is high -> the 4th WR's gain is small
//   - a high-variance bench flier still scores, via the s * phi(z) term, because
//     best ball only needs him to spike once
//
// ── Opportunity cost ─────────────────────────────────────────────────────────
// Raw marginal gain would always take the best available player.  What actually
// matters is gain relative to who survives to your NEXT pick — Value Over Next
// Available.  We model each player's survival with a noisy-ADP distribution and
// subtract the expected best survivor at that position.  VONA subsumes V1's
// positionalAdpCliff, waitabilityInfo and capitalAllocationInfo into one number,
// and it is the reason V2 won't spend round 1 on a QB even though a QB's raw
// marginal gain is the largest on the board: plenty of near-equal QBs survive,
// so QB VONA is tiny, while elite WR VONA is not.

// ── Format (DraftKings Best Ball, full PPR) ───────────────────────────────────
const V2_DRAFT_ROUNDS = 20;

// Weekly starting lineup: 1 QB, 2 RB, 3 WR, 1 TE, 1 FLEX.
// The FLEX is split by how often each position actually wins it in full PPR —
// DK's full point-per-reception and 100-yard bonuses make it a WR slot most weeks.
const V2_STARTER_SLOTS = { QB: 1.0, RB: 2.3, WR: 3.6, TE: 1.1 };

// Soft roster targets (the modal DK 3-6-8-3 build).  These are guardrails only —
// marginal gain and VONA drive the actual shape of the roster.
const V2_ROSTER_TARGETS = { QB: 3, RB: 6, WR: 8, TE: 3 };
const V2_MAX_ROSTER     = { QB: 3, RB: 8, WR: 11, TE: 4 };

// Phase weights.  Weeks 15-17 are three single-week knockouts worth essentially
// the entire prize pool, so ceiling is weighted above accumulation — but you have
// to survive weeks 1-14 first, so accumulation keeps real weight.
// Overridable from the environment so tools/compare-models.js can sweep them.
// `process` is undefined in the browser, so this is inert there.
const _v2env = (typeof process !== 'undefined' && process.env) ? process.env : {};
const V2_W_ACCUMULATION = _v2env.V2_W_ACC ? parseFloat(_v2env.V2_W_ACC) : 0.40;
const V2_W_PLAYOFF      = _v2env.V2_W_PO  ? parseFloat(_v2env.V2_W_PO)  : 0.60;

// How far above a lineup slot's normal output it has to land to win a knockout week,
// in units of the position's typical starter SD.  This is what makes weeks 15-17 a
// ceiling problem rather than a mean problem.
const V2_SPIKE_Z = 1.0;

// Chance a given player is on bye in a given week of the 14-week accumulation phase.
// Every team has exactly one bye inside that window.
const V2_BYE_RATE = 1 / 14;

// Same-team / same-game correlation coefficients for weekly fantasy scoring.
// QB-to-his-own-WR1 is the strongest routinely available correlation in football;
// two WRs on one team partly cannibalise each other but share game environment.
const V2_CORRELATION = {
  qbPassCatcher:   0.42,   // QB <-> his WR/TE
  passCatcherPair: 0.12,   // two pass-catchers, same team
  qbRb:            0.06,   // QB <-> his own RB (mildly negative game-script, positive volume)
  opposingGame:    0.20,   // players on opposite sides of the same game (shootout)
};

// Scales correlation into points-per-week so a stack is a nudge, not a 60-pick reach.
// Every source is explicit that you should not reach far to complete a stack.
const V2_CORRELATION_WEIGHT = _v2env.V2_CORR ? parseFloat(_v2env.V2_CORR) : 0.35;

// Correlation is only paid on the first 3 pass-catchers tied to one QB.  Past
// QB + 3, you are guaranteeing wasted roster spots on most weeks.
const V2_MAX_STACK_PARTNERS = 3;

// Playoff-week correlation is worth more than regular-season correlation: in a
// win-the-week format you need your whole team to spike simultaneously.
const V2_PLAYOFF_STACK_MULTIPLIER = 1.8;

// Pod size. Used to work out how many players at a position the rest of the league
// will still take, which sets the replacement baseline below.
const V2_NUM_TEAMS = 12;

// How the value baseline is split between two different questions:
//
//   VOR  (weight 1 - V2_TIMING_WEIGHT)  "how much better is he than a body I can get
//                                        at this position at the end of the draft?"
//   VONA (weight V2_TIMING_WEIGHT)      "how much better is he than what survives to
//                                        my next pick?"
//
// VONA alone does not work, and the failure is instructive: it is a *timing* signal,
// not a value signal.  It measures which position degrades fastest between now and
// your next turn, so whichever position wins that question gets stockpiled no matter
// how few lineup slots can absorb it.  Run on pure VONA the model piled up receivers;
// with the horizon corrected it piled up tight ends instead — the bias moved, it did
// not go away.  VOR is scaled against a fixed replacement level and is therefore
// comparable across positions, which is what stops the stockpiling; VONA is kept as a
// tilt because when the next tier really is about to disappear, that matters.
const V2_TIMING_WEIGHT = _v2env.V2_TIMING ? parseFloat(_v2env.V2_TIMING) : 0.35;

// How hard to anchor on market ADP.
//
// This turned out to be the single most important constant in the model, and the
// reason is worth recording.  ADP is thousands of drafters' collective answer to the
// roster-construction problem in this exact format — it is not merely a price signal,
// it carries positional-value information that the slot math above is trying to
// re-derive from first principles using a dozen hand-set parameters (starter slots,
// per-position CVs, spike threshold, availability, replacement depth).
//
// With this term weak, every baseline formulation produced a lopsided roster: pure
// VONA stockpiled receivers, a corrected horizon stockpiled tight ends, a VOR blend
// starved running backs.  The bias kept moving because the slot math has no anchor
// telling it what a position is worth in the aggregate.  ADP is that anchor.
//
// Swept against the slot-attribution harness, weeks 1-14 points versus V1:
//   0.25 -> -143    1.0 -> -80    2.5 -> -41    4.0 -> +22    5.0 -> +30    8.0 -> +36
// Anything from ~4 upward wins; the differences across that range are inside the
// harness's noise, so this is set mid-range rather than at the sampled maximum, to
// avoid fitting the simulator.
const V2_MARKET_PULL = _v2env.V2_MKT ? parseFloat(_v2env.V2_MKT) : 5.0;

// ADP noise.  Players do not come off the board exactly at ADP; the spread grows
// roughly proportionally as you get deeper into the draft.
const V2_ADP_SIGMA_FLOOR = 5.0;
const V2_ADP_SIGMA_RATIO = 0.30;

// How much weight to give consensus rankings (ECR / your custom board) as a
// sanity check against the point projections.  Higher when only one projection
// source is populated, since a single source can be an outlier.
const V2_ECR_WEIGHT_SINGLE_SOURCE = 0.30;
const V2_ECR_WEIGHT_MULTI_SOURCE  = 0.15;
const V2_CUSTOM_RANK_WEIGHT       = 0.35;

// ── Math helpers ──────────────────────────────────────────────────────────────

function v2NormPdf(z) {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

// Abramowitz & Stegun 7.1.26 — accurate to ~1.5e-7, far beyond what we need.
function v2Erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 =  0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function v2NormCdf(z) {
  return 0.5 * (1 + v2Erf(z / Math.SQRT2));
}

// E[max(X - Y, 0)] for independent normals X ~ N(mean, sd), Y ~ N(barMean, barSd).
//
// This is the heart of the model: how much this player adds to your weekly optimum,
// given he only counts in the weeks he beats the incumbent holding that lineup slot.
//
// The incumbent Y is a *random variable*, not a constant, and that matters enormously.
// If the bar were a fixed number, the 9th WR would still look useful — he'd clear a
// static bar sometimes.  But the player he must beat is himself the best of a growing
// pile of rostered WRs, so the bar rises (and gets less beatable) with every body you
// add.  Modelling Y as random is what produces correct diminishing returns and stops
// the model from stockpiling one position.
function v2MarginalGain(mean, sd, barMean, barSd = 0) {
  const theta = Math.sqrt(sd * sd + barSd * barSd);
  if (!(theta > 0)) return Math.max(0, mean - barMean);
  const alpha = (mean - barMean) / theta;
  return theta * v2NormPdf(alpha) + (mean - barMean) * v2NormCdf(alpha);
}

// Deterministic RNG — recommendations must not jitter between renders.
function v2Rng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const V2_ORDER_STAT_DRAWS = 240;

// ── Player projection resolution ──────────────────────────────────────────────

// Blend the point projection with rank-based consensus (ECR, and your custom board
// if you have one).  Ranks are converted to points by reading off the projection
// curve at that rank within the position — so "ECR says he's the WR12" becomes
// "the WR12 is worth about this many points."
//
// This matters right now because the projection blend is effectively single-source
// (FantasyPros / Yahoo / prop tables are empty until they refresh), and one source
// on one player can be badly wrong.
function v2BuildRankCurves(players) {
  const curves = {};
  for (const pos of Object.keys(V2_STARTER_SLOTS)) {
    const atPos = players
      .filter(p => p.pos === pos && p._proj && p._proj.ppg > 0)
      .sort((a, b) => b._proj.ppg - a._proj.ppg)
      .map(p => p._proj.ppg);
    curves[pos] = atPos;
  }
  return curves;
}

function v2CurveLookup(curve, rank) {
  if (!curve || !curve.length || !rank) return null;
  const i = Math.min(curve.length - 1, Math.max(0, Math.round(rank) - 1));
  return curve[i];
}

// Attach an effective (mean, sd, ceiling) to each player, blending projections
// with rank signals.  Players with no projection at all fall back to an
// ADP-implied estimate so they still order sensibly instead of dropping to zero.
function v2AttachEffective(players, projMap, opts = {}) {
  const customRankMap = opts.customRankMap || {};

  for (const p of players) {
    p._proj = projMap[p.id] || null;
  }

  const curves = v2BuildRankCurves(players);

  // Positional rank implied by raw ADP, used to estimate players with no projection.
  const adpRankByPos = {};
  for (const pos of Object.keys(V2_STARTER_SLOTS)) {
    adpRankByPos[pos] = players
      .filter(p => p.pos === pos)
      .sort((a, b) => (a.realAdp ?? a.adp ?? 9999) - (b.realAdp ?? b.adp ?? 9999));
  }

  // ecr_rank and custom ranks are OVERALL ranks; the projection curves are indexed
  // by rank *within* a position.  Convert by ordering each position's players by
  // the overall rank and taking their sequence number.
  const rankToPosRank = (rankOf) => {
    const out = new Map();
    for (const pos of Object.keys(V2_STARTER_SLOTS)) {
      players
        .filter(p => p.pos === pos && rankOf(p) != null)
        .sort((a, b) => rankOf(a) - rankOf(b))
        .forEach((p, i) => out.set(p, i + 1));
    }
    return out;
  };
  const ecrPosRank    = rankToPosRank(p => p.ecr_rank ?? null);
  const customPosRank = rankToPosRank(p => customRankMap[p.id] ?? null);

  for (const p of players) {
    const pos   = p.pos;
    const curve = curves[pos];
    const proj  = p._proj;

    let mean, sd, sources, avail = 1;

    if (proj && proj.ppg > 0) {
      mean    = proj.ppg;
      sd      = proj.sd;
      sources = proj.sources || 1;
      avail   = proj.avail ?? 1;
    } else {
      // No projection — estimate from where the market ranks him at his position.
      const list    = adpRankByPos[pos] || [];
      const posRank = list.indexOf(p) + 1;
      const est     = v2CurveLookup(curve, posRank);
      if (est == null) { p._eff = null; continue; }
      mean    = est * 0.92;   // unprojected players skew toward the downside
      sd      = est * 0.70;
      sources = 0;
      avail   = 0.80;         // no projection usually means a fringe/injury-risk body
    }

    // Rank-based sanity blend.  A single projection source can be badly wrong on
    // an individual player; expert consensus rank is an independent read.
    let blended = mean;
    let wUsed   = 0;

    const ecrPts = v2CurveLookup(curve, ecrPosRank.get(p));
    if (ecrPts != null && sources > 0) {
      const w = sources >= 2 ? V2_ECR_WEIGHT_MULTI_SOURCE : V2_ECR_WEIGHT_SINGLE_SOURCE;
      blended = blended * (1 - w) + ecrPts * w;
      wUsed   = w;
    }

    // Your own board, when you've set one, gets the heaviest rank weight —
    // it is the only signal here that reflects information the market may not have.
    const customPts = v2CurveLookup(curve, customPosRank.get(p));
    if (customPts != null) {
      blended = blended * (1 - V2_CUSTOM_RANK_WEIGHT) + customPts * V2_CUSTOM_RANK_WEIGHT;
    }

    p._eff = {
      mean:    blended,
      sd:      sd,
      ceiling: blended + 1.2816 * sd,
      sources: sources,
      avail:   avail,
      ecrWeight: wUsed,
      customRanked: customPts != null,
      projected: !!(proj && proj.ppg > 0),
    };
  }

  return players;
}

// ── Lineup bar: what does this player have to beat? ───────────────────────────

// Moments of the k-th best weekly score among the players you already own at a
// position — the bar a new player has to clear to earn that lineup slot.
//
// Estimated by simulation rather than closed form: order statistics of a set of
// normals with different means and SDs have no clean analytic form, and this only
// runs once per position per pick (not once per candidate), so it is cheap.
//
// Availability is the important part.  An earlier version assumed every rostered
// player suits up every week, which is what let the model carry four running backs
// against two mandatory RB slots.  Each player is instead drawn as absent with his
// own probability (bye week plus a position injury rate), and an absent player
// contributes nothing.  With ten receivers, one absence barely moves the third-best
// score; with four running backs it routinely empties a starting slot, which drops
// the bar, which raises the marginal value of adding depth.  That is the entire
// mechanism by which a thin position asks for more bodies.
//
// k > roster count means the slot is currently empty, so the bar is zero.
function v2OrderStatMoments(pos, myTeam, k, mode) {
  const owned = myTeam.filter(p => p.pos === pos && p._eff);
  if (owned.length < k) return { mean: 0, sd: 0 };

  // Byes only exist in the weeks 1-14 accumulation phase; the knockout weeks are
  // past the bye schedule entirely.
  const byeRate = mode === 'spike' ? 0 : V2_BYE_RATE;

  const rng = v2Rng(0x9E3779B9 ^ (owned.length * 31 + k * 7 + (mode === 'spike' ? 3 : 0)));
  const draws = new Array(V2_ORDER_STAT_DRAWS);

  for (let d = 0; d < V2_ORDER_STAT_DRAWS; d++) {
    const week = owned.map(p => {
      const avail = (p._eff.avail ?? 1) * (1 - byeRate);
      if (rng() > avail) return 0;
      // Box-Muller
      let u = rng(); if (u === 0) u = 1e-9;
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
      return Math.max(0, p._eff.mean + z * p._eff.sd);
    });
    week.sort((a, b) => b - a);
    draws[d] = week[k - 1];
  }

  const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
  const varr = draws.reduce((a, b) => a + (b - mean) ** 2, 0) / draws.length;
  return { mean, sd: Math.sqrt(varr) };
}

// The marginal gain of adding a player at `pos`, accounting for how many starting
// slots that position has and who already occupies them.
//
// A fractional slot count (WR is 3.6 — three dedicated slots plus most of the FLEX)
// is handled by blending the gain against the two adjacent order statistics.
//
// mode 'accum'  -> weeks 1-14.  Every point counts toward a 14-week total, so the
//                  bar is simply the incumbent's weekly output.
// mode 'spike'  -> weeks 15-17.  You are not accumulating, you are trying to be the
//                  single highest score in a 12-team pod on one Sunday.  An average
//                  week from this slot is worth nothing; only a big one wins.  So the
//                  bar is raised by a spike requirement.
//
// Both modes use the player's true (mean, sd).  An earlier version evaluated the
// spike mode at the player's *ceiling* while also keeping his full sd, which counted
// variance twice, inflated the playoff term to ~2x the accumulation term's scale, and
// systematically favoured whichever position had the highest CV (tight end).  Raising
// the bar instead of inflating the player keeps both terms on the same points scale
// and still rewards high-variance players — they clear a high bar more often — but
// only once.
function v2PositionGain(pos, mean, sd, myTeam, mode, ctx = null, avail = 1) {
  const slots = V2_STARTER_SLOTS[pos] || 1;
  const lo    = Math.floor(slots);
  const hi    = lo + 1;
  const frac  = slots - lo;

  // Cached per position AND mode — the bars differ between phases, since byes exist
  // in weeks 1-14 but not in the knockout weeks.
  const barCache = ctx && ctx.barCache;
  const cacheKey = `${pos}|${mode}`;
  let bars = barCache && barCache[cacheKey];
  if (!bars) {
    bars = {
      lo: v2OrderStatMoments(pos, myTeam, lo, mode),
      hi: v2OrderStatMoments(pos, myTeam, hi, mode),
    };
    if (barCache) barCache[cacheKey] = bars;
  }

  // How much a slot has to beat its own norm to win a knockout week.  Sized off the
  // typical starter SD at the position so an empty slot still demands a real spike —
  // filling week 17's TE slot with a low-ceiling body does not win a 12-team pod.
  let offset = 0;
  if (mode === 'spike') {
    const typicalSd = (ctx && ctx.typicalSd && ctx.typicalSd[pos]) || sd;
    offset = V2_SPIKE_Z * typicalSd;
  }

  const gLo = v2MarginalGain(mean, sd, bars.lo.mean + offset, bars.lo.sd);
  const gHi = v2MarginalGain(mean, sd, bars.hi.mean + offset, bars.hi.sd);

  // A player only helps in the weeks he actually plays.
  const byeRate  = mode === 'spike' ? 0 : V2_BYE_RATE;
  const playRate = avail * (1 - byeRate);

  return { gain: (gLo * (1 - frac) + gHi * frac) * playRate, bars, offset };
}

// ── Survival modelling ────────────────────────────────────────────────────────

// P(this player is still on the board at `pick`), from noisy ADP.
function v2SurvivalProb(player, pick) {
  const adp = player.realAdp ?? player.adp;
  if (!adp || !pick) return 0.5;
  const sigma = Math.max(V2_ADP_SIGMA_FLOOR, V2_ADP_SIGMA_RATIO * adp);
  return 1 - v2NormCdf((pick - adp) / sigma);
}

// The pick this position's replacement level is measured at.
//
// Deciding between player P and player Q at this pick is a pairwise swap: taking P now
// and Q later versus Q now and P later differ by
//
//     [P_now - P_later] - [Q_now - Q_later]
//
// so the correct quantity per position is the drop-off between now and the NEXT time
// you pick.  That is one-step VONA, and it is what this returns.
//
// A previous version scaled the horizon by how many bodies the position still needed
// (target minus rostered), reaching further down the board for positions with bigger
// targets.  That was not derived from anything — and because WR carries the largest
// target, it handed WR the lowest replacement level and therefore the highest VONA at
// every pick.  Slot-level attribution showed the damage: the model won the receiver
// slots by 71 points a season and lost 82 at running back and 28 at quarterback,
// because it never spent an early pick on the two positions with mandatory starters.
function v2ReplacementHorizon(pos, myTeam, ctx) {
  return ctx.nextMyPick;
}

// Expected marginal gain of the best player at `pos` who survives to `nextPick`.
// Walks candidates best-gain-first: the first one to survive is the one you'd take.
function v2ExpectedBestSurvivor(pos, available, myTeam, nextPick, mode, ctx) {
  if (nextPick == null) return 0;

  const candidates = available
    .filter(p => p.pos === pos && p._eff)
    .map(p => ({
      gain: v2PositionGain(pos, p._eff.mean, p._eff.sd, myTeam, mode, ctx, p._eff.avail ?? 1).gain,
      surv: v2SurvivalProb(p, nextPick),
    }))
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 25);

  let expected = 0;
  let allGoneP = 1;
  for (const c of candidates) {
    expected += c.gain * c.surv * allGoneP;
    allGoneP *= (1 - c.surv);
    if (allGoneP < 0.001) break;
  }
  return expected;
}

// ── Correlation ───────────────────────────────────────────────────────────────

function v2HasRealTeam(p) {
  return p.team && p.team !== 'FA';
}

function v2SamePlayoffGame(p1, p2, week) {
  const key = `week${week}`;
  return (p1[key] && p1[key] === p2.team) || (p2[key] && p2[key] === p1.team);
}

// Correlation value in points-per-week.  Proportional to the SD of the weaker
// partner: correlation is only worth something if both players can actually spike.
//
// Returns { regular, playoff, notes }
function v2CorrelationValue(player, myTeam) {
  const notes = [];
  if (!v2HasRealTeam(player) || !player._eff) return { regular: 0, playoff: 0, notes };

  let regular = 0;
  let playoff = 0;
  const sdMe = player._eff.sd;

  const sameTeam = myTeam.filter(m => v2HasRealTeam(m) && m.team === player.team && m._eff);
  const myQBs    = sameTeam.filter(m => m.pos === 'QB');
  const myCatch  = sameTeam.filter(m => ['WR', 'TE'].includes(m.pos));

  const pair = (rho, partner, label) => {
    const v = rho * Math.min(sdMe, partner._eff.sd) * V2_CORRELATION_WEIGHT;
    regular += v;
    notes.push(`${label} ${partner.name.split(' ').pop()}`);
    return v;
  };

  // Every correlation bonus below is gated on this: once you already have
  // V2_MAX_STACK_PARTNERS pass-catchers from a team, additional ones from that same
  // team are not a stack, they are a concentration.  Without this gate the bonus
  // becomes the dominant term in late rounds — VONA differences there are ~0.05
  // points while a correlation bonus is ~1.2 — and the model piles most of the
  // roster onto two or three NFL teams.
  const stackRoom = myCatch.length < V2_MAX_STACK_PARTNERS;

  if (['WR', 'TE'].includes(player.pos)) {
    // Pass-catcher joining a QB you own — the primary best-ball stack.
    if (myQBs.length && stackRoom) {
      pair(V2_CORRELATION.qbPassCatcher, myQBs[0], 'stacks w/');
    }
    // Pass-catcher on a team whose QB you don't own — weaker, shared game
    // environment only.
    if (stackRoom) {
      for (const c of myCatch) {
        regular += V2_CORRELATION.passCatcherPair * Math.min(sdMe, c._eff.sd) * V2_CORRELATION_WEIGHT;
      }
      if (!myQBs.length && myCatch.length) notes.push(`${player.team} receiver room`);
    }
  }

  if (player.pos === 'QB') {
    // Bring-back: you already own this QB's pass-catchers.
    for (const c of myCatch.slice(0, V2_MAX_STACK_PARTNERS)) {
      pair(V2_CORRELATION.qbPassCatcher, c, 'completes stack w/');
    }
  }

  if (player.pos === 'RB' && myQBs.length) {
    regular += V2_CORRELATION.qbRb * Math.min(sdMe, myQBs[0]._eff.sd) * V2_CORRELATION_WEIGHT;
  }

  // Playoff game stacks — both sides of one week 15/16/17 game.  Weighted far
  // more heavily than regular-season correlation because those weeks are
  // win-or-go-home, and week 17 is the final.
  const weekWeight = { 17: 1.6, 16: 1.0, 15: 0.9 };
  for (const week of [17, 16, 15]) {
    const partners = myTeam.filter(m => m._eff && v2SamePlayoffGame(player, m, week));
    for (const partner of partners) {
      playoff += V2_CORRELATION.opposingGame
               * Math.min(sdMe, partner._eff.sd)
               * V2_CORRELATION_WEIGHT
               * V2_PLAYOFF_STACK_MULTIPLIER
               * weekWeight[week];
    }
    if (partners.length) {
      notes.push(`Wk${week} game stack w/ ${partners.map(p => p.name.split(' ').pop()).join(', ')}`);
    }
  }

  return { regular, playoff, notes };
}

// Fraction of the three knockout weeks in which this player's team actually has a
// game.  Free agents (and anyone with no scheduled playoff-week opponent) are worth
// nothing in exactly the weeks that pay.
function v2PlayoffAvailability(player) {
  const weeks = ['week15', 'week16', 'week17'].filter(w => player[w]);
  if (!weeks.length) return v2HasRealTeam(player) ? 1.0 : 0.35;
  return weeks.length / 3;
}

// ── Bye weeks ─────────────────────────────────────────────────────────────────
// Only relevant to the weeks 1-14 accumulation phase (NFL byes are done by week 14).
// It matters most at QB and TE, where you roster 3 and start 1 — a week with zero
// healthy options at the position is a guaranteed zero in that slot.
function v2ByePenalty(player, myTeam) {
  if (!player.bye || !player._eff) return { penalty: 0, note: null };
  const pos   = player.pos;
  if (!['QB', 'TE'].includes(pos)) return { penalty: 0, note: null };

  const atPos = myTeam.filter(p => p.pos === pos && p._eff);
  if (!atPos.length) return { penalty: 0, note: null };

  // Would every player at this position share a bye week after this pick?
  const allShare = atPos.every(p => p.bye === player.bye);
  if (!allShare) return { penalty: 0, note: null };

  // Cost is roughly one blanked week of the slot, amortised over the 14-week phase.
  const penalty = player._eff.mean / 14;
  return { penalty, note: `all your ${pos}s share bye wk${player.bye}` };
}

// ── Structural guardrails ─────────────────────────────────────────────────────
// Marginal gain already self-regulates roster shape, so these only catch the
// extremes: blowing past a sane position cap, or ending the draft with an
// unusable roster.
function v2StructuralPenalty(player, myTeam) {
  const pos   = player.pos;
  const have  = myTeam.filter(p => p.pos === pos).length;
  const round = myTeam.length + 1;
  const left  = V2_DRAFT_ROUNDS - myTeam.length;

  let penalty = 0;
  const notes = [];

  if (have >= (V2_MAX_ROSTER[pos] ?? Infinity)) {
    penalty += 3.0;
    notes.push(`already ${have} ${pos} (cap ${V2_MAX_ROSTER[pos]})`);
  }

  // Team concentration.  Correlation bonuses actively push toward stacking, so
  // something has to push back: a roster stacked onto three NFL teams shares their
  // bye weeks in the accumulation phase and collapses entirely if those offences
  // underperform.  Past four players from one team the downside outweighs the
  // correlation, and it compounds from there.
  const fromTeam = myTeam.filter(p => p.team && p.team === player.team).length;
  if (fromTeam >= 4) {
    penalty += 1.5 * (fromTeam - 3);
    notes.push(`${fromTeam} players already from ${player.team}`);
  }

  // Endgame: make sure the roster is legal and playable.  If the picks remaining
  // exactly cover the positions still missing a minimum body, force those.
  const MINIMUMS = { QB: 2, RB: 4, WR: 5, TE: 2 };
  let mustFill = 0;
  for (const [p, min] of Object.entries(MINIMUMS)) {
    mustFill += Math.max(0, min - myTeam.filter(m => m.pos === p).length);
  }
  const myShort = Math.max(0, (MINIMUMS[pos] || 0) - have);
  if (mustFill >= left && myShort === 0) {
    penalty += 6.0;
    notes.push(`must fill other positions — ${left} picks left, ${mustFill} slots to cover`);
  }

  return { penalty, notes };
}

// ── Core value calculation ────────────────────────────────────────────────────

// Precompute the per-position replacement expectations once per pick rather than
// once per candidate — they depend only on position, roster and next pick.
function buildV2Context(available, myTeam, myPickNumber, nextMyPick, myPicks = null) {
  // barCache holds the order-statistic moments per position — they depend only on
  // the current roster, so they are computed once per pick, not once per candidate.
  const ctx = {
    nextMyPick, myPickNumber, myPicks,
    replAccum: {}, replSpike: {}, barCache: {}, typicalSd: {}, horizon: {}, replDepth: {},
  };

  // Typical starter SD per position, used to size the knockout-week spike bar.
  // Taken from the best remaining players at each position rather than the whole
  // pool, so deep late-round noise doesn't drag it around.
  for (const pos of Object.keys(V2_STARTER_SLOTS)) {
    const sds = available
      .filter(p => p.pos === pos && p._eff)
      .sort((a, b) => b._eff.mean - a._eff.mean)
      .slice(0, 24)
      .map(p => p._eff.sd);
    ctx.typicalSd[pos] = sds.length ? sds.reduce((a, b) => a + b, 0) / sds.length : 0;
  }

  const roundsLeft = Math.max(1, V2_DRAFT_ROUNDS - myTeam.length);

  for (const pos of Object.keys(V2_STARTER_SLOTS)) {
    const horizon = v2ReplacementHorizon(pos, myTeam, ctx);
    ctx.horizon[pos] = horizon;

    // Timing baseline: the best player at this position likely to survive to my next pick.
    const survAccum = v2ExpectedBestSurvivor(pos, available, myTeam, horizon, 'accum', ctx);
    const survSpike = v2ExpectedBestSurvivor(pos, available, myTeam, horizon, 'spike', ctx);

    // Value baseline: the player at this position who will still be there once the
    // league has taken everyone it is going to take.  Depth shrinks as the draft
    // runs down, so late in the draft the baseline correctly rises toward what is
    // actually left on the board.
    const depth = Math.max(1, Math.round(
      (V2_ROSTER_TARGETS[pos] || 1) * V2_NUM_TEAMS * (roundsLeft / V2_DRAFT_ROUNDS)
    ));
    const atPos = available
      .filter(p => p.pos === pos && p._eff)
      .sort((a, b) => b._eff.mean - a._eff.mean);
    const repl = atPos.length ? atPos[Math.min(depth, atPos.length - 1)] : null;

    const vorAccum = repl
      ? v2PositionGain(pos, repl._eff.mean, repl._eff.sd, myTeam, 'accum', ctx, repl._eff.avail ?? 1).gain : 0;
    const vorSpike = repl
      ? v2PositionGain(pos, repl._eff.mean, repl._eff.sd, myTeam, 'spike', ctx, repl._eff.avail ?? 1).gain : 0;

    const w = V2_TIMING_WEIGHT;
    ctx.replAccum[pos] = vorAccum * (1 - w) + survAccum * w;
    ctx.replSpike[pos] = vorSpike * (1 - w) + survSpike * w;
    ctx.replDepth[pos] = depth;
  }
  return ctx;
}

// Returns a score in expected DK points per week.  Positive means this pick raises
// your weekly optimum more than the best player at his position who is likely to
// survive until your next turn.
//
// bd (breakdown): optional array — each contribution is pushed as
// { label, points, note } so the UI can explain the score.
function calculateValueV2(player, myPickNumber, myTeam, nextMyPick = null, available = [], bd = null, ctx = null, myPicks = null) {
  if (!player._eff) return -999;

  const eff = player._eff;
  const pos = player.pos;
  if (!ctx) ctx = buildV2Context(available, myTeam, myPickNumber, nextMyPick, myPicks);

  const add = (points, label, note) => {
    if (bd && Math.abs(points) > 0.005) bd.push({ label, points, note });
    return points;
  };

  // ── Accumulation value (weeks 1-14) ────────────────────────────────────────
  const rAcc    = v2PositionGain(pos, eff.mean, eff.sd, myTeam, 'accum', ctx, eff.avail ?? 1);
  const vonaAcc = rAcc.gain - (ctx.replAccum[pos] || 0);

  // ── Playoff value (weeks 15-17) ────────────────────────────────────────────
  const rSpk    = v2PositionGain(pos, eff.mean, eff.sd, myTeam, 'spike', ctx, eff.avail ?? 1);
  const vonaSpk = (rSpk.gain - (ctx.replSpike[pos] || 0)) * v2PlayoffAvailability(player);

  let score = 0;
  score += add(V2_W_ACCUMULATION * vonaAcc, 'Accumulation (wk 1-14)',
               `${eff.mean.toFixed(1)} ppg, adds ${rAcc.gain.toFixed(2)} over slot bar ${rAcc.bars.lo.mean.toFixed(1)}; replacement adds ${(ctx.replAccum[pos] || 0).toFixed(2)}`);
  score += add(V2_W_PLAYOFF * vonaSpk, 'Playoff spike (wk 15-17)',
               `${eff.ceiling.toFixed(1)} ceiling, adds ${rSpk.gain.toFixed(2)} over spike bar ${(rSpk.bars.lo.mean + rSpk.offset).toFixed(1)}; replacement adds ${(ctx.replSpike[pos] || 0).toFixed(2)}`);

  // ── Correlation ────────────────────────────────────────────────────────────
  const corr = v2CorrelationValue(player, myTeam);
  if (corr.regular) score += add(V2_W_ACCUMULATION * corr.regular, 'Correlation', corr.notes.join(' · '));
  if (corr.playoff) score += add(V2_W_PLAYOFF * corr.playoff, 'Playoff game stack', corr.notes.join(' · '));

  // ── Penalties ──────────────────────────────────────────────────────────────
  const bye = v2ByePenalty(player, myTeam);
  if (bye.penalty) score += add(-bye.penalty, 'Bye risk', bye.note);

  const struct = v2StructuralPenalty(player, myTeam);
  if (struct.penalty) score += add(-struct.penalty, 'Roster structure', struct.notes.join(' · '));

  // ── Market value ───────────────────────────────────────────────────────────
  // Unlike V1 this uses realAdp, so it measures "the market let him fall to me"
  // rather than re-counting your own board (which already set the projection).
  // Deliberately small: it is a tiebreak between similarly-valued players, not a
  // driver.  Scaled by SD so it means the same thing across positions.
  const adp = player.realAdp ?? player.adp;
  if (adp) {
    const fell = myPickNumber - adp;
    const tilt = Math.max(-1.5, Math.min(1.5, fell / 24)) * V2_MARKET_PULL * (eff.sd / 10);
    if (Math.abs(tilt) > 0.005) {
      score += add(tilt, fell > 0 ? 'Value vs ADP' : 'Reaching vs ADP',
                   `ADP ${adp.toFixed(1)} at pick ${myPickNumber}`);
    }
  }

  return score;
}

// ── Recommendation ────────────────────────────────────────────────────────────

// myPicks: your remaining pick numbers after this one, in order.  Optional but worth
// supplying — it lets the replacement horizon look the correct number of turns ahead
// instead of assuming uniform gaps in what is actually a snake draft.
function getTopRecommendationsV2(available, myTeam, myPickNumber, n = 5, nextMyPick = null, myPicks = null) {
  if (!available.length) return [];
  const ctx = buildV2Context(available, myTeam, myPickNumber, nextMyPick, myPicks);

  const scored = available.map(p => {
    const bd  = [];
    const val = calculateValueV2(p, myPickNumber, myTeam, nextMyPick, available, bd, ctx);

    const reasons = [];
    const adp  = p.realAdp ?? p.adp;
    const fell = adp ? Math.round(myPickNumber - adp) : 0;
    const thresh = Math.max(3, Math.round((myTeam.length + 1) * 1.2));
    if (fell >= thresh)  reasons.push(`🔥 ${fell} picks of value`);
    if (fell <= -thresh) reasons.push(`⚠️ reaching ${-fell} picks early`);

    const corr = v2CorrelationValue(p, myTeam);
    if (corr.notes.length) reasons.push(corr.notes.join(' · '));

    if (p._eff) {
      if (!p._eff.projected) reasons.push('⚠ no projection — ADP-implied');
      else if (p._eff.sources === 1) reasons.push('single projection source');
    }

    // Survival read: if he is likely to last, you can take a scarcer need first.
    if (nextMyPick != null) {
      const surv = v2SurvivalProb(p, nextMyPick);
      if (surv > 0.65)      reasons.push(`⏳ ${Math.round(surv * 100)}% to last til ${nextMyPick}`);
      else if (surv < 0.20) reasons.push(`⚠ ${Math.round(surv * 100)}% to last — grab now`);
    }

    const bye = v2ByePenalty(p, myTeam);
    if (bye.note) reasons.push(`⚠ ${bye.note}`);

    const struct = v2StructuralPenalty(p, myTeam);
    if (struct.notes.length) reasons.push(`⚠ ${struct.notes.join(' · ')}`);

    return { player: p, value: val, reason: reasons.join(' · '), bd, ppg: p._eff ? p._eff.mean : null };
  });

  scored.sort((a, b) => b.value - a.value);
  return scored.slice(0, n);
}

// Node harness support — no effect in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calculateValueV2, getTopRecommendationsV2, buildV2Context,
    v2AttachEffective, v2MarginalGain, v2SurvivalProb, v2PositionGain, v2OrderStatMoments,
    v2ExpectedBestSurvivor, v2CorrelationValue,
    V2_DRAFT_ROUNDS, V2_ROSTER_TARGETS, V2_STARTER_SLOTS,
  };
}
