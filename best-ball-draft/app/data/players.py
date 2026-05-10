# 2024 NFL Players with DraftKings Scoring Projections
# Scoring: QB: 1pt/25 pass yds, 4pt pass TD, -2pt INT, 1pt/10 rush yds, 6pt rush TD
#          RB: 1pt/10 rush yds, 6pt rush TD, 1pt rec yd, 1pt PPR
#          WR: 1pt rec yd, 1pt PPR, 6pt rec TD
#          TE: 1pt rec yd, 1pt PPR, 6pt rec TD
#          K: 1pt XP, 3-5pt FG
#          DEF: 2pt sack, 2pt INT, 6pt TD, -1pt per 7-20 pts allowed, etc

PLAYERS = [
    # Top QBs
    {"id": "qb1", "name": "Patrick Mahomes", "pos": "QB", "team": "KC", "bye": 10, "adp": 2, "dk_proj": 298},
    {"id": "qb2", "name": "Josh Allen", "pos": "QB", "team": "BUF", "bye": 9, "adp": 3, "dk_proj": 287},
    {"id": "qb3", "name": "Lamar Jackson", "pos": "QB", "team": "BAL", "bye": 11, "adp": 4, "dk_proj": 285},
    {"id": "qb4", "name": "Jared Goff", "pos": "QB", "team": "DET", "bye": 8, "adp": 5, "dk_proj": 280},
    {"id": "qb5", "name": "Dak Prescott", "pos": "QB", "team": "DAL", "bye": 6, "adp": 8, "dk_proj": 268},
    {"id": "qb6", "name": "Joe Burrow", "pos": "QB", "team": "CIN", "bye": 10, "adp": 10, "dk_proj": 264},
    {"id": "qb7", "name": "Kyler Murray", "pos": "QB", "team": "ARI", "bye": 6, "adp": 12, "dk_proj": 260},
    {"id": "qb8", "name": "Tua Tagovailoa", "pos": "QB", "team": "MIA", "bye": 9, "adp": 15, "dk_proj": 255},
    {"id": "qb9", "name": "Trevor Lawrence", "pos": "QB", "team": "JAX", "bye": 13, "adp": 18, "dk_proj": 248},
    {"id": "qb10", "name": "Kirk Cousins", "pos": "QB", "team": "ATL", "bye": 11, "adp": 20, "dk_proj": 240},

    # Top RBs
    {"id": "rb1", "name": "Christian McCaffrey", "pos": "RB", "team": "SF", "bye": 9, "adp": 1, "dk_proj": 310},
    {"id": "rb2", "name": "Josh Jacobs", "pos": "RB", "team": "GB", "bye": 9, "adp": 6, "dk_proj": 268},
    {"id": "rb3", "name": "Derrick Henry", "pos": "RB", "team": "TEN", "bye": 8, "adp": 7, "dk_proj": 258},
    {"id": "rb4", "name": "Jonathan Taylor", "pos": "RB", "team": "IND", "bye": 11, "adp": 9, "dk_proj": 245},
    {"id": "rb5", "name": "Tony Pollard", "pos": "RB", "team": "DAL", "bye": 6, "adp": 11, "dk_proj": 242},
    {"id": "rb6", "name": "Saquon Barkley", "pos": "RB", "team": "PHI", "bye": 12, "adp": 13, "dk_proj": 235},
    {"id": "rb7", "name": "De'Von Achane", "pos": "RB", "team": "MIA", "bye": 9, "adp": 14, "dk_proj": 230},
    {"id": "rb8", "name": "Aaron Jones", "pos": "RB", "team": "GB", "bye": 9, "adp": 16, "dk_proj": 218},
    {"id": "rb9", "name": "Breece Hall", "pos": "RB", "team": "NYJ", "bye": 9, "adp": 17, "dk_proj": 215},
    {"id": "rb10", "name": "Najee Harris", "pos": "RB", "team": "PIT", "bye": 8, "adp": 19, "dk_proj": 208},
    {"id": "rb11", "name": "Isiah Pacheco", "pos": "RB", "team": "KC", "bye": 10, "adp": 21, "dk_proj": 202},
    {"id": "rb12", "name": "Ricky Pierce", "pos": "RB", "team": "LAR", "bye": 9, "adp": 23, "dk_proj": 195},

    # Top WRs
    {"id": "wr1", "name": "Tyreek Hill", "pos": "WR", "team": "MIA", "bye": 9, "adp": 22, "dk_proj": 188},
    {"id": "wr2", "name": "Ja'Marr Chase", "pos": "WR", "team": "CIN", "bye": 10, "adp": 24, "dk_proj": 185},
    {"id": "wr3", "name": "CeeDee Lamb", "pos": "WR", "team": "DAL", "bye": 6, "adp": 25, "dk_proj": 182},
    {"id": "wr4", "name": "A.J. Brown", "pos": "WR", "team": "PHI", "bye": 12, "adp": 26, "dk_proj": 180},
    {"id": "wr5", "name": "Justin Jefferson", "pos": "WR", "team": "MIN", "bye": 8, "adp": 27, "dk_proj": 178},
    {"id": "wr6", "name": "Davante Adams", "pos": "WR", "team": "LV", "bye": 8, "adp": 28, "dk_proj": 175},
    {"id": "wr7", "name": "Stefon Diggs", "pos": "WR", "team": "HOU", "bye": 6, "adp": 29, "dk_proj": 172},
    {"id": "wr8", "name": "Travis Etienne", "pos": "WR", "team": "JAX", "bye": 13, "adp": 30, "dk_proj": 168},
    {"id": "wr9", "name": "Puka Nacua", "pos": "WR", "team": "LAR", "bye": 9, "adp": 32, "dk_proj": 162},
    {"id": "wr10", "name": "Michael Pittman", "pos": "WR", "team": "IND", "bye": 11, "adp": 33, "dk_proj": 158},
    {"id": "wr11", "name": "Amon-Ra St. Brown", "pos": "WR", "team": "DET", "bye": 8, "adp": 34, "dk_proj": 155},
    {"id": "wr12", "name": "Cortland Sutton", "pos": "WR", "team": "DEN", "bye": 7, "adp": 35, "dk_proj": 152},

    # Top TEs
    {"id": "te1", "name": "Travis Kelce", "pos": "TE", "team": "KC", "bye": 10, "adp": 31, "dk_proj": 165},
    {"id": "te2", "name": "Mark Andrews", "pos": "TE", "team": "BAL", "bye": 11, "adp": 36, "dk_proj": 145},
    {"id": "te3", "name": "Darren Waller", "pos": "TE", "team": "NYG", "bye": 6, "adp": 37, "dk_proj": 138},
    {"id": "te4", "name": "Trey McBride", "pos": "TE", "team": "ARI", "bye": 6, "adp": 38, "dk_proj": 135},
    {"id": "te5", "name": "Sam LaPorta", "pos": "TE", "team": "DET", "bye": 8, "adp": 39, "dk_proj": 130},
    {"id": "te6", "name": "Kyle Pitts", "pos": "TE", "team": "ATL", "bye": 11, "adp": 40, "dk_proj": 125},

    # More RBs for depth
    {"id": "rb13", "name": "Alvin Kamara", "pos": "RB", "team": "NO", "bye": 12, "adp": 41, "dk_proj": 192},
    {"id": "rb14", "name": "Jeff Wilson", "pos": "RB", "team": "BAL", "bye": 11, "adp": 42, "dk_proj": 188},
    {"id": "rb15", "name": "David Montgomery", "pos": "RB", "team": "CHI", "bye": 7, "adp": 43, "dk_proj": 185},

    # More WRs for depth
    {"id": "wr13", "name": "Brandin Cooks", "pos": "WR", "team": "DAL", "bye": 6, "adp": 44, "dk_proj": 148},
    {"id": "wr14", "name": "Chris Olave", "pos": "WR", "team": "NO", "bye": 12, "adp": 45, "dk_proj": 145},
    {"id": "wr15", "name": "D.J. Moore", "pos": "WR", "team": "CHI", "bye": 7, "adp": 46, "dk_proj": 142},
]

# Add more depth players to reach realistic pool
def get_backup_players():
    """Generate additional backup/depth players"""
    backup = [
        {"id": "qb11", "name": "Daniel Jones", "pos": "QB", "team": "NYG", "bye": 6, "adp": 50, "dk_proj": 220},
        {"id": "qb12", "name": "Brock Purdy", "pos": "QB", "team": "SF", "bye": 9, "adp": 55, "dk_proj": 210},
        {"id": "rb16", "name": "Raheem Mostert", "pos": "RB", "team": "MIA", "bye": 9, "adp": 60, "dk_proj": 175},
        {"id": "rb17", "name": "Antonio Gibson", "pos": "RB", "team": "TEN", "bye": 8, "adp": 65, "dk_proj": 165},
        {"id": "wr16", "name": "Jalin Hyatt", "pos": "WR", "team": "NYG", "bye": 6, "adp": 70, "dk_proj": 130},
        {"id": "wr17", "name": "DK Metcalf", "pos": "WR", "team": "SEA", "bye": 10, "adp": 75, "dk_proj": 125},
        {"id": "te7", "name": "Gerald Everett", "pos": "TE", "team": "CHI", "bye": 7, "adp": 80, "dk_proj": 115},
        {"id": "k1", "name": "Patrick Mahomes", "pos": "K", "team": "KC", "bye": 10, "adp": 85, "dk_proj": 195},
        {"id": "def1", "name": "Buffalo Bills", "pos": "DEF", "team": "BUF", "bye": 9, "adp": 42, "dk_proj": 140},
        {"id": "def2", "name": "San Francisco 49ers", "pos": "DEF", "team": "SF", "bye": 9, "adp": 43, "dk_proj": 135},
    ]
    return backup

def get_all_players():
    """Return all available players, preferring live API data over the static list."""
    try:
        from app.data.api_fetcher import fetch_players
        players = fetch_players()
        if players:
            return players
    except Exception:
        pass
    all_players = PLAYERS + get_backup_players()
    return sorted(all_players, key=lambda p: p['adp'])

# Best ball doesn't include Defense position
DEFENSES = []

# Kickers (optional - most best ball formats don't include K)
KICKERS = []
