---
description: Sunday, after the 10:45 export and before the noon lock — build the DFS lineups for the contests being entered, off the ladder, and open the board on one of them.
argument-hint: "<contest id> [<contest id> ...]"
---

The Sunday question is one per contest: which nine, for THIS ladder. Every
flag that used to be typed by hand -- draft group, mean or ceiling, stack,
bring-back, top games, repeat QBs -- comes off the contest's payout ladder
now (`dfs/cli.py lineups --contest`), so the only input is which contests.

**Arguments: `$ARGUMENTS`.** DraftKings contest ids, from the lobby URL. If
none are given, list this slate's candidates and ask which, rather than
guessing:

```bash
cd dfs && .venv/bin/python cli.py contests --draftgroup <dg> --min-entries 5000
```

(the draft group is the Featured Classic slate `cli.py slates` names; the
list comes from the Sunday job's 10:45 lobby snapshot, so it needs no login).

## Step 1 — build, off the freshest export

```bash
cd dfs && tools/gameday.sh -n 4 <millionaire id> -n 1 <single-entry id>
```

`-n` before an id is that contest's entry count. The script copies the
projections export across if it is newer, **refuses an export over 6 hours
old** (on a Sunday that means the 10:45 job did not run -- check
`data/sunday-export/latest.txt`, then run `tools/sunday-export.sh`), runs
`doctor`, and builds each contest with its ladder's settings, writing
`data/<date>-<id>.csv` for upload.

## Step 2 — read the output, and say what the script cannot

- **The `props:` age line first.** Under an hour on a Sunday. Anything else
  is a lineup built on an older market wearing today's hat.
- **The unmatched list.** Players "above their position's minimum and not
  OUT/IR" have no yardage market and were unpickable. Twenty backups is
  normal; a $7,000 starter there means DK has not posted his game -- say so,
  and check whether the game is later in the day (late-afternoon markets can
  post after 10:45).
- **The `--top-games` lines.** The two games the quarterbacks were drawn
  from, with totals. If a third game is within a point, say it; the lever
  raises the odds and does not name the game.
- **Each lineup's ceiling band.** `top 0.01% (2024) to top 6% (2026)` is the
  range across seven years; a lineup that reads `cash` at the low end is a
  lineup a high-scoring week will not pay.
- **Whether the upload CSV was written.** DraftKings' draftables endpoint
  refused with 403 on 2026-09-17, and without it there are no per-slot ids.
  The lineups still print; say the file was skipped and that entry is by hand.

## Step 3 — the board, on the contest

```bash
cd dfs && .venv/bin/python cli.py serve --contest <id>
```

It opens on that contest with the ladder's controls already set, and every
slider stays live. **11:30**: download `DKEntries.csv` if a contest can fill
before lock; `lineups --entries` fills it. **12:00** lock.

Monday, once the ownership job has run: `cli.py replay --contest <id>` places
these lineups in every contest that ran on the slate.
