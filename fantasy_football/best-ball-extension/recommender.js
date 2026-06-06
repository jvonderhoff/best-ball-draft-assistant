// Draft recommendation engine

// ── Stack bonus multipliers by intensity ──────────────────────────────────────
// first      = 1st pass-catcher (WR/TE) from your QB's team
// second     = 2nd pass-catcher from same QB's team
// qbPull     = QB whose pass-catchers you already own
// cluster    = 2nd+ WR/TE from a team even without the QB (building a receiver room)
// rbCorrel   = RB from a team where you already have other players (correlated scoring)

const STACK_SETTINGS = {
  off:    { first: 1.00, second: 1.00, qbPull: 1.00, cluster: 1.00, rbCorrel: 1.00 },
  light:  { first: 1.15, second: 1.05, qbPull: 1.10, cluster: 1.05, rbCorrel: 1.03 },
  medium: { first: 1.25, second: 1.10, qbPull: 1.18, cluster: 1.10, rbCorrel: 1.05 },
  heavy:  { first: 1.40, second: 1.18, qbPull: 1.28, cluster: 1.15, rbCorrel: 1.08 },
};

// ── QB run detection ──────────────────────────────────────────────────────────
// Detects when multiple QBs are being drafted in opponent picks since your last
// turn, signaling you may miss a QB tier if you don't act now.
//
// recentOppPicks: [{pos, pick_number}] — opponent picks since your last pick.
// 0–1 QBs → no boost | 2 QBs → ×1.15 | 3+ QBs → ×1.25
function getQBRunBoost(recentOppPicks) {
  const qbCount = recentOppPicks.filter(p => p.pos === 'QB').length;
  if (qbCount < 2) return 1.0;
  return qbCount === 2 ? 1.15 : 1.25;
}

// Human-readable label for active QB run, or null.
function qbRunLabel(recentOppPicks) {
  const qbCount = recentOppPicks.filter(p => p.pos === 'QB').length;
  if (qbCount < 2) return null;
  return `QB run — ${qbCount} QB${qbCount > 1 ? 's' : ''} taken since your last pick`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTeamCounts(myTeam) {
  const counts = {};
  myTeam.forEach(p => { counts[p.team] = (counts[p.team] || 0) + 1; });
  return counts;
}

function getMyQBTeams(myTeam) {
  return new Set(myTeam.filter(p => p.pos === 'QB').map(p => p.team));
}

// Returns how many WR/TE I already have from a given team
function passCatcherCount(team, myTeam) {
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

const PLAYOFF_BONUS = { week17: 1.15, week16: 1.04, week15: 1.02 };
const PLAYOFF_BONUS_CAP = 1.40;

// Returns true if p1 and p2 are in the same game in a given week.
function samePlayoffGame(p1, p2, week) {
  const key = `week${week}`;
  // p1's opponent is p2's team, or vice versa (same game, both directions)
  return (p1[key] && p1[key] === p2.team) || (p2[key] && p2[key] === p1.team);
}

// Returns a multiplier > 1.0 if this player shares playoff games with current team members.
function getPlayoffBonus(player, myTeam) {
  if (!myTeam.length) return 1.0;
  // Only apply when we actually have schedule data
  if (!player.week15 && !player.week16 && !player.week17) return 1.0;

  let mult = 1.0;
  for (const mine of myTeam) {
    for (const week of [17, 16, 15]) {
      if (samePlayoffGame(player, mine, week)) {
        mult *= PLAYOFF_BONUS[`week${week}`];
      }
    }
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
    if (p.bye && p.team !== excludeTeam) counts[p.bye] = (counts[p.bye] || 0) + 1;
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

function calculateValue(player, needs, myPickNumber, myTeam, stackIntensity = 'medium', rbPriority = 'strong', recentOppPicks = []) {
  // Use inverse ADP so value is always positive and naturally orders players.
  // adp=1 → 1000, adp=50 → 20, adp=100 → 10, adp=200 → 5, adp=500 → 2
  // This ensures late-round players still have relative ordering rather than
  // all collapsing to 0 when ADP > 100 (which caused random late-round picks).
  const adpValue = 1000 / (player.adp || 1);
  const pos = player.pos;

  // ADP is the primary signal. RB and WR compete on pure ADP.
  // QB and TE get urgency-based adjustments since they fill capped slots.
  const totalDrafted = myTeam.length;
  const myTEs  = myTeam.filter(p => p.pos === 'TE').length;
  const myQBs  = myTeam.filter(p => p.pos === 'QB').length;
  const userRound = totalDrafted + 1;
  // Late-round zero: if you hit round 13+ with none drafted you'll need 3
  // to maintain adequate position quality across the remaining picks.
  const TE_TARGET = (userRound >= 13 && myTEs === 0) ? 3 : 2;
  const QB_TARGET = (userRound >= 13 && myQBs === 0) ? 3 : 2;
  let mult = 1.0;

  // TE urgency — starts late; you can comfortably grab TE in rounds 10-14.
  //   Rd 5-9:  no boost — WRs/RBs compete freely
  //   Rd 11:   weight 0.25 → mild nudge
  //   Rd 13:   weight 0.75 → meaningful push
  //   Rd 15+:  weight 1.0  → full urgency
  const teUrgencyWeight = Math.max(0, Math.min(1, (userRound - 9) / 7));

  if (pos === 'TE') {
    const teNeeded  = Math.max(0, TE_TARGET - myTEs);
    const picksLeft = Math.max(1, 20 - totalDrafted);
    if (teNeeded > 0) {
      const urgency = (teNeeded / picksLeft) * teUrgencyWeight;
      mult *= (1 + Math.min(urgency * 3.0, 2.0));
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
      const urgency = (qbNeeded / picksLeft) * qbUrgencyWeight;
      mult *= (1 + Math.min(urgency * 3.0, 2.0));
    }
    // Mild pace nudge in earlier rounds (±15%)
    if (totalDrafted > 0) {
      const pace    = totalDrafted / 20;
      const ideal   = QB_TARGET * pace;
      const deficit = ideal - myQBs;
      mult += Math.max(-0.15, Math.min(0.15, deficit * 0.07));
    }
  }

  // Hard discount when a position slot is fully filled
  if ((needs[pos] || 0) === 0) mult = Math.min(mult, 0.65);

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
    mult *= penalty;
  }

  // Early-round boost (position-agnostic — amplifies stacking/playoff bonuses)
  if (userRound <= 3) mult *= 1.1;

  // RB priority — boost RBs in early rounds to encourage drafting them before WRs.
  // Tapers off after round 5 since late RBs carry more risk than late WRs.
  //   mild:    rounds 1-3 ×1.10, rounds 4-5 ×1.05
  //   strong:  rounds 1-3 ×1.20, rounds 4-5 ×1.10
  //   extreme: rounds 1-3 ×1.35, rounds 4-5 ×1.18, rounds 6-7 ×1.08
  // Guard: suppress boost when already RB-heavy relative to WR count.
  // Having ≥2 more RBs than WRs means the roster is imbalanced enough that
  // the urgency signal has already been acted on — don't keep piling on.
  const myRBs = myTeam.filter(p => p.pos === 'RB').length;
  const myWRs = myTeam.filter(p => p.pos === 'WR').length;
  if (pos === 'RB' && rbPriority !== 'off' && myRBs < myWRs + 2) {
    const boosts = {
      mild:    [0, 1.10, 1.10, 1.10, 1.05, 1.05, 1.0],
      strong:  [0, 1.20, 1.20, 1.20, 1.10, 1.10, 1.0],
      extreme: [0, 1.35, 1.35, 1.35, 1.18, 1.18, 1.08, 1.08],
    };
    const table = boosts[rbPriority] || boosts.strong;
    const boost = table[Math.min(userRound, table.length - 1)] || 1.0;
    mult *= boost;
  }

  // Same-team stacking bonuses
  const s = STACK_SETTINGS[stackIntensity] || STACK_SETTINGS.medium;
  if (myTeam && stackIntensity !== 'off') {
    const qbTeams = getMyQBTeams(myTeam);
    const existingCatchers = passCatcherCount(player.team, myTeam);
    const teamMates = myTeam.filter(p => p.team === player.team).length;

    if (['WR', 'TE'].includes(pos)) {
      if (qbTeams.has(player.team)) {
        // Pass-catcher from one of my QB's teams — full QB-stack bonus
        if (existingCatchers === 0)      mult *= s.first;
        else if (existingCatchers === 1) mult *= s.second;
        // 3+ pass-catchers from same QB's team: no bonus (over-concentrated)
      } else if (existingCatchers >= 1) {
        // Already have a pass-catcher from this team but no QB yet —
        // building a receiver room; smaller bonus since correlation is QB-dependent
        mult *= s.cluster;
      }
    }

    if (pos === 'QB') {
      // QB whose pass-catchers I already own
      if (existingCatchers >= 1) mult *= s.qbPull;
    }

    if (pos === 'RB' && teamMates >= 1) {
      // RB from a team I already have players on — correlated game-script value
      // (smaller than pass-catcher stacking since RB/passing correlation is weaker)
      mult *= s.rbCorrel;
    }
  }

  // Playoff game stack bonus — week 17 weighted most heavily.
  // Not applied to QBs — QB stacking should come from same-team pass-catchers
  // only (qbPull bonus above), not from playing against teams you own.
  // Skipped when stack intensity is off so pure ADP/value mode is truly stack-free.
  if (stackIntensity !== 'off' && pos !== 'QB') mult *= getPlayoffBonus(player, myTeam);

  // Bye week penalty — discourage stacking too many players on the same bye
  mult *= getByeWeekPenalty(player, myTeam);

  // QB run boost — amplify QB urgency when opponents are taking QBs fast
  if (pos === 'QB') mult *= getQBRunBoost(recentOppPicks);

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
    // Value steal — player fell past their ADP
    const normalizedValue = valueGap / userRound;
    mult *= (1 + Math.min(normalizedValue * 0.20, 0.60));
  } else if (valueGap < 0) {
    // Reach penalty — drafting a player ahead of their ADP.
    // Two-stage rate: first 10 picks of reach at a base rate, anything beyond
    // 10 picks at a steeper rate.  Dividing by userRound makes later rounds
    // naturally more forgiving — a 12-pick reach in R15 barely matters.
    // Cap at 70% so even extreme reaches stay in the pool at a heavy discount.
    //
    // Examples (reachGap → penalty):
    //   R1 reach 3  → 3/1 × 0.08 = 0.24 → ×0.76
    //   R1 reach 5  → 5/1 × 0.08 = 0.40 → ×0.60
    //   R1 reach 10 → 10/1 × 0.08 = 0.80 → capped 0.70 → ×0.30
    //   R1 reach 15 → (10×0.08 + 5×0.20)/1 = 1.8 → capped → ×0.30
    //   R4 reach 10 → 10/4 × 0.08 = 0.20 → ×0.80
    //   R4 reach 15 → (10×0.08 + 5×0.20)/4 = 0.45 → ×0.55
    //   R8 reach 15 → (10×0.08 + 5×0.20)/8 = 0.225 → ×0.775
    //  R15 reach 20 → (10×0.08 + 10×0.20)/15 = 0.187 → ×0.813
    const reachGap    = -valueGap;
    const baseReach   = Math.min(reachGap, 10);
    const excessReach = Math.max(0, reachGap - 10);
    const penalty     = Math.min(
      (baseReach * 0.08 + excessReach * 0.20) / userRound,
      0.70
    );
    mult *= (1 - penalty);
  }

  return adpValue * mult;
}

// ── Recommendation ────────────────────────────────────────────────────────────

function getRecommendation(available, myTeam, myPickNumber, stackIntensity = 'medium', exposure = {}, diversifyStrength = 0.5, rbPriority = 'strong') {
  if (!available.length) return null;
  const needs = getTeamNeeds(myTeam);
  const qbTeams = getMyQBTeams(myTeam);
  const myQBCount = myTeam.filter(p => p.pos === 'QB').length;
  const pool = myQBCount >= 3 ? available.filter(p => p.pos !== 'QB') : available;
  if (!pool.length) return null;

  let best = null, bestVal = -1;
  for (const p of pool) {
    let val = calculateValue(p, needs, myPickNumber, myTeam, stackIntensity, rbPriority);
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
function getTopRecommendations(available, myTeam, myPickNumber, stackIntensity = 'medium', exposure = {}, diversifyStrength = 0.5, n = 5, rbPriority = 'strong', recentOppPicks = []) {
  if (!available.length) return [];
  const needs = getTeamNeeds(myTeam);
  const qbTeams = getMyQBTeams(myTeam);
  const myQBCount = myTeam.filter(p => p.pos === 'QB').length;
  const pool = myQBCount >= 3 ? available.filter(p => p.pos !== 'QB') : available;
  if (!pool.length) return [];
  const qbRun = qbRunLabel(recentOppPicks);

  const scored = pool.map(p => {
    let val = calculateValue(p, needs, myPickNumber, myTeam, stackIntensity, rbPriority, recentOppPicks);
    if (diversifyStrength > 0 && exposure[p.id]) {
      val *= (1 - exposure[p.id].exposure_rate * diversifyStrength);
    }

    const gap          = myPickNumber - (p.adp || myPickNumber);
    const pRound       = myTeam.length + 1;
    const pGapThresh   = Math.max(2, pRound);
    let reason = gap >= pGapThresh   ? `🔥 ${gap} picks of value`
               : gap < -pGapThresh   ? `⚠️ reaching ${-gap} picks early`
               : '';
    if (['WR', 'TE'].includes(p.pos) && qbTeams.has(p.team)) {
      reason = reason ? `${reason} · stacks w/ your ${p.team} QB` : `stacks w/ your ${p.team} QB`;
    } else if (['WR', 'TE'].includes(p.pos) && passCatcherCount(p.team, myTeam) >= 1) {
      reason = reason ? `${reason} · builds ${p.team} receiver room` : `builds ${p.team} receiver room`;
    } else if (p.pos === 'QB' && passCatcherCount(p.team, myTeam) > 0) {
      reason = reason ? `${reason} · completes ${p.team} stack` : `completes ${p.team} stack`;
    } else if (p.pos === 'RB' && myTeam.some(t => t.team === p.team)) {
      reason = reason ? `${reason} · ${p.team} game-script correlation` : `${p.team} game-script correlation`;
    }
    const pr = playoffStackReason(p, myTeam);
    if (pr) reason = reason ? `${reason} · ${pr}` : pr;
    if (exposure[p.id]?.exposure_rate > 0) {
      const expStr = `${Math.round(exposure[p.id].exposure_rate * 100)}% exp`;
      reason = reason ? `${reason} · ${expStr}` : expStr;
    }
    const byeWarn = byeWeekWarning(p, myTeam);
    if (byeWarn) reason = reason ? `${reason} · ⚠ ${byeWarn}` : `⚠ ${byeWarn}`;
    if (p.pos === 'QB' && qbRun) {
      reason = reason ? `${reason} · ⚡ ${qbRun}` : `⚡ ${qbRun}`;
    }

    return { player: p, value: val, reason };
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
