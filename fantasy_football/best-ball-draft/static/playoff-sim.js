/* Playoff best ball simulator — docs/PLAYOFF_DESIGN.md step 2.
 *
 * Simulates whole postseasons: who plays each round (the bracket), what every
 * player scores in each game he plays, and the best lineup any roster could
 * set each week. The recommender (step 3) asks it one question per candidate
 * pick: how does adding him change my chance to survive each round?
 *
 * Inputs are two files from ../projections, never constants of our own:
 *   playoff_bracket.json  (cli.py playoff-bracket)   ratings, seeds, sigma, fixed games
 *   playoff_players.json  (export_playoff_players.py) players, team implied totals, params
 * Every number about how scores behave lives in `params`, measured by
 * projections/tools/backtest_playoff_scores.py. A second copy here would drift.
 *
 * Worlds are generated ONCE and shared by every candidate, so two picks are
 * always compared on the same simulated postseasons (paired, like the harness).
 *
 * Runs in the browser and in node (tools/playoff-sim-check.js).
 */
(function (root) {
  'use strict';

  const ROUNDS = ['WC', 'DIV', 'CON', 'SB'];
  // A player who cannot play scores exactly 0 -- never a "value" from anything
  // else. This module has no term that could pay him; keep it that way (CLAUDE.md
  // bug class 2, the most repeated bug in this project).
  const SEASON_OVER = new Set(['IR', 'PUP', 'Sus', 'NA']);

  // ── rng ──────────────────────────────────────────────────────────────────
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }
  function normCdf(z) {
    // Abramowitz-Stegun 7.1.26 on erf; |error| < 1.5e-7.
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }

  // ── correlation (mirrors pipeline/playoff_scores.py residual_matrix/cholesky) ──
  function teamCorr(params, a, b) {
    const tc = params.team_corr;
    return tc[`${a}-${b}`] ?? tc[`${b}-${a}`] ?? 0;
  }
  function cholesky(m) {
    const n = m.length;
    for (let step = 0; step <= 20; step++) {
      const f = Math.pow(0.9, step);
      const L = Array.from({ length: n }, () => new Float64Array(n));
      let ok = true;
      for (let i = 0; i < n && ok; i++) {
        for (let j = 0; j <= i; j++) {
          let s = (i === j ? m[i][j] : m[i][j] * f);
          for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
          if (i === j) {
            if (s <= 1e-9) { ok = false; break; }
            L[i][i] = Math.sqrt(s);
          } else {
            L[i][j] = s / L[j][j];
          }
        }
      }
      if (ok) return L;
    }
    throw new Error('team correlation matrix not positive definite');
  }

  // ── context ──────────────────────────────────────────────────────────────
  function build(bracket, playersFile) {
    if (bracket.season !== playersFile.meta.season) {
      throw new Error(`bracket is ${bracket.season}, players are ${playersFile.meta.season}`);
    }
    const params = playersFile.params;
    const players = playersFile.players.map((p, i) => ({ ...p, idx: i }));
    const byTeam = {};
    for (const p of players) (byTeam[p.team] = byTeam[p.team] || []).push(p);
    const teamChol = {};
    // Team correlations only among the players they were measured on (>= 6 a
    // game and able to play); everyone else gets the game factor alone. See
    // CORR_MIN_PPG in pipeline/playoff_scores.py for what applying them to a
    // whole depth chart did.
    const inScope = p => p.avail && p.dk_ppg >= (params.corr_min_ppg ?? 6);
    for (const [t, ps] of Object.entries(byTeam)) {
      const m = ps.map((a, i) => ps.map((b, j) => {
        const ca = params.game_load[a.pos], cb = params.game_load[b.pos];
        if (i === j) return 1 - ca * ca;
        return inScope(a) && inScope(b) ? teamCorr(params, a.pos, b.pos) - ca * cb : 0;
      }));
      teamChol[t] = cholesky(m);
    }
    const fixed = new Map();
    for (const g of bracket.fixed || []) fixed.set(`${g.home}|${g.away}`, g.p_home);
    const posted = new Map();
    for (const g of playersFile.posted || []) {
      posted.set(`${g.home}|${g.away}`, [g.home_implied, g.away_implied]);
    }
    // Mid-season files (pipeline/season_sim.py) carry a sample of simulated
    // regular-season finishes: every world plays its postseason on one of them,
    // with that season's seeds and each team's rating drift. A January file has
    // none, and every world uses the one real bracket.
    let seasons = null;
    if (bracket.seasons && bracket.seasons.length) {
      seasons = bracket.seasons.map(x => {
        const k = x.t.length / 2;
        const drift = {};
        x.t.forEach((t, i) => { drift[t] = x.d[i]; });
        return { seeds: { AFC: x.t.slice(0, k), NFC: x.t.slice(k) }, drift };
      });
    }
    const conf = bracket.conf || {};
    if (!bracket.conf) for (const [c, ts] of Object.entries(bracket.seeds)) for (const t of ts) conf[t] = c;
    return {
      season: bracket.season,
      seedsFinal: !!bracket.seeds_final,
      seasonSim: !!seasons, seasons, conf, odds: bracket.odds || null,
      seeds: bracket.seeds, ratings: bracket.ratings, hfa: bracket.hfa, sigma: bracket.sigma,
      fixed, posted, params, players, byTeam, teamChol,
      implied: playersFile.team_implied,
    };
  }

  // ── bracket (mirrors pipeline/bracket.py; tests compare the two) ──────────
  function pHome(ctx, home, away, neutral, drift) {
    const k = `${home}|${away}`, r = `${away}|${home}`;
    if (ctx.fixed.has(k)) return ctx.fixed.get(k);
    if (ctx.fixed.has(r)) return 1 - ctx.fixed.get(r);
    const d = drift || {};
    const spread = (neutral ? 0 : ctx.hfa) + ctx.ratings[home] + (d[home] || 0) - ctx.ratings[away] - (d[away] || 0);
    return normCdf(spread / ctx.sigma);
  }
  function play(ctx, home, away, rng, neutral, drift) {
    return rng() < pHome(ctx, home, away, neutral, drift) ? home : away;
  }
  function conference(ctx, seeds, rng, log, drift) {
    const k = seeds.length, byes = 8 - k;
    const seedOf = Object.fromEntries(seeds.map((t, i) => [t, i + 1]));
    const bySeed = (a, b) => seedOf[a] - seedOf[b];
    const alive = seeds.slice(0, byes);
    const field = seeds.slice(byes);
    for (let i = 0; i < field.length / 2; i++) {
      const h = field[i], a = field[field.length - 1 - i];
      log.WC.push([h, a, false]);
      alive.push(play(ctx, h, a, rng, false, drift));
    }
    alive.sort(bySeed);
    const nxt = [];
    for (let i = 0; i < alive.length / 2; i++) {
      const h = alive[i], a = alive[alive.length - 1 - i];
      log.DIV.push([h, a, false]);
      nxt.push(play(ctx, h, a, rng, false, drift));
    }
    nxt.sort(bySeed);
    log.CON.push([nxt[0], nxt[1], false]);
    return play(ctx, nxt[0], nxt[1], rng, false, drift);
  }
  /* One postseason. `w` picks the simulated regular season it is played on
   * (mid-season files); log.seeds says which, for anything that reads byes. */
  function simulateBracket(ctx, rng, w) {
    const season = ctx.seasons ? ctx.seasons[(w || 0) % ctx.seasons.length] : null;
    const seeds = season ? season.seeds : ctx.seeds;
    const drift = season ? season.drift : null;
    const log = { WC: [], DIV: [], CON: [], SB: [], seeds };
    const afc = conference(ctx, seeds.AFC, rng, log, drift);
    const nfc = conference(ctx, seeds.NFC, rng, log, drift);
    log.SB.push([afc, nfc, true]);
    log.champion = play(ctx, afc, nfc, rng, true, drift);
    return log;
  }

  // ── player week means ─────────────────────────────────────────────────────
  /* The team's implied points for one game: the posted line when the book has
   * one (either orientation -- the Super Bowl's "home" side is nominal), else
   * (its season implied-for + the opponent's implied-against) / 2. */
  function gameImplied(ctx, team, opp) {
    const a = ctx.posted.get(`${team}|${opp}`);
    if (a) return a[0];
    const b = ctx.posted.get(`${opp}|${team}`);
    if (b) return b[1];
    const x = ctx.implied[team], y = ctx.implied[opp];
    if (!x || !y) return null;
    return (x.for + y.against) / 2;
  }
  function weekMean(ctx, p, implied) {
    const P = ctx.params;
    let m = p.dk_ppg * P.discount[p.pos];
    const season = ctx.implied[p.team] && ctx.implied[p.team].for;
    if (implied && season) m *= Math.pow(implied / season, P.elasticity);
    return m;
  }
  function weekSd(ctx, pos, mean) {
    const [a, b] = ctx.params.sd_line[pos];
    return a + b * Math.max(mean, 0);
  }
  /* Can he score in `round` at all? Mid-season (ctx.seasonSim) a status is
   * about this week, not January: an IR player may be back, a healthy one may
   * not be. There `avail` is a probability (measured: projections
   * tools/measure_playoff_avail.py) drawn once per world in simulateWorlds,
   * and statuses are not read again here. */
  function available(p, round, ctx) {
    if (!p.avail) return false;
    if (ctx && ctx.seasonSim) return true;
    if (SEASON_OVER.has(p.injury_status)) return false;
    // `Out` is a statement about this week's game: the wild card only.
    if (round === 'WC' && p.injury_status === 'Out') return false;
    return true;
  }

  // ── worlds ───────────────────────────────────────────────────────────────
  /* N simulated postseasons. scores[w * R * P + r * P + i] is player i's DK
   * points in round r of world w, 0 when his team did not play (eliminated or
   * on a bye) or he is unavailable. One Float32Array: 245 players x 4 rounds x
   * 2,000 worlds is 7.8 MB. */
  function simulateWorlds(ctx, n, seed) {
    const rng = mulberry32(seed || 1);
    const P = ctx.players.length, R = ROUNDS.length;
    const scores = new Float32Array(n * R * P);
    const brackets = [];
    const floor = ctx.params.floor;
    // Who is still playing by January, drawn once per world for the whole
    // postseason, on its own stream so the brackets and scores of a file with
    // every avail at 1 are exactly what they were before.
    const arng = mulberry32((seed || 1) + 7919);
    const playing = new Uint8Array(n * P);
    for (let w = 0; w < n; w++) {
      for (let i = 0; i < P; i++) {
        const a = ctx.players[i].avail;
        playing[w * P + i] = a >= 1 ? 1 : a > 0 && arng() < a ? 1 : 0;
      }
    }
    for (let w = 0; w < n; w++) {
      const br = simulateBracket(ctx, rng, w);
      brackets.push(br);
      ROUNDS.forEach((rnd, r) => {
        for (const [home, away] of br[rnd]) {
          const g = gauss(rng);
          for (const [team, opp] of [[home, away], [away, home]]) {
            const ps = ctx.byTeam[team] || [];
            const L = ctx.teamChol[team];
            const e = ps.map(() => gauss(rng));
            const imp = gameImplied(ctx, team, opp);
            ps.forEach((p, i) => {
              if (!available(p, rnd, ctx) || !playing[w * P + p.idx]) return;
              let z = ctx.params.game_load[p.pos] * g;
              const Li = L[i];
              for (let k = 0; k <= i; k++) z += Li[k] * e[k];
              const m = weekMean(ctx, p, imp);
              const s = weekSd(ctx, p.pos, m);
              scores[w * R * P + r * P + p.idx] = Math.max(floor, m + s * z);
            });
          }
        }
      });
    }
    return { n, R, P, scores, brackets, playing };
  }

  // ── lineups ──────────────────────────────────────────────────────────────
  /* Best legal lineup. Greedy is exact here: each position's required slots
   * take its top scorers, and FLEX (any non-QB) takes the best of what is
   * left -- no choice can do better, because FLEX accepts everything the
   * required slots leave over. */
  function bestLineup(ctx, roster, worlds, w, r, lineup) {
    const off = w * worlds.R * worlds.P + r * worlds.P;
    const by = { QB: [], RB: [], WR: [], TE: [] };
    for (const i of roster) by[ctx.players[i].pos].push(worlds.scores[off + i]);
    let total = 0;
    const left = [];
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const xs = by[pos].sort((a, b) => b - a);
      const need = lineup[pos] || 0;
      for (let k = 0; k < xs.length; k++) {
        if (k < need) total += xs[k];
        else if (pos !== 'QB') left.push(xs[k]);
      }
    }
    if (lineup.FLEX) {
      left.sort((a, b) => b - a);
      for (let k = 0; k < lineup.FLEX && k < left.length; k++) total += left[k];
    }
    return total;
  }
  /* A roster's best-lineup score in every world and round: Float32Array [w*R + r]. */
  function rosterScores(ctx, roster, worlds, lineup) {
    const out = new Float32Array(worlds.n * worlds.R);
    for (let w = 0; w < worlds.n; w++) {
      for (let r = 0; r < worlds.R; r++) out[w * worlds.R + r] = bestLineup(ctx, roster, worlds, w, r, lineup);
    }
    return out;
  }

  // ── the field ────────────────────────────────────────────────────────────
  /* Expected DK points over the postseason: sum over rounds of P(plays) x his
   * mean that round. The ranking a draft room approximates before real ADP
   * exists -- SYNTHETIC, and every caller that uses it must say so. */
  function syntheticAdp(ctx, worlds) {
    const tot = new Float64Array(ctx.players.length);
    const { n, R, P, scores } = worlds;
    for (let w = 0; w < n; w++) for (let r = 0; r < R; r++) for (let i = 0; i < P; i++) tot[i] += scores[w * R * P + r * P + i];
    const order = ctx.players.map((p, i) => i).sort((a, b) => tot[b] - tot[a]);
    const adp = new Float64Array(P);
    order.forEach((i, k) => { adp[i] = k + 1; });
    return { adp, expPoints: Array.from(tot, x => x / n) };
  }
  /* DK's ADP from a joined pool (/api/playoff/pool or /api/playoff/pools), by
   * player index. Players DK does not list get 0, which removes them from every
   * board: they cannot be drafted. One copy for the page and the tools, so a
   * check runs on exactly the ADP the page drafts with.
   *
   * A player DK DOES list but nobody has drafted carries ADP 9999. Those are
   * draftable, and they are where a room that drafts dead teams leaves value:
   * the first real pool (draft group 156836, 2026-11-27) had ADP for only 139 of
   * 579, ending at pick 69, and read as 0 they cut Drake Maye and Tyquan Thornton
   * (synthetic top 72) and 9 of the synthetic top 100 out of every board, the
   * recommendation included. They get UNDRAFTED_GAP picks past the last real
   * ADP: bots, which take the lowest ADP, almost never reach them, and the tool
   * can still take one. opts.undrafted false keeps the 0 (tools/playoff-adp.js
   * compares real ADP only). */
  const UNDRAFTED_GAP = 12;    // two rounds of a six-seat pod; judgement
  function adpFromPool(ctx, pool, opts = {}) {
    const byGsis = new Map(ctx.players.map((p, i) => [p.gsis_id, i]));
    const adp = new Float64Array(ctx.players.length);
    const listed = [];
    let last = 0;
    for (const row of pool.players || []) {
      const i = byGsis.get(row.gsis_id);
      if (i === undefined) continue;
      if (row.adp && row.adp < 9999) { adp[i] = row.adp; last = Math.max(last, row.adp); }
      else listed.push(i);
    }
    if (opts.undrafted !== false) for (const i of listed) adp[i] = last + UNDRAFTED_GAP;
    return adp;
  }
  /* Drafter styles (the user, 2026-11-25: "some will stack in a smart way and
   * others will draft off ADP"). A style is a number per seat: 0 drafts by ADP;
   * STACK_PICKS makes a stacker, who reaches that many picks earlier for each
   * teammate already on the roster (up to STACK_MAX), so stacks follow the
   * team of the stars a stacker's ADP picks land on. JUDGEMENT, not measured:
   * no real DK playoff board has been read yet. Six picks is one round per
   * teammate in a six-seat pod, which put stackers at 4-5 from their main team
   * where ADP bots hold 2-3 (tools/playoff-automock.js --room-check). */
  const STACK_PICKS = 6, STACK_MAX = 3;
  /* Bonus (in picks) a drafter of style `style` gives player i, holding `roster`. */
  function stackBonus(ctx, roster, i, style) {
    if (!style) return 0;
    const t = ctx.players[i].team;
    let k = 0;
    for (const j of roster) if (ctx.players[j].team === t) k++;
    return style * Math.min(k, STACK_MAX);
  }
  /* `share` of the seats other than `skip`, chosen at random, as stackers. */
  function roomStyles(seats, share, rng, skip = -1) {
    const styles = new Array(seats).fill(0);
    if (!share) return styles;
    const others = [...Array(seats).keys()].filter(s => s !== skip);
    const n = Math.round(share * others.length);
    for (let k = 0; k < n; k++) {
      const j = k + Math.floor(rng() * (others.length - k));
      [others[k], others[j]] = [others[j], others[k]];
      styles[others[k]] = STACK_PICKS;
    }
    return styles;
  }

  /* One snake draft by ADP bots: each pick is the available player with the
   * lowest ADP + noise (sd in picks), under per-position caps. `taken` seeds
   * picks already made (a live board). opts.styles: per seat, as above (default
   * all ADP). Returns rosters as index arrays. */
  function botDraft(ctx, adp, opts, rng) {
    const seats = opts.seats || 6, rounds = opts.rounds || 12;
    const caps = opts.caps || { QB: 3, RB: 6, WR: 8, TE: 3 };
    const noise = opts.noise ?? 6;
    const styles = opts.styles || null;
    const rosters = Array.from({ length: seats }, () => []);
    const taken = new Set(opts.taken || []);
    const pool = ctx.players.map((p, i) => i).filter(i => !taken.has(i) && adp[i] > 0);
    for (let rd = 0; rd < rounds; rd++) {
      const order = rd % 2 === 0 ? [...Array(seats).keys()] : [...Array(seats).keys()].reverse();
      for (const s of order) {
        const counts = {};
        for (const i of rosters[s]) counts[ctx.players[i].pos] = (counts[ctx.players[i].pos] || 0) + 1;
        let best = -1, bestKey = Infinity;
        const st = styles ? styles[s] : 0;
        for (const i of pool) {
          if (taken.has(i)) continue;
          const pos = ctx.players[i].pos;
          if ((counts[pos] || 0) >= (caps[pos] ?? 99)) continue;
          const key = adp[i] + noise * gauss(rng) - (st ? stackBonus(ctx, rosters[s], i, st) : 0);
          if (key < bestKey) { bestKey = key; best = i; }
        }
        if (best < 0) continue;
        taken.add(best);
        rosters[s].push(best);
      }
    }
    return rosters;
  }

  /* Who you have to beat after round 1, in the same world (scores within a
   * world share the bracket, so a field heavy on the champion rises with it).
   *
   * A round-r opponent is the winner of a mini-tournament over DISTINCT boards,
   * the contest's own structure: level 1 is one board's round-1 winner; level r
   * is the best, on round r-1, of podSize level-(r-1) survivors drawn from
   * DISJOINT boards. Level r needs podSize^(r-1) distinct boards (36 for the
   * final's opponents).
   *
   * Two earlier versions drew pod members WITH replacement -- first from random
   * rosters, then from a small pool of board winners -- and both let a roster
   * sit in a pod twice. A pod that repeats a roster is weaker than a real one,
   * so an average roster's round-3 survival read 15-24% above the 1/216 it must
   * be (worst in the 20-round format, where boards overlap most). Distinct
   * boards make the recursion exact by construction.
   *
   * boardScores: array of boards, each an array of rosterScores.
   * Returns pools[r] (r >= 1) = Float32Array [w * S + s] of a round-r opponent's
   * round-r score; pools[0] is null (round 1 is your own pod). */
  function survivorPools(boardScores, worlds, S, podSize, seed) {
    const rng = mulberry32(seed || 7);
    const R = worlds.R, n = worlds.n, B = boardScores.length;
    const need = Math.pow(podSize, R - 2);
    if (B < need) throw new Error(`survivorPools needs >= ${need} boards, got ${B}`);
    // Each board's round-1 winner per world, ties at random.
    const winner = new Array(n);
    for (let w = 0; w < n; w++) {
      winner[w] = boardScores.map(seats => {
        let best = null, bs = -Infinity;
        for (const sc of seats) { const x = sc[w * R]; if (x > bs || (x === bs && rng() < 0.5)) { bs = x; best = sc; } }
        return best;
      });
    }
    const idx = Array.from({ length: B }, (_, i) => i);
    // Survivor of `level` from the boards idx[off .. off + podSize^(level-1)).
    function survivor(w, level, off) {
      if (level === 1) return winner[w][idx[off]];
      const span = Math.pow(podSize, level - 2);
      let best = null, bs = -Infinity;
      for (let k = 0; k < podSize; k++) {
        const c = survivor(w, level - 1, off + k * span);
        const x = c[w * R + (level - 1)];
        if (x > bs || (x === bs && rng() < 0.5)) { bs = x; best = c; }
      }
      return best;
    }
    const pools = [null];
    for (let r = 1; r < R; r++) {
      const m = Math.pow(podSize, r - 1);
      const pool = new Float32Array(n * S);
      for (let w = 0; w < n; w++) {
        for (let s = 0; s < S; s++) {
          for (let k = 0; k < m; k++) {          // partial Fisher-Yates: m distinct boards
            const j = k + Math.floor(rng() * (B - k));
            const t = idx[k]; idx[k] = idx[j]; idx[j] = t;
          }
          pool[w * S + s] = survivor(w, r, 0)[w * R + r];
        }
      }
      pools.push(pool);
    }
    return pools;
  }

  /* A roster's path through the contest, per world: round 1 against its own
   * pod (`podScores`, the other seats' rosterScores), later rounds against
   * podSize-1 opponents sampled from `pools`. Returns P(survive round r) for
   * each r, unconditional, and the round-4 (final) score of every world in
   * which it reached the final, for the payout step to rank. */
  function contestPath(myScores, podScores, pools, worlds, opts, seed) {
    const rng = mulberry32(seed || 11);
    const podSize = opts.podSize || 6, R = worlds.R, n = worlds.n;
    const S = pools[1].length / n;
    const finalRound = R - 1;
    const survive = new Float64Array(finalRound);
    const finals = [];
    for (let w = 0; w < n; w++) {
      let alive = true;
      for (let r = 0; r < finalRound && alive; r++) {
        const me = myScores[w * R + r];
        const opp = [];
        if (r === 0) for (const ps of podScores) opp.push(ps[w * R]);
        else for (let k = 0; k < podSize - 1; k++) opp.push(pools[r][w * S + Math.floor(rng() * S)]);
        // Ties split evenly. Late rounds are full of them -- a roster with
        // nobody left in the conference games scores exactly 0, and so do
        // its opponents -- and awarding ties to "me" inflated round-3
        // survival 48% above the 1/216 an average roster must get.
        let beaten = false, ties = 0;
        for (const o of opp) { if (o > me) { beaten = true; break; } if (o === me) ties++; }
        if (!beaten && ties && rng() * (ties + 1) >= 1) beaten = true;
        if (beaten) alive = false; else survive[r] += 1;
      }
      if (alive) finals.push({ w, score: myScores[w * R + finalRound] });
    }
    return { survive: Array.from(survive, x => x / n), finals };
  }

  const api = {
    ROUNDS, build, simulateBracket, simulateWorlds, bestLineup, rosterScores,
    syntheticAdp, adpFromPool, botDraft, STACK_PICKS, STACK_MAX, stackBonus, roomStyles, survivorPools, contestPath, mulberry32, gauss, normCdf,
    weekMean, weekSd, gameImplied, available,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlayoffSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
