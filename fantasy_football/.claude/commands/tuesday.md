---
description: Tuesday-night routine, before waivers process — recapture LateRound (weekly + rest-of-season) and the week's waiver columns, refresh the market and the field, then read start/sit, every FAAB league's waiver board, and the roster-shape view across all four leagues.
argument-hint: ""
---

The Tuesday-night question is not "what do I start Sunday" — it is "is there a
free agent worth claiming before waivers clear, and does anyone on my bench
need a start THIS week that the wire would fill better." That needs both
LateRound pages, not one: the **weekly** page for this-week start/sit, the
**rest-of-season** page as a second opinion on the waiver board's own VOR
column. Running only one and skipping the other silently answers half the
question.

Four steps: recapture LateRound, refresh the market, read every waiver board,
then read the roster-shape view. The last one is what catches a league the
waiver board has nothing to say about.

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

## Step 1b — capture the week's waiver columns

The wire's best add is routinely a player with no stat line and no LateRound
rank, so he is invisible to both of the columns above — he shows up in the
board's coverage line as one of the ~400 who "carry no number at all". Three
outside signals cover him, and `tools/weekly.sh` refreshes two of them for
free (Sleeper's trending adds, the news RSS). The third is a capture, and it
is the only part that needs you.

**Read this week's waiver columns and write `projections/data/waiver-articles.json`**
— FantasyPros, Yahoo, SI and Dynasty Nerds were the four used on 2026-09-22,
and any comparable set is fine. One row per (player, source), because two
writers naming the same player IS the consensus signal:

```json
{"name": "Jonah Coleman", "pos": "RB", "team": "DEN",
 "source": "FantasyPros", "faab_pct": 16, "note": "Dobbins hurt, lead back"}
```

Keep `captured_at` and `week` current at the top of the file. Then let step 2
run the exporter, or run it directly:

```bash
cd projections && .venv/bin/python tools/export_waiver_buzz.py
```

It prints one line per leg. **Every article row must match** — an unmatched row
is a spelling this repo cannot resolve, and it is reported rather than dropped.
Fix the name in the capture and re-run; do not leave it, because a player you
meant to track silently not being there is the whole failure this guards.

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
- **`BUZZ`** — what the rest of the world is doing: Sleeper trending adds
  (`310k`) and how many waiver columns named him (`2★`). Popularity, never
  points — it is not summed into anything and cannot be compared with a VOR.
- **`KTC`/`DYN#`** — the dynasty trade market, dynasty leagues only.
- **`BID`** — a suggested FAAB dollar amount, printed with its own honesty
  line (`n`, MAE vs. the naive baseline) every time. Read it as a range, never
  as the number to type into Sleeper — see `leagues/faab.py`'s header for why.

**Read the section under each board — `THE FIELD IS ADDING THESE, and the
table above did not`.** On a Tuesday this is often where the real claim is: the
ranked table can only rank players it has a number for, and the man who
inherited a job on Sunday has neither a stat line nor a LateRound rank. Each
row carries our own number where one exists (`ros 0.6`) or `no number` where it
genuinely does not, plus the add count, which columns named him, the FAAB range
they suggested, and one line of why. A big add count next to a low `ros` is not
a contradiction — it is the crowd pricing a job change that the season rate has
not caught up with yet, which is exactly the disagreement worth reading.

A league whose FAAB board prints "only N winning FAAB bid(s) synced" below the
15-bid minimum is not broken; it just doesn't have enough history yet for a
bid suggestion, and the VOR/LR columns are still worth reading on their own.

## Step 4 — read the roster-shape view, every league

```bash
cd sleeper && .venv/bin/python cli.py gaps
```

No `--league` runs all four. Where `waivers` asks "who should I add", this asks
"does my roster still make sense", and it covers the leagues the waiver board
has nothing to say about. Three sections per league:

- **`UNRANKED, on your roster`** — who you carry that LateRound's 150 does not
  reach, with his slot and depth-chart spot. Not a verdict: the list runs out
  at roughly a startable WR5, and a player can be unranked and still be the
  week's biggest add (Tre Tucker, 990k adds, unranked, 2026-09-22).
- **`RANKED and free`** — their ranked players nobody rosters, each marked
  `free` or `ON WAIVERS until <day>`.
- **`OUTRANKED by someone free`** — the row worth acting on, and the one the
  other two miss. A ranked player of yours with better free players above him
  never appears in the unranked list at all: on 2026-09-22 that was Dallas
  Goedert, TE19, with three free tight ends rated over him.

**Zero ranked free agents is a finding, not an empty screen.** Both dynasty
leagues print it, because in 12-team superflex with 12- and 15-man benches
every ranked player is owned. That says trade, not claim, and no amount of
staring at the waiver board will say it.

K and DEF are skipped throughout and the command says so — the ROS page ranks
QB/RB/WR/TE only, so an unranked kicker reports the source's scope rather than
anything about him.

## If something looks wrong

`cli.py doctor` reports whether each FAAB league's transaction history was
ever synced at all (distinct from genuinely having zero bids so far), and
whether the player dump or crosswalk have gone stale. Run it if a waiver board
looks thinner than last week's for no reason you can see.

It also ages the three buzz legs separately — trending is a 24-hour
measurement, the article capture is a Tuesday snapshot — and flags any article
row that matched no player.
