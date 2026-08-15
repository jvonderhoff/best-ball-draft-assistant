# Splitting projections out of the draft app

**Status: design note, nothing built.** Written 2026-08-14 while deciding whether
analysis and projections should become their own app. Records the contract, the seam
and the failure modes, so the decision does not have to be re-derived later.

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
| `sd` | weekly standard deviation | ceiling, spike model |
| `sources` | how many projection sources agreed | ECR blend weight (§2) |
| `avail` | P(active in a non-bye week) | availability discount |
| `disagreement` | expert spread, normalised to draft position | uncertainty |
| `rec_share` | share of points earned receiving | QB↔RB correlation |

Everything else `analysis.py` computes — all 36+ display columns, the props, the
opportunity metrics added 2026-08-14 — is either display or an input that has already
been folded into those six by the time the recommender sees it.

Delivery is already one endpoint: **`GET /api/projections-v2`**, called by
`templates/recommend.html` and `templates/sandbox.html`. It returns
`{ok, players[], count, generated_at, stale}` and does nothing but serve what
`app/projections.py::get_projections()` built.

**So the split is: that endpoint stops computing and starts serving stored data.**

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
- Surface `generated_at` age in the UI. `generated_at` and `stale` already exist in
  the payload and are already returned by `/api/projections-v2`; nothing reads them.
- Prefer a hard refusal over a quiet fallback where a wrong answer is worse than no
  answer, as the rankings save path already does (409 when unhydrated).

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

1. Add `projections_hydrated` + staleness reporting **first**, while everything is
   still one app and a mistake is visible. §4 is the risk; retrofitting the guard
   after the split means running blind through the migration.
2. Add `POST /api/projections/upload` and have it write `projections_store`. Keep
   `get_projections()` computing as it does.
3. Switch `/api/projections-v2` to read the store, falling back to the local build.
   Both paths live — verify they agree on the six fields, player by player.
4. Only then move `analysis.py` out and delete the local build.

Steps 2 and 3 are reversible and leave the app working. Step 4 is the one-way door.
