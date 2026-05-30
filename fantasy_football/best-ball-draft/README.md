# 🏈 Best Ball Fantasy Draft Tool

A web-based fantasy football best ball draft simulator using DraftKings scoring format.

## Features

- **Solo Draft Interface**: Draft a complete 20-round fantasy football team
- **AI-Powered Autopick**: Get intelligent suggestions based on team needs and player value
- **DraftKings Scoring**: Built-in DraftKings scoring calculations
- **Real-time Team Projection**: See your projected DraftKings points as you draft
- **Player Search & Filtering**: Find players by name, team, or position
- **Team Needs Analytics**: View which positions you still need to fill

## Quick Start

### Prerequisites
- Python 3.7+
- pip (Python package manager)

### Installation

1. Navigate to the project directory:
```bash
cd best-ball-draft
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Run the application:
```bash
bash run.sh
```

The app will start on `http://localhost:8000`

## How to Use

1. **View Available Players**: The right panel shows all available players sorted by ADP (Average Draft Position)
2. **Get Autopick Suggestion**: Click "Get Suggestion" to see the AI's recommended next pick
3. **Auto-Draft**: Click "Auto-Draft Top Player" to automatically draft the suggested player
4. **Manual Draft**: Click any player in the list to manually draft them
5. **Search & Filter**: Use the search bar to find players, or filter by position (QB, RB, WR, TE, K, DEF)
6. **Monitor Team**: Your left panel shows your drafted roster and team needs
7. **Reset**: Start over with a fresh draft using the "Reset Draft" button

## DraftKings Scoring

- **QB**: 1pt per 25 passing yards, 4pt per passing TD, -2pt per int, 1pt per 10 rushing yards, 6pt rushing TD
- **RB**: 1pt per 10 rushing yards, 6pt per rushing TD, 1pt per receiving yard, 1pt PPR
- **WR**: 1pt per receiving yard, 1pt PPR, 6pt per receiving TD
- **TE**: 1pt per receiving yard, 1pt PPR, 6pt per receiving TD
- **K**: 1pt per extra point, 3-5pt per field goal
- **DEF**: 2pt per sack, 2pt per interception, 6pt per defensive TD, etc.

## DraftKings Best Ball Lineup Requirements

Your 20-player roster will be used to set optimal lineups each week:

**Starting Lineup (8 players):**
- 1 QB
- 2 RB
- 3 WR
- 1 TE
- 1 FLEX (RB/WR/TE)

**Bench (12 players):** Any combination of QB, RB, WR, TE

**Roster Requirements:**
- Exactly 20 players for your draft
- Players must come from at least 2 different NFL teams
- Best ball algorithm will auto-set your optimal lineup each week
- Total roster typically: 2 QB, 8 RB, 8 WR, 2 TE

## Project Structure

```
best-ball-draft/
├── app/
│   ├── __init__.py
│   ├── app.py              # Flask application & API routes
│   ├── draft.py            # Draft engine & game logic
│   └── data/
│       ├── __init__.py
│       └── players.py      # Player data with DraftKings projections
├── templates/
│   └── index.html          # Main web interface
├── static/
│   ├── style.css           # Styling
│   └── app.js              # Frontend JavaScript
├── requirements.txt        # Python dependencies
├── run.sh                  # Quick start script
└── README.md              # This file
```

## API Endpoints

All endpoints are prefixed with `/api`:

- `GET /draft/state` - Get current draft state, available players, and team
- `GET /draft/autopick` - Get AI suggestion for next pick
- `POST /draft/autopick-now` - Auto-draft the top suggested player
- `POST /draft/pick/<player_id>` - Manually draft a specific player
- `POST /draft/reset` - Reset draft to start over
- `GET /search-players` - Search players by name or position

## Tips for Best Results

1. **Early Rounds**: Autopick prioritizes high-value RBs and WRs in early rounds
2. **Bye Week Balancing**: The system avoids clustering bye weeks on your team
3. **Position Scarcity**: Later picks emphasize filling critical positions
4. **Tier-Based Valuation**: Suggestions adjust based on which round of drafting you're in

## Troubleshooting

**Port Already in Use**: The app uses port 8000 by default. If this port is occupied, edit `run.sh` to use a different port.

**Module Import Errors**: Make sure the PYTHONPATH includes the project directory:
```bash
export PYTHONPATH="${PWD}:${PYTHONPATH}"
bash run.sh
```

**Template Not Found**: Restart the Flask server after creating/modifying templates.

## Future Enhancements

- Multi-player draft simulations
- League management and scoring history
- Mock draft analysis and statistics
- Export drafted team to CSV
- Integration with real DraftKings contests

## License

MIT License - Feel free to use and modify!

---

Enjoy your best ball draft! 🏈
