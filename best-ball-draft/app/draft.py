from app.data.players import get_all_players, DEFENSES, KICKERS
from collections import defaultdict

class DraftState:
    """Manages the state of a best ball draft."""

    def __init__(self):
        self.available_players = {p['id']: p for p in get_all_players() + DEFENSES + KICKERS}
        self.drafted_players = []   # all taken players (mine + others)
        self.my_team = []
        self.pick_number = 1        # my picks made + 1
        self.overall_pick = 1       # overall pick across all teams
        self.total_picks = 20       # how many picks I make total
        self.num_teams = None
        self.my_position = None

    @property
    def is_setup(self):
        return self.num_teams is not None and self.my_position is not None

    def setup(self, num_teams, my_position):
        self.num_teams = num_teams
        self.my_position = my_position

    # --- Snake draft helpers ---

    def _my_slot_in_round(self, round_num):
        """0-indexed position within a round that belongs to me."""
        if round_num % 2 == 0:  # ascending
            return self.my_position - 1
        else:                    # descending
            return self.num_teams - self.my_position

    def is_my_turn(self):
        if not self.is_setup:
            return True
        round_num = (self.overall_pick - 1) // self.num_teams
        pos_in_round = (self.overall_pick - 1) % self.num_teams
        return pos_in_round == self._my_slot_in_round(round_num)

    def _next_my_overall_pick(self, from_pick=None):
        """Overall pick number of the next pick that belongs to me."""
        if not self.is_setup:
            return self.overall_pick
        pick = from_pick or self.overall_pick
        for _ in range(self.num_teams * self.total_picks):
            round_num = (pick - 1) // self.num_teams
            pos_in_round = (pick - 1) % self.num_teams
            if pos_in_round == self._my_slot_in_round(round_num):
                return pick
            pick += 1
        return None

    def picks_until_my_turn(self):
        if self.is_my_turn():
            return 0
        next_pick = self._next_my_overall_pick(self.overall_pick + 1)
        if next_pick is None:
            return 0
        return next_pick - self.overall_pick

    # --- Drafting ---

    def draft_player(self, player_id):
        """Draft a player to your team."""
        if player_id not in self.available_players:
            raise ValueError(f"Player {player_id} not available")
        player = self.available_players.pop(player_id)
        self.drafted_players.append(player)
        self.my_team.append(player)
        self.pick_number += 1
        self.overall_pick += 1
        return player

    def mark_taken(self, player_id):
        """Mark a player as taken by another team."""
        if player_id not in self.available_players:
            raise ValueError(f"Player {player_id} not available")
        player = self.available_players.pop(player_id)
        self.drafted_players.append(player)
        self.overall_pick += 1
        return player

    def get_available_players(self):
        return list(self.available_players.values())

    def is_draft_complete(self):
        return len(self.my_team) >= self.total_picks

    def reset(self):
        self.__init__()

    # --- Analysis ---

    def _get_position_counts(self, team):
        counts = defaultdict(int)
        for player in team:
            counts[player['pos']] += 1
        return counts

    def get_team_needs(self):
        pos_counts = self._get_position_counts(self.my_team)
        targets = {'QB': 2, 'RB': 8, 'WR': 8, 'TE': 2}
        return {pos: max(0, target - pos_counts.get(pos, 0)) for pos, target in targets.items()}

    def _calculate_position_value(self, player, needs):
        pos = player['pos']
        adp_value = max(0, 100 - player['adp'])
        pos_multiplier = 1.0
        if pos == 'QB':
            pos_multiplier = 0.9 if needs.get('QB', 0) > 0 else 0.6
        elif pos == 'RB':
            pos_multiplier = 1.3 if needs.get('RB', 0) > 0 else 1.0
        elif pos == 'WR':
            pos_multiplier = 1.2 if needs.get('WR', 0) > 0 else 0.9
        elif pos == 'TE':
            pos_multiplier = 1.1 if needs.get('TE', 0) > 0 else 0.7
        round_num = self.pick_number // 5 + 1
        if round_num <= 3 and pos not in ['K', 'DEF']:
            pos_multiplier *= 1.1
        return adp_value * pos_multiplier

    def get_autopick_suggestion(self, exposure=None, diversify_strength=0.5):
        """
        exposure: dict of player_id -> exposure_rate (0.0-1.0) from the database.
        diversify_strength: 0 = ignore exposure, 1 = maximum penalty for over-exposed players.
        """
        if self.is_draft_complete():
            return None
        needs = self.get_team_needs()
        available = self.get_available_players()
        if not available:
            return None

        scored = []
        for p in available:
            val = self._calculate_position_value(p, needs)
            # Diversification penalty: reduce value for players drafted heavily in past
            if exposure and diversify_strength > 0:
                exp_rate = exposure.get(p['id'], {}).get('exposure_rate', 0)
                val *= (1 - exp_rate * diversify_strength)
            scored.append((p, val))

        scored.sort(key=lambda x: x[1], reverse=True)
        best_player, value = scored[0]

        reason = f"Strong {best_player['pos']} value (ADP: {best_player['adp']})"
        if exposure:
            exp = exposure.get(best_player['id'], {})
            if exp.get('exposure_rate', 0) > 0:
                pct = round(exp['exposure_rate'] * 100)
                reason += f" · {pct}% exposure"

        return {'player': best_player, 'reason': reason, 'value_score': value}

    def get_unique_teams(self):
        return set(p['team'] for p in self.my_team)

    def get_team_composition(self):
        return self._get_position_counts(self.my_team)

    def meets_team_requirements(self):
        unique_teams = self.get_unique_teams()
        composition = self.get_team_composition()
        if len(unique_teams) < 2:
            return False, f"Need players from 2+ teams ({len(unique_teams)}/2)"
        if composition.get('QB', 0) < 1:
            return False, "Need at least 1 QB"
        if composition.get('RB', 0) < 2:
            return False, "Need at least 2 RBs"
        if composition.get('WR', 0) < 3:
            return False, "Need at least 3 WRs"
        if composition.get('TE', 0) < 1:
            return False, "Need at least 1 TE"
        if len(self.my_team) == 20:
            return True, "Roster complete!"
        return True, "Draft in progress..."

    def get_draft_state(self):
        composition = self.get_team_composition()
        meets_req, req_msg = self.meets_team_requirements()
        suggestion = self.get_autopick_suggestion(
            exposure=getattr(self, '_exposure', None)
        ) if self.is_my_turn() else None
        current_round = ((self.overall_pick - 1) // self.num_teams + 1) if self.is_setup else None

        return {
            'pick_number': self.pick_number,
            'overall_pick': self.overall_pick,
            'current_round': current_round,
            'total_picks': self.total_picks,
            'is_complete': self.is_draft_complete(),
            'is_setup': self.is_setup,
            'num_teams': self.num_teams,
            'my_position': self.my_position,
            'is_my_turn': self.is_my_turn(),
            'picks_until_my_turn': self.picks_until_my_turn(),
            'next_my_pick': self._next_my_overall_pick(),
            'my_team': self.my_team,
            'available_count': len(self.available_players),
            'team_projection': self.calculate_team_projection(),
            'team_needs': self.get_team_needs(),
            'team_composition': dict(composition),
            'unique_teams': len(self.get_unique_teams()),
            'meets_requirements': meets_req,
            'requirement_message': req_msg,
            'suggestion': suggestion,
        }
