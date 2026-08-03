#!/usr/bin/env node
//
// V1 vs V2 recommender comparison harness.
//
// Runs both models through complete simulated DraftKings Best Ball drafts and
// scores the resulting rosters against the metric that actually pays: expected
// dollars through the tournament's four phases.
//
//   Weeks 1-14   cumulative, top 2 of 12 advance
//   Week 15      single week, top 1 of 12
//   Week 16      single week, top 1 of 12
//   Week 17      single week, THE FINAL — ~1,089 teams, one common realisation
//
// ── Methodology, and its honest limitations ──────────────────────────────────
//
// Each simulated draft seats the model under test at one slot; the other 11 seats
// draft to ADP with noise (with light positional sanity limits).  The resulting
// 12 rosters then play a simulated season many times over, using common random
// numbers so V1 and V2 face identical luck.
//
// Weekly scoring is drawn ONCE PER PLAYER PER WEEK and shared by every roster that
// owns him.  This matters for two separate reasons:
//
//   1. It is what makes the final a contest.  If a player is diced independently
//      for each team that rosters him, nobody is ever "on the chalk" and there is
//      no such thing as leverage.
//   2. It makes common random numbers real.  Previously the draws were consumed
//      roster-by-roster, so the moment V1 and V2 drafted different players the two
//      runs diverged into different weather; "identical luck" held only at the seed.
//
// The season simulator models correlation explicitly — a shared team-week factor
// that QBs and pass-catchers load on heavily and RBs load on lightly, plus a
// shared game factor in weeks 15-17 — so stacking pays off (or doesn't) on its
// own merits rather than being assumed.
//
// THE BIG CAVEAT: in the default scenario, "true" player ability is the same
// projection set V2 optimises against.  That hands V2 a free win, because it is
// being graded by its own answer key.  So the harness also runs a `--truth market`
// scenario where true ability is derived from ADP instead, giving V2 no
// information advantage.  Treat the market scenario as the honest read; if V2 only
// wins under `--truth proj`, it has learned nothing but its own projections.
//
// Usage:
//   node tools/compare-models.js                      # 400 drafts, both truth scenarios
//   node tools/compare-models.js --drafts 200 --seasons 300
//   node tools/compare-models.js --truth market
//   node tools/compare-models.js --field-pods 200     # smaller/faster final field
//   node tools/compare-models.js --replay             # pick-by-pick on your real draft

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const V1 = require(path.join(ROOT, 'static', 'recommender.js'));
const V2 = require(path.join(ROOT, 'static', 'recommender-v2.js'));

const NUM_TEAMS = 12;

// ── Prize structure ──────────────────────────────────────────────────────────
// Advance rate is only a proxy, and a poor one: it scores reaching the final the
// same as winning it, when essentially all the money is in week 17. Expected
// dollars is the objective that actually matters.
//
// Approximate DraftKings Best Ball Millionaire structure. Weeks 15 and 16 pay a
// consolation to teams that fail to advance; week 17 is a single large field where
// the payout curve is brutally top-heavy.
const PAYOUT_WK15_CONSOLATION = 35;    // fails to advance out of week 15
const PAYOUT_WK16_CONSOLATION = 125;   // fails to advance out of week 16
const FINAL_FIELD_SIZE = 1089;         // teams contesting week 17

// Placement payouts in the final, as [topFraction, prize]. Interpolated between
// breakpoints. Sourced from published Millionaire payout tables; exact figures vary
// by contest, so treat the shape as the signal rather than any single number.
const FINAL_PAYOUTS = [
  [1 / FINAL_FIELD_SIZE, 1000000],
  [2 / FINAL_FIELD_SIZE,  150750],
  [3 / FINAL_FIELD_SIZE,  100000],
  [5 / FINAL_FIELD_SIZE,   50000],
  [10 / FINAL_FIELD_SIZE,  20000],
  [15 / FINAL_FIELD_SIZE,  12000],
  [50 / FINAL_FIELD_SIZE,   3000],
  [150 / FINAL_FIELD_SIZE,  1000],
  [400 / FINAL_FIELD_SIZE,   400],
  [1.0,                      200],
];

// Prize for finishing at `frac` through the final field (0 = won it).
function finalPayout(frac) {
  for (const [cut, prize] of FINAL_PAYOUTS) if (frac <= cut) return prize;
  return 0;
}

// ── Contests other than the Millionaire ──────────────────────────────────────
//
// Every DK best-ball tournament with this advancement structure sends 1 team in 864
// to the final (12-team pods, top 2 of 12 over weeks 1-14, then two single-week
// knockouts: 12 x 6 x 12 x 12 = 864). So the final's size is just entries/864, and
// it varies enormously across the lobby while the path to it stays identical:
//
//   $20M Millionaire   940,000 entries -> ~1,088 finalists
//   $1M Play-Action    395,300         ->   ~458
//   $500K Play-Action  197,800         ->   ~229
//   $300K Button Hook   38,800         ->    ~45
//   $150K Huddle        35,400         ->    ~41
//   $50K Tuddy           8,400         ->    ~10
//
// That matters for how a roster should be built. Winning a 1,088-team final needs a
// ~99.9th-percentile week; winning a 10-team final needs ~90th. Those are different
// asks, and a constant tuned against one of them is not obviously right for the
// other. Nested prefixes of the sampled field give every size in a single run — the
// field is shuffled first so a prefix is a random subset rather than the strongest.
// Confirmed against DK's own "Contest Sizes" panel for the $200K Bubble Screen:
// Round 1 top-2-of-12, Round 2 top-1-of-12, Round 3 top-1-of-12, Round 4 = 18 players.
// 15,500 / 864 = 17.9, so the 1-in-864 derivation is exact and the listed round sizes
// assume a full contest — an underfilled one produces a smaller final, not an easier
// path to the same 18.
const FINAL_SIZES = [10, 18, 45, 229, 458, 1089];

// Payout inside the final, as a share of that final's prize pool. A power law over
// rank, paying the top `paidFrac`. At alpha 1.7 / 36.7% paid this puts ~51% of the
// pool on first place, which is where the published 1,089-team Millionaire table
// sits — close enough for comparative statics, though it smooths the real curve's
// middle. Reported as a share, so contests with different pool sizes stay comparable.
function buildFinalPayouts(n, alpha, paidFrac) {
  const paid  = Math.max(1, Math.round(n * paidFrac));
  const share = new Float64Array(n + 1);
  let norm = 0;
  for (let r = 1; r <= paid; r++) norm += Math.pow(r, -alpha);
  for (let r = 1; r <= paid; r++) share[r] = Math.pow(r, -alpha) / norm;
  return share;
}

// Weekly starting slots per position, used to define "the startable tier" a breakout
// lands in. Mirrors the recommender's lineup shape.
const STARTABLE = { QB: 1.0, RB: 2.3, WR: 3.6, TE: 1.1 };

// How often roles change from what the projection assumed. Tunable so the harness's
// own assumptions can be stress-tested rather than trusted — a conclusion that only
// holds at one breakout rate is not a conclusion.
const BREAKOUT_BASE = process.env.SIM_BREAKOUT ? parseFloat(process.env.SIM_BREAKOUT) : 0.14;
const BUST_BASE     = process.env.SIM_BUST     ? parseFloat(process.env.SIM_BUST)     : 0.14;

// ── In-season absence ────────────────────────────────────────────────────────
// Until this existed the only things that zeroed a player were a bye week and a
// missing playoff game, so nobody was ever hurt and roster depth had no value the
// simulator could see. That is not a small omission: covering injuries is most of
// why you carry a 5th running back, and the harness was structurally incapable of
// pricing it — the same shape of blindness the 12-team-pod final had toward stacking.
//
// Modelled as ONE CONTIGUOUS WINDOW rather than independent weekly coin flips.
// Scattered single missed weeks are easy to absorb; what actually hurts is losing a
// back for five straight weeks, and depth is what covers that. Independent draws
// would match the mean and completely miss the clustering that gives depth its value.
//
// Calibrated off `_eff.avail` — P(active in a non-bye week), which is
// `1 - POS_INJURY_RATE[pos]` from app/projections.py (QB .12 / RB .18 / WR .14 /
// TE .15) unless the projection itself forecasts a short season. Expected weeks
// missed is (1 - avail) * 17, so P(injured at all) = that over the mean duration.
const SIM_INJURIES = process.env.SIM_INJURIES !== '0';
const INJURY_MEAN_WEEKS = process.env.SIM_INJURY_WEEKS ? parseFloat(process.env.SIM_INJURY_WEEKS) : 6.0;

// A window starting in week 15 cannot cost six weeks, so naive `expectedOut / mean`
// undershoots the target by ~17%. With a uniform start and exponential duration the
// expected TRUNCATED length is (m/17) * sum_{k=1..17} (1 - e^{-k/m}), which is exact
// and re-derives itself if the mean duration is retuned.
const INJURY_EFFECTIVE_WEEKS = (() => {
  const m = INJURY_MEAN_WEEKS;
  let s = 0;
  for (let k = 1; k <= 17; k++) s += 1 - Math.exp(-k / m);
  return (m / 17) * s;
})();
const ROUNDS    = 20;

// Weekly lineup: 1 QB, 2 RB, 3 WR, 1 TE, 1 FLEX (RB/WR/TE)
const POS = ['QB', 'RB', 'WR', 'TE'];
const POS_IDX = { QB: 0, RB: 1, WR: 2, TE: 3 };
const LINEUP = { QB: 1, RB: 2, WR: 3, TE: 1 };
const LINEUP_N = POS.map(p => LINEUP[p]);
const FLEX_OK  = POS.map(p => p !== 'QB');

// How strongly each position loads on its team's weekly game environment.
// This is what makes stacking mathematically worthwhile in the simulation.
const TEAM_LOADING = { QB: 0.75, WR: 0.65, TE: 0.60, RB: 0.35 };
const LOAD = POS.map(p => TEAM_LOADING[p]);

// These two set the ceiling on what correlation can possibly be worth: they are the
// entire reason a stack outscores two unrelated players. They were assumed, not
// measured, so every conclusion about V2_CORRELATION_WEIGHT is conditional on them
// and a constant tuned at one setting may be fitted to the simulator's tails rather
// than to football. Overridable so that can be tested rather than argued about.
const TEAM_FACTOR_CV = process.env.SIM_TEAM_CV ? parseFloat(process.env.SIM_TEAM_CV) : 0.35;
const GAME_FACTOR_CV = process.env.SIM_GAME_CV ? parseFloat(process.env.SIM_GAME_CV) : 0.22;

const T_SIGMA = Math.sqrt(Math.log(1 + TEAM_FACTOR_CV ** 2));
const G_SIGMA = Math.sqrt(Math.log(1 + GAME_FACTOR_CV ** 2));

// ── Deterministic RNG so runs are reproducible ────────────────────────────────
function mulberry32(seed) {
  const f = function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.spare = null;   // see gauss(): Box-Muller's second variate, per stream
  return f;
}

// Box-Muller produces two independent normals per pair of uniforms; the second is
// cached ON THE STREAM rather than in a module-level variable, so interleaving
// several rngs (draft bots, truth assignment, season weather) cannot leak a variate
// from one stream into another.
function gauss(rng) {
  if (rng.spare !== null) { const s = rng.spare; rng.spare = null; return s; }
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const r = Math.sqrt(-2 * Math.log(u)), th = 2 * Math.PI * v;
  rng.spare = r * Math.sin(th);
  return r * Math.cos(th);
}

// ── Data loading ──────────────────────────────────────────────────────────────

function loadData() {
  const cachePath = path.join(ROOT, 'app', 'data', 'player_cache.json');
  const projPath  = path.join(ROOT, 'app', 'data', 'projection_cache.json');

  const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  let players = (Array.isArray(raw) ? raw : raw.players).map(p => ({ ...p }));
  players = players.filter(p => POS.includes(p.pos));

  let projMap = {};
  if (fs.existsSync(projPath)) {
    const pj = JSON.parse(fs.readFileSync(projPath, 'utf8'));
    for (const e of pj.players) if (e.id) projMap[e.id] = e;
  } else {
    console.error('No projection_cache.json — run:  python3 -c "import sys;sys.path.insert(0,\'.\');'
                + 'from app.projections import get_projections as g;g(force_refresh=True)"');
    process.exit(1);
  }

  // V1 reads player.adp directly; V2 reads realAdp ?? adp. Set both so neither
  // model is accidentally advantaged by the field it happens to look at.
  for (const p of players) p.realAdp = p.adp;

  V2.v2AttachEffective(players, projMap, {});
  return players;
}

// ── Scoring context ───────────────────────────────────────────────────────────
//
// Everything the weekly simulation needs, flattened into typed arrays and indexed
// by a per-player slot `_si`. Rosters are then just lists of `_si`, which is what
// lets one week's draw be shared by 1,089 teams at once.

function buildScoringContext(players) {
  const scored = players.filter(p => p._eff);
  scored.forEach((p, i) => { p._si = i; });
  const n = scored.length;

  const ctx = {
    players: scored, n,
    pos:   new Int32Array(n),
    team:  new Int32Array(n),
    bye:   new Int32Array(n),
    game:  { 15: new Int32Array(n), 16: new Int32Array(n), 17: new Int32Array(n) },
    mean:  new Float64Array(n),
    missFrom: new Int32Array(n),
    missTo:   new Int32Array(n),
    idioReg: new Float64Array(n),
    idioPo:  new Float64Array(n),
    scores:  new Float64Array(n),
  };

  const teamIdx = new Map();
  for (let i = 0; i < n; i++) {
    const p = scored[i];
    ctx.pos[i] = POS_IDX[p.pos];
    ctx.bye[i] = p.bye || 0;
    const t = p.team && p.team !== 'FA' ? p.team : null;
    if (t === null) ctx.team[i] = -1;
    else {
      if (!teamIdx.has(t)) teamIdx.set(t, teamIdx.size);
      ctx.team[i] = teamIdx.get(t);
    }
  }
  ctx.nTeams = teamIdx.size;

  // Playoff-week games. Both sides of one game share a factor, which is what makes
  // a game stack (as opposed to a team stack) mean anything.
  ctx.nGames = {};
  for (const wk of [15, 16, 17]) {
    const gameIdx = new Map();
    for (let i = 0; i < n; i++) {
      const p = scored[i];
      const opp = p[`week${wk}`];
      if (!opp || !p.team || p.team === 'FA') { ctx.game[wk][i] = -1; continue; }
      const key = [p.team, opp].sort().join('@');
      if (!gameIdx.has(key)) gameIdx.set(key, gameIdx.size);
      ctx.game[wk][i] = gameIdx.get(key);
    }
    ctx.nGames[wk] = gameIdx.size;
  }

  // Per-week scratch: one extra slot on each factor array holds 1.0, so a player
  // with no team (index -1) needs no branch.
  const maxGames = Math.max(ctx.nGames[15], ctx.nGames[16], ctx.nGames[17]);
  ctx.teamPow = POS.map(() => new Float64Array(ctx.nTeams + 1));
  ctx.gamePow = POS.map(() => new Float64Array(maxGames + 1));
  ctx.teamRaw = new Float64Array(ctx.nTeams);
  ctx.gameRaw = new Float64Array(maxGames);

  // Static inputs to the truth model: the projected-points curve per position, and
  // each player's rank on the ADP board. Neither depends on the world being drawn,
  // and recomputing them per draft was an O(n^2) indexOf scan.
  ctx.curves = {};
  for (const pos of POS) {
    ctx.curves[pos] = scored.filter(p => p.pos === pos).map(p => p._eff.mean).sort((a, b) => b - a);
  }
  for (const pos of POS) {
    const byAdp = scored.filter(p => p.pos === pos).sort((a, b) => a.adp - b.adp);
    byAdp.forEach((p, i) => { p._adpRank = i; });
  }
  ctx.startable = {};
  ctx.tierFloor = {};
  for (const pos of POS) {
    const c = ctx.curves[pos];
    const s = Math.max(3, Math.round(STARTABLE[pos] * NUM_TEAMS));
    ctx.startable[pos] = s;
    ctx.tierFloor[pos] = c[Math.min(c.length - 1, s)] ?? 0;
  }

  return ctx;
}

// Flatten the per-player variance budget for the current truth assignment. Called
// once per world instead of once per player per week, which is where the old inner
// loop spent most of its time.
function compileTruth(ctx) {
  for (let i = 0; i < ctx.n; i++) {
    const p = ctx.players[i];
    if (!p._true) { ctx.mean[i] = 0; continue; }
    ctx.mean[i] = p._true.mean;
    const load = LOAD[ctx.pos[i]];
    const total = Math.log(1 + p._true.cv ** 2);
    const tSig2 = (T_SIGMA * load) ** 2;
    const gSig2 = (G_SIGMA * load) ** 2;
    ctx.idioReg[i] = Math.sqrt(Math.max(0.01, total - tSig2));
    ctx.idioPo[i]  = Math.sqrt(Math.max(0.01, total - tSig2 - gSig2));
  }
}

// One week of football, for everybody at once. Returns ctx.scores — a live buffer,
// valid until the next call.
function drawWeekScores(ctx, week, rng) {
  const playoff = week >= 15;
  const { teamRaw, gameRaw, teamPow, gamePow, nTeams } = ctx;

  for (let t = 0; t < nTeams; t++) {
    teamRaw[t] = Math.exp(gauss(rng) * T_SIGMA - T_SIGMA * T_SIGMA / 2);
  }
  for (let k = 0; k < 4; k++) {
    const arr = teamPow[k], load = LOAD[k];
    for (let t = 0; t < nTeams; t++) arr[t] = Math.pow(teamRaw[t], load);
    arr[nTeams] = 1;
  }

  const nG = playoff ? ctx.nGames[week] : 0;
  if (playoff) {
    for (let g = 0; g < nG; g++) {
      gameRaw[g] = Math.exp(gauss(rng) * G_SIGMA - G_SIGMA * G_SIGMA / 2);
    }
    for (let k = 0; k < 4; k++) {
      const arr = gamePow[k], load = LOAD[k];
      for (let g = 0; g < nG; g++) arr[g] = Math.pow(gameRaw[g], load);
    }
  }

  const { scores, mean, pos, team, bye, n, missFrom, missTo } = ctx;
  const gameW = playoff ? ctx.game[week] : null;
  const sig = playoff ? ctx.idioPo : ctx.idioReg;

  for (let i = 0; i < n; i++) {
    const m = mean[i];
    if (m <= 0 || bye[i] === week) { scores[i] = 0; continue; }
    if (week >= missFrom[i] && week <= missTo[i]) { scores[i] = 0; continue; }
    const k = pos[i];
    let f = teamPow[k][team[i] < 0 ? nTeams : team[i]];
    if (playoff) {
      const g = gameW[i];
      // No game scheduled in a knockout week means no points, which is the whole
      // reason playoff schedule shows up in the recommender at all.
      if (g < 0) { scores[i] = 0; continue; }
      f *= gamePow[k][g];
    }
    const s = sig[i];
    scores[i] = m * f * Math.exp(gauss(rng) * s - s * s / 2);
  }
  return scores;
}

// A roster reduced to what scoring needs: score-indices grouped by position.
function toFastRoster(roster) {
  const byPos = [[], [], [], []];
  for (const p of roster) {
    if (p._si === undefined) continue;
    byPos[POS_IDX[p.pos]].push(p._si);
  }
  return byPos.map(a => Int32Array.from(a));
}

const _lineupBuf = [new Float64Array(32), new Float64Array(32), new Float64Array(32), new Float64Array(32)];

// Optimal best-ball lineup for one week: best N at each position plus one flex.
function scoreRoster(fr, scores) {
  let total = 0, bestLeft = 0;
  for (let k = 0; k < 4; k++) {
    const ids = fr[k], len = ids.length;
    if (!len) continue;
    const buf = _lineupBuf[k];
    for (let j = 0; j < len; j++) buf[j] = scores[ids[j]];
    // Descending insertion sort — rosters hold at most ~10 per position.
    for (let j = 1; j < len; j++) {
      const v = buf[j];
      let m = j - 1;
      while (m >= 0 && buf[m] < v) { buf[m + 1] = buf[m]; m--; }
      buf[m + 1] = v;
    }
    const need = LINEUP_N[k];
    const take = len < need ? len : need;
    for (let j = 0; j < take; j++) total += buf[j];
    if (FLEX_OK[k] && len > need && buf[need] > bestLeft) bestLeft = buf[need];
  }
  return total + bestLeft;
}

// ── "True" player ability for the season simulation ───────────────────────────
//
// proj:   truth == the projections V2 optimises against (flatters V2)
// market: truth == ADP-implied ability, so neither model has an information edge
function assignTruth(players, mode, rng, ctx) {
  for (const p of players) {
    if (!p._eff) { p._true = null; continue; }

    const c = ctx.curves[p.pos];
    let mean;
    if (mode === 'market') {
      mean = c[Math.min(c.length - 1, p._adpRank)] ?? c[c.length - 1];
    } else {
      mean = p._eff.mean;
    }

    // Real outcomes are not the projection — add season-long "who they turned out
    // to be" noise so neither model gets a perfect board.
    const noise = Math.exp(gauss(rng) * 0.30 - 0.045);
    mean *= noise;

    // ── Regime change ────────────────────────────────────────────────────────
    // Lognormal noise around a projection cannot produce a breakout. It scales a
    // player up or down a bit; it never turns a 3-ppg bench body into a 13-ppg
    // starter. Real drafts are decided by exactly that event, and without it the
    // simulator silently assumes every player's role is already known — which
    // makes it incapable of judging any model that bets on uncertainty, while
    // still returning confident-looking numbers.
    //
    // A breakout is modelled as what it actually is: winning a role. The player's
    // true ability jumps to somewhere inside his position's startable tier rather
    // than being multiplied by a fudge factor, so the size of the jump follows
    // from how far down the board he started.
    //
    // Probability rises with expert disagreement, which is the observable the
    // recommender keys on, and with how little the projection expects of him — a
    // player with no assumed role has the most room to gain one. Busts are the
    // mirror image, so the feature cannot win simply by adding upside.
    const startable = ctx.startable[p.pos];
    const tierFloor = ctx.tierFloor[p.pos];
    const headroom = tierFloor > 0 ? Math.max(0, Math.min(1, 1 - mean / tierFloor)) : 0;
    const dis = p._eff.disagreement ?? 0;

    const pBreak = Math.min(0.30, BREAKOUT_BASE * (0.35 + dis) * (0.25 + headroom));
    const pBust  = Math.min(0.30, BUST_BASE * (0.35 + dis) * (1.25 - headroom));

    const roll = rng();
    if (roll < pBreak) {
      // Wins a role: lands somewhere in the startable tier for his position.
      const idx = Math.floor(rng() * startable);
      const target = c[Math.min(c.length - 1, idx)] ?? mean;
      mean = Math.max(mean, target * (0.65 + 0.35 * rng()));
    } else if (roll < pBreak + pBust) {
      // Loses the role the projection assumed: usage collapses.
      mean *= 0.30 + 0.35 * rng();
    }

    p._true = { mean, cv: p._eff.sd / Math.max(p._eff.mean, 0.01) };

    // Injury window for this season, drawn once per world per player.
    const si = p._si;
    if (si === undefined) continue;
    ctx.missFrom[si] = 0; ctx.missTo[si] = -1;
    if (SIM_INJURIES) {
      const avail = p._eff.avail ?? 1;
      const expectedOut = (1 - avail) * 17;
      const pHurt = Math.min(0.95, expectedOut / INJURY_EFFECTIVE_WEEKS);
      if (rng() < pHurt) {
        // Exponential duration: most injuries are short, a few end the season.
        const dur   = Math.max(1, Math.round(-INJURY_MEAN_WEEKS * Math.log(1 - rng() * 0.999)));  // exponential
        const start = 1 + Math.floor(rng() * 17);
        ctx.missFrom[si] = start;
        ctx.missTo[si]   = Math.min(17, start + dur - 1);
      }
    }
  }
  compileTruth(ctx);
}

// ── Draft simulation ──────────────────────────────────────────────────────────

function snakeSlot(pick, numTeams) {
  const round = Math.floor((pick - 1) / numTeams);
  const idx   = (pick - 1) % numTeams;
  return round % 2 === 0 ? idx : numTeams - 1 - idx;
}

// ADP bot with noise and loose positional limits, standing in for the other seats.
const BOT_LIMITS = { QB: 3, RB: 8, WR: 10, TE: 3 };

// ...and a hard floor: enough bodies to actually field a weekly lineup. Without it
// a pure-ADP bot will happily finish a draft with zero quarterbacks and score a
// structural zero at that slot every week, because QB and TE ADP sits far below the
// top of the board (QB median ADP ~116, TE ~149). In a 12-team draft the board runs
// deep enough that this rarely bites; in a 3-team Sit & Go only ~60 players come off
// the board, so it happens constantly and hands the model under test a free win it
// would never get against a human. The floor is the weekly lineup and nothing more —
// it stops the bot being broken without dictating a roster build.
const BOT_MINIMUMS = { QB: 1, RB: 2, WR: 3, TE: 1 };

function botPick(available, roster, rng, picksLeft) {
  const counts = {};
  for (const p of roster) counts[p.pos] = (counts[p.pos] || 0) + 1;

  let unmet = 0;
  for (const pos of POS) unmet += Math.max(0, BOT_MINIMUMS[pos] - (counts[pos] || 0));

  // Out of slack: every remaining pick has to go toward the lineup floor. Scan the
  // whole board, not just the top 40 — the needed QB may be 90 picks down.
  if (picksLeft !== undefined && unmet >= picksLeft) {
    let best = null, bestScore = Infinity;
    for (let i = 0; i < available.length; i++) {
      const p = available[i];
      if ((counts[p.pos] || 0) >= BOT_MINIMUMS[p.pos]) continue;
      const score = p.adp + gauss(rng) * Math.max(4, p.adp * 0.12);
      if (score < bestScore) { bestScore = score; best = p; }
    }
    if (best) return best;
  }

  let best = null, bestScore = Infinity;
  for (let i = 0; i < Math.min(available.length, 40); i++) {
    const p = available[i];
    if ((counts[p.pos] || 0) >= BOT_LIMITS[p.pos]) continue;
    const score = p.adp + gauss(rng) * Math.max(4, p.adp * 0.12);
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best || available[0];
}

function nextPickForSlot(fromPick, slot, numTeams) {
  for (let pick = fromPick; pick <= numTeams * ROUNDS; pick++) {
    if (snakeSlot(pick, numTeams) === slot) return pick;
  }
  return null;
}

// All of a slot's remaining pick numbers after `fromPick`, in order.
function remainingPicksForSlot(fromPick, slot, numTeams) {
  const out = [];
  for (let pick = fromPick; pick <= numTeams * ROUNDS; pick++) {
    if (snakeSlot(pick, numTeams) === slot) out.push(pick);
  }
  return out;
}

// `modelBySlot` is one entry per seat: null for an ADP bot, 'v1' or 'v2' for a seat
// drafted by that recommender. An all-null array is a pure bot pod, which is how the
// final's field used to be built in full.
//
// `numTeams` is a parameter only so the Sit & Go tool can run 3- and 6-team drafts;
// both recommenders are internally hardcoded to a 12-team league, which is itself
// one of the findings there.
// `opts.forceRound` / `opts.forcePos`: at that round the model seat takes the best
// available player of that position instead of its top overall pick. This is the only
// way to ask a counterfactual ("what if I'd taken a 5th RB there?") rather than
// reading roster shape off drafts that happened to go that way — see tools/rb-depth.js.
function simulateDraft(players, modelBySlot, rng, numTeams = NUM_TEAMS, opts = {}) {
  const available = players.filter(p => p._eff).sort((a, b) => a.adp - b.adp);
  const pool      = available.slice();
  const rosters   = Array.from({ length: numTeams }, () => []);

  for (let pick = 1; pick <= numTeams * ROUNDS; pick++) {
    const slot = snakeSlot(pick, numTeams);
    const model = modelBySlot[slot] || null;
    let chosen;

    if (model) {
      const myTeam   = rosters[slot];
      const nextPick = nextPickForSlot(pick + 1, slot, numTeams);

      const round = Math.floor((pick - 1) / numTeams) + 1;
      let force = (opts.forcePos && round === opts.forceRound) ? opts.forcePos : null;

      // `posBan` forbids a position before a given round. Needed because V2 almost
      // never goes RB-light on its own — only 14 of 300 drafts took <=1 back in the
      // first six rounds — so the branch where "wait and stockpile" would pay cannot
      // be measured without manufacturing it.
      const ban = (opts.posBan && round <= opts.posBan.throughRound) ? opts.posBan.pos : null;

      // Positional floor. Forcing a single round does nothing useful — the model
      // simply rebalances later and lands on the same shape (verified: forcing an RB
      // at round 8 produced 3-5-9-3 against a 2-5-9-4 baseline, the same 5 backs).
      // To ask "what does carrying N cost me" the TARGET has to be forced, not a pick.
      // `count` may be a function of the roster so far, which is what makes a
      // CAPITAL-AWARE policy expressible: "if I waited on RB, carry more bodies;
      // if I spent early picks there, carry fewer." A fixed floor cannot say that,
      // and averaging over both situations can hide a real conditional effect.
      if (opts.posFloor && round >= opts.posFloor.fromRound) {
        const have = myTeam.filter(p => p.pos === opts.posFloor.pos).length;
        const want = typeof opts.posFloor.count === 'function'
          ? opts.posFloor.count(myTeam) : opts.posFloor.count;
        if (have < want) force = opts.posFloor.pos;
      }
      const want  = (force || ban) ? 60 : 1;

      let recs;
      if (model === 'v1') {
        recs = V1.getTopRecommendations(pool, myTeam, pick, 'heavy', want, nextPick);
      } else {
        const myPicks = remainingPicksForSlot(pick + 1, slot, numTeams);
        recs = V2.getTopRecommendationsV2(pool, myTeam, pick, want, nextPick, myPicks, players);
      }
      let cands = ban ? recs.filter(r => r.player.pos !== ban) : recs;
      if (!cands.length) cands = recs;

      if (force) {
        // A forced position may not appear in the top `want` at all — V2 penalises a
        // 4th QB by 3.0 ppw, which buries every remaining one far below rank 60. A
        // floor that silently fails to bind would report "4 QBs is the same as 3"
        // when it never drafted a 4th, so fall through to the board itself.
        const hit = cands.find(r => r.player.pos === force);
        chosen = hit ? hit.player
                     : (pool.find(p => p.pos === force) || (cands[0] && cands[0].player) || pool[0]);
      } else {
        chosen = cands[0] ? cands[0].player : pool[0];
      }
    } else {
      chosen = botPick(pool, rosters[slot], rng, ROUNDS - rosters[slot].length);
    }

    const idx = pool.indexOf(chosen);
    if (idx >= 0) pool.splice(idx, 1);
    // V1's dynamicTarget reads p.round off rostered players.
    rosters[slot].push({ ...chosen, round: Math.floor((pick - 1) / numTeams) + 1 });
  }

  return rosters;
}

// ── Season simulation ─────────────────────────────────────────────────────────

function simulateSeason(fastRosters, rng, ctx) {
  const nR  = fastRosters.length;
  const acc = new Float64Array(nR);
  const wk  = { 15: null, 16: null, 17: null };

  for (let week = 1; week <= 17; week++) {
    const scores = drawWeekScores(ctx, week, rng);
    if (week <= 14) {
      for (let i = 0; i < nR; i++) acc[i] += scoreRoster(fastRosters[i], scores);
    } else {
      const out = new Float64Array(nR);
      for (let i = 0; i < nR; i++) out[i] = scoreRoster(fastRosters[i], scores);
      wk[week] = out;
    }
  }
  // ctx.scores still holds week 17 — the caller scores the final field against it
  // before anything else draws. Passing the buffer instead of copying it is what
  // keeps a 1,089-team final affordable.
  return { acc, wk, wk17Scores: ctx.scores };
}

function rankOf(arr, i) {
  let better = 1;
  for (let k = 0; k < arr.length; k++) if (arr[k] > arr[i]) better++;
  return better;
}

// ── The final field ───────────────────────────────────────────────────────────
//
// The single biggest thing this harness used to get wrong. Week 17 was scored as
// top-1-of-12 against the same pod the team had played all season, when the real
// contest is ~1,089 pod winners in one room with a payout curve that pays 5,000x
// more for first than for 400th. Correlation exists to buy the extreme right tail;
// a 12-team pod never asks for one, so the harness's verdict that stacking hurt was
// a verdict on a tournament that does not exist.
//
// Construction:
//   1. Draft a large population of all-bot rosters.
//   2. Estimate each one's probability of surviving the same three phases the model
//      has to survive — top 2 of 12 over weeks 1-14, then win week 15, then win
//      week 16 — by simulating the population across many worlds and reading each
//      roster's percentile F in the population that week. Beating 11 random
//      opponents is F^11, and finishing top-2 of 12 is F^11 + 11·F^10·(1−F).
//   3. SAMPLE 1,088 rosters without replacement with those probabilities as weights.
//
// Step 3 is the part that is easy to get wrong. Taking the top 1,088 by propensity
// instead would build a field of the intrinsically best rosters — but a real final
// is not the best 1,089 teams, it is 1,089 teams that beat 11 opponents twice in a
// row, which is mostly a very good team and partly a lucky mediocre one. A field
// with the luck squeezed out is far too strong, and it would understate every
// high-variance strategy by making first place unreachable.
//
// Residual approximation, stated plainly: field membership is decided across many
// worlds, while the model's own finalist qualified inside the world it is scored
// in. Simulating true in-world qualification for the field would cost ~110,000
// team-seasons per world. The field is also drawn from ADP bots, so it is a field
// of ordinary drafters that got hot, not of sharp ones.

// `sharpSeats` of each pod's 12 seats are drafted by a recommender instead of an ADP
// bot, alternating V1 and V2 so the field is not a monoculture — a field of nothing
// but V2 rosters would penalise V2 specifically, by making it duplicate itself.
//
// This is the expensive part of the harness (~5ms per model pick), so the result is
// cached to disk keyed by everything that affects it. Sweeps then pay for it once.
function buildFieldPods(players, nPods, seed, sharpSeats = 0) {
  const cacheDir  = path.join(__dirname, '.field-cache');
  const cacheFile = path.join(cacheDir, `pods-${nPods}-${sharpSeats}-${seed}.json`);
  const byId = new Map(players.map(p => [p.id, p]));

  if (fs.existsSync(cacheFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (raw.nPods === nPods && raw.sharpSeats === sharpSeats && raw.seed === seed) {
        return raw.pods.map(pod => pod.map(ids => toFastRoster(
          ids.map(id => byId.get(id)).filter(Boolean))));
      }
    } catch { /* fall through and rebuild */ }
  }

  const pods = [], serial = [];
  for (let i = 0; i < nPods; i++) {
    const modelBySlot = new Array(NUM_TEAMS).fill(null);
    // Spread the sharp seats around the snake rather than clustering them at the top.
    for (let k = 0; k < sharpSeats; k++) {
      const slot = Math.floor((k * NUM_TEAMS) / Math.max(1, sharpSeats) + (i % NUM_TEAMS)) % NUM_TEAMS;
      modelBySlot[slot] = (i + k) % 2 === 0 ? 'v2' : 'v1';
    }
    const rosters = simulateDraft(players, modelBySlot, mulberry32(seed + i * 104729));
    pods.push(rosters.map(toFastRoster));
    serial.push(rosters.map(r => r.map(p => p.id)));
  }

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ nPods, sharpSeats, seed, pods: serial }));
  } catch { /* cache is an optimisation, not a requirement */ }

  return pods;
}

// Percentile of every candidate within the population, as `out[i] = F(vals[i])`.
function cdfRanks(vals, srt, out, n) {
  srt.set(vals);
  srt.sort();
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (srt[mid] < v) lo = mid + 1; else hi = mid; }
    out[i] = lo / n;
  }
}

function selectFinalField(players, ctx, pods, truth, size, worlds, seed) {
  const cands = [];
  for (const pod of pods) for (const r of pod) cands.push(r);

  const nC   = cands.length;
  const qual = new Float64Array(nC);   // summed P(reach the final), across worlds
  const str  = new Float64Array(nC);   // summed knockout-week percentile — a readout
  const acc  = new Float64Array(nC);
  const s15  = new Float64Array(nC);
  const srt  = new Float64Array(nC);
  const fAcc = new Float64Array(nC);
  const f15  = new Float64Array(nC);
  const f16  = new Float64Array(nC);

  for (let w = 0; w < worlds; w++) {
    const rng = mulberry32(seed + w * 7907);
    assignTruth(players, truth, rng, ctx);

    acc.fill(0);
    for (let week = 1; week <= 14; week++) {
      const scores = drawWeekScores(ctx, week, rng);
      for (let i = 0; i < nC; i++) acc[i] += scoreRoster(cands[i], scores);
    }
    let scores = drawWeekScores(ctx, 15, rng);
    for (let i = 0; i < nC; i++) s15[i] = scoreRoster(cands[i], scores);
    cdfRanks(s15, srt, f15, nC);

    scores = drawWeekScores(ctx, 16, rng);
    for (let i = 0; i < nC; i++) s15[i] = scoreRoster(cands[i], scores);
    cdfRanks(s15, srt, f16, nC);

    cdfRanks(acc, srt, fAcc, nC);

    for (let i = 0; i < nC; i++) {
      const A = fAcc[i];
      // Top 2 of 12 against 11 draws from the population: nobody above, or one.
      const pAcc = Math.pow(A, 10) * (A + 11 * (1 - A));
      qual[i] += pAcc * Math.pow(f15[i], 11) * Math.pow(f16[i], 11);
      str[i]  += f15[i];
    }
  }

  // Weighted sampling without replacement (Efraimidis-Spirakis): the k smallest
  // keys of -ln(u)/w are a sample drawn proportionally to w.
  const rng  = mulberry32(seed + 31337);
  const keys = new Float64Array(nC);
  for (let i = 0; i < nC; i++) {
    keys[i] = qual[i] > 0 ? -Math.log(rng() || 1e-12) / qual[i] : Infinity;
  }
  const order = Array.from({ length: nC }, (_, i) => i).sort((a, b) => keys[a] - keys[b]);
  const keep  = order.slice(0, Math.min(size, nC));

  // Sorting by key leaves the strongest rosters at the front. Shuffle so that a
  // prefix of the field is a random subset of it — that is what makes nested
  // prefixes valid smaller finals rather than all-star games.
  for (let i = keep.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = keep[i]; keep[i] = keep[j]; keep[j] = t;
  }

  const meanStr = keep.reduce((s, i) => s + str[i], 0) / (keep.length * worlds);
  const totQ    = qual.reduce((s, v) => s + v, 0);
  return {
    rosters: keep.map(i => cands[i]),
    candidates: nC,
    // Median-ish strength of the field, as a percentile of the bot population in a
    // knockout week. A field of average rosters would read 50%.
    fieldStrength: meanStr,
    // Share of all qualification probability the sampled field accounts for.
    weightShare: totQ > 0 ? keep.reduce((s, i) => s + qual[i], 0) / totQ : 0,
  };
}

// Where `myScore` lands among the field. 1 == won the final.
//
// `out` collects the placement inside each nested prefix as well, so one pass over
// the 1,088 field rosters prices every contest size at once.
function placeInField(field, scores, myScore, sizes, out) {
  let better = 1, si = 0;
  for (let i = 0; i < field.length; i++) {
    while (si < sizes.length && i === sizes[si] - 1) out[si++] = better;
    if (scoreRoster(field[i], scores) > myScore) better++;
  }
  while (si < sizes.length) out[si++] = better;
  return better;
}

// ── Running the comparison ────────────────────────────────────────────────────

function evaluate(model, opts) {
  const { drafts, seasons, truth, players, ctx, field, baseSeed } = opts;
  const fieldSize = field.rosters.length + 1;

  const stats = {
    advance14: 0, win15: 0, win16: 0,
    reachFinal: 0, winFinal: 0, top15: 0, cashBig: 0,
    accPoints: 0, wk17Points: 0, n: 0,
    ev: 0, evNoJp: 0, placeSum: 0,
    posCounts: { QB: 0, RB: 0, WR: 0, TE: 0 },
    stackedPasscatchers: 0, playoffPartners: 0,
    // Advance rate bucketed by the roster construction that produced it. The public
    // best-ball research reports exactly this, and its central claim — that some
    // builds fail regardless of who is in them — is testable here rather than taken
    // on faith. Recording the shape a model actually produces alongside how those
    // rosters performed also shows whether an average like "2.4 QB" hides a tail of
    // 1-QB rosters, which the research says is among the worst constructions.
    byBuild: new Map(),
  };

  const JACKPOT = FINAL_PAYOUTS[0][1];

  // Contest-size sensitivity: EV as a share of the final's prize pool, for each
  // final size, so builds can be compared across contests with different pools.
  const sizes    = FINAL_SIZES.filter(s => s <= fieldSize);
  const payTable = sizes.map(s => buildFinalPayouts(s, opts.finalAlpha, opts.finalPaid));
  const evBySize = new Float64Array(sizes.length);
  const winBySize = new Float64Array(sizes.length);
  const placeBuf = new Int32Array(sizes.length);

  for (let d = 0; d < drafts; d++) {
    const seed = baseSeed + d * 7919;
    const rng  = mulberry32(seed);
    assignTruth(players, truth, rng, ctx);

    const slot    = d % NUM_TEAMS;
    const modelBySlot = new Array(NUM_TEAMS).fill(null);
    modelBySlot[slot] = model;
    const rosters = simulateDraft(players, modelBySlot, mulberry32(seed + 1));
    const mine    = rosters[slot];
    const fast    = rosters.map(toFastRoster);

    for (const p of mine) stats.posCounts[p.pos]++;
    // Roster shape diagnostics
    const qbTeams = new Set(mine.filter(p => p.pos === 'QB').map(p => p.team));
    stats.stackedPasscatchers += mine.filter(p => ['WR', 'TE'].includes(p.pos) && qbTeams.has(p.team)).length;
    for (const p of mine) {
      for (const w of [15, 16, 17]) {
        if (mine.some(m => m !== p && m.team === p[`week${w}`])) { stats.playoffPartners++; break; }
      }
    }

    const build = POS.map(p => mine.filter(x => x.pos === p).length).join('-');
    if (!stats.byBuild.has(build)) stats.byBuild.set(build, { n: 0, adv: 0, fin: 0, ev: 0 });
    const bucket = stats.byBuild.get(build);

    // Same season draws for every model via a seed tied to the draft index only.
    for (let s = 0; s < seasons; s++) {
      const srng = mulberry32(seed + 100000 + s);
      const { acc, wk, wk17Scores } = simulateSeason(fast, srng, ctx);

      stats.n++;
      stats.accPoints  += acc[slot];
      stats.wk17Points += wk[17][slot];

      const advanced = rankOf(acc, slot) <= 2;
      if (advanced) stats.advance14++;
      bucket.n++;
      if (advanced) bucket.adv++;

      const w15 = rankOf(wk[15], slot) === 1;
      const w16 = rankOf(wk[16], slot) === 1;
      if (w15) stats.win15++;
      if (w16) stats.win16++;

      // ── Expected dollars ─────────────────────────────────────────────────
      // Consolations are small and near-certain; the final is enormous and rare.
      // Reporting only advance rate hides which of those a model is buying.
      if (advanced && !w15) { stats.ev += PAYOUT_WK15_CONSOLATION; stats.evNoJp += PAYOUT_WK15_CONSOLATION; }
      else if (advanced && w15 && !w16) { stats.ev += PAYOUT_WK16_CONSOLATION; stats.evNoJp += PAYOUT_WK16_CONSOLATION; }
      else if (advanced && w15 && w16) {
        stats.reachFinal++; bucket.fin++;

        // The real thing: one common week 17, ~1,089 teams, top-heavy payouts.
        const place = placeInField(field.rosters, wk17Scores, wk[17][slot], sizes, placeBuf);
        for (let k = 0; k < sizes.length; k++) {
          evBySize[k] += payTable[k][placeBuf[k]] || 0;
          if (placeBuf[k] === 1) winBySize[k]++;
        }
        const frac  = place / fieldSize;
        const prize = finalPayout(frac);

        stats.placeSum += frac;
        if (place === 1) stats.winFinal++;
        if (place <= 15) stats.top15++;
        if (prize >= 1000) stats.cashBig++;
        stats.ev    += prize;
        stats.evNoJp += prize >= JACKPOT ? FINAL_PAYOUTS[1][1] : prize;
        bucket.ev   += prize;
      }
    }
  }

  const n = stats.n || 1;
  return {
    advance14:  stats.advance14 / n,
    seasons:    n,
    win15:      stats.win15 / n,
    win16:      stats.win16 / n,
    reachFinal: stats.reachFinal / n,
    winFinal:   stats.winFinal / n,
    top15:      stats.top15 / n,
    cashBig:    stats.cashBig / n,
    finalists:  stats.reachFinal,
    jackpots:   stats.winFinal,
    avgPlaceFrac: stats.reachFinal ? stats.placeSum / stats.reachFinal : 0,
    evTotal:    stats.ev / n,
    evNoJackpot: stats.evNoJp / n,
    sizes,
    // Parts per million of the final's prize pool, per entry.
    evBySize:  Array.from(evBySize, v => 1e6 * v / n),
    winBySize: Array.from(winBySize, v => v / n),
    accPoints:  stats.accPoints / n,
    wk17Points: stats.wk17Points / n,
    pos: Object.fromEntries(POS.map(p => [p, stats.posCounts[p] / drafts])),
    byBuild: [...stats.byBuild.entries()]
      .map(([build, b]) => ({ build, n: b.n, advance: b.adv / b.n, reachFinal: b.fin / b.n, ev: b.ev / b.n }))
      .sort((a, b) => b.n - a.n),
    stackedPC: stats.stackedPasscatchers / drafts,
    playoffPartners: stats.playoffPartners / drafts,
  };
}

function pct(x) { return (x * 100).toFixed(2) + '%'; }
function pct4(x) { return (x * 100).toFixed(4) + '%'; }

function report(truth, v1, v2, opts) {
  console.log(`\n${'='.repeat(74)}`);
  console.log(`TRUTH SCENARIO: ${truth === 'proj' ? 'projections (flatters V2 — see caveat)' : 'market/ADP-implied (neutral)'}`);
  console.log(`${opts.drafts} drafts x ${opts.seasons} seasons = ${opts.drafts * opts.seasons} team-seasons per model`);
  console.log(`Final: ${opts.field.rosters.length + 1} teams sampled from ${opts.field.candidates} candidate rosters `
            + `by qualification odds\n       (field sits at the ${(100 * opts.field.fieldStrength).toFixed(1)}th percentile of that population)`);
  console.log('='.repeat(74));

  const rows = [
    ['Top-2 of 12, weeks 1-14',   'advance14',  pct],
    ['Win week 15 (1 of 12)',     'win15',      pct],
    ['Win week 16 (1 of 12)',     'win16',      pct],
    ['Reach the final',           'reachFinal', pct],
    [`Win the final (1 of ${opts.field.rosters.length + 1})`, 'winFinal', pct4],
    ['Top 15 of the final',       'top15',      pct4],
    ['Final pays $1,000+',        'cashBig',    pct4],
    ['Avg wk 1-14 points',        'accPoints',  null],
    ['Avg week 17 points',        'wk17Points', null],
  ];

  console.log(`\n${'Metric'.padEnd(28)}${'V1'.padStart(12)}${'V2'.padStart(12)}${'Δ'.padStart(12)}`);
  console.log('-'.repeat(64));
  for (const [label, key, fmt] of rows) {
    const a = v1[key], b = v2[key];
    const fa = fmt ? fmt(a) : a.toFixed(1);
    const fb = fmt ? fmt(b) : b.toFixed(1);
    const rel = a > 0 ? ((b - a) / a * 100) : 0;
    const delta = fmt ? `${rel >= 0 ? '+' : ''}${rel.toFixed(1)}%` : `${b - a >= 0 ? '+' : ''}${(b - a).toFixed(1)}`;
    console.log(`${label.padEnd(28)}${fa.padStart(12)}${fb.padStart(12)}${delta.padStart(12)}`);
  }
  console.log(`${'Avg finish in final'.padEnd(28)}${('top ' + pct(v1.avgPlaceFrac)).padStart(12)}`
            + `${('top ' + pct(v2.avgPlaceFrac)).padStart(12)}`);

  console.log('\nExpected value per entry (approx DK Millionaire payouts)');
  const row = (label, a, b) => console.log(
    `  ${label.padEnd(24)}${('$' + a.toFixed(2)).padStart(10)}${('$' + b.toFixed(2)).padStart(12)}`
    + `${((b - a >= 0 ? '+$' : '-$') + Math.abs(b - a).toFixed(2)).padStart(12)}`);
  console.log(`  ${'source'.padEnd(24)}${'V1'.padStart(10)}${'V2'.padStart(12)}${'delta'.padStart(12)}`);
  row('TOTAL', v1.evTotal, v2.evTotal);
  row('TOTAL (jackpot capped)', v1.evNoJackpot, v2.evNoJackpot);
  const relEv = v1.evTotal ? (v2.evTotal - v1.evTotal) / v1.evTotal * 100 : 0;
  console.log(`  ${'as % of V1'.padEnd(24)}${''.padStart(10)}${''.padStart(12)}${((relEv >= 0 ? '+' : '') + relEv.toFixed(1) + '%').padStart(12)}`);
  console.log(`  finalists: V1 ${v1.finalists}, V2 ${v2.finalists} | finals won: V1 ${v1.jackpots}, V2 ${v2.jackpots}`);
  console.log('  NOTE: first place is 1-in-1089 and pays 5,000x the min cash. Unless finals');
  console.log('  won number in the dozens, read the jackpot-capped row.');

  // ── Does the right build depend on the contest? ─────────────────────────────
  // Same rosters, same seasons, same path to the final — only the size of the room
  // they land in changes. Anything that moves here is a reason to draft differently
  // for a $50K Tuddy than for the Millionaire.
  console.log('\nEV by contest size (ppm of the final prize pool, per entry)');
  console.log(`  ${'finalists'.padStart(10)}${'~entries'.padStart(10)}${'V1'.padStart(10)}`
            + `${'V2'.padStart(10)}${'Δ'.padStart(10)}${'V2 wins it'.padStart(12)}`);
  for (let k = 0; k < v1.sizes.length; k++) {
    const a = v1.evBySize[k], b = v2.evBySize[k];
    const rel = a > 0 ? (b - a) / a * 100 : 0;
    console.log(`  ${String(v1.sizes[k]).padStart(10)}${(v1.sizes[k] * 864).toLocaleString().padStart(10)}`
      + `${a.toFixed(0).padStart(10)}${b.toFixed(0).padStart(10)}`
      + `${((rel >= 0 ? '+' : '') + rel.toFixed(1) + '%').padStart(10)}`
      + `${pct4(v2.winBySize[k]).padStart(12)}`);
  }

  console.log(`\n${'Roster shape (avg)'.padEnd(28)}${'V1'.padStart(12)}${'V2'.padStart(12)}`);
  console.log('-'.repeat(52));
  for (const p of POS) {
    console.log(`${('  ' + p).padEnd(28)}${v1.pos[p].toFixed(2).padStart(12)}${v2.pos[p].toFixed(2).padStart(12)}`);
  }
  console.log(`${'  QB-stacked pass catchers'.padEnd(28)}${v1.stackedPC.toFixed(2).padStart(12)}${v2.stackedPC.toFixed(2).padStart(12)}`);
  console.log(`${'  players w/ playoff partner'.padEnd(28)}${v1.playoffPartners.toFixed(2).padStart(12)}${v2.playoffPartners.toFixed(2).padStart(12)}`);

  // Construction table. Ordered by frequency so the builds a model actually relies on
  // are visible, not just whichever happened to score well in a small sample.
  for (const [label, res] of [['V1', v1], ['V2', v2]]) {
    if (!res.byBuild || !res.byBuild.length) continue;
    const total = res.byBuild.reduce((a, b) => a + b.n, 0);
    const rows2 = res.byBuild.filter(b => b.n >= total * 0.03).slice(0, 8);
    if (!rows2.length) continue;
    console.log(`\n${label} — by roster construction (QB-RB-WR-TE)`);
    console.log(`  ${'build'.padEnd(12)}${'share'.padStart(8)}${'advance'.padStart(10)}${'reach final'.padStart(13)}${'final $/entry'.padStart(15)}`);
    for (const b of rows2) {
      const flag = b.advance < res.advance14 * 0.85 ? '  <-- underperforms' : '';
      console.log(`  ${b.build.padEnd(12)}${(100 * b.n / total).toFixed(1).padStart(7)}%`
        + `${(100 * b.advance).toFixed(1).padStart(9)}%${(100 * b.reachFinal).toFixed(2).padStart(12)}%`
        + `${('$' + b.ev.toFixed(2)).padStart(15)}${flag}`);
    }
  }
}

// ── Replay mode: pick-by-pick on a real draft ─────────────────────────────────

function replay(players, ctx) {
  const draftPath = path.join(__dirname, 'replay-draft.json');
  if (!fs.existsSync(draftPath)) {
    console.error('Missing tools/replay-draft.json — generate it with tools/export-draft.py');
    process.exit(1);
  }
  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  const byId  = Object.fromEntries(players.map(p => [p.id, p]));

  assignTruth(players, 'proj', mulberry32(12345), ctx);

  console.log(`\nReplay: ${draft.contest} — ${draft.num_teams} teams, your slot ${draft.my_position}`);
  console.log('At each of your picks: what you took vs what each model wanted.\n');
  console.log(`${'Rd'.padEnd(4)}${'You took'.padEnd(24)}${'V1 would take'.padEnd(24)}${'V2 would take'.padEnd(24)}`);
  console.log('-'.repeat(76));

  const pool   = players.filter(p => p._eff).sort((a, b) => a.adp - b.adp);
  const myTeam = [];
  const taken  = new Set();

  // Approximate the rest of the board: everyone with ADP below the current pick is gone.
  for (const pick of draft.picks) {
    const avail = pool.filter(p => !taken.has(p.id) && p.adp <= pick.pick_number + 12);
    const nextPick = nextPickForSlot(pick.pick_number + 1, draft.my_position - 1, draft.num_teams);

    const v1rec = V1.getTopRecommendations(avail, myTeam, pick.pick_number, 'heavy', 1, nextPick);
    const v2rec = V2.getTopRecommendationsV2(avail, myTeam, pick.pick_number, 1, nextPick);

    const fmt = (p) => p ? `${p.name.split(' ').slice(-1)[0]} (${p.pos})` : '—';
    const actual = byId[pick.player_id];

    console.log(
      `${String(pick.round).padEnd(4)}` +
      `${`${pick.player_name.split(' ').slice(-1)[0]} (${pick.pos})`.padEnd(24)}` +
      `${fmt(v1rec[0] && v1rec[0].player).padEnd(24)}` +
      `${fmt(v2rec[0] && v2rec[0].player).padEnd(24)}`
    );

    // Advance the board with what actually happened.
    for (const p of pool) if (p.adp <= pick.pick_number) taken.add(p.id);
    if (actual) { taken.add(actual.id); myTeam.push({ ...actual, round: pick.round }); }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const arg  = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };

  const players = loadData();
  const ctx     = buildScoringContext(players);
  console.log(`Loaded ${players.length} players, ${players.filter(p => p._eff && p._eff.projected).length} with projections.`);

  if (args.includes('--replay')) return replay(players, ctx);

  const opts = {
    drafts:  parseInt(arg('drafts', '400'), 10),
    seasons: parseInt(arg('seasons', '200'), 10),
    baseSeed: 20260730,
    players, ctx,
    finalAlpha: parseFloat(arg('final-alpha', '1.7')),
    finalPaid:  parseFloat(arg('final-paid', '0.367')),
  };
  const fieldPods   = parseInt(arg('field-pods', '900'), 10);
  const fieldWorlds = parseInt(arg('field-worlds', '120'), 10);
  const fieldSharp  = parseInt(arg('field-sharp', '0'), 10);

  const t0 = Date.now();
  const pods = buildFieldPods(players, fieldPods, 555001, fieldSharp);
  console.log(`Built ${fieldPods} field pods (${fieldPods * NUM_TEAMS} candidate rosters, `
            + `${fieldSharp}/${NUM_TEAMS} seats model-drafted) in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

  const scenarios = args.includes('--truth')
    ? [arg('truth', 'market')]
    : ['proj', 'market'];

  for (const truth of scenarios) {
    const t1 = Date.now();
    const field = selectFinalField(players, ctx, pods, truth, FINAL_FIELD_SIZE - 1, fieldWorlds, 909001);
    console.log(`\n[${truth}] final field: sampled ${field.rosters.length} of ${field.candidates} candidates `
              + `(${(100 * field.fieldStrength).toFixed(1)}th pctile, ${(100 * field.weightShare).toFixed(0)}% of qualification weight) `
              + `in ${((Date.now() - t1) / 1000).toFixed(1)}s.`);
    if (field.rosters.length < FINAL_FIELD_SIZE - 1) {
      console.log(`  WARNING: field is smaller than the real ${FINAL_FIELD_SIZE}-team final — first place is`);
      console.log('  correspondingly easier. Raise --field-pods before quoting EV.');
    }

    const o  = { ...opts, truth, field };
    const v1 = evaluate('v1', o);
    const v2 = evaluate('v2', o);
    report(truth, v1, v2, o);
  }

  console.log('\nNote: absolute rates are not calibrated to the real contest (the other 11');
  console.log('seats are ADP bots, and so is the final field). The V1-vs-V2 delta under');
  console.log('identical conditions is the signal.\n');
}

if (require.main === module) main();

// Exported so sibling tools (tools/sitngo-ev.js) can reuse the simulator instead of
// re-implementing a second, slightly-different copy of it.
module.exports = {
  loadData, buildScoringContext, assignTruth, drawWeekScores, toFastRoster,
  scoreRoster, simulateDraft, mulberry32, gauss, ROUNDS, NUM_TEAMS, POS,
};
