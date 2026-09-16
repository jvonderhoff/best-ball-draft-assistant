---
description: Tuesday-night routine, before waivers process — recapture LateRound (weekly + rest-of-season), refresh the market, then read start/sit and every FAAB league's waiver board.
argument-hint: ""
---

The Tuesday-night question is not "what do I start Sunday" — it is "is there a
free agent worth claiming before waivers clear, and does anyone on my bench
need a start THIS week that the wire would fill better." That needs both
LateRound pages, not one: the **weekly** page for this-week start/sit, the
**rest-of-season** page as a second opinion on the waiver board's own VOR
column. Running only one and skipping the other silently answers half the
question.

## Step 1 — recapture LateRound

Both captures are member-only pages that 302 for a scripted fetch, so both are
taken in a signed-in browser and only parsed in Python — same architecture,
different scripts:

| page | script | output |
|---|---|---|
| `lateround.com/rankings-tiers/weekly-rankings/` | `projections/tools/lateround-capture.js` | 4 CSVs |
| `lateround.com/rankings-tiers/rest-of-season-rankings/` | `projections/tools/lateround-ros-capture.js` | 1 CSV |

The weekly script's four downloads are staggered ~500ms apart, but **that does
not reliably fix Chrome's download-blocker** — verified by re-testing live on
2026-09-16 and still only 1 of 4 files landed. DevTools console execution
carries no page-level user gesture, so every download past the first reads as
unsolicited no matter the spacing. **The working fallback, proven twice:**
read each table's rows with a small `document.querySelectorAll('table')`
snippet per call and write the CSV directly from the returned text, instead of
clicking through the download. The single-file ROS capture has no
multi-download problem — its one download lands every time.

Move the captured CSVs into `projections/data/`, then:

```bash
cd projections && .venv/bin/python tools/export_lateround.py --week <current week>
cd projections && .venv/bin/python tools/export_lateround_ros.py
```

Each prints a coverage line (`N ranked, M unmatched`, by-position counts). Read
it before moving on — 0 unmatched and ~150 ranked is a clean capture; anything
short of that, redo the browser step rather than trusting a partial one.

## Step 2 — refresh everything else, read start/sit

```bash
cd sleeper && tools/weekly.sh
```

Read the output exactly as `/startsit` says to: check `N/M priced by the
market` before trusting a lineup, catch the player with no market at all whose
game hasn't kicked off, weigh a CLOSE call against the source it came from. Do
not re-derive those rules here — follow `/startsit`'s own judgment calls.

**The one thing that's different on a Tuesday: thin market coverage is
EXPECTED, not a red flag.** DK's board fills in toward kickoff, so a Tuesday
run of `weekly.sh` will show far fewer starters priced by the market than a
Thursday run of the same command would. The point of running this on Tuesday
is narrow — catch a start-worthy free agent before you lose the waiver
priority to claim him, not finalize Sunday's lineup. Re-run `/startsit` on its
own later in the week for that.

## Step 3 — read every FAAB league's waiver board

```bash
cd sleeper && .venv/bin/python cli.py leagues
```

confirms which leagues currently carry a FAAB budget (`cli.py leagues`'s own
output says so per league — do not hardcode league ids here, they drift as
leagues get re-synced). For each one:

```bash
cd sleeper && .venv/bin/python cli.py waivers --league <league id>
```

Three columns now carry independent second opinions, and none of them are
summed into VOR or into each other:

- **`LR`** — LateRound's rest-of-season rank and tier, the human second
  opinion on the exact question the `ROS`/`VOR` columns already answer from a
  stat line. `--` means LateRound doesn't rank that player at all, which is
  common outside their top ~150 and is not itself a signal.
- **`KTC`/`DYN#`** — the dynasty trade market, dynasty leagues only.
- **`BID`** — a suggested FAAB dollar amount, printed with its own honesty
  line (`n`, MAE vs. the naive baseline) every time. Read it as a range, never
  as the number to type into Sleeper — see `leagues/faab.py`'s header for why.

A league whose FAAB board prints "only N winning FAAB bid(s) synced" below the
15-bid minimum is not broken; it just doesn't have enough history yet for a
bid suggestion, and the VOR/LR columns are still worth reading on their own.

## If something looks wrong

`cli.py doctor` reports whether each FAAB league's transaction history was
ever synced at all (distinct from genuinely having zero bids so far), and
whether the player dump or crosswalk have gone stale. Run it if a waiver board
looks thinner than last week's for no reason you can see.
