// Draft recommendation engine

// ── Stack bonus multipliers by intensity ──────────────────────────────────────
// First stacker  = first pass-catcher (WR/TE) drafted from your QB's team
// Second stacker = second pass-catcher from same QB's team
// QB pull        = boost to a QB when you already have his pass-catchers

const STACK_SETTINGS = {
  off:        { first: 1.00, second: 1.00, qbPull: 1.00 },
  light:      { first: 1.15, second: 1.05, qbPull: 1.10 },
  medium:     { first: 1.25, second: 1.10, qbPull: 1.18 },
  heavy:      { first: 1.40, second: 1.18, qbPull: 1.28 },
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
  const targets = { QB: 2, RB: 8, WR: 8, TE: 2 };
  const needs = {};
  for (const [pos, target] of Object.entries(targets)) {
    needs[pos] = Math.max(0, target - (counts[pos] || 0));
  }
  return needs;
}

// ── Core value calculation ────────────────────────────────────────────────────

function calculateValue(player, needs, myPickNumber, myTeam, stackIntensity = 'medium') {
  const adpValue = Math.max(0, 100 - player.adp);
  const pos = player.pos;

  // Position/need multiplier
  let mult = 1.0;
  if (pos === 'QB')      mult = needs.QB > 0 ? 0.9 : 0.6;
  else if (pos === 'RB') mult = needs.RB > 0 ? 1.3 : 1.0;
  else if (pos === 'WR') mult = needs.WR > 0 ? 1.2 : 0.9;
  else if (pos === 'TE') mult = needs.TE > 0 ? 1.1 : 0.7;

  // Early-round value boost
  const round = Math.floor(myPickNumber / 5) + 1;
  if (round <= 3) mult *= 1.1;

  // Stacking bonus
  const s = STACK_SETTINGS[stackIntensity] || STACK_SETTINGS.medium;
  if (myTeam && stackIntensity !== 'off') {
    const qbTeams = getMyQBTeams(myTeam);

    if (['WR', 'TE'].includes(pos) && qbTeams.has(player.team)) {
      // Pass-catcher from one of my QB's teams
      const existing = passCatcherCount(player.team, myTeam);
      if (existing === 0)      mult *= s.first;   // first stacker
      else if (existing === 1) mult *= s.second;  // second stacker (diminishing)
      // 3+ stackers: no bonus (don't over-concentrate)
    }

    if (pos === 'QB') {
      // QB whose pass-catchers I already own
      const catchers = passCatcherCount(player.team, myTeam);
      if (catchers >= 1) mult *= s.qbPull;
    }
  }

  return adpValue * mult;
}

// ── Recommendation ────────────────────────────────────────────────────────────

function getRecommendation(available, myTeam, myPickNumber, stackIntensity = 'medium', exposure = {}, diversifyStrength = 0.5) {
  if (!available.length) return null;
  const needs = getTeamNeeds(myTeam);
  const qbTeams = getMyQBTeams(myTeam);

  let best = null, bestVal = -1;
  for (const p of available) {
    let val = calculateValue(p, needs, myPickNumber, myTeam, stackIntensity);
    // Diversification penalty
    if (diversifyStrength > 0 && exposure[p.id]) {
      val *= (1 - exposure[p.id].exposure_rate * diversifyStrength);
    }
    if (val > bestVal) { bestVal = val; best = p; }
  }
  if (!best) return null;

  let reason = `Best ${best.pos} available — ADP ${best.adp}, ${best.dk_proj} proj pts`;
  if (['WR', 'TE'].includes(best.pos) && qbTeams.has(best.team)) {
    reason += ` · stacks with your ${best.team} QB`;
  } else if (best.pos === 'QB' && passCatcherCount(best.team, myTeam) > 0) {
    reason += ` · completes your ${best.team} stack`;
  }
  if (exposure[best.id]?.exposure_rate > 0) {
    reason += ` · ${Math.round(exposure[best.id].exposure_rate * 100)}% exposure`;
  }

  return { player: best, reason };
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
