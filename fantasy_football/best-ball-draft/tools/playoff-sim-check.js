#!/usr/bin/env node
/* Check static/playoff-sim.js against what it is supposed to reproduce.
 *
 *   node tools/playoff-sim-check.js                 # files from ../projections/data
 *   node tools/playoff-sim-check.js --worlds 3000 --boards 60
 *
 * Non-zero exit on any FAIL. Each check exists because its failure would be
 * silent -- plausible numbers from a simulator that is wrong:
 *
 *   bracket     JS reach probabilities vs the Python simulator's in the file.
 *               Two implementations of one bracket must agree within MC error.
 *   scores      the simulated z-scores have variance 1 and the measured
 *               correlations (QB-WR +0.31, WR-WR ~0, QB-v-QB +0.23). A wrong
 *               Cholesky still produces scores that look like scores.
 *   unusable    a season-over player never scores; a bye team scores 0 in WC
 *               (per world: mid-season every world has its own seeds).
 *   seasons     mid-season files: each world's seeds are one simulated season,
 *               so P(make playoffs) must equal the file's `odds`, and a player
 *               with avail a must be playing in a share a of worlds.
 *   field       ADP bots are symmetric: each seat wins its round-1 pod ~1/6.
 *               An average roster survives ~1/6, 1/36, 1/216 -- the recursion
 *               in survivorPools is right only if this comes out.
 *
 * The ADP here is SYNTHETIC (expected postseason points) until a real DK
 * playoff pool exists. That is a property of the inputs, not of the sim.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Sim = require(path.join(__dirname, '..', 'static', 'playoff-sim.js'));

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, xs) => {
  if (a.startsWith('--')) acc.push([a.slice(2), xs[i + 1]]);
  return acc;
}, []));
const DATA = args.data || path.join(__dirname, '..', '..', 'projections', 'data');
const N = parseInt(args.worlds || '2000', 10);
const BOARDS = parseInt(args.boards || '60', 10);
const LINEUP = { QB: 1, RB: 1, WR: 2, TE: 1, FLEX: 1 };
const ROUNDS_DRAFTED = parseInt(args.rounds || '12', 10);

let fails = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  if (!ok) fails++;
}

const bracket = JSON.parse(fs.readFileSync(path.join(DATA, 'playoff_bracket.json')));
const players = JSON.parse(fs.readFileSync(path.join(DATA, 'playoff_players.json')));
const ctx = Sim.build(bracket, players);
console.log(`season ${ctx.season} (${ctx.seedsFinal ? 'final seeds' : ctx.seasonSim ? `SEASON SIM, ${ctx.seasons.length} simulated finishes` : 'PROVISIONAL seeds'}), `
  + `${ctx.players.length} players, ${N} worlds, ${BOARDS} bot boards x ${ROUNDS_DRAFTED} rounds`);

let t0 = Date.now();
const worlds = Sim.simulateWorlds(ctx, N, 1);
console.log(`worlds simulated in ${Date.now() - t0} ms`);

// ── bracket ──────────────────────────────────────────────────────────────────
{
  const M = 20000, rng = Sim.mulberry32(5);
  const reach = {};
  for (let k = 0; k < M; k++) {
    const b = Sim.simulateBracket(ctx, rng, k);
    for (const r of Sim.ROUNDS) for (const [h, a] of b[r]) for (const t of [h, a]) {
      reach[t] = reach[t] || { WC: 0, DIV: 0, CON: 0, SB: 0, champ: 0 };
      reach[t][r] += 1 / M;
    }
    reach[b.champion].champ += 1 / M;
  }
  let worst = 0, where = '';
  for (const [t, d] of Object.entries(bracket.reach)) {
    for (const r of [...Sim.ROUNDS, 'champ']) {
      const diff = Math.abs((reach[t] ? reach[t][r] : 0) - d[r]);
      if (diff > worst) { worst = diff; where = `${t} ${r}`; }
    }
  }
  // Two 20k-sim estimates of p differ by sd sqrt(2 p(1-p)/20000) <= 0.0071.
  check('bracket', worst < 0.025, `max |JS - Python| reach ${worst.toFixed(4)} (${where})`);
}

// ── scores ───────────────────────────────────────────────────────────────────
{
  const { R, P, scores } = worlds;
  const zs = [];             // per world-round-team: {pos: [z...]}
  let s1 = 0, s2 = 0, cnt = 0;
  for (let w = 0; w < N; w++) {
    Sim.ROUNDS.forEach((rnd, r) => {
      for (const [home, away] of worlds.brackets[w][rnd]) {
        const game = {};
        for (const [team, opp] of [[home, away], [away, home]]) {
          for (const p of ctx.byTeam[team] || []) {
            if (!Sim.available(p, rnd, ctx) || !worlds.playing[w * P + p.idx] || p.dk_ppg < 6) continue;
            const m = Sim.weekMean(ctx, p, Sim.gameImplied(ctx, team, opp));
            const sd = Sim.weekSd(ctx, p.pos, m);
            const sc = scores[w * R * P + r * P + p.idx];
            // The floor censors the low tail, so variance is not the test; the
            // upper tail best ball pays for is uncensored, so test that.
            const z = sc <= ctx.params.floor + 1e-6 ? -Infinity : (sc - m) / sd;
            s1 += z > 1; s2 += z > 2; cnt++;
            if (z === -Infinity) continue;
            (game[team] = game[team] || []).push([p.pos, z]);
          }
        }
        zs.push(game);
      }
    });
  }
  const p1 = s1 / cnt, p2 = s2 / cnt;
  check('scores: upper tail', Math.abs(p1 - 0.1587) < 0.01 && Math.abs(p2 - 0.0228) < 0.004,
    `P(z>1) ${p1.toFixed(4)} (normal 0.1587), P(z>2) ${p2.toFixed(4)} (0.0228), ${cnt} player-games`);
  const pair = (A, B, same) => {
    const xs = [], ys = [];
    for (const g of zs) {
      const teams = Object.keys(g);
      for (const t1 of teams) for (const t2 of teams) {
        if ((t1 === t2) !== same) continue;
        if (!same && t1 > t2) continue;
        for (const [pa, za] of g[t1]) for (const [pb, zb] of g[t2]) {
          if (pa === A && pb === B && !(same && za === zb)) { xs.push(za); ys.push(zb); }
        }
      }
    }
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    return sxy / Math.sqrt(sxx * syy);
  };
  for (const [a, b, same, want, tol] of [
    ['QB', 'WR', true, 0.307, 0.06], ['QB', 'TE', true, 0.269, 0.07], ['WR', 'WR', true, -0.001, 0.05],
    ['RB', 'WR', true, -0.033, 0.05], ['QB', 'QB', false, 0.23, 0.07], ['WR', 'WR', false, 0.045, 0.05],
  ]) {
    const r = pair(a, b, same);
    check(`scores: ${a}-${same ? '' : 'v-'}${b}`, Math.abs(r - want) < tol, `r ${r.toFixed(3)} vs measured ${want}`);
  }
}

// ── unusable players score nothing ───────────────────────────────────────────
{
  const { R, P, scores } = worlds;
  const over = ctx.players.filter(p => !p.avail);
  let leaked = 0;
  for (const p of over) for (let w = 0; w < N; w++) for (let r = 0; r < R; r++) leaked += scores[w * R * P + r * P + p.idx] !== 0;
  check('unusable: season-over', leaked === 0, `${over.length} players, ${leaked} nonzero scores`);
  let byeLeak = 0, byeTeams = 0;
  const notIn = new Set();
  let outLeak = 0;
  for (let w = 0; w < N; w++) {
    const sd = worlds.brackets[w].seeds;
    for (const ts of [sd.AFC, sd.NFC]) for (const t of ts.slice(0, 8 - ts.length)) {
      byeTeams++;
      for (const p of ctx.byTeam[t] || []) byeLeak += scores[w * R * P + p.idx] !== 0;
    }
    // A team that missed the playoffs in this world scores nothing in it.
    const inW = new Set([...sd.AFC, ...sd.NFC]);
    for (const [t, ps] of Object.entries(ctx.byTeam)) {
      if (inW.has(t)) continue;
      notIn.add(t);
      for (const p of ps) for (let r = 0; r < R; r++) outLeak += scores[w * R * P + r * P + p.idx] !== 0;
    }
  }
  check('unusable: bye week', byeLeak === 0, `${byeTeams} team-worlds on a bye: ${byeLeak} nonzero wild-card scores`);
  check('unusable: missed playoffs', outLeak === 0, `${notIn.size} teams miss in some world: ${outLeak} nonzero scores`);
}

// ── seasons (mid-season files only) ──────────────────────────────────────────
if (ctx.seasonSim) {
  const { P } = worlds;
  const make = {};
  for (let w = 0; w < N; w++) for (const ts of Object.values(worlds.brackets[w].seeds)) for (const t of ts) make[t] = (make[t] || 0) + 1 / N;
  let worst = 0, where = '';
  for (const [t, d] of Object.entries(ctx.odds)) {
    const diff = Math.abs((make[t] || 0) - d.make);
    if (diff > worst) { worst = diff; where = t; }
  }
  // Worlds cycle through the file's seasons, so with N a multiple of their
  // count the two are the same sample and agree to rounding.
  const exact = N % ctx.seasons.length === 0;
  check('seasons: P(make)', worst < (exact ? 0.001 : 0.03), `max |JS - file| ${worst.toFixed(4)} (${where}), ${N} worlds over ${ctx.seasons.length} seasons`);
  const groups = {};
  ctx.players.forEach((p, i) => {
    if (!(p.avail > 0 && p.avail < 1)) return;
    const g = groups[p.avail] = groups[p.avail] || [0, 0];
    for (let w = 0; w < N; w++) { g[0] += worlds.playing[w * P + i]; g[1]++; }
  });
  for (const [a, [k, n]] of Object.entries(groups)) {
    check(`seasons: avail ${a}`, Math.abs(k / n - a) < 0.01, `playing in ${(k / n).toFixed(4)} of ${n} player-worlds`);
  }
}

// ── field ────────────────────────────────────────────────────────────────────
{
  t0 = Date.now();
  const { adp } = Sim.syntheticAdp(ctx, worlds);
  const rng = Sim.mulberry32(3);
  const boards = [];
  for (let b = 0; b < BOARDS; b++) boards.push(Sim.botDraft(ctx, adp, { seats: 6, rounds: ROUNDS_DRAFTED }, rng));
  const boardScores = boards.map(rs => rs.map(r => Sim.rosterScores(ctx, r, worlds, LINEUP)));
  console.log(`field: ${BOARDS} boards drafted and scored in ${Date.now() - t0} ms (ADP SYNTHETIC)`);

  const wins = new Float64Array(6);
  for (const bs of boardScores) {
    for (let w = 0; w < N; w++) {
      let best = 0;
      for (let s = 1; s < 6; s++) if (bs[s][w * 4] > bs[best][w * 4]) best = s;
      wins[best]++;
    }
  }
  const rates = Array.from(wins, x => x / (BOARDS * N));
  const spread = Math.max(...rates) - Math.min(...rates);
  console.log(`  round-1 pod win rate by seat: ${rates.map(x => x.toFixed(3)).join(' ')}`);
  // Snake seats are not identical (seat 1 gets the best player), so this is a
  // sanity bound, not an equality: no seat should be a lock or shut out.
  check('field: seats', rates.every(x => x > 0.08 && x < 0.30), `spread ${spread.toFixed(3)}`);

  const pools = Sim.survivorPools(boardScores, worlds, 200, 6, 9);
  // Average over every seat of every board, so "an average roster"
  // is literally that, not one roster that happens to be good.
  const surv = [0, 0, 0];
  let m = 0;
  for (let b = 0; b < BOARDS; b++) for (let s = 0; s < 6; s++) {
    const pod = boardScores[b].filter((_, k) => k !== s);
    const path_ = Sim.contestPath(boardScores[b][s], pod, pools, worlds, { podSize: 6 }, 100 + m);
    path_.survive.forEach((x, r) => { surv[r] += x; });
    m++;
  }
  const got = surv.map(x => x / m), want = [1 / 6, 1 / 36, 1 / 216];
  console.log(`  average roster survives: ${got.map(x => x.toFixed(4)).join(' / ')}  (expect ${want.map(x => x.toFixed(4)).join(' / ')})`);
  check('field: survival recursion', got.every((x, r) => Math.abs(x / want[r] - 1) < 0.15),
    'each round within 15% of 1/6^r');
}

console.log(fails ? `\n${fails} FAIL` : '\nall checks pass');
process.exit(fails ? 1 : 0);
