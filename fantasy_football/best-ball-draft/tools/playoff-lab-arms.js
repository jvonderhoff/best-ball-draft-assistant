/* Strategies ("arms") for tools/playoff-lab.js. One arm = one way of choosing my pick.
 *
 * Add a theory HERE, not in the engine. An arm is a factory `(param) => spec`:
 *   rec:   extra options for Rec.recommend (completions, candidates, room, ...).
 *   allow: (i, st) => bool, a rule on which players may be offered.
 *   rank:  (res, st) => res re-ordered; res[0] is taken. Default: the tool's order.
 *   key:   REQUIRED when rec or allow is set — names the recommend() inputs, so the
 *          lab's cache never hands one arm another arm's results. Arms that only
 *          re-rank share the control's recommend() calls, which is what makes a
 *          multi-arm run cheap: every arm makes the same picks until they diverge.
 * st = { ctx, P, adp, format, me, rosters, taken, pick, round, mine } where
 * mine[team] = how many of that team are already on my roster.
 *
 * Every arm here is HARNESS ONLY. The page ranks by P(final); nothing in this file
 * reaches it. The results ledger is docs/PLAYOFF_LAB.md — read it before adding an
 * arm, because several of these ideas have already been measured and lost.
 */
'use strict';

const byScore = (res, f) => res.slice().sort((a, b) => f(b) - f(a));

module.exports = {
  // The page's own pick: the top row by P(reach the final).
  control: () => ({}),

  // pFinal x (1 + b x teammates already mine). LOST 2026-11-27 (STATUS): bigger
  // stacks, reach-final down, win-final flat. Kept as a known-loser control.
  stack: (b = 0.1) => ({
    rank: (res, st) => byScore(res, r => r.pFinal * (1 + b * (st.mine[st.P[r.idx].team] || 0))),
  }),

  // Lean toward winning the final: pFinal^(1-a) x pWin^a. a = 1 ranks on pWin alone.
  // (Ranking by expected winnings — nearly all first place — LOST 2026-11-27.)
  win: (a = 0.25) => ({
    rank: res => byScore(res, r => Math.pow(Math.max(r.pFinal, 1e-12), 1 - a) * Math.pow(Math.max(r.pWin, 1e-12), a)),
  }),

  // From round R on, rank by P(win the final) instead of P(reach it).
  latewin: (R = 10) => ({
    rank: (res, st) => st.round >= R ? byScore(res, r => r.pWin) : res,
  }),

  // More simulated drafts per candidate (the page uses 24).
  compute: (M = 48) => ({ key: 'M' + M, rec: { completions: M } }),

  // At most N QBs on my roster.
  qbcap: (N = 1) => ({
    key: 'qbcap' + N,
    allow: (i, st) => st.P[i].pos !== 'QB' || st.rosters[st.me].filter(j => st.P[j].pos === 'QB').length < N,
  }),

  // Leverage (ledger 15): favour teams the OTHER seats have drafted least so far.
  // "Least" is against what an ADP room would hold by now — raw counts alone would
  // just favour bad teams, which pFinal already marks down. For team t:
  //   e_t = 5/6 x (t's players among the top taken.length by ADP), o_t = t's players
  //   on the other five rosters; score = pFinal x max(0, 1 + b x (e_t - o_t)).
  lev: (b = 0.1) => ({
    rank: (res, st) => {
      const exp = {}, got = {};
      const byAdp = st.P.map((p, i) => i).filter(i => st.adp[i] > 0).sort((x, y) => st.adp[x] - st.adp[y]);
      for (const i of byAdp.slice(0, st.taken.length)) exp[st.P[i].team] = (exp[st.P[i].team] || 0) + 5 / 6;
      st.rosters.forEach((r, s) => { if (s !== st.me) for (const i of r) got[st.P[i].team] = (got[st.P[i].team] || 0) + 1; });
      return byScore(res, r => { const t = st.P[r.idx].team; return r.pFinal * Math.max(0, 1 + b * ((exp[t] || 0) - (got[t] || 0))); });
    },
  }),

  // Bring-back (ledger 16): once I hold 2+ of one team (my main team, most players;
  // ties to the likelier Super Bowl team), favour the team it most often meets in
  // the Super Bowl: their players' pFinal x (1 + b).
  bring: (b = 0.15) => ({
    rank: (res, st) => {
      const { pair, pSB } = sbOdds(st.ctx);
      const main = mainTeam(st, pSB);
      if (!main || st.mine[main] < 2) return res;
      const opp = Object.entries(pair[main] || {}).sort((x, y) => y[1] - x[1])[0];
      if (!opp) return res;
      return byScore(res, r => r.pFinal * (st.P[r.idx].team === opp[0] ? 1 + b : 1));
    },
  }),

  // Commit early (ledger 17): from round 3, my main team (most players; ties to the
  // likelier Super Bowl team) is fixed, Build-around style: take its best player
  // whenever his pFinal is within a fraction m of the top row; otherwise the top row.
  commit: (m = 0.1) => {
    let fixed = null;                                             // set at my round-3 pick
    return {
      rank: (res, st) => {
        if (st.round < 3) { fixed = null; return res; }           // rounds 1-2 of every draft reset it
        if (!fixed) fixed = mainTeam(st, sbOdds(st.ctx).pSB);
        const best = res.filter(r => st.P[r.idx].team === fixed).sort((x, y) => y.pFinal - x.pFinal)[0];
        if (!best || best.pFinal < (1 - m) * res[0].pFinal) return res;
        return [best, ...res.filter(r => r !== best)];
      },
    };
  },
};

// Super Bowl odds from 4,000 simulated brackets (own stream; only team odds are read).
const SB = new WeakMap();
function sbOdds(ctx) {
  if (SB.has(ctx)) return SB.get(ctx);
  const Sim = require('../static/playoff-sim.js');
  const n = 4000, rng = Sim.mulberry32(4242), pair = {}, pSB = {};
  for (let w = 0; w < n; w++) {
    const [a, b] = Sim.simulateBracket(ctx, rng, w).SB[0];
    for (const [x, y] of [[a, b], [b, a]]) {
      pSB[x] = (pSB[x] || 0) + 1 / n;
      (pair[x] = pair[x] || {})[y] = (pair[x][y] || 0) + 1 / n;
    }
  }
  const out = { pair, pSB };
  SB.set(ctx, out);
  return out;
}

// My main team: most players on my roster, ties to the likelier Super Bowl team.
function mainTeam(st, pSB) {
  const t = Object.keys(st.mine).sort((x, y) => st.mine[y] - st.mine[x] || (pSB[y] || 0) - (pSB[x] || 0))[0];
  return t || null;
}
