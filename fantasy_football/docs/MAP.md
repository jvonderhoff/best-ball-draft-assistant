# The map — everything in fantasy_football

Written 2026-09-08. **This file is for re-orienting, not for deciding.** It says what
exists, what feeds what, what runs when, and which of it is 2026-specific. When it
disagrees with a project's own doc, that doc wins — `../CLAUDE.md` holds the rules that
apply everywhere, and this holds the inventory.

Counts and ages below were measured on 2026-09-08 and are there to show you the SHAPE
of a healthy system. Do not trust the numbers themselves next season; run `doctor`.

---

## 1. The four projects, in one table

| | the question it answers | state | run it | port |
|---|---|---|---|---|
| `projections/` | *what is a player worth, and where did that come from?* | live, local only | `.venv/bin/python cli.py analysis-serve` | 8100 |
| `best-ball-draft/` | *DK best ball: who do I draft next?* | live, public on Render | `./run.sh` | 8000 |
| `sleeper/` | *my four Sleeper leagues: who do I start, who do I draft?* | live | `.venv/bin/python cli.py serve` | 8200 |
| `dfs/` | *DK daily: which 9 fit the salary cap?* | live, in season | `.venv/bin/python cli.py serve` | 8300 |

Repos: `projections/`, `sleeper/` and `dfs/` are their own git repos, gitignored by
the parent. `best-ball-draft/` is tracked by the parent repo at
`Development/projects`.

Two projects were removed on 2026-09-08 and both are recoverable.
`best-ball-extension/` (a Chrome overlay) is in the parent repo's history.
`dynasty-rankings/` was **absorbed rather than dropped** — its two market sources
now live in `projections/pipeline/sources/`, and its history is at
`github.com/jvonderhoff/dynasty-rankings`. See `../CLAUDE.md`.

Every project is Python 3.11 in its own `.venv/` via `uv`. There is no shared package
and that is deliberate — see §8.

**Authoritative docs, when you need more than this file:**

| for | read |
|---|---|
| best ball + projections together | `best-ball-draft/docs/STATUS.md` |
| how projections is built inside | `projections/ARCHITECTURE.md` |
| the four Sleeper leagues | `sleeper/README.md`, `sleeper/docs/DRAFT_DAY.md` |
| daily fantasy | `dfs/README.md`, `dfs/docs/STATUS.md` |
| the recommender model | `best-ball-draft/docs/V2_DESIGN.md` |

---

## 2. The flow is one-way

```
                  EXTERNAL SOURCES
   Sleeper · ESPN · FFToday · DK props · DK pool · nflverse pbp · LateRound
                         │
                         ▼
         ┌───────────────────────────────┐
         │        projections/           │   the only thing that touches a source
         │                               │   the only thing that owns identity
         │   pipeline/  fetch → store    │
         │              → derive         │   data/store.db      players, snapshots
         │   analysis/  → publish        │   data/analysis.db   espn, props
         │   Analysis UI  :8100          │
         └───────────────────────────────┘
                         │
      ┌──────────────────┼─────────────────────┐
      │ HTTP push        │ read-only files     │ read-only file
      ▼                  ▼                     ▼
 best-ball-draft/    sleeper/              dfs/
 DK best ball        4 Sleeper leagues     DK daily
 key: dk_player_id   key: sleeper_id       key: DK salary name
 :8000 + Render      :8200                 :8300
```

Nothing flows back up. No app imports another app's code. **Every arrow is a file or an
HTTP call, never an import** — that is the whole architecture in one sentence.

---

## 3. The seams — the complete list of what crosses

There are exactly five, plus one duplicated function. If a change does not touch this
table, it cannot break another project.

| from → to | what crosses | keyed on | written by | stale at |
|---|---|---|---|---|
| `projections` → `best-ball-draft` | the six model fields: `ppg` `sd` `sources` `avail` `disagreement` `rec_share` | `dk_player_id` | `cli.py analysis-publish` → `POST /api/projections/upload` | 48h |
| `projections` → `sleeper` | `data/store.db` (crosswalk, read-only) + `data/stat_lines.json` (ESPN stat lines, unscored) | `sleeper_id` | `tools/export_stat_lines.py` | 7d |
| `projections` → `sleeper` | `data/dynasty_values.json` — KTC + FantasyCalc trade prices, rest-of-career. Joined on `mfl_id`, so **no name matching anywhere in it** | `sleeper_id` | `tools/export_dynasty_values.py` | 14d |
| `projections` → `sleeper` **and** `dfs` | `data/weekly_props.json` — per-game DK markets, incl. `exp_td` | `name_key` **(a string, not an id)** — `sleeper_id` rides inside each record as a field | `tools/export_props.py` | 24h |
| `best-ball-draft` → `sleeper` | `drafts.db` table `player_rankings` (your best-ball board), read-only | `dk_player_id` | you, in the rankings UI | — |
| both directions, by hand | `names.py`, byte-identical below its header in `best-ball-draft/app/data/` and `projections/pipeline/core/` | — | copy-paste | must always agree |

Three things about that table are load-bearing:

- **The props file is the one seam keyed on a name.** It is safe only because the
  exporter owns `names.py` and does the join before writing. Read the dict key as an id
  and every lookup misses silently — that shipped once, and a full lineup of plausible
  numbers rendered with 0/9 starters actually taking a market price. `startsit` now
  refuses a run where no starter took a market number.
- **Stat lines cross UNSCORED**, in Sleeper's own column names (`pass_yd`, `rec`, …),
  because two leagues use 6-point passing TDs and a total scored ESPN's way cannot be
  un-scored.
- **The published payload carries its own provenance** — `sources_meta` (per-source age
  and role) and `publisher` (commit sha). The draft app cannot see the projections
  app's stores, so without that a deployed recommender has no way to say how old its
  inputs are.

Freshness is always read from the payload's or export's own `generated_at`, **never
from a file's mtime** — `cp` and `git clone` both stamp a copy with now, which is how a
31-hour-old snapshot once read as `0.0h old`.

---

## 4. Where every number actually comes from

| number | built from | lives in |
|---|---|---|
| `consensus_ppr` (season points) | Sleeper + ESPN + FFToday, averaged | `projections/analysis/build.py` |
| props correction | DK/Underdog season markets, de-meaned **per position** | `analysis/sources/dkprops.py` |
| `sd` | position-level coefficients of variation × `ppg` — **not** measured weekly variance | `pipeline/core/metrics.py:31` |
| `ceiling` (best ball) | `ppg + 1.28·sd` | `best-ball-draft/static/recommender-v2.js` |
| VOR (Sleeper board) | league's own scoring applied to stat lines, minus the replacement starter | `sleeper/leagues/scoring.py` |
| **this week's** points | DK per-game props only | `projections/tools/export_props.py` |
| expected TDs | `exp_td = p·(1 + 0.512p)`, fitted 2024, measured 2025 | `projections/pipeline/td.py` |
| team defence | opponent's implied total | `projections/pipeline/dst.py` |

Two standing caveats worth re-reading each season:

- **A home-made weekly model exists and lost.** `pipeline/weekly.py` measured worse than
  "assume every week is a player's season average" once its defence ratings were held
  out properly. Its own header says do not wire it in. Weekly numbers come from the
  market or they do not exist.
- **The anytime-TD market is not de-vigged**, alone among the markets in
  `export_props.py`. Summed over Week 1 the raw probabilities imply 25.7% more scorers
  than the slate's own totals do. A propped TD number is calibrated in SHAPE, not level.

---

## 5. What runs on its own, and what does not

Five launchd jobs, all installed in `~/Library/LaunchAgents/` from plists checked into
the repos. launchd rather than cron **because cron silently skips a run on a sleeping
Mac**; launchd fires at the next wake.

| job | when | what | writes anything? |
|---|---|---|---|
| `com.bba.nightly` | Tue + Fri 07:30 | refresh every manual source, snapshot the DK pool, build the payload, **stop at the dry run**, write a dated report | no — never publishes |
| `com.bba.marketreport` | the other 5 mornings, 07:30 | market movement report | no |
| `com.bba.newspoll` | every 3h | poll news feeds into the store | store only |
| `com.bba.newspush` | every 3h | push news alerts | notifications |
| `com.bba.autoqueue` | every 5 min, **when loaded** | keeps live DK draft queues stocked | **YES — writes to your DK entries** |

`nightly` deliberately stops before publishing. On 2026-08-27 a refresh built a payload
against a stale committed cache and passed every check the runbook says to read; the
only tell was one word in the build chatter. Automating that publish would have
automated shipping it on a schedule. A useful side effect: `nightly` never needs
`BBA_API_KEY`, so it *cannot* change production.

`autoqueue` is the one job that acts for you. It has a wall-clock `--deadline` that
makes a forgotten timer go quiet instead of drafting your board overnight, and it never
discards a player you queued by hand.

**Everything else is manual**, including the publish that changes what production
scores with.

### The weekly in-season routine

```bash
cd sleeper && tools/weekly.sh          # refresh props + stat lines, then read start/sit
```

One script rather than three commands, because each of the three **quietly degrades**:
`export_props.py` writes a complete well-formed file with the crosswalk missing,
`export_stat_lines.py` leaves the previous file in place on failure, and a props file
for the wrong week has exactly the same shape as the right one. The script states the
age and row count of everything the answer rests on, and derives the week from the
schedule rather than taking it on trust.

Do not loop it: it makes one live scrape, coverage grows toward kickoff, and props go
stale at 24h. Run it once, late. Sunday morning beats Thursday.

For daily, refresh the same export and copy it across:

```bash
cd projections && .venv/bin/python tools/export_props.py
cp data/weekly_props.json ../dfs/data/
```

### Slash commands that wrap all this

`/startsit`, `/nightly-review`, `/update-projections` live in `.claude/commands/`.

---

## 6. Is anything broken? One command each

```bash
cd projections && .venv/bin/python cli.py doctor
cd sleeper     && .venv/bin/python cli.py doctor
cd dfs         && .venv/bin/python cli.py doctor
```

Each exits non-zero on red and **never fetches**, so a red doctor means your data is
bad, not that the network is. In the draft app the same question is
`GET /api/freshness`, surfaced at `/setup` and as a bar on `/recommend` that appears
only when something is stale.

Test suites: projections 112, sleeper 113, dfs 35. `best-ball-draft` has none — its
guard is `tools/preflight.py`.

**Healthy shape, measured 2026-09-08** (so you can recognise wrong):

```
store.db     players 469 · player_sources 1288 · snapshots 196 · unmatched 28220
drafts.db    drafts 82 · draft_picks 1860 · player_rankings 381 · espn 458 · props 466
leagues.db   leagues 4 · managers 47 · rosters 46
```

`unmatched` being large is normal and correct: it is every source row outside the DK
best-ball pool, kept rather than dropped. The pool itself is ~450-460 and **moves** —
read the count at run time, never trust one written down.

---

## 7. What is 2026, and what is forever

This is the section to read next August. Everything below is a place where a new season
touches the code; everything not listed is season-agnostic by design.

| where | what to change |
|---|---|
| `sleeper/config.json` | `season`, and re-run `cli.py link` — league ids change every year for redraft, and do **not** for dynasty |
| `projections/analysis/trending.py:33` | `SEASON = 2026` |
| `projections/analysis/build.py:46` | Sleeper projections URL has the season in the path |
| `projections/analysis/build.py:480` | `PBP_SEASON` — last completed season, always one behind |
| `projections/pipeline/sources/fftoday.py:172` | `season` default |
| `dfs/cli.py:205` | `--draftgroup` default — a DK slate id, changes **weekly**, not yearly |
| `best-ball-draft/drafts.db` | `player_rankings` is your board and starts empty each year |
| `sleeper/rankings/2026-redraft-ppr.csv` | new file per season; nothing reads a blessed path, everything takes a PATH |

Two structural notes for the year-to-year goal:

- **`pipeline/defense.py` and `weekly.py` project the new season from the previous
  one's data.** In week 1 there is nothing else. That is correct and stated in their
  headers — but it means an early-September number is a last-season number wearing this
  year's hat, and it should be treated as one.
- **Rookie drafts are half-built as of 2026-09-08.** KTC publishes 84 rookie-pick
  entries — "2026 Pick 1.01", "2027 Early 1st" — and they are carried in
  `dynasty_values.json` under `rookie_picks`, with values. They have no id of any
  kind, because they are not people, so they join to nothing; that is why they sit
  in their own block rather than in 19 rows of `unmatched`. Nothing consumes them
  yet, and that is next summer's problem.

---

## 8. Why it is shaped this way (the short version)

The long version is in `../CLAUDE.md`. Four decisions explain most of the layout:

1. **Sharing is a data seam, not a library.** Four projects with separate venvs and
   separate deploy cadences would be coupled by one shared package, and the single
   genuinely duplicated function is duplicated on purpose.
2. **Repos split on platform and product mechanics, never on league format.** DK best
   ball and DK daily are the same operator and different products, so they are
   separate. Redraft and dynasty are different valuations of the same weekly question,
   so they are one app with a `horizon` parameter. The tell when the first version got
   this wrong: the only format-specific line in the whole repo was one filter.
3. **Everything is keyed on an id.** Name matching is the fallback, never the key, and
   where the matcher cannot decide it refuses and reports. `manual_overrides.json` is
   checked in because every entry is a place the automatic path failed — it is a to-do
   list, not config.
4. **An application never lives in `projections/`.** A lineup optimiser sat in
   `projections/tools/` for a day, importing across the seam, and was moved out.

And the six bug classes this codebase keeps hitting are listed in `../CLAUDE.md`. The
first one — *a signal that looks the same whether or not the thing happened* — is the
reason half the machinery above exists.
