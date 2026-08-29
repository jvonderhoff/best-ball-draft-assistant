# CLAUDE.md

DraftKings Best Ball draft assistant. Flask + vanilla JS + Postgres, deployed on Render.

**`docs/STATUS.md` is the map — read it first.** It holds the state of BOTH apps in
one place, which no single repo does since the split: what is live, what is open, the
runbook, and the traps that have already cost time.

**The Analysis page and every data source moved out on 2026-08-16.** They live in
`fantasy_football/projections` now. `docs/PROJECTIONS_SPLIT.md` is the record of what
moved, what stayed and why; read it before touching projections or analysis. The
contract it documents — V2 consumes six fields, V1 consumes `adp` alone — is what
makes the seam cheap.

```bash
cd ../projections && .venv/bin/python cli.py analysis-serve   # http://localhost:8100
```

**Analysis is NOT deployed and there is no `/analysis` on Render any more** — that
route returns 410 with a pointer. It runs on the Mac, against local or prod:

```bash
export DRAFT_APP_URL=https://best-ball-draft-assistant.onrender.com
cd ../projections && .venv/bin/python cli.py analysis-serve
```

Consequence worth knowing before a draft: **the Analysis table is not available on a
phone.** That was the deliberate trade (props need a residential connection anyway).
If it ever needs to be, the projections app's ARCHITECTURE §7 has the additive path —
a read-only UI on Render over a Postgres mirror, pipeline still local.

The analysis app needs THIS app running: it reads the DK pool from `/api/players` and
the rankings board from `/api/rankings`. It does **not** need to be deployed — it
pushes the six-field payload to whichever draft app you point it at, which is the same
local-compute-then-push pattern props already use.

**`app/analysis.py` here is a FROZEN FALLBACK. Edit the projections app instead.**
Both copies still compute, and they agreed exactly on 2026-08-16 (428 players, all six
fields). They will drift the moment one is edited alone, and the fallback is what makes
a bad publish survivable — so a change made in only one place removes the safety net
without saying so. Deleting this copy is §6 step 4, the one-way door, and has not
happened.

**Prod's V2 runs on the PUBLISHED payload as of 2026-08-18** — 431 players,
`source: pushed`. Nothing republishes automatically; do it after any source refresh.

**Read `source` on `/api/projections-v2` before concluding anything about a V2 number.**
It says `pushed` or `local` — which code computed the inputs — plus `age_hours`. A
`local` where you expected `pushed` means the projections app has gone quiet, and
nothing else says so. `?source=local` forces the fallback, which is how the two are
compared:

```bash
cd ../projections && .venv/bin/python cli.py analysis-verify
```

Publishing needs `BBA_API_KEY`, which lives in `~/.zshrc` — so it is absent from a
non-interactive agent shell and present in `zsh -ic`. `zsh -lc` is NOT enough; `.zshrc`
is sourced for interactive shells only.

**`GET /api/freshness` answers "how old is any of this".** One endpoint covering the
DK pool, the rankings board, the published payload, and every source behind it — the
payload carries per-source ages across in `sources_meta`, because this app cannot see
the projections app's stores. Surfaced as a panel on `/setup`, and on `/recommend` as a
bar that appears **only when something is stale** (a banner that is always on is one
nobody reads). Ages and states are computed server-side so the UI cannot drift from the
thresholds.

**Only the DK pool refreshes on its own.** Sleeper is fetched on each analysis build;
ESPN, props, FFToday and the publish itself are all manual.

**`v2SurvivalProb` is calibrated against REAL drafts, not the harness** — 33 complete
DK boards, 935,163 decisions. It is CONDITIONAL (`S(next)/S(now)`: he is on the board
now, and the old form forgot that) and `V2_ADP_SIGMA_RATIO` is **0.10**, not the 0.30
that was judgement. Calibration error 0.093 → 0.008. The harness cannot price this —
its opponents are ADP bots, so their behaviour *is* the thing being modelled. Re-score
with `tools/calibrate-survival.py`; grow the dataset with `tools/import-new-drafts.sh`.
V2_DESIGN §2.2.

**Before shipping any change to a scoring constant or term, run
`node tools/check-model-change.js`.** It scores every player with the working tree and
with `HEAD`, on REAL boards from `drafts.db` at four pick depths, and lists exactly who
moved — in BOTH models, because V1 is the primary column and a fix that reaches only V2
has not fixed the recommendation. Every mover should be one you intended: making V1
read `avail` moved all 443 players until it was narrowed to `avail === 0`, and the
sigma regression showed as **"0 unchanged, 357 MOVED"** for a change that was only
meant to recalibrate survival. Empty-roster testing is why that one shipped — at pick
190 with nobody rostered, neither the stack nor the reach term fires.

**One command refreshes everything manual:**
`../projections/tools/refresh-sources.sh` (add `--publish`), or the
`/update-projections` slash command, which reads the output for you. It refuses to run
without `DRAFT_APP_URL` rather than defaulting to localhost.

**`../projections/tools/nightly.sh` does all of that unattended, and never publishes.**
Scheduled at 07:30 by `tools/com.bba.nightly.plist` (launchd, because cron does not fire
on a sleeping Mac). It wakes the app, refreshes every source, snapshots DK for the ADP
series, polls news, stops at the DRY RUN, then runs market-watch and preflight into one
dated report at `../projections/data/nightly/`, ending with a `what needs you` section.
Read that; the publish stays a human decision.

**It wakes the app first because that is a real failure, not a precaution.**
`spine.py` reads the pool with a 15-second timeout and falls back to the committed
`player_cache.json` on any failure, swallowing the exception — and Render's free tier
spins down, with cold starts of 30-60s. An unattended job firing into a sleeping app
builds against a stale pool and reports success. It also greps the refresh output for
`from cache-file` and refuses, because the app answering is not proof the build read it.

**The nightly job never needs `BBA_API_KEY`**, and that is the point: it cannot change
production at all. A stronger guarantee than being written not to.

**Read `docs/V2_DESIGN.md` before changing the recommender.** It documents the model, the
evidence behind every constant, and — most importantly — §4, the dead ends. This file
covers only the operational things that live nowhere else.

## Running it

```bash
./run.sh                      # port 8000, --no-reload
```

**Flask runs with `--no-reload`. Restart the server after editing a template**, or you
will test the old page and believe your change did nothing. The browser caches it too —
if a restart isn't enough, load with a cache-busting query string.

`asset()` cache-busts static files by mtime. Never hand-maintain `?v=N`; doing so once
had browsers running scoring code from before several fixes, silently.

No test suite. Verification is by running the thing: the harness for model changes, the
app in a browser for UI changes.

**Doing both in one session silently invalidates the harness numbers.** `loadData()`
reads `app/data/player_cache.json` off disk, and the *app* rewrites it — `GET
/api/players` trips a 6h TTL and refreshes the DK pool in a background thread. So the
browser check you run to verify a UI change can re-baseline the simulator underneath
results you already have. Measured 2026-08-16: a rerun at an identical seed on identical
code moved V1's EV $76.17 → $68.09, because the pool had gone 420 → 427 players between
them. **The player count on line 1 of the harness output is the only tell** — record it
with any number you plan to compare later, and run every arm of a comparison inside one
script so a refresh cannot land mid-experiment. Full note in §5.4b.

## Deployment

Render, auto-deploys from `master`, usually live in 45–120s.

**Run `tools/preflight.py` before a draft, and after any deploy.**

```bash
python3 tools/preflight.py                       # checks prod; non-zero exit on FAIL
```

One command covering every way this app has silently served wrong data: a pool
reseeded from the committed cache by a deploy, publishing stopped and V2 back on the
frozen fallback, a board that is really `rankings_seed.json`, `projections_hydrated`
false, an unreachable Postgres, and stale sources behind the payload. Each check
exists because that failure actually happened, and every one of them was silent at
the time — plausible numbers, no error, nothing logged. WARN is for legitimate states
worth seeing; the commonest is a recent deploy, where prod correctly serves the seed
until the 6h TTL trips.

Its companion on the other side is `../projections/tools/source-ages.py`, which
answers what prod cannot: whether the LOCAL sources have moved ahead of what was
published.

**One check reads the local working tree rather than prod: `seed age`.** Every other
check asks what production is serving now; that one asks what it will serve the moment
it spins down, which on the free tier is routine. It FAILs past three days because the
committed `player_cache.json` has twice been served straight into a live draft — 92.6h
old on 2026-08-20 (a receiver at ADP 78 against DK's 113) and 109.7h old on 2026-08-29
(Gadsden II at 178 against 184.4). Neither was visible from the server side, because
from the server side nothing was wrong.

```bash
python3 tools/refresh-seed.py                    # refresh it, validate it, then commit
```

Use the script rather than calling `fetch_players(force_refresh=True)` by hand: a
refresh REBUILDS every row from DK, so any field not set in that loop is silently
dropped — which has wiped `ecr_rank` from the whole pool before. It validates count,
schema, ECR coverage and `fetched_at`, and restores the old file if any of them fail,
so a partial DK response cannot sit in the working tree looking committable.

**The filesystem is ephemeral.** SQLite is wiped on every deploy and on idle spin-down.
Anything that must survive lives in Postgres (`DATABASE_URL`): `rankings_store`,
`drafts_store`, `projections_store`, `kv_store_external`.

**`/api/stores/status` is the only endpoint that reads Postgres directly.** Every other
endpoint reports the local SQLite, so a warm instance looks healthy whether persistence
is working or not. Check it after any deploy that touches storage.

**A 200 does not mean your deploy landed.** The old instance keeps serving the whole
time the new one builds, and it answers every health check perfectly — because it *is*
healthy, it is just the previous code. Polling `until curl … 200` therefore returns
instantly and proves nothing, which is a way to "verify" a deploy that has not started.
Poll for something only the NEW build serves: a string added to a template
(`curl -s $HOST/analysis | grep -q col-groups`), or a field only the new code emits.
Same lesson as `rankings_hydrated` — check that the thing happened, do not infer it
from a signal that looks the same either way.

**Read `rankings_hydrated` there, not just the counts.** Counts were not enough and that
is exactly how a two-month-old board went unnoticed: a boot that fails to reach Postgres
leaves `rankings_seed.json` — a *committed* bootstrap file — serving as the live board,
at `V2_CUSTOM_RANK_WEIGHT` 0.55 of every valuation. By the time anyone calls the status
endpoint the database has woken up and reports a healthy count, so both columns look
fine. `rankings_hydrated: false` means the live board is the seed file; saving rankings
is then blocked (409), because the frontend posts the whole board and unranked players
go up as deletes — one Save from an unhydrated cache would have destroyed 69 real
rankings. A `rankings_warning` also appears whenever local and durable drift apart
after a good boot.

**`projections_hydrated` is the same check for V2's inputs**, per dataset
(`{"espn": …, "props": …}`), with `projections_warning` listing anything wrong. `false`
means the local table is whatever survived the filesystem wipe — on Render, nothing — so
V2 silently runs on Sleeper alone: 356 players drop from two projection sources to one
and the ECR blend doubles from 0.15 to 0.30. Every score shifts, nothing errors. There is
no seed file behind these tables, so the tell is a local count of 0, which reads
identically to "not fetched yet"; that ambiguity is why the flag is also on
`/api/projections/meta`, the endpoint you actually hit when the numbers look off. Unlike
rankings it does **not** block writes — `save_espn`/`save_props` are pure upserts with no
delete path, and pushing props is the obvious recovery from a failed hydrate.

**The lesson generalises past rankings.** Three bugs this session were silent in the same
way: plausible numbers, no errors, nothing logged. Prefer failing loudly and recording
whether a thing actually happened over inferring it from a count that looks right.

**The stores' `_conn()` must never raise, and this is load-bearing.** Every `load_*`
documents "None when unreachable", but until 2026-08-14 `psycopg2.connect` sat outside
the try, so that contract held only for the cheap cases (no `DATABASE_URL`, no psycopg2)
— a real outage *raised*. Two safety nets were dead as a result, both measured rather
than argued: the 4-attempt retry in `_hydrate_external_rankings` ran **0 of 4** loads
against an unreachable store (`init_external` raised first and unwound past the loop),
and that retry exists precisely for the Neon cold start after a deploy, where connect
times out; and `/api/stores/status` **500'd** instead of reporting `UNREACHABLE`, so the
one instrument for "did persistence work" broke exactly when persistence was broken.

`app/data/player_cache.json` is committed **on purpose** — `_seed_players_if_empty` needs
it to populate a cold database. It looks like a build artifact. It isn't. Don't gitignore
it.

## Data pipeline

| Source | Where | Refresh |
|---|---|---|
| DK player pool / ADP | this app | automatic, 6h TTL, background thread on `GET /api/players` |
| FantasyPros ECR | this app | enriches the pool; stays here |
| Custom rankings board | this app | manual, and correctly so — it's the user's opinion |
| Sleeper / ESPN / props | **projections app** | buttons on the Analysis page, or its CLI |
| FFToday season projections | **projections app** | `cli.py fetch --source fftoday` then `crosswalk` |
| The six-field V2 payload | **projections app** | `cli.py analysis-publish --no-dry-run` |

`tools/push-props.py` still works and still pushes straight into this app's store,
which is what the FROZEN fallback build reads. The Analysis page's prop buttons write
the projections app's store, which is what the published payload reads. **They are
different stores now** — pushing props here does not change what V2 scores with unless
you also publish.

**A page load does NOT re-fetch rankings or ADP on its own — know what triggers each.**
`PLAYERS` (and therefore ADP) is cached in **sessionStorage for 10 minutes**, so a
reload inside that window re-renders from cache and never calls `/api/players`. The
server then has its own 6h TTL on top, refreshed in a background thread, so a fetch
that does happen serves the OLD pool and the NEXT load gets the new one. Rankings are
fetched once at init and only when the star is already on; nothing polls them. To
force a genuinely fresh board mid-draft: `bustCache('players_bundle')` in the console,
or `POST /api/players/refresh`, then reload twice.

**You should not have to notice this yourself any more — the stale bar now says so.**
`/api/players` returns the pool's own `fetched_at` on an `X-Pool-Fetched-At` header,
the browser caches it with the bundle, and `checkFreshness()` compares it to what the
server currently holds. It asks two independent questions — "is the SERVER stale?" and
"is MY COPY older than the server's?" — and only the first existed until 2026-08-29,
which is how /recommend showed Gadsden at ADP 178 against DK's live 184.4 during a
draft while the bar stayed silent and was *right* to: prod had cold started, reseeded
from the committed cache, served that seed on the load which tripped the TTL, and
refreshed behind it exactly as designed. The bar was describing the server and the
cards were describing sessionStorage. The client-behind message carries a link that
busts and reloads, and the check re-runs every 5 minutes, because the 10-minute TTL
only applies on a reload — `PLAYERS` sits in memory for as long as the tab is open, so
a board that was current at pick 1 can be hours behind by pick 200.

**That 10-minute cache is also what made the rankings race bite.** Fixed 2026-08-17:
init called `loadCustomRankings()` fire-and-forget while `loadPlayers()` rendered
immediately — and the warm-cache branch renders SYNCHRONOUSLY, so the first
recommendations were computed against market ADP with `customRankMap` still empty,
while the star showed blue. Measured at a round-7 pick: the top pick changed and two
players appeared in the visible top 6 that did not belong. `loadV2Projections()
.then(renderRecs)` had always been right; rankings now follow the same pattern.

**The board is OFF by default and the flag is per-browser.** `useCustomRankings` reads
`localStorage['bba_use_custom_ranks'] === 'true'`, so a new browser, a cleared profile,
incognito, or simply the other device all default to market ADP — and the rankings are
not even fetched until it is on (`customRankMap` is empty, not merely unused). The only
indicator is the header button: **★ filled blue = on, ☆ hollow grey = off.** Check it
before concluding anything about why a player is or is not being recommended; on
2026-08-15 an entire analysis was written against the wrong mode because the flag was
read from an automated browser rather than the user's.

When it *is* on, `applyCustomRanks` **substitutes** the rank into `adp` and moves the
market value to `realAdp`. That is a bigger behavioural change than the 0.55 blend
weight suggests, because everything downstream reading `adp` is then reading the user's
opinion. Anything asking "will he last?" or "did the room let him slide?" must read
`realAdp` — V1 got this wrong in the value-steal term until 2026-08-16 and charged one
opinion twice (rank 164 → 120 doubled a player's score, 8.3 → 16.7).

**`/api/dk-draft-state/<id>` returns HTTP 200 with zero picks when its cache is cold.**
It is fed by the BBA Live bookmarklet and expires; the payload then carries
`needs_bookmarklet` and an `error` string. Check `picks.length` before trusting it —
scoring an empty board silently produces a confident, completely wrong answer rather
than an error.

**DK blocks Render's datacenter IPs for props only.** The player pool fetches fine from
prod (verified). Props must be pushed from a residential connection.

`/api/projections/refresh` calls the FantasyPros *season* scraper, which is dead —
paywalled to a 10-per-position teaser. It is not the path that feeds the model.

Name matching lives in `app/data/names.py`. DK says "Nick Singleton" where every
projection source says "Nicholas". Unmatched players fall through to an ADP-implied
estimate and get scored as generic bodies — check this first when a player's valuation
looks absurd.

**Don't fix a mismatch by special-casing one side.** `normalize_name` runs on *both*
sides of every lookup, and that symmetry is load-bearing rather than tidy. The
2026-08-12 pool refresh had DK change "Kenneth Gainwell" to "Kenny Gainwell" — the
exact spelling the alias was written to translate *away* from, on a round-8 back —
and nothing broke, because both spellings normalise to the same key either way. The
same refresh brought "A.J. Dillon" → "AJ Dillon" and "Ted Hurst" → "Ted Hurst III",
also absorbed. A one-directional fix would have silently un-matched all three.

## The harness

`tools/compare-models.js` — V1 vs V2 through complete simulated drafts and seasons.

- **Always read `--truth market`.** `proj` grades V2 against its own answer key.
- **Absolute numbers are meaningless.** Opponents are ADP bots and so is the 1,089-team
  final field, so EV levels are wildly inflated. Read model-vs-model deltas only. Never
  quote an EV figure as a real-world result.
- `tools/rb-depth.js --pos {QB|RB|WR|TE}` — paired counterfactuals for roster counts.
  Paired on seed *and* weather, which is what makes it able to resolve effects the
  construction table cannot.
- `tools/sitngo-ev.js` — the winner-take-all Sit & Go contests, a different game.

**The noise floor is ±$2 on a paired difference. Replicate anything smaller with
`--seed` before believing it.** Absolute EV swings 3.5x on the seed alone ($49 / $27 /
$14 for the same comparison), which is why the rule above says never to quote a level.
Paired differences are far tighter, but not infinitely so — see §5 of the design doc.
Two results this session survived only because they were re-run at a second seed, and
one confident write-up had to be retracted.

**Real opponent rosters (the §9.2 field) live only on this machine.** Deliberately:
Render has no use for opponent seats and DK blocks its IPs anyway. The chain is

```bash
xargs python3 import_dk_history.py --include-opponents --ids < ids.txt
python3 tools/export-real-rosters.py     # -> tools/.field-cache/ (gitignored)
```

where `ids.txt` is one DK draft id per line, from `.saved_drafts.json`. Both the
database and the export are gitignored and regenerable, so losing them costs a re-run
and nothing else. `compare-models.js` picks the export up automatically;
`--no-real-field` reproduces a bots-only run. Re-run as slow drafts finish — only
*completed* boards import, and this needs to be in the low hundreds before it can
measure anything (21 today, ~2% of the candidate pool).

**`--include-opponents` is off by default and must stay that way for normal imports.**
Exposure, the History page and the extension export all mean "my roster" by "picks".
A full board is kept apart from your own picks by the `mine` column, which every one
of those paths filters on.

## Working agreements

**V1 stays the primary column in `/recommend`; V2 shows alongside.** Do not swap the
default. §9 records why: three real V2 errors were caught by eye in its first day
(stale FA team, name mismatch, inflated stack), and the side-by-side is what catches
them. V2 is the model under development, not yet the model in charge.

**Commit freely; ask before pushing.** Local commits need no permission. Pushing to
`master` auto-deploys to production, so that needs a yes — including when a change
feels routine.

**`git push` hangs from an agent session unless the keychain helper is bypassed.**
`credential.helper` is `osxkeychain`, which wants a GUI prompt that never appears in a
sandboxed process, so the push sits there until it is killed — no error, no output.
Reads are unaffected (`git ls-remote` returns instantly), which makes it look like a
network problem rather than an auth one. Use `gh`'s helper instead:

```bash
GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin master
```

**The empty `-c credential.helper=` is the part that matters.** `-c` APPENDS to the
helper list rather than replacing it, so passing only the `gh` helper leaves osxkeychain
ahead of it in the chain and the push hangs exactly as before. Clearing the list first is
what makes the override take. Diagnose with `GIT_TRACE=1`: the tell is a `401` from
GitHub followed by `run_command: git credential-osxkeychain get` and then silence.

**Tune advice for large-field tournaments and mid-size single-entry contests.** The
Millionaire and Play-Action (~1,089 and ~458-team finals) are where V2's build is worth
the most. Bubble Screen and Huddle (18–41 team finals) are the lowest-rake, structurally
softest field, because single entry means nobody is running twenty correlated rosters
against you — **and as of 2026-08-16 that is where the user actually plays.**
Sit & Gos and satellite qualifiers are not the target; don't optimise for them.

**"V2 only matters in big fields" was wrong — do not repeat it.** This file used to say
V2 beat V1 by "+4–9% at small ones", from a §5.2 table that had gone stale by most of §2
and §3 of V2's development. Re-measured 2026-08-16 at five seeds on one pool: **+42.7%
mean at an 18-team final, +48.8% at 45, positive at 5/5 seeds.** The edge does still grow
with field size, but V2 is strongly ahead at every size, and the old number was steering
the user away from the model that helps them most. Corrected in §5.2; read the columns
there by event count, not by size.

**Yahoo would not add a projection even if unblocked — checked 2026-08-17.** The app is
still 403 at developer.yahoo.com ("This application is not authorized to perform this
action"), so its capability cannot be queried directly. But three things settle the
practical question without it:

- The fetcher requests `players;position=X;sort=AR` with no stats subresource, then
  parses `stat_id 1073` out of a `player_stats` block that was never asked for. `fpts`
  is structurally **always 0.0**, working auth or not.
- `yahoo_projections` has **0 rows in every store**, local and prod. It has never
  produced a record.
- The only Yahoo value anything downstream consumes is `yahoo_rank`, in the positional
  consensus. `consensus_ppr` filters on `v > 0`, so a permanently-zero `yahoo_pts_ppr`
  was never entering the average.

What Yahoo exposes here is **Analyst Rank ordering** (`sort=AR`), not season points.
Season-long point projections are not a documented resource in the public Fantasy API —
Yahoo's projections are weekly and surfaced in-product. Believed, not measured, since
the 403 blocks verification.

**So do not count Yahoo toward fixing the thin consensus.** Unblocking it would add a
rank, not a projection.

**The third source arrived from somewhere else: FFToday, 2026-08-17.** Staff season
projections with components, scraped in the projections app
(`pipeline/sources/fftoday.py`), free and no auth. Effect measured at the changeover:
**329 of 418 players gained a source** (mean +0.77, 137 now at four), and `ppg` moved
−2.49% mean / 5.34% mean absolute / 33.9% max. `sources` drives the ECR blend weight,
so this is a real change to what V2 scores with — the first input improvement that did
not need the harness's permission.

`consensus_ppr` is now **Sleeper + ESPN + FFToday**. (FantasyPros' season table and
Yahoo are in the average's source list but hold zero rows everywhere, and it filters on
`v > 0`.)

**Props are NOT in `consensus_ppr`, and this file said they were until 2026-08-20.**
They cannot be: no book quotes a season receptions market, so a prop-implied total is
missing 70-100 of a receiver's ~280 points while an RB's is nearly complete, and
averaging that in would drag every pass-catcher down relative to every runner. They are
applied as a per-COMPONENT correction on top instead — only quoted components move, a
missing market contributes exactly zero. What is true is narrower: a used market adds 1
to `sources`, which sets the ECR blend weight, so props do change valuations, just not
through the average. **The correction is de-meaned as of 2026-08-20** — see V2_DESIGN
§2.1 for why, and `V2_PROP_DEMEAN` in the projections app for the modes.

**Consequence: `analysis-verify` no longer expects the two paths to be identical, and
that is correct.** The frozen `app/analysis.py` here still blends Sleeper + ESPN +
props, so the projection fields legitimately differ now. What must still agree exactly
is everything FFToday cannot touch — `avail`, `rec_share`, the id keying — and that is
what the check is now for. It already did its original job: it proved the port was
faithful before the page moved.

## How this codebase decides things

This matters more than any individual convention.

**Constants are swept before they ship, not reasoned into place.** Every value in §2 of
the design doc carries its evidence. Where a constant is judgement rather than
measurement, it says so.

**§4 exists so failed ideas are not retried.** Three separate mechanisms for forcing
roster shape have now measured worse. The instinct to "improve" the model by adding a
heuristic is usually wrong here, and there is a written record of why.

**Features whose benefit the harness cannot measure ship off or flagged.** Portfolio
diversification and supply-exhaustion urgency are both plumbed behind env vars because
the simulator has no way to price them. Prefer that over shipping on theory.

**When a measurement contradicts intuition, the doc records the contradiction** rather
than the flattering reading. Several entries exist specifically to correct earlier
conclusions that turned out to be noise.

Comments explain *why*, at length, especially for anything non-obvious or previously
wrong. Match that density — this codebase is written to be picked up cold.
