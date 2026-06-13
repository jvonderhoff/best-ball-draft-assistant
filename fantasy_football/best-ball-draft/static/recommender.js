// Draft recommendation engine

// ── Stack bonus multipliers by intensity ──────────────────────────────────────
// first      = 1st pass-catcher (WR/TE) from your QB's team
// second     = 2nd pass-catcher from same QB's team
// qbPull     = QB whose pass-catchers you already own
// cluster    = 2nd+ WR/TE from a team even without the QB (building a receiver room)
// rbCorrel   = RB from a team where you already have other players (correlated scoring)

const STACK_SETTINGS = {
  //            first   second  qbPull  cluster rbCorrel
  off:    { first: 1.00, second: 1.00, qbPull: 1.00, cluster: 1.00, rbCorrel: 1.00 },
  light:  { first: 1.15, second: 1.05, qbPull: 1.15, cluster: 1.05, rbCorrel: 1.03 },
  medium: { first: 1.25, second: 1.10, qbPull: 1.35, cluster: 1.10, rbCorrel: 1.05 },
  heavy:  { first: 1.40, second: 1.18, qbPull: 1.40, cluster: 1.15, rbCorrel: 1.08 },
};

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
// is lower. Multi-partner stacks stay strong.
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

// ── Draft capital allocation ──────────────────────────────────────────────────
// Base roster targets for an 18-round best-ball draft.
const BASE_TARGETS  = { QB: 2, RB: 6, WR: 8, TE: 2 };
const DRAFT_ROUNDS  = 18;

// ADP gap between the last "needed" player at a position and the next one after.
// A large gap means the position gets dramatically worse if you wait — high scarcity.
function positionalAdpCliff(pos, available, stillNeed) {
  if (stillNeed <= 0) return 0;
  const atPos = available
    .filter(p => p.pos === pos && p.adp)
    .sort((a, b) => a.adp - b.adp);
  if (atPos.length < stillNeed) return 150; // almost none left — critical
  const lastNeeded = atPos[stillNeed - 1];
  const firstAfter = atPos[stillNeed];
  if (!firstAfter) return 80;
  return firstAfter.adp - lastNeeded.adp;
}

// Dynamic target: expands when you're behind pace so catch-up drafting isn't
// penalized. If you skipped TE early, target grows so taking a 3rd or 4th TE
// late registers as filling a need rather than over-spending.
//
// expectedSoFar: linear pace of base target through the current round.
// catchup: how many behind pace you are (capped at base so it can't double).
function dynamicTarget(pos, myTeam) {
  const base   = BASE_TARGETS[pos] || 4;
  const have   = myTeam.filter(p => p.pos === pos).length;
  const round  = myTeam.length + 1;
  const expectedSoFar = base * (round / DRAFT_ROUNDS);
  const catchup = Math.min(base, Math.max(0, Math.round(expectedSoFar) - have));
  return base + catchup;
}

// Returns { mult, target, need, cliff, totalDeficit } for use in calculateValue.
//   mult > 1.0  scarce position: next viable option is far down the board, grab now
//   mult < 1.0  over-allocated: at/above dynamic target while other positions need help
//               penalty fades in late rounds where cheap depth has low opportunity cost
function capitalAllocationInfo(player, myTeam, available) {
  if (!available || !available.length) return { mult: 1.0, target: 0, need: 0, cliff: 0, totalDeficit: 0 };
  const pos    = player.pos;
  const target = dynamicTarget(pos, myTeam);
  const have   = myTeam.filter(p => p.pos === pos).length;
  const need   = target - have;
  const round  = myTeam.length + 1;

  if (need > 0) {
    const cliff    = positionalAdpCliff(pos, available, need);
    const scarcity = Math.min(1.0, cliff / 40);
    return { mult: 1 + scarcity * 0.20, target, need, cliff, totalDeficit: 0 };
  }

  // Over dynamic target — penalty scales with how many other positions need help,
  // but fades in late rounds (13+) where cheap depth picks have low opportunity cost.
  const totalDeficit = Object.entries(BASE_TARGETS).reduce((sum, [p, t]) => {
    if (p === pos) return sum;
    return sum + Math.max(0, t - myTeam.filter(m => m.pos === p).length);
  }, 0);
  const maxDeficit      = Object.values(BASE_TARGETS).reduce((a, b) => a + b, 0);
  const lateFade        = Math.max(0, Math.min(1, (DRAFT_ROUNDS - round) / 5));
  const penaltyStrength = (totalDeficit / maxDeficit) * 0.20 * lateFade;
  return { mult: 1 - penaltyStrength, target, need, cliff: 0, totalDeficit };
}

// ── Bye week helpers ──────────────────────────────────────────────────────────

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

// nextMyPick: overall pick number of my NEXT turn after this one (for window urgency)
// bd (breakdown): optional array — if provided, each applied multiplier is pushed as
// { label, mult, note } so callers can explain the score to the user.
function calculateValue(player, myPickNumber, myTeam, stackIntensity = 'medium', nextMyPick = null, available = [], bd = null) {
  // Use inverse ADP so value is always positive and naturally orders players.
  // adp=1 → 1000, adp=50 → 20, adp=100 → 10, adp=200 → 5, adp=500 → 2
  // This ensures late-round players still have relative ordering rather than
  // all collapsing to 0 when ADP > 100 (which caused random late-round picks).
  const adpValue = 1000 / (player.adp || 1);
  const pos = player.pos;
  // Helper: apply multiplier and optionally record it
  const apply = (m, label, note) => { mult *= m; if (bd && Math.abs(m - 1) > 0.001) bd.push({ label, mult: m, note }); };

  const totalDrafted = myTeam.length;
  const myTEs  = myTeam.filter(p => p.pos === 'TE').length;
  const myQBs  = myTeam.filter(p => p.pos === 'QB').length;
  const myWRs  = myTeam.filter(p => p.pos === 'WR').length;
  const userRound = totalDrafted + 1;
  const TE_TARGET = 2;
  const QB_TARGET = 2;
  const qbTeams = getMyQBTeams(myTeam);
  let mult = 1.0;

  // Zero QB emergency — having no QB past round 8 is a critical situation.
  // Scales from ×1.30 at round 9 up to ×2.00 at round 16+, overriding the normal urgency math.
  if (pos === 'QB' && myQBs === 0 && userRound >= 9) {
    const emergencyBoost = 1 + Math.min(1.0, (userRound - 8) * 0.10);
    apply(emergencyBoost, 'QB emergency', `0 QBs in round ${userRound}`);
  }

  // Bye week penalty for 2nd/3rd QB sharing a bye with an existing QB.
  // With only 2-3 QBs rostered, a shared bye means zero QB coverage that week.
  if (pos === 'QB' && myQBs >= 1 && player.bye) {
    const qbByeClash = myTeam.find(p => p.pos === 'QB' && p.bye === player.bye && hasRealTeam(p));
    if (qbByeClash) {
      apply(0.70, 'QB bye clash', `same bye wk${player.bye} as ${qbByeClash.name.split(' ').pop()}`);
    }
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
        // PC-count ceiling: each extra catcher adds 60% of the remaining gap above qbPull.
        // 1 PC → ceiling = qbPull
        // 2 PC → ceiling = qbPull + 0.60 × (2.0 - qbPull)
        // 3 PC → ceiling = qbPull + 0.84 × (2.0 - qbPull)  [compounded]
        const extraCatchers = Math.min(existingCatchers - 1, 2);
        const ceilingBoost  = 1 - Math.pow(0.4, extraCatchers);           // 0 / 0.60 / 0.84
        const ceiling       = s.qbPull + ceilingBoost * (2.0 - s.qbPull);

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

    if (pos === 'RB' && myTeam.some(t => t.team === player.team && t.pos !== 'RB')) {
      apply(s.rbCorrel, 'Stack: RB correl', `${player.team} game-script`);
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


  // Draft capital allocation: scarcity bonus or over-allocation penalty.
  // Target is dynamic — expands when behind pace so catch-up drafting isn't penalized.
  // Skipped in stack-off mode to keep that mode a pure ADP/value signal.
  if (stackIntensity !== 'off') {
    const { mult: capMult, target: capTarget, need: capNeed, cliff: capCliff, totalDeficit } = capitalAllocationInfo(player, myTeam, available);
    const have = myTeam.filter(p => p.pos === pos).length;
    if (capMult > 1.001) {
      apply(capMult, 'Capital: scarce', `need ${capNeed} more ${pos} (target ${capTarget}), next tier +${Math.round(capCliff)} picks away`);
    }
    if (capMult < 0.999) {
      apply(capMult, 'Capital: over-alloc', `${pos} at ${have}/${capTarget}, ${totalDeficit} spots needed elsewhere`);
    }
  }

  // Value-steal boost / reach penalty: compares ADP to current overall pick.
  // Normalised by round (floored at 3) so early gaps carry more weight.
  //
  // BOOST: player fell past ADP  →  ×(1 + gap/round × 0.20), capped +60%
  //   R1 gap=3  → ×1.20  |  R4 gap=10 → ×1.50  |  R8 gap=10 → ×1.25
  //   QBs capped at +20% — stack fit matters more than value drift for QBs.
  //
  // PENALTY: reaching ahead of ADP  →  ×(1 − gap/round × 0.10), capped at ×0.30
  //   R1 reach=3  → ×0.90  |  R4 reach=10 → ×0.75  |  R8 reach=15 → ×0.81
  const valueGap = myPickNumber - (player.adp || myPickNumber);
  const effectiveRound = Math.max(userRound, 3);
  if (valueGap > 0) {
    const stealCap = pos === 'QB' ? 0.20 : 0.60;
    const m = 1 + Math.min((valueGap / effectiveRound) * 0.20, stealCap);
    apply(m, 'Value steal', `fell ${valueGap} picks (ADP ${player.adp} at pick ${myPickNumber})`);
  } else if (valueGap < 0) {
    const penalty = Math.min(((-valueGap) / effectiveRound) * 0.10, 0.70);
    apply(1 - penalty, 'Reach penalty', `${-valueGap} picks early (ADP ${player.adp} at pick ${myPickNumber})`);
  }

  return adpValue * mult;
}

// ── Recommendation ────────────────────────────────────────────────────────────

// Returns the top N recommendations sorted by value score.
// nextMyPick: overall pick number of my next turn after myPickNumber (for window urgency).
function getTopRecommendations(available, myTeam, myPickNumber, stackIntensity = 'medium', n = 5, nextMyPick = null) {
  if (!available.length) return [];
  const qbTeams = getMyQBTeams(myTeam);
  const pool = available;
  if (!pool.length) return [];

  const scored = pool.map(p => {
    const bd = [];
    const val = calculateValue(p, myPickNumber, myTeam, stackIntensity, nextMyPick, pool, bd);
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
    // QB-specific bye clash warning (2 QBs on same bye = zero QB coverage that week)
    if (p.pos === 'QB' && p.bye) {
      const qbByeClash = myTeam.find(t => t.pos === 'QB' && t.bye === p.bye && hasRealTeam(t));
      if (qbByeClash) {
        const clashName = qbByeClash.name.split(' ').pop();
        reason = reason ? `${reason} · ⚠ QB bye clash wk${p.bye} w/ ${clashName}` : `⚠ QB bye clash wk${p.bye} w/ ${clashName}`;
      }
    }
    const byeWarn = byeWeekWarning(p, myTeam);
    if (byeWarn) reason = reason ? `${reason} · ⚠ ${byeWarn}` : `⚠ ${byeWarn}`;
    return { player: p, value: val, reason, bd, baseScore };
  });

  scored.sort((a, b) => b.value - a.value);
  return scored.slice(0, n);
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
