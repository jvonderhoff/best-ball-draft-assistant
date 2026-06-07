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
            CREATE TABLE IF NOT EXISTS player_props (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                player_name TEXT    NOT NULL,
                prop_type   TEXT    NOT NULL,
                line        REAL,
                over_odds   TEXT,
                under_odds  TEXT,
                book        TEXT    DEFAULT 'DraftKings',
                updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(player_name, prop_type, book)
            );

            CREATE TABLE IF NOT EXISTS player_rankings (
                player_id   TEXT PRIMARY KEY,
                custom_rank INTEGER,
                notes       TEXT DEFAULT '',
                updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS drafts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                num_teams   INTEGER,
                my_position INTEGER,
                contest     TEXT,
                dk_draft_id TEXT,
                entry_fee   REAL,
                drafted_at  TEXT
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

            CREATE TABLE IF NOT EXISTS player_projections (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                player_name TEXT    NOT NULL UNIQUE,
                fpts        REAL,
                pos         TEXT,
                source      TEXT    DEFAULT 'FantasyPros',
                updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS yahoo_projections (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                player_name TEXT    NOT NULL UNIQUE,
                fpts        REAL,
                pos         TEXT,
                yahoo_rank  INTEGER,
                updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS kv_store (
                key         TEXT PRIMARY KEY,
                value       TEXT,
                updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    """Replace the players table with fresh data (clears stale rows first)."""
    with get_db() as conn:
        conn.execute("DELETE FROM players")
        conn.executemany("""
            INSERT INTO players (player_id, name, pos, team, adp, week15, week16, week17, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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


# ── Player props ─────────────────────────────────────────────────────────────

def save_props(props_by_player: dict, book: str = 'DraftKings'):
    """
    Upsert props from {player_name: {prop_type: {line, over_odds, under_odds}}}.
    book: 'DraftKings' or 'Underdog'
    """
    with get_db() as conn:
        count = 0
        for player_name, prop_types in props_by_player.items():
            for prop_type, data in prop_types.items():
                if not isinstance(data, dict):
                    continue
                conn.execute("""
                    INSERT INTO player_props (player_name, prop_type, line, over_odds, under_odds, book, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(player_name, prop_type, book) DO UPDATE SET
                        line       = excluded.line,
                        over_odds  = excluded.over_odds,
                        under_odds = excluded.under_odds,
                        updated_at = CURRENT_TIMESTAMP
                """, (player_name, prop_type, data.get('line'),
                      str(data.get('over_odds') or ''), str(data.get('under_odds') or ''), book))
                count += 1
    return count


def get_all_props():
    """
    Return all props keyed by book then player:
    {book: {player_name: {prop_type: {line, over_odds, under_odds, updated_at}}}}
    """
    with get_db() as conn:
        rows = conn.execute(
            "SELECT book, player_name, prop_type, line, over_odds, under_odds, updated_at "
            "FROM player_props ORDER BY book, player_name, prop_type"
        ).fetchall()
    result = {}
    for r in rows:
        book = r['book'] or 'DraftKings'
        pn   = r['player_name']
        result.setdefault(book, {}).setdefault(pn, {})[r['prop_type']] = {
            'line':       r['line'],
            'over_odds':  r['over_odds'],
            'under_odds': r['under_odds'],
            'updated_at': r['updated_at'],
        }
    return result


# ── Player projections ───────────────────────────────────────────────────────

def save_projections(projections: dict, source: str = 'FantasyPros'):
    """Upsert from {player_name: {'fpts': float, 'pos': str}}."""
    with get_db() as conn:
        count = 0
        for player_name, data in projections.items():
            conn.execute("""
                INSERT INTO player_projections (player_name, fpts, pos, source, updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(player_name) DO UPDATE SET
                    fpts       = excluded.fpts,
                    pos        = excluded.pos,
                    source     = excluded.source,
                    updated_at = CURRENT_TIMESTAMP
            """, (player_name, data.get('fpts'), data.get('pos'), source))
            count += 1
    return count


def get_raw_projections():
    """Return {player_name: {fpts, pos, source, updated_at}}."""
    with get_db() as conn:
        rows = conn.execute(
            'SELECT player_name, fpts, pos, source, updated_at FROM player_projections'
        ).fetchall()
    return {r['player_name']: dict(r) for r in rows}


def save_yahoo_projections(projections: dict):
    """Upsert Yahoo projections {player_name: {'fpts': float, 'pos': str, 'yahoo_rank': int}}."""
    with get_db() as conn:
        count = 0
        for player_name, data in projections.items():
            conn.execute("""
                INSERT INTO yahoo_projections (player_name, fpts, pos, yahoo_rank, updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(player_name) DO UPDATE SET
                    fpts       = excluded.fpts,
                    pos        = excluded.pos,
                    yahoo_rank = excluded.yahoo_rank,
                    updated_at = CURRENT_TIMESTAMP
            """, (player_name, data.get('fpts'), data.get('pos'), data.get('yahoo_rank')))
            count += 1
    return count


def get_yahoo_projections():
    """Return {player_name: {fpts, pos, yahoo_rank, updated_at}}."""
    with get_db() as conn:
        rows = conn.execute(
            'SELECT player_name, fpts, pos, yahoo_rank, updated_at FROM yahoo_projections'
        ).fetchall()
    return {r['player_name']: dict(r) for r in rows}


def yahoo_projections_meta():
    with get_db() as conn:
        row = conn.execute(
            'SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM yahoo_projections'
        ).fetchone()
    return {'count': row['n'], 'last_updated': row['last']} if row['n'] else None


def kv_set(key: str, value: str):
    """Store a string value by key (upsert)."""
    with get_db() as conn:
        conn.execute(
            'INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) '
            'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP',
            (key, value)
        )


def kv_get(key: str) -> str | None:
    """Retrieve a string value by key."""
    with get_db() as conn:
        row = conn.execute('SELECT value FROM kv_store WHERE key=?', (key,)).fetchone()
    return row['value'] if row else None


def projections_meta():
    """Return count and most recent updated_at, or None if empty."""
    with get_db() as conn:
        row = conn.execute(
            'SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM player_projections'
        ).fetchone()
    return {'count': row['n'], 'last_updated': row['last']} if row['n'] else None


# ── Player rankings ───────────────────────────────────────────────────────────

def get_rankings():
    """
    Return all players joined with their custom rankings.
    Players without a custom rank get custom_rank = NULL (sorted last).
    """
    with get_db() as conn:
        rows = conn.execute("""
            SELECT p.player_id, p.name, p.pos, p.team, p.adp,
                   p.week15, p.week16, p.week17,
                   r.custom_rank, COALESCE(r.notes, '') AS notes
            FROM players p
            LEFT JOIN player_rankings r ON p.player_id = r.player_id
            ORDER BY COALESCE(r.custom_rank, 9999), p.adp
        """).fetchall()
        return [dict(r) for r in rows]


def save_rankings(rankings):
    """
    Upsert a list of {player_id, custom_rank, notes} dicts.
    rankings with custom_rank=None are deleted (unranked).
    """
    with get_db() as conn:
        for r in rankings:
            pid  = r.get('player_id')
            rank = r.get('custom_rank')
            notes = r.get('notes', '') or ''
            if not pid:
                continue
            if rank is None:
                conn.execute("DELETE FROM player_rankings WHERE player_id=?", (pid,))
            else:
                conn.execute("""
                    INSERT INTO player_rankings (player_id, custom_rank, notes, updated_at)
                    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(player_id) DO UPDATE SET
                        custom_rank = excluded.custom_rank,
                        notes       = excluded.notes,
                        updated_at  = CURRENT_TIMESTAMP
                """, (pid, int(rank), notes))
    return len(rankings)
