#!/usr/bin/env node
/* DK's real playoff ADP, pulled from the draft app and set against the synthetic
 * ADP every playoff tool drafts with by default.
 *
 *   node tools/playoff-adp.js --list                 # what the app has saved
 *   node tools/playoff-adp.js                        # newest saved pool: save + compare
 *   node tools/playoff-adp.js --dg 12345 --day 2026-11-24
 *   node tools/playoff-adp.js --file tools/.playoff-adp/12345-2026-11-24.json   # compare only
 *   (--url http://localhost:8000 for a local app; default is production)
 *
 * Why: DK refuses the server (Akamai 403), so DK's pool arrives only through the
 * bookmarklet, which saves it (app/playoff_store.save_pool) since 2026-11-23.
 * Before that the mocks, tools/playoff-rec-check.js and the backtests all drafted
 * against SYNTHETIC ADP -- players ordered by expected postseason points, bots
 * that know the points and are blind to how a real room drafts. The 2026-11-20
 * Legendary Upside stream describes a room nothing like it (Mahomes in round 2-3,
 * Jefferson in round 3, the first Bear in round 3-4, LaPorta around 38), and the
 * synthetic order puts Josh Allen 1st and Purdy 3rd.
 *
 * The file it writes (tools/.playoff-adp/<dg>-<day>.json, gitignored) is what
 * `playoff-rec-check.js --adp` reads. What it prints: per-position counts (a
 * scraper that returns one position reads as a working one -- bug class 4), the
 * rank correlation, where the room disagrees with points by position and by bye
 * odds (does the room already price a round-1 zero?), and the biggest movers.
 * The past-postseason backtest cannot use this file: its players are 2016-25's.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Sim = require(path.join(__dirname, '..', 'static', 'playoff-sim.js'));

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, xs) => {
  if (a.startsWith('--')) acc.push([a.slice(2), xs[i + 1] && !xs[i + 1].startsWith('--') ? xs[i + 1] : true]);
  return acc;
}, []));
const URL_ = (args.url || 'https://best-ball-draft-assistant.onrender.com').replace(/\/$/, '');
const DATA = args.data || path.join(__dirname, '..', '..', 'projections', 'data');
const OUT = path.join(__dirname, '.playoff-adp');

async function getJson(u) {
  const r = await fetch(u);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${u}: HTTP ${r.status} ${d.error || ''}`);
  return d;
}

(async () => {
  if (args.list) {
    const d = await getJson(`${URL_}/api/playoff/pools`);
    if (!d.pools || !d.pools.length) { console.log('No saved pools. Click the BBA bookmark in a DK playoff draft room once.'); return; }
    for (const p of d.pools) {
      console.log(`draft group ${p.draft_group}  ${p.day}  ${p.players} players  saved ${((Date.now() / 1000 - p.fetched_at) / 3600).toFixed(1)}h ago`);
    }
    return;
  }
  let pool, file;
  if (args.file) {
    file = args.file;
    pool = JSON.parse(fs.readFileSync(file));
  } else {
    const q = [args.dg && `dg=${args.dg}`, args.day && `day=${args.day}`].filter(Boolean).join('&');
    pool = await getJson(q ? `${URL_}/api/playoff/pools?${q}` : `${URL_}/api/playoff/pool`);
    const day = pool.saved_day || new Date(pool.fetched_at * 1000).toISOString().slice(0, 10);
    fs.mkdirSync(OUT, { recursive: true });
    file = path.join(OUT, `${pool.draft_group_id}-${day}.json`);
    fs.writeFileSync(file, JSON.stringify(pool));
    console.log(`saved ${file}`);
  }
  const age = pool.fetched_at ? ((Date.now() / 1000 - pool.fetched_at) / 3600).toFixed(1) + 'h old' : 'age unknown';
  console.log(`DK draft group ${pool.draft_group_id}, ${pool.saved_day || ''} (${age}): ${pool.players.length} joined, `
    + `${(pool.unmatched || []).length} DK skill players not in the export`);

  // Per-position sanity check before anything else is believed.
  const byPos = {};
  for (const r of pool.players) byPos[r.pos] = (byPos[r.pos] || 0) + 1;
  const missing = ['QB', 'RB', 'WR', 'TE'].filter(p => !byPos[p]);
  console.log(`by position: ${['QB', 'RB', 'WR', 'TE'].map(p => `${p} ${byPos[p] || 0}`).join(' · ')}`
    + (missing.length ? `  FAIL: no ${missing.join(', ')}` : ''));
  const withAdp = pool.players.filter(r => r.adp && r.adp < 9999).length;
  console.log(`${withAdp} of ${pool.players.length} carry an ADP`
    + (withAdp < 50 ? '  FAIL: too few to be DK\'s real ADP (placeholder 9999s?)' : ''));
  if (missing.length || withAdp < 50) process.exitCode = 1;

  const ctx = Sim.build(JSON.parse(fs.readFileSync(path.join(DATA, 'playoff_bracket.json'))),
    JSON.parse(fs.readFileSync(path.join(DATA, 'playoff_players.json'))));
  const worlds = Sim.simulateWorlds(ctx, 2000, 1);
  const syn = Sim.syntheticAdp(ctx, worlds).adp;
  const dk = Sim.adpFromPool(ctx, pool, { undrafted: false });   // real ADP only, for the comparison
  const odds = JSON.parse(fs.readFileSync(path.join(DATA, 'playoff_bracket.json'))).odds || {};
  console.log(`inputs: season ${ctx.season}, ${ctx.players.length} players in the export; DK ADP for ${dk.filter(x => x > 0).length}`);

  // Ranks within the players both lists have, so the two scales agree.
  const both = ctx.players.map((p, i) => i).filter(i => dk[i] > 0 && syn[i] > 0);
  const rank = key => { const o = both.slice().sort((a, b) => key[a] - key[b]); const r = new Map(); o.forEach((i, k) => r.set(i, k + 1)); return r; };
  const rd = rank(dk), rs = rank(syn);
  const n = both.length;
  let d2 = 0;
  for (const i of both) d2 += (rd.get(i) - rs.get(i)) ** 2;
  const rho = 1 - 6 * d2 / (n * (n * n - 1));
  const top = both.filter(i => rd.get(i) <= 72);              // the 72 a 12-round, 6-seat room drafts
  console.log(`\nSpearman rank correlation, DK vs synthetic: ${rho.toFixed(2)} over ${n} players`);
  console.log(`DK's top 72 that synthetic also has in its top 72: ${top.filter(i => rs.get(i) <= 72).length}`);

  // Positive = the room takes them LATER than points alone would.
  const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
  console.log('\nDK rank minus synthetic rank, mean over DK\'s top 72 (positive = room drafts later than points say):');
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const xs = top.filter(i => ctx.players[i].pos === pos).map(i => rd.get(i) - rs.get(i));
    console.log(`  ${pos}: ${mean(xs).toFixed(1)} (${xs.length} players)`);
  }
  const byeHi = top.filter(i => (odds[ctx.players[i].team] || {}).bye >= 0.3).map(i => rd.get(i) - rs.get(i));
  const byeLo = top.filter(i => (odds[ctx.players[i].team] || {}).bye < 0.3).map(i => rd.get(i) - rs.get(i));
  console.log(`  teams with bye odds >= 30%: ${mean(byeHi).toFixed(1)} (${byeHi.length}) · under 30%: ${mean(byeLo).toFixed(1)} (${byeLo.length})`);
  console.log('  (synthetic ADP counts a bye team\'s round-1 zero only through expected points, so a gap here is the room pricing byes differently)');

  const row = i => { const p = ctx.players[i], o = odds[p.team] || {};
    return `${p.name.padEnd(24)} ${p.pos} ${p.team.padEnd(3)} DK ${dk[i].toFixed(1).padStart(5)} (rank ${String(rd.get(i)).padStart(3)})  synthetic rank ${String(rs.get(i)).padStart(3)}  make ${Math.round((o.make || 0) * 100)}% bye ${Math.round((o.bye || 0) * 100)}%`; };
  const moved = both.filter(i => rd.get(i) <= 100 || rs.get(i) <= 100).sort((a, b) => (rd.get(a) - rs.get(a)) - (rd.get(b) - rs.get(b)));
  console.log('\nRoom drafts EARLIER than points say:');
  moved.slice(0, 12).forEach(i => console.log('  ' + row(i)));
  console.log('Room drafts LATER than points say:');
  moved.slice(-12).reverse().forEach(i => console.log('  ' + row(i)));
  console.log(`\nNext: node tools/playoff-rec-check.js --adp ${path.relative(process.cwd(), file)} --drafts 30`);
})().catch(e => { console.error(String(e.message || e)); process.exit(2); });
