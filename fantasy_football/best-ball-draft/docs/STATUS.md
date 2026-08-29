# Where things are — 2026-08-24

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
| **V2's inputs in prod** | **the PUBLISHED payload** — 439 players, `source: pushed`, stamped with the publishing commit |
| Sources per player | 382 multi-source of 424 scored |
| Analysis app | local, 60 tests, `doctor: ok` |
| Both repos | pushed and clean |
| `tools/preflight.py` | **PASS — 0 failing, 0 worth a look** |

**Published 2026-08-27, publisher `dd03737`** — the first payload built with the
blended component basis (§2.5). Production's V2 scores on the projections app's payload,
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

**Each source is aged against the clock that fits what it FEEDS (2026-08-24).** One
7-day threshold for everything cried wolf: `sleeper` went "stale" at a week and raised
the bar mid-draft, when the Sleeper data behind the projections is refetched live on
*every build* and those rows are the pipeline's identity crosswalk. A warning that is
wrong once is a warning that gets ignored twice. `sources_meta` now carries a role —

| role | stale after | meaning |
|---|---|---|
| `projection` | 7d | inside `consensus_ppr`; stale matters |
| `market` | 4d | betting lines, refreshable only from the Mac |
| `identity` | 30d | player-id crosswalk, not a model input |
| `display` | 30d | Analysis columns only |

— plus a `live` flag for the two Sleeper rows, which report **no age at all** and say
why, because a snapshot age for something refetched every build is a number that looks
like an answer. An unlisted source defaults to `projection`: new sources are
load-bearing until someone says otherwise. A payload published before roles existed
carries none and keeps the old 7-day rule, so an older payload cannot look healthier
than a current one.

**The payload also carries the publishing commit** (`publisher`: sha, branch, dirty).
`/api/freshness` reads `pushed by projections-app @ c39da53`. Added after an afternoon
spent establishing something the payload should have said: a payload arrived with no
`sources_meta` while the publisher on the Mac built eleven keys for the same cache, and
nothing recorded which code had run. `analysis-serve` uses `use_reloader=False`, so a
process started before a feature existed keeps publishing without it indefinitely.

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

`consensus_ppr` = Sleeper + ESPN + FFToday. **Props are NOT in it** — no book quotes a
season receptions market, so a prop-implied total misses 70-100 of a receiver's ~280
points while an RB's is nearly complete, and averaging that in would drag every
pass-catcher down relative to every runner. They are a per-COMPONENT correction on top,
de-meaned **per position** since 2026-08-24 (V2_DESIGN §2.1).

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

## The routine — one command each

Every manual step is now scripted, because the order and the guards are where the
mistakes were, not the steps.

| what | command |
|---|---|
| refresh sources, build, dry run | `../projections/tools/refresh-sources.sh` |
| ...and publish | `../projections/tools/refresh-sources.sh --publish` |
| is prod serving real data? | `python3 tools/preflight.py` |
| have local sources moved ahead of prod? | `../projections/tools/source-ages.py --target <host>` |
| import finished drafts, re-score survival | `tools/import-new-drafts.sh` |
| does the basis of the prop correction matter? | `../projections/research/prop_basis.py --alt blend` |

`refresh-sources.sh` **refuses to run without `DRAFT_APP_URL`** rather than defaulting —
unset, it is localhost, and a publish then reports success while going nowhere near
production.

---

## Automation — what exists, and when each one runs

Three different mechanisms, and the difference between them is *who decides to run it*.
That distinction turned out to matter: three regressions shipped in one week with the
relevant lesson already written in this file, which is the case against relying on
anything that needs remembering.

### Runs by itself — a hook

| | |
|---|---|
| **`.claude/settings.json`** → `tools/hooks/on-model-edit.sh` | `PostToolUse` on `Write\|Edit` |

Fires on every edit and exits silently unless the file can change a recommendation —
either recommender, or the projections app's `payload.py`, matched by path suffix so it
works from either repo. When it matches it runs `tools/check-model-change.js` and
returns the diff as `additionalContext`, so it lands in the model's context rather than
only in the transcript.

**It never fails the edit.** A verification tool that can block work gets disabled, and
then it verifies nothing — the same fate as a warning that cries wolf.

`launch.json` stays gitignored; `settings.json` and `commands/` are shared, via two
negations in the root `.gitignore`. Note `git check-ignore` exits 0 when a NEGATION
matches too, so its exit code alone reports the opposite of the truth — use
`git add -n` to settle it.

### Runs when you type it — a slash command

| | |
|---|---|
| **`/update-projections`** | `.claude/commands/update-projections.md` |

Drives `refresh-sources.sh` and covers what a script cannot: what to read before
publishing (the target host, `sd_invariant_ok`, the player count in range), how to
interpret preflight afterwards, and which warnings are expected rather than wrong.

Deliberately NOT a hook. It publishes to production, and something that publishes
should be triggered on purpose. **Commands register at startup**, so a newly added one
needs a Claude Code restart before `/name` resolves.

### Runs when you invoke it — scripts

Everything in the table above, plus:

| what | command |
|---|---|
| did this change move anyone I did not intend? | `node tools/check-model-change.js` |
| re-score the survival model on real boards | `python3 tools/calibrate-survival.py` |

`check-model-change.js` is the substance behind the hook and is useful standalone —
`--base <ref>` compares against any commit.

### No skills, and that is deliberate

A skill loads automatically when its description matches the task, which makes it the
weakest of the three for this problem: the same judgement that failed three times would
be deciding whether it applies. The parts worth encoding either have teeth (the hook) or
need an explicit trigger (the command). The two judgement-shaped rules that remain —
grep every use of a constant before moving it, and check the change reaches V1 — are in
CLAUDE.md beside the command that runs the diff. Revisit if something slips past this.

### Considered — a backlog, with the reasoning kept (2026-08-27)

Reviewed for what agents and LLM tooling could actually add here. Ordered by value,
and the two rejections are listed because they are the obvious ideas and they are wrong.

1. ~~**News and injury advisories.**~~ **Built 2026-08-27** —
   `../projections/tools/injury-watch.py`, advisory only, writes `data/advisories.json`.
   On the first real board it found **7 material cases V2 cannot see**, Malik Nabers at
   ADP 23.1 with a torn ACL listed "Questionable" among them. Mostly a documented map,
   not a model call: two usable fields over 23 distinct pairs, and `injury_notes` is
   empty out of season. The LLM slot is the open set — an unrecognised body part, and
   free text in-season — surfaced as `review`. **Not wired into `/recommend` yet.**

   **Extended the same day into `tools/market-watch.py`, which is the version that
   earns its place.** An injury flag alone fires on 47 of 217 and gets ignored; an ADP
   move alone says something happened but not what. The signal is the DISAGREEMENT:
   bad news with a flat ADP is a room that has not reacted; OK news with a big drop is
   an overreaction worth buying. Median 14-day ADP drift across the pool is **1.9
   picks**, so movement is rare enough to read — Higgins +73.7 and Tyson +64.4 priced
   in, against Nabers +0.5 and Mahomes +0.8 unmoved on torn ACLs, and Kittle drafted
   7.6 picks EARLIER on an Achilles. News comes from RotoWire and CBS RSS, accumulated
   as snapshots because RotoWire serves only its last few items.

   **This also fixed the reason the ADP half could not have worked:**
   `refresh-sources.sh` fetched only fftoday, so the DK snapshot series had three
   points and stopped on 17 Aug. An ADP time series nobody was recording. It is in the
   routine now, and the tool improves every time the refresh runs.

   **The model call is still not wired** — there is no `ANTHROPIC_API_KEY`, no SDK and
   no `claude` on PATH here. The raw beat text is attached per player in
   `data/market-watch.json` for a reader to classify, which is what item 2's scheduled
   session would do. Original reasoning: `avail` is a positional base rate
   overridden to 0 only on a literal `IR` flag, so everything between "healthy" and
   "season over" is invisible to the model: a hamstring, a holdout, a committee, a snap
   count. This is the only item that adds a capability rather than automating a
   keystroke, and it sits on top of the most repeated bug class here. Advisory only —
   it must not move `avail`, or it becomes an unmeasurable heuristic of exactly the
   kind §4 records three failures of.
2. ~~**Nightly refresh on the Mac, stopping at the dry run.**~~ **Built 2026-08-28** —
   `../projections/tools/nightly.sh` plus `tools/com.bba.nightly.plist`. Wakes the app,
   refreshes every manual source, snapshots DK for the ADP series, polls news, builds,
   stops at the dry run, runs market-watch and preflight, and writes one dated report
   to `data/nightly/` with a `what needs you` section at the end.

   **It never publishes, and therefore never needs `BBA_API_KEY`** — it cannot change
   production even if something goes wrong with it, which is a stronger guarantee than
   being written not to. On 2026-08-27 a build fell back to the committed cache and
   passed every check the runbook lists; automating the publish would have automated
   shipping that on a schedule.

   **The reason it wakes the app first is measured, not defensive.** `spine.py` reads
   the pool with a 15-SECOND timeout and falls back to the committed cache on any
   failure, swallowing the exception; Render's free tier spins down and a cold start
   takes 30-60s. A 4am job firing into a sleeping app would build against a stale pool
   and report success, every night. That is very likely what happened on 2026-08-27, at
   the one moment nobody had touched the app in hours. It also greps the refresh output
   for `from cache-file` and refuses, because the app answering is not proof the build
   read it.

   **launchd, not cron:** cron does not fire on a sleeping Mac and silently skips;
   `StartCalendarInterval` runs at next wake. Scheduled 07:30, deliberately a time
   somebody will read it. launchd does not source `~/.zshrc`, so every variable is set
   explicitly in the plist — the same trap that has bitten the publish path.

   **Zero tokens.** Everything mechanical is shell. The judgement — read the report,
   decide whether to publish — stays with a human, and a scheduled Claude session would
   have cost 20-40k tokens a run for work a script does for free.

   **Split into three jobs on 2026-08-29, because one cadence was serving two needs.**
   `nightly.sh` is Tue/Fri and that is right for the SOURCES — it scrapes the DK
   sportsbook and FFToday, and doing that ~30 times a month from one home IP is a
   different thing from doing it a few times. It is wrong for the NEWS: RotoWire serves
   ~5 items a poll, so anything between runs is gone for good.

       com.bba.newspoll      every 3h                     capture. Two RSS requests.
       com.bba.marketreport  Sun/Mon/Wed/Thu/Sat 07:30    read them. News + ADP.
       com.bba.nightly       Tue/Fri 07:30                that, plus sources + dry run.

   Capture often, report daily, refresh rarely. `market-report.sh` wakes the app and
   asserts on `from cache-file` exactly as nightly does, and carries no API key either.

   **It does snapshot the DK pool, which is not the contradiction it looks like.**
   `dkpool.py` reads `$DRAFT_APP_URL/api/players` — our own app, not DraftKings — so it
   has no sportsbook footprint, and it is the highest-value thing the light job does:
   market-watch measures against the DK snapshot series, so without a fresh snapshot an
   off-day report reads today's news against Friday's board.

   **Both jobs write `nightly-latest.txt`, so line 1 names the job.** On a market-report
   day there is no publish decision — the sources were not refreshed. The days are
   covered exactly once; adding a day to one means removing it from the other.

3. ~~**The news join was throwing away 74% of what it captured.**~~ **Fixed 2026-08-29.**
   Measured across 77 stored items: RotoWire joined 20/20, **CBS joined 0/57**.
   `news_by_player` requires RotoWire's `"Name: headline"` shape, and CBS emits article
   titles — so every general NFL story was fetched, stored, and silently dropped at
   render. That is the entire non-injury half of the feed, which is also the half the
   quadrant table cannot help with.

   Now rendered as a **general-news digest**: unattached items, newest first, with any
   draftable player named in the text tagged in brackets. Yahoo added alongside (37/poll;
   ESPN's NFL feed is a one-item stub and FantasyPros' is a 404 — both probed and
   recorded in `FEEDS` so nobody retries them).

   **Two bugs surfaced while building it, both silent, both the house pattern.**
   `_text` decoded two entities by hand (`&amp;`, `&#39;`) and CBS emits `&#039;`, so
   stored titles read "Raiders&#039;" — harmless to the join, ugly in a digest a human
   reads; now `html.unescape`. And the player tagger missed **Cam Skattebo**, because
   `_normalize` rewrites nicknames to formal spellings (`cameron skattebo`) — correct
   when both sides are names, impossible when one side is prose, since no aliaser fires
   on "Cam" mid-sentence. CLAUDE.md's "normalize runs on both sides" symmetry cannot
   hold for free text, so `general_news` indexes the loose form alongside the aliased
   one. Do not fix this class by editing `_normalize`.

   **Readable as a page since the same day:** a `News` tab on the Analysis app
   (`/news` in the projections repo — `analysis-serve`, port 8100). Filters All /
   Player news / General / **Price moved**, which is the view worth having: it
   collapses ~130 headlines to the handful that both said something and had the room
   react. Headlines come from `store.db` (3-hourly, no network, 3-5ms); the player and
   ADP context comes from `market-watch.json`, so anything captured since the morning
   report shows the headline with no badge — the honest answer rather than a
   computed-live one that would disagree with the report already read. Two clocks in
   the freshness bar, because the halves fail differently.

   The read side lives in `analysis/news.py` so the page and the report cannot drift.
   Mac-only, like the rest of the Analysis app.

   Also: the no-news mover list printed only 12 of 19. A truncation you cannot see is
   the same failure as a filter you cannot audit — now 20, with an explicit "… and N
   more" line.

4. **Close the hook's blind spot.** The `PostToolUse` hook matches `Write|Edit`, so
   edits made through the shell never trigger it — both scoring files were changed that
   way on 2026-08-26 and the diff never ran. Add `Bash` to the matcher, and consider a
   `PreToolUse` guard that refuses a publish when the last build line says `cache-file`.
5. **More slash commands** for knowledge currently held in prose: a pre-draft check, a
   post-draft import, and the "why does this player look absurd" checklist (names.py,
   `avail`, `sources`, `realAdp` vs `adp`, then `debug-v2.js`).
6. **A subagent for open thread 6** — whether FantasySharks or CBS is parseable is a
   discrete, read-only research task and fits an agent well.

**Rejected, deliberately:**

- **Do not parallelise harness arms across agents.** §5.4b: `loadData()` reads a file
  the app rewrites, which is why every arm must run inside one script. Parallel agents
  reintroduce that exact failure, and the result would look like a finding.
- **Do not let an agent tune constants.** §4 exists because the instinct to improve the
  model by adding a heuristic has measured worse three times.

---

## Calibrated against real drafts (2026-08-24)

The first model work here scored against **real completed boards** rather than the
simulator. 33 DK boards, every seat, **935,163 (player, next-pick, survived) decisions**.
Re-run 2026-08-27 at **35 boards / 986,311 decisions**: 0.10 holds, calibration error
still 0.008. Two of thirteen saved drafts had finished; eleven are still in progress.

**`v2SurvivalProb` had never been checked, and was wrong twice.** It returned the
UNCONDITIONAL probability a player lasts — ignoring the one thing you always know when
you ask, that he is on the board *right now*. And `V2_ADP_SIGMA_RATIO` was 0.30 by
judgement against an actual sd of 6.5 at ADP 49-72.

| model | σ ratio | calib err | Brier |
|---|---|---|---|
| unconditional (old) | 0.30 | 0.093 | 0.0588 |
| conditional | 0.30 | 0.037 | 0.0521 |
| conditional | **0.10** | **0.008** | 0.0387 |

Conditioning alone recovers most of it at the unchanged σ — the tell that this was a
modelling error, not a tuning one. Excluding the 90-100% bin (81% of samples, all easy):
old 0.167 vs new 0.038, which is the honest number. **Not fixed:** the extreme tail,
where a Gaussian around ADP is thinner than real drafts. Full detail in V2_DESIGN §2.2.

**Why it mattered.** The old form was a standing *"grab him now"* bias on every pick.
The roster data agrees: across 33 drafts the first RB goes at exactly the field's pace
(round 2.0 vs 2.0) yet the roster finishes **0.41 backs short** (5.57 vs 5.98) with 0.48
more WRs — early picks spent on players who would have lasted.

**The harness cannot price any of this**, by construction: its opponents are ADP bots,
so their behaviour *is* the thing being modelled. This ships on out-of-sample
calibration instead. Re-run with `tools/calibrate-survival.py` as drafts finish; 33
boards establish the direction and cannot defend a third decimal.

---

## What the drafts say about how you draft

From the same 33 boards, seat-derived and verified 100% against the `mine` flag:

| | you | field |
|---|---|---|
| first RB | round 2.0 | 2.0 |
| RB count | 5.57 | 5.98 |
| WR count | 8.62 | 8.14 |
| QB1 taken | pick 77.9 | 73.1 |
| best QB, median ADP | 77.8 | 77.8 |

**The RB feeling is real but the cause was not front-loading** — the first back goes at
the field's pace. **The QB worry is a tail, not a level**: the median QB room is
identical to the field's, but five drafts landed on Mayfield 123.5 / Love 114.7 / Purdy
107.6 against a field median near 73. A floor rule beats a shape heuristic here — and
note §4 records three roster-shape mechanisms that all measured worse.

**ADP is unbiased and weak**: sd 15.0 picks, and 25% of all picks land more than a full
round from ADP. That is an argument for the column that does not run on ADP alone.

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

1. ~~**The reach penalty scales with the player's own volatility.**~~ **Fixed
   2026-08-26.** `tilt` was multiplied by `eff.sd / 10`, so among players you would
   equally be reaching for the WORST was penalised least — Darnold's sd 6.11 against
   DeVito's 0.19, a 32x gap. Scaled by the POSITION's reference sd now
   (`ctx.marketRefSd`, top-24 by mean in the universe). The number that made it
   concrete: a sub-1ppg body ranked **16th of 309** at pick 133 and now ranks 73rd;
   inversions across 12 real boards went 1320 → 357. V2_DESIGN §2.4.
2. ~~**`scale` re-inflates a source that reacts alone.**~~ **Fixed 2026-08-26**, and
   with it thread 3. Components now blend every source that publishes them
   (`_component_basis`), each rescaled by its OWN total, so a consensus total is met by
   consensus components. Basis values above what EVERY source holds: 68 pairs / 59
   players → 15 / 15. The residual 15 are components only one source publishes, where
   blending has nothing to average. `ppg` moved for 183 of 439 (mean 1.10%, max 8.80%);
   `rec_share` correctly did not move. `V2_PROP_BASIS=sleeper` restores the old basis.
   V2_DESIGN §2.5.
3. ~~**The prop correction's basis is Sleeper alone.**~~ **Fixed by the same change.**
   `research/prop_basis.py --alt blend` was the candidate; it is now the default. Note
   its numbers move as the sources do — the 14 sign flips recorded here read as 3 of
   155 when re-run on 2026-08-26.
4. **ESPN and FFToday components are collected and largely unused by the model.** 375
   of 435 players have ESPN components, including the only interception projection
   anywhere. The 2026-08-26 basis blend is the first model field to consume them; the
   rest still feed only the Analysis page.
5. **Survival is well calibrated in aggregate and skewed in the contested middle.**
   Re-run 2026-08-27 on 35 boards / 986,311 decisions: the headline calibration error
   is 0.008, but 794,158 of those decisions sit in the 90-100% bucket where the answer
   is "obviously still there". In the band where a pick decision actually turns the
   model is over-optimistic about survival — 40-50% predicted against 0.358 actual
   (+0.094), 50-60% against 0.481 (+0.070), 30-40% against 0.292 (+0.059) — while
   0-10% under-predicts (0.030 against 0.099). Directionally that advises WAITING on
   players who will not in fact last. Not acted on: one table, and the aggregate
   constant is unchanged, so this wants a second look before anything moves. The
   fitted optimum for `V2_ADP_SIGMA_RATIO` is still 0.10.
6. **A fourth projection source.** FantasySharks and CBS both responded but need
   rendering or more parsing work; NFL.com is weekly-only and still serving 2025. Note
   the marginal value is falling — most of the pool is already at three. The place it
   would pay is the thin tail: **37 players still rest on a single source**, which is
   how Pearsall reached production at 116 points while on IR.
7. **A QB floor rule.** Five of 33 drafts ended with a materially weak QB room. Unlike
   the §4 roster-shape mechanisms, a floor is a guardrail rather than a shape term.
8. **Pipeline step 4** — rebuild ESPN / props as pipeline sources. They work today in
   `analysis/`, so this is refactoring, not new capability.
9. **Delete the frozen fallback** (`PROJECTIONS_SPLIT` §6 step 4) once the pushed path
   has run for a while. Note `analysis-verify` no longer expects identity — the two
   paths legitimately differ now that FFToday is in one of them.
10. **Remove the dead Yahoo plumbing** — routes, `kv_store`, the fetcher. It cannot
   produce projections, and it is the only consumer of `kv_store`.

---

## Traps hit this week — each now guarded

- **A failed pool read falls back to the committed cache and says so in one word.**
  `spine.load_pool()` returns `(players, source)` where source is `api` or
  `cache-file`, and both `_from_api` and `load_custom_ranks` swallow every exception —
  so a refresh whose `/api/players` call fails builds the payload against
  `app/data/player_cache.json` instead, with **zero** custom ranks, and reports success
  at every other check. Hit 2026-08-27 during `refresh-sources.sh`: `441 players from
  cache-file | 0 custom ranks` where every other build that day said `440 from api |
  438 custom ranks`. `DRAFT_APP_URL` was set correctly — the script prints `target:` and
  refuses without it — so this was a transient read failure, not a misconfiguration, and
  a retry fixed it. Cost if published: 4 players in prod's live pool had no entry in the
  cache-file build and would have scored with no projection at all. **The `/update-projections`
  checklist reads three things and this is not one of them** — add the pool line to what
  you check, since `sd_invariant_ok`, `null_fields` and the player count were all
  perfectly healthy on the bad build. Note also that `--target` sets only where the
  publish SENDS; the env var is what the build READS.

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
- **A guard against "value credited to an unusable player" contained the fourth
  instance of that exact bug.** `V2_VALUE_FIT_FLOOR` (0.20) exists so a marginal player
  is not zeroed on roster fit alone — a third TE is a bad fit but he does play. It was
  applied to season-ending IR too, where 20% of a game stack is 20% of nothing. Ricky
  Pearsall ranked **V2 #3 at pick 240**: accumulation and playoff spike both correctly
  went to zero, then a stack worth +0.196 and "28 picks of value" worth +0.745 carried
  him positive — and the falling ADP *was the injury being priced in*, credited as a
  bonus. The floor now drops to 0 when `avail` is 0. 441 of 443 players unchanged; the
  two movers are the two IR players.
- **A calibration result for one question is not a licence to change another
  question's units.** `V2_ADP_SIGMA_RATIO` served both the survival model ("will he
  last?", measurable, and measured against 33 boards) and the reach penalty ("how far
  outside the market's own uncertainty is this?", a pricing judgement, never
  calibrated). Narrowing it 0.30 → 0.10 on the survival evidence tripled every reach
  penalty and put a 16-ppg QB *below* a 0.5-ppg QB — three backup quarterbacks in the
  V2 top ten on a live board. Nothing errored; both readings were plausible; the term
  simply meant something different afterwards. Split into `V2_MARKET_SIGMA_RATIO`.
  **Caught by the user looking at his own board, not by any check here.**
- **The same fix has to reach the model in charge.** The injury work landed in the
  payload and on V2's card, and V1 — the PRIMARY column — still had no concept of
  availability at all, because it scores on ADP and ADP lags a season-ending injury by
  days. Fixing V2's inputs is not fixing the recommendation unless V1 sees it too.
- **A check that dates a file by mtime cannot see a deploy.** `/api/freshness` aged the
  DK pool with `getmtime`, but that file is committed and a deploy checks it out fresh —
  so it reported a 92.6h-old ADP set as "0.2h old", and `/recommend` showed a receiver
  at ADP 78 against DK's live 113 mid-draft. `cache_age_seconds()` already read the
  embedded `fetched_at` and its docstring named this exact failure; it was three files
  away and simply not called.
- **A check can fix the thing it measures.** `preflight.py` calls `/api/players`, which
  trips the 6h TTL and starts the refresh — so a genuine FAIL cleared on the next run
  with nobody having done anything. Reads as a flaky tool rather than a fixed problem;
  the message now says so.
- **Identical values are not evidence of a shared cause.** The seed check inferred "prod
  is serving the bootstrap cache" from ADPs matching, and was wrong the same day: a
  freshly committed seed and a fresh pull agree almost perfectly. Only the *timestamp*
  separates them. Same lesson as `rankings_hydrated`.
- **Rounding three derived fields independently breaks the invariant between them.**
  `ppg`, `sd` and `ceiling` were each rounded to 2dp while `sd` and `ceiling` were
  derived from full precision — so the relationship held for numbers nobody could see
  and missed by up to 0.016 for the ones everyone reads, refusing a publish at random
  about once a pool. Derived from the rounded `ppg` now, and the tolerance TIGHTENED
  from 0.015 to 0.006 rather than widened.
- **`.gitignore` patterns containing a slash anchor to their own directory.**
  `.claude/*` covered only the repo root and left every nested `.claude` fully
  un-ignored by the `!` above it, briefly exposing `launch.json`. `**/` is required.
- **A stale warning that is wrong once gets the whole bar ignored.** The `/recommend`
  bar was fixed to fire on sub-rows, immediately started crying wolf about `sleeper`,
  and the fix was to age each source by its ROLE — not to widen the threshold.
- **Xcode updates break `/usr/bin/git`** until `sudo xcodebuild -license accept`. The
  Command Line Tools git at `/Library/Developer/CommandLineTools/usr/bin/git` is a
  working fallback.
