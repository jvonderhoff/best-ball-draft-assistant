#!/usr/bin/env python3
"""
One-off script to seed the players table from the local player cache.
Run this whenever you want to refresh the players table without going
through the extension.

Usage:
    python seed_players.py           # use cached data
    python seed_players.py --refresh # re-fetch from DraftKings (+ FantasyPros fallback)

Player data source: DraftKings rankings page — ensures player names and teams
match exactly what DK shows on the draft board.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from app.data.api_fetcher import fetch_players
from app.database import init_db, refresh_players

if __name__ == '__main__':
    force = '--refresh' in sys.argv
    if force:
        print('Fetching fresh player data from DraftKings...')
    else:
        print('Loading from local cache (pass --refresh to re-fetch)...')

    players = fetch_players(force_refresh=force)
    init_db()
    count = refresh_players(players)
    print(f'✓ {count} players upserted into players table')
