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
`doctor`, makes and stores the ownership estimate (so each lineup prints
`own~`), and builds each contest with its ladder's settings, writing
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
- **The `est own` on each lineup header, against the field.** Seven
  Millionaires say 1.0-1.5x the field's summed ownership finished best and
  below 0.8x lost every year. The estimate is one graded week old; say the
  ratio, and say it is an estimate. Do not move a lineup for it.
- **Whether the upload CSV was written.** DraftKings' draftables endpoint
  refused with 403 on 2026-09-17, and without it there are no per-slot ids.
  The lineups still print; say the file was skipped and that entry is by hand.

## Step 2b — the dashboard

`gameday.sh` passes `--json data/dashboard/classic-day.json` to every build and
writes the rows (`data/dashboard/cl_*.json`). Put them on the Classic view of the
Fantasy HQ DFS tab (https://claude.ai/artifact/V29D8kzo8Qenzr8U7nnAvq): read the
six dataset documents (`datasets/cl_run`, `cl_builds`, `cl_lineups`, `cl_slots`,
`cl_pool`, `cl_exposure`) for their current `source.url` and `version`; upload
each file with the Artifact tool (`asset: true`, one call per file); one
ArtifactData `batch` of six `update`s pinned with `if_version`, setting `source`
to the new `/_blob/` url and name and `updated` to now; then delete the six old
assets. Never touch `files/index.html` or another view's datasets. If the
exposure table shows anyone over two in the KEPT column, say so first.

## Step 3 — the board, on the contest

```bash
cd dfs && .venv/bin/python cli.py serve --contest <id>
```

It opens on that contest with the ladder's controls already set, and every
slider stays live. **11:30**: download `DKEntries.csv` if a contest can fill
before lock; `lineups --entries` fills it. **12:00** lock.

Monday, once the ownership job has run: `cli.py replay --contest <id>` places
these lineups in every contest that ran on the slate.

Showdowns (Thursday, Sunday night, Monday) have their own routine, `/showdown`,
which puts its builds on the DFS tab's Showdown view. This one is Classic only.
