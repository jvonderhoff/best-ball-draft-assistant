// Draft recommendation engine

// ── Stack bonus multipliers by intensity ──────────────────────────────────────
// first      = 1st pass-catcher (WR/TE) from your QB's team
// second     = 2nd pass-catcher from same QB's team
// qbPull     = QB whose pass-catchers you already own
// cluster    = 2nd+ WR/TE from a team even without the QB (building a receiver room)
// rbCorrel   = RB from a team where you already have other players (correlated scoring)

const STACK_SETTINGS = {
  //            existing ──────────────────────────────────  new ──────────────────────
  //            first   second  qbPull  cluster rbCorrel    stackReady  bringbackWindow
  // bringbackWindow is the CEILING of qbPull when urgency is max (interpolated, not compounded)
  off:    { first: 1.00, second: 1.00, qbPull: 1.00, cluster: 1.00, rbCorrel: 1.00, stackReady: 1.00, bringbackWindow: 1.00 },
  light:  { first: 1.15, second: 1.05, qbPull: 1.15, cluster: 1.05, rbCorrel: 1.03, stackReady: 1.06, bringbackWindow: 1.30 },
  medium: { first: 1.25, second: 1.10, qbPull: 1.35, cluster: 1.10, rbCorrel: 1.05, stackReady: 1.10, bringbackWindow: 1.55 },
  heavy:  { first: 1.40, second: 1.18, qbPull: 1.40, cluster: 1.15, rbCorrel: 1.08, stackReady: 1.15, bringbackWindow: 1.70 },
};

// ── QB tier tracking ──────────────────────────────────────────────────────────
// Boosts QB value based on how many QBs have been taken from the board overall,
// signaling tier depletion rather than just recency.
//
// Tier 1 (~ADP 1-60):   first 6 QBs off the board
// Tier 2 (~ADP 61-120): QBs 7-12 off the board
// Tier 3 (ADP 120+):    QBs 13+ off the board
//
// qbsTaken: total QBs drafted by all teams so far.
// myQBs:    QBs already on your roster.
function getQBTierBoost(qbsTaken, myQBs) {
  if (myQBs >= 2)   return 1.0;
  if (qbsTaken < 3) return 1.0;
  // Reduced from prior values — urgency weight already captures much of this
  // signal; compounding the two pushed QBs too aggressively past better-ADP players.
  if (qbsTaken < 6)  return myQBs === 0 ? 1.05 : 1.0;
  if (qbsTaken < 12) return myQBs === 0 ? 1.10 : 1.05;
  return myQBs === 0 ? 1.15 : 1.08;
}


// Human-readable alert label, or null if no action needed.
function qbTierLabel(qbsTaken, myQBs) {
  if (myQBs >= 2 || qbsTaken < 3) return null;
  const tier = qbsTaken < 6 ? 1 : qbsTaken < 12 ? 2 : 3;
  const status = tier === 1 ? 'depleting' : tier === 2 ? 'running out' : 'gone';
  return `${qbsTaken} QBs taken — Tier ${tier} ${status}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Free agents have no real NFL team — they must not correlate with each other
// or trigger any same-team stack bonuses.
function hasRealTeam(player) {
  return player.team && player.team !== 'FA';
}

function getTeamCounts(myTeam) {
  const counts = {};
  myTeam.forEach(p => { if (hasRealTeam(p)) counts[p.team] = (counts[p.team] || 0) + 1; });
  return counts;
}

function getMyQBTeams(myTeam) {
  return new Set(myTeam.filter(p => p.pos === 'QB' && hasRealTeam(p)).map(p => p.team));
}

// Returns how many WR/TE I already have from a given team
function passCatcherCount(team, myTeam) {
  if (!team || team === 'FA') return 0;
  return myTeam.filter(p => ['WR', 'TE'].includes(p.pos) && p.team === team).length;
}

// ── Needs ─────────────────────────────────────────────────────────────────────

function getTeamNeeds(myTeam) {
  const counts = {};
  myTeam.forEach(p => { counts[p.pos] = (counts[p.pos] || 0) + 1; });
  const targets = { QB: 2, RB: 6, WR: 8, TE: 2 };
  const needs = {};
  for (const [pos, target] of Object.entries(targets)) {
    needs[pos] = Math.max(0, target - (counts[pos] || 0));
  }
  return needs;
}

// ── Playoff schedule stacking ─────────────────────────────────────────────────
// Bonus for owning players from both teams in the same playoff game.
// Week 17 gets the highest emphasis since it's the fantasy championship.

// Base per-game bonuses (single partner).
// Amplified when 2+ partners share the same game — real game stack, not coincidence.
const PLAYOFF_BONUS     = { week17: 1.08, week16: 1.02, week15: 1.01 };
const PLAYOFF_BONUS_CAP = 1.50;

// Returns true if p1 and p2 are in the same game in a given week.
function samePlayoffGame(p1, p2, week) {
  const key = `week${week}`;
  // p1's opponent is p2's team, or vice versa (same game, both directions)
  return (p1[key] && p1[key] === p2.team) || (p2[key] && p2[key] === p1.team);
}

// Returns a multiplier > 1.0 if this player shares playoff games with current team members.
//
// userRound: used to fade the bonus in later rounds when standalone game-stack value
// is low and MC fitness should carry the load instead. Multi-partner stacks stay strong.
//
// Single partner:  bonus fades from full → 40% of full between rounds 9 and 16.
// 2+ partners:     no fade — owning multiple players in the same game is a committed
//                  stack worth protecting regardless of round.
function getPlayoffBonus(player, myTeam, userRound = 1) {
  if (!myTeam.length) return 1.0;
  // Only apply when we actually have schedule data
  if (!player.week15 && !player.week16 && !player.week17) return 1.0;

  // Count partners per week; track max to decide fade behaviour
  let mult = 1.0;
  let maxPartnersInAnyWeek = 0;
  for (const week of [17, 16, 15]) {
    const partners = myTeam.filter(m => samePlayoffGame(player, m, week));
    if (partners.length) {
      maxPartnersInAnyWeek = Math.max(maxPartnersInAnyWeek, partners.length);
      // Multi-partner amplifier: each extra partner beyond the first adds 50% more delta
      const partnerBoost = 1 + (partners.length - 1) * 0.5;
      const rawBonus = 1 + (PLAYOFF_BONUS[`week${week}`] - 1) * partnerBoost;
      mult *= rawBonus;
    }
  }
  if (mult <= 1.001) return 1.0;

  // Round-based fade for solo-partner game stacks only
  if (maxPartnersInAnyWeek < 2) {
    // Full bonus rounds 1-8; fades linearly to 40% by round 16+
    const fade = Math.max(0.40, 1 - Math.max(0, userRound - 8) / 12);
    mult = 1 + (mult - 1) * fade;
  }

  return Math.min(mult, PLAYOFF_BONUS_CAP);
}

// Returns a description of the strongest playoff game overlap, or null.
function playoffStackReason(player, myTeam) {
  // Find the highest-value week where this player shares a game with a teammate
  for (const week of [17, 16, 15]) {
    const partners = myTeam.filter(m => samePlayoffGame(player, m, week));
    if (partners.length) {
      const names = partners.map(p => p.name.split(' ').pop()).join(', ');
      return `playoff Wk${week} game stack w/ ${names}`;
    }
  }
  return null;
}

// ── Bye week helpers ──────────────────────────────────────────────────────────

// Returns a map of bye_week -> count of players on that week,
// excluding teammates of `player` (stacking the same team on the same bye is
// an accepted cost of stacking, not something to penalize).
function getByeWeekCounts(myTeam, excludeTeam = null) {
  const counts = {};
  for (const p of myTeam) {
    if (p.bye && hasRealTeam(p) && p.team !== excludeTeam) counts[p.bye] = (counts[p.bye] || 0) + 1;
  }
  return counts;
}

// Penalty multiplier when adding a player whose bye week is already crowded.
// Teammates sharing the same bye are not counted — stacking is intentional.
// 0-2 non-teammate players on same bye: no penalty
// 3: mild penalty (0.90) | 4: moderate (0.80) | 5+: heavy (0.70)
function getByeWeekPenalty(player, myTeam) {
  if (!player.bye) return 1.0;
  const counts = getByeWeekCounts(myTeam, player.team);
  const existing = counts[player.bye] || 0;
  if (existing <= 2) return 1.0;
  if (existing === 3) return 0.90;
  if (existing === 4) return 0.80;
  return 0.70;
}

// Returns a warning string if drafting this player would create a bye week crunch, else null.
// `existing` = non-teammate players already on that bye week (not counting the candidate).
// After drafting, total would be existing + 1. Only warn when that total hits 3+.
function byeWeekWarning(player, myTeam) {
  if (!player.bye) return null;
  const clashers = myTeam.filter(p => p.bye === player.bye && p.team !== player.team);
  const afterDraft = clashers.length + 1;
  if (afterDraft < 3) return null;
  const names = clashers.map(p => p.name.split(' ').pop()).join(', ');
  return `bye wk${player.bye} clash: ${names}`;
}

// ── Core value calculation ────────────────────────────────────────────────────

// availQBByTeam: team → best available QB (not yet drafted)
// availPCByTeam: team → available WR/TE sorted by ADP
// nextMyPick:    overall pick number of my NEXT turn after this one (for window urgency)
// bd (breakdown): optional array — if provided, each applied multiplier is pushed as
// { label, mult, note } so callers can explain the score to the user.
function calculateValue(player, needs, myPickNumber, myTeam, stackIntensity = 'medium', qbsTaken = 0, availQBByTeam = null, availPCByTeam = null, nextMyPick = null, bd = null) {
  // Use inverse ADP so value is always positive and naturally orders players.
  // adp=1 → 1000, adp=50 → 20, adp=100 → 10, adp=200 → 5, adp=500 → 2
  // This ensures late-round players still have relative ordering rather than
  // all collapsing to 0 when ADP > 100 (which caused random late-round picks).
  const adpValue = 1000 / (player.adp || 1);
  const pos = player.pos;
  // Helper: apply multiplier and optionally record it
  const apply = (m, label, note) => { mult *= m; if (bd && Math.abs(m - 1) > 0.001) bd.push({ label, mult: m, note }); };

  // ADP is the primary signal. RB and WR compete on pure ADP.
  // QB, TE, and WR get urgency-based adjustments when falling behind pace.
  const totalDrafted = myTeam.length;
  const myTEs  = myTeam.filter(p => p.pos === 'TE').length;
  const myQBs  = myTeam.filter(p => p.pos === 'QB').length;
  const myWRs  = myTeam.filter(p => p.pos === 'WR').length;
  const userRound = totalDrafted + 1;
  // Late-round zero: if you hit round 13+ with none drafted you'll need 3
  // to maintain adequate position quality across the remaining picks.
  const TE_TARGET = (userRound >= 13 && myTEs === 0) ? 3 : 2;
  const QB_TARGET = (userRound >= 13 && myQBs === 0) ? 3 : 2;
  let mult = 1.0;

  // TE urgency — bimodal strategy:
  //   Elite TEs (ADP ≤ 30, e.g. Bowers/McBride): worth drafting rounds 1-4,
  //     slight boost so they compete with elite WRs/RBs.
  //   Mid-tier TEs (ADP 31-115): no-man's-land — avoid spending rounds 4-9 here.
  //     ADP 31-60: compete on pure ADP, no modifier.
  //     ADP 61-115: penalty — worst outcome in best ball.
  //       × 1.00  — QB already on your team (stack bonus handles the value, don't double-penalise)
  //       × 0.90  — QB still available on the board (buildable stack, reduce friction)
  //       × 0.82  — no stack connection (was ×0.72; softened so penalty doesn't swamp legit picks)
  //   Late darts (ADP 116+): urgency ramps in rounds 11-16 once you need to fill slots.
  if (pos === 'TE') {
    const teNeeded = Math.max(0, TE_TARGET - myTEs);
    if (teNeeded > 0) {
      const adp = player.adp || 999;
      if (adp <= 30) {
        if (userRound <= 4) apply(1.20, 'TE elite boost', `ADP ${adp} ≤ 30, rd ${userRound}`);
      } else if (adp >= 61 && adp <= 115) {
        const teQBOwned  = qbTeams.has(player.team);
        const teQBAvail  = !teQBOwned && availQBByTeam && availQBByTeam[player.team];
        const midPenalty = teQBOwned ? 1.00
                         : teQBAvail ? 0.90
                         : 0.82;
        if (midPenalty < 0.999) {
          const why = teQBAvail
            ? `ADP ${adp}, QB avail (${availQBByTeam[player.team].name.split(' ').pop()})`
            : `ADP ${adp} danger zone, no stack`;
          apply(midPenalty, 'TE mid-tier penalty', why);
        }
      } else if (adp > 115) {
        const lateWeight = Math.max(0, Math.min(1, (userRound - 10) / 5));
        const picksLeft  = Math.max(1, 20 - totalDrafted);
        const urgency    = (teNeeded / picksLeft) * lateWeight;
        const m = 1 + Math.min(urgency * 3.0, 2.0);
        if (m > 1.001) apply(m, 'TE late urgency', `rd ${userRound}, ${picksLeft} picks left`);
      }
    }
  }

  // WR urgency — activates mid-draft when WR count is behind pace.
  // Uses pace deficit rather than absolute need since WR depth runs much deeper.
  // Expected pace: 8 WRs in 20 picks = 0.40 per pick drafted.
  // A 1.5-pick grace margin prevents boosting when only slightly behind.
  //   Rd 1-6:  no boost — plenty of WR depth available
  //   Rd 8:    weight 0.33 → mild nudge if behind
  //   Rd 10:   weight 0.67 → meaningful push if behind
  //   Rd 12+:  weight 1.0  → full urgency if behind
  const wrUrgencyWeight = Math.max(0, Math.min(1, (userRound - 6) / 6));

  if (pos === 'WR' && wrUrgencyWeight > 0) {
    const expectedWRs = totalDrafted * 0.40;
    const deficit = Math.max(0, expectedWRs - myWRs - 1.5);
    if (deficit > 0) {
      const m = 1 + Math.min(deficit * 0.20 * wrUrgencyWeight, 0.60);
      apply(m, 'WR urgency', `${myWRs} WRs, behind pace by ${deficit.toFixed(1)}`);
    }
  }

  // QB urgency — starts early; good QBs dry up fast and you can't pivot late.
  //   Rd 1-3:  no boost
  //   Rd 5:    weight 0.20 → gentle push
  //   Rd 7:    weight 0.60 → solid push
  //   Rd 9+:   weight 1.0  → full urgency
  const qbUrgencyWeight = Math.max(0, Math.min(1, (userRound - 3) / 6));

  if (pos === 'QB') {
    const qbNeeded  = Math.max(0, QB_TARGET - myQBs);
    const picksLeft = Math.max(1, 20 - totalDrafted);
    if (qbNeeded > 0) {
      // Gate urgency by QB quality so dart QBs (ADP 100+) don't leapfrog
      // better-value skill players. Elite QBs (ADP ≤ 40) get full push;
      // mid-tier partial; late-round darts get 20% of normal urgency.
      // Formula: 1.5 − adp/80, clamped [0.2, 1.0]
      //   ADP  24 → 1.20 → capped 1.0  (full urgency)
      //   ADP  60 → 0.75                (75%)
      //   ADP  80 → 0.50                (50%)
      //   ADP 100 → 0.25                (25%)
      //   ADP 116 → 0.05 → floored 0.2 (20%)
      const qbQualFactor = Math.max(0.2, Math.min(1.0, 1.5 - player.adp / 80));
      const urgency = (qbNeeded / picksLeft) * qbUrgencyWeight * qbQualFactor;
      const m = 1 + Math.min(urgency * 2.0, 0.8);
      if (m > 1.001) apply(m, 'QB urgency', `${myQBs}/${QB_TARGET} QBs, qual ${qbQualFactor.toFixed(2)}`);
    }
  }

  // Hard discount when a position slot is fully filled.
  // ×0.30 cap (was ×0.65) so over-drafted positions genuinely fall off the board —
  // the old 0.65 still let saturated picks outrank players you actually need.
  if ((needs[pos] || 0) === 0) {
    const before = mult;
    mult = Math.min(mult, 0.30);
    if (bd && mult < before - 0.001) bd.push({ label: 'Position full', mult: mult / before, note: `${pos} slots filled` });
  }

  // QB saturation penalty — scales with how early the first QB was drafted.
  // Early QB capital (round 1-5) = you're locked in, 3rd QB almost never right.
  // Late QB darts (round 14+) = cheap commitment, 3rd is more viable.
  //
  //   Earliest QB round 1-5:   ×0.05 — elite QB, 3rd essentially blocked
  //   Earliest QB round 6-9:   ×0.15 — solid QB, very unlikely
  //   Earliest QB round 10-13: ×0.35 — late QB, 3rd viable on good value
  //   Earliest QB round 14+:   ×0.60 — dart throws, happy to add another
  if (pos === 'QB' && myQBs >= QB_TARGET) {
    const myQBsList = myTeam.filter(p => p.pos === 'QB');
    const earliestQBRound = Math.min(...myQBsList.map(p => p.round || 20));
    let penalty;
    if (earliestQBRound <= 5)       penalty = 0.05;
    else if (earliestQBRound <= 9)  penalty = 0.15;
    else if (earliestQBRound <= 13) penalty = 0.35;
    else                             penalty = 0.60;
    apply(penalty, 'QB saturation', `3rd QB, earliest in rd ${earliestQBRound}`);
  }

  // Early-round blanket ×1.10 amplifier removed — it compounded indiscriminately
  // on top of stacking and playoff bonuses that are already calibrated independently.
  // Those signals are self-sufficient; layering a round-based multiplier on top
  // pushed early-round picks too aggressively regardless of actual fit.

  const myRBs = myTeam.filter(p => p.pos === 'RB').length;

  // Same-team stacking bonuses — skipped for FA players (no real NFL team)
  const s = STACK_SETTINGS[stackIntensity] || STACK_SETTINGS.medium;
  const existingCatchers = passCatcherCount(player.team, myTeam);
  if (myTeam && stackIntensity !== 'off' && hasRealTeam(player)) {
    const qbTeams = getMyQBTeams(myTeam);
    const teamMates = myTeam.filter(p => hasRealTeam(p) && p.team === player.team).length;

    if (['WR', 'TE'].includes(pos)) {
      if (qbTeams.has(player.team)) {
        if (existingCatchers === 0)      apply(s.first,  'Stack: 1st PC',  `${player.team} QB stack`);
        else if (existingCatchers === 1) apply(s.second, 'Stack: 2nd PC',  `${player.team} QB stack`);
      } else if (existingCatchers >= 1) {
        apply(s.cluster, 'Stack: receiver room', `${existingCatchers} PCs, no QB yet`);
      }
    }

    if (pos === 'QB') {
      // Bring-back: I own pass-catchers for this QB.
      //
      // Three axes of urgency compound here:
      //   1. Window urgency  — how likely is this QB to survive until my next pick?
      //                        Concave curve (^0.6) so pressure rises fast as gap narrows.
      //   2. PC-count scale  — 2 catchers owned is dramatically more valuable than 1;
      //                        the ceiling is raised proportionally.
      //   3. PC-count floor  — even outside the tight window, owning 2+ catchers
      //                        means the base boost should exceed plain qbPull.
      //
      // The final mult replaces qbPull (not stacked on top of it).
      if (existingCatchers >= 1) {
        // PC-count ceiling: each extra catcher adds 60% of the remaining gap above bringbackWindow.
        // 1 PC → ceiling = bringbackWindow
        // 2 PC → ceiling = bringbackWindow + 0.60 × (2.0 - bringbackWindow)
        // 3 PC → ceiling = bringbackWindow + 0.84 × (2.0 - bringbackWindow)  [compounded]
        const extraCatchers = Math.min(existingCatchers - 1, 2);
        const ceilingBoost  = 1 - Math.pow(0.4, extraCatchers);           // 0 / 0.60 / 0.84
        const ceiling       = s.bringbackWindow + ceilingBoost * (2.0 - s.bringbackWindow);

        // PC-count floor: 2+ catchers guarantee at least 30% of the way to the ceiling
        // even if the QB's ADP suggests he'll still be available.
        const floorFraction = extraCatchers >= 1 ? 0.30 : 0;
        const floor         = s.qbPull + floorFraction * (ceiling - s.qbPull);

        let bringbackMult = floor;
        if (nextMyPick != null) {
          const windowSize = Math.max(1, nextMyPick - myPickNumber);
          const adpGap     = Math.max(0, (player.adp || myPickNumber) - myPickNumber);
          if (adpGap < windowSize * 2.0) {
            // Concave urgency: rises steeply as adpGap → 0
            const rawUrgency = Math.max(0, 1 - adpGap / windowSize);
            const urgency    = Math.pow(rawUrgency, 0.6);
            bringbackMult = floor + urgency * (ceiling - floor);
          }
        }
        const note = `${existingCatchers} PC${existingCatchers > 1 ? 's' : ''} owned, window ${nextMyPick ? nextMyPick - myPickNumber : '?'}, ceil ×${ceiling.toFixed(2)}`;
        apply(bringbackMult, 'Stack: bring-back QB', note);
      }
    }

    if (pos === 'RB' && teamMates >= 1) {
      apply(s.rbCorrel, 'Stack: RB correl', `${player.team} game-script`);
    }

    // ── Stack co-availability (WR/TE only) ────────────────────────────────────
    // Bonus when this WR/TE's QB is still on the board and I don't own him yet —
    // the stack is completable. Scales by QB tier so only matters for real QBs.
    if (['WR', 'TE'].includes(pos) && availQBByTeam) {
      const qbTeams2 = getMyQBTeams(myTeam);
      if (!qbTeams2.has(player.team)) {
        const teamQB = availQBByTeam[player.team];
        if (teamQB) {
          const qbTier = (teamQB.adp || 999) <= 48  ? 1.0
                       : (teamQB.adp || 999) <= 96  ? 0.7
                       : (teamQB.adp || 999) <= 144 ? 0.4
                       : 0.2;
          const m = 1 + (s.stackReady - 1) * qbTier;
          if (m > 1.001) apply(m, 'Stack: QB avail', `${teamQB.name.split(' ').pop()} ADP ${teamQB.adp}`);
        }
      }
    }
  }

  // Playoff game stack bonus — week 17 weighted most heavily.
  // Not applied to QBs — QB stacking should come from same-team pass-catchers
  // only (qbPull bonus above), not from playing against teams you own.
  // Skipped when stack intensity is off so pure ADP/value mode is truly stack-free.
  if (stackIntensity !== 'off' && pos !== 'QB') {
    const pb = getPlayoffBonus(player, myTeam, userRound);
    if (pb > 1.001) apply(pb, 'Playoff stack', playoffStackReason(player, myTeam) || '');
  }

  const byePen = getByeWeekPenalty(player, myTeam);
  if (byePen < 0.999) apply(byePen, 'Bye week clash', byeWeekWarning(player, myTeam) || '');

  if (pos === 'QB') {
    const qbTierBoost = getQBTierBoost(qbsTaken, myQBs);
    if (qbTierBoost > 1.001) apply(qbTierBoost, 'QB tier depletion', `${qbsTaken} QBs taken`);
  }

  // Value-steal boost / reach penalty: compares ADP to current overall pick.
  // myPickNumber is the overall pick; player.adp is also overall — apples to apples.
  // Normalised by the user's current round so early gaps carry more weight.
  //
  // BOOST (ADP < pick — player fell):
  //   normalizedValue = valueGap / userRound
  //   boost = normalizedValue × 0.20, capped at +60%
  //   R1 pick 6,  ADP 3  → gap=3,  round=1 → ×1.60 (cap)
  //   R4 pick 45, ADP 35 → gap=10, round=4 → ×1.50
  //   R8 pick 90, ADP 80 → gap=10, round=8 → ×1.25
  //
  // PENALTY (ADP > pick — reaching):
  //   reachGap = adp - pick (how many picks ahead you'd be drafting)
  //   penalty  = (reachGap / userRound) × 0.15, capped at -40%
  //   R1 pick 6,  ADP 9  → gap=3,  round=1 → ×0.70
  //   R4 pick 45, ADP 55 → gap=10, round=4 → ×0.63 (≈ cap)
  //   R8 pick 90, ADP 97 → gap=7,  round=8 → ×0.87
  const valueGap  = myPickNumber - (player.adp || myPickNumber);
  // userRound already defined above
  if (valueGap > 0) {
    // Value steal — player fell past their ADP.
    // QBs are selected for stack fit, not pure value drift — cap their steal bonus
    // lower so a fallen QB doesn't overwhelm a bring-back target.
    const normalizedValue = valueGap / userRound;
    const stealCap = pos === 'QB' ? 0.20 : 0.60;
    const m = 1 + Math.min(normalizedValue * 0.20, stealCap);
    apply(m, 'Value steal', `fell ${valueGap} picks (ADP ${player.adp} at pick ${myPickNumber})`);
  } else if (valueGap < 0) {
    // Reach penalty — drafting a player ahead of their ADP.
    // Two-stage rate: first 10 picks of reach at a base rate, anything beyond
    // 10 picks at a steeper rate.  Denominator is floored at round 3 so early
    // reaches aren't cripplingly penalised — a 5-pick reach in R1 to complete
    // a stack or grab a falling player shouldn't be nearly blocked.
    // Cap at 70% so even extreme reaches stay in the pool at a heavy discount.
    //
    // Examples (reachGap → penalty):
    //   R1 reach 3  → 3/3 × 0.08 = 0.08 → ×0.92  (was ×0.76)
    //   R1 reach 5  → 5/3 × 0.08 = 0.13 → ×0.87  (was ×0.60)
    //   R1 reach 10 → 10/3 × 0.08 = 0.27 → ×0.73 (was ×0.30)
    //   R4 reach 10 → 10/4 × 0.08 = 0.20 → ×0.80 (unchanged)
    //   R8 reach 15 → (10×0.08+5×0.20)/8 = 0.225 → ×0.775 (unchanged)
    const reachGap      = -valueGap;
    const effectiveRound = Math.max(userRound, 3);
    const baseReach     = Math.min(reachGap, 10);
    const excessReach   = Math.max(0, reachGap - 10);
    const penalty       = Math.min(
      (baseReach * 0.08 + excessReach * 0.20) / effectiveRound,
      0.70
    );
    apply(1 - penalty, 'Reach penalty', `${reachGap} picks early (ADP ${player.adp} at pick ${myPickNumber})`);
  }

  return adpValue * mult;
}

// ── Recommendation ────────────────────────────────────────────────────────────

function getRecommendation(available, myTeam, myPickNumber, stackIntensity = 'medium', exposure = {}, diversifyStrength = 0.5) {
  if (!available.length) return null;
  const needs = getTeamNeeds(myTeam);
  const qbTeams = getMyQBTeams(myTeam);
  const myQBCount = myTeam.filter(p => p.pos === 'QB').length;
  const pool = myQBCount >= 3 ? available.filter(p => p.pos !== 'QB') : available;
  if (!pool.length) return null;

  let best = null, bestVal = -1;
  for (const p of pool) {
    let val = calculateValue(p, needs, myPickNumber, myTeam, stackIntensity);
    // Diversification penalty
    if (diversifyStrength > 0 && exposure[p.id]) {
      val *= (1 - exposure[p.id].exposure_rate * diversifyStrength);
    }
    if (val > bestVal) { bestVal = val; best = p; }
  }
  if (!best) return null;

  const bestGap      = myPickNumber - (best.adp || myPickNumber);
  const bestRound    = myTeam.length + 1;
  const gapThreshold = Math.max(2, bestRound);  // R1→2, R4→4, R8→8
  let reason = `Best ${best.pos} available — ADP ${best.adp}`;
  if (bestGap >= gapThreshold)  reason += ` · 🔥 ${bestGap} picks of value`;
  if (bestGap < -gapThreshold)  reason += ` · ⚠️ reaching ${-bestGap} picks early`;
  if (['WR', 'TE'].includes(best.pos) && qbTeams.has(best.team)) {
    reason += ` · stacks with your ${best.team} QB`;
  } else if (best.pos === 'QB' && passCatcherCount(best.team, myTeam) > 0) {
    reason += ` · completes your ${best.team} stack`;
  }
  const playoffReason = playoffStackReason(best, myTeam);
  if (playoffReason) reason += ` · ${playoffReason}`;
  if (exposure[best.id]?.exposure_rate > 0) {
    reason += ` · ${Math.round(exposure[best.id].exposure_rate * 100)}% exposure`;
  }
  const byeWarn = byeWeekWarning(best, myTeam);
  if (byeWarn) reason += ` · ⚠ ${byeWarn}`;

  return { player: best, reason };
}

// Returns the top N recommendations sorted by value score.
// nextMyPick: overall pick number of my next turn after myPickNumber (for window urgency).
function getTopRecommendations(available, myTeam, myPickNumber, stackIntensity = 'medium', exposure = {}, diversifyStrength = 0.5, n = 5, qbsTaken = 0, nextMyPick = null) {
  if (!available.length) return [];
  const needs = getTeamNeeds(myTeam);
  const qbTeams = getMyQBTeams(myTeam);
  const myQBCount = myTeam.filter(p => p.pos === 'QB').length;
  const pool = myQBCount >= 3 ? available.filter(p => p.pos !== 'QB') : available;
  if (!pool.length) return [];
  const qbAlert = qbTierLabel(qbsTaken, myQBCount);

  // Pre-compute availability maps once — passed into calculateValue per player.
  // FA players (no real NFL team) are excluded so they don't contaminate stack lookups.
  const availQBByTeam = {};
  for (const p of available) {
    if (p.pos === 'QB' && hasRealTeam(p)) {
      if (!availQBByTeam[p.team] || (p.adp || 999) < (availQBByTeam[p.team].adp || 999)) {
        availQBByTeam[p.team] = p;
      }
    }
  }
  const availPCByTeam = {};
  for (const p of available) {
    if (['WR', 'TE'].includes(p.pos) && hasRealTeam(p)) {
      (availPCByTeam[p.team] = availPCByTeam[p.team] || []).push(p);
    }
  }
  for (const t in availPCByTeam) availPCByTeam[t].sort((a, b) => (a.adp || 999) - (b.adp || 999));

  const scored = pool.map(p => {
    const bd = [];
    let val = calculateValue(p, needs, myPickNumber, myTeam, stackIntensity, qbsTaken, availQBByTeam, availPCByTeam, nextMyPick, bd);
    if (diversifyStrength > 0 && exposure[p.id]) {
      const divMult = 1 - exposure[p.id].exposure_rate * diversifyStrength;
      if (Math.abs(divMult - 1) > 0.001) bd.push({ label: 'Diversify', mult: divMult, note: `${Math.round(exposure[p.id].exposure_rate * 100)}% exposure` });
      val *= divMult;
    }
    const baseScore = 1000 / (p.adp || 1);

    const gap        = myPickNumber - (p.adp || myPickNumber);
    const pRound     = myTeam.length + 1;
    const pGapThresh = Math.max(2, pRound);
    const pcCount    = passCatcherCount(p.team, myTeam);

    let reason = gap >= pGapThresh ? `🔥 ${gap} picks of value`
               : gap < -pGapThresh ? `⚠️ reaching ${-gap} picks early`
               : '';

    // Stack relationship to current roster
    if (['WR', 'TE'].includes(p.pos) && qbTeams.has(p.team)) {
      reason = reason ? `${reason} · stacks w/ your ${p.team} QB` : `stacks w/ your ${p.team} QB`;
    } else if (['WR', 'TE'].includes(p.pos) && pcCount >= 1) {
      reason = reason ? `${reason} · builds ${p.team} receiver room` : `builds ${p.team} receiver room`;
    } else if (p.pos === 'QB' && pcCount > 0) {
      const pcNames = myTeam.filter(t => t.team === p.team && ['WR','TE'].includes(t.pos))
        .map(t => t.name.split(' ').pop()).join(', ');
      reason = reason ? `${reason} · completes ${p.team} stack (have ${pcNames})` : `completes ${p.team} stack (have ${pcNames})`;
    } else if (p.pos === 'RB' && myTeam.some(t => t.team === p.team)) {
      reason = reason ? `${reason} · ${p.team} game-script correlation` : `${p.team} game-script correlation`;
    }

    // Stack co-availability (WR/TE only — QB stackReady removed to avoid over-pushing QBs)
    if (['WR', 'TE'].includes(p.pos) && !qbTeams.has(p.team) && availQBByTeam[p.team]) {
      const qb = availQBByTeam[p.team];
      if ((qb.adp || 999) <= 144) {
        reason = reason ? `${reason} · ${qb.name.split(' ').pop()} still avail` : `${qb.name.split(' ').pop()} still avail`;
      }
    }

    // Bring-back window urgency signal
    if (p.pos === 'QB' && pcCount > 0 && nextMyPick != null) {
      const windowSize = Math.max(1, nextMyPick - myPickNumber);
      const adpGap     = Math.max(0, (p.adp || myPickNumber) - myPickNumber);
      if (adpGap < windowSize) {
        reason = reason ? `${reason} · ⚠ grab now — likely gone by next pick` : `⚠ grab now — likely gone by next pick`;
      }
    }

    const pr = playoffStackReason(p, myTeam);
    if (pr) reason = reason ? `${reason} · ${pr}` : pr;
    if (exposure[p.id]?.exposure_rate > 0) {
      const expStr = `${Math.round(exposure[p.id].exposure_rate * 100)}% exp`;
      reason = reason ? `${reason} · ${expStr}` : expStr;
    }
    const byeWarn = byeWeekWarning(p, myTeam);
    if (byeWarn) reason = reason ? `${reason} · ⚠ ${byeWarn}` : `⚠ ${byeWarn}`;
    if (p.pos === 'QB' && qbAlert) {
      reason = reason ? `${reason} · ⚡ ${qbAlert}` : `⚡ ${qbAlert}`;
    }

    return { player: p, value: val, reason, bd, baseScore };
  });

  scored.sort((a, b) => b.value - a.value);
  return scored.slice(0, n);
}

// ── Monte Carlo best-ball simulation ─────────────────────────────────────────
// Simulates N full seasons to estimate expected best-ball score for a roster.
// Uses player prop projections when available; falls back to ADP-derived estimates.
//
// Best-ball lineup each week: 1 QB · 2 RB · 3 WR · 1 TE · 1 FLEX (RB/WR/TE)
// Weekly scores modelled as Normal(mean/17, stddev) floored at 0.
// Position CVs (σ / μ): QB 0.35 · RB 0.55 · WR 0.75 · TE 0.65

const MC_POS_CV = { QB: 0.35, RB: 0.55, WR: 0.75, TE: 0.65 };
const MC_WEEKS  = 17;
const MC_N      = 300;

// Box-Muller: standard normal sample
function randn() {
  let u, v;
  do { u = Math.random(); } while (u === 0);
  do { v = Math.random(); } while (v === 0);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ADP → rough season projection for players with no prop data.
// Calibrated so ADP 1 ≈ 280 pts, ADP 50 ≈ 68 pts, ADP 100 ≈ 50 pts.
function adpToProjection(adp) {
  return Math.max(8, 280 * Math.pow(Math.max(adp, 1), -0.4));
}

// Pick the best possible lineup from a set of weekly scores.
function bestBallWeekScore(weeklyScores) {
  const by = { QB: [], RB: [], WR: [], TE: [] };
  for (const { pos, score } of weeklyScores) {
    if (by[pos]) by[pos].push(score);
  }
  for (const arr of Object.values(by)) arr.sort((a, b) => b - a);

  const score = (by.QB[0] || 0)
    + (by.RB[0] || 0) + (by.RB[1] || 0)
    + (by.WR[0] || 0) + (by.WR[1] || 0) + (by.WR[2] || 0)
    + (by.TE[0] || 0)
    + Math.max(by.RB[2] || 0, by.WR[3] || 0, by.TE[1] || 0);  // FLEX
  return score;
}

// Simulate N seasons and return the expected best-ball season score.
function simulateSeason(roster, projections, N = MC_N) {
  if (!roster.length) return 0;

  const stats = roster.map(p => {
    const proj = projections[p.id];
    const seasonMean   = proj ? proj.mean          : adpToProjection(p.adp);
    const weeklyMean   = seasonMean / MC_WEEKS;
    const weeklyStddev = proj ? proj.weekly_stddev : weeklyMean * (MC_POS_CV[p.pos] || 0.5);
    return { pos: p.pos, weeklyMean, weeklyStddev };
  });

  let total = 0;
  for (let i = 0; i < N; i++) {
    let season = 0;
    for (let w = 0; w < MC_WEEKS; w++) {
      const scores = stats.map(s => ({
        pos:   s.pos,
        score: Math.max(0, s.weeklyMean + s.weeklyStddev * randn()),
      }));
      season += bestBallWeekScore(scores);
    }
    total += season;
  }
  return total / N;
}

// Marginal contribution: expected season-score gain from adding one player.
// Runs two simulations (base roster, then roster + candidate) and returns the delta.
function mcMarginalContribution(player, currentRoster, projections, N = MC_N) {
  const base = simulateSeason(currentRoster, projections, N);
  const with_ = simulateSeason([...currentRoster, player], projections, N);
  return with_ - base;
}

// ── Stack summary (for overlay display) ──────────────────────────────────────

function getStackSummary(myTeam) {
  const teamCounts = getTeamCounts(myTeam);
  return Object.entries(teamCounts)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([team, count]) => {
      const players = myTeam.filter(p => p.team === team);
      const positions = players.map(p => p.pos).join('+');
      return { team, count, positions, players };
    });
}

// ── Snake draft helpers ───────────────────────────────────────────────────────

function isMyTurn(overallPick, numTeams, myPosition) {
  if (!numTeams || !myPosition) return false;
  const round = Math.floor((overallPick - 1) / numTeams);
  const posInRound = (overallPick - 1) % numTeams;
  const mySlot = round % 2 === 0 ? myPosition - 1 : numTeams - myPosition;
  return posInRound === mySlot;
}

function nextMyOverallPick(fromPick, numTeams, myPosition) {
  if (!numTeams || !myPosition) return fromPick;
  for (let pick = fromPick; pick <= numTeams * 20; pick++) {
    const round = Math.floor((pick - 1) / numTeams);
    const posInRound = (pick - 1) % numTeams;
    const mySlot = round % 2 === 0 ? myPosition - 1 : numTeams - myPosition;
    if (posInRound === mySlot) return pick;
  }
  return null;
}

function picksUntilMyTurn(overallPick, numTeams, myPosition) {
  if (isMyTurn(overallPick, numTeams, myPosition)) return 0;
  const next = nextMyOverallPick(overallPick + 1, numTeams, myPosition);
  return next != null ? next - overallPick : 0;
}

function currentRound(overallPick, numTeams) {
  if (!numTeams) return null;
  return Math.floor((overallPick - 1) / numTeams) + 1;
}
