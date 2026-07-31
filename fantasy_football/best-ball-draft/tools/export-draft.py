#!/usr/bin/env python3
"""Export a saved draft to tools/replay-draft.json for the V1/V2 replay harness."""
import json
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'replay-draft.json')


def main():
    dk_id = sys.argv[1] if len(sys.argv) > 1 else None

    conn = sqlite3.connect(os.path.join(ROOT, 'drafts.db'))
    conn.row_factory = sqlite3.Row

    if dk_id:
        draft = conn.execute('SELECT * FROM drafts WHERE dk_draft_id = ?', (dk_id,)).fetchone()
    else:
        draft = conn.execute('SELECT * FROM drafts ORDER BY created_at DESC LIMIT 1').fetchone()

    if not draft:
        print('No draft found', file=sys.stderr)
        return 1

    picks = conn.execute(
        'SELECT * FROM draft_picks WHERE draft_id = ? ORDER BY pick_number',
        (draft['id'],)
    ).fetchall()

    payload = {
        'contest':     draft['contest'],
        'num_teams':   draft['num_teams'],
        'my_position': draft['my_position'],
        'picks':       [dict(p) for p in picks],
    }
    with open(OUT, 'w') as f:
        json.dump(payload, f, indent=1)

    print(f"Wrote {OUT}: {payload['contest']}, {len(picks)} picks, slot {payload['my_position']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
