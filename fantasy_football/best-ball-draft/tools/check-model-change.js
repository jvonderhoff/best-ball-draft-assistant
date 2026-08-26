#!/usr/bin/env node
/**
 * Score every player before and after a change to the recommender, on REAL boards.
 *
 * Three failures in one week shipped because the change was verified on the half of
 * the problem I was thinking about. Each is a rule here:
 *
 *   * **Score the WHOLE pool, and confirm only the intended players moved.** Making V1
 *     read `avail` looked right until this diff showed it moving all 443 players —
 *     the injury prior (QB 0.88, RB 0.82) was quietly re-weighting every position.
 *     Narrowed to `avail === 0`, and 441 of 443 went back to identical.
 *   * **Use a real board, not an empty roster.** The sigma regression was invisible at
 *     pick 190 with nobody rostered, because neither the stack nor the reach term
 *     fires there. It was obvious at pick 133 with eleven players. Empty-roster
 *     testing is why it shipped.
 *   * **Score V1 too.** V1 is the PRIMARY column. An injury fix that reaches only V2's
 *     inputs has not fixed the recommendation.
 *
 * Compares the WORKING TREE against any git ref, using the committed pool and the
 * local payload mirror, so it is deterministic and needs no network.
 *
 *   node tools/check-model-change.js                 # vs HEAD
 *   node tools/check-model-change.js --base f3d779f  # vs any ref
 *   node tools/check-model-change.js --top 40        # list more movers
 */
const fs = require('fs');
const cp = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['static/recommender-v2.js', 'static/recommender.js'];

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = arg('--base', 'HEAD');
const TOP  = parseInt(arg('--top', '12'), 10);

const atRef = f => {
  try { return cp.execSync(`git -C ${ROOT} show ${BASE}:./${f}`, {encoding: 'utf8', stdio:['pipe','pipe','pipe']}); }
  catch { return null; }
};
const now = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Both recommenders are loaded into one scope, because V1 reads `_eff`, which the V2
// annotate pass attaches. Scoring them from separate scopes would silently give V1 a
// pool with no `_eff` at all and report "V1 unaffected" for every change.
function load(v2src, v1src) {
  return new Function(v2src + '\n' + v1src + `
    return { v2AttachEffective, buildV2Context, calculateValueV2, calculateValue };`)();
}

const pool = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/player_cache.json'), 'utf8'));
const payload = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/data/pushed_payload.json'), 'utf8'));
const projMap = Object.fromEntries((payload.players || []).map(p => [p.id, p]));

// Real boards, sampled at several depths. Late picks with a full roster are where the
// stack, correlation and reach terms actually bite — see the sigma note above.
function scenarios() {
  const sq = `SELECT d.id, d.num_teams, d.my_position FROM drafts d
              JOIN draft_picks p ON p.draft_id = d.id
              GROUP BY d.id HAVING COUNT(*) > 200 ORDER BY d.id LIMIT 3`;
  const rows = cp.execSync(`sqlite3 -json "${path.join(ROOT,'drafts.db')}" "${sq}"`, {encoding:'utf8'});
  const drafts = JSON.parse(rows || '[]');
  const out = [];
  for (const d of drafts) {
    const picks = JSON.parse(cp.execSync(
      `sqlite3 -json "${path.join(ROOT,'drafts.db')}" ` +
      `"SELECT player_name, pick_number FROM draft_picks WHERE draft_id=${d.id} ORDER BY pick_number"`,
      {encoding:'utf8'}) || '[]');
    for (const pick of [37, 85, 133, 181]) out.push({ d, picks, pick });
  }
  return out;
}

function board(sc, players) {
  const teams = sc.d.num_teams || 12, mypos = sc.d.my_position || 1;
  const seat = n => { const r = Math.ceil(n/teams), i = (n-1)%teams;
                      return r % 2 === 1 ? i+1 : teams - i; };
  const byName = new Map(players.map(p => [p.name, p]));
  const taken = new Set(), myTeam = [];
  for (const pk of sc.picks) {
    if (pk.pick_number >= sc.pick) break;
    const p = byName.get(pk.player_name);
    if (!p) continue;
    taken.add(p.id);
    if (seat(pk.pick_number) === mypos) myTeam.push(p);
  }
  return { available: players.filter(p => !taken.has(p.id)), myTeam };
}

function scoreAll(M, sc) {
  const players = pool.players.map(p => ({...p}));
  M.v2AttachEffective(players, projMap);
  const { available, myTeam } = board(sc, players);
  const ctx = M.buildV2Context(available, myTeam, sc.pick, sc.pick + 12, null, players);
  const out = new Map();
  for (const p of available) {
    out.set(p.id, {
      name: p.name, pos: p.pos, ppg: p._eff ? p._eff.mean : null,
      v2: p._eff ? M.calculateValueV2(p, sc.pick, myTeam, sc.pick+12, available, null, ctx) : null,
      v1: M.calculateValue(p, sc.pick, myTeam, 'medium', sc.pick+12, available, null),
    });
  }
  return { out, n: available.length, roster: myTeam.length };
}

const beforeSrc = FILES.map(atRef);
if (beforeSrc.some(x => x === null)) { console.error(`cannot read ${FILES} at ${BASE}`); process.exit(2); }
const A = load(beforeSrc[0], beforeSrc[1]);
const B = load(now(FILES[0]), now(FILES[1]));

const changed = FILES.filter((f, i) => beforeSrc[i] !== now(f));
console.log(`base ${BASE} -> working tree`);
console.log(`changed: ${changed.length ? changed.join(', ') : 'nothing'}\n`);

let anyMoved = false;
for (const sc of scenarios()) {
  const a = scoreAll(A, sc), b = scoreAll(B, sc);
  for (const model of ['v1', 'v2']) {
    const moved = [];
    let same = 0;
    for (const [id, x] of a.out) {
      const y = b.out.get(id); if (!y) continue;
      if (x[model] == null && y[model] == null) { same++; continue; }
      const d = (y[model] ?? 0) - (x[model] ?? 0);
      if (Math.abs(d) > 0.0005) moved.push({...x, from: x[model], to: y[model], d});
      else same++;
    }
    if (!moved.length) { console.log(`  draft ${sc.d.id} pick ${String(sc.pick).padStart(3)} · ${model.toUpperCase()}  ${same} scored, none moved`); continue; }
    anyMoved = true;
    moved.sort((p, q) => Math.abs(q.d) - Math.abs(p.d));
    console.log(`  draft ${sc.d.id} pick ${String(sc.pick).padStart(3)} · ${model.toUpperCase()}  `
      + `${same} unchanged, ${moved.length} MOVED  (roster ${b.roster}, pool ${b.n})`);
    for (const m of moved.slice(0, TOP))
      console.log(`      ${String(m.pos).padEnd(3)} ${m.name.padEnd(21)} ppg ${String(m.ppg==null?'—':m.ppg.toFixed(1)).padStart(5)}`
        + `  ${Number(m.from).toFixed(2).padStart(8)} -> ${Number(m.to).toFixed(2).padStart(8)}  ${m.d>0?'+':''}${m.d.toFixed(2)}`);
    if (moved.length > TOP) console.log(`      … ${moved.length - TOP} more`);
  }
}
console.log(anyMoved
  ? '\nEvery mover above should be one you intended. If a change meant to affect\n'
    + 'injured players moved 400, it is re-weighting something else as well.'
  : '\nNo player moved in any scenario. If you expected a change, it did not take.');
