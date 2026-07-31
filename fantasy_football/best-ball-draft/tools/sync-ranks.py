#!/usr/bin/env python3
"""
Pull your custom rankings from the deployed app into the local database.

The sandbox reads the local drafts.db while you edit rankings in production, so
the two drift apart silently — a sandbox scoring a six-week-old board looks like
a model problem rather than a data problem.

Deliberately narrower than pull_db.sh, which downloads the whole database and
would overwrite locally-populated ESPN projections and betting props. /api/rankings
needs no auth, so only the rankings move.

Writes local-only: save_rankings write-throughs to the external store only when
DATABASE_URL is set, which it is not on a dev machine. Verified before writing.

Usage:
    python3 tools/sync-ranks.py            # sync
    python3 tools/sync-ranks.py --dry-run  # show what would change
"""
import json
import os
import shutil
import sqlite3
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

SERVER = os.environ.get('BBA_SERVER', 'https://best-ball-draft-assistant.onrender.com')


def fetch_prod_rankings():
    url = f'{SERVER}/api/rankings'
    print(f'Fetching {url} (a cold Render instance can take ~60s)...')
    with urllib.request.urlopen(url, timeout=180) as r:
        return json.load(r)


def main():
    dry = '--dry-run' in sys.argv

    if os.environ.get('DATABASE_URL'):
        print('DATABASE_URL is set — writes would propagate to the external store.')
        print('Unset it before syncing into a local database.')
        return 1

    rows = fetch_prod_rankings()
    prod = {r['player_id']: r for r in rows if r.get('custom_rank') is not None}
    if not prod:
        print('No ranked players returned — aborting rather than wiping local ranks.')
        return 1

    db = os.path.join(ROOT, 'drafts.db')
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    local = {r['player_id']: r['custom_rank']
             for r in conn.execute('SELECT player_id, custom_rank FROM player_rankings')
             if r['custom_rank'] is not None}
    names = {r['player_id']: r['name'] for r in conn.execute('SELECT player_id, name FROM players')}
    conn.close()

    changed = [(pid, local[pid], prod[pid]['custom_rank'])
               for pid in set(prod) & set(local) if local[pid] != prod[pid]['custom_rank']]
    changed.sort(key=lambda x: -abs(x[1] - x[2]))
    added = set(prod) - set(local)

    print(f'prod {len(prod)} ranked | local {len(local)} ranked | '
          f'{len(changed)} changed | {len(added)} newly ranked')
    for pid, a, b in changed[:10]:
        print(f'   {names.get(pid, pid)[:24]:26s} {a:4d} -> {b:4d}  ({b - a:+d})')

    if dry:
        print('\n--dry-run: nothing written.')
        return 0

    backup = f'{db}.bak-{time.strftime("%Y%m%d-%H%M%S")}'
    shutil.copy2(db, backup)

    from app.database import save_rankings
    save_rankings([{'player_id': pid, 'custom_rank': r.get('custom_rank'),
                    'notes': r.get('notes', '')} for pid, r in prod.items()])

    print(f'\nSynced {len(prod)} rankings. Backup: {os.path.basename(backup)}')
    print('Reload /sandbox to pick them up.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
