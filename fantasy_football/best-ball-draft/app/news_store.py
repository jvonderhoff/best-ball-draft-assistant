"""Durable external store for the pushed news bundle.

News is captured on the Mac — `com.bba.newspoll` polls two RSS feeds every three
hours into the projections app's `store.db`, and `market-watch.py` joins it to the
DK ADP series. None of that can run here: the pipeline is local by design
(PROJECTIONS_SPLIT, ARCHITECTURE §7), and this app has no news feed of its own.

So this is the same shape as `projections_payload` in projections_store, and for
the same reason: the computation happens elsewhere and the RESULT is pushed. One
slot, replaced wholesale. A news bundle is one atomic statement about what the
feeds said at a moment in time; merging a new push into an old one would leave
items nobody pushed sitting beside items somebody did, under a single
`generated_at` claiming to describe both.

**Why this exists at all when the Analysis app already renders it:** that app is
not deployed and will not be — deploying it as-is would put an unauthenticated
`/api/publish` on the public internet, and its props fetch is blocked from
datacenter IPs anyway. The news page is the one piece that is genuinely cheap to
serve remotely: it is read-only, needs no pool, and touches no network. Pushing
the bundle here reuses the publish path that already works rather than standing up
a second Render service and a second cold-start chain.

If DATABASE_URL is unset (local dev), every function is a safe no-op and the app
falls back to the disk mirror.
"""
from __future__ import annotations

import json
import logging
import os

_log = logging.getLogger('app')


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
        _log.warning('[news-store] psycopg2 not installed; external store disabled')
        return None
    # Never raise. Every load_* here documents "None when unreachable", and that
    # contract held only for the cheap cases until 2026-08-14, when a real outage
    # RAISED and took two safety nets with it. See rankings_store._conn.
    try:
        return psycopg2.connect(url, connect_timeout=10)
    except Exception as e:
        _log.warning(f'[news-store] connect failed: {e!r}')
        return None


def init_external() -> None:
    conn = _conn()
    if not conn:
        return
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS news_bundle (
                    slot         TEXT PRIMARY KEY,
                    generated_at DOUBLE PRECISION,
                    item_count   INTEGER,
                    bundle       TEXT,
                    publisher    TEXT,
                    uploaded_at  TIMESTAMPTZ DEFAULT now()
                )
            """)
    except Exception as e:
        _log.warning(f'[news-store] init failed: {e!r}')
    finally:
        conn.close()


def load_bundle():
    """The stored bundle, or None when the store is unreachable.

    None and {} mean different things and callers depend on the difference: None is
    "the database did not answer", {} is "it answered and there is nothing stored".
    Collapsing them is how a page ends up reporting an outage as an empty news day.
    """
    conn = _conn()
    if not conn:
        return None
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT bundle FROM news_bundle WHERE slot = 'current'")
            row = cur.fetchone()
            if not row or not row[0]:
                return {}
            return json.loads(row[0])
    except Exception as e:
        _log.warning(f'[news-store] load failed: {e!r}')
        return None
    finally:
        conn.close()


def save_bundle(bundle: dict, publisher: dict | None = None) -> bool:
    """Replace the stored bundle. True only if Postgres accepted the write."""
    conn = _conn()
    if not conn:
        return False
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""
                INSERT INTO news_bundle
                    (slot, generated_at, item_count, bundle, publisher, uploaded_at)
                VALUES ('current', %s, %s, %s, %s, now())
                ON CONFLICT (slot) DO UPDATE SET
                    generated_at = excluded.generated_at,
                    item_count   = excluded.item_count,
                    bundle       = excluded.bundle,
                    publisher    = excluded.publisher,
                    uploaded_at  = now()
            """, (bundle.get('generated_at') or 0,
                  len(bundle.get('items') or []),
                  json.dumps(bundle),
                  json.dumps(publisher or {})))
        return True
    except Exception as e:
        _log.warning(f'[news-store] save failed: {e!r}')
        return False
    finally:
        conn.close()
