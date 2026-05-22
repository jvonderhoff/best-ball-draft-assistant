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

// Returns a warning string if this player would create a bye week crunch, else null.
// Teammates are excluded from the count for the same reason.
function byeWeekWarning(player, myTeam) {
  if (!player.bye) return null;
  const counts = getByeWeekCounts(myTeam, player.team);
  const existing = counts[player.bye] || 0;
  if (existing < 2) return null;
  return `${existing + 1} non-teammate players on bye wk${player.bye}`;
}

// ── Core value calculation ────────────────────────────────────────────────────

function calculateValue(player, needs, myPickNumber, myTeam, stackIntensity = 'medium') {
  const adpValue = Math.max(0, 100 - player.adp);
  const pos = player.pos;

  // ADP is the primary signal. RB and WR are treated as a single interchangeable
  // pool — they compete on pure ADP with no positional tilt between them.
  // Pace-based adjustment only applies to QB and TE (genuinely scarce/capped slots).
  const targets = { QB: 2, TE: 2 };
  const totalDrafted = myTeam.length;
  let mult = 1.0;

  if (totalDrafted > 0 && (pos === 'QB' || pos === 'TE')) {
    const pace  = totalDrafted / 20;                          // 0→1 as roster fills
    const ideal = (targets[pos] || 0) * pace;                // where you should be
    const actual = myTeam.filter(p => p.pos === pos).length;
    const deficit = ideal - actual;                           // + = behind, - = ahead
    // Max ±15% adjustment, grows with imbalance
    mult += Math.max(-0.15, Math.min(0.15, deficit * 0.07));
  }

  // Hard discount when a position slot is fully filled
  if ((needs[pos] || 0) === 0) mult = Math.min(mult, 0.65);

  // Early-round boost (position-agnostic — amplifies stacking/playoff bonuses)
  const round = Math.floor(myPickNumber / 5) + 1;
  if (round <= 3) mult *= 1.1;

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

  // Playoff game stack bonus — week 17 weighted most heavily
  mult *= getPlayoffBonus(player, myTeam);

  // Bye week penalty — discourage stacking too many players on the same bye
  mult *= getByeWeekPenalty(player, myTeam);

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

  let reason = `Best ${best.pos} available — ADP ${best.adp}`;
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
function getTopRecommendations(available, myTeam, myPickNumber, stackIntensity = 'medium', exposure = {}, diversifyStrength = 0.5, n = 5) {
  if (!available.length) return [];
  const needs = getTeamNeeds(myTeam);
  const qbTeams = getMyQBTeams(myTeam);
  const myQBCount = myTeam.filter(p => p.pos === 'QB').length;
  const pool = myQBCount >= 3 ? available.filter(p => p.pos !== 'QB') : available;
  if (!pool.length) return [];

  const scored = pool.map(p => {
    let val = calculateValue(p, needs, myPickNumber, myTeam, stackIntensity);
    if (diversifyStrength > 0 && exposure[p.id]) {
      val *= (1 - exposure[p.id].exposure_rate * diversifyStrength);
    }

    let reason = '';
    if (['WR', 'TE'].includes(p.pos) && qbTeams.has(p.team)) {
      reason = `stacks w/ your ${p.team} QB`;
    } else if (['WR', 'TE'].includes(p.pos) && passCatcherCount(p.team, myTeam) >= 1) {
      reason = `builds ${p.team} receiver room`;
    } else if (p.pos === 'QB' && passCatcherCount(p.team, myTeam) > 0) {
      reason = `completes ${p.team} stack`;
    } else if (p.pos === 'RB' && myTeam.some(t => t.team === p.team)) {
      reason = `${p.team} game-script correlation`;
    }
    const pr = playoffStackReason(p, myTeam);
    if (pr) reason = reason ? `${reason} · ${pr}` : pr;
    if (exposure[p.id]?.exposure_rate > 0) {
      const expStr = `${Math.round(exposure[p.id].exposure_rate * 100)}% exp`;
      reason = reason ? `${reason} · ${expStr}` : expStr;
    }
    const byeWarn = byeWeekWarning(p, myTeam);
    if (byeWarn) reason = reason ? `${reason} · ⚠ ${byeWarn}` : `⚠ ${byeWarn}`;

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
