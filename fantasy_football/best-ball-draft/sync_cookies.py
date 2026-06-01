#!/usr/bin/env python3
"""
sync_cookies.py — Push Firefox DraftKings cookies, user GUID, and saved draft IDs
to the Render server. Run this once after deploying, and again if DK logs you out.

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

CONFIG_FILE   = os.path.expanduser('~/.bba_sync_config')
BASEDIR       = os.path.dirname(os.path.abspath(__file__))
GUID_FILE     = os.path.join(BASEDIR, 'app', 'data', '.dk_user_guid')
DRAFTS_FILE   = os.path.join(BASEDIR, '.saved_drafts.json')


def load_config():
    try:
        with open(CONFIG_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(cfg, f, indent=2)
    os.chmod(CONFIG_FILE, 0o600)


def get_config():
    cfg = load_config()
    if not cfg.get('url') or not cfg.get('api_key'):
        print('First-time setup — enter your Render details.')
        print('(Find these in the Render dashboard after deploying)\n')
        cfg['url']     = input('Render app URL (e.g. https://best-ball-draft-assistant.onrender.com): ').strip().rstrip('/')
        cfg['api_key'] = input('BBA_API_KEY (from Render → Environment): ').strip()
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


def read_guid():
    try:
        with open(GUID_FILE) as f:
            return f.read().strip()
    except Exception:
        return None


def read_saved_drafts():
    try:
        with open(DRAFTS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


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

    guid         = read_guid()
    saved_drafts = read_saved_drafts()

    payload = {'cookies': cookies}
    if guid:
        payload['guid'] = guid
    if saved_drafts:
        payload['saved_drafts'] = saved_drafts

    print(f'Found {len(cookies)} cookies'
          + (f', GUID: {guid[:8]}…' if guid else ', no GUID cached')
          + (f', {len(saved_drafts)} saved draft(s)' if saved_drafts else ', no saved drafts'))
    print(f'Syncing to {cfg["url"]}…')

    try:
        r = requests.post(
            f'{cfg["url"]}/api/sync-cookies',
            json=payload,
            headers={'X-Api-Key': cfg['api_key']},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        print(f'✓ Synced {data.get("count", "?")} cookies. DraftKings auth is live on Render.')
        if guid:
            print('✓ GUID synced.')
        if saved_drafts:
            print(f'✓ {len(saved_drafts)} draft ID(s) synced.')
    except requests.HTTPError as e:
        print(f'ERROR {e.response.status_code}: {e.response.text[:200]}')
        if e.response.status_code == 401:
            print('Hint: API key mismatch — check BBA_API_KEY in Render environment variables.')
            cfg.pop('api_key', None)
            save_config(cfg)
    except requests.ConnectionError:
        print(f'ERROR: Could not reach {cfg["url"]} — is the Render app deployed and running?')
    except Exception as e:
        print(f'ERROR: {e}')


if __name__ == '__main__':
    main()
