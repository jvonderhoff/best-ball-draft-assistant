# Where things are — 2026-08-18

The state of BOTH apps in one place, because since the analysis split no single repo
holds the whole picture. Detailed reasoning lives in `PROJECTIONS_SPLIT.md` (the
contract), the projections app's `ARCHITECTURE.md` (its internals) and `V2_DESIGN.md`
(the model, and §4 the dead ends). This file is the map.

---

## The two apps

```
  best-ball-draft  (PUBLIC)                   projections  (PRIVATE)
  deployed on Render                          local only, on the Mac
  ────────────────────────────────            ──────────────────────────────
  DK pool + ADP                               Analysis UI      :8100
  custom rankings board                       Sleeper · ESPN · FFToday · props
  V1 + V2 recommender                         nflverse pbp + Next Gen Stats
  drafts, history, live draft                 the six-field payload
  /api/projections-v2                         analysis/  +  pipeline/
        ▲                                              │
        └──────── POST /api/projections/upload ────────┘
                  X-Api-Key: $BBA_API_KEY
```

The analysis app **does not need deploying**. It computes on the Mac and pushes, the
same pattern props already used and for the same reason — DK blocks Render's IPs. The
cost: **the Analysis table is not reachable from a phone.**

---

## What is live right now

| | state |
|---|---|
| Draft app on Render | deployed, healthy, `/analysis` → 410 |
| **V2's inputs in prod** | **the PUBLISHED payload** — 431 players, `source: pushed` |
| Sources per player | 137 at four, 182 at three (the pre-FFToday ceiling was three) |
| Analysis app | local, 54 tests, `doctor: ok` |
| Both repos | pushed and clean |

**Published 2026-08-18.** Production's V2 scores on the projections app's payload,
built against prod's own pool and board. `/api/projections-v2` reports `source:
pushed` — if it ever reads `local` again, publishing has stopped and prod has silently
reverted to the frozen fallback. That field is the only thing that would say so.

**Re-publish after any source refresh.** Nothing does it automatically, and the payload
is flagged stale at 48h.

---

## Running it

```bash
./run.sh                                    # draft app, :8000

cd ../projections
.venv/bin/python cli.py analysis-serve      # Analysis UI, :8100 (needs the draft app)
```

Against production — point **both** at prod, since the boards differ:

```bash
export DRAFT_APP_URL=https://best-ball-draft-assistant.onrender.com
.venv/bin/python cli.py analysis-serve
.venv/bin/python cli.py analysis-publish --no-dry-run    # changes what prod's V2 scores with
```

`BBA_API_KEY` lives in `~/.zshrc` — present in `zsh -ic`, **absent in `zsh -lc`** and in
any non-interactive shell. `.zshrc` is sourced for interactive shells only.

Pipeline: `cli.py fetch --source {dk|sleeper|nflverse|fftoday|all}` → `crosswalk` →
`doctor`. Also `analysis-verify`, `analysis-import`.

---

## How fresh is anything? — `/api/freshness`

**Only the DK pool refreshes on its own** (6h TTL, background thread, and the *next*
page load serves it). Sleeper is fetched live on each analysis build. ESPN, props and
FFToday are **manual**. The published payload is **manual**.

One endpoint answers it for everything, and two places surface it:

| surface | behaviour |
|---|---|
| `/setup` → Data Freshness | full panel: every source, age, rows, ok/stale/unused |
| `/recommend` | a bar that appears **only when something is stale**, linking to setup |
| `GET /api/freshness` | the JSON behind both |

Ages are computed server-side against server time and returned with a per-row `state`,
so the UI cannot drift from the endpoint on what counts as stale.

**The payload carries per-source ages with it** (`sources_meta`). The draft app cannot
see the projections app's stores, so without that a deployed recommender has no way to
answer "how old is the ESPN data behind these numbers" — which is exactly how an
18-day-old props table went unnoticed while every downstream number looked normal.
Stored in Postgres, not just on the instance: the first version kept them only in
memory, so the detail rows survived until the next deploy and then vanished silently
while the payload itself lived on.

`unused` is a distinct state from `unknown`, and deliberately so: FantasyPros' season
table and Yahoo are permanently empty by design, so counting them as unknown left the
rollup permanently unresolved — the same failure as a check that is always red.

## Projection sources — what is real

| source | state |
|---|---|
| Sleeper | live |
| ESPN | live, 458 rows |
| **FFToday** | **live since 2026-08-17 — the third real source** |
| DK / Underdog props | live, 545 rows — component correction, not a projection |
| FantasyPros season | **dead** — paywalled to a 10-per-position teaser |
| Yahoo | **not a projection source, ever** — see below |

`consensus_ppr` = Sleeper + ESPN + FFToday, corrected by props.

**Yahoo, settled 2026-08-17.** The app is still 403 at developer.yahoo.com so its
capability cannot be queried — but the practical question is closed regardless: the
fetcher requests `sort=AR` with no stats subresource and then parses a `player_stats`
block that was never asked for, so `fpts` is structurally always 0; `yahoo_projections`
has 0 rows in every store and never produced a record; and `consensus_ppr` filters on
`v > 0`. Yahoo exposes Analyst Rank, not points. **Unblocking it would add a rank.**

---

## FFToday, and the bug worth remembering

Free, no auth, 2026 season projections **with components** — so PPR is computed by us
rather than read from their scoring preset, and the components feed the prop
correction, which until now had ESPN as its only source.

Coverage: **120/120 inside ADP 120**, 330/428 overall. The ~98 it omits are fringe
players it genuinely does not project, which is why `doctor` registers it as a
partial-coverage source and gates it on ADP-120 rather than a spine bar it can never
clear. A permanently red check is one that stops being read.

Effect: **329 of 418 players gained a source**, `ppg` mean +0.12%, mean absolute 4.37%.

**The bug: RB and WR rows are both 11 cells with the halves swapped.** RB is
`Att Yds TD | Rec Yds TD`, WR is `Rec Yds TD | Att Yds TD`. Dispatching on cell width
read every receiver's receptions as his rush attempts — Chase's 116 catches became 2,
across all 126 WRs. Nothing errored; totals came out ~35% low and looked like a
conservative source. It shipped, and was caught only by a per-position cross-source
ratio: QB 1.000, RB 1.071, TE 0.999, **WR 0.653**.

Two fixes, both worth keeping: the parser reads the page's own **header** and maps by
column name, so a layout change fails loudly; and `_sanity()` asserts the top-20 WRs and
TEs have real reception counts. The bug was self-consistent under its own mapping, so no
internal cross-check could catch it — only a fact about football could.

Also note FFToday is **100% name-matched** (it publishes no ids). `doctor` warns about
it; re-check the ADP-120 number after every refresh.

---

## New display data — nflverse and NGS

Both **display only**. Neither feeds the model; see the nulls below.

**Play-by-play:** real **aDOT**, **WOPR**, **AY%**. Sleeper publishes *completed* air
yards, so aDOT is not recoverable from it — Chase reads 8.49 real against 4.17
(Sleeper ÷ targets) and 6.18 (÷ receptions). This replaced the old AY/Rec column.
Negative aDOT is correct for check-down backs.

**Next Gen Stats:** **separation**, **cushion**, **YAC over expected** — tracking data,
so they describe the *player* where aDOT and WOPR describe his *usage*. Own column
group, because NGS covers qualifying receivers only: 117 vs 255, and 54 of the top-120.

NGS independently confirmed the pbp aDOT to **0.28 yards** mean absolute difference.

---

## Settled — do not re-litigate

- **nflverse has no projections.** All 25 buckets are historical. `ffverse/ffopportunity`
  has expected points, but that is retrospective, not a forecast.
- **Routes run are not in pbp, PFR advanced receiving, or NGS.** YPRR is not computable
  from any free source. Do not derive one from something else.
- **aDOT/WOPR do not improve a projection** — inside the permutation null over three
  season pairs.
- **Nor do they predict the tail.** Re-tested with top-6 finish as the outcome,
  1999–2025, 136 apex positives: +0.005 AUC, CI [−0.020, +0.030]. The effect *shrank*
  as the sample grew from 33 to 136 positives, which is the signature of noise, not of
  an underpowered real effect.
- **V1's roster targets are not worth changing** — six seeds, all three alternatives
  positive in the mean and none distinguishable from noise. The targets are a weak
  lever anyway: moving one by a full player moves the realised roster by ~0.4, and V1
  already drafts 2.94 TEs against a target of 2.

---

## Open threads

1. **A fourth projection source.** FantasySharks and CBS both responded but need
   rendering or more parsing work; NFL.com is weekly-only and still serving 2025.
2. **Pipeline step 4** — rebuild ESPN / props as pipeline sources. They work today in
   `analysis/`, so this is refactoring, not new capability.
3. **Delete the frozen fallback** (`PROJECTIONS_SPLIT` §6 step 4) once the pushed path
   has run for a while. Note `analysis-verify` no longer expects identity — the two
   paths legitimately differ now that FFToday is in one of them.
4. **Remove the dead Yahoo plumbing** — routes, `kv_store`, the fetcher. It cannot
   produce projections, and it is the only consumer of `kv_store`.

---

## Traps hit this week — each now guarded

- **The recommender was ignoring your board on every warm reload.** Init called
  `loadCustomRankings()` fire-and-forget while `loadPlayers()` rendered immediately, and
  the sessionStorage-cached branch renders *synchronously* — so the first
  recommendations used market ADP with the star showing blue. V2 too, at
  `V2_CUSTOM_RANK_WEIGHT` 0.55. Fixed; it re-renders when ranks land.
- **CSV import left dropped players at their old rank.** A 250-row import only touched
  those 250; a player you cut kept his number. Clearing them does not fix it either —
  unranked falls back to market ADP. Non-CSV players now rank *below* the file, with an
  opt-out checkbox showing the counts.
- **A deploy silently reverts ADP** to the committed `player_cache.json`, and
  `/api/players` serves the cache *then* refreshes — so the first load after a deploy
  shows the old number and the next one is current.
- **Comparing against a cached build.** `analysis-verify` reported 345 false mismatches
  from a 6h-cached 427-player build vs a fresh 428-player one. Forces a rebuild now.
- **A ratio test that fires on rounding.** The sd invariant as `ceiling/ppg` rejected 18
  correct players; stated in points now.
- **Mean-of-ratios lies.** It reported ESPN +11.6% vs Sleeper and FFToday −2.4%; median
  and ratio-of-totals said +2–5% and −10%. Small denominators dominate. Use robust
  measures before concluding a source is biased.
- **A permutation null at high blend weight proves nothing** — there the shuffled arm is
  pure noise scoring 0.5, so it asks "beats random?" not "beats the baseline?". Only a
  bootstrap CI on the *difference* answers that.
- **Two prop stores now.** `tools/push-props.py` writes the draft app's, which only the
  fallback reads; the Analysis page's buttons write the projections app's, which the
  published payload reads.
- **Metadata that lives only on the instance disappears on deploy.** `sources_meta`
  was published, stored in memory, and lost at the next restart while the payload it
  described survived — so the freshness panel quietly lost its detail rows. Caught by
  watching the panel *across* a deploy rather than trusting the publish. Anything that
  must outlive a restart goes to Postgres.
- **Xcode updates break `/usr/bin/git`** until `sudo xcodebuild -license accept`. The
  Command Line Tools git at `/Library/Developer/CommandLineTools/usr/bin/git` is a
  working fallback.
