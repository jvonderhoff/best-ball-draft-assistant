#!/usr/bin/env python3
"""
sync_cookies.py — Push Firefox DraftKings cookies to the Render server.

Run this once after deploying, and again whenever DK logs you out (~every few weeks).

Usage:
    python3 sync_cookies.py
    python3 sync_cookies.py --url https://your-app.onrender.com --key YOUR_API_KEY
"""
import argparse
import glob
import json
import os
import shutil
import sqlite3
import tempfile
import requests

# ── Config — edit these or pass as CLI args ────────────────────────────────────
RENDER_URL = os.environ.get('BBA_RENDER_URL', 'https://YOUR-APP.onrender.com')
API_KEY    = os.environ.get('BBA_API_KEY',    'YOUR_API_KEY')
# ──────────────────────────────────────────────────────────────────────────────


def read_firefox_dk_cookies():
    patterns = [
        '~/Library/Application Support/Firefox/Profiles/*.default-release*/cookies.sqlite',
        '~/Library/Application Support/Firefox/Profiles/*.default/cookies.sqlite',
        '~/.mozilla/firefox/*.default-release*/cookies.sqlite',
        '~/.mozilla/firefox/*.default/cookies.sqlite',
    ]
    db_path = None
    for pat in patterns:
        matches = glob.glob(os.path.expanduser(pat))
        if matches:
            db_path = matches[0]
            break
    if not db_path:
        raise FileNotFoundError('Firefox cookie database not found')

    tmp = tempfile.mktemp(suffix='.sqlite')
    try:
        shutil.copy2(db_path, tmp)
        conn = sqlite3.connect(tmp)
        rows = conn.execute(
            'SELECT name, value FROM moz_cookies WHERE host LIKE "%draftkings%"'
        ).fetchall()
        conn.close()
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass

    return {name: value for name, value in rows}


def main():
    parser = argparse.ArgumentParser(description='Sync DK cookies to Render')
    parser.add_argument('--url', default=RENDER_URL, help='Render app URL')
    parser.add_argument('--key', default=API_KEY,    help='BBA_API_KEY value')
    args = parser.parse_args()

    if 'YOUR-APP' in args.url or 'YOUR_API_KEY' in args.key:
        print('ERROR: Edit RENDER_URL and API_KEY in sync_cookies.py first,')
        print('       or set BBA_RENDER_URL and BBA_API_KEY environment variables.')
        return

    print('Reading Firefox DraftKings cookies…')
    try:
        cookies = read_firefox_dk_cookies()
    except FileNotFoundError as e:
        print(f'ERROR: {e}')
        print('Make sure Firefox is installed and you are logged in to DraftKings.')
        return

    print(f'Found {len(cookies)} DK cookies. Syncing to {args.url}…')
    try:
        r = requests.post(
            f'{args.url}/api/sync-cookies',
            json={'cookies': cookies},
            headers={'X-Api-Key': args.key},
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        print(f'✓ Synced {data.get("count", "?")} cookies successfully.')
    except requests.HTTPError as e:
        print(f'ERROR: {e.response.status_code} — {e.response.text[:200]}')
    except Exception as e:
        print(f'ERROR: {e}')


if __name__ == '__main__':
    main()
