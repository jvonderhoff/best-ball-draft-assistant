"""Durable external store for draft history (drafts + draft_picks).

Same approach as rankings_store: the local SQLite tables are a per-boot cache,
the durable copy lives in Postgres (DATABASE_URL) and survives Render's
ephemeral-filesystem resets. Keyed by dk_draft_id — the stable natural key DK
gives every draft. Drafts without a dk_draft_id (rare/legacy) stay local-only.

No-ops entirely when DATABASE_URL is unset (local dev / fallback).
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
    if url.startswith('postgres://'):
        url = 'postgresql://' + url[len('postgres://'):]
    try:
        import psycopg2
    except ImportError:
        _log.warning('[drafts-store] psycopg2 not installed; external store disabled')
        return None
    return psycopg2.connect(url, connect_timeout=10)


def init_external() -> None:
    conn = _conn()
    if not conn:
        return
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS drafts (
                    dk_draft_id text PRIMARY KEY,
                    num_teams   integer,
                    my_position integer,
                    contest     text,
                    entry_fee   double precision,
                    drafted_at  text,
                    created_at  timestamptz DEFAULT now()
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS draft_picks (
                    dk_draft_id text REFERENCES drafts(dk_draft_id) ON DELETE CASCADE,
                    player_id   text,
                    player_name text,
                    pos         text,
                    team        text,
                    adp         double precision,
                    pick_number integer,
                    round       integer,
                    week15      text,
                    week16      text,
                    week17      text
                )
            """)
    finally:
        conn.close()


def load_drafts():
    """Return [{draft fields..., 'picks': [...]}] from the external store.

    None when the store isn't configured/reachable (so callers can tell that
    apart from "configured but empty" => [])."""
    conn = _conn()
    if not conn:
        return None
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""SELECT dk_draft_id, num_teams, my_position, contest, entry_fee, drafted_at
                           FROM drafts ORDER BY created_at""")
            drafts = cur.fetchall()
            cur.execute("""SELECT dk_draft_id, player_id, player_name, pos, team, adp,
                                  pick_number, round, week15, week16, week17
                           FROM draft_picks ORDER BY pick_number""")
            picks = cur.fetchall()
    except Exception as e:
        _log.warning(f'[drafts-store] load failed: {e!r}')
        return None
    finally:
        conn.close()

    by_draft = {}
    for p in picks:
        by_draft.setdefault(p[0], []).append({
            'player_id': p[1], 'player_name': p[2], 'pos': p[3], 'team': p[4],
            'adp': p[5], 'pick_number': p[6], 'round': p[7],
            'week15': p[8], 'week16': p[9], 'week17': p[10],
        })
    return [{
        'dk_draft_id': d[0], 'num_teams': d[1], 'my_position': d[2],
        'contest': d[3], 'entry_fee': d[4], 'drafted_at': d[5],
        'picks': by_draft.get(d[0], []),
    } for d in drafts]


def save_draft(dk_draft_id, num_teams, my_position, contest, entry_fee, drafted_at, picks) -> None:
    """Upsert one draft and replace its picks. No-op without a dk_draft_id.

    `picks` are import-shaped dicts (id/name/...) — the same list save_draft in
    database.py receives — so round is recomputed here as enumerate index + 1."""
    if not dk_draft_id:
        return
    conn = _conn()
    if not conn:
        return
    try:
        from psycopg2.extras import execute_values
        with conn, conn.cursor() as cur:
            cur.execute("""
                INSERT INTO drafts (dk_draft_id, num_teams, my_position, contest, entry_fee, drafted_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (dk_draft_id) DO UPDATE SET
                    num_teams   = excluded.num_teams,
                    my_position = excluded.my_position,
                    contest     = excluded.contest,
                    entry_fee   = excluded.entry_fee,
                    drafted_at  = excluded.drafted_at
            """, (dk_draft_id, num_teams, my_position, contest, entry_fee, drafted_at))
            cur.execute("DELETE FROM draft_picks WHERE dk_draft_id = %s", (dk_draft_id,))
            if picks:
                rows = [
                    (dk_draft_id,
                     p.get('id') or p.get('player_id'),
                     p.get('name') or p.get('player_name'),
                     p.get('pos'), p.get('team'), p.get('adp', 0),
                     p.get('pick_number'), i + 1,
                     p.get('week15'), p.get('week16'), p.get('week17'))
                    for i, p in enumerate(picks)
                ]
                execute_values(cur, """
                    INSERT INTO draft_picks
                        (dk_draft_id, player_id, player_name, pos, team, adp,
                         pick_number, round, week15, week16, week17)
                    VALUES %s
                """, rows)
    except Exception as e:
        _log.warning(f'[drafts-store] save failed: {e!r}')
    finally:
        conn.close()


def delete_draft(dk_draft_id) -> None:
    if not dk_draft_id:
        return
    conn = _conn()
    if not conn:
        return
    try:
        with conn, conn.cursor() as cur:
            cur.execute("DELETE FROM drafts WHERE dk_draft_id = %s", (dk_draft_id,))
    except Exception as e:
        _log.warning(f'[drafts-store] delete failed: {e!r}')
    finally:
        conn.close()
