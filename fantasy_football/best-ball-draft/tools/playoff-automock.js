#!/usr/bin/env node
/* Auto-draft /playoff mocks headless: the page's own draft, many times, two ways.
 *
 *   node tools/playoff-automock.js --data DIR --from 0 --drafts 20 --out runs.jsonl
 *   node tools/playoff-automock.js --summary runs.jsonl [more.jsonl ...]
 *
 * Why: the user auto-drafted two mocks by hand on 2026-11-25 ("always take the top
 * recommendation") and at pick 1.05 the top row was Jaxon Smith-Njigba, whom the
 * page's own Next column gave a 100% chance to still be there at pick 8. The
 * recommender cannot see that: recommend() values each candidate as "take him now,
 * then every later pick -- MINE included -- by ADP" (completeBoard over all seats),
 * so "Allen now" is scored with an ADP-8 player at pick 8, never JSN at ADP 23.
 * The option of waiting is invisible to the ranking; Next is display only.
 *
 * Each draft runs twice on the same seat and the same bot randomness (each bot
 * pick is seeded by draft and pick number, so the two only diverge where my
 * picks make the board differ):
 *   top:  always the top row, as the page shows it at 24 simulated drafts;
 *   wait: when the top player would still be there at my next pick (>= WAIT_SURE,
 *         if I take an alternative now) and a ≈ row would probably NOT be
 *         (<= ALT_GONE, if I take the top now), take the best such ≈ row now.
 *         The next pick asks the recommender afresh: no promise to take the top.
 * Bots are the page's mock bots (completeBoard, ADP noise 6, synthetic ADP).
 * Rosters are scored on FRESH worlds (seed 999, field seed 555), as
 * tools/playoff-review.js does: the recommender's own worlds would flatter it.
 *
 * MEASURED 2026-11-25 (prod data pushed that morning, synthetic ADP, 20 drafts,
 * seeds 0-19, 10 processes, ~8 min a draft per rule): wait does NOT help.
 *   top:  round 1 33.3%, final 2.09% (bots 13.3%, 0.42%)
 *   wait: round 1 33.8%, final 1.99%
 *   paired wait - top: round 1 +0.5 pts (se 1.2), final -0.10 (se 0.09);
 *   better in 5 drafts, worse in 8, same in 7.
 * The rule fired on 40 of 240 picks; the passed-over top player was still there
 * at the next pick 39 times but the recommender took him only 21 times -- by then
 * someone else ranked higher, so "wait and get him" was not what happened. And
 * top-every-time took a player rated >= 90% to last on 86 of 220 picks, mostly
 * in rounds 6-11: a pick that "could have waited" is the normal case, not a bug,
 * because the ≈ rows are interchangeable to within the simulator's noise.
 *
 * What this cannot say: these are simulated postseasons and ADP bots blind to
 * byes. A rule that wins here still has to win on real postseasons
 * (tools/playoff-backtest.sh) before the page changes.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Sim = require(path.join(__dirname, '..', 'static', 'playoff-sim.js'));
const Rec = require(path.join(__dirname, '..', 'static', 'recommender-playoff.js'));

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const SEATS = 6, NOISE = 6;
const WAIT_SURE = parseFloat(opt('wait-sure', '0.9'));
const ALT_GONE = parseFloat(opt('alt-gone', '0.5'));
const M = parseInt(opt('completions', '24'), 10);

function summary(files) {
  const rows = files.flatMap(f => fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)));
  const by = {};
  for (const r of rows) (by[r.draft] = by[r.draft] || {})[r.policy] = r;
  const pairs = Object.values(by).filter(p => p.top && p.wait);
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const se = xs => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1) / xs.length); };
  const pct = (x, d = 1) => (100 * x).toFixed(d) + '%';
  console.log(`${pairs.length} drafts, each run both ways (same seat, same bot randomness)\n`);
  for (const pol of ['top', 'wait']) {
    const rs = pairs.map(p => p[pol]);
    console.log(`${pol.padEnd(5)} me: round 1 ${pct(mean(rs.map(r => r.me.pR1)))}  final ${pct(mean(rs.map(r => r.me.pFinal)), 2)}`
      + `   bots: round 1 ${pct(mean(rs.map(r => r.bots.pR1)))}  final ${pct(mean(rs.map(r => r.bots.pFinal)), 2)}`);
  }
  const d1 = pairs.map(p => p.wait.me.pR1 - p.top.me.pR1), dF = pairs.map(p => p.wait.me.pFinal - p.top.me.pFinal);
  console.log(`wait - top, paired: round 1 ${(100 * mean(d1)).toFixed(1)} pts (se ${(100 * se(d1)).toFixed(1)}), `
    + `final ${(100 * mean(dF)).toFixed(2)} pts (se ${(100 * se(dF)).toFixed(2)}); better in ${dF.filter(x => x > 0).length}, `
    + `worse in ${dF.filter(x => x < 0).length}, same in ${dF.filter(x => x === 0).length}`);
  const waits = pairs.flatMap(p => p.wait.picks.filter(k => k.waited));
  console.log(`\nwait rule fired on ${waits.length} of ${pairs.length * 12} picks; the top was there at the next pick ${waits.filter(k => k.topThereNext).length} times`
    + `, and taken then ${waits.filter(k => k.tookTopNext).length} times`);
  // What the 'top' drafts show on their own.
  const tp = pairs.flatMap(p => p.top.picks.filter(k => k.nextSurv != null));
  const sure = tp.filter(k => k.nextSurv >= WAIT_SURE);
  console.log(`\ntop-every-time: ${sure.length} of ${tp.length} picks (excluding last picks) took a player the tool gave >= ${pct(WAIT_SURE, 0)} to be there next time`);
  const byRd = {};
  for (const k of sure) byRd[k.round] = (byRd[k.round] || 0) + 1;
  console.log('  by round: ' + Object.entries(byRd).map(([r, n]) => `R${r} ${n}`).join(', '));
  const qbs = {};
  for (const p of pairs) qbs[p.top.qbs] = (qbs[p.top.qbs] || 0) + 1;
  console.log(`  QBs per roster: ${Object.entries(qbs).map(([k, n]) => `${k}: ${n}`).join(', ')}`);
  const stack = pairs.map(p => p.top.topTeam);
  console.log(`  biggest team stack: ${stack.map(s => s.team + s.n).join(' ')}`);
  console.log('\nper draft (seat, top final vs wait final, top roster teams):');
  for (const p of pairs) console.log(`  #${p.top.draft} seat ${p.top.seat + 1}: ${pct(p.top.me.pFinal, 2)} vs ${pct(p.wait.me.pFinal, 2)}  `
    + `R1 ${pct(p.top.me.pR1, 0)} vs ${pct(p.wait.me.pR1, 0)}  ${p.top.teams}`);
}

function main() {
  if (opt('summary')) return summary(argv.slice(argv.indexOf('--summary') + 1).filter(a => !a.startsWith('--')));
  const dir = opt('data');
  if (!dir) throw new Error('--data DIR (playoff_bracket.json + playoff_players.json) is required');
  const data = { bracket: JSON.parse(fs.readFileSync(path.join(dir, 'playoff_bracket.json'))),
    players: JSON.parse(fs.readFileSync(path.join(dir, 'playoff_players.json'))) };
  const from = parseInt(opt('from', '0'), 10), n = parseInt(opt('drafts', '1'), 10);
  const policies = (opt('policies', 'top,wait')).split(',');
  const out = opt('out');
  const ctx = Sim.build(data.bracket, data.players);
  const P = ctx.players;
  const format = { ...Rec.PRESETS[opt('preset', 'dk-12')] };
  const worlds = Sim.simulateWorlds(ctx, 2000, 1);              // the page's worlds
  const adp = Sim.syntheticAdp(ctx, worlds).adp;                  // the page's ADP without a DK pool
  const field = Rec.buildField(ctx, worlds, adp, format);
  const fresh = Sim.simulateWorlds(ctx, 2000, 999);
  const freshField = Rec.buildField(ctx, fresh, adp, format, { seed: 555 });
  const total = SEATS * format.rounds;

  for (let d = from; d < from + n; d++) {
    const me = Math.floor(Sim.mulberry32(77 + d)() * SEATS);
    for (const policy of policies) {
      const t0 = Date.now();
      const rosters = Array.from({ length: SEATS }, () => []);
      const taken = [];
      const log = [];
      for (let pick = 1; pick <= total; pick++) {
        const s = Rec.seatOfPick(pick, SEATS);
        let idx;
        if (s !== me) {
          const done = Rec.completeBoard(ctx, adp, rosters, taken, pick, format, Sim.mulberry32(d * 1000 + pick), NOISE, pick);
          idx = done[s][rosters[s].length];
          if (idx === undefined) continue;
        } else {
          const board = { mySeat: me, rosters: rosters.map(r => r.slice()), taken: taken.slice(), nextPick: pick };
          const res = Rec.recommend(ctx, worlds, adp, field, format, board, { completions: M, seed: 1000 }).results;
          const top = res[0];
          // The page's Next for the top row: if I take the second row now, is the top there next time?
          const svAlt = res[1] ? Rec.survival(ctx, adp, board, format, res[1].idx) : null;
          const nextSurv = svAlt ? svAlt.left[top.idx] : null;
          idx = top.idx;
          let waited = false, alt = null;
          if (policy === 'wait' && nextSurv != null && nextSurv >= WAIT_SURE) {
            const svTop = Rec.survival(ctx, adp, board, format, top.idx);
            for (const r of res.slice(1).filter(x => x.tie)) {
              const sv = Rec.survival(ctx, adp, board, format, r.idx);
              if (sv.left[top.idx] >= WAIT_SURE && svTop.left[r.idx] <= ALT_GONE) { alt = r; break; }
            }
            if (alt) { idx = alt.idx; waited = true; }
          }
          log.push({ pick, round: Math.ceil(pick / SEATS), took: P[idx].name, top: P[top.idx].name, topIdx: top.idx,
            nextSurv, waited, ties: res.filter(r => r.tie).length, value: (res.find(r => r.idx === idx) || {}).pFinal, topValue: top.pFinal });
        }
        rosters[s].push(idx);
        taken.push(idx);
      }
      // Did waiting work: was the top I passed on still there at my next pick, and did I take him?
      for (let k = 0; k < log.length; k++) {
        const w = log[k];
        if (!w.waited || !log[k + 1]) continue;
        w.topThereNext = !taken.slice(0, log[k + 1].pick - 1).includes(w.topIdx);
        w.tookTopNext = log[k + 1].took === P[w.topIdx].name;
      }
      const sc = rosters.map(r => Sim.rosterScores(ctx, r, fresh, format.lineup));
      const v = sc.map((x, k) => Rec.contestValue(x, sc.filter((_, j) => j !== k), freshField, fresh, format));
      const bots = v.filter((_, k) => k !== me);
      const tm = {};
      for (const i of rosters[me]) tm[P[i].team] = (tm[P[i].team] || 0) + 1;
      const top = Object.entries(tm).sort((a, b) => b[1] - a[1])[0];
      const rec = {
        draft: d, policy, seat: me, s: (Date.now() - t0) / 1000,
        me: { pR1: v[me].pR[0], pFinal: v[me].pFinal },
        bots: { pR1: bots.reduce((a, x) => a + x.pR[0], 0) / bots.length, pFinal: bots.reduce((a, x) => a + x.pFinal, 0) / bots.length },
        qbs: rosters[me].filter(i => P[i].pos === 'QB').length,
        topTeam: { team: top[0], n: top[1] },
        teams: Object.entries(tm).sort((a, b) => b[1] - a[1]).map(([t, k]) => t + k).join(' '),
        roster: rosters[me].map(i => `${P[i].pos} ${P[i].name} ${P[i].team}`),
        picks: log,
      };
      const line = JSON.stringify(rec);
      if (out) fs.appendFileSync(out, line + '\n'); else console.log(line);
      console.error(`draft ${d} ${policy} seat ${me + 1}: R1 ${(100 * rec.me.pR1).toFixed(1)}% final ${(100 * rec.me.pFinal).toFixed(2)}% (${rec.s.toFixed(0)} s)`);
    }
  }
}

main();
