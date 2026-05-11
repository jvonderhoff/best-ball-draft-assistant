#!/Users/jvonderhoff/opt/anaconda3/bin/python3
"""
Native messaging host for the Best Ball Draft Assistant extension.
Firefox launches this on-demand; it reads one JSON message from stdin,
writes to the SQLite database, and responds on stdout.
"""
import sys
import json
import struct
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'drafts.db')


def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack('=I', raw)[0]
    return json.loads(sys.stdin.buffer.read(length))


def send_msg(data):
    encoded = json.dumps(data).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS drafts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            num_teams   INTEGER,
            my_position INTEGER,
            proj_pts    INTEGER,
            contest     TEXT,
            dk_draft_id TEXT
        );
        CREATE TABLE IF NOT EXISTS draft_picks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            draft_id    INTEGER REFERENCES drafts(id) ON DELETE CASCADE,
            player_id   TEXT,
            player_name TEXT,
            pos         TEXT,
            team        TEXT,
            adp         INTEGER,
            dk_proj     INTEGER,
            pick_number INTEGER
        );
    """)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(drafts)").fetchall()]
    if 'dk_draft_id' not in cols:
        conn.execute("ALTER TABLE drafts ADD COLUMN dk_draft_id TEXT")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_dk_draft_id "
        "ON drafts(dk_draft_id) WHERE dk_draft_id IS NOT NULL"
    )


def handle_save_draft(msg):
    picks = msg.get('picks', [])
    if not picks:
        return {'ok': False, 'error': 'no picks'}
    proj_pts = sum(p.get('dk_proj', 0) for p in picks)
    with get_db() as conn:
        ensure_schema(conn)
        try:
            cur = conn.execute(
                "INSERT INTO drafts (num_teams, my_position, proj_pts, contest, dk_draft_id) "
                "VALUES (?,?,?,?,?)",
                (msg.get('num_teams', 12), msg.get('my_position', 0),
                 proj_pts, msg.get('contest', ''), msg.get('dk_draft_id'))
            )
        except sqlite3.IntegrityError:
            return {'ok': True, 'duplicate': True}
        draft_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO draft_picks "
            "(draft_id, player_id, player_name, pos, team, adp, dk_proj, pick_number) "
            "VALUES (?,?,?,?,?,?,?,?)",
            [(draft_id, p.get('id'), p.get('name'), p.get('pos'), p.get('team'),
              p.get('adp', 0), p.get('dk_proj', 0), i + 1)
             for i, p in enumerate(picks)]
        )
    return {'ok': True, 'draft_id': draft_id}


def handle_get_exposure():
    with get_db() as conn:
        ensure_schema(conn)
        total = conn.execute("SELECT COUNT(*) FROM drafts").fetchone()[0]
        if total == 0:
            return {'ok': True, 'data': {'total_drafts': 0, 'players': {}}}
        rows = conn.execute("""
            SELECT player_id, player_name, pos, team, COUNT(*) AS times_drafted
            FROM draft_picks GROUP BY player_id ORDER BY times_drafted DESC
        """).fetchall()
        players = {
            r['player_id']: {
                'name': r['player_name'], 'pos': r['pos'], 'team': r['team'],
                'times_drafted': r['times_drafted'],
                'exposure_rate': round(r['times_drafted'] / total, 3),
            }
            for r in rows
        }
    return {'ok': True, 'data': {'total_drafts': total, 'players': players}}


def main():
    msg = read_msg()
    if not msg:
        send_msg({'ok': False, 'error': 'no message'})
        return
    action = msg.get('action')
    if action == 'saveDraft':
        send_msg(handle_save_draft(msg))
    elif action == 'getExposure':
        send_msg(handle_get_exposure())
    else:
        send_msg({'ok': False, 'error': f'unknown action: {action}'})


if __name__ == '__main__':
    main()
