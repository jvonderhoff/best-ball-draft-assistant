#!/usr/bin/env python3
"""
Fetch betting props locally and push them to the deployed app.

DraftKings' sportsbook API blocks datacenter traffic. The identical fetch that
returns 131 players from a home connection returns 403 Forbidden from Render, so
production can never refresh that book itself — verified by running both within
the same minute. Underdog does not block Render and refreshes there normally.

So DK props are fetched from a machine DK will serve and uploaded. Props feed the
component-level market correction in app/projections.py, which is the only signal
in the model that is independent of the fantasy-industry consensus.

Requires BBA_API_KEY (same key as pull_db.sh) — set it in your shell profile:
    export BBA_API_KEY="...the value from Render's environment..."

Usage:
    python3 tools/push-props.py               # DraftKings (the blocked one)
    python3 tools/push-props.py --book both   # DK + Underdog
    python3 tools/push-props.py --dry-run     # fetch and report, upload nothing
"""
import json
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

SERVER = os.environ.get('BBA_SERVER', 'https://best-ball-draft-assistant.onrender.com')


def fetch(book):
    if book == 'DraftKings':
        from app.data.betting_fetcher import fetch_season_props
        return fetch_season_props(verbose=False)
    from app.data.underdog_fetcher import fetch_season_props as ud
    return ud(verbose=False)


def upload(book, props, api_key):
    body = json.dumps({'book': book, 'props': props}).encode()
    req = urllib.request.Request(
        f'{SERVER}/api/props/upload', data=body, method='POST',
        headers={'Content-Type': 'application/json', 'X-Api-Key': api_key},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def main():
    dry = '--dry-run' in sys.argv
    books = ['DraftKings']
    if '--book' in sys.argv:
        choice = sys.argv[sys.argv.index('--book') + 1].lower()
        books = ['DraftKings', 'Underdog'] if choice == 'both' else \
                ['Underdog'] if choice.startswith('under') else ['DraftKings']

    api_key = os.environ.get('BBA_API_KEY', '')
    if not api_key and not dry:
        print('BBA_API_KEY not set. Add to your shell profile:')
        print('    export BBA_API_KEY="your-key-from-render-env"')
        return 1

    for book in books:
        print(f'Fetching {book} props locally...')
        props = fetch(book)
        if not props:
            print(f'  {book}: nothing returned — skipping rather than uploading an empty set.')
            continue
        markets = sum(len(m) for m in props.values())
        print(f'  {book}: {len(props)} players, {markets} markets')
        if dry:
            continue
        try:
            res = upload(book, props, api_key)
            print(f'  uploaded -> {res}')
        except urllib.error.HTTPError as e:
            print(f'  upload failed: HTTP {e.code} {e.read()[:200].decode(errors="replace")}')
            return 1

    if dry:
        print('\n--dry-run: nothing uploaded.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
