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
};
