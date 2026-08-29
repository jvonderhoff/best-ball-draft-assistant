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

## First, is the report even current?

Line 1 carries a timestamp. **A job that has quietly stopped running and a job with
nothing to report look identical**, which is the failure this whole codebase keeps
guarding against. If the report is more than ~36 hours old, say so first and stop —
reviewing a stale report as though it were this morning's is worse than not reviewing.

Check `launchctl list | grep bba` if it looks stalled.

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
