#!/usr/bin/env node
/* Check and measure static/recommender-playoff.js.
 *
 *   node tools/playoff-rec-check.js                       # checks + a short head-to-head
 *   node tools/playoff-rec-check.js --drafts 30 --preset dk-20
 *
 * 1. contestValue (computed later rounds) agrees with the simulator's sampled
 *    contestPath: an average roster gets 1/6, 1/36, 1/216.
 * 2. Speed: one recommendation must fit inside DK's 30-second pick clock with
 *    room to spare on a phone, so it is timed here on the Mac.
 * 3. Head-to-head, the only test that says it is worth using: one seat drafts by
 *    the recommender, five by ADP, and every roster is then scored on FRESH
 *    worlds (a different seed from the ones the recommender chose on) against a
 *    fresh field. The control is the ADP seats in the same rooms -- the V1-column
 *    discipline: they must come out ~1/216 each, or the experiment is broken.
 *
 * ADP is SYNTHETIC (expected postseason points) until DK's playoff pool exists,
 * so the bots are better informed than a real room. Read the result as "beats a
 * room that already knows the points", which is the harder version.
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
const DATA = args.data || path.join(__dirname, '..', '..', 'projections', 'data');
const N = parseInt(args.worlds || '2000', 10);
const DRAFTS = parseInt(args.drafts || '6', 10);
const format = { ...Rec.PRESETS[args.preset || 'dk-12'] };
const ctx = Sim.build(JSON.parse(fs.readFileSync(path.join(DATA, 'playoff_bracket.json'))),
  JSON.parse(fs.readFileSync(path.join(DATA, 'playoff_players.json'))));
console.log(`season ${ctx.season} (${ctx.seedsFinal ? 'final' : 'PROVISIONAL'} seeds), ${ctx.players.length} players, `
  + `${N} worlds, format ${args.preset || 'dk-12'} (${format.label}), ADP SYNTHETIC`);

let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); if (!ok) fails++; };

const worlds = Sim.simulateWorlds(ctx, N, 1);
const { adp } = Sim.syntheticAdp(ctx, worlds);
let t0 = Date.now();
const field = Rec.buildField(ctx, worlds, adp, format);
console.log(`field built in ${Date.now() - t0} ms (${field.boards} boards, ${field.S} survivors/world)`);

// ── 1. computed vs sampled ──────────────────────────────────────────────────
{
  const rng = Sim.mulberry32(77);
  const tot = [0, 0, 0];
  let m = 0;
  for (let b = 0; b < 30; b++) {
    const rs = Sim.botDraft(ctx, adp, { seats: 6, rounds: format.rounds, caps: field.caps }, rng);
    const sc = rs.map(r => Sim.rosterScores(ctx, r, worlds, format.lineup));
    for (let s = 0; s < 6; s++) {
      const v = Rec.contestValue(sc[s], sc.filter((_, k) => k !== s), field, worlds, format);
      v.pR.forEach((x, r) => { tot[r] += x; });
      m++;
    }
  }
  const got = tot.map(x => x / m), want = [1 / 6, 1 / 36, 1 / 216];
  // Round 3 gets 25%. Measured 2026-11-17, 20-round format: computed 0.00500 vs
  // the simulator's sampled 0.00507, and field rosters 0.00496 vs outside ones
  // 0.00500 -- the method agrees with itself both ways, so the residual ~8-20%
  // over 1/216 is a level shared by every candidate (a finite field, 30 boards
  // of roster noise here), not a ranking error. The pool bug this check caught
  // twice read +15-24% in rounds 2-3 together; round 2 stays at 15%.
  check('contestValue', got.every((x, r) => Math.abs(x / want[r] - 1) < (r === 2 ? 0.25 : 0.15)),
    `average roster ${got.map(x => x.toFixed(4)).join(' / ')} vs ${want.map(x => x.toFixed(4)).join(' / ')}`);
}

// ── 2. speed ────────────────────────────────────────────────────────────────
{
  for (const nextPick of [1, 31, 61]) {
    const rng = Sim.mulberry32(5);
    const rosters = Array.from({ length: 6 }, () => []);
    const taken = [];
    if (nextPick > 1) {
      const pre = Rec.completeBoard(ctx, adp, rosters, [], 1, { ...format, rounds: Math.ceil((nextPick - 1) / 6) }, rng, 6);
      // trim to exactly nextPick-1 picks in snake order
      let count = 0;
      const trimmed = Array.from({ length: 6 }, () => []);
      for (let p = 1; p < nextPick; p++) {
        const s = Rec.seatOfPick(p, 6), rd = Math.floor((p - 1) / 6);
        if (pre[s][rd] !== undefined) { trimmed[s].push(pre[s][rd]); taken.push(pre[s][rd]); count++; }
      }
      rosters.splice(0, 6, ...trimmed);
    }
    t0 = Date.now();
    const out = Rec.recommend(ctx, worlds, adp, field, format,
      { mySeat: Rec.seatOfPick(nextPick, 6), rosters, taken, nextPick });
    const ms = Date.now() - t0;
    const top = out.results.slice(0, 3).map(r => `${ctx.players[r.idx].name} ${(100 * r.pFinal).toFixed(2)}%`).join(', ');
    check(`speed @ pick ${nextPick}`, ms < 8000, `${ms} ms, top: ${top}`);
  }
}

// ── 3. head-to-head on fresh worlds ─────────────────────────────────────────
{
  const fresh = Sim.simulateWorlds(ctx, N, 999);
  const freshField = Rec.buildField(ctx, fresh, adp, format, { seed: 555 });
  const rec = { pR: [0, 0, 0] }, bot = { pR: [0, 0, 0] };
  let nb = 0;
  t0 = Date.now();
  for (let d = 0; d < DRAFTS; d++) {
    const mySeat = d % 6;
    const rng = Sim.mulberry32(300 + d);
    const rosters = Array.from({ length: 6 }, () => []);
    const taken = [];
    const total = 6 * format.rounds;
    for (let pick = 1; pick <= total; pick++) {
      const s = Rec.seatOfPick(pick, 6);
      let choice;
      if (s === mySeat) {
        choice = Rec.recommend(ctx, worlds, adp, field, format, { mySeat, rosters, taken, nextPick: pick },
          { candidates: 14, completions: 2 }).results[0].idx;
      } else {
        const one = Rec.completeBoard(ctx, adp, rosters, taken, pick, { ...format, rounds: Math.ceil(pick / 6) }, rng, 6);
        choice = one[s][rosters[s].length];
      }
      rosters[s].push(choice);
      taken.push(choice);
    }
    const sc = rosters.map(r => Sim.rosterScores(ctx, r, fresh, format.lineup));
    for (let s = 0; s < 6; s++) {
      const v = Rec.contestValue(sc[s], sc.filter((_, k) => k !== s), freshField, fresh, format);
      const into = s === mySeat ? rec : bot;
      v.pR.forEach((x, r) => { into.pR[r] += x; });
      if (s !== mySeat) nb++;
    }
    const teams = {};
    for (const i of rosters[mySeat]) teams[ctx.players[i].team] = (teams[ctx.players[i].team] || 0) + 1;
    console.log(`  draft ${d + 1} seat ${mySeat + 1}: ${Object.entries(teams).sort((a, b) => b[1] - a[1]).map(([t, k]) => `${t}${k}`).join(' ')}`);
  }
  const r = rec.pR.map(x => x / DRAFTS), b = bot.pR.map(x => x / nb);
  console.log(`head-to-head, ${DRAFTS} drafts, ${Date.now() - t0} ms, scored on fresh worlds:`);
  console.log(`  recommender  P(R1) ${r[0].toFixed(4)}  P(R2) ${r[1].toFixed(4)}  P(final) ${r[2].toFixed(5)}`);
  console.log(`  ADP seats    P(R1) ${b[0].toFixed(4)}  P(R2) ${b[1].toFixed(4)}  P(final) ${b[2].toFixed(5)}`);
  console.log(`  ratio P(final) recommender / ADP seat: ${(r[2] / b[2]).toFixed(2)}x  (1/216 = 0.00463)`);
}

console.log(fails ? `\n${fails} FAIL` : '\nall checks pass');
process.exit(fails ? 1 : 0);
