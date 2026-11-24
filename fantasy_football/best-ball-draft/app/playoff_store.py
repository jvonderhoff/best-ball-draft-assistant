"""Durable store for the playoff best-ball inputs pushed from the projections app.

One slot, replaced wholesale: the bracket and the player export are one statement
about one moment and are only meaningful together (same season, same seeds), so
they are stored as one row and never merged. Same contract as season_store:
every load returns None when Postgres is unreachable, {} when it is empty, and
never raises.

If DATABASE_URL is unset (local dev), every function is a safe no-op and the app
serves the disk mirror.
"""
from __future__ import annotations

import json
import logging
import os

_log = logging.getLogger('app')

_DDL = """
    CREATE TABLE IF NOT EXISTS playoff_inputs (
        slot         TEXT PRIMARY KEY,
        payload      TEXT,
        uploaded_at  TIMESTAMPTZ DEFAULT now()
    )
"""
SLOT = 'current'


def _conn():
    url = os.environ.get('DATABASE_URL', '').strip()
    if not url:
        return None
    if url.startswith('postgres://'):
        url = 'postgresql://' + url[len('postgres://'):]
    try:
        import psycopg2
    except ImportError:
        _log.warning('[playoff-store] psycopg2 not installed; external store disabled')
        return None
    # Never raise: see rankings_store._conn for the outage that made this a rule.
    try:
        return psycopg2.connect(url, connect_timeout=10)
    except Exception as e:
        _log.warning(f'[playoff-store] connect failed: {e!r}')
        return None


def load():
    """The stored payload, {} if none, None if the store is unreachable."""
    conn = _conn()
    if not conn:
        return None
    try:
        with conn, conn.cursor() as cur:
            cur.execute(_DDL)
            cur.execute("SELECT payload FROM playoff_inputs WHERE slot = %s", (SLOT,))
            row = cur.fetchone()
            return json.loads(row[0]) if row and row[0] else {}
    except Exception as e:
        _log.warning(f'[playoff-store] load failed: {e!r}')
        return None
    finally:
        conn.close()


def save(payload: dict) -> bool:
    """Replace the slot. True only if Postgres accepted the write."""
    conn = _conn()
    if not conn:
        return False
    try:
        with conn, conn.cursor() as cur:
            cur.execute(_DDL)
            cur.execute("""
                INSERT INTO playoff_inputs (slot, payload, uploaded_at)
                VALUES (%s, %s, now())
                ON CONFLICT (slot) DO UPDATE SET
                    payload = excluded.payload, uploaded_at = now()
            """, (SLOT, json.dumps(payload)))
        return True
    except Exception as e:
        _log.warning(f'[playoff-store] save failed: {e!r}')
        return False
    finally:
        conn.close()


# ── DK's playoff pool and ADP, as the bookmarklet sends it ─────────────────────
# One row per draft group per day. Until 2026-11-23 the pool lived only in the
# server's memory: it reached the live draft that sent it and nothing else, so
# mocks, tools/playoff-rec-check.js and every backtest kept drafting against
# SYNTHETIC ADP (expected points: Josh Allen 1st, Purdy 3rd) while real rooms
# take Mahomes in round 2-3 and the first Bear in round 3-4 (Legendary Upside
# stream, 2026-11-20). One row a day rather than one slot, because how ADP moves
# through the window is itself worth having later. Same never-raise contract.
_POOL_DDL = """
    CREATE TABLE IF NOT EXISTS playoff_pools (
        draft_group  TEXT,
        day          DATE,
        payload      TEXT,
        fetched_at   TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (draft_group, day)
    )
"""


def save_pool(draft_group: str, joined: dict) -> bool:
    """Upsert today's row for this draft group. True only if Postgres took it."""
    conn = _conn()
    if not conn:
        return False
    try:
        with conn, conn.cursor() as cur:
            cur.execute(_POOL_DDL)
            cur.execute("""
                INSERT INTO playoff_pools (draft_group, day, payload, fetched_at)
                VALUES (%s, (now() AT TIME ZONE 'UTC')::date, %s, now())
                ON CONFLICT (draft_group, day) DO UPDATE SET
                    payload = excluded.payload, fetched_at = now()
            """, (str(draft_group), json.dumps(joined)))
        return True
    except Exception as e:
        _log.warning(f'[playoff-store] save_pool failed: {e!r}')
        return False
    finally:
        conn.close()


def load_pool(draft_group: str | None = None, day: str | None = None):
    """(joined, fetched_at epoch, draft_group, day) for the newest matching row;
    {} if none; None if the store is unreachable."""
    conn = _conn()
    if not conn:
        return None
    try:
        with conn, conn.cursor() as cur:
            cur.execute(_POOL_DDL)
            where, args = [], []
            if draft_group:
                where.append('draft_group = %s'); args.append(str(draft_group))
            if day:
                where.append('day = %s'); args.append(day)
            cur.execute("SELECT payload, EXTRACT(EPOCH FROM fetched_at), draft_group, day::text "
                        "FROM playoff_pools" + (' WHERE ' + ' AND '.join(where) if where else '')
                        + " ORDER BY fetched_at DESC LIMIT 1", args)
            row = cur.fetchone()
            if not row:
                return {}
            return json.loads(row[0]), float(row[1]), row[2], row[3]
    except Exception as e:
        _log.warning(f'[playoff-store] load_pool failed: {e!r}')
        return None
    finally:
        conn.close()


def list_pools():
    """[{draft_group, day, fetched_at, players}] newest first; None if unreachable."""
    conn = _conn()
    if not conn:
        return None
    try:
        with conn, conn.cursor() as cur:
            cur.execute(_POOL_DDL)
            cur.execute("SELECT draft_group, day::text, EXTRACT(EPOCH FROM fetched_at), payload "
                        "FROM playoff_pools ORDER BY fetched_at DESC LIMIT 200")
            out = []
            for dg, day, at, payload in cur.fetchall():
                try:
                    n = len(json.loads(payload).get('players', []))
                except ValueError:
                    n = None
                out.append({'draft_group': dg, 'day': day, 'fetched_at': float(at), 'players': n})
            return out
    except Exception as e:
        _log.warning(f'[playoff-store] list_pools failed: {e!r}')
        return None
    finally:
        conn.close()
