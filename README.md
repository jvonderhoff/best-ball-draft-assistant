# Best Ball Draft Assistant

A two-part tool for DraftKings best ball drafting: a **Firefox browser extension** that overlays on the live draft room, and a **Flask web app** for draft history and exposure tracking.

## Components

### `best-ball-extension/` — Firefox Extension
Overlays a live recommendation panel directly on the DraftKings draft room.

- Real-time pick suggestions based on ADP, positional needs, and team stacking
- Configurable **stack intensity** — boosts WRs/TEs from your QB's team (off / light / medium / heavy)
- **Diversification** — penalizes players you've over-drafted in past contests
- Auto-detects picks from the DraftKings DOM; manual "My Pick" / "Taken" buttons as fallback
- Three tabs: Board, My Team, Stacks
- Settings saved in browser storage (teams, position, stack intensity, diversification strength)

### `best-ball-draft/` — Flask Web App
Local server for practice drafts and tracking draft history.

- Draft board with autopick suggestions and snake draft position awareness
- **Draft history** — saves completed teams to SQLite
- **Exposure tracker** — shows which players you've over-drafted across contests with visual bars
- Player data pulled from the Sleeper API (2026 season, ~960 players)

## Setup

### 1. Flask Web App (optional — needed for exposure tracking)

```bash
cd best-ball-draft
pip install -r requirements.txt
bash run.sh
# Open http://localhost:8000
```

### 2. Firefox Extension

**First-time player data setup:**
```bash
cd best-ball-draft
python app/data/api_fetcher.py   # fetches from Sleeper API, writes player_cache.json
cd ../best-ball-extension
python generate_players.py        # writes players.js (bundled into extension)
```

**Install in Firefox:**
1. Open `about:debugging` → This Firefox → Load Temporary Add-on
2. Select `best-ball-extension/manifest.json`
3. Click the extension icon, set your draft position and strategy, then navigate to a DraftKings draft

**Refresh player data** (run before each season or when rosters change):
```bash
cd best-ball-draft && python -c "from app.data.api_fetcher import fetch_players; fetch_players(force_refresh=True)"
cd ../best-ball-extension && python generate_players.py
```

## Project Structure

```
best-ball-draft/
├── app/
│   ├── app.py              # Flask routes
│   ├── draft.py            # Snake draft engine
│   ├── database.py         # SQLite draft history
│   └── data/
│       ├── api_fetcher.py  # Sleeper API integration
│       └── players.py      # Player data + fallback static list
├── templates/
│   ├── index.html          # Draft board UI
│   └── history.html        # Exposure tracker UI
├── static/
│   ├── style.css
│   └── app.js
├── requirements.txt
└── run.sh

best-ball-extension/
├── manifest.json           # WebExtension manifest (Firefox/Chrome compatible)
├── content.js              # Main overlay injected into DraftKings
├── recommender.js          # Pick recommendation engine
├── overlay.css             # Panel styles
├── popup.html / popup.js   # Extension settings popup
├── generate_players.py     # Builds players.js from player_cache.json
└── players.js              # Generated — do not edit manually
```

## How Recommendations Work

1. **ADP value** — `max(0, 100 - player.adp)` as base score
2. **Positional need** — multiplier based on how many of each position you still need
3. **Early-round boost** — rounds 1–3 get a 10% bump
4. **Stack bonus** — WR/TE from your QB's team gets a `first` or `second` multiplier (based on how many stackmates you already own); a QB gets a `qbPull` boost if you already own his receivers
5. **Diversification penalty** — `val *= (1 - exposure_rate * strength)` for players you've drafted heavily in past contests

## DraftKings Best Ball Roster

20 players total — 2 QB, 8 RB, 8 WR, 2 TE. Best ball auto-sets the optimal 8-man lineup each week (1 QB, 2 RB, 3 WR, 1 TE, 1 FLEX).

## Requirements

- Python 3.7+
- Firefox (for extension; also Chrome-compatible with minor manifest adjustments)
- Flask, requests (see `best-ball-draft/requirements.txt`)
