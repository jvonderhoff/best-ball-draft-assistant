# Fantasy football — the umbrella

Four projects, one player universe. This file is loaded by any session started in
any of them, so it holds **only what is true across all four**. Per-project detail
lives in each project's own docs, named below; when they disagree with this file,
they win.

## The projects

| | what it is | authoritative doc | state |
|---|---|---|---|
| `best-ball-draft/` | DK best-ball draft app + V1/V2 recommender. Public, on Render. | `CLAUDE.md`, `docs/STATUS.md` | **live, in season** |
| `projections/` | Every external source, every derived metric, the Analysis UI. Local only. | `ARCHITECTURE.md`, `README.md` | **live, local** |
| `sleeper/` | All four Sleeper leagues (2 redraft, 2 dynasty): board, draft plan, queue; start/sit and waivers still to come. | `README.md`, `docs/DRAFT_DAY.md` | **live** |
| `dfs/` | DraftKings daily: slates, salaries, salary-cap lineups. | `README.md`, `docs/STATUS.md` | **live, in season** |

`docs/STATUS.md` in the draft app is **the map** for best-ball + projections: since
the analysis split, no single repo holds that picture. Read it before changing
either.

Rookie drafts are next summer's problem. Nothing has been built for them.

**Rankings differ per format.** Redraft, best ball and dynasty are three separate
lists of the same players and must never be reused across formats. Redraft:
`sleeper/rankings/2026-redraft-ppr.csv`. Best ball: `best-ball-draft/drafts.db`
table `player_rankings`. Dynasty: the MARKET, not a list of yours —
`projections/data/dynasty_values.json`, read by `sleeper/cli.py dynasty`. Anything consuming rankings takes
a PATH, never a blessed location.

## Identity: everything is keyed on an id, never on a name

The spine lives in `projections/data/store.db`, table `players`:

```
dk_player_id  (PK)  ·  gsis_id  ·  sleeper_id  ·  espn_id  ·  yahoo_id  ·  fp_id
```

Each app keys on the id of **its own universe** and joins through this table:
best-ball on `dk_player_id`, `sleeper/` on `sleeper_id`, nflverse on `gsis_id`.

Two rules that hold everywhere:

- **Where the matcher cannot decide, refuse and report.** An unmatched player you
  can see beats a wrong one you cannot. `manual_overrides.json` is checked in
  because every entry is a place the automatic path failed — it is a to-do list.
- **Name matching is the fallback, never the key.** `names.py` is duplicated
  byte-identically (below its header) in `best-ball-draft/app/data/` and
  `projections/pipeline/core/` on purpose, and the two must agree while both apps
  exist. `sleeper/` has no copy and does no name matching at all.
  A *weaker* rule used to exist in `dynasty-rankings/sources/normalize.py`; that
  app was deleted 2026-09-08 and the rule went with it rather than spreading.
  Its replacement is the better answer: the dynasty export joins KTC to
  FantasyCalc on `mfl_id` and reads `sleeper_id` off FantasyCalc, so it does no
  name matching at all.

## Sharing is a data seam, not a code library

Decided 2026-08-31. The apps share the crosswalk (SQLite, read-only) and the
payload contract (`POST /api/projections/upload`, `GET /api/projections-v2`), and
nothing else. No common Python package: four projects with separate venvs and
separate deploy cadences would be coupled by one, and the single genuinely
duplicated function is duplicated deliberately.

**Corrected the same day, and worth keeping as a lesson.** The first version of
this split redraft and dynasty into separate apps — the wrong seam. Format does
not change how a lineup is picked; start/sit and waiver mechanics are identical
across them. It changes only how a player is VALUED. So they are one app with a
`horizon` (`ros` | `dynasty`) derived from Sleeper's `settings.type`, and the axis
to split on is **platform mechanics vs valuation horizon**, never league format.
The tell was measurable: the only format-specific line in the whole repo was one
filter. When a proposed split leaves the shared modules untouched, it is not a
split.

```
              projections/  (owns every source and the crosswalk)
                    │
   publish (HTTP)   │   read-only SQLite / JSON exports
   ┌────────────────┼─────────────────────┬──────────────────┐
best-ball-draft/    │              sleeper/               dfs/
DK best ball        │              Sleeper leagues        DK daily
keyed dk_player_id  │              keyed sleeper_id       keyed by DK salary name
```

**The axis is platform AND product mechanics, never data.** DK best ball and DK
daily are the same operator and different products — one drafts twenty players
and holds them, the other fills a salary cap weekly — so they are separate. An
application never lives in `projections/`: a lineup optimiser sat in
`projections/tools/` for a day, importing across the seam, and was moved out.

**The crosswalk covers the DK best-ball pool, not the waiver wire.** That is
~450-460 players and it MOVES as DK's pool changes, so read the count at run time
rather than trusting one written down. Anything outside that pool has no
projection. Report the count; never let those players quietly vanish from a
ranked list.

## Best ball, redraft and dynasty ask different questions

Same players, different maths. This is the axis that DOES separate repos — DK best
ball from Sleeper — as opposed to league format, which does not:

- **Best ball** counts your max scorer each week across 20 undroppable players, so
  `ceiling` (= `ppg + 1.28·sd`) is the number and variance is an asset.
- **Redraft** starts ~9 players you choose weekly and can replace, so the median
  week and the matchup are the numbers, and variance is mostly a cost.
- **Dynasty** asks the same weekly question as redraft — which is why they share an
  app — and a different one at acquisition: rest-of-career, not rest-of-season.

**Per-week numbers come from the MARKET, and only there.** `ppg` is season-long
and `sd` is estimated from position-level coefficients of variation
(`projections/pipeline/core/metrics.py:31`), not from opponent-adjusted weekly
numbers. The one genuine weekly source is DraftKings' own per-game player props:
`projections/tools/export_props.py` writes them across the seam and
`sleeper/cli.py startsit` consumes them. A home-made weekly model exists at
`projections/pipeline/weekly.py` and its own header says do not wire it in - it
lost to assuming every week is a player's season average (bug class 5 below).

Two measured facts about that seam, because both are ways to be wrong invisibly:

- **The props file is keyed on `name_key`, not on an id** - uniquely among the
  seams here, because the exporter owns `names.py` and does the join there so no
  consumer needs a copy. Each record carries `sleeper_id` as a FIELD. Reading the
  dict key as an id raises nothing: every lookup misses, every player falls back
  to his season week, and a complete lineup of plausible numbers renders with the
  market absent. It shipped that way and the first real run scored 0/9 starters
  from the market against 349 keyed players. `startsit` now refuses a run where
  no starter took a market number.
- **`anytime_td` is P(scores at all); `exp_td` is the count. Score `exp_td`.**
  Fixed 2026-09-08. The conversion now lives at `projections/pipeline/td.py` and
  travels with the export, because both consumers had been doing it themselves,
  neither measured, and in OPPOSITE directions - `dfs` read the probability as
  the count, `sleeper` used `-ln(1-p)`. Measured on 2025 play-by-play, fitted on
  2024, over the `p>=0.45` group a lineup actually turns on: identity MAE 0.176 /
  bias -24.6%, Poisson 0.128 / +9.7%, `p*(1+0.512p)` 0.094 / -3.5%. Poisson loses
  because scoring is clustered - a goal-line back's second touchdown is not
  independent of his first. Re-derive with `tools/backtest_td.py` rather than
  trusting the constant. Consumers keep their old conversion as a fallback for a
  pre-`exp_td` file and REPORT when it fires; do not copy the fit across the seam.
- **The anytime-TD market is still NOT de-vigged**, alone among the markets in
  `export_props.py`, while the ladders are cut 6%. Summed over Week 1 the raw
  probabilities imply 25.7% more scorers than the slate's own implied totals do.
  Not fixed. A propped touchdown number is calibrated in SHAPE now, not in level.

**A scoring rule that lifts a whole position lifts its replacement just as fast.**
Measured 2026-08-31: six-point passing TDs raise QB1's season total by 52.6 points
and his value over replacement by 0.7. What moves positional value is how many of
a position must be STARTED — superflex takes QB1 from ~80 VOR to 130. Check the
lineup before the scoring when a league "feels" like it favours a position.

## Environment

Python **3.11 via `uv`**, per project, in `.venv/`. The machine default is 3.9 —
do not use it, and do not suggest conda (anaconda was deleted 2026-08-14).

```bash
uv venv --python 3.11 && uv pip install --python .venv/bin/python requests pytest
```

`BBA_API_KEY` lives in `~/.zshrc`: present in `zsh -ic`, **absent in `zsh -lc`** and
in any non-interactive shell, which is how a cron publish fails silently.

Repos: `best-ball-draft/` is tracked by the parent repo at `Development/projects`.
`projections/`, `sleeper/` and `dfs/` are their own repos, gitignored by the parent.

**`dynasty-rankings/` was removed 2026-09-08**, and this is the shape of a
correct deletion. It was the only thing producing a rest-of-career valuation, so
it was not simply dropped: its two market sources moved to
`projections/pipeline/sources/{ktc,fantasycalc}.py`, behind the crosswalk, and
`tools/export_dynasty_values.py` writes the seam that `sleeper/cli.py dynasty`
reads. What died was the standalone Flask app and its weaker `normalize.py` —
what it *knew* moved to where sources live. Its git history is intact at
`github.com/jvonderhoff/dynasty-rankings`.

The two dynasty sources join on `mfl_id` and FantasyCalc carries `sleeper_id` on
every row, so the whole dynasty export resolves **without one name comparison** —
the strongest version of the identity rule above, and the reason the deletion
improved matters rather than merely tidying.

**`best-ball-extension/` was removed 2026-09-08** — a Chrome overlay for the DK
draft room, dormant since June. It is in git history if it is ever wanted back. Three
things went with it, and the reasons are worth keeping: a `pre-commit` hook that
copied the extension's `recommender.js` over the served one (the two had diverged by
15KB and six commits, so the next commit to the extension would have silently reverted
the live recommender), the `/api/rankings/export` endpoint and its button, and a
`players.js` fallback in `/api/players`. The extension directory was never inside
`render.yaml`'s `rootDir`, so every one of those paths was already dead in production.

## The bug classes this codebase keeps hitting

Written down because they recur, across every project here:

1. **A signal that looks the same whether or not the thing happened.** A stale
   payload and a fresh one, a cached 427-player build and a live 428-player one, a
   cron publish whose key was missing. The defence is always the same: state the
   age and the row count of everything an answer rests on, and give every project a
   `doctor` that never fetches and exits non-zero on red.
2. **Value paid to players who cannot play.** The most repeated bug here. Suspended,
   injured, retired, not on a roster — check availability before ranking anything.
3. **Confident wrong numbers from a harness.** Check the known-good control first
   before believing a measurement.
4. **Per-position sanity checks on any scraper.** A source that silently returns
   only WRs reads as a working source. This caught two real failures on their
   first run: FantasyPros' ADP page ships only its first five rows and lazy-loads
   the rest, and a five-player board parses perfectly cleanly.
5. **A model that beats the baseline only because the harness cheated.** A
   weekly projection measured +2.14% against "assume every week is average" —
   until the defence ratings were computed from a season it was not predicting,
   at which point it measured −1.19%. Hold out the data the model was fitted on,
   always.
6. **A parameter that is accepted, echoed, and ignored.** Fantasy Football
   Calculator's ADP API takes `teams`, reflects it in `meta.teams`, and returns
   byte-identical payloads for 8/10/12/14. `dfs --leverage` shipped inert twice
   for the same reason. Verify a knob changes the output before believing it
   does, and write the regression that proves it.

## Working style

Match the surrounding code: these repos comment the *why* — especially the failure
a piece of code exists to prevent — and not the *what*. Comments that record a real
past failure are load-bearing; do not strip them.
