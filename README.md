# Best Ball Draft Assistant

A **Flask web app** for DraftKings best ball drafting.

> **This file is stale below this line (last accurate ~June 2026).** Paths moved
> under `fantasy_football/`, the pool comes from DraftKings rather than Sleeper, and
> the recommender is now V1 + V2. The live docs are
> `fantasy_football/docs/MAP.md` (what exists), `fantasy_football/CLAUDE.md` (the
> rules) and `fantasy_football/best-ball-draft/docs/STATUS.md` (the map for this app).
>
> The Firefox/Chrome extension that this file used to describe was **removed
> 2026-09-08**; it is in git history.

### `best-ball-draft/` — Flask Web App
Local server for practice drafts and tracking draft history.

- Draft board with autopick suggestions and snake draft position awareness
- **Draft history** — saves completed teams to SQLite
- **Exposure tracker** — shows which players you've over-drafted across contests with visual bars
- Player data pulled from the Sleeper API (2026 season, ~960 players)

## Setup

### Flask Web App

```bash
cd best-ball-draft
pip install -r requirements.txt
bash run.sh
# Open http://localhost:8000
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
- Flask, requests (see `best-ball-draft/requirements.txt`)
