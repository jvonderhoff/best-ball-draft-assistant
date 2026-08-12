"""Durable external store for custom player rankings.

Render's free tier has an ephemeral filesystem — the local SQLite DB is wiped on
every deploy AND on every idle spin-down. To make rankings survive, they live in
an external Postgres (any provider: Neon, Supabase, Render PG, …) addressed by the
DATABASE_URL env var. The local player_rankings table becomes a per-boot cache
that is hydrated from here.

If DATABASE_URL is unset (e.g. local dev), every function is a safe no-op and the
app falls back to its original SQLite-only behaviour.
"""
from __future__ import annotations
import os
import logging

_log = logging.getLogger('app')


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
        _log.warning('[rankings-store] psycopg2 not installed; external store disabled')
        return None
    return psycopg2.connect(url, connect_timeout=10)


def init_external() -> None:
    """Create the rankings table if it doesn't exist."""
    conn = _conn()
    if not conn:
        return
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS player_rankings (
                    player_id   text PRIMARY KEY,
                    custom_rank integer,
                    notes       text DEFAULT '',
                    updated_at  timestamptz DEFAULT now()
                )
            """)
    finally:
        conn.close()


# Did THIS boot succeed in replacing the local cache from the durable store?
#
#   None   not attempted (no DATABASE_URL, or init hasn't run)
#   True   the local player_rankings table mirrors the external one
#   False  the external store could not be read; local holds whatever
#          rankings_seed.json provided, which is a committed bootstrap file
#          that can be months old
#
# This is load-bearing rather than diagnostic. save_rankings() below receives the
# FULL board with custom_rank=None for anything unranked, and turns those Nones
# into DELETEs. Saving from an unhydrated cache would therefore delete every
# ranking the seed file happens not to contain — silently, and from the only
# durable copy. Observed live: external held 422 rankings while local served the
# 356-entry June seed, so one Save would have destroyed 69 of them.
_hydrated = None


def hydration_state():
    return _hydrated


def mark_hydrated(ok: bool) -> None:
    global _hydrated
    _hydrated = ok


def load_rankings():
    """Return [{player_id, custom_rank, notes}] from the external store.

    Returns None when the store isn't configured/reachable so callers can tell
    "no external store" apart from "external store is empty" ([])."""
    conn = _conn()
    if not conn:
        return None
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT player_id, custom_rank, notes FROM player_rankings")
            return [
                {'player_id': r[0], 'custom_rank': r[1], 'notes': r[2] or ''}
                for r in cur.fetchall()
            ]
    except Exception as e:
        _log.warning(f'[rankings-store] load failed: {e!r}')
        return None
    finally:
        conn.close()


def save_rankings(rankings) -> int:
    """Mirror the full rankings list into the external store.

    Same contract as the frontend/DB: custom_rank None => unranked (delete).
    Batched into one DELETE + one multi-row upsert. Returns rows upserted."""
    conn = _conn()
    if not conn:
        return 0
    upserts = [
        (r['player_id'], int(r['custom_rank']), r.get('notes', '') or '')
        for r in rankings
        if r.get('player_id') and r.get('custom_rank') is not None
    ]
    deletes = [
        r['player_id'] for r in rankings
        if r.get('player_id') and r.get('custom_rank') is None
    ]
    try:
        from psycopg2.extras import execute_values
        with conn, conn.cursor() as cur:
            if deletes:
                cur.execute("DELETE FROM player_rankings WHERE player_id = ANY(%s)", (deletes,))
            if upserts:
                execute_values(cur, """
                    INSERT INTO player_rankings (player_id, custom_rank, notes, updated_at)
                    VALUES %s
                    ON CONFLICT (player_id) DO UPDATE SET
                        custom_rank = excluded.custom_rank,
                        notes       = excluded.notes,
                        updated_at  = now()
                """, upserts, template="(%s, %s, %s, now())")
        return len(upserts)
    except Exception as e:
        _log.warning(f'[rankings-store] save failed: {e!r}')
        return 0
    finally:
        conn.close()
