#!/usr/bin/env node
// Dump V2's board at a given pick with full score breakdowns, plus a solo draft trace.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const V2 = require(path.join(ROOT, 'static', 'recommender-v2.js'));

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/player_cache.json'), 'utf8'));
const pj  = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/projection_cache.json'), 'utf8'));
const projMap = Object.fromEntries(pj.players.filter(p => p.id).map(p => [p.id, p]));

let players = (Array.isArray(raw) ? raw : raw.players)
  .filter(p => ['QB','RB','WR','TE'].includes(p.pos)).map(p => ({ ...p, realAdp: p.adp }));
V2.v2AttachEffective(players, projMap, {});
players = players.filter(p => p._eff).sort((a,b) => a.adp - b.adp);

// Solo snake draft from slot 5, ADP bots elsewhere, tracing my picks.
const NUM = 12, ROUNDS = 20, SLOT = 4;
const pool = players.slice();
const myTeam = [];
const remainingFor = (from) => {
  const out = [];
  for (let p = from; p <= NUM*ROUNDS; p++) {
    const r = Math.floor((p-1)/NUM), i = (p-1)%NUM;
    if ((r%2===0 ? i : NUM-1-i) === SLOT) out.push(p);
  }
  return out;
};
const nextFor = (from) => remainingFor(from)[0] ?? null;

for (let pick = 1; pick <= NUM*ROUNDS; pick++) {
  const r = Math.floor((pick-1)/NUM), i = (pick-1)%NUM;
  const slot = r%2===0 ? i : NUM-1-i;
  let chosen;
  if (slot === SLOT) {
    const recs = V2.getTopRecommendationsV2(pool, myTeam, pick, 6, nextFor(pick+1), remainingFor(pick+1));
    console.log(`\n── Round ${r+1}, pick ${pick} ── roster: ` +
      ['QB','RB','WR','TE'].map(p => `${p}${myTeam.filter(m=>m.pos===p).length}`).join(' '));
    for (const rec of recs) {
      const e = rec.player._eff;
      console.log(`  ${rec.value.toFixed(3).padStart(8)}  ${rec.player.pos} ${rec.player.name.padEnd(22)} adp ${String(rec.player.adp).padStart(6)} ppg ${e.mean.toFixed(1).padStart(5)} sd ${e.sd.toFixed(1).padStart(5)}`);
      for (const b of rec.bd) console.log(`              ${b.points >= 0 ? '+' : ''}${b.points.toFixed(3).padStart(7)}  ${b.label}  — ${b.note || ''}`);
    }
    chosen = recs[0].player;
  } else {
    chosen = pool[0];
  }
  pool.splice(pool.indexOf(chosen), 1);
  if (slot === SLOT) myTeam.push({ ...chosen, round: r+1 });
}

console.log('\nFinal roster:');
for (const p of myTeam) console.log(`  R${String(p.round).padStart(2)} ${p.pos} ${p.name} (adp ${p.adp}, ppg ${p._eff.mean.toFixed(1)})`);
