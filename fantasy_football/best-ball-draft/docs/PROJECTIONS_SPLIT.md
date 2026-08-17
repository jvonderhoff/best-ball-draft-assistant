# Splitting projections out of the draft app

**Status: DONE through step 3, 2026-08-16.** Written 2026-08-14 as a design note;
the analysis half moved on 2026-08-16. Records the contract, the seam and the
failure modes, so the decision does not have to be re-derived later.

## What is true now

| | where it lives |
|---|---|
| Analysis UI | `projections/web` — `cli.py analysis-serve`, port 8100 |
| `analysis.py`, the source fetchers, the derived metrics | `projections/analysis/` |
| The six-field payload | built in `projections/analysis/payload.py`, POSTed to the draft app |
| DK pool, rankings board, V1/V2, drafts | unchanged, still here |
| `app/analysis.py` in THIS repo | **frozen fallback**, scheduled for deletion (step 4 below) |

The draft app's `/analysis` now returns 410 with a pointer. `/api/analysis` still
works, serving the frozen build, because `analysis-verify` compares against it.

**Both paths were verified to agree before the page moved**: 428 players, exact
agreement on all six model fields plus `ceiling`, `proj_dk` and `sources`
(2026-08-16). Re-run it with `cli.py analysis-verify` in the projections app.

**The one trap that comparison hit, and it is the familiar one.** The first run
reported 345 `disagreement` mismatches and a one-player pool gap — all of it the
draft app serving a 6h-cached build describing a 427-player pool while the
projections app built fresh against 428. Nothing was wrong with either. `verify.py`
now forces `?refresh=1` and builds both arms in one run, for the same reason the
harness rule says to record the player count with any number you plan to compare.

### The order it happened in

Steps 1-3 of §6 shipped, then the UI moved. **Step 4 — deleting `app/analysis.py`
from this repo — has NOT happened**, deliberately: it is the one-way door, and the
fallback is what makes the split reversible while the projections app is still young.
Delete it once `analysis-verify` has been clean across a few real publishes, and take
`/api/analysis`, the analysis-only fetchers and this repo's Yahoo OAuth routes with
it.

This file covers only the **contract between the two apps**. See
`PROJECTIONS_APP_ARCHITECTURE.md` for the new app's own internals.

The goal is a **lite draft app**: DK pool, rankings board, recommender, drafts. Every
data source, every scraper and every derived metric moves out.

---

## 1. The contract is six fields

This is the finding that makes the split cheap, and it was measured against the code
rather than assumed.

**V1 reads exactly one field off a player: `p.adp`.** The primary `/recommend` column
depends on nothing but the DK pool. It does not consume projections at all.

**V2 reads exactly six fields off a projection object:**

| field | what it is | consumed by |
|---|---|---|
| `ppg` | per-game mean, DK-adjusted | the mean of every valuation |
| `sd` | weekly standard deviation | ceiling, spike model, **and the per-position CV** |
| `sources` | how many projection sources agreed | ECR blend weight (§2) |
| `avail` | P(active in a non-bye week) | availability discount |
| `disagreement` | expert spread, normalised to draft position | uncertainty |
| `rec_share` | share of points earned receiving | QB↔RB correlation |

Everything else `analysis.py` computes — all 36+ display columns, the props, the
opportunity metrics added 2026-08-14 — is either display or an input that has already
been folded into those six by the time the recommender sees it.

**`sd` gained a second, invisible job on 2026-08-15 — read this before reimplementing
it.** The recommender now recovers the position's scoring CV as `proj.sd / proj.ppg`
and uses it to rescale sd after blending (V2_DESIGN §4, "sd now follows the blend"). It
does that specifically to avoid hardcoding a copy of `POS_SCORING_CV` that would drift
from the producer. The consequence for this split is a coupling that is easy to miss:

- The producer must keep emitting `sd = ppg × POS_SCORING_CV[pos]`, a **clean per-position
  constant ratio**. Any per-player volatility model — a genuinely reasonable thing for a
  projections app to want — silently redefines the recommender's CV, and therefore every
  ceiling and every correlation term, with no error anywhere.
- If the new app ever *should* emit per-player sd, that is fine, but the recommender has
  to stop deriving `cv` from the ratio first, and the two changes have to ship together.
- The ratio is also the invariant to assert on: `ceiling / mean` must equal
  `1 + 1.2816 × CV[pos]` for every projected player. Verified in the browser at
  RB 1.741–1.746, WR 1.893–1.899, TE 1.946–1.951, QB 1.485–1.490. A cheap post-publish
  check, and the one that would catch this.

Note also that `sd` gates every correlation term via `Math.min(sdMe, partner._eff.sd)`,
so getting it wrong does not just move ceilings — it moves stack values too.

Delivery is already one endpoint: **`GET /api/projections-v2`**, called by
`templates/recommend.html` and `templates/sandbox.html`. It returns
`{ok, players[], count, generated_at, stale}` and does nothing but serve what
`app/projections.py::get_projections()` built.

**So the split is: that endpoint stops computing and starts serving stored data.**

**Done 2026-08-16.** It now serves the pushed payload and falls back to the local
build, reporting which in `source`, with `age_hours`, `schema_version` and
`published_by` alongside. `?source=local` forces the fallback, which is what
`analysis-verify` compares against.

The preference is **deterministic**: a pushed payload wins however old it is. The
tempting alternative — fall back to the local build once the push goes stale — would
have the model silently change which code computed its inputs based on a clock, and
that is the exact bug shape this file is about. Serve the stale push and say so.

`sd`'s second job survived the move intact and is asserted on every build:
`payload.validate()` refuses a payload where `sd != ppg × POS_SCORING_CV[pos]` or
`ceiling != ppg + 1.2816 × sd`. Note it checks in **points, not as the ceiling/mean
ratio quoted above** — both fields are rounded to 2dp before publishing, so at
ppg ~0.3 that rounding is over 1% and the ratio form fires on players who are
perfectly correct. (It did, on 18 of them, the first time it ran.) Same invariant,
rounding-safe instrument; the 1.741–1.746 spread recorded above is this rounding.

---

## 2. What moves, what stays

**Moves to the projections app**

- `app/analysis.py` — every source fetch and every derived metric
- Sleeper / ESPN / FantasyPros / Yahoo fetchers
- Prop scraping (`tools/push-props.py`, `app/data/betting_fetcher.py`)
- `templates/analysis.html`
- nflfastR, if it happens — see §5

**Stays in the draft app**

- DK player pool and ADP
- **The custom rankings board.** It is the user's opinion, not derived data, and it is
  `V2_CUSTOM_RANK_WEIGHT` 0.55 of every valuation. Moving it would put the largest
  single input to the model behind a network hop for no benefit.
- V1 / V2, drafts, history, live draft UI
- `app/data/names.py` — still needed for the rankings board and the DK pool

---

## 3. The seam

Copy the pattern that already exists for props, because it already solves the same
problem (compute where the data is reachable, push the result in):

```
projections app  --POST /api/projections/upload-->  draft app  -->  Postgres
                     X-Api-Key: $BBA_API_KEY                    projections_store
```

`tools/push-props.py` + `POST /api/props/upload` in `app/app.py` is the working
template, down to the auth header. `projections_store` already exists and is already
reported by `/api/stores/status`.

**Key on DK `player_id`, not on name.** The payload already does
(`app/projections.py` emits `'id': p.get('player_id')`) and this must not regress.
Today `names.py` normalises both sides of every lookup inside one process; after a
split, name-keyed matching becomes a *cross-app* silent-failure surface, and an
unmatched player does not error — he falls through to an ADP-implied estimate and is
scored as a generic body. Note that the existing external store is name-keyed for
ESPN and props (`load_espn()` returns `{player_name: …}`); the projection payload
should not follow it.

**The one real coupling this creates:** the projections app needs the DK pool to key
against. Either it fetches DK itself (it can — it will be running somewhere with a
residential connection anyway, which is the whole reason props are pushed rather than
fetched), or the draft app exposes its pool. Prefer the former; it keeps the
dependency arrow pointing one way.

**Resolved 2026-08-16: the second option, and the reasoning changed.**
`projections/analysis/spine.py` reads `GET /api/players`, falling back to the
committed `player_cache.json`. Fetching DK independently would mean a second copy of
`api_fetcher` — a DK session, the cookie sync, the ECR enrichment and the playoff
schedule join, all of which the live-draft features need and none of which should
exist twice. More to the point, `/api/players` is *the pool the recommender will
score against*, and a projection keyed to a player the draft app does not have is a
projection nobody reads. Agreeing with the consumer beats independence here.

The custom rankings board is read the same way, from `GET /api/rankings`, for the
"My Rank" column only. It stays the draft app's, per §2.

Both reads are also why the drift §3 warned about is now *visible* rather than
theoretical: on 2026-08-16 the live pool held 428 players and the committed cache
427, and the analysis page's status line says which one it is looking at.

---

## 4. Failure modes, and the one that matters

**A stale payload must fail LOUDLY. This is the whole risk of the split.**

The draft app needs a committed bootstrap payload so a cold Render boot serves
something — but that is exactly the shape of the bug that hid a two-month-old
rankings board: `rankings_seed.json` is a *committed* file that silently became the
live board when a boot could not reach Postgres, at 0.55 of every valuation, with no
error and plausible numbers. A projections app that quietly stops pushing reproduces
that failure precisely, one layer down.

So:

- ~~`/api/stores/status` must report a `projections_hydrated` alongside
  `rankings_hydrated` — is the served payload the pushed one, or the bootstrap?~~
  **Built 2026-08-14, before the split rather than after** — deliberately, while
  both halves are still in one app and a wrong answer is verifiable end to end.
  Per dataset (`espn`/`props`), mirrored on `/api/projections/meta`, with the
  boot-time retry that the rankings hydrate turned out never to have been running
  (see CLAUDE.md on `_conn()`). When the split happens this becomes the check on
  the *pushed payload* rather than on two Postgres tables; the shape carries over.
- **`stale` gained a second meaning, and two templates already read it.** On the
  local fallback it still means "the rebuild failed, serving cache"; on a pushed
  payload it means the projections app has not published in 48h. `recommend.html`
  and `sandbox.html` both turn it into a banner, and the sandbox's hardcoded text
  said "(rebuild failed, serving cache)" — the wrong cause for the new case. Both
  now take the server's `warning` string and fall back to their old wording.

  `resolve()` deliberately sets **no** warning for "serving local because nothing
  was pushed". That is a normal state — a fresh install and production before the
  first publish both look exactly like it — and a banner that is always on during a
  live draft is one nobody reads. The app also cannot distinguish "nobody has
  published yet" from "publishing stopped": both are just the absence of a payload.
  The case it CAN identify, a pushed payload gone stale, is the one that warns.
  Which path is serving is always in `source`.

- ~~Surface `generated_at` age in the UI.~~ **Done 2026-08-16.** The Analysis page
  carries a bar reading "Draft app is scoring on: your payload · 3h old" / "STALE"
  / "its own fallback build (nothing published)", read from the draft app rather
  than inferred from whether a publish succeeded here — a push that landed on an
  instance whose Postgres was unreachable is gone after the next deploy, and only
  the draft app knows that. Stale is 48h, which is judgement, not measurement.
  Also on `/api/projections/meta` (`serving`, `pushed`) and `/api/stores/status`.
- Prefer a hard refusal over a quiet fallback where a wrong answer is worse than no
  answer, as the rankings save path already does (409 when unhydrated).
  **Applied at the boundary, not at serve time:** `/api/projections/upload` refuses
  an unknown schema major (409) and a payload with unkeyed players (400), and
  `payload.validate()` refuses to send one where the sd invariant is broken, where
  fewer than half the pool has a ppg, or where every scored player has
  `sources <= 1` — that last one because a collapse to a single feed doubles the
  ECR blend weight silently. Serving is deliberately NOT a refusal: mid-draft, a
  stale payload clearly labelled stale beats no projections at all.

See CLAUDE.md: *prefer failing loudly and recording whether a thing actually happened
over inferring it from a count that looks right.* Two separate incidents in this
codebase have now been this exact shape, plus the deploy check in this same session.

**Second failure mode: silent meaning changes.** If the projections app redefines a
field, the draft app cannot tell — the numbers stay plausible. Put a
`schema_version` in the payload and refuse an unknown major version.

---

## 5. Extensibility — "can it feed any data the recommender needs?"

Yes, and the right discipline is already in the code.

New fields are additive because V2 reads optional inputs as *unknown*, not zero:

```js
// recommender-v2.js
recShare = proj.rec_share ?? null;   // absent on a cache built before this field
```

with a comment saying exactly why null must not be read as "a back who never catches
the ball". Keep that and any future field — real aDOT, WOPR, snap share — is a
one-line read on the V2 side and an added key on the projections side, with old
payloads still valid.

**The constraint is not the transport, it is the harness.** A new input is only worth
shipping if `tools/compare-models.js` can price it, and several already-plumbed
features sit at 0.0 precisely because it cannot (§4, §9). Being able to *deliver*
snap share to the recommender does not establish that the recommender should use it.
Feed display columns freely; feed the model only what has been measured.

---

## 6. If it happens, do it in this order

1. ~~Add `projections_hydrated` + staleness reporting **first**~~ — **done 2026-08-14.**
2. ~~Add `POST /api/projections/upload` and have it write `projections_store`. Keep
   `get_projections()` computing as it does.~~ **Done 2026-08-16.** Writes the new
   `projections_payload` table (one row, replaced wholesale — a published payload is
   one atomic statement about the whole pool, and merging pushes would leave a single
   `generated_at` describing rows from two different moments). Hydrated into a local
   mirror at boot, because Render's filesystem does not survive a deploy and without
   it a perfectly good payload would sit in Postgres while the instance served the
   fallback.
3. ~~Switch `/api/projections-v2` to read the store, falling back to the local build.
   Both paths live — verify they agree on the six fields, player by player.~~
   **Done 2026-08-16**, verified at 428 players with exact agreement.
4. **NOT DONE — the one-way door.** Move `analysis.py` out and delete the local
   build. The move happened; the deletion has not. What still has to go when it does:
   `app/analysis.py`, `/api/analysis`, the analysis-only fetchers
   (`espn_fetcher`, `fantasypros_fetcher`, `betting_fetcher`, `underdog_fetcher`,
   `yahoo_fetcher`), this repo's Yahoo OAuth routes, and the four analysis tables in
   `database.py`. Keep `fantasypros_ecr_fetcher` — it enriches the DK pool, which
   stays.

Steps 2 and 3 are reversible and leave the app working. Step 4 is the one-way door.

**Do not do step 4 until the projections app has published for real a few times and
`analysis-verify` has stayed clean.** The fallback costs a frozen file; removing it
early costs the only thing that makes a bad publish survivable.
