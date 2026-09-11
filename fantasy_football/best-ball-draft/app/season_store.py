"""Durable store for the weekly standings snapshots.

Unlike `news_bundle` — one slot, replaced wholesale, because a news bundle is one
statement about one moment — standings ACCUMULATE. The rank history is the point,
and DraftKings will not give it back later. So one row per (season, week), and a
re-capture of a week replaces that week alone.

If DATABASE_URL is unset (local dev), every function is a safe no-op and the app
serves the disk mirror.
"""
from __future__ import annotations

import json
import logging
import os

_log = logging.getLogger('app')

_DDL = """
    CREATE TABLE IF NOT EXISTS season_snapshots (
        season       INTEGER NOT NULL,
        week         INTEGER NOT NULL,
        status       TEXT,
        captured_at  DOUBLE PRECISION,
        entry_count  INTEGER,
        snapshot     TEXT,
        uploaded_at  TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (season, week)
    )
"""


def external_enabled() -> bool:
    return bool(os.environ.get('DATABASE_URL', '').strip())


def _conn():
    url = os.environ.get('DATABASE_URL', '').strip()
    if not url:
        return None
    if url.startswith('postgres://'):
        url = 'postgresql://' + url[len('postgres://'):]
    try:
        import psycopg2
    except ImportError:
        _log.warning('[season-store] psycopg2 not installed; external store disabled')
        return None
    # Never raise. Every load_* here documents "None when unreachable", and that
    # contract held only for the cheap cases until 2026-08-14, when a real outage
    # RAISED and took two safety nets with it. See rankings_store._conn.
    try:
        return psycopg2.connect(url, connect_timeout=10)
    except Exception as e:
        _log.warning(f'[season-store] connect failed: {e!r}')
        return None


def load_all():
    """{"season": {"week": snapshot}}, {} when nothing is stored, None when unreachable.

    None and {} mean different things and the hydrate depends on it: None keeps the
    disk mirror, {} is a genuinely empty store.
    """
    conn = _conn()
    if not conn:
        return None
    try:
        with conn, conn.cursor() as cur:
            # Created on read as well as write: a boot that could not reach the store
            # never ran the DDL, and the first push must not fail on a missing table.
            cur.execute(_DDL)
            cur.execute("SELECT season, week, snapshot FROM season_snapshots")
            out = {}
            for season, week, snapshot in cur.fetchall():
                if snapshot:
                    out.setdefault(str(season), {})[str(week)] = json.loads(snapshot)
            return out
    except Exception as e:
        _log.warning(f'[season-store] load failed: {e!r}')
        return None
    finally:
        conn.close()


def load_week(season: int, week: int):
    """One stored snapshot, {} if that week has none, None if the store is unreachable."""
    conn = _conn()
    if not conn:
        return None
    try:
        with conn, conn.cursor() as cur:
            cur.execute(_DDL)
            cur.execute("SELECT snapshot FROM season_snapshots WHERE season = %s AND week = %s",
                        (season, week))
            row = cur.fetchone()
            return json.loads(row[0]) if row and row[0] else {}
    except Exception as e:
        _log.warning(f'[season-store] load_week failed: {e!r}')
        return None
    finally:
        conn.close()


def save_week(snap: dict) -> bool:
    """Replace one week's snapshot. True only if Postgres accepted the write."""
    conn = _conn()
    if not conn:
        return False
    try:
        with conn, conn.cursor() as cur:
            cur.execute(_DDL)
            cur.execute("""
                INSERT INTO season_snapshots
                    (season, week, status, captured_at, entry_count, snapshot, uploaded_at)
                VALUES (%s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (season, week) DO UPDATE SET
                    status      = excluded.status,
                    captured_at = excluded.captured_at,
                    entry_count = excluded.entry_count,
                    snapshot    = excluded.snapshot,
                    uploaded_at = now()
            """, (snap['season'], snap['week'], snap.get('status'), snap.get('captured_at'),
                  len(snap.get('entries') or []), json.dumps(snap)))
        return True
    except Exception as e:
        _log.warning(f'[season-store] save failed: {e!r}')
        return False
    finally:
        conn.close()
