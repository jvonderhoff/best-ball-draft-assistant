# Fantasy football — the umbrella

Five projects, one player universe. This file is loaded by any session started in
any of them, so it holds **only what is true across all five**. Per-project detail
lives in each project's own docs, named below; when they disagree with this file,
they win.

## The projects

| | what it is | authoritative doc | state |
|---|---|---|---|
| `best-ball-draft/` | DK best-ball draft app + V1/V2 recommender. Public, on Render. | `CLAUDE.md`, `docs/STATUS.md` | **live, in season** |
| `projections/` | Every external source, every derived metric, the Analysis UI. Local only. | `ARCHITECTURE.md`, `README.md` | **live, local** |
| `sleeper/` | All four Sleeper leagues (2 redraft, 2 dynasty): board, draft plan, queue; start/sit and waivers still to come. | `README.md`, `docs/DRAFT_DAY.md` | **live** |
| `dynasty-rankings/` | Ranking-source comparison (KTC, FantasyCalc, CSV). A valuation INPUT, not a weekly tool — the dynasty leagues' start/sit lives in `sleeper/`. | — | dormant, uncommitted changes |
| `best-ball-extension/` | Chrome overlay for the DK draft room. | — | dormant since 2026-06-11 |

`docs/STATUS.md` in the draft app is **the map** for best-ball + projections: since
the analysis split, no single repo holds that picture. Read it before changing
either.

Rookie drafts are next summer's problem. Nothing has been built for them.

**Rankings differ per format.** Redraft, best ball and dynasty are three separate
lists of the same players and must never be reused across formats. Redraft:
`sleeper/rankings/2026-redraft-ppr.csv`. Best ball: `best-ball-draft/drafts.db`
table `player_rankings`. Dynasty: not wired up. Anything consuming rankings takes
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
  `dynasty-rankings/sources/normalize.py` is a *different, weaker* rule — fine for
  comparing ranking sources by name, not to be copied anywhere else.

## Sharing is a data seam, not a code library

Decided 2026-08-31. The apps share the crosswalk (SQLite, read-only) and the
payload contract (`POST /api/projections/upload`, `GET /api/projections-v2`), and
nothing else. No common Python package: five projects with separate venvs and
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
        publish (HTTP)    │    read-only SQLite
        ┌─────────────────┴──────────────────┐
  best-ball-draft/                       sleeper/
  keyed dk_player_id                     keyed sleeper_id
```

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

**There are no per-week projections anywhere yet.** `ppg` is season-long and `sd`
is estimated from position-level coefficients of variation
(`projections/pipeline/core/metrics.py:31`), not from opponent-adjusted weekly
numbers. Anything that needs a weekly number is new work.

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

Repos: `best-ball-draft/` and `best-ball-extension/` are tracked by the parent
repo at `Development/projects`. `projections/`, `dynasty-rankings/` and `sleeper/`
are their own repos, gitignored by the parent.

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
5. **A parameter that is accepted, echoed, and ignored.** Fantasy Football
   Calculator's ADP API takes `teams`, reflects it in `meta.teams`, and returns
   byte-identical payloads for 8/10/12/14. Verify a knob changes the output before
   believing it does.

## Working style

Match the surrounding code: these repos comment the *why* — especially the failure
a piece of code exists to prevent — and not the *what*. Comments that record a real
past failure are load-bearing; do not strip them.
