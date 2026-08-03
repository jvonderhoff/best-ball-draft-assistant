#!/usr/bin/env node
//
// Does carrying a 5th (or 6th) running back actually pay?
//
// The construction table in tools/compare-models.js cannot answer this and should not
// be read as if it can. Its buckets hold 21-58 distinct rosters, season draws inside a
// bucket share those rosters, and the rosters are not 4-RB by choice — they are 4-RB
// because that draft went that way. Turning injuries on moved the two 5-RB builds in
// OPPOSITE directions (2-5-9-4 fell 34.0% -> 28.9% advance while 3-5-8-4 rose 12.0% ->
// 28.4%), which is all the proof needed that the table is reporting noise at that level.
//
// This asks the counterfactual instead. Each draft seed is played three times:
//
//   baseline   V2 as shipped, lands around 4.6 RB
//   RB >= 5    from round 7, take the best RB until you have five
//   RB >= 6    same, six
//
// Everything else is held identical — same seed, same bots, same board, same truth,
// and critically the SAME WEEKLY PLAYER SCORES, since the simulator draws weather once
// per player per week and shares it. So the three arms differ only in roster
// composition, and the comparison is PAIRED: the error bar is the spread of the
// per-draft difference, not of the arms themselves. That is what kills the noise the
// construction table drowns in.
//
// Forcing a single round does nothing, by the way — the model rebalances and lands on
// the same shape. The target has to be forced, not a pick.
//
// Usage:
//   node tools/rb-depth.js
//   node tools/rb-depth.js --drafts 150 --seasons 250 --from-round 7

const H = require('./compare-models.js');

const NUM = 12;

function main() {
  const args = process.argv.slice(2);
  const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

  const drafts    = parseInt(arg('drafts', '150'), 10);
  const seasons   = parseInt(arg('seasons', '250'), 10);
  const truth     = arg('truth', 'market');
  const model     = arg('model', 'v2');

  // Position-general. "Early" has to mean something different per position — the
  // median ADP of the top 36 is RB 44 and WR 37 but QB 116 and TE 149, so a
  // round-4 quarterback essentially never happens and a round-6 window would
  // classify every draft as QB-light.
  const POS_DEFAULTS = {
    RB: { early: 6,  from: 7,  ban: 6,  floors: [5, 6] },
    WR: { early: 6,  from: 7,  ban: 6,  floors: [9, 10] },
    QB: { early: 9,  from: 10, ban: 10, floors: [2, 3, 4] },
    TE: { early: 10, from: 11, ban: 10, floors: [3, 4, 5] },
  };
  const pos = (arg('pos', 'RB') || 'RB').toUpperCase();
  const dflt = POS_DEFAULTS[pos] || POS_DEFAULTS.RB;
  const earlyWindow = parseInt(arg('early-window', String(dflt.early)), 10);
  const fromRound   = parseInt(arg('from-round', String(dflt.from)), 10);
  const banThrough  = parseInt(arg('ban-through', String(dflt.ban)), 10);
  const floors      = (arg('floors', dflt.floors.join(',')) || '').split(',').map(Number);

  const players = H.loadData();
  const ctx     = H.buildScoringContext(players);

  // Capital-aware target: how many backs you end up wanting depends on how many
  // early picks you already spent there. Early backs are reliable and cover the 2.3
  // weekly slots on their own; late backs are lottery tickets, and you need more
  // tickets. A fixed floor cannot express that, and averaging over both situations
  // can hide a real effect in either direction.
  const earlyAt = myTeam => myTeam.filter(p => p.pos === pos && p.round <= earlyWindow).length;
  const capitalAware = myTeam => {
    const e = earlyAt(myTeam);
    if (e >= 2) return floors[0];                              // spent early capital
    if (e === 1) return floors[Math.min(1, floors.length - 1)];
    return floors[floors.length - 1];                          // waited — carry more
  };

  // --light manufactures the RB-light start V2 will not choose on its own, then asks
  // the only question that matters in that branch: given you waited, how many?
  const light = args.includes('--light');
  const ban   = light ? { posBan: { pos, throughRound: banThrough } } : {};

  const arms = light ? [
    { name: `light, no floor`, opts: { ...ban } },
    ...floors.map(c => ({ name: `light, ${pos}>=${c}`,
                          opts: { ...ban, posFloor: { pos, count: c, fromRound } } })),
  ] : [
    { name: 'baseline', opts: {} },
    ...floors.map(c => ({ name: `${pos} >= ${c}`,
                          opts: { posFloor: { pos, count: c, fromRound } } })),
    { name: 'capital-aware', opts: { posFloor: { pos, count: capitalAware, fromRound } } },
  ];

  console.log(`${model.toUpperCase()}, truth ${truth}, ${drafts} drafts x ${seasons} seasons, `
            + `${pos} floor from round ${fromRound}, early window R1-${earlyWindow}`
            + (light ? `, ${pos} banned through R${banThrough}.` : '.'));
  console.log('Paired: every arm sees the same draft seed, the same opponents and the');
  console.log('same weekly player scores. Only the roster differs.\n');

  for (const a of arms) { a.rb = 0; a.perDraft = []; a.earlyRB = []; }

  for (let d = 0; d < drafts; d++) {
    const seed = 660000 + d * 7919;
    H.assignTruth(players, truth, H.mulberry32(seed), ctx);

    const slot = d % NUM;
    const bySlot = new Array(NUM).fill(null); bySlot[slot] = model;

    // Draft each arm from the identical seed, so the bots behave the same way.
    for (const a of arms) {
      const rosters = H.simulateDraft(players, bySlot, H.mulberry32(seed + 1), NUM, a.opts);
      a.fast = rosters.map(H.toFastRoster);
      a.rb  += rosters[slot].filter(p => p.pos === pos).length;
      a.earlyRB.push(rosters[slot].filter(p => p.pos === pos && p.round <= earlyWindow).length);
      a.adv = 0; a.fin = 0;
    }

    for (let s = 0; s < seasons; s++) {
      const rng = H.mulberry32(seed + 100000 + s);
      const acc = arms.map(() => new Float64Array(NUM));
      const wk  = arms.map(() => ({}));

      // One weather draw, shared by every arm — this is the whole point.
      for (let week = 1; week <= 17; week++) {
        const scores = H.drawWeekScores(ctx, week, rng);
        for (let ai = 0; ai < arms.length; ai++) {
          const vals = arms[ai].fast.map(fr => H.scoreRoster(fr, scores));
          if (week <= 14) for (let i = 0; i < NUM; i++) acc[ai][i] += vals[i];
          else wk[ai][week] = vals;
        }
      }

      for (let ai = 0; ai < arms.length; ai++) {
        const rank = (arr, i) => { let b = 1; for (let k = 0; k < arr.length; k++) if (arr[k] > arr[i]) b++; return b; };
        const advanced = rank(acc[ai], slot) <= 2;
        if (advanced) arms[ai].adv++;
        if (advanced && rank(wk[ai][15], slot) === 1 && rank(wk[ai][16], slot) === 1) arms[ai].fin++;
      }
    }

    for (const a of arms) a.perDraft.push({ adv: a.adv / seasons, fin: a.fin / seasons });
  }

  const mean = xs => xs.reduce((s, v) => s + v, 0) / xs.length;
  const se   = xs => {
    const m = mean(xs);
    return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1) / xs.length);
  };

  console.log(`${'arm'.padEnd(12)}${('avg ' + pos).padStart(8)}${'advance'.padStart(10)}${'reach final'.padStart(13)}`);
  console.log('-'.repeat(43));
  for (const a of arms) {
    console.log(`${a.name.padEnd(12)}${(a.rb / drafts).toFixed(2).padStart(8)}`
      + `${(100 * mean(a.perDraft.map(x => x.adv))).toFixed(2).padStart(9)}%`
      + `${(100 * mean(a.perDraft.map(x => x.fin))).toFixed(3).padStart(12)}%`);
  }

  // Paired differences. Same seed, same weather, so the per-draft difference is the
  // estimator and its spread is the honest error bar.
  console.log('\nPaired difference vs baseline (same seed, same weather)');
  console.log(`${'arm'.padEnd(12)}${'Δ advance'.padStart(14)}${'Δ reach final'.padStart(18)}`);
  console.log('-'.repeat(44));
  for (const a of arms.slice(1)) {
    const dAdv = a.perDraft.map((x, i) => x.adv - arms[0].perDraft[i].adv);
    const dFin = a.perDraft.map((x, i) => x.fin - arms[0].perDraft[i].fin);
    const fmt = (xs, dp) => {
      const m = 100 * mean(xs), s = 100 * se(xs);
      return `${m >= 0 ? '+' : ''}${m.toFixed(dp)} ±${s.toFixed(dp)}pp`;
    };
    console.log(`${a.name.padEnd(12)}${fmt(dAdv, 2).padStart(14)}${fmt(dFin, 3).padStart(18)}`);
  }
  // Split by how much early capital went into RB. If the right target depends on
  // that, the paired difference should have opposite signs across these buckets.
  console.log(`\nPaired Δ advance vs baseline, split by early (R1-${earlyWindow}) ${pos} capital`);
  console.log(`${'arm'.padEnd(16)}${'0-1 early'.padStart(15)}${'2 early'.padStart(15)}${'3+ early'.padStart(15)}`);
  console.log('-'.repeat(60));
  for (const a of arms.slice(1)) {
    const cells = [[0, 1], [2, 2], [3, 99]].map(([lo, hi]) => {
      const idx = arms[0].earlyRB.map((e, i) => (e >= lo && e <= hi) ? i : -1).filter(i => i >= 0);
      if (idx.length < 8) return `n=${idx.length}`.padStart(15);
      const ds = idx.map(i => a.perDraft[i].adv - arms[0].perDraft[i].adv);
      const m = 100 * mean(ds), s2 = 100 * se(ds);
      return `${m >= 0 ? '+' : ''}${m.toFixed(2)} ±${s2.toFixed(2)} (${idx.length})`.padStart(15);
    });
    console.log(`${a.name.padEnd(16)}${cells.join('')}`);
  }

  console.log('\n± is one standard error of the PAIRED difference across drafts.');
  console.log('A result inside ~2 SE of zero is not a result.');
}

main();
