"""In-season standings for the best-ball entries: per-season rules, the disk
mirror, and the view /season reads.

── Where the numbers come from ─────────────────────────────────────────────────

DraftKings, captured on the Mac by `tools/capture-standings.py` and pushed here as
one SNAPSHOT per week. This app never fetches standings itself: its DK cookies are
synced by hand and expire without saying so, and a page that quietly stopped
updating is the failure this codebase keeps writing down.

Measured 2026-09-10, the season's first day, across all 81 entries:

  * `/mycontests` carries every entry's pod rank and points in ONE request, and
    they agreed with the contest leaderboard on all 12 tournament types.
  * `PaidPositionThresholdPoints` is NOT the advance line, whatever it is called.
    It equalled the pod LEADER's total on 12 of 12. The line is read off the
    12-row leaderboard instead — see `_margin`.
  * Every tournament advanced exactly 2 of 12 (`LastWinningMegaEntry.Rank`).
  * Scorecard scores in the non-bench slots summed to the entry total, 12 of 12.

── Why a snapshot per week ─────────────────────────────────────────────────────

DK shows standings as of NOW. Nothing on either endpoint answers "what was my rank
after week 3", so a rank history exists only if it is recorded as it happens. A
later capture of the same week replaces the earlier one — it carries DK's stat
corrections — except for what it could no longer see; see `merge`.

── Next season ─────────────────────────────────────────────────────────────────

Everything is keyed by season, and a season must be DECLARED in `SEASONS` before a
capture for it is accepted. DK changes tournament structures between years, and a
2027 capture scored silently against 2026's rules is the confident-wrong-number
shape. Adding a year is one dict entry; forgetting fails loudly on the first
Tuesday.

Players are keyed by DK's `playerId`, not the draftable id the rest of this app
keys on. Draftable ids are not identities: inside ONE draft group on 2026-09-10
Drake Maye was both 42775186 and 42775187, and every season's pool mints new ones.
"""
from __future__ import annotations

import json
import logging
import os
import re
import statistics
import time
from datetime import date, datetime, timedelta, timezone

_log = logging.getLogger('app')

MIRROR_PATH = os.path.join(os.path.dirname(__file__), 'data', 'pushed_season.json')

SEASONS = {
    2026: {
        # The Tuesday before the opener. Weeks run Tuesday to Monday, which is how
        # both the NFL and DK close them. Read off nflverse games.csv 2026-09-10:
        # opener Wednesday 9 Sep, week 1 over Monday 14 Sep, and week 15's Saturday
        # games and week 17's Sunday 3 Jan both land in the right week.
        'week1_tuesday': '2026-09-08',
        'regular_weeks': 14,     # cumulative; the top `advance` of each pod go on
        'final_week': 17,
        'pod_size': 12,
        'advance': 2,            # measured on 12 of 12 tournament types, not assumed
    },
}

STATUSES = ('live', 'final', 'pre')

# A weekly job. Stale once a Tuesday has plainly been missed, bad after two — an
# always-on warning is one nobody reads.
STALE_AFTER = 8 * 86400
BAD_AFTER = 15 * 86400

# Only ever asked "which side of Tuesday midnight ET is this kickoff". Monday Night
# Football starts at 00:15 UTC on TUESDAY, so the UTC date put week 1's last game in
# week 2. A fixed -5h rather than zoneinfo: exact in winter, an hour early in
# September, and no game kicks off in the hour either side of midnight.
_ET = timedelta(hours=-5)


def season_config(season) -> dict | None:
    try:
        return SEASONS.get(int(season))
    except (TypeError, ValueError):
        return None


def season_of(start_time: str | None) -> int | None:
    """The season a DK contest time belongs to. January and February are the
    previous season's week 17, not a new year's."""
    m = re.match(r'(\d{4})-(\d{2})', start_time or '')
    if not m:
        return None
    year, month = int(m.group(1)), int(m.group(2))
    return year - 1 if month <= 2 else year


def week_of(season, start_time: str | None) -> int | None:
    """NFL week of a kickoff given as DK's ISO UTC string, or None."""
    cfg = season_config(season)
    # Minutes are all this needs, and a regex does not care that DK sends seven
    # fractional digits (…T20:25:00.0000000Z).
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})', start_time or '')
    if not cfg or not m:
        return None
    kickoff = datetime(*map(int, m.groups()), tzinfo=timezone.utc) + _ET
    days = (kickoff.date() - date.fromisoformat(cfg['week1_tuesday'])).days
    return days // 7 + 1


def short_contest(name: str | None) -> str:
    """'NFL Best Ball $20M Millionaire [$3M to 1st] (Tournament)' -> '$20M Millionaire'."""
    s = re.sub(r'\[[^\]]*\]|\([^)]*\)', '', name or '')
    s = re.sub(r'^\s*NFL Best Ball\s+', '', s)
    return re.sub(r'\s+', ' ', s).strip() or (name or '')


# ── validation and merge — shared by the upload endpoint and the capture tool ──

def validate(snap: dict) -> str | None:
    """Why a snapshot must be refused, or None. Refuses what would break the page
    or overwrite a good week with nothing; stores the rest."""
    cfg = season_config(snap.get('season'))
    if not cfg:
        return (f"season {snap.get('season')!r} is not declared in app/season.py "
                f"SEASONS — add it (one entry) before capturing that season")
    week = snap.get('week')
    if not isinstance(week, int) or isinstance(week, bool) or not 1 <= week <= cfg['final_week']:
        return f"week {week!r} is outside 1..{cfg['final_week']}"
    if snap.get('status') not in STATUSES:
        return f"status {snap.get('status')!r} is not one of {STATUSES}"
    if not isinstance(snap.get('captured_at'), (int, float)):
        return 'captured_at missing'
    entries = snap.get('entries')
    if not isinstance(entries, list) or not entries:
        # Zero entries is an expired DK session far more often than a portfolio with
        # nothing in it, and accepting it would blank the week.
        return 'no entries — refusing, and keeping what is stored'
    for e in entries:
        if (not isinstance(e, dict) or not e.get('contest_id')
                or not isinstance(e.get('rank'), int)
                or not isinstance(e.get('points'), (int, float))):
            return f'malformed entry: {str(e)[:160]}'
    return None


def merge(old: dict | None, new: dict) -> dict:
    """A later capture of the same week, keeping the rosters it could not see.

    Standings always come from the newer capture — it has DK's stat corrections.
    Rosters are the exception. Once DK rolls its scorecards on to next week's games,
    a capture can still read this week's standings but no longer this week's player
    scores, and replacing a snapshot that had them with one that does not would
    delete the only record of who scored what.
    """
    if not old or new.get('has_rosters') or not old.get('has_rosters'):
        return new
    kept = {e.get('contest_id'): e.get('roster') for e in old.get('entries') or []}
    for e in new['entries']:
        if kept.get(e['contest_id']):
            e['roster'] = kept[e['contest_id']]
            if 'lineup_points' not in e:
                prev = next(x for x in old['entries'] if x.get('contest_id') == e['contest_id'])
                if 'lineup_points' in prev:
                    e['lineup_points'] = prev['lineup_points']
    new['players'] = {**(old.get('players') or {}), **(new.get('players') or {})}
    new['has_rosters'] = True
    new['rosters_captured_at'] = old.get('rosters_captured_at') or old.get('captured_at')
    return new


# ── the disk mirror ──────────────────────────────────────────────────────────

def read_mirror() -> dict:
    """{"2026": {"1": snapshot, ...}} for every stored season, or {}."""
    try:
        with open(MIRROR_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def read_week(season, week) -> dict:
    return (read_mirror().get(str(season)) or {}).get(str(week)) or {}


def write_mirror(data: dict) -> None:
    """Raises — the caller reports it. See news.write_mirror for why that matters."""
    os.makedirs(os.path.dirname(MIRROR_PATH), exist_ok=True)
    tmp = MIRROR_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, MIRROR_PATH)


def write_week(snap: dict) -> None:
    data = read_mirror()
    data.setdefault(str(snap['season']), {})[str(snap['week'])] = snap
    write_mirror(data)


def hydrate() -> bool:
    """Rebuild the mirror from Postgres at boot. True if it was refreshed.

    An unreachable store leaves whatever survived the filesystem wipe — on Render,
    nothing — and the page then says no standings are stored rather than inventing
    an empty season.
    """
    from app import season_store
    if not season_store.external_enabled():
        return False
    try:
        data = season_store.load_all()
        if data is None:
            _log.warning('[season] store UNREACHABLE at boot — serving whatever is on disk')
            return False
        if data:
            write_mirror(data)
            return True
    except Exception as e:
        _log.warning(f'[season] hydrate failed: {e!r}')
    return False


# ── the view ─────────────────────────────────────────────────────────────────

def _age(ts):
    if not ts:
        return None, 'missing'
    age = max(0.0, time.time() - float(ts))
    return age, 'bad' if age >= BAD_AFTER else 'stale' if age >= STALE_AFTER else 'ok'


def meta(snap: dict | None, cfg: dict) -> dict:
    snap = snap or {}
    age, state = _age(snap.get('captured_at'))
    # Once the last week is final, an old capture is the right answer, not a stale one.
    if (state in ('stale', 'bad') and snap.get('status') == 'final'
            and snap.get('week') == cfg.get('final_week')):
        state = 'done'
    return {
        'season': snap.get('season'),
        'week': snap.get('week'),
        'status': snap.get('status'),
        'games_week': snap.get('games_week'),
        'captured_at': snap.get('captured_at'),
        'age_hours': round(age / 3600, 1) if age is not None else None,
        'state': state,
        'has_rosters': bool(snap.get('has_rosters')),
        'rosters_captured_at': snap.get('rosters_captured_at'),
        'entries': len(snap.get('entries') or []),
        'warnings': snap.get('warnings') or [],
        'publisher': snap.get('publisher') or {},
    }


def _margin(entry: dict, advance: int):
    """(margin, line). Margin is points from the advance line: positive is the
    cushion over the first team out, negative the gap to the last team in."""
    pod = sorted((p for p in entry.get('pod') or [] if isinstance(p, (int, float))),
                 reverse=True)
    if len(pod) <= advance:
        return None, None
    last_in, first_out = pod[advance - 1], pod[advance]
    if 0 < entry['rank'] <= advance:
        return round(entry['points'] - first_out, 2), last_in
    return round(entry['points'] - last_in, 2), last_in


def _stored_drafts(season: int) -> dict:
    """{dk_draft_id: row} for this season's drafts in history, or {} if unreadable.

    The one place a season is INFERRED, from `drafted_at`: DK best-ball drafts for a
    season open in spring and close by kickoff, inside one calendar year. The drafts
    table has no season column; add one if that ever stops being true.
    """
    try:
        from app.database import get_db
        with get_db() as conn:
            rows = conn.execute(
                "SELECT dk_draft_id, drafted_at, contest, entry_fee FROM drafts "
                "WHERE dk_draft_id IS NOT NULL").fetchall()
    except Exception as e:
        _log.warning(f'[season] draft history unreadable: {e!r}')
        return {}
    return {str(r['dk_draft_id']): dict(r) for r in rows
            if str(r['drafted_at'] or '').startswith(str(season))}


def view(season: int | None = None) -> dict:
    """Everything /season renders, computed here so the page holds no rules."""
    data = read_mirror()
    stored = sorted((int(s) for s in data if str(s).isdigit()), reverse=True)
    if season is None:
        season = stored[0] if stored else max(SEASONS)
    cfg = season_config(season) or {}
    by_week = data.get(str(season)) or {}
    weeks = sorted(int(w) for w in by_week)
    out = {'season': season, 'seasons': stored, 'weeks': weeks, 'config': cfg}
    if not weeks:
        return {**out, 'ok': False, 'meta': meta(None, cfg), 'entries': [],
                'tournaments': [], 'players': [], 'totals': {}, 'reconcile': {}}

    snap = by_week[str(weeks[-1])]
    advance = cfg.get('advance', 2)
    past = {w: {e['contest_id']: e for e in by_week[str(w)].get('entries') or []}
            for w in weeks}
    names = snap.get('players') or {}
    drafts = _stored_drafts(season)

    entries = []
    for e in snap['entries']:
        cid = e['contest_id']
        margin, line = _margin(e, advance)
        entries.append({
            'contest_id': cid,
            'contest': short_contest(e.get('contest')),
            'contest_full': e.get('contest'),
            'entry_fee': e.get('entry_fee'),
            'drafted_at': (drafts.get(cid) or {}).get('drafted_at'),
            'rank': e['rank'],
            'points': e['points'],
            'line': line,
            'margin': margin,
            'advancing': 0 < e['rank'] <= advance,
            'ranks': [(past[w].get(cid) or {}).get('rank') for w in weeks],
            'points_by_week': [(past[w].get(cid) or {}).get('points') for w in weeks],
            'roster': [{'key': k, 'slot': slot, 'score': score,
                        **(names.get(k) or {'name': k})}
                       for k, slot, score in e.get('roster') or []],
        })

    groups = {}
    for e in entries:
        g = groups.setdefault(e['contest'], {'contest': e['contest'], 'entries': 0,
                                             'advancing': 0, 'fees': 0.0, 'rank_sum': 0})
        g['entries'] += 1
        g['advancing'] += int(e['advancing'])
        g['fees'] += e['entry_fee'] or 0
        g['rank_sum'] += e['rank']
    tournaments = sorted(
        ({'contest': g['contest'], 'entries': g['entries'], 'advancing': g['advancing'],
          'fees': round(g['fees'], 2), 'avg_rank': round(g['rank_sum'] / g['entries'], 1)}
         for g in groups.values()),
        key=lambda g: (-g['fees'], g['contest']))

    agg = {}
    for e in entries:
        for r in e['roster']:
            a = agg.setdefault(r['key'], {'key': r['key'], 'name': r.get('name'),
                                          'pos': r.get('pos'), 'team': r.get('team'),
                                          'score': 0.0, 'rosters': 0, 'counted': 0})
            a['rosters'] += 1
            a['counted'] += int(r['slot'] != 'BN')
            a['score'] = max(a['score'], r['score'])
    players = sorted(agg.values(), key=lambda a: (-a['rosters'], -a['score']))

    margins = [e['margin'] for e in entries if e['margin'] is not None]
    totals = {
        'entries': len(entries),
        'advancing': sum(int(e['advancing']) for e in entries),
        'fees': round(sum(e['entry_fee'] or 0 for e in entries), 2),
        'fees_advancing': round(sum(e['entry_fee'] or 0 for e in entries if e['advancing']), 2),
        'median_margin': round(statistics.median(margins), 2) if margins else None,
        'within_10': sum(1 for m in margins if abs(m) <= 10),
    }

    captured = {e['contest_id'] for e in entries}
    reconcile = {
        'drafts_stored': len(drafts),
        'not_in_capture': sorted(
            ({'dk_draft_id': k, 'drafted_at': v.get('drafted_at'),
              'contest': short_contest(v.get('contest'))}
             for k, v in drafts.items() if k not in captured),
            key=lambda r: r['drafted_at'] or ''),
        'not_in_history': sorted(c for c in captured if c not in drafts),
    }

    return {**out, 'ok': True, 'meta': meta(snap, cfg), 'entries': entries,
            'tournaments': tournaments, 'players': players, 'totals': totals,
            'reconcile': reconcile}
