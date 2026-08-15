#!/usr/bin/env node
/**
 * explain.js — why did V1 and V2 score this player the way they did?
 *
 *   node tools/explain.js --draft 193145794 --player "Jaydon Blue"
 *   node tools/explain.js --draft 193145794 --player Blue --board
 *   node tools/explain.js --draft 193145794 --player Blue --json | jq .v2
 *
 * This exists because answering "why isn't he recommended?" used to mean pasting
 * JavaScript into a browser console against a live draft page, which is both
 * awkward and unrepeatable — and on 2026-08-15 it produced two wrong answers
 * before it produced a right one (a ceiling-ordering proxy mistaken for V2's
 * actual ranking, and a localStorage flag read from the wrong browser).
 *
 * It loads `static/recommender.js` and `static/recommender-v2.js` VERBATIM — the
 * same files the browser runs — rather than reimplementing the scoring. That is
 * the whole point: a Python reimplementation on the server would have to track
 * two models that are actively changing, and would drift silently. Same reason
 * `compare-models.js` requires the real file instead of a copy.
 *
 * Why this is a CLI and not an HTTP endpoint: Render runs the app as
 * `runtime: python` with a pip-only build (render.yaml), so there is no Node in
 * production to execute either model. A prod endpoint would mean either adding a
 * second runtime to the deploy or reimplementing the models in Python. Neither is
 * worth it for a debugging tool.
 *
 * Data comes from the live host by default, so what you see is what the app sees.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');

const V1 = require(path.join(ROOT, 'static', 'recommender.js'));
const V2 = require(path.join(ROOT, 'static', 'recommender-v2.js'));

const DEFAULT_HOST = 'https://best-ball-draft-assistant.onrender.com';

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

if (has('help') || !arg('draft') || !arg('player')) {
  console.log(`
Usage: node tools/explain.js --draft <id> --player <name> [options]

  --draft   <id>     DK draft id (as in /recommend?draft=…)
  --player  <name>   full or partial name, case-insensitive
  --host    <url>    default ${DEFAULT_HOST}
  --state   <file>   read draft state from a saved JSON file instead of the host
                     (the /api/dk-draft-state payload; its cache is fed by the
                     bookmarklet and expires, so save one to debug later)
  --me      <name>   DK username, for tagging your own picks (default jvonderhoff)
  --pick    <n>      override the pick being scored (default: your next pick)
  --stack   <mode>   off | light | medium | heavy   (default: the app's default)
  --board            apply your custom rankings board
                     NOTE: the app defaults this OFF and stores it per-browser in
                     localStorage, so check the ☆/★ My Ranks button to see which
                     mode you were actually drafting in.
  --json             machine-readable output
`);
  process.exit(has('help') ? 0 : 1);
}

const HOST     = arg('host', DEFAULT_HOST).replace(/\/$/, '');
const DRAFT_ID = arg('draft');
const QUERY    = arg('player');
const USE_BOARD = has('board');
const AS_JSON  = has('json');
const STACK    = arg('stack', V1.DEFAULT_STACK_INTENSITY || 'medium');
const STATE_FILE = arg('state', null);
const ME       = (arg('me', 'jvonderhoff') || '').toLowerCase();

// ── fetch ─────────────────────────────────────────────────────────────────────
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return r.json();
}

// Mirrors findPlayerByName() in recommend.html: exact, then last-name+pos, then
// prefix either way. Kept deliberately identical so the tool resolves the same
// player the page would, including for the DK spellings names.py exists to absorb.
function findPlayer(players, query) {
  const lower = String(query).toLowerCase().trim();
  const exact = players.find(p => p.name.toLowerCase() === lower);
  if (exact) return exact;
  const pre = players.filter(p => {
    const k = p.name.toLowerCase();
    return k.startsWith(lower) || lower.startsWith(k);
  });
  if (pre.length === 1) return pre[0];
  const sub = players.filter(p => p.name.toLowerCase().includes(lower));
  if (sub.length === 1) return sub[0];
  if (sub.length > 1) {
    const e = new Error(`"${query}" is ambiguous: ${sub.map(p => p.name).join(', ')}`);
    e.ambiguous = true;
    throw e;
  }
  return pre[0] || null;
}

// Same substitution the page's applyCustomRanks() performs: your rank REPLACES
// adp and the market value moves to realAdp. Worth knowing that this is a
// substitution rather than an extra input — with the board on, everything
// downstream that reads `adp` is reading your opinion.
function applyBoard(players, rankMap, on) {
  return players.map(p => {
    const cr = rankMap[p.id];
    return (on && cr != null)
      ? { ...p, adp: cr, realAdp: p.adp }
      : { ...p, realAdp: p.realAdp != null ? p.realAdp : p.adp };
  });
}

function fmtMult(m) {
  const pct = (m - 1) * 100;
  return `${m >= 1 ? '+' : ''}${pct.toFixed(1)}%`;
}

(async () => {
  const [pool, projPayload, rankings, draft] = await Promise.all([
    getJSON(`${HOST}/api/players`),
    getJSON(`${HOST}/api/projections-v2`).catch(e => ({ players: [], _err: e.message })),
    getJSON(`${HOST}/api/rankings`).catch(() => []),
    STATE_FILE
      ? Promise.resolve(require(path.resolve(STATE_FILE)))
      : getJSON(`${HOST}/api/dk-draft-state/${DRAFT_ID}`),
  ]);

  // Refuse to score an empty board rather than quietly pretending it is pick 1.
  //
  // The draft-state cache is fed by the DK bookmarklet and expires; the endpoint
  // then returns `needs_bookmarklet` with zero picks and HTTP 200. Scoring that
  // silently is not a smaller failure than erroring — it produces a confident,
  // completely wrong answer (every player "reaching 167 picks early" against an
  // empty roster), which is exactly the class of silent-plausible-nonsense this
  // codebase keeps getting bitten by. Fail loudly instead.
  if (!draft || !(draft.picks || []).length) {
    console.error(`\nNo pick data for draft ${DRAFT_ID}${STATE_FILE ? ` in ${STATE_FILE}` : ` at ${HOST}`}.`);
    if (draft && draft.error) console.error(`  server says: ${draft.error}`);
    console.error(`\n  The draft-state cache is populated by the BBA Live bookmarklet on the DK`);
    console.error(`  draft page, and it expires. Either re-tap it, or pass a saved payload:`);
    console.error(`    curl -s ${HOST}/api/dk-draft-state/${DRAFT_ID} > state.json   # while it is warm`);
    console.error(`    node tools/explain.js --state state.json --draft ${DRAFT_ID} --player "…"\n`);
    process.exit(4);
  }

  const projMap = {};
  for (const p of (projPayload.players || [])) if (p.id) projMap[p.id] = p;

  const rankMap = {};
  for (const r of (rankings || [])) if (r.custom_rank != null) rankMap[r.player_id] = r.custom_rank;

  // ── reconstruct draft state ────────────────────────────────────────────────
  // Picks are matched to the pool by NAME, not by draftable_id, because DK
  // reissues draftable ids per slate: on the 2026-08-15 board, 7 of 14 of one
  // roster's ids were absent from the cached pool while every name resolved.
  // recommend.html has always done it this way; matching by id here would have
  // silently dropped half the roster and changed every roster-fit multiplier.
  const players = pool.map(p => ({ ...p }));
  const takenIds = new Set();
  const myIds = new Set();
  const unmatched = [];

  const myCol = draft.my_position != null ? draft.my_position - 1 : null;
  for (const pk of (draft.picks || [])) {
    let hit = null;
    try { hit = findPlayer(players, pk.player_name); } catch { hit = null; }
    if (!hit) { unmatched.push(pk.player_name); continue; }
    takenIds.add(hit.id);
    // Same precedence as applyDKPickState() in recommend.html: the draft-board
    // column is authoritative when present, username is the fallback. Note the
    // fallback needs a real username to compare against — every OTHER seat comes
    // back with `username: ""`, so an empty ME would tag the whole board as yours.
    const isMine = (pk.column_idx != null)
      ? pk.column_idx === myCol
      : !!(ME && (pk.username || '').toLowerCase().includes(ME));
    if (isMine) myIds.add(hit.id);
  }

  const numTeams = draft.num_teams || 12;
  const myPos    = draft.my_position || 1;
  const overall  = draft.overall_pick || (draft.pick_count || 0) + 1;
  const myTurn   = V1.isMyTurn(overall, numTeams, myPos);
  const pickForRec = parseInt(
    arg('pick', String(myTurn ? overall : (V1.nextMyOverallPick(overall, numTeams, myPos) || overall))), 10);
  const nextMyPick = V1.nextMyOverallPick(pickForRec + 1, numTeams, myPos);

  // Remaining picks after this one — V2 uses them for its replacement horizon.
  const myPicks = [];
  { let cur = pickForRec + 1;
    for (let i = 0; i < 24; i++) {
      const nxt = V1.nextMyOverallPick(cur, numTeams, myPos);
      if (!nxt || nxt > numTeams * 20) break;
      myPicks.push(nxt); cur = nxt + 1;
    } }

  // ── attach V2 effective values ─────────────────────────────────────────────
  // Order matters and mirrors the page: realAdp is seeded first, then
  // v2AttachEffective runs against the ORIGINAL objects with the rank map passed
  // in separately — the board is an input to the blend, not a mutation of adp.
  // The adp substitution (applyBoard) happens afterwards, for V1's benefit.
  players.forEach(p => { if (p.realAdp == null) p.realAdp = p.adp; });
  V2.v2AttachEffective(players, projMap, { customRankMap: USE_BOARD ? rankMap : {} });

  const target0 = findPlayer(players, QUERY);
  if (!target0) {
    console.error(`No player matching "${QUERY}".`);
    process.exit(2);
  }
  if (takenIds.has(target0.id)) {
    console.error(`${target0.name} is already drafted in this draft.`);
    process.exit(3);
  }

  const availableRaw = players.filter(p => !takenIds.has(p.id));
  const available = applyBoard(availableRaw, rankMap, USE_BOARD);
  // myTeam is looked up from the scored array so roster players always carry
  // _eff. The page builds myTeam from copies taken at pick time, which is why it
  // needs its own "roster players V2 cannot see" banner; here it cannot happen.
  const myTeam = players.filter(p => myIds.has(p.id));
  const target = available.find(p => p.id === target0.id);

  // ── V1 ─────────────────────────────────────────────────────────────────────
  const bd1 = [];
  const v1Value = V1.calculateValue(target, pickForRec, myTeam, STACK, nextMyPick, available, bd1);
  const v1Board = available
    .map(p => ({ name: p.name, v: V1.calculateValue(p, pickForRec, myTeam, STACK, nextMyPick, available) }))
    .sort((a, b) => b.v - a.v);
  const v1Rank = v1Board.findIndex(r => r.name === target.name) + 1;

  // ── V2 ─────────────────────────────────────────────────────────────────────
  let v2Value = null, bd2 = [], v2Rank = null, v2Err = null, eff = null;
  try {
    const ctx = V2.buildV2Context(available, myTeam, pickForRec, nextMyPick, myPicks, players, {});
    v2Value = V2.calculateValueV2(target, pickForRec, myTeam, nextMyPick, available, bd2, ctx, myPicks);
    const recs = V2.getTopRecommendationsV2(available, myTeam, pickForRec, available.length,
                                            nextMyPick, myPicks, players, {});
    v2Rank = recs.findIndex(r => r.player.name === target.name) + 1 || null;
    eff = target._eff;
  } catch (e) { v2Err = e.message; }

  if (AS_JSON) {
    console.log(JSON.stringify({
      host: HOST, draft: DRAFT_ID, pick: pickForRec, nextPick: nextMyPick,
      board: USE_BOARD, stack: STACK,
      player: { name: target.name, pos: target.pos, team: target.team,
                adpUsed: target.adp, realAdp: target.realAdp,
                customRank: rankMap[target.id] ?? null, ecrRank: target.ecr_rank ?? null },
      projection: projMap[target.id] || null,
      effective: eff ? { mean: eff.mean, sd: eff.sd, ceiling: eff.ceiling,
                         sources: eff.sources, projected: eff.projected,
                         customRanked: eff.customRanked } : null,
      v1: { value: v1Value, rank: v1Rank, breakdown: bd1 },
      v2: { value: v2Value, rank: v2Rank, breakdown: bd2, error: v2Err },
      unmatchedPicks: unmatched,
    }, null, 2));
    return;
  }

  const proj = projMap[target.id];
  console.log(`\n${target.name}  ${target.pos} ${target.team}   —  draft ${DRAFT_ID}, pick ${pickForRec} (next ${nextMyPick ?? '—'})`);
  console.log(`board: ${USE_BOARD ? 'ON (your ranks)' : 'off (market ADP)'}   stack: ${STACK}   roster: ${myTeam.length} players`);
  if (unmatched.length) console.log(`  ⚠ ${unmatched.length} pick(s) unmatched to the pool: ${unmatched.join(', ')}`);
  console.log(`\n  ADP ${target.realAdp}${USE_BOARD && rankMap[target.id] != null ? `   your rank ${rankMap[target.id]} (used as adp)` : ''}   ECR ${target.ecr_rank ?? '—'}`);
  if (proj) {
    console.log(`  projection  ${proj.proj_dk} pts / ${proj.ppg} ppg / sd ${proj.sd} / ${proj.proj_sources} source(s)`
              + `${proj.consensus_label ? `  (${proj.consensus_label})` : ''}`);
  } else {
    console.log(`  projection  none — scored from an ADP-implied estimate`);
  }
  if (eff) {
    console.log(`  effective   mean ${eff.mean.toFixed(2)}  sd ${eff.sd.toFixed(2)}  ceiling ${eff.ceiling.toFixed(2)}`
              + `   [ratio ${(eff.ceiling / eff.mean).toFixed(3)}]`);
  }

  console.log(`\n── V1  (ADP + multipliers) ──  value ${v1Value.toFixed(2)}   board rank #${v1Rank}`);
  console.log(`  base 1000/${target.adp} = ${(1000 / (target.adp || 1)).toFixed(2)}`);
  if (!bd1.length) console.log('  (no multipliers applied)');
  for (const b of bd1) {
    console.log(`  ${b.label.padEnd(24)} ${fmtMult(b.mult).padStart(8)}   ${b.note || ''}`);
  }

  console.log(`\n── V2  (projections, pts/week) ──  ${v2Err ? `ERROR: ${v2Err}` : `value ${v2Value.toFixed(3)}   board rank #${v2Rank}`}`);
  if (!v2Err) {
    if (!bd2.length) console.log('  (no components)');
    for (const b of bd2) {
      const pts = b.points != null ? b.points : b.mult;
      const shown = b.points != null ? `${pts >= 0 ? '+' : ''}${pts.toFixed(3)}` : fmtMult(b.mult);
      console.log(`  ${String(b.label).padEnd(24)} ${shown.padStart(8)}   ${b.note || ''}`);
    }
  }
  console.log('');
})().catch(e => {
  console.error(e.ambiguous ? e.message : `explain.js failed: ${e.message}`);
  process.exit(1);
});
