#!/usr/bin/env node
//
// V1 vs V2 recommender comparison harness.
//
// Runs both models through complete simulated DraftKings Best Ball drafts and
// scores the resulting rosters against the metric that actually pays: advance
// rate through the tournament's four phases.
//
//   Weeks 1-14   cumulative, top 2 of 12 advance
//   Week 15      single week, top 1 of 12
//   Week 16      single week, top 1 of 12
//   Week 17      single week, the final
//
// ── Methodology, and its honest limitations ──────────────────────────────────
//
// Each simulated draft seats the model under test at one slot; the other 11 seats
// draft to ADP with noise (with light positional sanity limits).  The resulting
// 12 rosters then play a simulated season many times over, using common random
// numbers so V1 and V2 face identical luck.
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
//   node tools/compare-models.js --replay             # pick-by-pick on your real draft

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const V1 = require(path.join(ROOT, 'static', 'recommender.js'));
const V2 = require(path.join(ROOT, 'static', 'recommender-v2.js'));

const NUM_TEAMS = 12;

// Weekly starting slots per position, used to define "the startable tier" a breakout
// lands in. Mirrors the recommender's lineup shape.
const STARTABLE = { QB: 1.0, RB: 2.3, WR: 3.6, TE: 1.1 };

// How often roles change from what the projection assumed. Tunable so the harness's
// own assumptions can be stress-tested rather than trusted — a conclusion that only
// holds at one breakout rate is not a conclusion.
const BREAKOUT_BASE = process.env.SIM_BREAKOUT ? parseFloat(process.env.SIM_BREAKOUT) : 0.14;
const BUST_BASE     = process.env.SIM_BUST     ? parseFloat(process.env.SIM_BUST)     : 0.14;
const ROUNDS    = 20;

// Weekly lineup: 1 QB, 2 RB, 3 WR, 1 TE, 1 FLEX (RB/WR/TE)
const LINEUP = { QB: 1, RB: 2, WR: 3, TE: 1 };
const FLEX_ELIGIBLE = ['RB', 'WR', 'TE'];

// How strongly each position loads on its team's weekly game environment.
// This is what makes stacking mathematically worthwhile in the simulation.
const TEAM_LOADING = { QB: 0.75, WR: 0.65, TE: 0.60, RB: 0.35 };
const TEAM_FACTOR_CV = 0.35;
const GAME_FACTOR_CV = 0.22;   // shared by both teams in a playoff-week game

const POS = ['QB', 'RB', 'WR', 'TE'];

// ── Deterministic RNG so runs are reproducible ────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
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

// ── "True" player ability for the season simulation ───────────────────────────
//
// proj:   truth == the projections V2 optimises against (flatters V2)
// market: truth == ADP-implied ability, so neither model has an information edge
function assignTruth(players, mode, rng) {
  // Position curves of projected points, used to map a rank onto an ability level.
  const curves = {};
  for (const pos of POS) {
    curves[pos] = players
      .filter(p => p.pos === pos && p._eff)
      .map(p => p._eff.mean)
      .sort((a, b) => b - a);
  }

  const adpRank = {};
  for (const pos of POS) {
    adpRank[pos] = players
      .filter(p => p.pos === pos)
      .sort((a, b) => a.adp - b.adp);
  }

  for (const p of players) {
    if (!p._eff) { p._true = null; continue; }

    let mean;
    if (mode === 'market') {
      const list = adpRank[p.pos];
      const i    = list.indexOf(p);
      const c    = curves[p.pos];
      mean = c[Math.min(c.length - 1, i)] ?? c[c.length - 1];
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
    const c = curves[p.pos];
    const startable = Math.max(3, Math.round(STARTABLE[p.pos] * NUM_TEAMS));
    const tierFloor = c[Math.min(c.length - 1, startable)] ?? 0;
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
  }
}

// ── Draft simulation ──────────────────────────────────────────────────────────

function snakeSlot(pick, numTeams) {
  const round = Math.floor((pick - 1) / numTeams);
  const idx   = (pick - 1) % numTeams;
  return round % 2 === 0 ? idx : numTeams - 1 - idx;
}

// ADP bot with noise and loose positional limits, standing in for the other 11 seats.
const BOT_LIMITS = { QB: 3, RB: 8, WR: 10, TE: 3 };

function botPick(available, roster, rng) {
  const counts = {};
  for (const p of roster) counts[p.pos] = (counts[p.pos] || 0) + 1;

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

function simulateDraft(players, modelSlot, model, rng) {
  const available = players.filter(p => p._eff).sort((a, b) => a.adp - b.adp);
  const pool      = available.slice();
  const rosters   = Array.from({ length: NUM_TEAMS }, () => []);

  for (let pick = 1; pick <= NUM_TEAMS * ROUNDS; pick++) {
    const slot = snakeSlot(pick, NUM_TEAMS);
    let chosen;

    if (slot === modelSlot) {
      const myTeam   = rosters[slot];
      const nextPick = nextPickForSlot(pick + 1, slot, NUM_TEAMS);

      if (model === 'v1') {
        const recs = V1.getTopRecommendations(pool, myTeam, pick, 'heavy', 1, nextPick);
        chosen = recs.length ? recs[0].player : pool[0];
      } else {
        const myPicks = remainingPicksForSlot(pick + 1, slot, NUM_TEAMS);
        const recs = V2.getTopRecommendationsV2(pool, myTeam, pick, 1, nextPick, myPicks);
        chosen = recs.length ? recs[0].player : pool[0];
      }
    } else {
      chosen = botPick(pool, rosters[slot], rng);
    }

    const idx = pool.indexOf(chosen);
    if (idx >= 0) pool.splice(idx, 1);
    // V1's dynamicTarget reads p.round off rostered players.
    rosters[slot].push({ ...chosen, round: Math.floor((pick - 1) / NUM_TEAMS) + 1 });
  }

  return rosters;
}

// ── Season simulation ─────────────────────────────────────────────────────────

// Optimal best-ball lineup for one week.
function optimalLineup(scores) {
  const byPos = {};
  for (const pos of POS) {
    byPos[pos] = scores.filter(s => s.pos === pos).map(s => s.pts).sort((a, b) => b - a);
  }
  let total = 0;
  const leftovers = [];
  for (const pos of POS) {
    const need = LINEUP[pos];
    const list = byPos[pos];
    for (let i = 0; i < list.length; i++) {
      if (i < need) total += list[i];
      else if (FLEX_ELIGIBLE.includes(pos)) leftovers.push(list[i]);
    }
  }
  if (leftovers.length) total += Math.max(...leftovers);
  return total;
}

function simulateSeason(rosters, rng) {
  // Accumulated weeks 1-14 plus the three knockout weeks, per team.
  const acc  = new Array(NUM_TEAMS).fill(0);
  const wk   = { 15: [], 16: [], 17: [] };

  const teams = new Set();
  for (const r of rosters) for (const p of r) if (p.team && p.team !== 'FA') teams.add(p.team);

  for (let week = 1; week <= 17; week++) {
    // Shared team-week environment factors -> intra-team correlation.
    const teamFactor = {};
    const tSigma = Math.sqrt(Math.log(1 + TEAM_FACTOR_CV ** 2));
    for (const t of teams) teamFactor[t] = Math.exp(gauss(rng) * tSigma - tSigma * tSigma / 2);

    // In the knockout weeks we know the actual matchups, so both sides of a game
    // additionally share a game factor -> game stacks correlate.
    const gameFactor = {};
    if (week >= 15) {
      const gSigma = Math.sqrt(Math.log(1 + GAME_FACTOR_CV ** 2));
      const seen = new Set();
      for (const r of rosters) for (const p of r) {
        const opp = p[`week${week}`];
        if (!opp || !p.team) continue;
        const key = [p.team, opp].sort().join('@');
        if (seen.has(key)) continue;
        seen.add(key);
        gameFactor[key] = Math.exp(gauss(rng) * gSigma - gSigma * gSigma / 2);
      }
    }

    const weekScores = rosters.map(roster => {
      const scores = roster.map(p => {
        if (!p._true) return { pos: p.pos, pts: 0 };
        if (p.bye === week) return { pos: p.pos, pts: 0 };
        // Playoff weeks: no game scheduled means no points.
        if (week >= 15 && !p[`week${week}`]) return { pos: p.pos, pts: 0 };

        const load  = TEAM_LOADING[p.pos] ?? 0.5;
        const tf    = (teamFactor[p.team] ?? 1) ** load;

        let gf = 1;
        if (week >= 15 && p.team) {
          const opp = p[`week${week}`];
          if (opp) {
            const key = [p.team, opp].sort().join('@');
            gf = (gameFactor[key] ?? 1) ** load;
          }
        }

        // Idiosyncratic component, sized so total variance matches the player's CV.
        const totalSigma = Math.sqrt(Math.log(1 + p._true.cv ** 2));
        const tSig = Math.sqrt(Math.log(1 + TEAM_FACTOR_CV ** 2)) * load;
        const gSig = week >= 15 ? Math.sqrt(Math.log(1 + GAME_FACTOR_CV ** 2)) * load : 0;
        const idioSigma = Math.sqrt(Math.max(0.01, totalSigma ** 2 - tSig ** 2 - gSig ** 2));
        const idio = Math.exp(gauss(rng) * idioSigma - idioSigma * idioSigma / 2);

        return { pos: p.pos, pts: Math.max(0, p._true.mean * tf * gf * idio) };
      });
      return optimalLineup(scores);
    });

    if (week <= 14) {
      for (let i = 0; i < NUM_TEAMS; i++) acc[i] += weekScores[i];
    } else {
      wk[week] = weekScores;
    }
  }

  return { acc, wk };
}

function rankOf(arr, i) {
  return arr.filter(v => v > arr[i]).length + 1;
}

// ── Running the comparison ────────────────────────────────────────────────────

function evaluate(model, opts) {
  const { drafts, seasons, truth, players, baseSeed } = opts;

  const stats = {
    advance14: 0, win15: 0, win16: 0, win17: 0,
    reachFinal: 0, accPoints: 0, wk17Points: 0, n: 0,
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

  for (let d = 0; d < drafts; d++) {
    const seed = baseSeed + d * 7919;
    const rng  = mulberry32(seed);
    assignTruth(players, truth, rng);

    const slot    = d % NUM_TEAMS;
    const rosters = simulateDraft(players, slot, model, mulberry32(seed + 1));
    const mine    = rosters[slot];

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
    if (!stats.byBuild.has(build)) stats.byBuild.set(build, { n: 0, adv: 0, fin: 0 });
    const bucket = stats.byBuild.get(build);

    // Same season draws for every model via a seed tied to the draft index only.
    for (let s = 0; s < seasons; s++) {
      const srng = mulberry32(seed + 100000 + s);
      const { acc, wk } = simulateSeason(rosters, srng);

      stats.n++;
      stats.accPoints  += acc[slot];
      stats.wk17Points += wk[17][slot];

      const advanced = rankOf(acc, slot) <= 2;
      if (advanced) stats.advance14++;
      bucket.n++;
      if (advanced) bucket.adv++;

      const w15 = rankOf(wk[15], slot) === 1;
      const w16 = rankOf(wk[16], slot) === 1;
      const w17 = rankOf(wk[17], slot) === 1;
      if (w15) stats.win15++;
      if (w16) stats.win16++;
      if (w17) stats.win17++;
      // Full tournament path: survive weeks 1-14, then win 15 and 16 to reach the final.
      if (advanced && w15 && w16) { stats.reachFinal++; bucket.fin++; }
    }
  }

  const n = stats.n || 1;
  const totalPlayers = drafts * ROUNDS || 1;
  return {
    advance14:  stats.advance14 / n,
    win15:      stats.win15 / n,
    win16:      stats.win16 / n,
    win17:      stats.win17 / n,
    reachFinal: stats.reachFinal / n,
    accPoints:  stats.accPoints / n,
    wk17Points: stats.wk17Points / n,
    pos: Object.fromEntries(POS.map(p => [p, stats.posCounts[p] / drafts])),
    byBuild: [...stats.byBuild.entries()]
      .map(([build, b]) => ({ build, n: b.n, advance: b.adv / b.n, reachFinal: b.fin / b.n }))
      .sort((a, b) => b.n - a.n),
    stackedPC: stats.stackedPasscatchers / drafts,
    playoffPartners: stats.playoffPartners / drafts,
  };
}

function pct(x) { return (x * 100).toFixed(2) + '%'; }

function report(truth, v1, v2, opts) {
  console.log(`\n${'='.repeat(74)}`);
  console.log(`TRUTH SCENARIO: ${truth === 'proj' ? 'projections (flatters V2 — see caveat)' : 'market/ADP-implied (neutral)'}`);
  console.log(`${opts.drafts} drafts x ${opts.seasons} seasons = ${opts.drafts * opts.seasons} team-seasons per model`);
  console.log('='.repeat(74));

  const rows = [
    ['Top-2 of 12, weeks 1-14',   'advance14',  true],
    ['Win week 15 (1 of 12)',     'win15',      true],
    ['Win week 16 (1 of 12)',     'win16',      true],
    ['Win week 17 (1 of 12)',     'win17',      true],
    ['Reach the final',           'reachFinal', true],
    ['Avg wk 1-14 points',        'accPoints',  false],
    ['Avg week 17 points',        'wk17Points', false],
  ];

  console.log(`\n${'Metric'.padEnd(28)}${'V1'.padStart(12)}${'V2'.padStart(12)}${'Δ'.padStart(12)}`);
  console.log('-'.repeat(64));
  for (const [label, key, isPct] of rows) {
    const a = v1[key], b = v2[key];
    const fa = isPct ? pct(a) : a.toFixed(1);
    const fb = isPct ? pct(b) : b.toFixed(1);
    const rel = a > 0 ? ((b - a) / a * 100) : 0;
    const delta = isPct ? `${rel >= 0 ? '+' : ''}${rel.toFixed(1)}%` : `${b - a >= 0 ? '+' : ''}${(b - a).toFixed(1)}`;
    console.log(`${label.padEnd(28)}${fa.padStart(12)}${fb.padStart(12)}${delta.padStart(12)}`);
  }

  console.log(`\n${'Roster shape (avg)'.padEnd(28)}${'V1'.padStart(12)}${'V2'.padStart(12)}`);
  console.log('-'.repeat(52));
  for (const p of POS) {
    console.log(`${('  ' + p).padEnd(28)}${v1.pos[p].toFixed(2).padStart(12)}${v2.pos[p].toFixed(2).padStart(12)}`);
  }
  console.log(`${'  QB-stacked pass catchers'.padEnd(28)}${v1.stackedPC.toFixed(2).padStart(12)}${v2.stackedPC.toFixed(2).padStart(12)}`);
  console.log(`${'  players w/ playoff partner'.padEnd(28)}${v1.playoffPartners.toFixed(2).padStart(12)}${v2.playoffPartners.toFixed(2).padStart(12)}`);
}

// ── Replay mode: pick-by-pick on a real draft ─────────────────────────────────

function replay(players) {
  const draftPath = path.join(__dirname, 'replay-draft.json');
  if (!fs.existsSync(draftPath)) {
    console.error('Missing tools/replay-draft.json — generate it with tools/export-draft.py');
    process.exit(1);
  }
  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  const byId  = Object.fromEntries(players.map(p => [p.id, p]));

  const rng = mulberry32(12345);
  assignTruth(players, 'proj', rng);

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
  console.log(`Loaded ${players.length} players, ${players.filter(p => p._eff && p._eff.projected).length} with projections.`);

  if (args.includes('--replay')) return replay(players);

  const opts = {
    drafts:  parseInt(arg('drafts', '400'), 10),
    seasons: parseInt(arg('seasons', '200'), 10),
    baseSeed: 20260730,
    players,
  };

  const scenarios = args.includes('--truth')
    ? [arg('truth', 'market')]
    : ['proj', 'market'];

  for (const truth of scenarios) {
    const o  = { ...opts, truth };
    const v1 = evaluate('v1', o);
    const v2 = evaluate('v2', o);
    report(truth, v1, v2, o);
  // Construction table. Ordered by frequency so the builds a model actually relies on
  // are visible, not just whichever happened to score well in a small sample.
  for (const [label, res] of [['V1', v1], ['V2', v2]]) {
    if (!res.byBuild || !res.byBuild.length) continue;
    const total = res.byBuild.reduce((a, b) => a + b.n, 0);
    const rows = res.byBuild.filter(b => b.n >= total * 0.03).slice(0, 8);
    if (!rows.length) continue;
    console.log(`\n${label} — advance rate by roster construction (QB-RB-WR-TE)`);
    console.log(`  ${'build'.padEnd(12)}${'share'.padStart(8)}${'advance'.padStart(10)}${'reach final'.padStart(13)}`);
    for (const b of rows) {
      const flag = b.advance < res.advance14 * 0.85 ? '   <-- underperforms' : '';
      console.log(`  ${b.build.padEnd(12)}${(100 * b.n / total).toFixed(1).padStart(7)}%`
        + `${(100 * b.advance).toFixed(1).padStart(9)}%${(100 * b.reachFinal).toFixed(2).padStart(12)}%${flag}`);
    }
  }


  }

  console.log('\nNote: absolute rates are not calibrated to the real contest (the other 11');
  console.log('seats are ADP bots). The V1-vs-V2 delta under identical conditions is the signal.\n');
}

main();
