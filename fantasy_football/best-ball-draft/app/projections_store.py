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
  projections_payload
                    The finished six-field payload PUSHED by the projections app
                    (see docs/PROJECTIONS_SPLIT.md). Unlike the two above it is
                    not an input to a local computation — it IS the computation,
                    performed elsewhere. One row, replaced wholesale.

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
    # Never raise — the None-means-unreachable contract every caller here relies
    # on. See rankings_store._conn for what a raising connect silently broke.
    try:
        return psycopg2.connect(url, connect_timeout=10)
    except Exception as e:
        _log.warning(f'[projections-store] connect failed: {e!r}')
        return None


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
            # One row, always slot='current'. The payload is stored as text rather
            # than jsonb because nothing ever queries INTO it — it is fetched whole
            # or not at all — and text has no adaptation behaviour to be surprised
            # by. The scalar columns beside it are duplicated out of the JSON so
            # that "how old is this and where did it come from" can be answered
            # without parsing a megabyte.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS projections_payload (
                    slot           text PRIMARY KEY,
                    schema_version text NOT NULL,
                    generated_at   double precision,
                    source         text,
                    player_count   integer,
                    payload        text NOT NULL,
                    sources_meta   text,
                    uploaded_at    timestamptz DEFAULT now()
                )
            """)
            # Added after the table shipped, so an existing deployment needs it
            # backfilled rather than recreated.
            cur.execute('ALTER TABLE projections_payload '
                        'ADD COLUMN IF NOT EXISTS sources_meta text')
    except Exception as e:
        _log.warning(f'[projections-store] init failed: {e!r}')
    finally:
        conn.close()


# ── Hydration state ──────────────────────────────────────────────────────────
#
# Did THIS boot succeed in replacing the local caches from the durable store?
# Tracked per dataset, because ESPN projections and props are two independent
# loads and either can fail on its own.
#
#   None   not attempted (no DATABASE_URL, or init hasn't run)
#   True   the local table mirrors the external one
#   False  the external store could not be read; local holds whatever survived
#
# Why this needs recording rather than inferring: the failure has no symptom.
# There is no seed file here, so on Render — where the filesystem is wiped every
# deploy — an unreachable store leaves the local tables simply EMPTY, and V2
# falls back to Sleeper alone. 356 players drop from two projection sources to
# one and the ECR blend doubles from 0.15 to 0.30. Every score shifts, nothing
# errors, nothing is logged, and the numbers stay entirely plausible. By the time
# anyone calls /api/stores/status the external compute has woken up and reports a
# healthy count, so the external column looks fine too — the same way the stale
# rankings board hid for two months.
#
# Unlike rankings, this flag does NOT gate writes. save_rankings() has to be
# blocked when unhydrated because it turns unranked players into DELETEs, so one
# Save from a stale cache destroys durable data. save_espn()/save_props() are
# pure upserts with no delete path, and blocking them would break the obvious
# recovery — pushing props from a residential connection is exactly what you'd
# want to do after a failed hydrate. So this one is diagnostic on purpose.
# `payload` is the pushed six-field artifact and is a slightly different question
# from the other two: not "did the local table get refilled" but "does this
# instance hold the payload the projections app last published". Same three
# states, same reason for recording rather than inferring — a missing payload
# looks exactly like a payload nobody has pushed yet.
_hydrated = {'espn': None, 'props': None, 'payload': None}


def hydration_state() -> dict:
    """{'espn': True|False|None, 'props': …} for this boot. See _hydrated above."""
    return dict(_hydrated)


def mark_hydrated(dataset: str, ok: bool) -> None:
    _hydrated[dataset] = ok


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


# ── The pushed six-field payload ─────────────────────────────────────────────
#
# The projections app computes the payload and POSTs it here; this is where it
# lands. See docs/PROJECTIONS_SPLIT.md §3 for the seam and §4 for why the age of
# what is stored matters more than its contents.

# Major version of the payload contract. Bump when a field CHANGES MEANING, not
# when one is added — V2 reads unknown fields as absent, so additions are
# backward compatible by construction (SPLIT §5). An unknown major is refused at
# upload rather than served, because the failure this guards against is a
# payload whose numbers are still perfectly plausible.
PAYLOAD_SCHEMA_MAJOR = 1


def load_payload():
    """Return the stored payload dict, {} if none has been pushed, or None if unreachable.

    Three-way, and all three are distinct: None is an outage (keep whatever is
    local), {} is "nobody has ever published" (a real, reportable state on a fresh
    database), and a dict is the payload. Collapsing the first two would make an
    unreachable Postgres look exactly like a first run.
    """
    conn = _conn()
    if not conn:
        return None
    try:
        with conn, conn.cursor() as cur:
            cur.execute("""SELECT schema_version, generated_at, source, player_count,
                                  payload, sources_meta
                           FROM projections_payload WHERE slot = 'current'""")
            row = cur.fetchone()
            if not row:
                return {}
            import json
            return {
                'schema_version': row[0],
                'generated_at':   row[1],
                'source':         row[2],
                'player_count':   row[3],
                'players':        json.loads(row[4]),
                # Per-source ages from the publisher. Stored durably rather than
                # left on the instance: without this the ages vanished on every
                # deploy while the payload itself survived, so the freshness panel
                # silently lost its detail rows.
                'sources_meta':   json.loads(row[5]) if row[5] else {},
            }
    except Exception as e:
        _log.warning(f'[projections-store] payload load failed: {e!r}')
        return None
    finally:
        conn.close()


def save_payload(players: list, schema_version: str, generated_at: float,
                 source: str = 'projections-app', sources_meta: dict | None = None) -> bool:
    """Replace the stored payload. Returns True only if Postgres accepted the write.

    Wholesale replacement rather than an upsert per player, deliberately: a
    published payload is one atomic statement about the whole pool at a moment in
    time. Merging a new push into an old one would leave players nobody published
    sitting alongside players somebody did, with a single generated_at claiming to
    describe both.
    """
    conn = _conn()
    if not conn:
        return False
    try:
        import json
        with conn, conn.cursor() as cur:
            cur.execute("""
                INSERT INTO projections_payload
                    (slot, schema_version, generated_at, source, player_count, payload,
                     sources_meta, uploaded_at)
                VALUES ('current', %s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (slot) DO UPDATE SET
                    schema_version = excluded.schema_version,
                    generated_at   = excluded.generated_at,
                    source         = excluded.source,
                    player_count   = excluded.player_count,
                    payload        = excluded.payload,
                    sources_meta   = excluded.sources_meta,
                    uploaded_at    = now()
            """, (schema_version, generated_at, source, len(players), json.dumps(players),
                  json.dumps(sources_meta or {})))
        return True
    except Exception as e:
        _log.warning(f'[projections-store] payload save failed: {e!r}')
        return False
    finally:
        conn.close()
