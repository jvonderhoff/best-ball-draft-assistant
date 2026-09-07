#!/usr/bin/env node
/**
 * Score every live board with the REAL V1 recommender and print the ranked list.
 *
 * Reads one JSON blob (path in argv[2] — {pool, v2, rankings, boards, depth}) and
 * writes {draftId: {…, recs: […]}} to stdout. auto-queue.py owns the network on both
 * sides; this file owns nothing but the scoring, so what goes into a DK queue is the
 * same code that draws /recommend and nothing else.
 *
 * Two things here are load-bearing and both have already cost a session:
 *
 *   V1 and V2 must share ONE scope. V1 reads `_eff`, which the V2 annotate pass
 *   attaches; evaluated separately, V1 silently gets a pool with no `_eff`.
 *   (check-model-change.js does the same thing for the same reason.)
 *
 *   Pool ids are `dk_42775003`; live picks carry the bare `42775003`. Matching the
 *   raw strings gives ZERO overlap, every drafted player reads as available, and the
 *   recommender happily returns Gibbs at pick 209.
 */
const fs = require('fs'), path = require('path');
const ROOT = path.dirname(__dirname);

const v2src = fs.readFileSync(path.join(ROOT, 'static/recommender-v2.js'), 'utf8');
const v1src = fs.readFileSync(path.join(ROOT, 'static/recommender.js'), 'utf8');
const M = new Function(v2src + '\n' + v1src + `
  return { v2AttachEffective, getTopRecommendations, nextMyOverallPick, isMyTurn,
           getTeamNeeds, DEFAULT_STACK_INTENSITY };`)();

const IN       = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const pool     = IN.pool;
const v2       = IN.v2;
const rankings = IN.rankings;
const boards   = IN.boards;
const DEPTH    = IN.depth || 6;
const TOTAL_ROUNDS = 20;

// ★ ON — the custom board is the user's opinion and the app defaults to it.
// Mirrors loadCustomRankings() + applyCustomRanks() in templates/recommend.html.
const customRankMap = {};
for (const p of rankings) if (p.custom_rank != null) customRankMap[p.player_id] = p.custom_rank;

const v2Map = {};
(v2.players || []).forEach(p => { if (p.id) v2Map[p.id] = p; });

function applyCustomRanks(players) {
  return players.map(p => {
    const cr = customRankMap[p.id];
    return cr != null ? { ...p, adp: cr, realAdp: p.adp } : { ...p, realAdp: p.adp };
  });
}

function myPickNumbers(pos, teams) {
  const out = [];
  for (let r = 1; r <= TOTAL_ROUNDS; r++)
    out.push((r - 1) * teams + (r % 2 === 1 ? pos : teams - pos + 1));
  return out;
}

const results = {};
for (const [did, b] of Object.entries(boards)) {
  const teams = b.num_teams, myPos = b.my_position, picks = b.picks || [];
  if (!picks.length || !teams || !myPos) { results[did] = { error: 'incomplete board' }; continue; }

  const byId   = Object.fromEntries(pool.map(p => [String(p.id), p]));
  const byName = Object.fromEntries(pool.map(p => [p.name, p]));
  // Name is the documented fallback (recommend.html:1219): DK reissues draftable ids
  // per slate, so an id on a live pick can be absent from the pool.
  const resolve = pk => byId[`dk_${pk.draftable_id}`] || byId[String(pk.draftable_id)]
                     || byName[pk.player_name] || null;

  const unmatched = [], takenIds = new Set();
  for (const pk of picks) {
    const pl = resolve(pk);
    if (!pl) { unmatched.push(`${pk.player_name} (${pk.pos} ${pk.team}, #${pk.pick_number})`); continue; }
    takenIds.add(String(pl.id));
  }

  const mineNums = new Set(myPickNumbers(myPos, teams));
  // myTeam must be POOL objects (pos/team/adp), not the thin pick records.
  const myTeam = picks.filter(p => mineNums.has(p.pick_number))
    .sort((a, c) => a.pick_number - c.pick_number)
    .map(p => resolve(p) || { id: `dk_${p.draftable_id}`, name: p.player_name,
                              pos: p.pos, team: p.team, adp: 999 });

  // Fresh copies per draft so `_eff` from one board cannot leak into the next.
  const players = pool.map(p => ({ ...p }));
  players.forEach(p => { if (p.realAdp == null) p.realAdp = p.adp; });
  M.v2AttachEffective(players, v2Map, { customRankMap });

  const available = applyCustomRanks(players.filter(p => !takenIds.has(String(p.id))));

  const overall     = b.overall_pick;
  const myTurn      = M.isMyTurn(overall, teams, myPos);
  const pickForRec  = myTurn ? overall : (M.nextMyOverallPick(overall, teams, myPos) || overall);
  const nextMyPick  = M.nextMyOverallPick(pickForRec + 1, teams, myPos);
  const recs = M.getTopRecommendations(available, myTeam, pickForRec,
                                       M.DEFAULT_STACK_INTENSITY, DEPTH * 4, nextMyPick);

  const cnt = {}; myTeam.forEach(p => cnt[p.pos] = (cnt[p.pos] || 0) + 1);
  results[did] = {
    teams, myPos, overall, pickForRec, nextMyPick, myTurn, unmatched,
    made: myTeam.length, remaining: TOTAL_ROUNDS - myTeam.length,
    roster: cnt, needs: M.getTeamNeeds(myTeam),
    upcoming: [...mineNums].filter(n => n >= overall).sort((a, c) => a - c),
    recs: recs.map(r => ({
      id: String(r.id ?? r.player?.id), name: r.name ?? r.player?.name,
      pos: r.pos ?? r.player?.pos, team: r.team ?? r.player?.team,
      adp: r.adp ?? r.player?.adp, realAdp: r.realAdp ?? r.player?.realAdp,
      value: r.value ?? r.score, reason: r.reason,
    })),
  };
}
process.stdout.write(JSON.stringify(results));
