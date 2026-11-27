#!/usr/bin/env node
/* Review a finished practice draft from the /playoff page, pick by pick.
 *
 *   node tools/playoff-review.js mock.json            # the JSON "Copy for review" gives
 *   pbpaste | node tools/playoff-review.js -
 *   node tools/playoff-review.js --draft 198275001   # a REAL draft the server saved (My teams)
 *   node tools/playoff-review.js mock.json --data ../projections/data   # local inputs, not production's
 *   node tools/playoff-review.js mock.json --completions 12 --no-alt    # quicker
 *
 * ~5 minutes on the Mac for a 12-round draft (24 drafts a pick, then the
 * top-every-time path at --alt-completions 6). Run it in the background.
 *
 * For each of my picks it rebuilds the board as it stood, asks the recommender the
 * question the page asked (same worlds, same field, same Build around / Avoid
 * teams, settled at 24 simulated drafts), and reports:
 *   - where my pick ranked and its value as a share of the top's (vs top);
 *   - Next: had I taken the top, the chance my player was still there at my
 *     next pick (could I have waited?), and whether the top actually was;
 * then scores my finished roster, and the roster I would have had by taking the
 * top pick every time, on FRESH simulated postseasons (seed 999, not the ones the
 * recommender chose on: scoring on its own worlds would flatter it). The five
 * bot seats are the control: they must come out near 1/216 each in P(final).
 *
 * "Followed the tool" keeps every bot's recorded pick except one I took first;
 * that bot takes the best ADP player it can instead. So it is the same room,
 * reacting the least it can -- an approximation, said where it is printed.
 *
 * Inputs: production's pushed data and, when the mock used DK's ADP, that draft
 * group's saved pool. If the data was pushed again since the mock, the answers
 * are for today's data, and the header says so.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Sim = require(path.join(__dirname, '..', 'static', 'playoff-sim.js'));
const Rec = require(path.join(__dirname, '..', 'static', 'recommender-playoff.js'));

const argv = process.argv.slice(2);
const flag = k => argv.includes('--' + k);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const VALUED = new Set(['--server', '--worlds', '--completions', '--alt-completions', '--data', '--draft']);
const file = argv.find((a, i) => (a === '-' || !a.startsWith('--')) && !VALUED.has(argv[i - 1]));
const SERVER = opt('server', 'https://best-ball-draft-assistant.onrender.com');
const N = parseInt(opt('worlds', '2000'), 10);
const M = parseInt(opt('completions', '24'), 10);     // the page settles at 24 (REFINE_TO)
// The "taking the top every time" path only needs a good pick, not a settled
// table: 6 is twice what the backtest measured at, and halves the run.
const M_ALT = parseInt(opt('alt-completions', '6'), 10);
const SEATS = 6, STACK_PER_TEAM = 3;

const pct = (x, d = 1) => (100 * x).toFixed(d) + '%';
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

async function getJson(url) {
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${url}: ${r.status} ${d.error || ''}`);
  return d;
}

function readMock() {
  if (!file) { console.error('usage: node tools/playoff-review.js <mock.json | -> [--data DIR] [--completions N] [--no-alt]'); process.exit(2); }
  const raw = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  // Pasted text may carry chat around it: take the outermost {...}.
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  const m = JSON.parse(raw.slice(a, b + 1));
  if (m.kind !== 'bba-playoff-mock' || !Array.isArray(m.picks)) throw new Error('not a practice draft from the /playoff page (kind bba-playoff-mock)');
  return m;
}

/* A REAL draft, as the server saved it (/api/playoff/drafts, My teams), in the
 * shape a practice draft has. Before 2026-11-27 a real board had to be turned into
 * that JSON by hand (198275001); --draft <DK contest id> reads it directly. The
 * contest's preset comes from its DK name, as My teams scores it. */
async function fromServer(id) {
  const d = (await getJson(`${SERVER}/api/playoff/drafts`)).drafts.find(x => String(x.draft_id) === String(id));
  if (!d) throw new Error(`draft ${id} is not saved on ${SERVER} (was the BBA bookmark running?)`);
  if (!d.complete) console.log(`WARNING: draft ${id} is not finished (${d.picks.length} of ${d.slots} picks).`);
  const c = String(d.contest || '').toLowerCase();
  const preset = Object.entries(Rec.PRESETS).find(([, f]) => {
    const w = f.label.split('·')[0].replace(/^\$[\d.]+[KM]?\s*/i, '').trim().toLowerCase();
    return w && c.includes(w);
  });
  if (!preset) console.log(`WARNING: contest "${d.contest || '?'}" matches no preset; reviewing as play-action.`);
  const picks = d.picks.slice().sort((a, b) => a.pick_number - b.pick_number);
  return { kind: 'bba-playoff-mock', v: 1, id: `dk${d.draft_id}`, at: new Date(1000 * (d.first_seen || d.updated_at)).toISOString(),
    preset: preset ? preset[0] : 'play-action', seat: d.my_position,
    adp: d.draft_group_id ? { src: 'dk', dg: d.draft_group_id } : { src: 'synthetic' }, data_at: null, page_final: null,
    picks: picks.map(p => ({ n: p.player_name, t: p.team, g: p.gsis_id })) };
}

async function main() {
  const mock = opt('draft') ? await fromServer(opt('draft')) : readMock();
  let data, pool = null, source;
  if (opt('data')) {
    const dir = opt('data');
    data = { bracket: JSON.parse(fs.readFileSync(path.join(dir, 'playoff_bracket.json'))),
      players: JSON.parse(fs.readFileSync(path.join(dir, 'playoff_players.json'))), uploaded_at: null };
    source = `local ${dir}`;
  } else {
    data = await getJson(`${SERVER}/api/playoff/data`);
    source = `${SERVER} (${data.source}, pushed ${data.age_hours}h ago)`;
  }
  const ctx = Sim.build(data.bracket, data.players);
  const P = ctx.players;
  const format = { ...Rec.PRESETS[mock.preset] };
  if (!Rec.PRESETS[mock.preset]) throw new Error(`unknown format ${mock.preset}`);
  const typed = Rec.parsePayouts(mock.payouts || '');
  if (typed.length) format.payouts = typed;

  const worlds = Sim.simulateWorlds(ctx, N, 1);          // the page's worlds
  let adp, adpNote;
  if (mock.adp && mock.adp.src === 'dk') {
    pool = await getJson(`${SERVER}/api/playoff/pool?dg=${encodeURIComponent(mock.adp.dg)}`);
    adp = Sim.adpFromPool(ctx, pool);
    adpNote = `DK draft group ${mock.adp.dg}` + (pool.fetched_at !== mock.adp.fetched_at ? ' (pool saved again since the mock: ADP may have moved)' : '');
  } else {
    adp = Sim.syntheticAdp(ctx, worlds).adp;
    adpNote = 'SYNTHETIC (expected points), as the mock used';
  }

  // Players by gsis_id: indexes change with every push. Refuse on a miss.
  const byG = new Map(P.map((p, i) => [p.gsis_id, i]));
  const miss = mock.picks.filter(p => !byG.has(p.g));
  if (miss.length) {
    console.error(`${miss.length} picks are not in today's data: ${miss.map(p => `${p.n} (${p.t})`).join(', ')}`);
    console.error('The data was pushed again since the mock and these players left it. Nothing reviewed.');
    process.exit(1);
  }
  const picks = mock.picks.map((p, k) => ({ ...p, idx: byG.get(p.g), pick: k + 1, seat: Rec.seatOfPick(k + 1, SEATS) }));
  const me = mock.seat - 1;
  const total = SEATS * format.rounds;
  if (picks.length !== total) console.log(`WARNING: ${picks.length} picks for a ${total}-pick draft; reviewing what is there.`);

  console.log(`Practice draft ${mock.id}, ${new Date(mock.at).toLocaleString()} · seat ${mock.seat} · ${format.label}${mock.stackers && mock.stackers.length ? ` · seats ${mock.stackers.join(' and ')} stacked` : ''}`);
  console.log(`Inputs: ${source}${mock.data_at && data.uploaded_at && Math.abs(mock.data_at - data.uploaded_at) > 1 ? ' -- PUSHED AGAIN since the mock: answers are for today\'s data' : ''}`);
  console.log(`ADP: ${adpNote} · ${N} worlds · ${M} simulated drafts per pick`);

  let t0 = Date.now();
  const field = Rec.buildField(ctx, worlds, adp, format);
  const teamsOf = s => new Set(String(s || '').toUpperCase().split(/[\s,]+/).filter(t => ctx.conf && ctx.conf[t]));

  // The question the page asked at a pick: same allow (Avoid) and include (Build around).
  function ask(board, st, av, extra, m = M) {
    const avoid = teamsOf(av), stack = teamsOf(st);
    const taken = new Set(board.taken);
    const include = [];
    for (const t of stack) {
      if (avoid.has(t)) continue;
      P.map((p, i) => i).filter(i => P[i].team === t && P[i].avail && adp[i] > 0 && !taken.has(i))
        .sort((a, b) => adp[a] - adp[b]).slice(0, STACK_PER_TEAM).forEach(i => include.push(i));
    }
    if (extra != null && !include.includes(extra)) include.push(extra);
    return Rec.recommend(ctx, worlds, adp, field, format, board,
      { allow: avoid.size ? i => !avoid.has(P[i].team) : undefined, include, completions: m, seed: 1000 });
  }
  const boardAt = (seq, k) => {
    const rosters = Array.from({ length: SEATS }, () => []);
    for (const p of seq.slice(0, k)) rosters[p.seat].push(p.idx);
    return { mySeat: me, rosters, taken: seq.slice(0, k).map(p => p.idx), nextPick: k + 1 };
  };
  const nm = i => `${P[i].name} (${P[i].pos} ${P[i].team})`;

  // ── pick by pick ──────────────────────────────────────────────────────────
  console.log('\nPick   You took                          rank  vs top   Tool\'s top (≈n = n more as good)       Verdict');
  const rows = [];
  for (const p of picks.filter(x => x.seat === me)) {
    const board = boardAt(picks, p.pick - 1);
    const out = ask(board, p.st, p.av, p.idx);
    const key = out.key, top = out.results[0];
    const k = out.results.findIndex(r => r.idx === p.idx);
    const mine = out.results[k];
    const share = mine && top[key] > 0 ? mine[key] / top[key] : null;
    // Could I have waited on my player? Survival if I had taken the top instead.
    let waitMine = null, topLeft = null, nextPk = null;
    if (top.idx !== p.idx) {
      const sv = Rec.survival(ctx, adp, board, format, top.idx);
      if (sv) { waitMine = sv.left[p.idx]; nextPk = sv.next; }
      // Was the top actually still there at my next pick in this draft?
      const nxt = picks.find(x => x.seat === me && x.pick > p.pick);
      if (nxt) topLeft = !picks.slice(0, nxt.pick - 1).some(x => x.idx === top.idx);
    }
    const ties = out.results.filter(r => r.tie).slice(0, 4).map(r => P[r.idx].name.split(' ').slice(-1)[0]);
    let verdict;
    if (!mine) verdict = 'not allowed here (DK roster minimums / maximums)';
    else if (mine.tie) verdict = top.idx === p.idx ? 'the top pick' : '≈ as good as the top';
    else if (waitMine != null && waitMine >= 0.6) verdict = `reach: ${pct(waitMine, 0)} he was there at #${nextPk} had you taken the top`;
    else if (waitMine != null && waitMine < 0.25) verdict = `reach, but he'd be gone (${pct(waitMine, 0)} left at #${nextPk}): fine only for a stack you wanted`;
    else verdict = waitMine != null ? `reach (${pct(waitMine, 0)} he'd last to #${nextPk})` : 'reach (last pick)';
    if (topLeft === true && mine && !mine.tie) verdict += `; ${P[top.idx].name} was still there at your next pick`;
    if (mine && !mine.tie && teamsOf(p.st).has(P[p.idx].team)) verdict = `stack (${P[p.idx].team}) ` + verdict;
    rows.push({ p, mine, share, top, verdict, out });
    const rd = Math.ceil(p.pick / SEATS), inRd = p.pick - (rd - 1) * SEATS;
    console.log(`${pad(`${rd}.${String(inRd).padStart(2, '0')}`, 7)}${pad(nm(p.idx).slice(0, 33), 34)}${lpad(k >= 0 ? k + 1 : '—', 4)}  ${lpad(share == null ? '—' : pct(share, 0), 6)}   `
      + `${pad(`${nm(top.idx).slice(0, 28)}${ties.length > 1 ? ' ≈' + (ties.length - 1) : ''}`, 37)}  ${verdict}`);
    if (p.st || p.av) console.log(`       ${p.st ? `Build around ${p.st}` : ''}${p.st && p.av ? ' · ' : ''}${p.av ? `Avoid ${p.av}` : ''}`);
  }
  const costly = rows.filter(r => r.mine && !r.mine.tie);
  console.log(`\n${rows.length - costly.length} of ${rows.length} picks were the top pick or within the simulator's noise of it (≈).`);
  if (costly.length) {
    console.log('Biggest gaps (value given up vs the top pick at that moment):');
    for (const r of costly.sort((a, b) => a.share - b.share).slice(0, 4)) {
      console.log(`  #${r.p.pick} ${r.p.n}: ${pct(r.share, 0)} of ${P[r.top.idx].name}'s value — ${r.verdict}`);
    }
  }
  console.log(`(${((Date.now() - t0) / 1000).toFixed(0)} s)`);

  // ── the roster, and the roster from taking the top every time ─────────────
  const fresh = Sim.simulateWorlds(ctx, N, 999);
  const freshField = Rec.buildField(ctx, fresh, adp, format, { seed: 555 });
  const scoreBoard = seq => {
    const rs = Array.from({ length: SEATS }, () => []);
    for (const p of seq) rs[p.seat].push(p.idx);
    const sc = rs.map(r => Sim.rosterScores(ctx, r, fresh, format.lineup));
    return { rs, v: sc.map((s, k) => Rec.contestValue(s, sc.filter((_, j) => j !== k), freshField, fresh, format)) };
  };
  const real = scoreBoard(picks);
  const bots = real.v.filter((_, k) => k !== me);
  const botF = bots.reduce((a, v) => a + v.pFinal, 0) / bots.length;
  const botR1 = bots.reduce((a, v) => a + v.pR[0], 0) / bots.length;

  let alt = null;
  if (!flag('no-alt')) {
    t0 = Date.now();
    const seq = [];
    const takenAlt = new Set();
    for (const p of picks) {
      let idx;
      if (p.seat === me) {
        const board = boardAt(seq, seq.length);
        idx = ask(board, p.st, p.av, null, M_ALT).results[0].idx;
      } else if (!takenAlt.has(p.idx)) idx = p.idx;
      else {
        // The bot's player is on my alternate roster: best ADP it can take (no noise).
        const rs = boardAt(seq, seq.length).rosters;
        const done = Rec.completeBoard(ctx, adp, rs, [...takenAlt], p.pick, format, Sim.mulberry32(1), 0, p.pick);
        idx = done[p.seat][rs[p.seat].length];
      }
      takenAlt.add(idx);
      seq.push({ idx, seat: p.seat, pick: p.pick });
    }
    alt = { seq, ...scoreBoard(seq), s: (Date.now() - t0) / 1000 };
  }

  const line = (label, v) => `  ${pad(label, 26)} win round 1 ${lpad(pct(v.pR[0]), 6)}   reach the final ${lpad(pct(v.pFinal, 2), 6)}`;
  console.log(`\nScored on fresh simulated postseasons (not the ones the tool chose on):`);
  console.log(line('Your roster', real.v[me]));
  if (alt) console.log(line('Taking the top every time', alt.v[me]));
  console.log(line('Bot seats (average)', { pR: [botR1], pFinal: botF }));
  console.log(`  An average roster: 16.7% and ${pct(1 / 216, 2)}. Bots far from that = the check is off; don't trust the rest.`);
  const teamLine = rs => {
    const t = {};
    for (const i of rs) t[P[i].team] = (t[P[i].team] || 0) + 1;
    return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([x, k]) => `${x}${k}`).join(' ');
  };
  console.log(`\nYour teams:        ${teamLine(real.rs[me])}`);
  if (alt) {
    console.log(`Top-every-time:    ${teamLine(alt.rs[me])}`);
    const a = new Set(alt.rs[me]), b = new Set(real.rs[me]);
    const onlyYou = real.rs[me].filter(i => !a.has(i)).map(i => P[i].name);
    const onlyTool = alt.rs[me].filter(i => !b.has(i)).map(i => P[i].name);
    console.log(`Only on yours:     ${onlyYou.join(', ') || '—'}`);
    console.log(`Only on the tool's: ${onlyTool.join(', ') || '—'}`);
    console.log(`(Tool path: the same room, each bot taking its recorded player unless the tool took him first; ${alt.s.toFixed(0)} s.)`);
  }
  // The level moves with the set of worlds (measured: 0.41% on the page's, 0.96%
  // on these, same roster): compare rows scored together, never across sets.
  if (mock.page_final != null) console.log(`The page scored your roster at ${pct(mock.page_final, 2)} on its own worlds. Levels move between`
    + ' sets of simulated postseasons; the rows above are scored together, so compare those.');
}

main().catch(e => { console.error(String(e.stack || e)); process.exit(1); });
