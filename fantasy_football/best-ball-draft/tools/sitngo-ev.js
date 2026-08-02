#!/usr/bin/env node
//
// Which DraftKings Best Ball "Sit & Go" is worth entering?
//
// These are a completely different game from the Millionaire the main harness
// models. Every one of them is:
//
//   * winner-take-all — one prize, no consolation, no advancement phases
//   * season-long cumulative scoring, weeks 1-17 (GameType 145, IsSeasonLong)
//   * single entry per user
//   * 3, 6 or 12 drafters
//
// With one prize and N drafters, the break-even win rate is a/prize = 1/(N(1-rake)),
// so the RELATIVE edge you need over chance is 1/(1-rake) no matter how big the
// field is: at 10% rake you must win 11.1% more often than a coin flip whether the
// contest has 3 seats or 12. Field size does not change the bar.
//
// What field size does change is how much of a drafting edge survives to the
// scoreboard, and that is not something you can reason out from a payout table. In a
// 3-team draft only 60 of ~400 players come off the board, so every seat ends up
// with a roster full of startable talent and the gaps between teams collapse toward
// weekly noise. In a 12-team draft scarcity is real and roster quality separates.
// This tool measures that directly: it drafts the recommender into an N-team room
// of ADP bots, plays the season out, and reports how often it finishes first.
//
// Usage:
//   node tools/sitngo-ev.js
//   node tools/sitngo-ev.js --drafts 150 --seasons 400 --truth market --model v2

const H = require('./compare-models.js');

// Rake by entry fee, read off the live lobby (draft groups 146136/146163).
// Prize is winner-take-all, so rake = 1 - prize/(entry * seats).
const RAKE_TIERS = [
  [1,    0.100], [5,    0.100], [10,   0.100], [20,   0.100], [50,   0.100],
  [109,  0.083], [215,  0.070], [530,  0.057], [1060, 0.057], [2120, 0.057],
  [5300, 0.057],
];

// DK awards 550 Crowns per $1 of entry across every one of these contests, so
// crowns shift every tier by the same amount and cannot break a tie between them.
// Valued conservatively; set to 0 to ignore.
const CROWNS_PER_DOLLAR = 550;
const CROWN_VALUE = parseFloat(process.env.CROWN_VALUE || '0.000');

const FIELD_SIZES = [3, 6, 12];

function main() {
  const args = process.argv.slice(2);
  const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

  const drafts  = parseInt(arg('drafts', '120'), 10);
  const seasons = parseInt(arg('seasons', '400'), 10);
  const truth   = arg('truth', 'market');
  const model   = arg('model', 'v2');

  const players = H.loadData();
  const ctx     = H.buildScoringContext(players);
  console.log(`Loaded ${players.length} players. Model: ${model.toUpperCase()}, truth: ${truth}, `
            + `${drafts} drafts x ${seasons} seasons per field size.\n`);

  const results = [];

  for (const N of FIELD_SIZES) {
    let wins = 0, n = 0, myPts = 0, oppPts = 0;
    // Seasons within one draft share a roster, so they are not independent samples.
    // The honest error bar is the spread ACROSS drafts, not across team-seasons.
    const perDraft = [];

    for (let d = 0; d < drafts; d++) {
      const seed = 4242000 + d * 7919;
      H.assignTruth(players, truth, H.mulberry32(seed), ctx);

      const slot    = d % N;
      const rosters = H.simulateDraft(players, slot, model, H.mulberry32(seed + 1), N);
      const fast    = rosters.map(H.toFastRoster);
      let dWins = 0;

      for (let s = 0; s < seasons; s++) {
        const rng = H.mulberry32(seed + 100000 + s);
        const tot = new Float64Array(N);
        // Season-long cumulative: every week counts, no knockout phases.
        for (let week = 1; week <= 17; week++) {
          const scores = H.drawWeekScores(ctx, week, rng);
          for (let i = 0; i < N; i++) tot[i] += H.scoreRoster(fast[i], scores);
        }

        let best = 0;
        for (let i = 1; i < N; i++) if (tot[i] > tot[best]) best = i;
        n++;
        if (best === slot) { wins++; dWins++; }
        myPts += tot[slot];
        for (let i = 0; i < N; i++) if (i !== slot) oppPts += tot[i] / (N - 1);
      }
      perDraft.push(dWins / seasons);
    }

    const p  = wins / n;
    const mu = perDraft.reduce((a, b) => a + b, 0) / perDraft.length;
    const va = perDraft.reduce((a, b) => a + (b - mu) ** 2, 0) / (perDraft.length - 1);
    results.push({ N, p, ratio: p * N, se: Math.sqrt(va / perDraft.length),
                   myPts: myPts / n, oppPts: oppPts / n });
  }

  // ── Win rate vs chance ──────────────────────────────────────────────────────
  console.log('How well the draft edge survives, by field size');
  console.log(`${'seats'.padStart(6)}${'win rate'.padStart(11)}${'+/- 1se'.padStart(9)}${'chance'.padStart(9)}`
            + `${'edge'.padStart(9)}${'your pts'.padStart(11)}${'opp pts'.padStart(10)}`);
  console.log('-'.repeat(65));
  for (const r of results) {
    console.log(`${String(r.N).padStart(6)}${(100 * r.p).toFixed(2).padStart(10)}%`
      + `${(100 * r.se).toFixed(2).padStart(9)}`
      + `${(100 / r.N).toFixed(2).padStart(8)}%`
      + `${((r.ratio >= 1 ? '+' : '') + ((r.ratio - 1) * 100).toFixed(1) + '%').padStart(9)}`
      + `${r.myPts.toFixed(0).padStart(11)}${r.oppPts.toFixed(0).padStart(10)}`);
  }
  console.log('\n"edge" is how much more often than chance the model wins. Break-even needs');
  console.log('+11.1% at the 10% rake tiers, +9.1% at $109, +7.5% at $215, +6.0% at $530+.');

  // ── ROI by entry fee and field size ─────────────────────────────────────────
  console.log('\nExpected ROI per entry (winner-take-all, rake from the live lobby)');
  console.log(`${'entry'.padStart(8)}${'rake'.padStart(7)}` + FIELD_SIZES.map(N => `${N} seats`.padStart(11)).join(''));
  console.log('-'.repeat(8 + 7 + 11 * FIELD_SIZES.length));
  for (const [fee, rake] of RAKE_TIERS) {
    const cells = results.map(r => {
      // One prize of fee*N*(1-rake); you take it with probability p.
      const roi = r.ratio * (1 - rake) - 1 + (CROWNS_PER_DOLLAR * CROWN_VALUE);
      return `${(roi >= 0 ? '+' : '') + (100 * roi).toFixed(1)}%`.padStart(11);
    });
    console.log(`${('$' + fee).padStart(8)}${(100 * rake).toFixed(1).padStart(6)}%${cells.join('')}`);
  }

  console.log('\nCAVEATS, and they are load-bearing:');
  console.log('  * Opponents are ADP bots. Real Sit & Go opponents at $530+ are not, so the');
  console.log('    ROI table overstates high stakes — rake falls, but so does your edge.');
  console.log('  * Both recommenders hardcode a 12-team league (V2_NUM_TEAMS = 12). Their');
  console.log('    replacement level and survival maths are simply wrong at 3 and 6 seats,');
  console.log('    which is part of what the 3-seat number is measuring.');
  console.log('  * Winner-take-all season-long is a different objective from the Millionaire.');
  console.log('    Nothing here transfers to that contest, or its numbers to this one.');
}

main();
