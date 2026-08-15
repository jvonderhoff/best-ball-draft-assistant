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

// How far expert disagreement widens a player's knockout-week spread.
//
// SD is otherwise computed as a fixed multiple of the mean, so a 3-ppg round-18
// receiver gets an SD of 1.8 and a ceiling of 5.0 — the model concludes he cannot
// spike, every late pick collapses toward zero, and the ordering among the last five
// rounds becomes noise. But real late-round hits do not drift from 3 to 5; they win a
// job and go to 14. That is a change of regime rather than variance, and nothing in a
// mean-scaled SD can represent it.
//
// FantasyPros' rank_std across ~74 experts is the observable proxy: a player the panel
// splits on is one some experts already think is a starter. It widens the SPIKE term
// only. Accumulation is left alone deliberately — disagreement says the outcome is
// uncertain, not that the fourteen-week expectation is higher.
// DEFAULTS TO OFF, and unlike most of the off-by-default features here, this one has
// now been measured properly rather than being unmeasurable.
//
// The first sweep was worthless and this comment used to quote it: the simulator drew
// every player's true mean from the projection curve with lognormal noise, so no
// simulated player could ever become better than his projection implied. It was
// scoring a bet on breakouts in a world where breakouts could not happen, and the only
// available outcome was a penalty. That defect is fixed — the truth model rolls a real
// regime change now, with probability rising in the same disagreement signal this
// constant keys on.
//
// Swept twice against the fixed simulator, and the two runs DISAGREE about the shape
// near zero: one has 0.5 costing badly, the other has 0.4 gaining half a point, on
// projection caches rebuilt a few days apart. Both agree 1.6 is bad. The honest
// conclusion is not "0.4 is optimal" but "the effect is smaller than the variation a
// routine data refresh introduces", which is a reason to leave it off that the earlier
// version of this comment could not have given. Full tables in §4.
//
// Watch for one trap if you re-run it: capped EV peaked at 0.8 on ~16 outright final
// wins against ~9, while every high-count metric put 0.8 below off. Read `Top 15 of the
// final` over `finals won`. Set V2_BREAKOUT to experiment.
const V2_BREAKOUT_SD_GAIN = _v2env.V2_BREAKOUT ? parseFloat(_v2env.V2_BREAKOUT) : 0.0;

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

// ── QB <-> his own running back, split by how the back scores ────────────────
//
// `V2_CORRELATION.qbRb` above is one number for every back on the board, and that
// is the problem this replaces. A back's relationship with his quarterback runs
// through two channels that point in OPPOSITE directions in a knockout week:
//
//   Rushing   negative game script. The week the QB throws for 400 is the week the
//             back gets 11 carries. Volume correlation over a season is real, a
//             simultaneous spike is not — this is the reasoning that (correctly)
//             kept qbRb out of the playoff term.
//   Receiving a shared scoring EVENT. A receiving touchdown pays the quarterback 4
//             and the back 6 on the same play. There is no game script to net out:
//             it is the same mechanism as a QB-to-WR stack, just with a smaller
//             per-target payoff, which is why the coefficient sits below
//             qbPassCatcher's 0.42 rather than at it.
//
// The 2026 pool runs 14.7% receiving (Henry) to 70.3% (Justice Hill), median 36.9%.
// A flat 0.06 gives Christian McCaffrey — 70 catches, 4 receiving TDs — exactly the
// credit it gives a goal-line grinder, and denies both the playoff weight that the
// receiving half genuinely earns.
//
// DEFAULTS TO OFF, and the reason is the harness rather than the argument. The
// simulator's `TEAM_LOADING` is per POSITION (RB 0.35 flat), so every back in it
// loads on his team's week identically — there are no receiving backs in the truth
// model at all. A sweep would return noise wearing the costume of a result. Pricing
// this honestly needs per-player loading driven by the same receiving share, which
// is a change to the simulator's truth, not to the recommender. See §9.
//
// V2_QB_RB_REC blends: 0.0 is exactly today's flat behaviour, 1.0 is fully
// share-driven. Anything between is a partial move, for sweeping once §9 lands.
const V2_QB_RB_REC = _v2env.V2_QB_RB_REC ? parseFloat(_v2env.V2_QB_RB_REC) : 0.0;

// Per-channel coefficients. Judgement, and marked as such: they are read off the
// mechanism (shared scoring event vs. opposed game script), not measured, and the
// harness cannot currently measure them. The rushing figure is deliberately near
// zero rather than negative — the season-long volume correlation is positive, it
// just does not survive into a single-week spike.
const V2_CORRELATION_QB_RB_RUSH = 0.02;
const V2_CORRELATION_QB_RB_REC  = 0.30;

// Correlation is only paid on the first 3 pass-catchers tied to one QB.  Past
// QB + 3, you are guaranteeing wasted roster spots on most weeks.
const V2_MAX_STACK_PARTNERS = 3;

// How much of a same-team backup RB's knockout-week value is stripped, at the limit
// where the back you already own is the entire backfield. See v2BackfieldSpikeDiscount.
const V2_BACKFIELD_DISCOUNT = 0.80;

// ── Portfolio diversification ────────────────────────────────────────────────
// Entering the same contest twenty times with the same four players is not twenty
// bets, it is one bet with a twenty-times stake. Exposure data (`/api/drafts/exposure`,
// your own picks only) is the observable, and this converts it into a cost.
//
// Deliberately a points-per-week COST rather than the multiplier the old V1 build
// used (`val *= 1 - rate * strength`). A multiplier on total value moves a player a
// different distance depending on where he is going, which is the same defect §1
// called out in V1's stack bonus; a flat ppw cost means the same thing in round 2
// and round 18.
//
// It is subtracted from standalone value and NEVER scales the correlation terms, so
// a player you are heavy on still earns his full stack bonus and only has to clear
// the cost to be taken. Diversification is the default; a real stack overrides it.
//
// IMPORTANT: the harness cannot measure whether this is worth it. It simulates
// independent drafts, and in a single-draft world diversification has no upside at
// all — it can only cost. What the harness CAN measure is the price, which is what
// V2_DIVERSIFY was swept for. The benefit needs a portfolio harness (see §9).
// Sized against the board rather than guessed. Spots the top candidate drops at 100%
// exposure over 20 drafts: pick 25 -> 1, pick 60 -> 2, pick 120 -> 5, pick 200 -> 1.
// At a realistic 60% exposure it is 0-1 spots everywhere. The ppw denomination does
// the work: early rounds have ~1 ppw between adjacent candidates so an elite player
// you are heavy on is still taken, while round 10 has ~0.05 and diversifies freely.
// That is the correct place for the effect to live. 2.0 was tested and moves 8 spots
// at pick 120, which is no longer a nudge.
const V2_DIVERSITY_WEIGHT = _v2env.V2_DIVERSIFY ? parseFloat(_v2env.V2_DIVERSIFY) : 1.0;

// Exposure below this is not over-exposure. Every drafter is heavy on somebody, and
// penalising a 30% share would just be a tax on having opinions.
const V2_DIVERSITY_FLOOR = 0.40;

// Exposure over very few drafts is noise — after one draft every player you took
// reads 100%. Ramps the cost in as the sample grows: ~17% of full at 1 draft, 50%
// at 5, 80% at 20.
const V2_DIVERSITY_CONFIDENCE_K = 5;

// ── Supply exhaustion ────────────────────────────────────────────────────────
// One-step VONA prices how much WORSE the next body at a position gets if you wait.
// It cannot price running OUT of them. Those are different risks, and on a real board
// only the second one separates positions: from pick 79 to 138 the best available
// falls 10.2 -> 7.5 ppg at RB and 11.4 -> 8.5 at WR, which is nearly identical decay.
// What differs is the count — 10 usable RBs become 1 by pick 114, while 19 usable WRs
// are still 8.
//
// §4 records a "need-scaled replacement horizon" that failed at this. It moved the
// VONA horizon, which is a QUALITY lever, and scaled it by bodies-still-wanted, so WR
// got the largest adjustment purely for having the largest target — backwards. This
// keys on the SUPPLY-TO-NEED RATIO instead: WR has a big target and a big pool, so it
// reads as comfortable, while RB's small pool against a similar need does not.
//
// Per position, because the evidence is not uniform. Applied to all four at once this
// lost money at every setting (§4). But QB >= 3 is the single measured IMPROVEMENT in
// the §5.4 roster-count table (+1.16 ±1.31, replicated at +1.17), and V2 leaves 60% of
// drafts with fewer than three quarterbacks — median QB1 round 8, QB2 round 12, QB3
// round 16. So the knob is per-position and swept separately rather than globally.
//
// V2_EXHAUST sets all four; V2_EXHAUST_QB and friends override one.
const _exhaustBase = _v2env.V2_EXHAUST ? parseFloat(_v2env.V2_EXHAUST) : 0.0;
const V2_EXHAUSTION_WEIGHT = {
  QB: _v2env.V2_EXHAUST_QB ? parseFloat(_v2env.V2_EXHAUST_QB) : _exhaustBase,
  RB: _v2env.V2_EXHAUST_RB ? parseFloat(_v2env.V2_EXHAUST_RB) : _exhaustBase,
  WR: _v2env.V2_EXHAUST_WR ? parseFloat(_v2env.V2_EXHAUST_WR) : _exhaustBase,
  TE: _v2env.V2_EXHAUST_TE ? parseFloat(_v2env.V2_EXHAUST_TE) : _exhaustBase,
};

// Bodies actually worth having, from the §5.4 paired tests — deliberately NOT
// V2_ROSTER_TARGETS, whose RB:6 measured -4.97 ±1.66pp against a 5-back baseline.
// Using the old targets here would encode a known-wrong goal into a new feature.
const V2_EXHAUSTION_TARGETS = { QB: 3, RB: 5, WR: 8, TE: 3 };

// Cost per body once a position reaches its modal-build target, escalating beyond it.
// Swept against the harness rather than assumed; see v2StructuralPenalty.
const V2_OVER_TARGET_COST = _v2env.V2_OVERCOST ? parseFloat(_v2env.V2_OVERCOST) : 0.0;

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

// A player who falls only counts as value to the extent you can use him. FIT_REF is
// the share of his weekly output that has to clear your lineup bar for the fall to
// count in full; FLOOR keeps a genuine bargain from being zeroed out entirely at a
// position you are deep in. See the market-value block in calculateValueV2.
const V2_VALUE_FIT_REF   = 0.50;
const V2_VALUE_FIT_FLOOR = 0.20;

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
// Originally swept against the slot-attribution harness (weeks 1-14 points vs V1:
// 0.25 -> -143, 1.0 -> -80, 2.5 -> -41, 4.0 -> +22, 5.0 -> +30, 8.0 -> +36). That run
// was monotonic to the edge of what was tested and the gaps looked like noise, so it
// was set mid-range at 5.0 rather than at the sampled maximum.
//
// Re-swept against the rebuilt harness (real 1,089-team final, injuries, shared
// weather) and 8.0 is now a clear INTERIOR maximum — 12.0 falls back — in BOTH truth
// scenarios, on both capped EV and contest-size EV:
//
//   truth=market   2.5 $83.23 / 1774   5.0 $94.69 / 2356   8.0 $114.61 / 3109   12.0 $96.05 / 2479
//   truth=proj     2.5 $129.23/ 3976   5.0 $192.84/ 4632   8.0 $208.17/ 5091   12.0 $141.11/ 4162
//
// Four independent confirmations of the same peak. Worth stressing WHY it survives
// `truth=proj`, where projections are the answer key and anchoring on ADP should drag
// the model away from the truth: this is a PRICE term, not a valuation one. It scores
// `fell = myPickNumber - adp`, so it is buying players below market rather than
// asserting the market knows who is good. Surplus in draft capital is real whoever
// turns out to be right about the player.
//
// It also does not crowd out a custom board: raising 5.0 -> 8.0 moved a real 384-player
// board from changing 51% of V2's top-10 slots to 49%. Who is good and what to pay for
// him are separable, and this constant only touches the second.
const V2_MARKET_PULL = _v2env.V2_MKT ? parseFloat(_v2env.V2_MKT) : 8.0;

// ADP noise.  Players do not come off the board exactly at ADP; the spread grows
// roughly proportionally as you get deeper into the draft.
// Bounds on the draft-room run factor. A room cannot be read as drafting a position
// at half or double ADP pace on a handful of picks without the signal being noise.
const V2_RUN_CLAMP_LO = 0.70;
const V2_RUN_CLAMP_HI = 1.45;

const V2_ADP_SIGMA_FLOOR = 5.0;
const V2_ADP_SIGMA_RATIO = 0.30;

// How much weight to give consensus rankings (ECR / your custom board) as a
// sanity check against the point projections.  Higher when only one projection
// source is populated, since a single source can be an outlier.
const V2_ECR_WEIGHT_SINGLE_SOURCE = 0.30;
const V2_ECR_WEIGHT_MULTI_SOURCE  = 0.15;

// Your own board outweighs the point projections.
//
// Not arbitrary: Sleeper and ESPN publish generic season-long PPR projections, which
// are redraft artifacts. They know nothing about spike weeks, playoff schedule or
// roster construction — the things that decide a best-ball draft. A board built by a
// best-ball specialist encodes exactly those, so on this format it is the better
// signal about ORDERING.
//
// The projections still matter and are deliberately not sidelined. Ranks are read off
// the positional projection curve, so they set the point SCALE — "the WR you have 12th
// is worth what the 12th-best-projected WR is worth". That is what keeps a rank
// comparable across positions and lets the marginal-gain math work at all. A pure
// ranking model cannot do that; it is what V1 does, and why it cannot tell you whether
// a WR or an RB is the better pick.
//
// Effective shares at this setting: board ~52%, projections ~41%, ECR ~6%.
//
// NOTE: the harness cannot evaluate this. Simulated truth is derived from projections
// or ADP, so it has no way to represent your board being right — raising this can only
// look neutral-to-worse there by construction. This is set on judgement, not evidence.
const V2_CUSTOM_RANK_WEIGHT       = _v2env.V2_RANKW ? parseFloat(_v2env.V2_RANKW) : 0.55;

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

    let mean, sd, cv, sources, avail = 1, disagree = 0, recShare = null;

    if (proj && proj.ppg > 0) {
      mean    = proj.ppg;
      sd      = proj.sd;
      // The scoring CV for this position, recovered from the payload rather than
      // duplicated here.  The projection pipeline builds sd as `ppg x POS_SCORING_CV`
      // (app/projections.py), so the ratio IS that constant.  Deriving it keeps one
      // source of truth: a hardcoded copy in this file would silently drift the day
      // someone retunes the server-side table.
      //
      // Both fields arrive rounded to 2dp, so the recovered CV carries a little
      // rounding noise — but the error is inversely proportional to ppg and is
      // therefore confined to players nobody drafts.  Measured against the true
      // constants: max relative error 0.12% above 8 ppg, 0.56% above 2 ppg, and it
      // only reaches 7% on a WR projected at 0.08 ppg.
      cv      = proj.sd / proj.ppg;
      sources = proj.sources || 1;
      avail   = proj.avail ?? 1;
      disagree = proj.disagreement ?? 0;
      // May be absent on a projection cache built before this field existed, which
      // is why every consumer treats null as "unknown" and falls back rather than
      // reading it as a back who never catches the ball.
      recShare = proj.rec_share ?? null;
    } else {
      // No projection — estimate from where the market ranks him at his position.
      const list    = adpRankByPos[pos] || [];
      const posRank = list.indexOf(p) + 1;
      const est     = v2CurveLookup(curve, posRank);
      if (est == null) { p._eff = null; continue; }
      mean    = est * 0.92;   // unprojected players skew toward the downside
      sd      = est * 0.70;
      // Deliberately wider than any real position's CV — an unprojected body is
      // uncertain on top of being weak.  Expressed as a ratio so the blend below
      // preserves that spread instead of collapsing it onto a projection CV.
      cv      = 0.70 / 0.92;
      sources = 0;
      avail   = 0.80;         // no projection usually means a fringe/injury-risk body
      disagree = 0.35;        // unprojected bodies are inherently uncertain, not inherently bad
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

    // sd follows the blend.  Until 2026-08-15 it did not: sd stayed at its raw
    // projection value while ECR and the custom board moved the mean, so the
    // ceiling/mean ratio — which should be the per-position constant
    // `1 + 1.2816 x CV` (WR 1.897) — actually ranged 1.739–2.164 at WR.
    //
    // The practical cost fell exactly where the user has most influence: rank a
    // player up and his mean rose while his spread did not, so his ceiling rose
    // *less* than proportionally and his spike value was understated against
    // someone who reached the same mean through projections.  With
    // V2_CUSTOM_RANK_WEIGHT at 0.55 that is a large share of the valuation.
    //
    // Worth +$3.28 mean / +$4.34 median across four seeds, `--truth market`, past the
    // ±$2 floor at three of four and a loss at none — but see §5.5 of the design doc:
    // the harness passes an empty customRankMap, so that figure prices only the ECR
    // path and NOT the 0.55 custom-board weight this fix mainly serves.  Measuring it
    // at all required patching the harness, which builds the simulated world's
    // volatility from `_eff.sd` — i.e. from the very thing under test.
    //
    // sd also gates every correlation term via `Math.min(sdMe, partner._eff.sd)`, so
    // this raises stack credit too: live case (Jaydon Blue, DAL, with the board on)
    // week-17 game stack 0.49 -> 0.70, and V2 rank #11 -> #9.
    sd = blended * cv;

    p._eff = {
      mean:    blended,
      sd:      sd,
      ceiling: blended + 1.2816 * sd,
      sources: sources,
      avail:   avail,
      disagreement: disagree,
      ecrWeight: wUsed,
      customRanked: customPts != null,
      projected: !!(proj && proj.ppg > 0),
      recShare: recShare,
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
function v2PositionGain(pos, mean, sd, myTeam, mode, ctx = null, avail = 1, disagreement = 0) {
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

  // Outcome uncertainty only counts where the format pays for it: one huge week.
  const sdEff = mode === 'spike'
    ? sd * (1 + V2_BREAKOUT_SD_GAIN * (disagreement || 0))
    : sd;

  const gLo = v2MarginalGain(mean, sdEff, bars.lo.mean + offset, bars.lo.sd);
  const gHi = v2MarginalGain(mean, sdEff, bars.hi.mean + offset, bars.hi.sd);

  // A player only helps in the weeks he actually plays.
  const byeRate  = mode === 'spike' ? 0 : V2_BYE_RATE;
  const playRate = avail * (1 - byeRate);

  return { gain: (gLo * (1 - frac) + gHi * frac) * playRate, bars, offset };
}

// ── Survival modelling ────────────────────────────────────────────────────────

// P(this player is still on the board at `pick`), from noisy ADP.
// How fast each position is actually coming off the board in THIS room, relative to
// what ADP predicts by now.
//
// ADP is a league-wide average. It cannot tell you that the eleven people in your
// draft have taken eight quarterbacks by pick 60, and that reading is often the whole
// edge — every room behaves differently, and the one you are in is the only one whose
// remaining supply you actually draft from. A position running hot has fewer survivors
// than ADP implies, so waiting costs more than the static model thinks; a position
// falling gives you the opposite.
//
// Measured as taken-so-far against ADP-expected-taken-so-far, using the full player
// universe against what remains on the board. Returns 1.0 when a position is running
// exactly to ADP, above 1 when it is going early, below 1 when it is falling.
function v2PositionalRun(universe, available, pick) {
  const out = { QB: 1, RB: 1, WR: 1, TE: 1 };
  if (!universe || !universe.length || !pick) return out;

  const onBoard = new Set(available.map(p => p.id));
  for (const pos of Object.keys(out)) {
    let expected = 0, taken = 0;
    for (const p of universe) {
      if (p.pos !== pos) continue;
      const adp = p.realAdp ?? p.adp;
      if (!adp || adp >= 9999) continue;
      if (adp < pick) expected++;
      if (!onBoard.has(p.id)) taken++;
    }
    // Needs enough of a sample to mean anything; early picks are all noise.
    if (expected >= 4) {
      out[pos] = Math.max(V2_RUN_CLAMP_LO, Math.min(V2_RUN_CLAMP_HI, taken / expected));
    }
  }
  return out;
}

// Probability this player is still on the board at `pick`.
//
// `run` shifts the curve by how hard his position is being drafted in this specific
// room: at a run factor of 1.4 the market is effectively 40% further through the
// position than ADP says, so he is correspondingly less likely to last.
function v2SurvivalProb(player, pick, run = 1) {
  const adp = player.realAdp ?? player.adp;
  if (!adp || !pick) return 0.5;
  const sigma = Math.max(V2_ADP_SIGMA_FLOOR, V2_ADP_SIGMA_RATIO * adp);
  const effAdp = run && run !== 1 ? adp / run : adp;
  return 1 - v2NormCdf((pick - effAdp) / sigma);
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
// Takes no position or roster argument on purpose: the horizon is the same for every
// position, and making that explicit is the point of keeping the function.
function v2ReplacementHorizon(ctx) {
  return ctx.nextMyPick;
}

// Expected marginal gain of the best player at `pos` who survives to `nextPick`.
// Walks candidates best-gain-first: the first one to survive is the one you'd take.
function v2ExpectedBestSurvivor(pos, available, myTeam, nextPick, mode, ctx) {
  if (nextPick == null) return 0;

  const candidates = available
    .filter(p => p.pos === pos && p._eff)
    .map(p => ({
      gain: v2PositionGain(pos, p._eff.mean, p._eff.sd, myTeam, mode, ctx, p._eff.avail ?? 1, p._eff.disagreement ?? 0).gain,
      surv: v2SurvivalProb(p, nextPick, (ctx && ctx.run && ctx.run[pos]) || 1),
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
  if (!v2HasRealTeam(player) || !player._eff) {
    return { regular: 0, playoff: 0, playoffTeam: 0, playoffGame: 0, notes };
  }

  let regular = 0;
  // Split by source. Both are playoff-weighted correlation, but they are different
  // bets and the UI used to report them under one "Playoff game stack" label — which
  // reads as an opposing-game shootout even when the contribution was two receivers
  // on the same team. That mattered: the breakdown is what gets eyeballed to sanity
  // check a pick, and it was naming the wrong reason.
  let playoffTeam = 0;   // same-team correlation, present in all three weeks
  let playoffGame = 0;   // both sides of one specific playoff game
  const sdMe = player._eff.sd;

  const sameTeam = myTeam.filter(m => v2HasRealTeam(m) && m.team === player.team && m._eff);
  const myQBs    = sameTeam.filter(m => m.pos === 'QB');
  const myCatch  = sameTeam.filter(m => ['WR', 'TE'].includes(m.pos));

  // Same-team correlation pays into BOTH phases, and pays more into the knockout
  // weeks than the regular season.
  //
  // This was previously credited only to `regular`, so a QB-to-his-own-receiver
  // stack — the strongest and most useful correlation in the sport — earned nothing
  // in the weeks 15-17 term, while a mere opposing-game stack earned full playoff
  // weight plus a 1.8x multiplier despite a much weaker coefficient. Backwards:
  // stacking is a win-the-week play. Its whole purpose is simultaneous spikes, which
  // is exactly what a single-week knockout rewards and what a 14-week accumulation
  // total mostly averages away.
  //
  // It also invalidated an earlier finding. Sweeping V2_CORRELATION_WEIGHT appeared
  // to show that stacking cost the model badly, so it was left low — but that dial
  // only ever fed the 0.40-weighted accumulation term, so the experiment was
  // measuring a lever wired to the wrong place.
  const pair = (rho, partner, label) => {
    const v = rho * Math.min(sdMe, partner._eff.sd) * V2_CORRELATION_WEIGHT;
    regular += v;
    playoffTeam += v * V2_PLAYOFF_STACK_MULTIPLIER;
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
        const v = V2_CORRELATION.passCatcherPair * Math.min(sdMe, c._eff.sd) * V2_CORRELATION_WEIGHT;
        regular += v;
        playoffTeam += v * V2_PLAYOFF_STACK_MULTIPLIER;
      }
      if (!myQBs.length && myCatch.length) notes.push(`${player.team} receiver room`);
    }
  }

  // A quarterback and his own running back, split by how the back actually scores.
  // See the V2_QB_RB_REC block above for the mechanism.
  //
  // With the feature off this is the long-standing behaviour verbatim: one flat
  // coefficient, credited to `regular` only, never to the playoff term — the week a
  // quarterback goes nuclear is a pass-heavy week, which is usually not his running
  // back's big week.
  //
  // With it on, only the RECEIVING channel earns playoff weight. That is the whole
  // point: a shared touchdown is a simultaneous spike, a 25-carry game is not, so
  // crediting the pairing as a unit would smuggle the rushing half into a term it
  // has no claim on.
  //
  // One helper, used from BOTH directions, so they cannot drift apart. That symmetry
  // is not tidiness — it was the bug. This term used to be credited only when
  // evaluating an RB against a rostered QB, while the QB branch below looked at
  // `myCatch` (WR/TE only) and could not see a rostered back at all. V2 drafts backs
  // early and quarterbacks around round 8, so the direction that actually arises in a
  // draft — "I own the back, is his QB worth taking?" — earned nothing, and a sweep
  // of this constant measured only the rare direction and correctly found nothing.
  const qbRbChannels = (rb, qb) => {
    const minSd = Math.min(rb._eff.sd, qb._eff.sd);
    const flat  = V2_CORRELATION.qbRb * minSd * V2_CORRELATION_WEIGHT;
    const share = rb._eff.recShare;
    if (!(V2_QB_RB_REC > 0) || share == null) {
      return { regular: flat, playoffTeam: 0, share: null };
    }
    const w     = Math.max(0, Math.min(1, V2_QB_RB_REC));
    const vRush = V2_CORRELATION_QB_RB_RUSH * (1 - share) * minSd * V2_CORRELATION_WEIGHT;
    const vRec  = V2_CORRELATION_QB_RB_REC  * share       * minSd * V2_CORRELATION_WEIGHT;
    return {
      regular:     flat * (1 - w) + (vRush + vRec) * w,
      playoffTeam: vRec * w * V2_PLAYOFF_STACK_MULTIPLIER,
      share,
    };
  };

  if (player.pos === 'QB') {
    // Bring-back: you already own this QB's pass-catchers.
    for (const c of myCatch.slice(0, V2_MAX_STACK_PARTNERS)) {
      pair(V2_CORRELATION.qbPassCatcher, c, 'completes stack w/');
    }
    // ...and his running back, if you own one. Only the best of them — a second back
    // from the same backfield adds almost nothing (they rarely play together, which
    // is the same reason v2BackfieldSpikeDiscount exists) and would double-count one
    // bet.
    const myRbs = sameTeam.filter(m => m.pos === 'RB');
    if (myRbs.length) {
      const rb = myRbs.reduce((a, b) => (a._eff.mean >= b._eff.mean ? a : b));
      const ch = qbRbChannels(rb, player);
      regular     += ch.regular;
      playoffTeam += ch.playoffTeam;
      const last = rb.name.split(' ').pop();
      notes.push(ch.share != null
        ? `completes RB stack w/ ${last} · ${Math.round(ch.share * 100)}% receiving`
        : `completes RB stack w/ ${last}`);
    }
  }

  if (player.pos === 'RB' && myQBs.length) {
    const qb = myQBs[0];
    const ch = qbRbChannels(player, qb);
    regular     += ch.regular;
    playoffTeam += ch.playoffTeam;
    const last = qb.name.split(' ').pop();
    // Noted even when the credit is tiny. It was previously silent — the only
    // same-team pairing in the model that produced no breakdown line at all — so
    // there was no way to eyeball whether it was doing anything, which is exactly
    // the check the side-by-side with V1 exists to make possible.
    notes.push(ch.share != null
      ? `w/ QB ${last} · ${Math.round(ch.share * 100)}% receiving`
      : `w/ QB ${last}`);
  }

  // Playoff game stacks — both sides of one week 15/16/17 game.  Weighted far
  // more heavily than regular-season correlation because those weeks are
  // win-or-go-home, and week 17 is the final.
  //
  // Capped at the same partner count as pass-catcher stacks.  Uncapped, this summed
  // over every partner in all three weeks, so a player whose team happened to face
  // several teams you own racked up a point of "stack" value on volume alone — a
  // 3.4-ppg back was scoring 0.93 from six partners, which was 93% of his total and
  // enough to rank him 2nd on the board.  Correlation past a few partners is not
  // additional edge, it is the same bet placed repeatedly.
  const weekWeight = { 17: 1.6, 16: 1.0, 15: 0.9 };
  let stackPartners = 0;
  for (const week of [17, 16, 15]) {
    const partners = myTeam.filter(m => m._eff && v2SamePlayoffGame(player, m, week));
    for (const partner of partners) {
      if (stackPartners >= V2_MAX_STACK_PARTNERS) break;
      stackPartners++;
      playoffGame += V2_CORRELATION.opposingGame
               * Math.min(sdMe, partner._eff.sd)
               * V2_CORRELATION_WEIGHT
               * V2_PLAYOFF_STACK_MULTIPLIER
               * weekWeight[week];
    }
    if (partners.length) {
      notes.push(`Wk${week} game stack w/ ${partners.map(p => p.name.split(' ').pop()).join(', ')}`);
    }
  }

  // `playoff` stays the sum so existing callers keep working unchanged.
  return { regular, playoff: playoffTeam + playoffGame, playoffTeam, playoffGame, notes };
}

// How much of a running back's knockout-week value survives when you already own a
// back from the same team.
//
// Only one back is on the field for most snaps, so two from one backfield essentially
// never post big weeks together.  That matters asymmetrically across the two phases,
// which is why this discounts the spike term only:
//
//   Weeks 1-14   the backup genuinely helps.  Over fourteen weeks he covers the
//                starter's absences, and those are real accumulated points.
//   Weeks 15-17  he does not.  You need one enormous score from the slot, and the
//                week your starter explodes is not a week his backup also explodes.
//                There is no independent path to the score that wins the week.
//
// Two things scale it, and they are genuinely different signals:
//
//   Workload share  — how lopsided the backfield is.  A clear backup behind a
//                     workhorse keeps little; a true committee back keeps most,
//                     because he has his own path to a big week.
//   Draft capital   — how early the back you already own went.  Pairing two mid or
//                     late-round backs is a reasonable bet on an unsettled job: you
//                     do not need either specifically, so owning both sides is fine.
//                     Pairing the backup to a first-round back is not the same
//                     move.  Spending that pick concentrates your season on him
//                     hitting, and the weeks his backup pays off are weeks you have
//                     already lost the accumulation phase.  Insurance that only
//                     settles in branches where you are eliminated is worth little
//                     in a top-heavy tournament.
//
// Receivers are deliberately exempt — they are on the field together and can both
// go off in the same game.
function v2BackfieldSpikeDiscount(player, myTeam) {
  if (player.pos !== 'RB' || !player._eff || !v2HasRealTeam(player)) return 1;
  const mates = myTeam.filter(m => m.pos === 'RB' && m._eff && m.team === player.team);
  if (!mates.length) return 1;

  // The most valuable back from that team you already hold.
  const mate = mates.reduce((a, b) => (a._eff.mean >= b._eff.mean ? a : b));
  const share = mate._eff.mean / Math.max(0.01, mate._eff.mean + player._eff.mean);

  // Draft capital sunk into him, from where the market had him. Full weight inside
  // the first ~2 rounds, fading to none by roughly round 10.
  const mateAdp = mate.realAdp ?? mate.adp ?? 999;
  const capital = Math.max(0, Math.min(1, 1 - mateAdp / 120));

  const discount = V2_BACKFIELD_DISCOUNT * share * (0.5 + 0.5 * capital);
  return Math.max(0.15, 1 - discount);
}

// How likely an unsigned free agent is to be on a roster by the knockout weeks.
//
// Read off the market rather than assumed: if the field spends a round-12 pick on a
// free agent, the field believes he will sign and contribute, and that belief is
// already in his ADP.  Applying a further flat penalty on top double-counts it.
//
// The curve is deliberately convex, so only players going at the very back of the
// draft — where a pick is a dart throw and non-signing is a live outcome — take a
// real discount.  Never reaches 1.0: even a certain signing carries genuine risk of
// a late deal, a reduced role, or a bad landing spot, and we cannot see his schedule.
function v2FreeAgentSignProb(player, ctx) {
  const adp = player.realAdp ?? player.adp;
  const max = (ctx && ctx.maxAdp) || 250;
  if (!adp) return 0.45;
  const depth = Math.min(1, adp / max);
  return Math.max(0.45, Math.min(0.95, 0.95 - 0.55 * Math.pow(depth, 3)));
}

// Fraction of the three knockout weeks in which this player's team actually has a
// game.  A player with a real team and no scheduled opponent is a data gap; an
// unsigned free agent is discounted by how likely the market thinks he is to sign.
function v2PlayoffAvailability(player, ctx) {
  const weeks = ['week15', 'week16', 'week17'].filter(w => player[w]);
  if (weeks.length) return weeks.length / 3;
  return v2HasRealTeam(player) ? 1.0 : v2FreeAgentSignProb(player, ctx);
}

// Expected playoff game-stack value for a player whose team we do not know yet.
//
// Returning zero (the previous behaviour) is not neutral, it is a penalty: in a
// roster with several playoff-week partners every rostered candidate collects a
// point or more of game-stack value, and a free agent alone cannot. But he will
// land somewhere, and some landing spots do stack with your roster.
//
// So instead of guessing, average the actual stack value over every team on the
// board — the schedule is known even when the player's destination is not.
function v2ExpectedUnknownTeamStack(player, myTeam, ctx) {
  if (!ctx || !ctx.teamSchedules || !player._eff) return 0;
  const teams = Object.keys(ctx.teamSchedules);
  if (!teams.length) return 0;

  const sdMe = player._eff.sd;
  const weekWeight = { 17: 1.6, 16: 1.0, 15: 0.9 };
  let total = 0;

  for (const team of teams) {
    const sched = ctx.teamSchedules[team];
    for (const week of [17, 16, 15]) {
      const opp = sched[`week${week}`];
      if (!opp) continue;
      for (const m of myTeam) {
        if (!m._eff) continue;
        // Would a player on `team` share this week's game with teammate m?
        if (m.team !== opp && m[`week${week}`] !== team) continue;
        total += V2_CORRELATION.opposingGame
               * Math.min(sdMe, m._eff.sd)
               * V2_CORRELATION_WEIGHT
               * V2_PLAYOFF_STACK_MULTIPLIER
               * weekWeight[week];
      }
    }
  }
  return (total / teams.length) * v2FreeAgentSignProb(player, ctx);
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
// Cost of taking a player you are already heavy on across your saved drafts.
// Returns points per week, to be subtracted.
function v2DiversityCost(player, ctx) {
  const strength = (ctx && ctx.diversify != null) ? ctx.diversify : 1;
  if (!ctx || !ctx.exposure || !V2_DIVERSITY_WEIGHT || strength <= 0) return { penalty: 0, note: '' };

  const e = ctx.exposure[player.id];
  if (!e) return { penalty: 0, note: '' };

  const rate = e.exposure_rate ?? 0;
  if (rate <= V2_DIVERSITY_FLOOR) return { penalty: 0, note: '' };

  const over = (rate - V2_DIVERSITY_FLOOR) / (1 - V2_DIVERSITY_FLOOR);
  const n    = ctx.totalDrafts ?? 0;
  const conf = n / (n + V2_DIVERSITY_CONFIDENCE_K);

  return {
    penalty: V2_DIVERSITY_WEIGHT * strength * over * conf,
    rate,
    note: `on ${Math.round(rate * 100)}% of your ${n} draft${n === 1 ? '' : 's'}`,
  };
}

// Urgency from a position's pool running dry before you can fill it. Returns points
// per week, to be added. Cached per position on the context — it depends on the board
// and roster, not on the individual candidate.
function v2ExhaustionUrgency(pos, available, myTeam, ctx) {
  const weight = (V2_EXHAUSTION_WEIGHT && V2_EXHAUSTION_WEIGHT[pos]) || 0;
  if (!weight || !ctx) return { premium: 0, note: null };
  if (ctx.exhaustion && ctx.exhaustion[pos] !== undefined) return ctx.exhaustion[pos];

  const out = (v) => { if (ctx.exhaustion) ctx.exhaustion[pos] = v; return v; };

  const picks = ctx.myPicks;
  if (!picks || !picks.length) return out({ premium: 0, note: null });

  const owned = myTeam.filter(p => p.pos === pos && p._eff).length;
  const need  = Math.max(0, (V2_EXHAUSTION_TARGETS[pos] || 1) - owned);
  if (need <= 0) return out({ premium: 0, note: null });

  // "Usable" is the league-wide startable bar — the (slots x 12)-th best player at the
  // position in the FULL universe, not in what is left on the board.
  //
  // This differs deliberately from the VOR baseline, which indexes into the available
  // pool so it self-adjusts as the draft runs down. That is right for pricing value
  // and fatal here: a bar that falls as fast as the supply means a position can never
  // run out by construction. Measured on a real mid-draft board it made RB's premium
  // exactly 0.000 while RB was visibly the scarcest thing left.
  const depth = Math.max(1, Math.round((V2_STARTER_SLOTS[pos] || 1) * V2_NUM_TEAMS));
  const univ = (ctx.universe && ctx.universe.length) ? ctx.universe : available;
  const univAtPos = univ
    .filter(p => p.pos === pos && p._eff)
    .sort((a, b) => b._eff.mean - a._eff.mean);
  if (!univAtPos.length) return out({ premium: 0, note: null });
  const replMean = univAtPos[Math.min(depth, univAtPos.length - 1)]._eff.mean;

  const atPos = available
    .filter(p => p.pos === pos && p._eff)
    .sort((a, b) => b._eff.mean - a._eff.mean);
  if (!atPos.length) return out({ premium: 0, note: null });

  // How many usable bodies can I expect to ACQUIRE across my remaining picks?
  //
  // Not "how many survive to my Nth pick" — that was the first version and it walked
  // straight back into §4's trap. A larger `need` pushes the target pick further out,
  // almost nothing survives that far, so every high-need position saturated at the
  // maximum premium and the term stopped discriminating: QB 0.915, RB 0.992, WR 0.960.
  //
  // You acquire at most one body per pick, so the right sum is over picks: at each of
  // the next `need` picks, the chance that at least one usable body is still there.
  const run = (ctx.run && ctx.run[pos]) || 1;
  let acquirable = 0;
  for (let i = 0; i < need && i < picks.length; i++) {
    let cnt = 0;
    for (const p of atPos) {
      if (p._eff.mean < replMean) break;
      cnt += v2SurvivalProb(p, picks[i], run);
      if (cnt >= 1) break;
    }
    acquirable += Math.min(1, cnt);
  }

  const shortfall = Math.max(0, need - acquirable) / need;   // 0 comfortable, 1 nothing left
  if (shortfall <= 0.001) return out({ premium: 0, note: null });

  return out({
    premium: weight * shortfall,
    note: `can expect ~${acquirable.toFixed(1)} more startable ${pos} across your next `
        + `${Math.min(need, picks.length)} picks, need ${need}`,
  });
}

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

  // Soft cost for going past the modal build, escalating with each extra body.
  //
  // Not a cap — going over is sometimes right, and a hard limit at three tight ends
  // measured worse. But it should be a deliberate choice rather than the default, and
  // it was the default: 87% of rosters finished with four tight ends, and every
  // construction the harness flags as underperforming has TE:4 while the two best
  // builds have TE:3.
  //
  // The marginal-value math is not wrong at the moment it takes them. Late in the
  // draft the remaining tight ends genuinely out-project the remaining backs and
  // receivers, so each individual pick is defensible. What it cannot see is that a
  // fourth tight end has almost nowhere to play, and that the shape it accumulates
  // one locally-correct pick at a time is one that loses.
  const over = have - (V2_ROSTER_TARGETS[pos] ?? 99);
  if (over >= 0) {
    penalty += V2_OVER_TARGET_COST * (over + 1);
    notes.push(`${have} ${pos} already (target ${V2_ROSTER_TARGETS[pos]})`);
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
function buildV2Context(available, myTeam, myPickNumber, nextMyPick, myPicks = null, universe = null, opts = {}) {
  // barCache holds the order-statistic moments per position — they depend only on
  // the current roster, so they are computed once per pick, not once per candidate.
  const ctx = {
    nextMyPick, myPickNumber, myPicks,
    replAccum: {}, replSpike: {}, barCache: {}, typicalSd: {}, horizon: {}, replDepth: {},
    exhaustion: {}, universe: universe || null,
    maxAdp: 250, teamSchedules: {},
    run: v2PositionalRun(universe, available, myPickNumber),
    // Portfolio state: absent in the harness and on a first draft, which is why every
    // consumer of these has to tolerate undefined.
    exposure: opts.exposure || null,
    totalDrafts: opts.totalDrafts || 0,
    diversify: opts.diversify != null ? opts.diversify : 1,
  };

  // Deepest ADP on the board — the scale a free agent's draft position is read
  // against when estimating how likely the market thinks he is to sign.
  let maxAdp = 0;
  for (const p of available) {
    const a = p.realAdp ?? p.adp;
    if (a && a < 9999 && a > maxAdp) maxAdp = a;
    // Playoff schedule per NFL team, recovered from the pool. Lets an unsigned
    // player's expected game stack be averaged over real destinations.
    if (v2HasRealTeam(p) && !ctx.teamSchedules[p.team] && (p.week15 || p.week16 || p.week17)) {
      ctx.teamSchedules[p.team] = { week15: p.week15, week16: p.week16, week17: p.week17 };
    }
  }
  if (maxAdp > 0) ctx.maxAdp = maxAdp;

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


  for (const pos of Object.keys(V2_STARTER_SLOTS)) {
    const horizon = v2ReplacementHorizon(ctx);
    ctx.horizon[pos] = horizon;

    // Timing baseline: the best player at this position likely to survive to my next pick.
    const survAccum = v2ExpectedBestSurvivor(pos, available, myTeam, horizon, 'accum', ctx);
    const survSpike = v2ExpectedBestSurvivor(pos, available, myTeam, horizon, 'spike', ctx);

    // Value baseline: the last STARTABLE player at this position across the league,
    // i.e. lineup demand (slots x teams), not roster demand (target x teams).
    //
    // Using roster demand put the quarterback baseline at QB36 — a player worth under
    // 2 ppg who nobody ever starts — so an elite QB scored ~19 points above
    // "replacement" and the model would reach many picks for him.  Your actual
    // fallback is never QB36; it is the next competent starter a round or two later.
    // Lineup demand puts the baseline near QB12, which is the real alternative and
    // the standard VORP definition.
    //
    // Indexing into the *available* pool means this self-adjusts as the draft runs
    // down: once the good players are gone, the Nth-best remaining is worse, and the
    // baseline rises on its own without scaling by rounds left.
    const depth = Math.max(1, Math.round((V2_STARTER_SLOTS[pos] || 1) * V2_NUM_TEAMS));
    const atPos = available
      .filter(p => p.pos === pos && p._eff)
      .sort((a, b) => b._eff.mean - a._eff.mean);
    const repl = atPos.length ? atPos[Math.min(depth, atPos.length - 1)] : null;

    const vorAccum = repl
      ? v2PositionGain(pos, repl._eff.mean, repl._eff.sd, myTeam, 'accum', ctx, repl._eff.avail ?? 1).gain : 0;
    const vorSpike = repl
      ? v2PositionGain(pos, repl._eff.mean, repl._eff.sd, myTeam, 'spike', ctx, repl._eff.avail ?? 1, repl._eff.disagreement ?? 0).gain : 0;

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
  const rSpk     = v2PositionGain(pos, eff.mean, eff.sd, myTeam, 'spike', ctx, eff.avail ?? 1, eff.disagreement ?? 0);
  const backfield = v2BackfieldSpikeDiscount(player, myTeam);
  const vonaSpk   = (rSpk.gain - (ctx.replSpike[pos] || 0))
                  * v2PlayoffAvailability(player, ctx) * backfield;

  let score = 0;
  score += add(V2_W_ACCUMULATION * vonaAcc, 'Accumulation (wk 1-14)',
               `${eff.mean.toFixed(1)} ppg, adds ${rAcc.gain.toFixed(2)} over slot bar ${rAcc.bars.lo.mean.toFixed(1)}; replacement adds ${(ctx.replAccum[pos] || 0).toFixed(2)}`);
  score += add(V2_W_PLAYOFF * vonaSpk, 'Playoff spike (wk 15-17)',
               `${eff.ceiling.toFixed(1)} ceiling, adds ${rSpk.gain.toFixed(2)} over spike bar ${(rSpk.bars.lo.mean + rSpk.offset).toFixed(1)}; replacement adds ${(ctx.replSpike[pos] || 0).toFixed(2)}`
               + (backfield < 0.999 ? ` · x${backfield.toFixed(2)} same-backfield` : '')
               + ((eff.disagreement ?? 0) > 0.35 ? ` · experts split (${(eff.disagreement*100).toFixed(0)}%) — widened` : ''));

  // ── Correlation ────────────────────────────────────────────────────────────
  // Scaled by the same roster fit the market-value term uses, and for the same
  // reason: correlation only pays on points that actually reach your lineup.
  //
  // A third tight end behind an elite one is 6 points a week below the slot he
  // competes for, so he starts almost never — and a "stack" with a player who is
  // not in the lineup is not a stack at all. Unscaled, one such player scored 1.93
  // from game stacks against 0.50 of his own value, which was 75% of his total and
  // enough to rank him first overall ahead of every startable option.
  //
  // Note this is the third place the same mistake appeared: value credited without
  // checking whether the player can be used. Falling ADP value and same-backfield
  // spikes were the other two.
  const corr = v2CorrelationValue(player, myTeam);
  const corrFit = Math.max(V2_VALUE_FIT_FLOOR,
                           Math.min(1, rAcc.gain / Math.max(0.01, V2_VALUE_FIT_REF * eff.mean)));
  const fitNote = corrFit < 0.999 ? ` · x${corrFit.toFixed(2)} roster fit` : '';
  if (corr.regular) {
    score += add(V2_W_ACCUMULATION * corr.regular * corrFit, 'Correlation',
                 corr.notes.join(' · ') + fitNote);
  }
  if (corr.playoffTeam) {
    score += add(V2_W_PLAYOFF * corr.playoffTeam * corrFit, 'Playoff correlation (same team)',
                 `same team in all 3 knockout weeks · x${V2_PLAYOFF_STACK_MULTIPLIER} playoff weight` + fitNote);
  }
  if (corr.playoffGame) {
    score += add(V2_W_PLAYOFF * corr.playoffGame * corrFit, 'Playoff game stack',
                 corr.notes.filter(n => /^Wk\d/.test(n)).join(' · ') + fitNote);
  }

  // Unsigned free agent: no known team, so no concrete stack — but an expected one.
  if (!v2HasRealTeam(player)) {
    const exp = v2ExpectedUnknownTeamStack(player, myTeam, ctx);
    if (exp) {
      score += add(V2_W_PLAYOFF * exp, 'Expected stack (unsigned)',
                   `avg over all landing spots, ${Math.round(v2FreeAgentSignProb(player, ctx) * 100)}% signing weight`);
    }
  }

  // ── Penalties ──────────────────────────────────────────────────────────────
  const bye = v2ByePenalty(player, myTeam);
  if (bye.penalty) score += add(-bye.penalty, 'Bye risk', bye.note);

  const struct = v2StructuralPenalty(player, myTeam);
  if (struct.penalty) score += add(-struct.penalty, 'Roster structure', struct.notes.join(' · '));

  const div = v2DiversityCost(player, ctx);
  if (div.penalty) score += add(-div.penalty, 'Over-exposed', div.note);

  const exh = v2ExhaustionUrgency(pos, available, myTeam, ctx);
  if (exh.premium) score += add(exh.premium, 'Supply running out', exh.note);

  // ── Market value ───────────────────────────────────────────────────────────
  // Unlike V1 this uses realAdp, so it measures "the market let him fall to me"
  // rather than re-counting your own board (which already set the projection).
  // Scaled by SD so it means the same thing across positions.
  //
  // Measured in units of the market's OWN uncertainty about that player, not in
  // raw picks. A fixed pick yardstick treats reaching eight spots at pick 12 and at
  // pick 212 as the same mistake, and they are nothing alike: early ADP is a tight
  // consensus of thousands of drafters on heavily-researched players, while late ADP
  // is mostly noise — the gap between the 190th and 230th player is nobody knowing
  // who is any good. FantasyPros bears this out directly: expert rank disagreement
  // runs a standard deviation above 45 for some players inside the top 150.
  //
  // The scale is the same ADP sigma the survival model already uses (0.30 x adp), so
  // reaching is priced against how precisely the player is actually priced. Around
  // six picks at ADP 20, around sixty at ADP 200. That makes late-round reaches for
  // stacks and playoff correlation nearly free, which is the point: when the market
  // does not know either, structural edges are the better thing to spend on.
  const adp = player.realAdp ?? player.adp;
  if (adp) {
    const fell     = myPickNumber - adp;
    const adpSigma = Math.max(V2_ADP_SIGMA_FLOOR, V2_ADP_SIGMA_RATIO * adp);
    let tilt = Math.max(-1.5, Math.min(1.5, fell / adpSigma)) * V2_MARKET_PULL * (eff.sd / 10);

    // The two directions are not symmetric.
    //
    // Reaching is scaled by nothing but the market: overpaying is overpaying whether
    // or not the player fits, and leaving that unscaled is what keeps the model
    // anchored to ADP, which is what makes its positional allocation sane.
    //
    // Falling value is different. A player who slides is only a bargain to the extent
    // you can actually use him, and the amount of his production that clears your
    // lineup bar is exactly what the accumulation gain already measures. A third tight
    // end behind an elite one is six points a week below the slot he would compete
    // for — the fourteen picks he fell are close to meaningless, yet unscaled they
    // were worth 0.93, some 43% of his score and enough to rank him first overall.
    let fit = 1;
    if (fell > 0) {
      fit = Math.max(V2_VALUE_FIT_FLOOR,
                     Math.min(1, rAcc.gain / Math.max(0.01, V2_VALUE_FIT_REF * eff.mean)));
      tilt *= fit;
    }

    if (Math.abs(tilt) > 0.005) {
      score += add(tilt, fell > 0 ? 'Value vs ADP' : 'Reaching vs ADP',
                   `ADP ${adp.toFixed(1)} at pick ${myPickNumber}, ${Math.abs(fell / adpSigma).toFixed(2)}σ of market noise`
                   + (fell > 0 && fit < 0.999 ? ` · x${fit.toFixed(2)} roster fit` : ''));
    }
  }

  return score;
}

// ── Recommendation ────────────────────────────────────────────────────────────

// myPicks: your remaining pick numbers after this one, in order.  Optional but worth
// supplying — it lets the replacement horizon look the correct number of turns ahead
// instead of assuming uniform gaps in what is actually a snake draft.
function getTopRecommendationsV2(available, myTeam, myPickNumber, n = 5, nextMyPick = null, myPicks = null, universe = null, opts = {}) {
  if (!available.length) return [];
  const ctx = buildV2Context(available, myTeam, myPickNumber, nextMyPick, myPicks, universe, opts);

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

    const divR = v2DiversityCost(p, ctx);
    if (divR.penalty) reasons.push(`♻️ already ${divR.note}`);

    const runF = (ctx.run && ctx.run[p.pos]) || 1;
    if (runF >= 1.15) reasons.push(`🔥 ${p.pos} run — going ${Math.round((runF - 1) * 100)}% ahead of ADP in this room`);
    else if (runF <= 0.88) reasons.push(`🧊 ${p.pos} falling — ${Math.round((1 - runF) * 100)}% behind ADP pace`);

    if (!v2HasRealTeam(p)) {
      reasons.push(`🔓 unsigned — ${Math.round(v2FreeAgentSignProb(p, ctx) * 100)}% signing weight, no known schedule`);
    }
    if (p._eff) {
      if (!p._eff.projected) reasons.push('⚠ no projection — ADP-implied');
      else if (p._eff.sources === 1) reasons.push('single projection source');
    }

    // Survival read: if he is likely to last, you can take a scarcer need first.
    if (nextMyPick != null) {
      const surv = v2SurvivalProb(p, nextMyPick, (ctx.run && ctx.run[p.pos]) || 1);
      if (surv > 0.65)      reasons.push(`⏳ ${Math.round(surv * 100)}% to last til ${nextMyPick}`);
      else if (surv < 0.20) reasons.push(`⚠ ${Math.round(surv * 100)}% to last — grab now`);
    }

    const bf = v2BackfieldSpikeDiscount(p, myTeam);
    if (bf < 0.999) {
      const mate = myTeam.filter(m => m.pos === 'RB' && m.team === p.team)
                         .sort((a,b) => (b._eff?.mean||0) - (a._eff?.mean||0))[0];
      reasons.push(`⚠ shares ${p.team} backfield w/ ${mate ? mate.name.split(' ').pop() : 'your RB'} — spike value x${bf.toFixed(2)}`);
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
    v2ExpectedBestSurvivor, v2CorrelationValue, v2FreeAgentSignProb, v2PlayoffAvailability,
    v2PositionalRun,
    v2BackfieldSpikeDiscount, v2DiversityCost, v2ExhaustionUrgency,
    V2_DRAFT_ROUNDS, V2_ROSTER_TARGETS, V2_STARTER_SLOTS,
  };
}
