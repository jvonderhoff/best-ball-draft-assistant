import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'drafts.db')


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS drafts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                num_teams   INTEGER,
                my_position INTEGER,
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
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_dk_draft_id ON drafts(dk_draft_id) WHERE dk_draft_id IS NOT NULL")
        pick_cols = [r[1] for r in conn.execute("PRAGMA table_info(draft_picks)").fetchall()]
        for col in ('week15', 'week16', 'week17'):
            if col not in pick_cols:
                conn.execute(f"ALTER TABLE draft_picks ADD COLUMN {col} TEXT")


def save_draft(num_teams, my_position, picks, contest='', dk_draft_id=None):
    """
    Save a completed draft. picks = list of player dicts.
    If dk_draft_id is provided and already exists, the save is skipped (returns None).
    """
    with get_db() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO drafts (num_teams, my_position, contest, dk_draft_id) VALUES (?,?,?,?)",
                (num_teams, my_position, contest, dk_draft_id)
            )
        except sqlite3.IntegrityError:
            return None
        draft_id = cur.lastrowid
        conn.executemany(
            "INSERT INTO draft_picks (draft_id, player_id, player_name, pos, team, adp, pick_number, round, week15, week16, week17) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [
                (draft_id, p['id'], p['name'], p['pos'], p['team'], p.get('adp', 0), p.get('pick_number'), i + 1,
                 p.get('week15'), p.get('week16'), p.get('week17'))
                for i, p in enumerate(picks)
            ]
        )
        return draft_id


def refresh_players(players):
    """Upsert current player data (ADP, schedule weeks) into the players reference table."""
    with get_db() as conn:
        conn.executemany("""
            INSERT INTO players (player_id, name, pos, team, adp, week15, week16, week17, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(player_id) DO UPDATE SET
                name       = excluded.name,
                pos        = excluded.pos,
                team       = excluded.team,
                adp        = excluded.adp,
                week15     = excluded.week15,
                week16     = excluded.week16,
                week17     = excluded.week17,
                updated_at = excluded.updated_at
        """, [(p['id'], p['name'], p['pos'], p['team'], p.get('adp'),
               p.get('week15'), p.get('week16'), p.get('week17'))
              for p in players])
    return len(players)


def get_all_drafts():
    with get_db() as conn:
        drafts = conn.execute(
            "SELECT * FROM drafts ORDER BY created_at DESC"
        ).fetchall()
        result = []
        for d in drafts:
            picks = conn.execute(
                "SELECT * FROM draft_picks WHERE draft_id=? ORDER BY pick_number",
                (d['id'],)
            ).fetchall()
            result.append({**dict(d), 'picks': [dict(p) for p in picks]})
        return result


def get_exposure():
    with get_db() as conn:
        total = conn.execute("SELECT COUNT(*) FROM drafts").fetchone()[0]
        if total == 0:
            return {'total_drafts': 0, 'players': {}}

        rows = conn.execute("""
            SELECT player_id, player_name, pos, team,
                   COUNT(*) AS times_drafted
            FROM draft_picks
            GROUP BY player_id
            ORDER BY times_drafted DESC
        """).fetchall()

        players = {
            r['player_id']: {
                'name': r['player_name'],
                'pos': r['pos'],
                'team': r['team'],
                'times_drafted': r['times_drafted'],
                'exposure_rate': round(r['times_drafted'] / total, 3),
            }
            for r in rows
        }
        return {'total_drafts': total, 'players': players}


def delete_draft(draft_id):
    with get_db() as conn:
        conn.execute("DELETE FROM drafts WHERE id=?", (draft_id,))
