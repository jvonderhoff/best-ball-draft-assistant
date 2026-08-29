---
description: Read last night's report, judge every news item and the dry run, and say whether to publish.
---

Read the nightly report and do the parts the script deliberately does not: decide what
the news means, and whether the refreshed payload should go live.

`../projections/tools/nightly.sh` gathers everything mechanically and stops at a dry
run. It never publishes. Your job starts where it stops.

## Read these

```bash
cat ../projections/data/nightly-latest.txt
```

And the raw beat-report text, which the printed report truncates to one line each:

```bash
cat ../projections/data/market-watch.json
```

## First: which report is this, and is it current?

**Line 1 names the job as well as the time, and both matter.**

| line 1 starts | job | ran | refreshed the sources? |
|---|---|---|---|
| `nightly —` | `nightly.sh` | Tue/Fri 07:30 | yes — props, FFToday, DK, and a dry run |
| `market report —` | `market-report.sh` | Sun/Mon/Wed/Thu/Sat 07:30 | **no** — news and ADP only |

Both write `nightly-latest.txt`, so this file is whichever ran most recently. On a
market-report day there is **no publish decision to make** — props and FFToday were not
refreshed, so the payload has not changed since the last nightly. Skip the publish
section entirely rather than re-approving Friday's payload as if it were new; say which
report you read and move on to the news.

**A job that has quietly stopped running and a job with nothing to report look
identical**, which is the failure this whole codebase keeps guarding against. Expect a
report every day now. If the newest is more than ~36 hours old, say so first and stop —
reviewing a stale report as though it were this morning's is worse than not reviewing.

Check `launchctl list | grep bba` if it looks stalled; there should be three jobs —
`newspoll` (every 3h), `marketreport` (off days), `nightly` (Tue/Fri). Confirm the date
you are checking against actually falls on the day the job that produced it runs, before
calling a gap a failure.

## Show a verdict on EVERY news item, not just the interesting ones

This is the part that matters and the easy part to get wrong. Do **not** present only
the players you think are significant — list every one, with a one-line verdict, so the
reader can see what you dismissed and disagree. A filter you cannot audit is one that
quietly drops the thing you needed.

The signal is the DISAGREEMENT between what the news says and what the market did:

| news | ADP moved | read |
|---|---|---|
| bad | down | priced in — no edge, no action |
| bad | flat | the room has not reacted. A fade, or a warning |
| fine | down | **overreaction — the one worth money** |
| fine | flat | nothing happened |

Most preseason items are noise: "did not play Thursday" in late August is rest, not
information. Say so plainly rather than hedging — a review that calls everything
"worth monitoring" is the always-on warning bar again.

`up` means drafted EARLIER (a falling ADP number). Movement is measured against a
threshold of 0.15 × the player's own ADP, because five picks at ADP 12 and at ADP 180
are not the same event.

## Then the general-news digest

`market-watch` also prints **the rest of the feed** — the CBS and Yahoo items that carry
no player price signal, with any draftable player named in them tagged in brackets. This
is the non-injury half, and it is where roster cuts, depth-chart changes, trades and
beat-reporter colour show up. It is a reading list, not a quadrant: there is no ADP move
attached, so do not manufacture a verdict for each one. Call out the few that plausibly
change a valuation — a cut, a trade, a starter named, a role opening — and say plainly
that the rest is scenery.

## Then the movers with no news attached

Players whose price moved with nothing in the feed. The news history only started on
2026-08-27 and RotoWire serves ~5 items a poll, so absence of news means "we did not
catch it", NOT "nothing happened". Say which ones look worth chasing manually.

## Then: publish or not

The report ends with a `what needs you` section. The mechanical checks are already
done — target, `sd_invariant_ok`, null fields, and the stale-pool refusal. What is left
for you is judgement:

- Did a source's row count move sharply from the day before? (props ~120-150 players,
  FFToday ~350, ESPN ~460.) A big drop is a source half-failing, not news.
- Did the player count swing outside 420-445?
- Is the published payload old enough to be worth replacing at all?

If it looks safe, say so and give the command — do not run it without a yes:

```bash
cd ~/Development/projects/fantasy_football/projections && export DRAFT_APP_URL=https://best-ball-draft-assistant.onrender.com && .venv/bin/python cli.py analysis-publish --no-dry-run
```

## Finally, invite the correction

End by asking which verdicts the reader disagrees with. **While this is new, they are
reading the full report themselves to catch what you missed** — that check is the point,
so make it easy: keep the list complete, the reasons short, and the confidence honest.
When a verdict turns out to be wrong, add it to `docs/STATUS.md` under the backlog entry
for this command, so the next review does not repeat it.
