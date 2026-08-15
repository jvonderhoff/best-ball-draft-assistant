"""Durable external store for the kv_store key/value table.

The local SQLite kv_store is where Yahoo OAuth tokens live, and Render's
filesystem is ephemeral — so every deploy and every idle spin-down silently
destroyed them. The saver in yahoo_fetcher claims SQLite "survives across
workers and redeploys"; it does not, and the symptom is a bare 403 from the
Yahoo API with nothing to indicate the credentials were simply gone.

An env-var fallback cannot fix this on its own. Yahoo access tokens expire
roughly hourly and _refresh_tokens writes the rotated pair back via _save_tokens,
so the storage has to be writable as well as durable. That is what the external
Postgres provides, and it is the same pattern already used for rankings, draft
history and projection inputs.

SECURITY NOTE: unlike the other stores, this table holds credentials. It lives in
the same private Postgres addressed by DATABASE_URL, so it inherits that database's
access control — but treat a dump of this table as a secret, and revoke Yahoo
tokens rather than only deleting rows if it is ever exposed.

If DATABASE_URL is unset (local dev), every function is a safe no-op.
"""
from __future__ import annotations

import logging
import os

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
        _log.warning('[kv-store] psycopg2 not installed; external store disabled')
        return None
    # Never raise — the None-means-unreachable contract every caller here relies
    # on. See rankings_store._conn for what a raising connect silently broke.
    try:
        return psycopg2.connect(url, connect_timeout=10)
    except Exception as e:
        _log.warning(f'[kv-store] connect failed: {e!r}')
        return None


def init_external() -> None:
    """Create the kv table if it doesn't exist."""
    conn = _conn()
    if not conn:
        return
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS kv_store (
                    key        text PRIMARY KEY,
                    value      text,
                    updated_at timestamptz DEFAULT now()
                )
            """)
    except Exception as e:
        _log.warning(f'[kv-store] init failed: {e!r}')
    finally:
        conn.close()


def load_all():
    """Return {key: value}, or None when the store is unreachable.

    None distinguishes an outage from a genuinely empty store, so the hydrate
    never wipes local credentials because Postgres happened to be down.
    """
    conn = _conn()
    if not conn:
        return None
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT key, value FROM kv_store")
            return {r[0]: r[1] for r in cur.fetchall()}
    except Exception as e:
        _log.warning(f'[kv-store] load failed: {e!r}')
        return None
    finally:
        conn.close()


def save(key: str, value: str) -> bool:
    """Mirror one key into the external store. Returns True on success."""
    conn = _conn()
    if not conn:
        return False
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""
                INSERT INTO kv_store (key, value, updated_at)
                VALUES (%s, %s, now())
                ON CONFLICT (key) DO UPDATE SET
                    value = excluded.value, updated_at = now()
            """, (key, value))
        return True
    except Exception as e:
        _log.warning(f'[kv-store] save failed for {key!r}: {e!r}')
        return False
    finally:
        conn.close()
