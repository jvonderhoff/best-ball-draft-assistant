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
