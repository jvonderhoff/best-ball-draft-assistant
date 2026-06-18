from __future__ import annotations
import sqlite3
import json
import os

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'drafts.db')
_DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')
RANKINGS_SEED_PATH = os.path.join(_DATA_DIR, 'rankings_seed.json')


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
                ecr_rank   INTEGER,
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
        player_cols = [r[1] for r in conn.execute("PRAGMA table_info(players)").fetchall()]
        if 'ecr_rank' not in player_cols:
            conn.execute("ALTER TABLE players ADD COLUMN ecr_rank INTEGER")
        pick_cols = [r[1] for r in conn.execute("PRAGMA table_info(draft_picks)").fetchall()]
        for col in ('week15', 'week16', 'week17'):
            if col not in pick_cols:
                conn.execute(f"ALTER TABLE draft_picks ADD COLUMN {col} TEXT")
        _seed_rankings_if_empty(conn)
        _seed_players_if_empty(conn)
        _hydrate_external_rankings(conn)
        _hydrate_external_drafts(conn)


def _seed_players_if_empty(conn):
    """Load player_cache.json into players table if empty."""
    player_cache = os.path.join(_DATA_DIR, 'player_cache.json')
    if not os.path.exists(player_cache):
        return
    count = conn.execute("SELECT COUNT(*) FROM players").fetchone()[0]
    if count > 0:
        return
    with open(player_cache) as f:
        data = json.load(f)
    players = data.get('players', data) if isinstance(data, dict) else data
    conn.executemany("""
        INSERT OR IGNORE INTO players
            (player_id, name, pos, team, adp, ecr_rank, week15, week16, week17, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    """, [(p['id'], p['name'], p['pos'], p['team'], p.get('adp'),
           p.get('ecr_rank'), p.get('week15'), p.get('week16'), p.get('week17'))
          for p in players])


def _seed_rankings_if_empty(conn):
    """Load rankings_seed.json into player_rankings if the table is empty.

    This is only the bootstrap for the very first run / local dev. When an
    external store is configured, _hydrate_external_rankings overrides this.
    """
    if not os.path.exists(RANKINGS_SEED_PATH):
        return
    count = conn.execute("SELECT COUNT(*) FROM player_rankings").fetchone()[0]
    if count > 0:
        return
    with open(RANKINGS_SEED_PATH) as f:
        seed = json.load(f)
    conn.executemany(
        "INSERT OR IGNORE INTO player_rankings (player_id, custom_rank, notes, updated_at) "
        "VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
        [(r['player_id'], r['custom_rank'], r.get('notes', '')) for r in seed]
    )


def _hydrate_external_rankings(conn):
    """Make the durable external store the source of truth for rankings.

    On boot: pull rankings from the external DB and replace the local cache so
    ephemeral-filesystem resets (deploy or spin-down) never lose edits. If the
    external store is empty (first run), seed it from whatever is local — the
    seed-file bootstrap that _seed_rankings_if_empty just loaded.
    """
    from app import rankings_store
    if not rankings_store.external_enabled():
        return
    try:
        rankings_store.init_external()
        ext = rankings_store.load_rankings()
        if ext is None:
            return  # store unreachable — keep local cache, don't wipe it
        if not ext:
            # First run: external is empty. Seed it from the local bootstrap so
            # we don't lose the committed rankings_seed.json set.
            local = conn.execute(
                "SELECT player_id, custom_rank, notes FROM player_rankings"
            ).fetchall()
            seed = [
                {'player_id': r['player_id'], 'custom_rank': r['custom_rank'], 'notes': r['notes'] or ''}
                for r in local
            ]
            if seed:
                rankings_store.save_rankings(seed)
            return
        # External has data — it wins. Replace the local cache wholesale.
        conn.execute("DELETE FROM player_rankings")
        conn.executemany(
            "INSERT OR IGNORE INTO player_rankings (player_id, custom_rank, notes, updated_at) "
            "VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
            [(r['player_id'], r['custom_rank'], r.get('notes', '')) for r in ext]
        )
    except Exception as e:
        import logging
        logging.getLogger('app').warning(f'[rankings-store] hydrate failed: {e!r}')


def _hydrate_external_drafts(conn):
    """Make the durable external store the source of truth for draft history.

    On boot: rebuild the local drafts/draft_picks tables from the external DB so
    history survives ephemeral-filesystem resets. If the external store is empty
    (first run), seed it from whatever local drafts already exist.
    """
    from app import drafts_store
    if not drafts_store.external_enabled():
        return
    try:
        drafts_store.init_external()
        ext = drafts_store.load_drafts()
        if ext is None:
            return  # store unreachable — keep local cache, don't wipe it
        if not ext:
            # First run: seed external from any local drafts that have a dk_draft_id.
            rows = conn.execute(
                "SELECT id, num_teams, my_position, contest, dk_draft_id, entry_fee, drafted_at "
                "FROM drafts WHERE dk_draft_id IS NOT NULL"
            ).fetchall()
            for d in rows:
                picks = conn.execute(
                    "SELECT player_id, player_name, pos, team, adp, pick_number, week15, week16, week17 "
                    "FROM draft_picks WHERE draft_id=? ORDER BY pick_number", (d['id'],)
                ).fetchall()
                drafts_store.save_draft(
                    d['dk_draft_id'], d['num_teams'], d['my_position'], d['contest'],
                    d['entry_fee'], d['drafted_at'],
                    [{'id': p['player_id'], 'name': p['player_name'], 'pos': p['pos'],
                      'team': p['team'], 'adp': p['adp'], 'pick_number': p['pick_number'],
                      'week15': p['week15'], 'week16': p['week16'], 'week17': p['week17']}
                     for p in picks]
                )
            return
        # External has data — it wins. Rebuild local tables from it.
        conn.execute("DELETE FROM draft_picks")
        conn.execute("DELETE FROM drafts")
        for d in ext:
            cur = conn.execute(
                "INSERT INTO drafts (num_teams, my_position, contest, dk_draft_id, entry_fee, drafted_at) "
                "VALUES (?,?,?,?,?,?)",
                (d.get('num_teams'), d.get('my_position'), d.get('contest'),
                 d.get('dk_draft_id'), d.get('entry_fee'), d.get('drafted_at'))
            )
            local_id = cur.lastrowid
            conn.executemany(
                "INSERT INTO draft_picks (draft_id, player_id, player_name, pos, team, adp, pick_number, round, week15, week16, week17) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [(local_id, p.get('player_id'), p.get('player_name'), p.get('pos'), p.get('team'),
                  p.get('adp'), p.get('pick_number'), idx + 1,
                  p.get('week15'), p.get('week16'), p.get('week17'))
                 for idx, p in enumerate(d.get('picks', []))]
            )
    except Exception as e:
        import logging
        logging.getLogger('app').warning(f'[drafts-store] hydrate failed: {e!r}')


def _insert_picks(conn, draft_id, picks):
    conn.executemany(
        "INSERT INTO draft_picks (draft_id, player_id, player_name, pos, team, adp, pick_number, round, week15, week16, week17) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
            (draft_id, p['id'], p['name'], p['pos'], p['team'], p.get('adp', 0), p.get('pick_number'), i + 1,
             p.get('week15'), p.get('week16'), p.get('week17'))
            for i, p in enumerate(picks)
        ]
    )


def save_draft(num_teams, my_position, picks, contest='', dk_draft_id=None, entry_fee=None, drafted_at=None):
    """
    Save (or update) a completed draft. picks = list of player dicts.

    If dk_draft_id already exists, the row is UPDATED in place — metadata is
    backfilled/refreshed (existing values kept when the incoming one is null/0/
    empty) and the roster is replaced. This lets a re-sync fill in entry_fee /
    drafted_at and fix pick numbers on drafts imported before those existed.

    Returns (draft_id, created) where created is False for an update.
    """
    created = True
    with get_db() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO drafts (num_teams, my_position, contest, dk_draft_id, entry_fee, drafted_at) VALUES (?,?,?,?,?,?)",
                (num_teams, my_position, contest, dk_draft_id, entry_fee, drafted_at)
            )
            draft_id = cur.lastrowid
        except sqlite3.IntegrityError:
            created = False
            row = conn.execute("SELECT id FROM drafts WHERE dk_draft_id=?", (dk_draft_id,)).fetchone()
            draft_id = row['id']
            # Keep existing values when the incoming one is missing (NULL / 0 / '').
            conn.execute("""
                UPDATE drafts SET
                    num_teams   = COALESCE(?, num_teams),
                    my_position = COALESCE(NULLIF(?, 0), my_position),
                    contest     = COALESCE(NULLIF(?, ''), contest),
                    entry_fee   = COALESCE(?, entry_fee),
                    drafted_at  = COALESCE(?, drafted_at)
                WHERE id=?
            """, (num_teams, my_position, contest, entry_fee, drafted_at, draft_id))
            conn.execute("DELETE FROM draft_picks WHERE draft_id=?", (draft_id,))
        _insert_picks(conn, draft_id, picks)
    # Write through to the durable external store (upserts by dk_draft_id).
    if dk_draft_id:
        try:
            from app import drafts_store
            if drafts_store.external_enabled():
                drafts_store.save_draft(dk_draft_id, num_teams, my_position, contest,
                                        entry_fee, drafted_at, picks)
        except Exception as e:
            import logging
            logging.getLogger('app').warning(f'[drafts-store] write-through failed: {e!r}')
    return draft_id, created


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
        # Remove rankings for players no longer in the pool
        conn.execute("""
            DELETE FROM player_rankings
            WHERE player_id NOT IN (SELECT player_id FROM players)
        """)
    return len(players)


def get_players():
    """Return all players from the DB in the same shape as player_cache.json."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT player_id, name, pos, team, adp, ecr_rank, week15, week16, week17
            FROM players ORDER BY adp
        """).fetchall()
        return [{'id': r['player_id'], 'name': r['name'], 'pos': r['pos'],
                 'team': r['team'], 'adp': r['adp'], 'ecr_rank': r['ecr_rank'],
                 'week15': r['week15'], 'week16': r['week16'], 'week17': r['week17']}
                for r in rows]


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
        row = conn.execute("SELECT dk_draft_id FROM drafts WHERE id=?", (draft_id,)).fetchone()
        dk_draft_id = row['dk_draft_id'] if row else None
        conn.execute("DELETE FROM drafts WHERE id=?", (draft_id,))
    # Mirror the delete to the durable store.
    if dk_draft_id:
        try:
            from app import drafts_store
            if drafts_store.external_enabled():
                drafts_store.delete_draft(dk_draft_id)
        except Exception as e:
            import logging
            logging.getLogger('app').warning(f'[drafts-store] delete write-through failed: {e!r}')


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
    # Write through to the durable external store so the edit survives the next
    # ephemeral-filesystem reset. No-op when DATABASE_URL is unset.
    try:
        from app import rankings_store
        if rankings_store.external_enabled():
            rankings_store.save_rankings(rankings)
    except Exception as e:
        import logging
        logging.getLogger('app').warning(f'[rankings-store] write-through failed: {e!r}')
    return len(rankings)
