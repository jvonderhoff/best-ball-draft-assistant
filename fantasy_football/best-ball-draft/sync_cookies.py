#!/usr/bin/env python3
"""
sync_cookies.py — Push Firefox DraftKings cookies to the Render server AND
update Render environment variables so they persist across deploys automatically.

Run this once after deploying, and again if DK logs you out (~every few weeks).
After the first run, Render redeploys will automatically pick up saved cookies.

    python3 sync_cookies.py

First run will prompt for your Render URL, API key, and Render service ID.
Config is saved to ~/.bba_sync_config.
"""
import glob
import json
import os
import shutil
import sqlite3
import tempfile
import requests

CONFIG_FILE = os.path.expanduser('~/.bba_sync_config')
BASEDIR     = os.path.dirname(os.path.abspath(__file__))
GUID_FILE   = os.path.join(BASEDIR, 'app', 'data', '.dk_user_guid')
DRAFTS_FILE = os.path.join(BASEDIR, '.saved_drafts.json')


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
    changed = False

    if not cfg.get('url') or not cfg.get('api_key'):
        print('First-time setup — enter your Render app details.\n')
        cfg['url']     = input('Render app URL (e.g. https://best-ball-draft-assistant.onrender.com): ').strip().rstrip('/')
        cfg['api_key'] = input('BBA_API_KEY (from Render → Environment): ').strip()
        changed = True

    if not cfg.get('render_api_key'):
        print('\nOptional: Render API key lets cookies persist across deploys automatically.')
        print('Get it from: Render dashboard → Account (top-right) → API Keys → Create API Key')
        key = input('Render API Key (press Enter to skip): ').strip()
        if key:
            cfg['render_api_key'] = key
            changed = True

    if cfg.get('render_api_key') and not cfg.get('render_service_id'):
        print('\nRender Service ID — from your service URL:')
        print('  dashboard.render.com/web/srv-XXXXXXXXX  →  srv-XXXXXXXXX')
        sid = input('Render Service ID (press Enter to skip): ').strip()
        if sid:
            cfg['render_service_id'] = sid
            changed = True

    if changed:
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


def update_render_env_vars(cfg, cookies, guid, saved_drafts):
    """Update Render env vars so cookies persist across deploys."""
    api_key    = cfg.get('render_api_key', '')
    service_id = cfg.get('render_service_id', '')
    if not api_key or not service_id:
        return  # skipped — not configured

    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }

    # Fetch existing env vars so we don't overwrite others
    try:
        r = requests.get(
            f'https://api.render.com/v1/services/{service_id}/env-vars',
            headers=headers, timeout=10,
        )
        r.raise_for_status()
        existing = {item['envVar']['key']: item['envVar']['value'] for item in r.json()}
    except Exception as e:
        print(f'  ⚠ Could not fetch Render env vars: {e}')
        return

    # Update the three DK vars
    existing['DK_COOKIES']       = json.dumps(cookies)
    existing['DK_USER_GUID']     = guid or existing.get('DK_USER_GUID', '')
    existing['DK_SAVED_DRAFTS']  = json.dumps(saved_drafts) if saved_drafts else existing.get('DK_SAVED_DRAFTS', '{}')

    env_list = [{'key': k, 'value': v} for k, v in existing.items()]
    try:
        r = requests.put(
            f'https://api.render.com/v1/services/{service_id}/env-vars',
            headers=headers, json=env_list, timeout=15,
        )
        r.raise_for_status()
        print('✓ Render env vars updated — cookies will persist across future deploys.')
    except Exception as e:
        print(f'  ⚠ Could not update Render env vars: {e}')


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

    print(f'Found {len(cookies)} cookies'
          + (f', GUID: {guid[:8]}…' if guid else ', no GUID cached')
          + (f', {len(saved_drafts)} saved draft(s)' if saved_drafts else ''))
    print(f'Syncing to {cfg["url"]}…')

    # Push to live server
    try:
        payload = {'cookies': cookies}
        if guid:
            payload['guid'] = guid
        if saved_drafts:
            payload['saved_drafts'] = saved_drafts

        r = requests.post(
            f'{cfg["url"]}/api/sync-cookies',
            json=payload,
            headers={'X-Api-Key': cfg['api_key']},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        print(f'✓ Synced {data.get("count", "?")} cookies to live server.')
        if guid:   print('✓ GUID synced.')
        if saved_drafts: print(f'✓ {len(saved_drafts)} draft ID(s) synced.')
    except requests.HTTPError as e:
        print(f'ERROR {e.response.status_code}: {e.response.text[:200]}')
        if e.response.status_code == 401:
            cfg.pop('api_key', None)
            save_config(cfg)
        return
    except requests.ConnectionError:
        print(f'ERROR: Could not reach {cfg["url"]}')
        return
    except Exception as e:
        print(f'ERROR: {e}')
        return

    # Update Render env vars (persist across deploys)
    update_render_env_vars(cfg, cookies, guid, saved_drafts)


if __name__ == '__main__':
    main()
