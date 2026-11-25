#!/usr/bin/env node
/* Backtest the playoff recommender on REAL postseasons — PLAYOFF_DESIGN step 4.
 *
 *   node tools/playoff-backtest.js --season 2023 --preset dk-12 --drafts 6 --out x.json
 *   tools/playoff-backtest.sh dk-12 6          # all seasons in parallel, then the summary
 *
 * Inputs: ../projections/data/playoff_backtest/<season>.json
 * (tools/build_playoff_backtest.py): the bracket and players as a drafter saw them
 * before the wild card, and what every player actually scored.
 *
 * Per draft: one seat drafts by the recommender (on simulated postseasons, the
 * same as the live page), five by ADP bots. Then every roster is scored on the ONE
 * postseason that happened. Round 1 is decided against the real board; later
 * rounds against survivors of 120 bot boards scored on that same real postseason,
 * so P(R2), P(final) are probabilities over who you would have drawn, not over
 * what happened.
 *
 * This is the only test of the recommender whose answer key is not its own model
 * (tools/playoff-rec-check.js scores with the model it is testing). Its limits:
 * one world per season, ten seasons, synthetic ADP (the bots draft the model's
 * expected points), and availability approximated from box scores (see the
 * builder's header). Read seasons, not just the total: one champion can carry it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Sim = require(path.join(__dirname, '..', 'static', 'playoff-sim.js'));
const Rec = require(path.join(__dirname, '..', 'static', 'recommender-playoff.js'));

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, xs) => {
  if (a.startsWith('--')) acc.push([a.slice(2), xs[i + 1]]);
  return acc;
}, []));
const DATA = args.data || path.join(__dirname, '..', '..', 'projections', 'data', 'playoff_backtest');
const season = parseInt(args.season, 10);
const preset = args.preset || 'dk-12';
const DRAFTS = parseInt(args.drafts || '6', 10);
const N = parseInt(args.worlds || '2000', 10);
const CANDS = parseInt(args.candidates || '14', 10);
// Unset = the recommender's own default for the method (redraft 3, swap 8). The
// published runs use redraft with --completions 2 (the default here before
// 2026-11-19), so pass it to compare with them.
const COMPS = args.completions ? parseInt(args.completions, 10) : undefined;
const METHOD = args.method || 'redraft';
const format = { ...Rec.PRESETS[preset] };
// --objective pfinal drops the preset's payout ladder, so the recommender ranks
// by P(final) instead of EV (recommend() switches on payouts.length). Added to
// test whether dk-20's top-3-only ladder is what made it worse than ADP.
if (args.objective === 'pfinal') format.payouts = [];

const file = JSON.parse(fs.readFileSync(path.join(DATA, `${season}.json`)));
const ctx = Sim.build(file.bracket, file.players);
const P = ctx.players.length, R = Sim.ROUNDS.length;

// The real postseason as a one-world `worlds`, so every scoring function applies.
const real = { n: 1, R, P, scores: new Float32Array(R * P), brackets: [] };
ctx.players.forEach((p, i) => {
  const a = file.actual[p.gsis_id] || {};
  Sim.ROUNDS.forEach((rnd, r) => { if (a[rnd] !== undefined) real.scores[r * P + i] = a[rnd]; });
});

const t0 = Date.now();
const worlds = Sim.simulateWorlds(ctx, N, 1);
const { adp } = Sim.syntheticAdp(ctx, worlds);
// --room-share X: that share of the five bot seats (and of the later pods) are
// stackers (Sim.roomStyles); --model-share Y: the room the recommender assumes.
// Both default to 0, the ADP-only room every earlier run used (the user,
// 2026-11-25: "some will stack in a smart way and others will draft off ADP").
const ROOM = parseFloat(args['room-share'] || '0'), MODEL = parseFloat(args['model-share'] || '0');
const model = MODEL ? { share: MODEL } : undefined;
const field = Rec.buildField(ctx, worlds, adp, format, { room: model });
const realField = Rec.buildField(ctx, real, adp, format, { seed: 4242, room: ROOM ? { share: ROOM } : undefined });
// --rule conf|wc|both|qb1|qb2: the user's roster rules (Rec.rosterRule), judged on what the
// drafter knew (the simulated worlds), scored on what happened.
const RULE = args.rule || 'none';
const WC = Rec.wcPlay(ctx, worlds);
let ruleFallbacks = 0;

const rows = [];
// --from N starts at draft N, so a second batch adds new drafts instead of repeating seeds.
const FROM = parseInt(args.from || '0', 10);
for (let d = FROM; d < FROM + DRAFTS; d++) {
  const mySeat = d % 6;
  const rng = Sim.mulberry32(season * 100 + d);
  const styles = ROOM ? Sim.roomStyles(6, ROOM, Sim.mulberry32(season * 100 + d + 777), mySeat) : null;
  const rosters = Array.from({ length: 6 }, () => []);
  const taken = [];
  for (let pick = 1; pick <= 6 * format.rounds; pick++) {
    const s = Rec.seatOfPick(pick, 6);
    let choice;
    if (s === mySeat) {
      const allow = Rec.rosterRule(RULE, ctx, format, WC, rosters[mySeat]);
      const out = Rec.recommend(ctx, worlds, adp, field, format, { mySeat, rosters, taken, nextPick: pick },
        { candidates: CANDS, completions: COMPS, method: METHOD, allow, room: model });
      // A rule that leaves no candidate falls back to the unruled pick (counted).
      if (out.results.length) choice = out.results[0].idx;
      else { ruleFallbacks++; choice = Rec.recommend(ctx, worlds, adp, field, format, { mySeat, rosters, taken, nextPick: pick },
        { candidates: CANDS, completions: COMPS, method: METHOD, room: model }).results[0].idx; }
    } else {
      const one = Rec.completeBoard(ctx, adp, rosters, taken, pick, { ...format, rounds: Math.ceil(pick / 6) }, rng, 6, undefined, styles);
      choice = one[s][rosters[s].length];
    }
    rosters[s].push(choice);
    taken.push(choice);
  }
  const sc = rosters.map(r => Sim.rosterScores(ctx, r, real, format.lineup));
  for (let s = 0; s < 6; s++) {
    const v = Rec.contestValue(sc[s], sc.filter((_, k) => k !== s), realField, real, format);
    const teams = {};
    for (const i of rosters[s]) teams[ctx.players[i].team] = (teams[ctx.players[i].team] || 0) + 1;
    const conf = {}; let wcExp = 0;
    for (const i of rosters[s]) { conf[ctx.conf[ctx.players[i].team]] = (conf[ctx.conf[ctx.players[i].team]] || 0) + 1; wcExp += WC[i]; }
    const qbs = rosters[s].filter(i => ctx.players[i].pos === 'QB').length;
    rows.push({ draft: d, seat: s, rec: s === mySeat, pR: v.pR, pFinal: v.pFinal, ev: v.ev, conf, wcExp,
      wc: sc[s][0], teams, qbs });
  }
}
const mean = (xs, f) => xs.reduce((a, x) => a + f(x), 0) / xs.length;
const rec = rows.filter(r => r.rec), bot = rows.filter(r => !r.rec);
const out = {
  season, preset, objective: format.payouts.length ? 'ev' : 'pfinal', method: METHOD, rule: RULE, ruleFallbacks, drafts: DRAFTS, champion: file.champion, ms: Date.now() - t0,
  rec: { pR1: mean(rec, r => r.pR[0]), pR2: mean(rec, r => r.pR[1]), pFinal: mean(rec, r => r.pFinal), ev: mean(rec, r => r.ev) },
  bot: { pR1: mean(bot, r => r.pR[0]), pR2: mean(bot, r => r.pR[1]), pFinal: mean(bot, r => r.pFinal), ev: mean(bot, r => r.ev) },
  // Per-draft values, so two runs on the same seeds can be compared draft by draft.
  recRows: rec.map(r => ({ draft: r.draft, pR1: r.pR[0], pR2: r.pR[1], pFinal: r.pFinal, conf: r.conf, wcExp: r.wcExp, qbs: r.qbs })),
  botRows: bot.map(r => ({ draft: r.draft, pR1: r.pR[0], pR2: r.pR[1], pFinal: r.pFinal, qbs: r.qbs })),
  recTeams: rec.map(r => Object.entries(r.teams).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, k]) => `${t}${k}`).join(' ')),
};
const line = `${season} ${preset} champ ${out.champion}: rec P(R1) ${out.rec.pR1.toFixed(3)} P(final) ${out.rec.pFinal.toFixed(5)} | ADP P(R1) ${out.bot.pR1.toFixed(3)} P(final) ${out.bot.pFinal.toFixed(5)} | rec stacks ${out.recTeams.join(', ')}`;
console.log(line);
if (args.out) fs.writeFileSync(args.out, JSON.stringify(out));
