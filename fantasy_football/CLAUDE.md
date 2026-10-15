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
| `sleeper/` | All four Sleeper leagues (2 redraft, 2 dynasty): draft board and queue, weekly start/sit, waivers, dynasty roster values. | `README.md`, `docs/DRAFT_DAY.md` | **live** |
| `dfs/` | DraftKings daily: slates, salaries, salary-cap lineups. | `README.md`, `docs/STATUS.md` | **live, in season** |

**The map is `docs/architecture.html`, and it is the only one.** A clickable diagram
with one page per part (Projections, Best Ball, Redraft, Dynasty, DFS), plus every seam,
where every number comes from, the launchd schedule and the health checks. Open it in a
browser; it is also published as a pinned Artifact, so republish after editing it.
`docs/MAP.md` was folded into it and deleted on 2026-09-14 — do not start a second
inventory. When the map disagrees with a project's own doc, the project's doc wins; fix
the map.

`best-ball-draft/docs/STATUS.md` is the running status log for best ball + projections
(what is live, what is open, the traps), and `dfs/docs/STATUS.md` is the same for DFS.
Read the relevant one before changing that project.

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
  How the other copies were removed, and why the dynasty export needs no name
  matching at all: `docs/DECISIONS.md`.

## Sharing is a data seam, not a code library

Decided 2026-08-31. The apps share the crosswalk (SQLite, read-only) and the
payload contract (`POST /api/projections/upload`, `GET /api/projections-v2`), and
nothing else. No common Python package: four projects with separate venvs and
separate deploy cadences would be coupled by one, and the single genuinely
duplicated function is duplicated deliberately.

**Split on platform mechanics vs valuation horizon, never league format.** Redraft
and dynasty are one app (`sleeper/`) with a `horizon` (`ros` | `dynasty`) derived
from Sleeper's `settings.type`: format changes how a player is VALUED, not how a
lineup is picked. When a proposed split leaves the shared modules untouched, it is
not a split. (The seam was drawn wrong once, the same day: `docs/DECISIONS.md`.)

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
daily are the same operator and different products, so they are separate. An
application never lives in `projections/`.

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

Two rules for anything that reads that export. The measurements behind them, and
the de-vig and ladder-hold fits, are in `projections/README.md` under *What the
seam has measured* — read it before touching the export or a consumer of it:

- **Join on `match_keys`, never on the dict key.** The file is keyed on `name_key`
  and carries `sleeper_id` as a FIELD. Misreading the key raises nothing: every
  player silently falls back to his season week. Fold punctuation, look up, done;
  anything that renames a player belongs in `names.py`, not in a consumer.
- **Score `exp_td`, not `anytime_td`.** One is a count, the other P(scores at all).
  A consumer keeps its old conversion only as a fallback for a pre-`exp_td` file
  and REPORTS when it fires; never copy the fit across the seam.

Positional value moves with how many of a position must be STARTED, not with the
scoring rules: check the lineup before the scoring when a league "feels" like it
favours a position (measured: `docs/DECISIONS.md`).

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

**The rules above that a machine can check are checked** — `names.py` agreement, one
home for name matching, no imports across the seam. Run it after touching any of them;
non-zero on FAIL, and a missing project prints SKIP, never PASS:

```bash
projections/.venv/bin/python tools/check_rules.py          # its own tests: -m pytest tools/ -q
```

`dynasty-rankings/` and `best-ball-extension/` were removed 2026-09-08. What a
correct deletion looks like, and what went with each: `docs/DECISIONS.md`.

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
