"""Durable external store for the V2 recommender's projection inputs.

Render's free tier has an ephemeral filesystem: the local SQLite DB is wiped on
every deploy AND every idle spin-down. Custom rankings already survive that via
rankings_store, and draft history via drafts_store. The V2 recommender added two
more datasets that need the same treatment:

  espn_projections  ESPN full-PPR season projections with component stats. The
                    only free source that projects receptions, which full-PPR
                    valuation and the betting-prop correction both depend on.
  player_props      DraftKings and Underdog season prop lines, used to correct
                    projected components against the market.

Without this, a deployed V2 silently runs on Sleeper alone: 356 players drop from
two projection sources to one, the ECR blend doubles from 0.15 to 0.30, and every
score shifts. It would look like it was working.

If DATABASE_URL is unset (local dev), every function is a safe no-op and the app
falls back to SQLite-only behaviour.
"""
from __future__ import annotations

import logging
import os

_log = logging.getLogger('app')

# Kept in sync with the espn_projections columns in database.py.
ESPN_COMPONENTS = ('pass_yd', 'pass_td', 'pass_int', 'rush_yd', 'rush_td',
                   'rec', 'rec_yd', 'rec_td')


def external_enabled() -> bool:
    return bool(os.environ.get('DATABASE_URL', '').strip())


def _conn():
    url = os.environ.get('DATABASE_URL', '').strip()
    if not url:
        return None
    # Some providers hand out postgres://; psycopg2 wants postgresql://
    if url.startswith('postgres://'):
        url = 'postgresql://' + url[len('postgres://'):]
    try:
        import psycopg2
    except ImportError:
        _log.warning('[projections-store] psycopg2 not installed; external store disabled')
        return None
    return psycopg2.connect(url, connect_timeout=10)


def init_external() -> None:
    """Create the projection tables if they don't exist."""
    conn = _conn()
    if not conn:
        return
    cols = ',\n                    '.join(f'{c} real' for c in ESPN_COMPONENTS)
    try:
        with conn, conn.cursor() as cur:
            cur.execute(f"""
                CREATE TABLE IF NOT EXISTS espn_projections (
                    player_name text PRIMARY KEY,
                    fpts        real,
                    pos         text,
                    {cols},
                    updated_at  timestamptz DEFAULT now()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS player_props (
                    player_name text NOT NULL,
                    prop_type   text NOT NULL,
                    line        real,
                    over_odds   text,
                    under_odds  text,
                    book        text NOT NULL DEFAULT 'DraftKings',
                    updated_at  timestamptz DEFAULT now(),
                    PRIMARY KEY (player_name, prop_type, book)
                )
            """)
    except Exception as e:
        _log.warning(f'[projections-store] init failed: {e!r}')
    finally:
        conn.close()


# ── ESPN projections ─────────────────────────────────────────────────────────

def load_espn():
    """Return {player_name: {fpts, pos, components…}}, or None if unreachable.

    None distinguishes "no external store" from "store is empty" ({}), so callers
    never mistake an outage for a legitimately empty dataset and wipe the local
    cache on the strength of it.
    """
    conn = _conn()
    if not conn:
        return None
    cols = ['player_name', 'fpts', 'pos'] + list(ESPN_COMPONENTS)
    try:
        with conn, conn.cursor() as cur:
            cur.execute(f"SELECT {', '.join(cols)} FROM espn_projections")
            return {r[0]: dict(zip(cols[1:], r[1:])) for r in cur.fetchall()}
    except Exception as e:
        _log.warning(f'[projections-store] espn load failed: {e!r}')
        return None
    finally:
        conn.close()


def save_espn(projections: dict) -> int:
    """Mirror ESPN projections into the external store. Returns rows upserted."""
    conn = _conn()
    if not conn:
        return 0
    rows = [
        tuple([name, d.get('fpts'), d.get('pos')] + [d.get(c) for c in ESPN_COMPONENTS])
        for name, d in projections.items() if name
    ]
    if not rows:
        return 0
    cols = ['player_name', 'fpts', 'pos'] + list(ESPN_COMPONENTS)
    updates = ', '.join(f'{c} = excluded.{c}' for c in cols[1:])
    try:
        from psycopg2.extras import execute_values
        with conn, conn.cursor() as cur:
            execute_values(cur, f"""
                INSERT INTO espn_projections ({', '.join(cols)}, updated_at)
                VALUES %s
                ON CONFLICT (player_name) DO UPDATE SET
                    {updates}, updated_at = now()
            """, rows, template='(' + ', '.join(['%s'] * len(cols)) + ', now())')
        return len(rows)
    except Exception as e:
        _log.warning(f'[projections-store] espn save failed: {e!r}')
        return 0
    finally:
        conn.close()


# ── Betting props ────────────────────────────────────────────────────────────

def load_props():
    """Return [{player_name, prop_type, line, over_odds, under_odds, book}], or None."""
    conn = _conn()
    if not conn:
        return None
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""SELECT player_name, prop_type, line, over_odds, under_odds, book
                           FROM player_props""")
            keys = ('player_name', 'prop_type', 'line', 'over_odds', 'under_odds', 'book')
            return [dict(zip(keys, r)) for r in cur.fetchall()]
    except Exception as e:
        _log.warning(f'[projections-store] props load failed: {e!r}')
        return None
    finally:
        conn.close()


def save_props(props_by_player: dict, book: str = 'DraftKings') -> int:
    """Mirror one book's prop lines into the external store. Returns rows upserted."""
    conn = _conn()
    if not conn:
        return 0
    rows = []
    for name, markets in props_by_player.items():
        for prop_type, entry in (markets or {}).items():
            if not isinstance(entry, dict):
                continue
            rows.append((name, prop_type, entry.get('line'),
                         entry.get('over_odds'), entry.get('under_odds'), book))
    if not rows:
        return 0
    try:
        from psycopg2.extras import execute_values
        with conn, conn.cursor() as cur:
            execute_values(cur, """
                INSERT INTO player_props
                    (player_name, prop_type, line, over_odds, under_odds, book, updated_at)
                VALUES %s
                ON CONFLICT (player_name, prop_type, book) DO UPDATE SET
                    line       = excluded.line,
                    over_odds  = excluded.over_odds,
                    under_odds = excluded.under_odds,
                    updated_at = now()
            """, rows, template='(%s, %s, %s, %s, %s, %s, now())')
        return len(rows)
    except Exception as e:
        _log.warning(f'[projections-store] props save failed: {e!r}')
        return 0
    finally:
        conn.close()
