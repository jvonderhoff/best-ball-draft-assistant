/* Playoff best ball recommender — docs/PLAYOFF_DESIGN.md step 3.
 *
 * For each candidate pick: put him on my roster, let ADP bots finish the board
 * (every seat, mine included), score every roster in every simulated
 * postseason (static/playoff-sim.js), and measure what the contest pays for:
 *
 *   P(win my round-1 pod) -> P(win a round-2 pod) -> P(win a round-3 pod) = P(final)
 *   -> E[payout | my Super Bowl-week score, that world's finalists]
 *
 * The objective is EV under the format's payout ladder when one is entered,
 * else P(reach the final). Without a ladder, reaching the final is the target
 * every ladder agrees on; ranking by P(1st) instead would rest on a tail the
 * simulator cannot resolve at 2,000 worlds.
 *
 * Every candidate is scored on the SAME worlds and the SAME bot completions
 * (common random numbers), so differences between candidates are paired, the
 * way the regular-season harness compares models.
 *
 * Later rounds are computed, not sampled: given my score in a world, P(beat
 * podSize-1 random survivors) = F(my score)^(podSize-1), with F that world's
 * empirical distribution of survivor scores. Sampling opponents (as
 * PlayoffSim.contestPath does, and the check script compares the two) adds
 * noise that, at 1/216 events, swamped the differences between picks.
 */
(function (root) {
  'use strict';
  const Sim = (typeof module !== 'undefined' && module.exports) ? require('./playoff-sim.js') : root.PlayoffSim;

  /* Formats as reported by write-ups on 2026-11-17. They DISAGREE, which is why
   * there are two and why the page asks you to confirm in the lobby. Payouts
   * beyond what a source printed are left out, not invented: EV is then over the
   * known prizes only, and the page says so. */
  const PRESETS = {
    'dk-12': {
      label: '12 rounds · QB RB WR WR TE FLEX · final 816',
      source: 'RotoWire, "$3M Playoff Millionaire"',
      rounds: 12, lineup: { QB: 1, RB: 1, WR: 2, TE: 1, FLEX: 1 },
      podSize: 6, finalSize: 816, payouts: [],
      measured: 'real postseasons 2016-25 (30 drafts each, synthetic-ADP bots): 2.1x the ADP seats\' P(final), 1.6x without the best season; better in 6 of 10',
    },
    'dk-20': {
      label: '20 rounds · QB RB RB WR WR WR TE FLEX · final 81',
      source: 'Stokastic, $20 entry',
      rounds: 20, lineup: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1 },
      podSize: 6, finalSize: 81, payouts: [[1, 1, 100000], [2, 2, 31000], [3, 3, 20000]],
      // The two measurements disagree, so the page says so. In-model (12 drafts):
      // 0.99x. Real postseasons 2016-25 (12 drafts each): 3.4x, 2.2x without
      // 2018, better in only 5 of 10 seasons. Neither is proof either way.
      warning: 'Mixed evidence in this format: no better than ADP in-model (0.99x), 3.4x on real 2016-25 postseasons but better in only 5 of 10 seasons. Treat as a second opinion.',
    },
  };
  // Roster caps for the bots, so a bot does not take a fifth QB. Judgement, not
  // measured: there is no real playoff board to measure against yet.
  const CAPS = { 12: { QB: 2, RB: 4, WR: 5, TE: 2 }, 20: { QB: 3, RB: 6, WR: 8, TE: 4 } };

  /* "1:100000, 2:31000, 3-5:5000" -> [[1,1,100000],[2,2,31000],[3,5,5000]] */
  function parsePayouts(text) {
    const out = [];
    for (const part of String(text || '').split(',')) {
      const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?\s*:\s*\$?([\d.]+)\s*$/);
      if (m) out.push([+m[1], +(m[2] || m[1]), +m[3]]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }
  function payoutAt(payouts, place) {
    for (const [a, b, amt] of payouts) if (place >= a && place <= b) return amt;
    return 0;
  }

  // ── the field, once per draft ───────────────────────────────────────────────
  /* Bot boards for the opponents I meet after round 1, and per-world survivor
   * score distributions for each later round. Built once per (format, ADP); it
   * does not depend on my picks. */
  function buildField(ctx, worlds, adp, format, opts = {}) {
    // 120 boards, measured: at 40, every world has at most 40 distinct round-1
    // winners, later pods drawn from them repeat a roster and are weaker, and an
    // average roster's round-3 survival read 0.0054-0.0058 against the 1/216 =
    // 0.0046 it must be. At 120 it reads 0.0048-0.0051, and 240 is no better.
    // Costs ~6 s on the Mac, once per draft.
    const B = opts.boards || 120, S = opts.survivors || 300;
    const rng = Sim.mulberry32(opts.seed || 21);
    const caps = format.caps || CAPS[format.rounds] || CAPS[20];
    const boards = [];
    for (let b = 0; b < B; b++) {
      const rs = Sim.botDraft(ctx, adp, { seats: format.podSize, rounds: format.rounds, caps }, rng);
      boards.push(rs.map(r => Sim.rosterScores(ctx, r, worlds, format.lineup)));
    }
    const pools = Sim.survivorPools(boards, worlds, S, format.podSize, (opts.seed || 21) + 1);
    const n = worlds.n;
    const sorted = [null];
    for (let r = 1; r < pools.length; r++) {
      const arr = new Float32Array(n * S);
      for (let w = 0; w < n; w++) {
        const slice = pools[r].slice(w * S, (w + 1) * S).sort();
        arr.set(slice, w * S);
      }
      sorted.push(arr);
    }
    // Final-round tail: normal fit per world, because first place in an 816-team
    // final is a 1-in-816 event and 300 samples cannot resolve it.
    const last = pools.length - 1;
    const mu = new Float32Array(n), sd = new Float32Array(n);
    for (let w = 0; w < n; w++) {
      let s1 = 0, s2 = 0;
      for (let s = 0; s < S; s++) { const x = pools[last][w * S + s]; s1 += x; s2 += x * x; }
      mu[w] = s1 / S; sd[w] = Math.sqrt(Math.max(1e-6, s2 / S - (s1 / S) ** 2));
    }
    return { S, sorted, mu, sd, boards: B, caps };
  }

  // Mid-rank CDF: ties count half, so two empty rosters split a tie rather than
  // one winning it (the round-3 inflation contestPath also had to fix).
  function cdf(sortedArr, off, S, x) {
    let lo = 0, hi = S;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sortedArr[off + m] < x) lo = m + 1; else hi = m; }
    const below = lo;
    let hi2 = below;
    while (hi2 < S && sortedArr[off + hi2] === x) hi2++;
    return (below + 0.5 * (hi2 - below)) / S;
  }

  /* One roster's value against a known round-1 pod and the field. */
  function contestValue(myScores, podScores, field, worlds, format) {
    const R = worlds.R, n = worlds.n, S = field.S, k = format.podSize - 1;
    const surv = [0, 0, 0];
    let ev = 0, pWin = 0;
    const N = format.finalSize;
    const maxPlace = format.payouts.length ? format.payouts[format.payouts.length - 1][1] : 0;
    for (let w = 0; w < n; w++) {
      const me1 = myScores[w * R];
      let above = 0, ties = 0;
      for (const ps of podScores) { const o = ps[w * R]; if (o > me1) above++; else if (o === me1) ties++; }
      if (above) continue;
      let p = 1 / (ties + 1);
      surv[0] += p;
      for (let r = 1; r < R - 1; r++) {
        p *= Math.pow(cdf(field.sorted[r], w * S, S, myScores[w * R + r]), k);
        surv[r] += p;
      }
      // The final: N-1 finalists, each beating my SB-week score with prob q.
      const z = (myScores[w * R + R - 1] - field.mu[w]) / field.sd[w];
      const q = Math.min(1 - 1e-12, Math.max(1e-12, 1 - Sim.normCdf(z)));
      pWin += p * Math.pow(1 - q, N - 1);
      if (maxPlace) {
        // P(exactly j finalists beat me), j = 0..maxPlace-1, by the binomial recurrence.
        let pmf = Math.pow(1 - q, N - 1), e = 0;
        for (let j = 0; j < maxPlace && j < N; j++) {
          e += pmf * payoutAt(format.payouts, j + 1);
          pmf *= ((N - 1 - j) / (j + 1)) * (q / (1 - q));
        }
        ev += p * e;
      }
    }
    return { pR: surv.map(x => x / n), pFinal: surv[R - 2] / n, pWin: pWin / n, ev: ev / n };
  }

  // ── the board ───────────────────────────────────────────────────────────────
  function seatOfPick(pick, seats) {          // 1-based pick -> 0-based seat, snake
    const rd = Math.floor((pick - 1) / seats), i = (pick - 1) % seats;
    return rd % 2 === 0 ? i : seats - 1 - i;
  }

  /* Finish a board from `rosters` (index arrays per seat) starting at pick
   * `fromPick`, every seat drafting as an ADP bot. Deterministic for a seed. */
  function completeBoard(ctx, adp, rosters, taken, fromPick, format, rng, noise) {
    const seats = format.podSize, total = seats * format.rounds;
    const caps = format.caps || CAPS[format.rounds] || CAPS[20];
    const out = rosters.map(r => r.slice());
    const tk = new Set(taken);
    const pool = ctx.players.map((p, i) => i).filter(i => adp[i] > 0 && !tk.has(i))
      .sort((a, b) => adp[a] - adp[b]);
    for (let pick = fromPick; pick <= total; pick++) {
      const s = seatOfPick(pick, seats);
      const counts = {};
      for (const i of out[s]) counts[ctx.players[i].pos] = (counts[ctx.players[i].pos] || 0) + 1;
      let best = -1, bestKey = Infinity;
      // ADP-sorted, so beyond ~4 noise sds past the best key nothing can win.
      for (const i of pool) {
        if (tk.has(i)) continue;
        if (adp[i] - 4 * noise > bestKey) break;
        const pos = ctx.players[i].pos;
        if ((counts[pos] || 0) >= (caps[pos] ?? 99)) continue;
        const key = adp[i] + noise * Sim.gauss(rng);
        if (key < bestKey) { bestKey = key; best = i; }
      }
      if (best < 0) continue;
      tk.add(best);
      out[s].push(best);
    }
    return out;
  }

  /* board = { mySeat (0-based), rosters: [[idx...] per seat], taken: [idx...],
   *           nextPick (1-based overall pick about to be made) }
   * Returns candidates sorted best first. */
  function recommend(ctx, worlds, adp, field, format, board, opts = {}) {
    const C = opts.candidates || 20, M = opts.completions || 3, noise = opts.noise ?? 6;
    const taken = new Set(board.taken);
    const avail = ctx.players.map((p, i) => i).filter(i => !taken.has(i) && adp[i] > 0 && ctx.players[i].avail);
    avail.sort((a, b) => adp[a] - adp[b]);
    const cands = avail.slice(0, C);
    const results = [];
    for (const c of cands) {
      let acc = { pR: [0, 0, 0], pFinal: 0, pWin: 0, ev: 0 };
      for (let m = 0; m < M; m++) {
        const rng = Sim.mulberry32(1000 + m);          // same completions for every candidate
        const rosters = board.rosters.map(r => r.slice());
        rosters[board.mySeat].push(c);
        const done = completeBoard(ctx, adp, rosters, [...taken, c], board.nextPick + 1, format, rng, noise);
        const mine = Sim.rosterScores(ctx, done[board.mySeat], worlds, format.lineup);
        const pod = done.filter((_, s) => s !== board.mySeat).map(r => Sim.rosterScores(ctx, r, worlds, format.lineup));
        const v = contestValue(mine, pod, field, worlds, format);
        acc.pR = acc.pR.map((x, r) => x + v.pR[r] / M);
        acc.pFinal += v.pFinal / M; acc.pWin += v.pWin / M; acc.ev += v.ev / M;
      }
      results.push({ idx: c, ...acc });
    }
    const key = format.payouts.length ? 'ev' : 'pFinal';
    results.sort((a, b) => b[key] - a[key]);
    return { key, results };
  }

  /* Teams on my roster that must meet before the Super Bowl, with how likely
   * that is: two teams in one conference cannot both reach the final. */
  function conflicts(ctx, worlds, rosterIdx) {
    const teams = [...new Set(rosterIdx.map(i => ctx.players[i].team))];
    const conf = {};
    for (const [c, ts] of Object.entries(ctx.seeds)) for (const t of ts) conf[t] = c;
    const out = [];
    for (let a = 0; a < teams.length; a++) for (let b = a + 1; b < teams.length; b++) {
      if (conf[teams[a]] !== conf[teams[b]]) continue;
      let meet = 0;
      for (const br of worlds.brackets) {
        for (const r of ['WC', 'DIV', 'CON']) for (const [h, aw] of br[r]) {
          if ((h === teams[a] && aw === teams[b]) || (h === teams[b] && aw === teams[a])) meet++;
        }
      }
      out.push({ a: teams[a], b: teams[b], pMeet: meet / worlds.n });
    }
    return out.sort((x, y) => y.pMeet - x.pMeet);
  }

  const api = { PRESETS, CAPS, parsePayouts, buildField, contestValue, completeBoard, recommend, seatOfPick, conflicts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlayoffRec = api;
})(typeof window !== 'undefined' ? window : globalThis);
