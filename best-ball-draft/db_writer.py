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
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def ensure_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS drafts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            drafted_at  TEXT,
            num_teams   INTEGER,
            my_position INTEGER,
            contest     TEXT,
            dk_draft_id TEXT,
            entry_fee   REAL
        );
        CREATE TABLE IF NOT EXISTS draft_picks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            draft_id    INTEGER REFERENCES drafts(id) ON DELETE CASCADE,
            player_id   TEXT,
            player_name TEXT,
            pos         TEXT,
            team        TEXT,
            adp         INTEGER,
            pick_number INTEGER,
            round       INTEGER,
            week15      TEXT,
            week16      TEXT,
            week17      TEXT
        );
        CREATE TABLE IF NOT EXISTS players (
            player_id  TEXT PRIMARY KEY,
            name       TEXT,
            pos        TEXT,
            team       TEXT,
            adp        REAL,
            week15     TEXT,
            week16     TEXT,
            week17     TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(drafts)").fetchall()]
    if 'dk_draft_id' not in cols:
        conn.execute("ALTER TABLE drafts ADD COLUMN dk_draft_id TEXT")
    if 'entry_fee' not in cols:
        conn.execute("ALTER TABLE drafts ADD COLUMN entry_fee REAL")
    if 'drafted_at' not in cols:
        conn.execute("ALTER TABLE drafts ADD COLUMN drafted_at TEXT")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_dk_draft_id "
        "ON drafts(dk_draft_id) WHERE dk_draft_id IS NOT NULL"
    )
    pick_cols = [r[1] for r in conn.execute("PRAGMA table_info(draft_picks)").fetchall()]
    for col in ('week15', 'week16', 'week17'):
        if col not in pick_cols:
            conn.execute(f"ALTER TABLE draft_picks ADD COLUMN {col} TEXT")


def handle_save_draft(msg):
    picks = msg.get('picks', [])
    if not picks:
        return {'ok': False, 'error': 'no picks'}
    with get_db() as conn:
        ensure_schema(conn)
        try:
            cur = conn.execute(
                "INSERT INTO drafts (num_teams, my_position, contest, dk_draft_id, entry_fee, drafted_at) VALUES (?,?,?,?,?,?)",
                (msg.get('num_teams', 12), msg.get('my_position', 0),
                 msg.get('contest', ''), msg.get('dk_draft_id'), msg.get('entry_fee'),
                 msg.get('drafted_at'))
            )
        except sqlite3.IntegrityError:
            # Draft already exists — update metadata and backfill any missing values
            row = conn.execute(
                "SELECT id FROM drafts WHERE dk_draft_id=?", (msg.get('dk_draft_id'),)
            ).fetchone()
            if row:
                draft_id = row['id']
                # Update drafted_at and entry_fee if we now have better values
                conn.execute("""
                    UPDATE drafts
                    SET drafted_at = COALESCE(?, drafted_at),
                        entry_fee  = COALESCE(?, entry_fee)
                    WHERE id = ?
                """, (msg.get('drafted_at'), msg.get('entry_fee'), draft_id))
                # Backfill any NULL pick_number values
                for p in picks:
                    if p.get('pick_number') is not None:
                        conn.execute(
                            "UPDATE draft_picks SET pick_number=? WHERE draft_id=? AND player_id=?",
                            (p['pick_number'], draft_id, p.get('id'))
                        )
            return {'ok': True, 'duplicate': True, 'draft_id': draft_id if row else None}
        draft_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO draft_picks "
            "(draft_id, player_id, player_name, pos, team, adp, pick_number, round, week15, week16, week17) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [(draft_id, p.get('id'), p.get('name'), p.get('pos'), p.get('team'),
              p.get('adp', 0), p.get('pick_number'), i + 1,
              p.get('week15'), p.get('week16'), p.get('week17'))
             for i, p in enumerate(picks)]
        )
    return {'ok': True, 'draft_id': draft_id}


def handle_refresh_players(msg):
    players = msg.get('players', [])
    if not players:
        return {'ok': False, 'error': 'no players'}
    with get_db() as conn:
        ensure_schema(conn)
        conn.execute("DELETE FROM players")
        conn.executemany("""
            INSERT INTO players (player_id, name, pos, team, adp, week15, week16, week17, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """, [(p.get('id'), p.get('name'), p.get('pos'), p.get('team'),
               p.get('adp'), p.get('week15'), p.get('week16'), p.get('week17'))
              for p in players])
    return {'ok': True, 'count': len(players)}


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


def handle_get_rankings():
    with get_db() as conn:
        ensure_schema(conn)
        # Ensure player_rankings table exists
        conn.execute("""
            CREATE TABLE IF NOT EXISTS player_rankings (
                player_id   TEXT PRIMARY KEY,
                custom_rank INTEGER,
                notes       TEXT DEFAULT '',
                updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        rows = conn.execute("""
            SELECT p.player_id, p.name, p.pos, p.team, p.adp,
                   p.week15, p.week16, p.week17,
                   r.custom_rank
            FROM players p
            LEFT JOIN player_rankings r ON p.player_id = r.player_id
            WHERE r.custom_rank IS NOT NULL
            ORDER BY r.custom_rank
        """).fetchall()
        players = [dict(r) for r in rows]
    return {'ok': True, 'data': players}


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
    elif action == 'refreshPlayers':
        send_msg(handle_refresh_players(msg))
    elif action == 'getRankings':
        send_msg(handle_get_rankings())
    else:
        send_msg({'ok': False, 'error': f'unknown action: {action}'})


if __name__ == '__main__':
    main()
