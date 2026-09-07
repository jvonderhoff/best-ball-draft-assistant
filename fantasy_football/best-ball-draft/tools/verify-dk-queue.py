#!/usr/bin/env python3
"""Prove the DK draft queue write actually changes the queue.

This exists because `POST /api/dk-draft/queue/<id>` shipped on 2026-06-01 sending
{"draftableId": N}, and DK answered every one of those with HTTP 200 and a genuine
draftPreferences body while ignoring the write completely. Nothing in the app read
the queue back, so the endpoint sat inert for three months — CLAUDE.md bug class #6,
a parameter accepted, echoed and ignored.

The real contract, read out of DK's own draft-room bundle:

    POST /drafts/v1/snake/{contest}/entries/{entry}/draftPreferences/queue/players
    {"playerIds": [...]}            # the WHOLE queue, keyed on playerId

So this script does three things against a live draft, and restores what it found:

  1. adds a player and reads the queue back      — the write must land
  2. re-posts the OLD {"draftableId": N} body    — it must WIPE the queue
  3. removes the player and reads back           — the queue must equal the baseline

Step 2 is the regression that matters, and it is worse than "ignored": a body with no
`playerIds` key is read as an EMPTY queue, so the old call replaced the whole queue
with nothing. Measured on live draft 194778826, 2026-09-07: [Strange, Andrews] -> [].
The `+ Queue` button was not failing to add a player — it was deleting the queue on
every click. Without this step a revert to the old body reads as a passing test, which
is how three months went by.

Usage:

    python3 tools/verify-dk-queue.py                     # first live draft, first
    python3 tools/verify-dk-queue.py --draft 194886809   # available player
    python3 tools/verify-dk-queue.py --draft 194886809 --player-id 1444547

Writes to a REAL draft queue. It removes what it adds, but a queued player can be
auto-drafted if your pick arrives while the script is running — so run it on a draft
that is not on the clock. Exits non-zero on any failure.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.app import app, _resolve_entry_id                          # noqa: E402
from app.data.api_fetcher import (_dk_session, _load_user_guid,     # noqa: E402
                                  fetch_dk_draft_status, dk_player_index,
                                  read_dk_queue, write_dk_queue)

FAILURES: list[str] = []


def check(label, ok, detail=''):
    print(f'  {"OK  " if ok else "FAIL"}  {label}{"  — " + detail if detail else ""}')
    if not ok:
        FAILURES.append(label)
    return ok


def first_live_draft():
    """A draft the user is actually in, so the script has something to write to."""
    guid = _load_user_guid()
    session = _dk_session()
    if not (guid and session):
        return None
    r = session.get(f'https://api.draftkings.com/drafts/v1/users/{guid}/drafts/live?format=json',
                    timeout=15)
    if not r.ok:
        return None
    drafts = r.json().get('userDrafts') or []
    # Furthest from the clock — the least likely to autodraft what we queue.
    drafts.sort(key=lambda d: d.get('picksUntilOnTheClock') or 0, reverse=True)
    return str(drafts[0]['contestId']) if drafts else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--draft', help='DK contest id (default: your live draft furthest from the clock)')
    ap.add_argument('--player-id', type=int, help='DK playerId to queue (default: first available)')
    args = ap.parse_args()

    draft_id = args.draft or first_live_draft()
    if not draft_id:
        print('No live draft found — pass --draft, or check DK cookies (sync_cookies.py).')
        return 2
    with app.app_context():
        entry_id = _resolve_entry_id(draft_id)
    if not entry_id:
        print(f'No entry_id for draft {draft_id} — is this one of your drafts?')
        return 2

    status = fetch_dk_draft_status(draft_id, entry_id)
    if status is None:
        print(f'Could not read draftStatus for draft {draft_id}.')
        return 2
    did_to_pid, players = dk_player_index(status)
    baseline = read_dk_queue(draft_id, entry_id, status=status)
    print(f'draft {draft_id}  entry {entry_id}  queue at start: {baseline}')

    player_id = args.player_id
    if not player_id:
        player_id = next((pid for pid, p in players.items()
                          if p['available'] and pid not in baseline), None)
    if not player_id:
        print('No available player to queue.')
        return 2
    name = (players.get(player_id) or {}).get('name', f'Player #{player_id}')
    draftable_id = next((d for d, p in did_to_pid.items() if p == player_id), None)
    print(f'test player: {name}  playerId={player_id}  draftableId={draftable_id}\n')

    client = app.test_client()

    # 1 — the write must land, and the read-back must show it
    print('1. add')
    r = client.post(f'/api/dk-draft/queue/{draft_id}',
                    json={'draftable_id': draftable_id})
    check('POST add returns 200', r.status_code == 200, f'got {r.status_code}: {r.get_data(as_text=True)[:200]}')
    after_add = read_dk_queue(draft_id, entry_id)
    check('queue read back contains the player', after_add is not None and player_id in after_add,
          f'queue={after_add}')
    check('GET read path agrees', (client.get(f'/api/dk-draft/queue/{draft_id}')
                                  .get_json() or {}).get('player_ids') == after_add)

    # 2 — the old body, on purpose, to keep the real failure measurable. It is not
    #     inert: no `playerIds` key means an empty list, and the write replaces the
    #     queue with it. Restored on the next line, before step 3 runs.
    print('\n2. old {"draftableId": N} body — must WIPE the queue')
    session = _dk_session(referer=f'https://www.draftkings.com/draft/snake/{draft_id}')
    url = (f'https://api.draftkings.com/drafts/v1/snake/{draft_id}/entries/{entry_id}'
           f'/draftPreferences/queue/players?format=json')
    old = session.post(url, json={'draftableId': int(draftable_id)}, timeout=15)
    print(f'     DK answered {old.status_code}: {old.text[:120]}')
    after_old = read_dk_queue(draft_id, entry_id)
    check('the old body empties the queue', after_old == [], f'{after_add} -> {after_old}')
    write_dk_queue(draft_id, entry_id, after_add)
    check('queue put back after the destructive write',
          read_dk_queue(draft_id, entry_id) == after_add)

    # 3 — remove, and put the queue back exactly as it was found
    print('\n3. remove')
    r = client.post(f'/api/dk-draft/queue/{draft_id}',
                    json={'player_id': player_id, 'action': 'remove'})
    check('POST remove returns 200', r.status_code == 200,
          f'got {r.status_code}: {r.get_data(as_text=True)[:200]}')
    final = read_dk_queue(draft_id, entry_id)
    check('queue restored to what it was', final == baseline, f'{baseline} -> {final}')

    if final != baseline:
        print('\n  restoring the baseline queue')
        write_dk_queue(draft_id, entry_id, baseline)

    print()
    if FAILURES:
        print(f'FAILED: {len(FAILURES)} check(s) — ' + '; '.join(FAILURES))
        return 1
    print('All checks passed — the write lands, and the old body still wipes the queue.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
