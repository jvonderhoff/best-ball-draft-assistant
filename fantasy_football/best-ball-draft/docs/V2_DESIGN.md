# V2 recommender — design, evidence, and dead ends

Written so this can be picked up cold. The code says *what*; this says *why*, and —
more importantly — **what was already tried and failed**, so it isn't retried.

Format throughout: **DraftKings Best Ball, 20 rounds, 12 teams, full PPR.**
Contests played: $20M Millionaire and $1M Play Action. Both use the same
advancement structure (weeks 1-14 top 2 of 12 → wk15 top 1 → wk16 top 1 → wk17
final); they differ only in final field size.

---

## 1. The core model

Everything is denominated in **points per week**, so a number means the same thing
in round 2 as in round 18. V1's `1000/adp` curve is hyperbolic, which made every
multiplier's real-world aggression depend on where the player was going — a ×1.55
stack bonus moved a player 7 picks at ADP 20 and 71 picks at ADP 200.

Best ball counts the max of your roster at each slot each week, so a player's value
is how much he raises your weekly optimum:

```
gain = E[max(X − Y, 0)]      X = candidate, Y = current slot-holder
```

`Y` is a **random variable** — simulated (240 draws) as the k-th best weekly score
among players you already own at that position, each possibly absent for a bye or
injury. Modelling `Y` as random rather than fixed is what produces correct
diminishing returns, and is what replaced V1's position caps, roster targets and QB
emergency boost.

Lineup slots `QB 1.0 · RB 2.3 · WR 3.6 · TE 1.1` — fractions are each position's
share of the single FLEX spot.

Two phases scored separately: **accumulation 0.40 / spike 0.60**. Spike mode raises
the *bar* by 1 SD rather than inflating the player, which avoids double-counting
variance (an early bug — see §4).

Baseline is **65% VOR** (vs the last startable player, `slots × 12`) **+ 35% VONA**
(vs who survives to your next pick).

---

## 2. Constants, and the evidence for each

| Constant | Value | Basis |
|---|---|---|
| `V2_MARKET_PULL` | **5.0** | Swept. 0.25→−143 pts, 2.5→−41, 4.0→+22, 5.0→+30, 8.0→+36. Set mid-range, not at the sampled max, to avoid fitting the simulator. **The single most important constant.** |
| `V2_CUSTOM_RANK_WEIGHT` | **0.55** | Judgement, not measured. Board comes from a best-ball specialist; Sleeper/ESPN publish generic redraft projections that know nothing about spike weeks or playoff schedule. Effective shares: board ~52%, projections ~41%, ECR ~6%. |
| `V2_TIMING_WEIGHT` | 0.35 | VONA as a tilt on VOR. Pure VONA stockpiles whichever position degrades fastest. |
| `V2_W_ACCUMULATION / PLAYOFF` | **0.40 / 0.60** | Swept 100/0 → 40/60; roster shape barely moved (RB 4.06–4.14 throughout), so this is *not* the allocation lever it looks like. Re-swept across contest sizes (§5.2): best or tied-best at 3 of 4. Pushing toward spike is badly wrong for large finals. |
| `V2_CORRELATION_WEIGHT` | **0.35** | Swept against a real 1,089-team final (§5). Interior maximum, and the curve is steeply asymmetric — see §5.1. |
| `V2_BACKFIELD_DISCOUNT` | 0.80 | Judgement. Retained spike value: backup behind a R1 workhorse 38%, two mid-round committee backs 73%. |
| `V2_VALUE_FIT_REF / FLOOR` | 0.50 / 0.20 | Roster-fit scaling, applied in three places (§3). |
| `V2_BREAKOUT_SD_GAIN` | **0.0 (off)** | Fully plumbed, doesn't earn its place. See §4. |
| `V2_OVER_TARGET_COST` | **0.0 (off)** | Roster-shape forcing. See §4. |

All are overridable via env (`V2_MKT`, `V2_RANKW`, `V2_CORR`, `V2_BREAKOUT`,
`V2_OVERCOST`, `V2_TIMING`, `V2_W_ACC`, `V2_W_PO`) for sweeping.

---

## 3. One idea appearing in three places: roster fit

**Value only counts if the player can actually reach your lineup.** Each of these
was found separately, as a bug, before the pattern was obvious:

1. **Falling ADP value** — a 3rd TE behind an elite one scored +0.93 for sliding 14
   picks, 43% of his total, enough to rank him #1. Reaching stays *unscaled* (over-
   paying is overpaying regardless of fit, and it's what anchors the model to ADP).
2. **Same-backfield spikes** — two backs from one team essentially never spike in
   the same week. Discounts the *spike* term only; accumulation genuinely benefits,
   since over 14 weeks the backup covers absences.
3. **Correlation** — a stack with a player who never starts isn't a stack. One TE
   was scoring 1.93 from game stacks against 0.50 of his own value.

---

## 4. Dead ends — do not retry without new evidence

**Forcing roster shape (3 attempts, all worse).**
The harness reports advance rate by construction, and V2's TE:4 builds do
underperform. But:
- Hard cap `MAX_ROSTER.TE = 3` → worse.
- Cross-positional flex bar (TE must beat your best spare RB/WR, not your 2nd TE —
  theoretically the right model) → advance +35.3% vs +38.7%, TE:4 share went *up*
  to 97.9%. Reverted, dead code removed.
- Soft `V2_OVER_TARGET_COST` → moved shape toward 3-6-8-3 exactly as intended while
  advance fell monotonically (0.0→+31.0%, 0.25→+24.4%, 0.50→+17.6%).

**The construction table is correlation, not causation.** V2 ends with 4 TEs when a
draft has *already* gone badly and the board is barren — the 4th TE is a symptom.
Forcing the shape just makes a worse pick at that moment.

**Breakout modelling from expert disagreement.** `rank_std` (FantasyPros, ~74
experts) is plumbed end to end and normalised by rank. Widens the spike term only.
Swept against the *upgraded* simulator (which does model role change): 0.0→+25.4%,
0.5→+18.2%, 0.8→+17.9%, 1.3→+20.5%. Disagreement does raise breakout odds, but not
enough to pay for the projection quality given up. Left off, behind `V2_BREAKOUT`.

**Need-scaled replacement horizon.** Scaling the VONA horizon by bodies still needed
silently handed WR (largest target) the lowest replacement level and highest VONA at
every pick. Slot attribution showed +71 pts at WR against −82 at RB and −28 at QB.
Replaced with one-step VONA, which is the correct pairwise-swap criterion.

---

## 5. Harness limitations — read before trusting any number

`tools/compare-models.js`. Two truth scenarios; **always read `market` (neutral)** —
`proj` grades V2 against its own answer key and is an upper bound only.

- **Week 17 is now a real final.** ~1,089 teams, one common realisation, top-heavy
  payouts. Two changes made it work:
  - *Weekly scores are drawn once per player and shared by every roster that owns
    him.* Previously each roster diced its own copy, so no two teams could be on the
    same chalk and leverage did not exist as a concept. This also made common random
    numbers real — before, V1 and V2 diverged into different weather the moment they
    drafted different players, and "identical luck" held only at the seed.
  - *The field is 1,088 bot rosters **sampled** by their odds of surviving the same
    three phases* (`F^11` to win a knockout week, `F^11 + 11·F^10·(1−F)` for top-2 of
    12), not the best 1,088. A field with the luck squeezed out is far too strong,
    and would understate exactly the high-variance strategies this is meant to judge.
- **The 11 opponents draft to noisy ADP — and so does the entire final field.** This
  is now the load-bearing limitation, and it got *worse*, not better: bot softness
  used to cost you a 12-team pod, and now it sets the whole 1,089-team room. Absolute
  EV is wildly inflated (a good roster wins a bot final far too often). **Read the
  delta, never the level.** No leverage or uniqueness modelling either.
- **How much stacking can pay is capped by `TEAM_FACTOR_CV = 0.35` and
  `GAME_FACTOR_CV = 0.22`** in the simulator's own weather model. If real team-weeks
  have fatter tails than lognormal at those CVs, the harness still understates
  correlation — and no amount of field-size fixing touches that. Unlike the old gap
  this is one tunable pair, so it can be stress-tested rather than argued about.
- **Bots have a lineup floor** (`BOT_MINIMUMS`, 1/2/3/1). Pure-ADP bots would finish
  drafts with zero quarterbacks — QB median ADP is ~116 — and score a structural zero
  at that slot every week. Barely matters at 12 teams; it completely invalidated the
  3- and 6-seat numbers in `tools/sitngo-ev.js` before it was fixed.
- **The truth model now includes role change** (breakouts/busts, `SIM_BREAKOUT` /
  `SIM_BUST`, ~2.3% for picks 1-60 rising to ~7.6% past 180). Adding it cut V2's
  measured edge from ~+47% to ~+24% — **every number quoted before that was
  flattered.** V1 falls further than V2 when roles change, which favours V2.
- **Jackpot EV needs thousands of finalists.** At a few hundred, one simulated $1M
  season is worth ~$116/entry and dominates everything. An early version reported
  "+882% EV" — that was one lucky team. Read the **jackpot-capped** row unless
  finalists number in the thousands.

### Current standing (150 drafts × 300 seasons, 45k team-seasons, neutral truth)

| Metric | V1 | V2 | Δ |
|---|---|---|---|
| Top-2, weeks 1-14 | 26.88% | 30.84% | +14.7% |
| Reach the final | 1.68% | 1.81% | +7.8% |
| Top 15 of the final | 0.1467% | 0.1733% | +18.2% |
| **EV per entry (jackpot capped)** | $100.63 | **$134.24** | **+33.4%** |
| EV per entry (uncapped) | $232.74 | $322.96 | +38.8% |

Finalists: V1 757 / V2 816. Finals won: 7 / 10.

Every number here is smaller than the pre-final-field version, and the dollar levels
are an order of magnitude larger and meaningless in absolute terms. Both follow from
scoring week 17 honestly against a soft field; **prior EV figures are not
comparable** and were not merely optimistic, they measured a different tournament.

### 5.1 The correlation sweep this was built to run

`V2_CORR` against the real final, same seeds, 45k team-seasons each. All figures are
V2 relative to an unchanged V1.

| `V2_CORR` | Advance (wk 1-14) | Reach final | Top 15 of final | EV capped | Stacked pass-catchers |
|---|---|---|---|---|---|
| 0.00 | +20.5% | −1.7% | −24.2% | $82.85 | 0.98 |
| 0.20 | **+22.8%** | +1.5% | +1.5% | $108.46 | 1.72 |
| **0.35** | +14.7% | **+7.8%** | **+18.2%** | **$134.24** | 2.45 |
| 0.70 | +1.4% | −13.9% | −15.2% | $102.23 | 4.15 |
| 1.20 | −31.0% | −60.9% | −66.7% | $49.16 | 5.60 |

**0.35 is an interior maximum on the money metric, and the old verdict survived
contact with a real field.** The shape is the interesting part: advance rate peaks at
0.20 while every knockout metric peaks at 0.35. That is correlation doing exactly
what it is supposed to — trading accumulation for knockout-week upside — and the old
harness could not see it, because it had no knockout week worth winning.

Going up is far more costly than going down. At 1.20, V2's finalists finish *worse in
the final itself* (top 32.8% vs 26.3%) and score 4.9 fewer week-17 points: reaching
for a stack costs more roster quality than the correlation buys back, in the exact
week correlation is supposed to pay. The advance-rate collapse is a symptom, not the
mechanism.

Two things keep this from being fully closed. Top-15 counts at the peak are 78 events
against 67 and 56 for its neighbours — the ordering is consistent across three
independent metrics but each is thin. And **V1 carries 4.25 stacked pass-catchers to
V2's 2.45 and finishes the final slightly worse** (26.31% vs 24.53%), which says stack
count is not what separates these two models under this simulator. Receiver depth
(§5, slot diagnostic) still is.

**Where the edge comes from** (per-slot points, `tools/slot-diagnostic.js`):
WR2 +26.7, WR3 +25.8, TE +24.3, WR1 +22.6, FLEX +11.7; QB −3.7, RB1 −3.5, RB2 −7.3.
Nearly all of it is receiver **depth** (9.0 WR vs 8.2), not better stars.

### 5.2 Does the right build depend on which contest you enter?

Every DK best-ball tournament on this structure sends **1 team in 864** to the final
(12 × 6 × 12 × 12), so the path is identical everywhere and only the destination
changes size: `finalists ≈ entries / 864`. The $50K Tuddy's final is ~10 teams; the
Millionaire's is ~1,088. Winning the first needs a ~90th-percentile week, the second
~99.9th. `tools/compare-models.js` scores each finalist against nested random subsets
of the same sampled field, so one run prices every contest size at once.

V2 EV in ppm of the final's prize pool (V1 identical across rows — a CRN check):

| `V2_CORR` | 10 | 45 | 229 | 1,089 |
|---|---|---|---|---|
| 0.00 | 4,445 | 1,371 | 357 | 74 |
| 0.20 | 4,208 | 1,434 | 452 | 123 |
| **0.35** | **4,896** | **1,709** | **531** | **178** |
| 0.70 | 3,785 | 1,377 | 399 | 130 |
| *V1* | *4,538* | *1,649* | *488* | *127* |

**The optimum does not move — 0.35 wins at every size.** There is no per-contest
correlation setting to tune, which is a genuinely useful negative result.

What scales is the payoff for getting it right. Going 0.00 → 0.35 is worth +10% at a
10-team final, +25% at 45, +49% at 229 and **+141%** at 1,088. And V2's edge over V1
scales the same way: +7.9% / +3.6% / +8.8% / **+40%**. Against a ~10-team final the
two models are near-equivalent — you need a good roster, not an extreme week. **V2's
whole thesis only cashes in large-field contests.**

The same sweep on `V2_W_ACC / V2_W_PO` — the literal season-vs-big-week dial — does
show a shift, in the opposite direction to the obvious guess:

| `ACC/PO` | 10 | 18 | 45 | 229 | 458 | 1,089 |
|---|---|---|---|---|---|---|
| 0.60 / 0.40 | 4,346 | 2,737 | 1,469 | 480 | 303 | 176 |
| **0.40 / 0.60** | 4,896 | **3,208** | **1,709** | **531** | **333** | **178** |
| 0.25 / 0.75 | 4,896 | 3,132 | 1,678 | 478 | 263 | 117 |
| 0.10 / 0.90 | **5,085** | 3,162 | 1,610 | 406 | 219 | 94 |

**Keep 0.40/0.60 — best at five of six sizes.** Only the 10-team column prefers more
spike, and it does not survive at 18, so treat it as noise rather than a small-final
effect. There is no per-contest tuning to do on either upside dial.

The gradient that *is* real runs the other way: 0.10/0.90 reaches the final more often
than any other setting (1.85% vs 1.60%) and still finishes **below V1** inside a
1,088-team one. Spike weight buys the two single-week knockouts that get you there;
what it trades away is the roster quality that produces a 99.9th-percentile week once
you arrive. Small finals forgive that because being one of ten is already a ~10% shot;
large ones do not. **Pushing toward spike is badly wrong for large-field contests.**

Note also that advance rate through weeks 1-14 *peaks* at 0.25/0.75 (32.2% vs 29.9%
at the accumulation-heavy setting). Spike mode raises the bar by 1 SD, which selects
ceiling, and best ball takes the max every week — so the two phases are far less
opposed than the constant names imply. Roster shape barely moves across all four
(RB 4.53-4.65, WR 8.99-9.03), consistent with §2.

Caveats: the 1,089 column is thin (~64% of its EV is 10 outright wins, so 178 vs 123
is ~1.2 SE); the smaller columns are well resolved and rank 0.35 first independently.
The metric prices only the final's pool, excluding the wk15/16 consolations where
accumulation matters more. Payouts inside each final are modelled as a power law
(`--final-alpha`, `--final-paid`) because DK does not publish tables for the smaller
contests — direction is trustworthy, exact crossovers are not.

---

## 6. Data pipeline

| Source | Role | Notes |
|---|---|---|
| DraftKings | player pool, ADP | `fetch_players(force_refresh=True)`. **Blocks Render datacenter IPs for props** — verified 131 players locally, 403 from prod within the same minute. |
| Sleeper | projections (`pts_ppr`) | full PPR |
| ESPN | projections (`leaguedefaults/3`) | full PPR. **Only free source projecting receptions.** |
| FantasyPros ECR | rank blend + `rank_std` | Partners API. **Season projections are paywalled** to a 10-per-position teaser — the old scraper returned 40 players and never errored. |
| DK / Underdog props | component-level market correction | **Not a projection source** — neither book posts season receptions, so prop-implied totals understate pass-catchers by ~25-35% while RB/QB are near-complete. Corrections are applied per component; missing markets contribute exactly zero. |
| Your rankings | 0.55 weight | `tools/sync-ranks.py` pulls from prod. |

**DK scoring caveat (known, unfixed):** DK scores interceptions and fumbles at −1;
the sources use standard PPR's −2. Makes QBs ~0.9 ppg understated. Uniform across
QBs so relative order barely moves — judged not worth fixing.

**Name matching:** `app/data/names.py` canonicalises nicknames. DK says "Nick
Singleton"/"Kenneth Gainwell"; all three projection sources say
"Nicholas"/"Kenny". Unmatched players fall through to an ADP-implied estimate and
are scored as generic bodies — Gainwell was a round-8 pick valued on nothing.

---

## 7. Deployment

Render's filesystem is **ephemeral** — SQLite is wiped on every deploy and idle
spin-down. Anything that must survive lives in Postgres (`DATABASE_URL`):
`rankings_store`, `drafts_store`, `projections_store` (ESPN + props),
`kv_store_external` (Yahoo OAuth tokens).

Check `/api/stores/status` — it reads Postgres directly, unlike every other
endpoint. A warm instance looks healthy whether persistence works or not.

- Props for DK must be **uploaded** from a residential connection:
  `python3 tools/push-props.py` → `POST /api/props/upload` (BBA_API_KEY).
- `asset()` cache-busts static files by mtime. Hand-maintained `?v=N` caused
  browsers to run scoring code from before several fixes, silently.
- Flask runs `--no-reload`, so **restart the server after editing a template**.

**Recurring failure class:** bugs whose only execution path is a cold start
(`_seed_players_if_empty`, external-store creation). They cannot fail locally
because a dev DB always has rows. Test by pointing `DB_PATH` at a throwaway file
and running `init_db()` from scratch.

---

## 8. Board reading (2026 season)

From `tools/` analysis of the current board — usable supply by pick:

| Position | Usable players left after pick… | Market's median ADP (top 36) |
|---|---|---|
| **RB** (≥8 ppg) | 12 @ 72 · 5 @ 96 · **0 @ 144** | 44 |
| **QB** (≥14 ppg) | 18 @ 72 · 5 @ 120 · **1 @ 144** | 116 |
| **WR** (≥8 ppg) | 21 @ 72 · 6 @ 120 · **0 @ 168** | 37 |
| **TE** (≥7 ppg) | 23 @ 72 · **15 @ 120** · 5 @ 168 | 149 |

Supply exhausts **RB → QB → WR → TE**, roughly the inverse of how the market prices
them. QB is nearly flat QB2→QB24 (18.5→14.8 ppg) then falls off a cliff to 9.6 by
QB30 — so waiting on QB is right, but not past ~pick 130.

`v2PositionalRun` reads *this specific room* against ADP and shifts survival
accordingly (clamped 0.70–1.45). Improved advance rate +31.0% → +35.4%.

---

## 9. Open questions, highest value first

1. **Sharpen the field.** *(Was: "make the final field size real" — done, §5/§5.1.
   It did not move the correlation answer.)* The final is now the right size and
   shape but is drafted by ADP bots, which is what every remaining inflated number
   traces back to. The concrete version: draft some fraction of the field with V1/V2
   themselves rather than bots. Costed at ~1.2s per 12-seat model pod, so a fully
   sharp 1,088-team field is ~110s of one-time build — affordable, just not free.
   **Best remaining guess at where the harness still lies to us.**
2. **Stress-test the weather model.** `TEAM_FACTOR_CV` / `GAME_FACTOR_CV` set the
   ceiling on what stacking can possibly be worth, and they were assumed, not
   measured. Re-run the §5.1 sweep at higher CVs: if the optimum moves up, the
   constant was fitted to the simulator's tails rather than to football.
3. **Yahoo** — blocked on app registration at developer.yahoo.com needing Fantasy
   Sports read permission. Error is `"This application is not authorized to perform
   this action"`, which is app-level. Code side (scope, token persistence, Python
   3.9 compat) is done.
4. **Flex modelling** — TE gets a fixed 10% flex share against a 2nd-best-TE bar
   rather than a true cross-positional contest. Known approximation; the obvious fix
   measured *worse* (§4).
5. **V2 is not the default.** `/recommend` shows V1 and V2 side by side; V1 still
   drives nothing-changed behaviour. Swapping outright is premature — three real
   errors in V2 were caught by eye in its first day (stale FA team, name mismatch,
   inflated stack).
