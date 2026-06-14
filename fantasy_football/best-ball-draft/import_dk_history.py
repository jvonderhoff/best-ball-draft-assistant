#!/usr/bin/env python3
"""Backfill draft history from DraftKings.

Pulls your completed drafts straight from DK and saves them into history
(which now write-throughs to the durable external store, Neon). Run locally,
where your DK cookies live.

Prereqs:
  • DK cookies available (Firefox), same as the live-draft features use
  • Your DK user GUID — from app/data/.dk_user_guid, the DK_USER_GUID env var,
    or pass --guid <value>

Usage:
  python import_dk_history.py                 # all saved drafts (.saved_drafts.json)
  python import_dk_history.py --ids 191061875 191154362
  python import_dk_history.py --guid <GUID>   # if the GUID file isn't present
  python import_dk_history.py --min-picks 18  # completeness threshold (default 18)
  DATABASE_URL=postgres://... python import_dk_history.py   # also persists to Neon
"""
import os
import sys
import json
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_BASEDIR = os.path.dirname(os.path.abspath(__file__))
_SAVED_DRAFTS = os.path.join(_BASEDIR, '.saved_drafts.json')
_GUID_FILE = os.path.join(_BASEDIR, 'app', 'data', '.dk_user_guid')


def _ensure_guid(cli_guid):
    """Make sure a GUID is in place; DK pick attribution needs it."""
    from app.data.api_fetcher import _load_user_guid, _save_user_guid
    guid = (cli_guid or '').strip() or _load_user_guid() or os.environ.get('DK_USER_GUID', '').strip()
    if guid and not _load_user_guid():
        _save_user_guid(guid)   # cache it so api_fetcher picks it up
    return guid


def _load_items(ids):
    """Return [{id, entry_id, name}] from --ids or .saved_drafts.json."""
    saved = {}
    if os.path.exists(_SAVED_DRAFTS):
        try:
            saved = json.load(open(_SAVED_DRAFTS))
        except Exception:
            saved = {}
    if ids:
        return [{'id': i, 'entry_id': (saved.get(i) or {}).get('entry_id'),
                 'name': (saved.get(i) or {}).get('name')} for i in ids]
    return [{'id': did, 'entry_id': info.get('entry_id'), 'name': info.get('name')}
            for did, info in saved.items()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ids', nargs='*', help='specific DK draft/contest IDs')
    ap.add_argument('--guid', help='DK user GUID (if the cached file is missing)')
    ap.add_argument('--min-picks', type=int, default=18, help='min of your picks to count as complete')
    args = ap.parse_args()

    from app.database import init_db
    init_db()

    persist = 'Neon' if os.environ.get('DATABASE_URL') else 'local only'

    if args.ids:
        # Contest/board path for specific drafts — needs the GUID for pick attribution.
        guid = _ensure_guid(args.guid)
        if not guid:
            print('✗ No DK user GUID available. Pass --guid <value>, set DK_USER_GUID, '
                  'or run sync_cookies.py first. Without it, your picks can\'t be identified.')
            return 1
        items = _load_items(args.ids)
        print(f'Importing {len(items)} draft(s) by ID from DK '
              f'(GUID {guid[:8]}…, persist={persist})\n')
        from app.dk_import import import_many
        results = import_many(items, min_picks=args.min_picks)
    else:
        # Default: completed-draft rosters via the lineup endpoint (no GUID/entry_id needed).
        print(f'Importing completed-draft rosters from DK (persist={persist})\n')
        from app.dk_import import import_lineups
        results = import_lineups(min_picks=args.min_picks)

    counts = {}
    for r in results:
        counts[r['status']] = counts.get(r['status'], 0) + 1
        icon = {'imported': '✓', 'duplicate': '•', 'incomplete': '·',
                'no_picks': '✗', 'error': '✗'}.get(r['status'], '?')
        line = f"  {icon} {r['contest_id']:<12} {r['status']:<11} picks={r['my_picks']}"
        if r.get('reason'):
            line += f"  ({r['reason']})"
        print(line)

    print('\nSummary: ' + ', '.join(f'{k}={v}' for k, v in sorted(counts.items())))
    return 0


if __name__ == '__main__':
    sys.exit(main())
