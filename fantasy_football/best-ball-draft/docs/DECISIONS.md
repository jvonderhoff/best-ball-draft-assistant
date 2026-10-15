# Decisions and evidence behind CLAUDE.md

`CLAUDE.md` holds the operational rules for this app. This file holds the evidence and
the history behind some of them, moved here verbatim on 2026-10-15 so that a session
loads the rule and opens the story only when it needs it. When the two disagree,
`CLAUDE.md` wins; status and open work stay in `STATUS.md`.

## Why the Analysis app is not deployed (2026-08-29)

**The Analysis app is NOT being deployed, and the news page is why it does not need to
be.** Checked 2026-08-29: `web/app.py` has no authentication of any kind — it has only
ever been bound to localhost — and one of its four POST routes publishes the payload
production scores with. Deploying it means either that button is dead or the deployed app
holds `BBA_API_KEY` behind an unauthenticated endpoint. Add to that props being blocked
from datacenter IPs, SQLite on an ephemeral filesystem, and a cold-start chain (it reads
the pool from THIS app, so `spine.py`'s 15s timeout would fire on ordinary page loads and
silently serve the committed cache). The news page has none of those: read-only, no pool,
no network. So the page moved and the app stayed home.

## Survival calibration against real drafts

**`v2SurvivalProb` is calibrated against REAL drafts, not the harness** — 33 complete
DK boards, 935,163 decisions. It is CONDITIONAL (`S(next)/S(now)`: he is on the board
now, and the old form forgot that) and `V2_ADP_SIGMA_RATIO` is **0.10**, not the 0.30
that was judgement. Calibration error 0.093 → 0.008. The harness cannot price this —
its opponents are ADP bots, so their behaviour *is* the thing being modelled. Re-score
with `tools/calibrate-survival.py`; grow the dataset with `tools/import-new-drafts.sh`.
V2_DESIGN §2.2.

## The scheduled jobs and production: how the claim was narrowed

**That claim was narrowed on 2026-08-29 and the narrowing is the honest part.** It used
to read "never needs `BBA_API_KEY`, so it cannot change production at all". Both jobs now
push the news bundle to `/api/news/upload`, which does need the key — so run by hand from
an interactive shell, they DO write to production. What they still cannot do is change a
score: that endpoint writes `news_bundle` and nothing else, and the bundle feeds no
valuation, no `avail`, and not the payload. Under launchd the push is skipped and the
report SAYS so, rather than reporting a success it did not achieve.

## `_conn()` raised during a real outage (until 2026-08-14)

**The stores' `_conn()` must never raise, and this is load-bearing.** Every `load_*`
documents "None when unreachable", but until 2026-08-14 `psycopg2.connect` sat outside
the try, so that contract held only for the cheap cases (no `DATABASE_URL`, no psycopg2)
— a real outage *raised*. Two safety nets were dead as a result, both measured rather
than argued: the 4-attempt retry in `_hydrate_external_rankings` ran **0 of 4** loads
against an unreachable store (`init_external` raised first and unwound past the loop),
and that retry exists precisely for the Neon cold start after a deploy, where connect
times out; and `/api/stores/status` **500'd** instead of reporting `UNREACHABLE`, so the
one instrument for "did persistence work" broke exactly when persistence was broken.

## The stale bar that was right and still misleading (2026-08-29)

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

## The rankings race (fixed 2026-08-17)

**That 10-minute cache is also what made the rankings race bite.** Fixed 2026-08-17:
init called `loadCustomRankings()` fire-and-forget while `loadPlayers()` rendered
immediately — and the warm-cache branch renders SYNCHRONOUSLY, so the first
recommendations were computed against market ADP with `customRankMap` still empty,
while the star showed blue. Measured at a round-7 pick: the top pick changed and two
players appeared in the visible top 6 that did not belong. `loadV2Projections()
.then(renderRecs)` had always been right; rankings now follow the same pattern.

## Name symmetry, proved by a DK refresh (2026-08-12)

**Don't fix a mismatch by special-casing one side.** `normalize_name` runs on *both*
sides of every lookup, and that symmetry is load-bearing rather than tidy. The
2026-08-12 pool refresh had DK change "Kenneth Gainwell" to "Kenny Gainwell" — the
exact spelling the alias was written to translate *away* from, on a round-8 back —
and nothing broke, because both spellings normalise to the same key either way. The
same refresh brought "A.J. Dillon" → "AJ Dillon" and "Ted Hurst" → "Ted Hurst III",
also absorbed. A one-directional fix would have silently un-matched all three.

## "V2 only matters in big fields" was wrong

**"V2 only matters in big fields" was wrong — do not repeat it.** This file used to say
V2 beat V1 by "+4–9% at small ones", from a §5.2 table that had gone stale by most of §2
and §3 of V2's development. Re-measured 2026-08-16 at five seeds on one pool: **+42.7%
mean at an 18-team final, +48.8% at 45, positive at 5/5 seeds.** The edge does still grow
with field size, but V2 is strongly ahead at every size, and the old number was steering
the user away from the model that helps them most. Corrected in §5.2; read the columns
there by event count, not by size.

## Projection sources: Yahoo, FFToday, props (2026-08-17 to 08-20)

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
