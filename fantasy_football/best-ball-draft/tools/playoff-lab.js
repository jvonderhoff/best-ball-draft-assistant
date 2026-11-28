#!/usr/bin/env node
/* The playoff strategy lab: every arm on the same drafts, in one process, scored on
 * many fresh worlds. The successor to running tools/playoff-automock.js once per arm.
 *
 *   node tools/playoff-lab.js --data DIR --adp FILE --preset play-action \
 *     --arms control,stack:0.1,win:0.25 --from 500 --drafts 2 --out lab.jsonl
 *   node tools/playoff-lab.js --summary lab.jsonl [more.jsonl ...] [--control control]
 *
 * Shard with xargs (one process per draft or two; the Mac has 10 cores and is
 * already saturated at 10 processes, so more parallelism buys nothing):
 *   seq 500 519 | xargs -n 1 -P 10 -I{} node tools/playoff-lab.js ... --from {} --drafts 1 --out lab.jsonl
 *
 * Why it is faster than one automock run per arm (2026-11-27):
 *   1. recommend() is cached per board. Bots are seeded by draft and pick, and
 *      recommend() by a fixed seed, so two arms facing the same board get the same
 *      answer: arms only pay for picks after they diverge. Re-rank arms share the
 *      control's calls; arms that change recommend()'s inputs declare a `key`.
 *   2. No survival() calls: automock spends one per pick on the page's Next column,
 *      which no arm here reads.
 *   3. --score-worlds (default 10000, automock's 2000). Drafting is the slow part,
 *      scoring is cheap, and P(win the final) is rare enough that 2,000 worlds left
 *      it the noisiest number in every test so far.
 *
 * Rules (docs/PLAYOFF_LAB.md has the ledger and why each exists):
 *   - Every arm sees the same seat and bot randomness; read PAIRED differences.
 *   - Rosters are scored on FRESH worlds (seed 999, field 555), never the
 *     recommender's own (seed 1), which would flatter whichever arm agrees with it.
 *   - Each row records a stamp of the data it drafted on; --summary refuses to pair
 *     rows with different stamps (a data push mid-experiment moves every number).
 *   - Opponents are ADP bots (or --room-share stackers): compare arms, never quote
 *     a level as a real-world rate.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Sim = require(path.join(__dirname, '..', 'static', 'playoff-sim.js'));
const Rec = require(path.join(__dirname, '..', 'static', 'recommender-playoff.js'));
const ARMS = require('./playoff-lab-arms.js');

const SEATS = 6, NOISE = 6;          // the page's mock room, as in playoff-automock.js
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

function parseArms(text) {
  return text.split(',').map(s => s.trim()).filter(Boolean).map(name => {
    const [base, ...ps] = name.split(':');
    if (!ARMS[base]) throw new Error(`unknown arm "${base}" (have: ${Object.keys(ARMS).join(', ')})`);
    const spec = ARMS[base](...ps.map(Number));
    if ((spec.rec || spec.allow) && !spec.key) throw new Error(`arm ${name} changes recommend() inputs and needs a key`);
    return { name, ...spec, recKey: spec.key || 'default' };
  });
}

function main() {
  if (opt('summary') !== undefined || argv.includes('--summary')) return summary();
  const dir = opt('data');
  if (!dir) throw new Error('--data DIR (playoff_bracket.json + playoff_players.json) is required');
  const raw = { bracket: fs.readFileSync(path.join(dir, 'playoff_bracket.json')), players: fs.readFileSync(path.join(dir, 'playoff_players.json')) };
  const data = { bracket: JSON.parse(raw.bracket), players: JSON.parse(raw.players) };
  const adpFile = opt('adp');
  if (!adpFile) throw new Error('--adp FILE is required (DK real ADP; synthetic ADP is a room that drafts by the numbers)');
  const adpRaw = fs.readFileSync(adpFile);
  // The data stamp: what every number in this row rests on.
  const stamp = crypto.createHash('sha1').update(raw.bracket).update(raw.players).update(adpRaw).digest('hex').slice(0, 10);
  const arms = parseArms(opt('arms', 'control'));
  const from = parseInt(opt('from', '0'), 10), n = parseInt(opt('drafts', '1'), 10);
  const M = parseInt(opt('completions', '24'), 10);
  const roomShare = parseFloat(opt('room-share', '0'));
  const scoreWorlds = parseInt(opt('score-worlds', '10000'), 10);
  const out = opt('out');

  const ctx = Sim.build(data.bracket, data.players);
  const P = ctx.players;
  const format = { ...Rec.PRESETS[opt('preset', 'play-action')] };
  const worlds = Sim.simulateWorlds(ctx, 2000, 1);              // the page's worlds
  const adp = Sim.adpFromPool(ctx, JSON.parse(adpRaw));
  const field = Rec.buildField(ctx, worlds, adp, format);
  const fresh = Sim.simulateWorlds(ctx, scoreWorlds, 999);
  const freshField = Rec.buildField(ctx, fresh, adp, format, { seed: 555, room: roomShare ? { share: roomShare } : undefined });
  const total = SEATS * format.rounds;
  console.error(`lab: ${P.length} players, stamp ${stamp}, arms ${arms.map(a => a.name).join(' ')}, score worlds ${scoreWorlds}`);

  for (let d = from; d < from + n; d++) {
    const me = Math.floor(Sim.mulberry32(77 + d)() * SEATS);
    const styles = Sim.roomStyles(SEATS, roomShare, Sim.mulberry32(5000 + d), me);
    const cache = new Map();
    let calls = 0, hits = 0;
    const t0 = Date.now();
    for (const arm of arms) {
      const ta = Date.now();
      const rosters = Array.from({ length: SEATS }, () => []);
      const taken = [];
      const log = [];
      for (let pick = 1; pick <= total; pick++) {
        const s = Rec.seatOfPick(pick, SEATS);
        let idx;
        if (s !== me) {
          const done = Rec.completeBoard(ctx, adp, rosters, taken, pick, format, Sim.mulberry32(d * 1000 + pick), NOISE, pick, styles);
          idx = done[s][rosters[s].length];
          if (idx === undefined) continue;
        } else {
          const mine = {};
          for (const i of rosters[me]) mine[P[i].team] = (mine[P[i].team] || 0) + 1;
          const st = { ctx, P, adp, format, me, rosters, taken, pick, round: Math.ceil(pick / SEATS), mine };
          const key = arm.recKey + '|' + pick + '|' + rosters.map(r => r.join('.')).join('/');
          let res = cache.get(key);
          if (res) hits++;
          else {
            calls++;
            const board = { mySeat: me, rosters: rosters.map(r => r.slice()), taken: taken.slice(), nextPick: pick };
            const o = { completions: M, seed: 1000, ...(arm.rec || {}) };
            if (arm.allow) o.allow = i => arm.allow(i, st);
            res = Rec.recommend(ctx, worlds, adp, field, format, board, o).results;
            cache.set(key, res);
          }
          const ranked = arm.rank ? arm.rank(res, st) : res;
          idx = ranked[0].idx;
          log.push({ pick, round: st.round, took: P[idx].name, toolTop: P[res[0].idx].name, toolRank: res.findIndex(r => r.idx === idx) });
        }
        rosters[s].push(idx);
        taken.push(idx);
      }
      const sc = rosters.map(r => Sim.rosterScores(ctx, r, fresh, format.lineup));
      const v = sc.map((x, k) => Rec.contestValue(x, sc.filter((_, j) => j !== k), freshField, fresh, format));
      const bots = v.filter((_, k) => k !== me);
      const tm = {};
      for (const i of rosters[me]) tm[P[i].team] = (tm[P[i].team] || 0) + 1;
      const teams = Object.entries(tm).sort((a, b) => b[1] - a[1]);
      const mean = k => bots.reduce((a, x) => a + (k === 'pR1' ? x.pR[0] : x[k]), 0) / bots.length;
      const rec = {
        draft: d, arm: arm.name, seat: me, stamp, players: P.length, preset: opt('preset', 'play-action'), adp: path.basename(adpFile),
        roomShare, completions: M, scoreWorlds,
        me: { pR1: v[me].pR[0], pFinal: v[me].pFinal, pWin: v[me].pWin },
        bots: { pR1: mean('pR1'), pFinal: mean('pFinal'), pWin: mean('pWin') },
        topTeam: { team: teams[0][0], n: teams[0][1] }, nTeams: teams.length,
        qbs: rosters[me].filter(i => P[i].pos === 'QB').length,
        teams: teams.map(([t, k]) => t + k).join(' '),
        roster: rosters[me].map(i => ({ id: P[i].gsis_id || P[i].id, name: P[i].name, pos: P[i].pos, team: P[i].team })),
        picks: log, s: (Date.now() - ta) / 1000,
      };
      const line = JSON.stringify(rec);
      if (out) fs.appendFileSync(out, line + '\n'); else console.log(line);
      console.error(`draft ${d} ${arm.name} seat ${me + 1}: R1 ${(100 * rec.me.pR1).toFixed(1)}% final ${(100 * rec.me.pFinal).toFixed(2)}% win ${(100 * rec.me.pWin).toFixed(3)}% ${rec.teams} (${rec.s.toFixed(0)} s)`);
    }
    console.error(`draft ${d}: ${calls} recommend calls, ${hits} cached, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
}

function summary() {
  const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--control');
  const rows = files.flatMap(f => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));
  const control = opt('control', 'control');
  const stamps = [...new Set(rows.map(r => r.stamp))];
  if (stamps.length > 1) {
    console.log(`REFUSED: rows rest on ${stamps.length} different data stamps (${stamps.join(', ')}). A data push or ADP change landed mid-experiment; split the files by stamp.`);
    process.exitCode = 1;
    return;
  }
  const by = {};
  for (const r of rows) (by[r.draft] = by[r.draft] || {})[r.arm] = r;
  const arms = [...new Set(rows.map(r => r.arm))];
  if (!arms.includes(control)) throw new Error(`no "${control}" rows to pair against (arms: ${arms.join(', ')})`);
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const se = xs => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1) / xs.length); };
  const r0 = rows[0];
  console.log(`stamp ${r0.stamp}, ${r0.players} players, ${r0.preset}, ADP ${r0.adp}, room-share ${r0.roomShare}, score worlds ${r0.scoreWorlds}\n`);
  console.log('arm'.padEnd(16) + 'drafts  win group  reach final  win final  biggest stack  QBs');
  for (const a of arms) {
    const rs = Object.values(by).map(x => x[a]).filter(Boolean);
    console.log(a.padEnd(16) + String(rs.length).padStart(6) + `  ${(100 * mean(rs.map(r => r.me.pR1))).toFixed(1).padStart(8)}%  ${(100 * mean(rs.map(r => r.me.pFinal))).toFixed(2).padStart(10)}%  ${(100 * mean(rs.map(r => r.me.pWin))).toFixed(3).padStart(8)}%  ${mean(rs.map(r => r.topTeam.n)).toFixed(1).padStart(13)}  ${mean(rs.map(r => r.qbs)).toFixed(1).padStart(3)}`);
  }
  console.log(`\npaired against ${control} (difference in percentage points, se; better/worse/same drafts):`);
  for (const a of arms.filter(x => x !== control)) {
    const ps = Object.values(by).filter(x => x[a] && x[control]);
    const line = ['pR1', 'pFinal', 'pWin'].map(k => {
      const d = ps.map(x => x[a].me[k] - x[control].me[k]);
      const dp = k === 'pWin' ? 3 : 2;
      return `${k} ${(100 * mean(d)).toFixed(dp)} (se ${(100 * se(d)).toFixed(dp)}) ${d.filter(x => x > 0).length}/${d.filter(x => x < 0).length}/${d.filter(x => x === 0).length}`;
    }).join('   ');
    const differ = mean(ps.map(x => x[a].picks.filter((p, i) => p.took !== (x[control].picks[i] || {}).took).length));
    console.log(`  ${a.padEnd(14)} n=${ps.length}  ${line}   picks differing ${differ.toFixed(1)}/12`);
  }
  console.log('\nA difference under 2 se is noise. Screen at 10 drafts, confirm survivors at 40+ on NEW seeds.');
}

main();
