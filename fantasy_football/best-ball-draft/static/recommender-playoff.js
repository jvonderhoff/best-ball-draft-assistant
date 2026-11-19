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

  /* DK's playoff format, from DK's own rules page (help/rules/nfl/playoff-best-ball,
   * read 2026-11-19): 12 players, QB RB WR WR TE FLEX + 6 bench, 30-second fast
   * drafts. A 'dk-20' preset (20 rounds, 8 starters, final 81) was here until
   * 2026-11-19; it came from one write-up (Stokastic, Aug 2026), DK's lobby lists
   * Playoff Best Ball as "a 12-player team", and it never beat ADP drafters from
   * mid-season, so it went. Final sizes are
   * inferred from the lobby (below): confirm them, and the payouts, in the lobby. Payouts beyond what a source
   * printed are left out, not invented: EV is then over the known prizes only. */
  // The 2026-27 lobby (user's screenshot, 2026-11-19). Final size = entries / 216,
  // i.e. 1 of 6 advancing in each of rounds 1-3; it comes out whole for these four,
  // which is the evidence they use that format. Field General ($444) and Spy ($100)
  // do not divide by 216, so they advance differently and are left out until their
  // rounds tab is read. Confirm each contest's rounds tab in the lobby.
  const BASE = {
    rounds: 12, lineup: { QB: 1, RB: 1, WR: 2, TE: 1, FLEX: 1 }, podSize: 6, payouts: [],
    source: 'DK rules page (roster); DK lobby 2026-11-19 (fee, field; final = field / 216)',
    measured: 'real postseasons 2016-25, synthetic-ADP bots blind to byes. Drafting from mid-November, 180 drafts: round 1 won 29% vs 14% for ADP drafters. P(final) 3.1x (60 drafts) and 4.4x (120; 2.8x without the best season), but better in only 4 of 10 seasons each time: treat the final as a lottery',
  };
  const PRESETS = {
    'dk-12': { ...BASE, label: '$5M Playoff Millionaire · $25 · final 1,089', finalSize: 1089 },
    'fair-catch': { ...BASE, label: '$50K Fair Catch · $12 single entry · final 22', finalSize: 22 },
    'play-action': { ...BASE, label: '$400K Play-Action · $3 · final 733', finalSize: 733 },
    'nickel': { ...BASE, label: '$100K Nickel · $5 · final 110', finalSize: 110 },
  };
  // Roster caps for the bots, so a bot does not take a fifth QB. Judgement, not
  // measured: there is no real playoff board to measure against yet.
  // DK's own auto-draft stops at 2 QB, 3 RB, 5 WR, 2 TE (rules page), but only for
  // drafters who never touched their rankings; RB 4 is kept for the rest.
  const CAPS = { 12: { QB: 2, RB: 4, WR: 5, TE: 2 } };

  /* DK's own roster rules (help/rules/nfl/playoff-best-ball, read 2026-11-19): a
   * lineup without at least 1 QB, 1 RB, 2 WR and 1 TE is INVALID and scores
   * nothing all postseason, and a lineup may hold at most 3 QBs and 3 TEs. The
   * minimums are the lineup's fixed slots, FLEX excluded. */
  const MAX_POS = { QB: 3, TE: 3 };
  function canTake(ctx, format, myRoster, i) {
    const pos = ctx.players[i].pos;
    const counts = {};
    for (const j of myRoster) counts[ctx.players[j].pos] = (counts[ctx.players[j].pos] || 0) + 1;
    counts[pos] = (counts[pos] || 0) + 1;
    if (counts[pos] > (MAX_POS[pos] ?? 99)) return false;
    const left = format.rounds - myRoster.length - 1;   // picks after this one
    let short = 0;
    for (const [p, k] of Object.entries(format.lineup)) if (p !== 'FLEX') short += Math.max(0, k - (counts[p] || 0));
    return short <= left;
  }

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
    const caps = format.caps || CAPS[format.rounds] || CAPS[12];
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
    const caps = format.caps || CAPS[format.rounds] || CAPS[12];
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
  /* Two ways to value a candidate against the rest of the draft:
   *
   *  'swap' (tested 2026-11-19, NOT the default): finish the board ONCE per completion with bots in every
   *   seat, mine included, then for each candidate swap him in for the player
   *   my seat took at this pick, and hand that displaced player to whichever
   *   seat had the candidate later. Every candidate then faces the same board,
   *   so the difference between two candidates is the difference between two
   *   players and nothing else.
   *
   *  'redraft' (the default): re-run the bots after each candidate. Taking a
   *   different player changes every later bot pick, so each candidate gets
   *   its own board. Measured 2026-11-19 (tools/playoff-backtest.js, scratch
   *   stability check): two completion seeds on the same board ranked the
   *   candidates with rank correlation -0.2 to 0.5 in 20 rounds and changed
   *   the top pick about half the time, because one player's value is smaller
   *   than the spread of 19 re-drafted picks. That noise made the 20-round
   *   recommender reach down the ADP list at random, worse than ADP drafters.
   *
   * Swap is far steadier (rank correlation 0.5-0.85 between seeds) and still
   * lost on real postseasons, 12 rounds, drafting from mid-November
   * (tools/playoff-backtest.sh, 180 drafts in two batches, same seeds for both):
   * round 1 won 25.9% vs redraft 28.9% (ADP seats ~14.5%), P(final) 1.76x vs
   * 4.44x on the 120-draft batch. Paired by draft the round-1 gap is -5.8 points,
   * se 5.8: not significant, but no sign swap helps. Redraft stays. A guess at
   * why: swap's later picks cannot react to this one, and redraft's re-run
   * does price, roughly, what a pick does to the rest of my draft. Do not retry
   * swap as a noise fix without beating redraft on this backtest. A swap can put
   * an opponent one over a cap; that roster is not scored as mine. */
  function recommend(ctx, worlds, adp, field, format, board, opts = {}) {
    const method = opts.method || 'redraft';
    const C = opts.candidates || 20, noise = opts.noise ?? 6;
    // Swap scores each candidate with 2 rosters, not 6, so it affords more completions.
    const M = opts.completions || (method === 'swap' ? 8 : 3);
    const taken = new Set(board.taken);
    const mineNow = board.rosters[board.mySeat];
    // Never offer a pick that leaves the roster unable to meet DK's minimums with
    // the picks left (an invalid entry scores zero) or breaks the QB/TE maximum.
    // opts.allow(i): an extra rule on which players may be offered (rosterRule below).
    const avail = ctx.players.map((p, i) => i).filter(i => !taken.has(i) && adp[i] > 0 && ctx.players[i].avail
      && canTake(ctx, format, mineNow, i) && (!opts.allow || opts.allow(i)));
    avail.sort((a, b) => adp[a] - adp[b]);
    const cands = avail.slice(0, C);
    const me = board.mySeat, slot = board.rosters[me].length;
    const lu = format.lineup;
    const acc = new Map(cands.map(c => [c, { pR: [0, 0, 0], pFinal: 0, pWin: 0, ev: 0 }]));
    const add = (c, v) => {
      const a = acc.get(c);
      a.pR = a.pR.map((x, r) => x + v.pR[r] / M);
      a.pFinal += v.pFinal / M; a.pWin += v.pWin / M; a.ev += v.ev / M;
    };
    for (let m = 0; m < M; m++) {
      const rngSeed = (opts.seed ?? 1000) + m;          // same completions for every candidate
      if (method === 'redraft') {
        for (const c of cands) {
          const rosters = board.rosters.map(r => r.slice());
          rosters[me].push(c);
          const done = completeBoard(ctx, adp, rosters, [...taken, c], board.nextPick + 1, format, Sim.mulberry32(rngSeed), noise);
          const mine = Sim.rosterScores(ctx, done[me], worlds, lu);
          const pod = done.filter((_, s) => s !== me).map(r => Sim.rosterScores(ctx, r, worlds, lu));
          add(c, contestValue(mine, pod, field, worlds, format));
        }
        continue;
      }
      const base = completeBoard(ctx, adp, board.rosters, board.taken, board.nextPick, format, Sim.mulberry32(rngSeed), noise);
      const b0 = base[me][slot];
      const holder = new Map();                         // player -> seat that drafts him in `base`
      base.forEach((r, s) => r.forEach(i => holder.set(i, s)));
      const baseScores = base.map(r => Sim.rosterScores(ctx, r, worlds, lu));
      const others = (s, swapped) => baseScores.filter((_, k) => k !== me).map((sc, j) => {
        const k = j < me ? j : j + 1;
        return k === s ? swapped : sc;
      });
      for (const c of cands) {
        const h = holder.get(c);
        // c is my pick here anyway, or I take him later in `base`: then taking him
        // now and b0 at that later slot leaves the same roster.
        if (c === b0 || h === me || b0 === undefined) {
          add(c, contestValue(baseScores[me], others(-1), field, worlds, format));
          continue;
        }
        const mineIdx = base[me].slice(); mineIdx[slot] = c;
        const mine = Sim.rosterScores(ctx, mineIdx, worlds, lu);
        let pod;
        if (h === undefined) pod = others(-1);          // nobody drafts c; b0 goes undrafted
        else {
          const theirs = base[h].map(i => (i === c ? b0 : i));
          pod = others(h, Sim.rosterScores(ctx, theirs, worlds, lu));
        }
        add(c, contestValue(mine, pod, field, worlds, format));
      }
    }
    const results = cands.map(c => ({ idx: c, ...acc.get(c) }));
    const key = format.payouts.length ? 'ev' : 'pFinal';
    results.sort((a, b) => b[key] - a[key]);
    return { key, results };
  }

  /* P(player i scores in wild-card week) in the simulated worlds: his team is in
   * the bracket, not on a bye, and he is playing. What a drafter knows, not what
   * happened. Float32Array by player index. */
  function wcPlay(ctx, worlds) {
    const P = ctx.players.length, out = new Float32Array(P);
    const byTeam = ctx.byTeam;
    worlds.brackets.forEach((br, w) => {
      for (const [h, a] of br.WC) for (const t of [h, a]) for (const p of (byTeam[t] || [])) {
        if (!worlds.playing || worlds.playing[w * P + p.idx]) out[p.idx] += 1;
      }
    });
    for (let i = 0; i < P; i++) out[i] /= worlds.n;
    return out;
  }

  /* The user's roster rules (2026-11-19), as filters on the candidates, for the
   * backtest to test before anything ships:
   *   conf: at most CONF_MAX players from one conference (stack across them: two
   *         teams in one conference cannot both reach the Super Bowl);
   *   wc:   keep the roster on course for at least WC_MIN expected wild-card-week
   *         scorers (a bye stack must be paired with players who play that week).
   *         Course = expected scorers so far + WC_PER_PICK for each pick left;
   *         0.7 is about the best a single pick can add (a near-certain playoff
   *         team, small bye chance). WC_MIN 7 is where an ADP roster sits (7.1 in
   *         the 2026-11-19 mock draft).
   *
   * MEASURED 2026-11-19, and neither ships as a default: tools/playoff-backtest.sh
   * --rule, 12 rounds from mid-November, the same 120 drafts as the unruled run:
   *   none: round 1 30.0%, P(final) 4.44x ADP (2.77x without the best season)
   *   conf: round 1 28.3% (paired -1.7 pts, se 4.4), P(final) 1.44x (0.60x)
   *   wc:   round 1 25.0% (paired -5.0 pts, se 4.7), P(final) 0.37x (0.13x)
   *   both: round 1 25.0%, P(final) 0.49x
   * wc found no legal candidate among the top 14 on 262 of 1,440 picks and fell
   * back to the unruled pick. The recommender already prices conferences and byes
   * world by world; forcing them on top cost here, as forcing roster shape did
   * three times in V2_DESIGN §4. The page shows the numbers instead (In/Bye/G,
   * conferences, wild-card coverage) for the drafter's own judgement. */
  const CONF_MAX = 7, WC_MIN = 7, WC_PER_PICK = 0.7;
  function rosterRule(name, ctx, format, wc, mine) {
    if (!name || name === 'none') return null;
    const conf = {};
    let exp = 0;
    for (const j of mine) { const c = ctx.conf[ctx.players[j].team]; conf[c] = (conf[c] || 0) + 1; exp += wc[j]; }
    const left = format.rounds - mine.length - 1;
    const okConf = i => (conf[ctx.conf[ctx.players[i].team]] || 0) + 1 <= CONF_MAX;
    const okWc = i => exp + wc[i] + WC_PER_PICK * left >= WC_MIN;
    if (name === 'conf') return okConf;
    if (name === 'wc') return okWc;
    if (name === 'both') return i => okConf(i) && okWc(i);
    throw new Error(`unknown rule ${name}`);
  }

  /* Teams on my roster that must meet before the Super Bowl, with how likely
   * that is: two teams in one conference cannot both reach the final. */
  function conflicts(ctx, worlds, rosterIdx) {
    const teams = [...new Set(rosterIdx.map(i => ctx.players[i].team))];
    const conf = ctx.conf;
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

  const api = { PRESETS, CAPS, MAX_POS, canTake, wcPlay, rosterRule, CONF_MAX, WC_MIN, parsePayouts, buildField, contestValue, completeBoard, recommend, seatOfPick, conflicts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlayoffRec = api;
})(typeof window !== 'undefined' ? window : globalThis);
