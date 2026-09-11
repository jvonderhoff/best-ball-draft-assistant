#!/usr/bin/env python3
"""Capture this week's best-ball standings from DraftKings and push them to /season.

    .venv/bin/python tools/capture-standings.py            # capture + archive, DRY RUN
    .venv/bin/python tools/capture-standings.py --push     # ...and send to $DRAFT_APP_URL
    tools/capture-standings.sh                             # what launchd runs, Tuesdays

It READS DraftKings, with your own Firefox session, for your own entries. It enters
nothing and changes nothing there. What it can change in production is one table,
`season_snapshots`, and nothing the recommender scores with reads that table.

── Why this runs on the Mac and not on Render ──────────────────────────────────

DK's standings are only ever as of NOW. A missed Tuesday is a week of rank history
gone for good, so the capture has to be the dependable half — and the dependable DK
session is the one in Firefox here, not the hand-synced copy on Render that expires
without telling anyone.

Every capture is archived to data/season/<season>/weekNN.json BEFORE anything is
pushed. The archive is the complete record: the page can be rebuilt from it if
production loses the table, and the reverse is not true.

── The requests, about 165 for 81 entries ───────────────────────────────────────

    1        /mycontests          every entry's rank and points, one page
    1/group  draftables           draftable id -> DK playerId, position, team
    1/entry  scores leaderboard   the 12 pod totals, which is where the line is
    1/entry  scores entries       this week's 20-player scorecard

── Exit codes ───────────────────────────────────────────────────────────────────

    0  captured (and pushed, with --push), nothing to look at
    1  failed — the message says where; a push failure still leaves the archive
    2  refused to push: no --target / DRAFT_APP_URL, or no BBA_API_KEY
    3  captured and pushed, WITH warnings worth reading
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import requests  # noqa: E402

from app import season as seasons  # noqa: E402

MYCONTESTS = 'https://www.draftkings.com/mycontests'
DRAFTABLES = 'https://api.draftkings.com/draftgroups/v1/draftgroups/{dg}/draftables?format=json'
LEADERBOARD = 'https://api.draftkings.com/scores/v1/leaderboards/{cid}?format=json&embed=leaderboard'
SCORECARD = 'https://api.draftkings.com/scores/v2/entries/{dg}/{eid}?format=json&embed=roster'
GAME_TYPE_BESTBALL = 145
PACE = 0.25
ARCHIVE = ROOT / 'data' / 'season'
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')


class CaptureError(RuntimeError):
    """Raised rather than returning partial or empty data — the two look alike."""


def dk_session() -> requests.Session:
    from app.data.api_fetcher import _get_firefox_dk_cookies_dict
    cookies = _get_firefox_dk_cookies_dict()
    if not cookies:
        raise CaptureError('no DraftKings cookies in the local Firefox profile. '
                           'Log in to draftkings.com in Firefox and re-run.')
    s = requests.Session()
    s.headers.update({'User-Agent': UA, 'Accept': 'application/json, text/html, */*',
                      'Referer': 'https://www.draftkings.com/'})
    # Scoped to draftkings.com, never `cookies.update(dict)`: that makes domain-less
    # cookies requests sends to ANY host, and a DK export that redirected to S3 once
    # carried the whole login jar there with it (dfs/standings.py, 2026-09-10).
    for name, value in cookies.items():
        s.cookies.set(name, value, domain='.draftkings.com', path='/')
    return s


def get_json(s, url: str, what: str, timeout: int = 30) -> dict:
    """One GET with one retry. Raises CaptureError naming what failed and how."""
    last = None
    for attempt in (1, 2):
        try:
            r = s.get(url, timeout=timeout)
            if r.ok:
                return r.json()
            last = f'HTTP {r.status_code}: {r.text[:120]!r}'
        except (requests.RequestException, ValueError) as exc:
            last = f'{type(exc).__name__}: {exc}'
        if attempt == 1:
            time.sleep(2)
    raise CaptureError(f'{what}: {last}')


def best_ball_contests(s) -> list:
    """Every best-ball entry on the account, from the JSON embedded in /mycontests."""
    try:
        html = s.get(MYCONTESTS, timeout=30).text
    except requests.RequestException as exc:
        raise CaptureError(f'/mycontests unreachable: {exc}') from exc
    dec, idx, found = json.JSONDecoder(), 0, {}
    while True:
        i = html.find('{"ContestId":', idx)
        if i < 0:
            break
        try:
            obj, idx = dec.raw_decode(html, i)
        except ValueError:
            idx = i + 13
            continue
        if obj.get('GameTypeId') == GAME_TYPE_BESTBALL and obj.get('UserContestId'):
            found.setdefault(str(obj['ContestId']), obj)
    if not found:
        # DK serves this page whether or not you are logged in; logged out, it simply
        # has no contests in it. "0 entries" would be a lie told with confidence.
        raise CaptureError('/mycontests lists no best-ball entries — the DK session has '
                           'almost certainly expired. Log in again in Firefox.')
    return list(found.values())


def capture(s, pace: float = PACE, say=print) -> dict:
    contests = best_ball_contests(s)
    year = Counter(seasons.season_of(o.get('ContestStartDate'))
                   for o in contests).most_common(1)[0][0]
    if not seasons.season_config(year):
        raise CaptureError(f'these contests belong to the {year} season, which is not '
                           f'declared in app/season.py SEASONS. Add it (one entry) and re-run.')
    say(f'contests    {len(contests)} best-ball entries on /mycontests, season {year}')

    draftables = {}
    for dg in sorted({str(o.get('DraftGroupId')) for o in contests}):
        body = get_json(s, DRAFTABLES.format(dg=dg), f'draftables for group {dg}', timeout=60)
        for d in body.get('draftables') or []:
            draftables[str(d.get('draftableId'))] = d
        time.sleep(pace)
    if not draftables:
        raise CaptureError('draftables came back empty, so no player can be keyed by DK '
                           'playerId — refusing rather than keying on draftable ids')

    players, entries = {}, []
    problems, timing = [], []        # always worth reading / only once games are over
    games, weeks = Counter(), Counter()
    for n, o in enumerate(sorted(contests, key=lambda c: str(c['ContestId'])), 1):
        cid, eid, dg = str(o['ContestId']), str(o['UserContestId']), str(o.get('DraftGroupId'))
        e = {
            'contest_id': cid, 'entry_id': eid, 'draft_group_id': dg,
            'contest': o.get('ContestName'), 'entry_fee': o.get('BuyInAmount'),
            'rank': int(o.get('ResultsRank') or 0),
            'points': round(float(o.get('PlayerPoints') or 0), 2),
            'minutes_left': o.get('TimeRemaining'),
            # Kept for the playoff weeks, which nobody has captured yet: an entry that
            # advances may move to a new contest id, and these are the fields most
            # likely to tie the two together. Unverified until week 15.
            'round': o.get('MegaContestRoundNumber'),
            'mega_contest_id': str(o.get('MegaContestId') or ''),
            'lineup_id': str(o.get('LineupId') or ''),
            'tournament_key': o.get('TournamentKey'),
            'entrants': o.get('NumberOfEntrants'),
            'pod': [], 'roster': [],
        }

        try:
            board = get_json(s, LEADERBOARD.format(cid=cid),
                             f'{cid} leaderboard').get('leaderBoard') or []
            # Totals only. The other eleven usernames are not needed for a line, and
            # the page this feeds is on the public internet.
            e['pod'] = [round(float(r.get('fantasyPoints') or 0), 2) for r in board]
            mine = [r for r in board if str(r.get('entryKey')) == eid]
            if not mine:
                problems.append(f'{cid}: this entry is not on its own leaderboard')
            else:
                lb_pts = round(float(mine[0].get('fantasyPoints') or 0), 2)
                if mine[0].get('rank') != e['rank'] or abs(lb_pts - e['points']) > 0.005:
                    timing.append(f"{cid}: /mycontests rank {e['rank']} / {e['points']:.2f}, "
                                  f"leaderboard rank {mine[0].get('rank')} / {lb_pts:.2f}")
        except CaptureError as exc:
            problems.append(f'{exc} — no advance line for this entry')
        time.sleep(pace)

        try:
            body = get_json(s, SCORECARD.format(dg=dg, eid=eid), f'{cid} scorecard')
            ent = (body.get('entries') or [{}])[0]
            if ent.get('timeRemaining') is not None:
                e['minutes_left'] = ent['timeRemaining']
            unkeyed = 0
            for c in (ent.get('roster') or {}).get('scorecards') or []:
                d = draftables.get(str(c.get('draftableId'))) or {}
                if d.get('playerId'):
                    key = str(d['playerId'])
                else:
                    unkeyed += 1
                    key = f"draftable:{c.get('draftableId')}"
                players.setdefault(key, {'name': c.get('displayName'),
                                         'pos': d.get('position'),
                                         'team': d.get('teamAbbreviation')})
                e['roster'].append([key, c.get('rosterPosition'),
                                    round(float(c.get('score') or 0), 2)])
                comp = c.get('competition') or {}
                w = seasons.week_of(year, comp.get('startTime'))
                if w is not None:
                    weeks[w] += 1
                    games[comp.get('competitionStatus') or '?'] += 1
            e['lineup_points'] = round(sum(sc for _, slot, sc in e['roster'] if slot != 'BN'), 2)
            if unkeyed:
                problems.append(f'{cid}: {unkeyed} scorecard player(s) missing from the '
                                f'draftables — keyed by draftable id instead')
        except CaptureError as exc:
            problems.append(f'{exc} — no roster for this entry')
        time.sleep(pace)
        entries.append(e)
        if n % 20 == 0:
            say(f'            {n}/{len(contests)}')

    if not weeks:
        raise CaptureError('no scorecard carried a kickoff time, so there is no telling '
                           'which week this is')
    games_week = weeks.most_common(1)[0][0]
    if len(weeks) > 1:
        problems.append(f'scorecards span weeks {sorted(weeks)}; filed under week {games_week}')
    total = sum(games.values())
    if games['Upcoming'] == total:
        if not any(e['points'] for e in entries):
            raise CaptureError(f'no week {games_week} game has kicked off and no entry has '
                               f'points — nothing to capture yet')
        # DK has rolled its scorecards on to next week. The standings still describe
        # the week just finished; the scorecards describe nothing that has happened.
        status, week = 'pre', games_week - 1
    # Two "over" states, both seen on the first real capture: CompetitionOver as the
    # game ends and ScoresOfficial once the stats are settled. Reading only the first
    # would call a finished week live forever.
    elif games['CompetitionOver'] + games['ScoresOfficial'] == total:
        status, week = 'final', games_week
    else:
        status, week = 'live', games_week

    has_rosters = status != 'pre'
    if not has_rosters:
        for e in entries:
            e['roster'] = []
            e.pop('lineup_points', None)
        players = {}
    missing_pos = sum(1 for p in players.values() if not p.get('pos'))
    if missing_pos:
        problems.append(f'{missing_pos} player(s) have no position in the draftables — '
                        f'DK may have renamed the field')

    now = time.time()
    return {
        'season': year, 'week': week, 'status': status, 'games_week': games_week,
        'games': dict(games),
        'captured_at': now, 'has_rosters': has_rosters,
        'rosters_captured_at': now if has_rosters else None,
        'players': players, 'entries': entries,
        'problems': problems, 'timing': timing,
        'counts': {'entries': len(entries),
                   'with_pod': sum(1 for e in entries if e['pod']),
                   'with_roster': sum(1 for e in entries if e['roster']),
                   'draftables': len(draftables),
                   'draft_groups': len({e['draft_group_id'] for e in entries})},
    }


def check_lineups(snap: dict) -> tuple[list, str]:
    """Does each lineup's scorecard total explain the points its entry gained this week?

    DK checked against itself: week 1 agreed on 12 of 12. From week 2 this also
    settles something not yet observed — whether a scorecard shows the WEEK's points
    or the season's. If the season's, every entry fails here on the first week-2
    capture, which is the loud answer wanted.
    """
    if not snap['has_rosters']:
        return [], 'not checked: no rosters in this capture'
    prev = {}
    if snap['week'] > 1:
        p = ARCHIVE / str(snap['season']) / f"week{snap['week'] - 1:02d}.json"
        if not p.exists():
            return [], f"not checked: no week {snap['week'] - 1} archive on this machine to subtract"
        before = json.loads(p.read_text())
        if before.get('status') == 'live':
            # Subtracting a mid-week total would blame every lineup for the games
            # that finished after it was taken.
            return [], f"not checked: week {snap['week'] - 1}'s last capture was taken mid-week"
        prev = {e['contest_id']: e['points'] for e in before.get('entries') or []}
    bad, checked = [], 0
    for e in snap['entries']:
        if not e['roster'] or (snap['week'] > 1 and e['contest_id'] not in prev):
            continue
        checked += 1
        gained = round(e['points'] - prev.get(e['contest_id'], 0.0), 2)
        if abs(gained - e['lineup_points']) > 0.011:
            bad.append(f"{e['contest_id']}: lineup scorecards {e['lineup_points']:.2f}, "
                       f"entry gained {gained:.2f} this week")
    return bad, f'{checked} lineups checked, {len(bad)} disagree'


def archive(snap: dict) -> Path:
    d = ARCHIVE / str(snap['season'])
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"week{snap['week']:02d}.json"
    old = json.loads(p.read_text()) if p.exists() else None
    merged = seasons.merge(old, snap)
    tmp = p.with_suffix('.tmp')
    tmp.write_text(json.dumps(merged))
    tmp.replace(p)
    return p


def push(snap: dict, target: str, key: str) -> dict:
    base = target.rstrip('/')
    # Wake it first. Render's free tier spins down and a cold start takes 30-60s,
    # which inside the POST's own timeout reads as a failed push.
    try:
        requests.get(f'{base}/api/season', timeout=90)
    except requests.RequestException:
        pass
    try:
        r = requests.post(f'{base}/api/season/upload', json=snap,
                          headers={'X-Api-Key': key}, timeout=120)
    except requests.RequestException as exc:
        raise CaptureError(f'POST {base}/api/season/upload failed: {exc}') from exc
    if not r.ok:
        # Status before body, and never r.json() before r.ok: a proxy answers in HTML,
        # and parsing it first hides the one thing it said.
        raise CaptureError(f'{base}/api/season/upload returned HTTP {r.status_code}: '
                           f'{r.text[:300]}')
    body = r.json()
    # A 200 is not proof it landed. Read it back.
    try:
        back = requests.get(f"{base}/api/season?season={snap['season']}",
                            timeout=60).json().get('meta') or {}
    except (requests.RequestException, ValueError) as exc:
        raise CaptureError(f'pushed, but reading /api/season back failed: {exc}') from exc
    shown = back.get('week') or 0
    if shown < snap['week'] or (shown == snap['week']
                                and abs((back.get('captured_at') or 0) - snap['captured_at']) > 1):
        raise CaptureError(f"push answered 200 but /api/season shows week {back.get('week')} "
                           f"captured_at {back.get('captured_at')} — not this capture")
    return body


def _publisher() -> dict:
    def git(*a):
        try:
            return subprocess.run(['git', '-C', str(ROOT), *a], capture_output=True,
                                  text=True, timeout=5).stdout.strip()
        except Exception:
            return ''
    return {'sha': git('rev-parse', '--short', 'HEAD'),
            'dirty': bool(git('status', '--porcelain', '--', '.'))}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='Capture best-ball standings from DK and push them to /season.')
    ap.add_argument('--push', action='store_true', help='send to the draft app (default: dry run)')
    ap.add_argument('--target', default=os.environ.get('DRAFT_APP_URL', ''),
                    help='draft app base URL (default: $DRAFT_APP_URL)')
    ap.add_argument('--pace', type=float, default=PACE,
                    help=f'seconds between DK requests (default {PACE})')
    ap.add_argument('--quiet', action='store_true', help='one summary line — what launchd logs')
    args = ap.parse_args(argv)
    say = (lambda *a, **k: None) if args.quiet else print
    stamp = time.strftime('%Y-%m-%d %H:%M:%S %Z')

    if args.push and not args.target:
        print(f'capture-standings {stamp}: --push needs --target or DRAFT_APP_URL. '
              f'Refusing rather than guessing a host.')
        return 2
    try:
        snap = capture(dk_session(), pace=args.pace, say=say)
    except CaptureError as exc:
        print(f'capture-standings {stamp}: FAILED — {exc}')
        return 1

    mismatches, lineup_note = check_lineups(snap)
    problems, timing = snap.pop('problems'), snap.pop('timing') + mismatches
    # Mid-week, DK's endpoints update independently and a play can land between two
    # requests, so disagreement then is timing rather than a fault. Warning on it every
    # Sunday would train everyone to skip the line that matters.
    if snap['status'] == 'live':
        snap['warnings'], snap['notes'] = problems, timing
    else:
        snap['warnings'], snap['notes'] = problems + timing, []
    snap['publisher'] = _publisher()
    path = archive(snap)

    entries, c = snap['entries'], snap['counts']
    adv = seasons.season_config(snap['season'])['advance']
    advancing = sum(1 for e in entries if 0 < e['rank'] <= adv)
    say(f"standings   {snap['season']} week {snap['week']} {snap['status']}   games {snap['games']}")
    say(f"entries     {c['entries']} · {c['with_pod']} with pod · {c['with_roster']} with roster"
        f" · {c['draftables']} draftables in {c['draft_groups']} group(s)")
    say(f'advancing   {advancing} of {len(entries)} (top {adv})')
    say(f'lineups     {lineup_note}')
    say(f'archive     {path.relative_to(ROOT)}')
    for w in snap['warnings']:
        say(f'WARN        {w}')
    for note in snap['notes'][:10]:
        say(f'note        {note}')
    if len(snap['notes']) > 10:
        say(f"            … and {len(snap['notes']) - 10} more notes")

    summary = (f"{snap['season']} week {snap['week']} {snap['status']} — {len(entries)} entries, "
               f"{advancing} advancing, {len(snap['warnings'])} warnings")
    rc = 3 if snap['warnings'] else 0

    if not args.push:
        say('DRY RUN    archived locally, not pushed. Add --push to send it.')
        if args.quiet:
            print(f'capture-standings {stamp}: {summary}, dry run')
        return rc
    key = os.environ.get('BBA_API_KEY', '')
    if not key:
        print(f'capture-standings {stamp}: {summary}, archived — NOT pushed: BBA_API_KEY is '
              f'absent. ~/.zshrc is read by interactive shells only; run under zsh -ic.')
        return 2
    try:
        body = push(snap, args.target, key)
    except CaptureError as exc:
        print(f'capture-standings {stamp}: {summary}, archived — PUSH FAILED: {exc}')
        return 1
    print(f"capture-standings {stamp}: {summary}, pushed to {args.target} "
          f"durable={body.get('durable')}")
    return rc


if __name__ == '__main__':
    sys.exit(main())
