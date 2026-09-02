#!/usr/bin/env python3
"""What the best-ball entries have cost — and what is still a guess.

    tools/entry-spend.py                       # the report
    tools/entry-spend.py --mark 193391013 ticket
    tools/entry-spend.py --mark 193391013 cash
    tools/entry-spend.py --unknown             # list what still needs marking

── The number this CANNOT know on its own ──────────────────────────────────────────

DK does not record how an entry was funded. All 57 fields on a My Contests row were
dumped on 2026-09-01: `BuyInAmount` is the sticker price whether you paid cash or burned
a ticket; `IsFreeroll` says only that the contest was free for everyone; and
`TicketWinnings`, `TokensWon`, `CrownsAwarded` and `AwardableTokenId` all describe what
was WON. Nothing says how it was paid.

So the honest output is three numbers, not one: what is confirmed cash, what is
confirmed ticket, and what is **unknown**. Unknown is not folded into cash. Doing that
would overstate spend by exactly the amount you were trying to measure, and it would do
it silently — which is the failure mode this repo keeps paying for.

DK's own transaction history is the authoritative source. This is for tracking what you
have told it.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys

DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'drafts.db')
VALID = ('cash', 'ticket')


def _conn():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c


def mark(dk_id: str, how: str) -> int:
    if how not in VALID:
        print(f'  how must be one of {VALID}, got {how!r}')
        return 2
    with _conn() as c:
        n = c.execute('UPDATE drafts SET entry_paid=? WHERE dk_draft_id=?',
                      (how, str(dk_id))).rowcount
    if not n:
        print(f'  no draft with dk_draft_id {dk_id} — is it imported?')
        return 1
    print(f'  {dk_id} marked {how}')
    return 0


def report(unknown_only: bool = False) -> int:
    with _conn() as c:
        rows = c.execute(
            'SELECT dk_draft_id, contest, entry_fee, entry_paid, drafted_at '
            'FROM drafts ORDER BY drafted_at, dk_draft_id').fetchall()

    priced = [r for r in rows if r['entry_fee']]
    if unknown_only:
        todo = [r for r in priced if not r['entry_paid']]
        print(f'\n  {len(todo)} priced draft(s) with no payment method recorded:\n')
        for r in todo:
            print(f"    {r['dk_draft_id']:>10}  ${r['entry_fee'] or 0:6.2f}  {(r['contest'] or '')[:52]}")
        print(f"\n  mark them: tools/entry-spend.py --mark <id> {'|'.join(VALID)}\n")
        return 0

    def total(pred):
        return sum(r['entry_fee'] or 0 for r in priced if pred(r))

    cash    = total(lambda r: r['entry_paid'] == 'cash')
    ticket  = total(lambda r: r['entry_paid'] == 'ticket')
    unknown = total(lambda r: r['entry_paid'] not in VALID)
    n = lambda pred: sum(1 for r in priced if pred(r))

    print(f'\n  {len(rows)} drafts imported · {len(priced)} carry an entry fee '
          f'· {len(rows) - len(priced)} have none recorded\n')
    print(f"    confirmed cash      {n(lambda r: r['entry_paid']=='cash'):3}  ${cash:9,.2f}")
    print(f"    confirmed ticket    {n(lambda r: r['entry_paid']=='ticket'):3}  ${ticket:9,.2f}   (won, not spent)")
    print(f"    UNKNOWN             {n(lambda r: r['entry_paid'] not in VALID):3}  ${unknown:9,.2f}   <- not counted as either")
    print(f'    {"":20}     {"-"*9}')
    print(f'    sticker total       {len(priced):3}  ${cash + ticket + unknown:9,.2f}')
    print()
    print(f'    actual cash spent is between ${cash:,.2f} and ${cash + unknown:,.2f}')
    if unknown:
        print(f'    — narrow it with `--unknown`, or take the exact figure from DK.')
    if len(rows) - len(priced):
        print(f'\n    {len(rows) - len(priced)} imported draft(s) have no fee at all. Re-import to backfill:')
        print('      tools/import-new-drafts.sh')
    print('\n    Covers only drafts imported HERE. DK showed 77 best-ball contests on')
    print('    2026-09-01 against 35 imported, so treat this as a floor.\n')
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--mark', nargs=2, metavar=('DK_ID', 'HOW'),
                    help=f'record how one entry was paid ({" or ".join(VALID)})')
    ap.add_argument('--unknown', action='store_true',
                    help='list priced drafts with no payment method yet')
    a = ap.parse_args()
    if a.mark:
        return mark(a.mark[0], a.mark[1].lower())
    return report(unknown_only=a.unknown)


if __name__ == '__main__':
    raise SystemExit(main())
