# Projections app — architecture

**Status: design, nothing built.** Written 2026-08-14. Companion to
`PROJECTIONS_SPLIT.md`, which covers the *contract with the draft app*; this covers
the *new app itself*. Meant to move into the new repo when it exists.

---

## 1. Scope

**It owns:** every external data source, every derived metric, and the Analysis UI.
Sleeper, ESPN, FantasyPros, Yahoo, DK/Underdog props, nflverse play-by-play.

**It does not own:** the DK player pool as a *product* (it consumes one), the custom
rankings board, the recommender, or anything about drafting. Those stay lite in the
draft app.

**Its output is one artifact:** a per-player payload keyed on DK `player_id`, of which
the draft app's recommender consumes six fields. Everything else it produces is for a
human to look at.

That asymmetry drives the whole design. **The model-facing output is tiny and must be
correct; the human-facing output is large and merely has to be useful.** Do not let
the second one's size dictate the first one's architecture.

---

## 2. The shape that matters: pipeline ≠ presentation

The single most important decision, because it defers every other one:

```
   fetch  ──►  raw store  ──►  derive  ──►  publish
                                  │
                                  └──►  read-only UI
```

The pipeline is a **library plus a CLI that produces artifacts**. The UI is a thin
read-only layer over those artifacts. Nothing in the UI computes anything.

Why this is the right call here specifically:

- **Where it runs stops being a foundational choice.** Local CLI today, deployed
  later, both, neither — the pipeline does not care. Given that DK props already
  require a residential connection and nflverse parquet is heavy, you do not yet know
  where this wants to live. Do not answer that question in the foundations.
- **The expensive, fragile part becomes testable.** A pipeline stage is a function
  from inputs to outputs; a Flask route that fetches, computes and renders is not.
- The draft app is the counter-example: `analysis.py` fetches, joins, derives and
  serves in one call, and that is exactly why nothing in it can be tested and why
  three bugs in one session were silent.

---

## 3. Layout

```
projections/
  pipeline/
    sources/            # one module per source. Each returns normalised records
      sleeper.py        #   and knows NOTHING about any other source.
      espn.py
      fantasypros.py
      yahoo.py
      nflverse.py       # play-by-play parquet; the only heavy dependency
      dkprops.py
      underdog.py
    core/
      ids.py            # THE crosswalk. See §4 — this is the heart of the app.
      names.py          # ported from the draft app; keep the both-sides discipline
      metrics.py        # opportunity, red zone, efficiency, regression
      blend.py          # consensus + props correction -> the six model fields
      schema.py         # payload shape, schema_version, validation
    store.py            # local SQLite: immutable raw snapshots
    publish.py          # POST to the draft app; write artifacts
  web/                  # read-only Flask UI over artifacts. No computation.
  tests/
  cli.py                # fetch | build | publish | doctor
```

**Sources know nothing about each other.** Every cross-source join happens in `core`,
against the crosswalk, never inside a fetcher. In the draft app that separation does
not exist and the result is a 460-line function where a Sleeper change can break an
ESPN column.

---

## 4. The ID crosswalk is the heart of this app

Build this first. Every silent failure in the draft app traces to name matching:
a player who does not match is not an error — he falls through to an ADP-implied
estimate and gets scored as a generic body, with plausible numbers and no log line.
Gainwell went at ADP 97 valued on nothing, and it took a person noticing.

With six sources instead of four, that surface grows. So make identity a
**first-class table**, not a dict lookup that returns `None`:

```
players
  dk_player_id   PK, the key the draft app speaks
  gsis_id        nflverse
  sleeper_id     Sleeper
  espn_id, yahoo_id, fp_id
  full_name, pos, team
  resolved_by    'id' | 'name' | 'manual'
  confidence
```

Rules:

- **Join on IDs wherever an ID exists.** nflverse publishes a `players.parquet` with
  `gsis_id -> display_name`, so pbp joins by id and never by the abbreviated
  `J.Chase` form. Verified 2026-08-14: 0 unresolved gsis_ids.
- **Name matching is the fallback, and it must be recorded as such** — that is what
  `resolved_by` is for. A payload built on 40% name matches is one source rename away
  from a bad night.
- **Unmatched is a reported number, not a silent null.** `doctor` (§8) prints match
  rate per source, overall and inside ADP 120, and names the misses. Measured
  baseline to beat: nflverse matched 94% of pass catchers inside ADP 120, and every
  miss was a rookie with no NFL snaps — which is correct absence, and the point is
  that you can *tell the difference*.
- **Manual overrides are a checked-in file**, not a code patch.

---

## 5. Raw snapshots are immutable

`store.py` writes every fetch as a new row keyed `(source, season, fetched_at)` and
**never overwrites**. Derivation always reads from the store, never from the network.

This buys three things the draft app cannot do today:

1. **Re-derive without re-fetching.** Change a metric, replay every historical
   snapshot, diff the output. This is what makes a metric change safe.
2. **Answer "what did Sleeper say on the 12th".** The two-month-old board incident
   was undiagnosable partly because nothing recorded what had been served when.
3. **Diff two snapshots** to see what actually moved — the same thing that made the
   `Kenneth -> Kenny Gainwell` rename visible in the pool refresh.

Cost is disk, which is free. A season of pbp parquet is 20MB and is *immutable
historical data* — fetch it once, ever.

---

## 6. Stack

| Concern | Choice | Why |
|---|---|---|
| Language | Python **3.11+**, own venv | Local default is **3.9.19** (anaconda) and you have already lost time to a 3.9 venv problem on the dynasty tool. Pin this explicitly at init; Render's draft app is already on 3.11. |
| Parquet / pbp | **duckdb** preferred, `pandas`+`pyarrow` as the verified fallback | duckdb is one dependency, queries parquet with SQL directly, and does not hold the frame in memory — a good fit for "aggregate 48k plays into 300 rows". **Not verified here: duckdb is not installed on this machine.** pandas 1.4.4 + pyarrow 12.0.1 *are* installed and I used them to compute real aDOT/WOPR successfully, so that path is known-good. |
| Raw store | SQLite | Local, immutable snapshots, zero ops. Postgres only if the UI is ever deployed. |
| Web | Flask + vanilla JS | Same as the draft app. The Analysis table already exists — port it, including the column-definition model, which is what keeps 50+ columns maintainable. |
| Scheduling | `cron` locally, or run by hand | Season projections move slowly. Props are the only thing wanting frequency, and they already need a residential connection. |

---

## 7. Where it runs

**Recommendation: local-first.** CLI on the Mac, pushing artifacts to the draft app.

- DK props are already blocked from datacenter IPs, so a residential runner is
  mandatory regardless.
- nflverse parquet plus a dataframe engine is a heavy deploy for something computed
  from data that never changes.
- Board-building happens at a desk.

**The fork to decide later, not now:** whether the Analysis UI needs to be reachable
away from the Mac — on a phone mid-draft, say. If yes, phase 2 is a read-only Flask
UI on Render reading a Postgres mirror, with the pipeline still local. Because §2
separates pipeline from presentation, that is an additive change rather than a
rewrite. Do not pre-build it.

---

## 8. `doctor`, and testing — the two things the draft app lacks

**`cli.py doctor`** is the operational answer to this codebase's recurring bug: a
signal that looks the same whether or not the thing happened. It prints, and exits
non-zero on anything red:

- per-source: rows fetched, snapshot age, match rate overall and inside ADP 120
- crosswalk: how many players resolved by id vs name vs manual, and the unmatched list
- payload: schema version, player count, and **which of the six fields are null and
  for whom**
- last publish: when, to where, accepted or refused

**Tests earn their place here in a way they did not in the draft app.** CLAUDE.md
says verification is by running the thing, and for a recommender graded by a
simulator that is right. But this app's core is pure functions over fixed inputs with
knowable answers, and its failures are *silent* rather than visible. So:

- **Crosswalk and metrics get real unit tests**, against a small committed fixture
  (say 20 players covering a rookie, a name-changer, a suffix, a QB, a pass-catching
  back, and someone with zero targets). Every gate added on 2026-08-14 — rookies read
  `—` not `0.0%`, QBs get no receiving metrics, rates need 10+ targets — is a test
  case, because each was a real bug found by eye.
- **Golden-payload test:** derive from a committed snapshot, compare the six fields
  against a checked-in expected output. Any change to that diff must be intentional.
- Fetchers are **not** unit tested — they talk to the network. They get a contract
  check in `doctor` instead.

---

## 9. Build order

1. **`ids.py` + `store.py` + `doctor`.** Identity and visibility before anything that
   depends on them. At the end of this step you can answer "who do we know about, from
   which sources, and how confident are we" — which is the question the draft app
   still cannot answer.
2. **One source end-to-end: Sleeper.** Fetch -> snapshot -> crosswalk -> derive ->
   payload -> `publish --dry-run`. Proves every seam on the source you understand best.
3. **`projections_hydrated` on the draft app side** (see `PROJECTIONS_SPLIT.md` §6) —
   before anything real is pushed.
4. **Remaining sources**, one at a time, each with its match rate recorded.
5. **nflverse**, which is where the payoff is: real aDOT and WOPR, retiring the
   AY/Rec compromise.
6. **Port the Analysis UI.** Last, because it is the part that works today.
7. Only then delete `analysis.py` from the draft app.

Steps 1–5 leave both apps working. Step 7 is the one-way door.
