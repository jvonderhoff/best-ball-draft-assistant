"""Serving the pushed news bundle: the disk mirror, and the ages the UI reads.

Same two-layer shape as the pushed projections payload. Postgres is the durable
copy; a JSON file on disk is the warm read. Render's filesystem is ephemeral, so
the mirror is a cache and never the source of truth — it is rebuilt from Postgres
at boot and on every accepted push.

**Ages are computed here, server-side, on purpose.** `/api/freshness` and the
`/recommend` staleness bar already work this way: a threshold duplicated in
JavaScript drifts from the one in Python and nobody notices, because both keep
rendering something plausible.
"""
from __future__ import annotations

import json
import logging
import os
import time

_log = logging.getLogger('app')

MIRROR_PATH = os.path.join(os.path.dirname(__file__), 'data', 'pushed_news.json')

# The pollers run every 3h and a report is written every morning. These are the
# points at which a job has plainly MISSED a turn, not merely "some time passed" —
# an always-on warning is one nobody reads.
POLL_STALE_AFTER  = 6 * 3600
POLL_BAD_AFTER    = 12 * 3600
WATCH_STALE_AFTER = 30 * 3600
WATCH_BAD_AFTER   = 72 * 3600


def read_mirror() -> dict:
    try:
        with open(MIRROR_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def write_mirror(bundle: dict) -> None:
    """Mirror an accepted push to disk. Raises — the caller reports the failure.

    Not swallowing errors, for the reason projections.write_pushed does not: the
    upload endpoint's job is to say whether the push landed, and a mirror write
    that failed quietly lets it answer yes when the next read serves nothing.
    """
    os.makedirs(os.path.dirname(MIRROR_PATH), exist_ok=True)
    tmp = MIRROR_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(bundle, f)
    os.replace(tmp, MIRROR_PATH)      # atomic; a torn write serves half a feed


def hydrate() -> bool:
    """Rebuild the disk mirror from Postgres at boot. True if it was refreshed.

    An unreachable store leaves whatever survived the filesystem wipe — on Render
    that is nothing, and the page then correctly reports no news rather than
    inventing an empty feed.
    """
    from app import news_store
    if not news_store.external_enabled():
        return False
    try:
        news_store.init_external()
        bundle = news_store.load_bundle()
        if bundle is None:
            _log.warning('[news] store UNREACHABLE at boot — serving whatever is on disk')
            return False
        if bundle:
            write_mirror(bundle)
            return True
    except Exception as e:
        _log.warning(f'[news] hydrate failed: {e!r}')
    return False


def _age(ts, stale_after, bad_after):
    """(seconds, state) for a timestamp, or (None, 'missing')."""
    if not ts:
        return None, 'missing'
    age = max(0.0, time.time() - float(ts))
    state = 'bad' if age >= bad_after else 'stale' if age >= stale_after else 'ok'
    return age, state


def bundle_meta(bundle: dict) -> dict:
    """The two clocks the page shows, and what each one being late would mean.

    Separate on purpose: if the poller stops, the page keeps rendering the same
    stories and nothing else says so; if the report stops, headlines stay current
    but every ADP badge silently freezes. One "last updated" would hide whichever
    actually broke.
    """
    poll_age,  poll_state  = _age(bundle.get('last_poll_at'),
                                  POLL_STALE_AFTER, POLL_BAD_AFTER)
    watch_age, watch_state = _age(bundle.get('watch_generated_at'),
                                  WATCH_STALE_AFTER, WATCH_BAD_AFTER)
    push_age,  push_state  = _age(bundle.get('generated_at'),
                                  POLL_STALE_AFTER, POLL_BAD_AFTER)
    return {
        'poll_age_hours':  round(poll_age / 3600, 1) if poll_age is not None else None,
        'poll_state':      poll_state,
        'watch_age_hours': round(watch_age / 3600, 1) if watch_age is not None else None,
        'watch_state':     watch_state,
        'push_age_hours':  round(push_age / 3600, 1) if push_age is not None else None,
        'push_state':      push_state,
        'items':           len(bundle.get('items') or []),
        'items_stored':    bundle.get('items_stored'),
        'publisher':       bundle.get('publisher') or {},
    }
