#!/usr/bin/env python3
"""
sync_cookies.py — Push Firefox DraftKings cookies to the Render server.

Run this once after deploying, and again whenever DK logs you out (~every few weeks).

    python3 sync_cookies.py

First run will ask for your Render URL and API key and save them to ~/.bba_sync_config.
"""
import glob
import json
import os
import shutil
import sqlite3
import tempfile
import requests

CONFIG_FILE = os.path.expanduser('~/.bba_sync_config')


def load_config():
    try:
        with open(CONFIG_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(cfg, f, indent=2)
    os.chmod(CONFIG_FILE, 0o600)  # readable only by you


def get_config():
    cfg = load_config()

    if not cfg.get('url') or not cfg.get('api_key'):
        print('First-time setup — enter your Render details.')
        print('(Find these in the Render dashboard after deploying)\n')
        cfg['url']     = input('Render app URL (e.g. https://best-ball-assistant.onrender.com): ').strip().rstrip('/')
        cfg['api_key'] = input('BBA_API_KEY (from Render environment variables): ').strip()
        save_config(cfg)
        print(f'\nConfig saved to {CONFIG_FILE}\n')

    return cfg


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
        raise FileNotFoundError('Firefox cookie database not found — make sure Firefox is installed')

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
    cfg = get_config()

    print('Reading Firefox DraftKings cookies…')
    try:
        cookies = read_firefox_dk_cookies()
    except FileNotFoundError as e:
        print(f'ERROR: {e}')
        return

    if not cookies:
        print('ERROR: No DraftKings cookies found — make sure you are logged in to DraftKings in Firefox.')
        return

    print(f'Found {len(cookies)} cookies. Syncing to {cfg["url"]}…')
    try:
        r = requests.post(
            f'{cfg["url"]}/api/sync-cookies',
            json={'cookies': cookies},
            headers={'X-Api-Key': cfg['api_key']},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        print(f'✓ Synced {data.get("count", "?")} cookies. DraftKings auth is live on Render.')
    except requests.HTTPError as e:
        print(f'ERROR {e.response.status_code}: {e.response.text[:200]}')
        if e.response.status_code == 401:
            print('Hint: API key mismatch — check BBA_API_KEY in Render environment variables.')
            # Clear saved key so next run prompts again
            cfg.pop('api_key', None)
            save_config(cfg)
    except requests.ConnectionError:
        print(f'ERROR: Could not reach {cfg["url"]} — is the Render app deployed and running?')
    except Exception as e:
        print(f'ERROR: {e}')


if __name__ == '__main__':
    main()
