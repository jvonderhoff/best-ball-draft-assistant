# Where things are — 2026-08-17

The state of BOTH apps in one place, because since the analysis split no single repo
holds the whole picture. The detailed reasoning lives in `PROJECTIONS_SPLIT.md` (the
contract), the projections app's `ARCHITECTURE.md` (its internals) and `V2_DESIGN.md`
(the model). This file is the map.

---

## The two apps

```
  best-ball-draft  (this repo, PUBLIC)        projections  (PRIVATE)
  deployed on Render                          local only, on the Mac
  ────────────────────────────────            ──────────────────────────────
  DK pool + ADP                               Analysis UI      :8100
  custom rankings board                       Sleeper / ESPN / props
  V1 + V2 recommender                         nflverse pbp + NGS
  drafts, history, live draft                 the six-field payload
  /api/projections-v2                         analysis/  +  pipeline/
        ▲                                              │
        └──────── POST /api/projections/upload ────────┘
                  X-Api-Key: $BBA_API_KEY
```

**The analysis app does not need deploying.** It computes on the Mac and pushes the
result, which is the same pattern props already used and for the same reason — DK
blocks Render's datacenter IPs. The consequence to know before a draft: **the Analysis
table is not reachable from a phone.**

---

## What is live right now

| | state |
|---|---|
| Draft app on Render | deployed, healthy, `/analysis` → 410 (moved) |
| V2's inputs in prod | **the local fallback build** — nothing published yet |
| `/api/stores/status` | all hydrated; `projections_payload: NONE PUBLISHED` |
| Analysis app | local, working, 54 tests passing, `doctor` clean |
| `best-ball-draft` | pushed, `master` level with origin |
| `projections` | pushed, `main` level with origin |

**Prod's recommender is running exactly the code and numbers it was before the split.**
That is intended: the split shipped without changing a single V2 valuation, and moving
prod onto the new payload is a separate, deliberate act.

---

## Running it

```bash
./run.sh                                    # draft app, :8000

cd ../projections
.venv/bin/python cli.py analysis-serve      # Analysis UI, :8100 (needs the draft app)
```

Against production instead of local — **point BOTH at prod, not just the publish**,
because the boards differ (prod 391 custom ranks, local 380):

```bash
export DRAFT_APP_URL=https://best-ball-draft-assistant.onrender.com
.venv/bin/python cli.py analysis-serve
.venv/bin/python cli.py analysis-publish --no-dry-run    # updates what prod's V2 scores with
```

`BBA_API_KEY` lives in `~/.zshrc`, so it is present in `zsh -ic` and **absent in
`zsh -lc` and in any non-interactive shell** — `.zshrc` is sourced for interactive
shells only. This costs an hour if you rediscover it.

Other commands: `analysis-verify` (diff against the draft app's own build),
`analysis-import` (one-shot table copy), `fetch --source nflverse`, `crosswalk`,
`doctor`.

---

## What moved on 2026-08-16, and what did not

**Moved** to `projections/analysis/`: `analysis.py`, the ESPN / FantasyPros / Yahoo /
DK-props / Underdog fetchers, `templates/analysis.html`, and the six-field payload
builder.

**Stayed** here: the DK pool, the custom rankings board (the user's opinion, and 55%
of every V2 valuation — moving it would put the largest single input behind a network
hop), V1/V2, drafts, `names.py`, and the FantasyPros ECR fetcher, which enriches the
pool rather than feeding analysis.

**`app/analysis.py` here is a FROZEN FALLBACK.** Both copies still compute. They were
verified identical before the page moved — 428 players, exact agreement on all 20
payload fields — and they will drift the moment one is edited alone. Edit the
projections app. Deleting this copy is the one-way door and has **not** been taken;
`PROJECTIONS_SPLIT.md` §6 step 4 lists everything that goes with it.

---

## Reading a V2 number

`/api/projections-v2` now reports **`source`** — `pushed` or `local` — plus
`age_hours` and `schema_version`. Read it before concluding anything:

- `local` when you expected `pushed` → the projections app has stopped publishing.
- a `warning` field → only ever set for a pushed payload gone stale (48h). The plain
  local fallback deliberately does **not** warn, because that is a normal state (a
  fresh install and prod-before-first-publish both look like it) and a banner that is
  always on is one nobody reads.

`?source=local` forces the fallback, which is how the two are compared.

---

## New data since the split

Both **display only**. Neither touches the six fields V2 scores with, per the standing
rule that features the harness cannot price ship off or flagged.

**Play-by-play (nflverse)** — real **aDOT**, **WOPR**, **AY%**. The reason it exists is
that Sleeper publishes *completed* air yards, so aDOT is not recoverable from it:

| | real aDOT | SL ÷ targets | SL ÷ receptions |
|---|---|---|---|
| Chase | 8.49 | 4.17 | 6.18 |
| Smith-Njigba | 11.25 | 7.76 | 10.63 |

This replaced the old AY/Rec column. Negative aDOT is correct for check-down backs.

**Next Gen Stats** — **separation**, **cushion**, **YAC over expected**. Tracking data,
so it measures the *player* where aDOT and WOPR measure his *usage*. Its own column
group because NGS publishes qualifying receivers only.

Coverage, all pass catchers / inside ADP 120:

| | crosswalked | pbp metrics | NGS |
|---|---|---|---|
| all (362) | 361 | 286 | 117 |
| ADP ≤ 120 (102) | 102 | 96 | 54 |

NGS independently confirmed the pbp aDOT to **0.28 yards** mean absolute difference —
a different instrument measuring the same thing. That check is now a test.

---

## Checked so it is not re-litigated

- **nflverse has no projections.** All 25 release buckets are historical.
  `ffverse/ffopportunity` has expected points, but that is retrospective — what a
  player *should* have scored given usage, not a forecast.
- **Routes run are not in pbp, PFR advanced receiving, or NGS.** So **YPRR is not
  computable from any free source** — this is not a Sleeper limitation. Do not derive
  one from something else; that is the mistake aDOT existed to correct.

---

## Open threads, highest value first

1. **The projection consensus is thin, and this one actually moves V2.**
   `consensus_ppr` is Sleeper + ESPN + props only: FantasyPros season is paywalled to
   a 10-per-position teaser and Yahoo is blocked at app registration. `sources` drives
   how heavily V2 leans on the ECR blend, so a third real source changes valuations.
2. **Publish to prod** when you want the deployed recommender on the new analysis. It
   is one command; it is separate from everything above on purpose.
3. **Pipeline step 4** — rebuild ESPN / FantasyPros / Yahoo / props as pipeline
   sources. They work today in `analysis/`, so this is refactoring, not new capability.
4. **Delete the frozen fallback** (§6 step 4) once `analysis-verify` has stayed clean
   across a few real publishes.
5. **Yahoo** is still wanted and still blocked at developer.yahoo.com needing Fantasy
   Sports read permission. App-level, not code — scope, token persistence and 3.9
   compatibility are all done.

---

## Traps this session actually hit

Each of these cost real time and is now guarded in code:

- **Comparing against a cached build.** The first `analysis-verify` reported 345
  mismatches; every one was a 6h-cached 427-player build against a fresh 428-player
  one. Forces `?refresh=1` now. Same lesson as the harness: record the player count
  with any number you plan to compare, and build both arms in one run.
- **A ratio test that fires on rounding.** The sd invariant stated as `ceiling/ppg`
  rejected 18 correct players, because both fields round to 2dp and at ppg ≈ 0.3 that
  is over 1%. Stated in points now.
- **A warning that would always be on.** Surfacing "serving the local fallback" as a
  UI warning would have put a permanent banner on the live draft page. Only the
  identifiable failure — a pushed payload gone stale — warns.
- **Two stores for props now.** `tools/push-props.py` writes this app's (which only
  the fallback reads); the Analysis page's buttons write the projections app's (which
  the published payload reads). Pushing props here no longer changes what V2 scores
  with unless you also publish.
