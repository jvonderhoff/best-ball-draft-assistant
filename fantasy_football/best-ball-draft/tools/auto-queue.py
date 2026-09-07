#!/usr/bin/env python3
"""Keep every live DK draft queue stocked with the V1 recommender's top picks.

Why this exists: a DK pick clock that expires drafts for you. With a queue, it drafts
your queue; with an empty queue, it drafts DK's best-available by ADP. So on a 10-minute
clock the queue IS the plan, and a queue one player deep stops being a plan the moment
someone else takes him. This keeps N deep on every live board and re-scores each pass.

One pass:

  1. read every live draft, and one draftStatus per draft — which carries the board,
     the current queue, and DK's own isAvailable flags in a single call
  2. score with the REAL V1 recommender (tools/queue-recs.js), custom board ON,
     against pool / V2 payload / rankings pulled from the app at run time
  3. set each queue to: whatever YOU queued by hand, still available, in front — then
     the top V1 picks behind it, up to N. `--replace` drops yours instead. It tells
     yours from its own by remembering what it wrote (~/.bba-autoqueue-state.json);
     without that memory every pass would read pass one's picks as hand-made and the
     queue would never be re-ranked again.
  4. read the queue back and check it landed

Step 3's availability filter is the guard that matters, and it is deliberately DK's
flag rather than the pool's: the pool is up to 6h old and a name that fails to match a
live pick reads as undrafted (CLAUDE.md bug class #2, value paid to players who cannot
play). DK's flag is live and cannot miss.

Step 4 is not optional either. The queue write answers 200 to a body it ignores — see
docs/STATUS.md — so a pass that does not read back has proved nothing.

    python3 tools/auto-queue.py --dry-run          # score and print, write nothing
    python3 tools/auto-queue.py                    # one pass over every live draft
    python3 tools/auto-queue.py --depth 8
    python3 tools/auto-queue.py --draft 194290989  # just this one
    python3 tools/auto-queue.py --deadline 2026-09-07T17:30

--deadline makes an unattended job stop deciding for you at a wall-clock time: past it
the script exits without touching a queue, so a launchd timer left loaded goes quiet
instead of drafting your board all night. Exits non-zero if any write failed to land.
"""
from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from app.data.api_fetcher import (_dk_session, _load_user_guid,          # noqa: E402
                                  fetch_dk_draft_picks, fetch_dk_draft_status,
                                  dk_player_index, read_dk_queue, write_dk_queue)

PROD = os.environ.get('DRAFT_APP_URL', 'https://best-ball-draft-assistant.onrender.com')
TOTAL_ROUNDS = 20

# What THIS tool put in each queue last pass. Without it every pass reads its own
# previous writes as hand-picked and refuses to touch them, so the queue freezes at
# pass one's opinion and later passes only top up — which is not what a job that
# re-scores every five minutes is for.
STATE = os.path.join(os.path.expanduser('~'), '.bba-autoqueue-state.json')


def load_state(path):
    try:
        with open(path) as f:
            return {k: [int(v) for v in vs] for k, vs in json.load(f).items()}
    except Exception:
        return {}


def save_state(path, state):
    try:
        with open(path, 'w') as f:
            json.dump(state, f)
    except Exception as e:
        # Not fatal, but say so: a pass that cannot write state will treat its own
        # picks as yours next time round.
        log(f'  !! could not write state to {path}: {e}')


def log(msg=''):
    print(msg, flush=True)


def find_node():
    """Absolute path to node, because launchd hands a job a minimal PATH — no nvm,
    no homebrew — and `node` alone is a FileNotFoundError the first time this runs
    unattended. BBA_NODE overrides everything."""
    found = os.environ.get('BBA_NODE') or shutil.which('node')
    if found:
        return found
    cands = []
    for pat in ('~/.nvm/versions/node/*/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node'):
        cands += glob.glob(os.path.expanduser(pat))
    def ver(path):
        m = re.search(r'/v(\d+)\.(\d+)\.(\d+)/', path)
        return tuple(int(g) for g in m.groups()) if m else (0, 0, 0)
    return sorted(cands, key=ver)[-1] if cands else None


def get_json(url, timeout=90):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())


def live_drafts(session, guid):
    url = f'https://api.draftkings.com/drafts/v1/users/{guid}/drafts/live?format=json'
    return session.get(url, timeout=20).json().get('userDrafts', [])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--depth', type=int, default=6, help='players to keep queued per draft')
    ap.add_argument('--draft', action='append', help='limit to this contest id (repeatable)')
    ap.add_argument('--dry-run', action='store_true', help='score and print, write nothing')
    ap.add_argument('--replace', action='store_true',
                    help='discard players you queued by hand instead of keeping them in front')
    ap.add_argument('--state', default=STATE, help=f'where to remember its own writes (default {STATE})')
    ap.add_argument('--deadline', help='ISO time after which this does nothing (e.g. 2026-09-07T17:30)')
    args = ap.parse_args()

    stamp = dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    if args.deadline:
        try:
            deadline = dt.datetime.fromisoformat(args.deadline)
        except ValueError:
            log(f'[{stamp}] bad --deadline {args.deadline!r}; expected ISO like 2026-09-07T17:30')
            return 2
        if dt.datetime.now() >= deadline:
            log(f'[{stamp}] past deadline {args.deadline} — doing nothing')
            return 0

    state = load_state(args.state)
    session = _dk_session()
    guid = _load_user_guid()
    if not (session and guid):
        log(f'[{stamp}] no DK session — cookies stale? run sync_cookies.py')
        return 2

    drafts = live_drafts(session, guid)
    if args.draft:
        wanted = {str(d) for d in args.draft}
        drafts = [d for d in drafts if str(d['contestId']) in wanted]
    if not drafts:
        log(f'[{stamp}] no live drafts')
        return 0

    # Everything the recommender scores with, pulled fresh. Deliberately NOT
    # app/data/player_cache.json: the committed seed is a bootstrap file and has been
    # 100+ hours stale while looking perfectly healthy.
    pool     = get_json(f'{PROD}/api/players')
    v2       = get_json(f'{PROD}/api/projections-v2')
    rankings = get_json(f'{PROD}/api/rankings')
    ranked   = sum(1 for p in rankings if p.get('custom_rank') is not None)
    log(f'[{stamp}] {len(drafts)} live drafts · pool {len(pool)} · '
        f'V2 {v2.get("count")} {v2.get("source")} {v2.get("age_hours")}h · board {ranked} ranks')
    if v2.get('source') != 'pushed' or v2.get('stale'):
        log(f'  !! V2 payload is {v2.get("source")}, stale={v2.get("stale")} — scoring anyway, but look')

    boards, status_by, avail_by, didmap_by, queue_by = {}, {}, {}, {}, {}
    for ud in drafts:
        cid, eid = str(ud['contestId']), str(ud['entryId'])
        status = fetch_dk_draft_status(cid, eid, session)
        if status is None:
            log(f'  {cid}: draftStatus unreachable — skipped')
            continue
        picks = (fetch_dk_draft_picks(cid, entry_id=eid,
                                      draft_group_id=str(ud.get('draftGroupId')),
                                      status=status) or {})
        if not picks.get('picks'):
            log(f'  {cid}: no picks — skipped')
            continue
        did_to_pid, players = dk_player_index(status)
        boards[cid] = {
            'num_teams': max((p['pick_number'] for p in picks['picks'] if p['round'] == 1), default=0),
            'my_position': picks.get('my_position'),
            'overall_pick': max((p['pick_number'] or 0 for p in picks['picks']), default=0) + 1,
            'picks': picks['picks'],
        }
        status_by[cid]  = status
        avail_by[cid]   = players
        didmap_by[cid]  = did_to_pid
        queue_by[cid]   = read_dk_queue(cid, eid, status=status)
        boards[cid]['entry_id'] = eid
        boards[cid]['until_clock'] = ud.get('picksUntilOnTheClock')
        boards[cid]['name'] = ud.get('contestName', '')

    if not boards:
        log('nothing to score')
        return 2

    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump({'pool': pool, 'v2': v2, 'rankings': rankings,
                   'boards': boards, 'depth': args.depth}, f)
        blob = f.name
    node = find_node()
    if not node:
        os.unlink(blob)
        log('no node on PATH — set BBA_NODE to its absolute path')
        return 2
    try:
        out = subprocess.run([node, os.path.join(ROOT, 'tools', 'queue-recs.js'), blob],
                             capture_output=True, text=True)
    finally:
        os.unlink(blob)
    if out.returncode != 0:
        log('scorer failed:\n' + out.stderr[-2000:])
        return 2
    scored = json.loads(out.stdout)

    failures, written = [], 0
    for cid, r in sorted(scored.items(), key=lambda kv: kv[1].get('overall', 0)):
        b = boards[cid]
        if r.get('error'):
            log(f'  {cid}: {r["error"]} — skipped'); continue
        if r['remaining'] <= 0:
            log(f'  {cid}: complete ({r["made"]} picks) — skipped'); continue
        if r['unmatched']:
            # Not fatal — DK's own availability flag below is what actually protects the
            # queue — but it means the pool and the live board disagree, and that is
            # always worth seeing rather than swallowing.
            log(f'  {cid}: !! {len(r["unmatched"])} picks unmatched to the pool: '
                f'{"; ".join(r["unmatched"][:3])}')

        avail, didmap = avail_by[cid], didmap_by[cid]
        # Anything already in the queue was put there by a person, so it stays, and it
        # stays IN FRONT — the write replaces the whole list, and a tool that quietly
        # drops a hand-picked player is worse than one that queues nobody. Drafted
        # entries fall off here; DK removes them itself, but not before the read.
        mine = set(state.get(cid, []))
        kept = [] if args.replace else [pid for pid in (queue_by[cid] or [])
                                        if (avail.get(pid) or {}).get('available')
                                        and pid not in mine]
        wanted = list(kept)
        names  = [f"{(avail.get(pid) or {}).get('name', pid)} (yours, kept)" for pid in kept]
        # Depth is protection against someone else taking your man, not a plan of N
        # picks — so it is NOT capped by picks remaining. A queue four deep with one
        # round left just means three fallbacks.
        limit = max(args.depth, len(kept))
        for rec in r['recs']:
            if len(wanted) >= limit:
                break
            raw = str(rec['id'])
            pid = didmap.get(int(raw[3:] if raw.startswith('dk_') else raw)) if raw.lstrip('dk_').isdigit() else None
            if not pid or pid in wanted:
                continue
            if not (avail.get(pid) or {}).get('available'):
                continue    # DK says he is gone. The pool may not know yet.
            wanted.append(pid)
            names.append(f"{rec['name']} ({rec['pos']} {rec['team']}, v={rec['value']:.1f})")

        before = queue_by[cid]
        rost = ' '.join(f'{k}{r["roster"].get(k, 0)}' for k in ('QB', 'RB', 'WR', 'TE'))
        log(f'\n  {cid}  pick {r["overall"]} · seat {r["myPos"]}/{r["teams"]} · '
            f'{r["remaining"]} left · {rost} · {b["until_clock"]} until clock')
        log(f'    scoring at {r["pickForRec"]} · queue was {before}')
        for i, n in enumerate(names, 1):
            log(f'    {i}. {n}')
        if not wanted:
            log('    nothing available to queue — skipped'); continue
        if before == wanted:
            log('    queue already correct — no write'); continue
        if args.dry_run:
            log('    DRY RUN — not written'); continue

        after, error = write_dk_queue(cid, b['entry_id'], wanted, session)
        if error:
            log(f'    !! WRITE FAILED: {error}'); failures.append(cid); continue
        # The read-back. A 200 from this endpoint has meant nothing before.
        if after != wanted:
            log(f'    !! queue did not land: wanted {wanted}, DK reports {after}')
            failures.append(cid); continue
        written += 1
        state[cid] = [pid for pid in wanted if pid not in kept]
        log(f'    ✓ queued {len(after)}'
            + (f' ({len(kept)} of them yours)' if kept else ''))

    save_state(args.state, state)
    log(f'\n[{stamp}] {written} queues written, {len(failures)} failed'
        + (f': {failures}' if failures else ''))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
