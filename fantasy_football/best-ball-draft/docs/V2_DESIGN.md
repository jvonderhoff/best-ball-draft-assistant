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
| `V2_DIVERSITY_WEIGHT` | **1.0** | Portfolio diversification cost, §3.1. Sized against board spread, not guessed. **Benefit is unmeasurable in this harness** — see §9. |
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

### 3.1 Portfolio diversification

Recovered from `origin/reorganize/fantasy-football-folder`, where 29 commits sat
unmerged since June. Everything else on that branch had been reimplemented on master;
this had not. The backend survived (`/api/drafts/exposure`, `get_exposure()`,
`history.html`) — only the two places that *used* it were lost.

Entering the same contest twenty times with the same four players is not twenty bets,
it is one bet at twenty times stake. `exposure_rate` = your own picks only
(`dk_import.py` filters the DK board to them), over saved drafts.

**A points-per-week cost, not the old multiplier.** V1's version was
`val *= 1 - rate * strength`, which moves a player a different distance depending on
where he is going — the same defect §1 calls out in V1's stack bonus. A flat ppw cost
means the same thing in round 2 and round 18.

Three guards, each earning its place:

| Guard | Value | Why |
|---|---|---|
| Floor | 0.40 | Every drafter is heavy on somebody. Taxing a 30% share is a tax on having opinions. |
| Confidence ramp | `n/(n+5)` | After one draft every player you took reads 100%. Damps to 17% of full at 1 draft, 50% at 5, 80% at 20. Not hypothetical — the live DB had exactly one saved draft when this was wired. |
| Never scales correlation | — | The cost hits standalone value only, so a stack partner keeps his full bonus and merely has to clear the cost. |

Sized against the actual board rather than picked. Spots the top candidate drops at
100% exposure over 20 drafts: **pick 25 → 1, pick 60 → 2, pick 120 → 5, pick 200 → 1**;
at a realistic 60% it is 0-1 everywhere. The ppw denomination does the work — early
rounds have ~1 ppw between adjacent candidates so an elite player you are heavy on is
still taken, round 10 has ~0.05 and diversifies freely. That is the right place for
the effect to live. 2.0 was tested and moves 8 spots at pick 120, which is no longer
a nudge.

Stacking survives, measured: owning Lamar Jackson with Mark Andrews at 100% exposure,
Andrews falls rank 7 → 13. The same player at the same exposure *without* his QB
rostered falls 24 → 33. The stack keeps him 20 spots higher and moves him less.

**What is NOT established.** The harness simulates independent drafts, so
diversification has no upside in it at all — it can only cost. Every number above is
a price, not a return. See §9.

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

**The construction table cannot settle roster-count questions — it is too noisy.**
Buckets hold 21-58 distinct rosters, and season draws within a bucket are correlated
because they share those rosters. Turning injuries on, with the *same* rosters and
seeds, moved the two 5-RB builds in opposite directions: 2-5-9-4 fell 34.0% → 28.9%
advance while 3-5-8-4 rose 12.0% → 28.4%. Both cannot be an injury effect. Anything
read off this table at bucket level is a draw from that noise. Settling 4-vs-5 RB
needs a controlled test — same seed, force one extra RB, identical season draws.

**Settled by controlled test instead** (`tools/rb-depth.js`, 250 drafts x 250
seasons). Each seed is played three times — baseline, RB floor 5, RB floor 6 — with
the same bots, board, truth and *the same weekly player scores*, so the arms differ
only in roster composition and the comparison is paired.

| Arm | avg RB | advance | Δ paired | reach final | Δ paired |
|---|---|---|---|---|---|
| baseline | 4.65 | 30.20% | — | 1.483% | — |
| RB ≥ 5 | 5.01 | 29.89% | **−0.31 ±1.89pp** | 1.328% | −0.155 ±0.197pp |
| RB ≥ 6 | 6.00 | 25.44% | **−4.77 ±1.83pp** | 1.029% | −0.454 ±0.194pp |

**A 5th back is free; a 6th costs you.** −0.31pp against ±1.89 is nothing (and it is
+0.89 ±1.75 with injuries off — a coin flip either way), so a drafter who prefers
five is not paying for the preference. Six is −4.77pp at 2.6 SE, which is real.

**Injuries made extra backs slightly worse, not better** (RB≥5: +0.89 → −0.31;
RB≥6: −2.86 → −4.77), though that shift is itself inside noise. The slot maths is
why: WR starts **3.6** weekly against RB's **2.3**, so thinning receivers to thicken
backs increases fragility where it costs most. RBs do get hurt more (avail 0.82 vs
0.86) and it is not enough to overcome starting 1.3 more of the other.

Note reach-final is negative in **all four** floor cells (−0.155, −0.454, −0.187,
−0.354). Individually 1-2.3 SE, but four consistent negatives is a pattern, and
reach-final is the metric that pays. Read a 5th back as "free or very nearly", not
"free". Caveat: this is the policy *commit to N by round 7*; a floor from round 12
buys different and worse players (`--from-round`, untested).

Forcing a single round does nothing — the model rebalances and lands on the same
shape (an RB forced at round 8 gave 3-5-9-3 against a 2-5-9-4 baseline, the same
five backs). The target has to be forced, not a pick.

**Waiting does not buy cheap backs.** Forcing an RB-light start (no RB through R6,
n=250) and sweeping the target: no floor 24.36% advance, RB≥4 +1.36 ±1.61, RB≥5
−1.00 ±1.53, RB≥6 −3.02 ±1.30, RB≥7 **−7.12 ±1.46**. Monotonically worse, and the
light start itself costs ~5.5pp against unrestricted V2. So extra backs are never a
gain — the conditional gradient runs from bad to *very* bad, not from good to bad.
An earlier read of the naturally-occurring light bucket (n=14) suggested the
opposite and was noise.

**QB is the mirror image, and the board says why.** Same rig, `--pos QB`:

| Arm | avg QB | Δ advance (normal) | Δ advance (QB-light) |
|---|---|---|---|
| QB ≥ 2 | 2.38 | +0.79 ±1.06 | +0.77 ±1.40 |
| **QB ≥ 3** | 3.00 | **+1.16 ±1.31** | **+1.17 ±1.42** |
| QB ≥ 4 | 4.00 | **−2.69 ±1.23** | −0.83 ±1.36 |

Three quarterbacks beats V2's natural 2.41 — replicated to two decimals across two
independent runs, though each alone is only ~0.85 SE. And a 4th costs 2.2 SE at
normal timing but is near-free if you waited, which is the conditional effect that
RB refused to show. §8 is the reason: QB is flat QB2→QB24 then cliffs, so a late 3rd
is nearly as good as the 2nd, while RB supply hits zero after pick 144 and a late
5th is a body. **Flat-then-cliff rewards waiting; evaporation punishes it.**

Untested: "2 early QBs, skip the 3rd" — only 10 of 250 drafts take 2 QBs by R9, so
it needs a forced *early* start (the mirror of `posBan`). Watch also that reach-final
is positive for all three QB floors in the light branch (+0.163/+0.205/+0.174),
including the arm whose advance rate is negative — spare QBs may be cheap
knockout-week upside, at ~1.2 SE.

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
- **The 11 opponents draft to noisy ADP.** The final field no longer has to:
  `--field-sharp K` drafts K of each field pod's 12 seats with a recommender,
  alternating V1/V2 so the field is not a monoculture (an all-V2 field would penalise
  V2 specifically by making it duplicate itself). Pods are cached under
  `tools/.field-cache/`. Measured at K = 0/3/6 — see §5.3. Absolute EV is still
  inflated and there is still no leverage or uniqueness modelling. **Read the delta,
  never the level.**
- **How much stacking can pay is capped by `TEAM_FACTOR_CV` and `GAME_FACTOR_CV`**
  in the simulator's own weather model. Overridable via `SIM_TEAM_CV` / `SIM_GAME_CV`
  and stress-tested across ±40% — §5.3. The answer did not move, which retires this
  as a threat to the `V2_CORRELATION_WEIGHT` result.
- **In-season absence is now modelled** (`SIM_INJURIES`, on by default). Until it
  existed the only things that zeroed a player were a bye and a missing playoff game,
  so nobody was ever hurt and depth had no value the simulator could see — which made
  it structurally incapable of pricing the 4th-vs-5th RB question. Drawn as ONE
  CONTIGUOUS WINDOW per season, not independent weekly flips: scattered single weeks
  are absorbed easily, and losing a back for five straight is what depth actually
  covers. Calibrated off `_eff.avail` (RB 3.13 weeks simulated vs 3.06 expected, 73%
  injured, mean 4.3 weeks). **Every table dated before this was computed in a world
  without injuries and is optimistic** — reach-final fell 1.73% → 1.59% for V2 and
  1.63% → 1.38% for V1, capped EV $143.76 → $94.69 and $96.92 → $73.33.
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

### 5.3 Two robustness checks that both came out against the prediction

**Weather.** `SIM_TEAM_CV` / `SIM_GAME_CV` set the ceiling on what correlation can be
worth, and were assumed rather than measured — so the 0.35 result might have been
fitted to the simulator's tails. Swept ±40% against `V2_CORR` 0.20 / 0.35 / 0.70:

| Weather | metric | 0.20 | **0.35** | 0.70 |
|---|---|---|---|---|
| 0.24 / 0.15 | reach final | 1.43% | **1.71%** | 1.40% |
| 0.35 / 0.22 | reach final | 1.44% | **1.70%** | 1.46% |
| 0.50 / 0.32 | reach final | 1.42% | **1.66%** | 1.38% |
| 0.24 / 0.15 | 18-team EV | 2,062 | **2,880** | 2,349 |
| 0.35 / 0.22 | 18-team EV | 2,212 | **3,109** | 2,571 |
| 0.50 / 0.32 | 18-team EV | 1,897 | **2,573** | 2,304 |

Nine comparisons, 0.35 first in all nine. **The constant is not an artefact of the
assumed weather**, and calibrating those CVs against real NFL data is no longer
urgent. The prediction going in was that fatter tails would push the optimum up.

*The exception, stated because it is consistent rather than significant:* at the
1,089-team final, 0.70 edges 0.35 at all three weather settings (292/206, 180/178,
134/113). Each cell turns on <20 outright wins and the jackpot-capped EV swings on
6-15 events, so this is a hint that Millionaire-sized finals want more than 0.35 —
not a finding. Settling it needs ~10x the team-seasons aimed only at that column.

**A sharper field.** The whole 1,089-team room was ADP bots, which was the last
structural excuse for not trusting the numbers. At K = 0/3/6 model-drafted seats per
field pod (EV in ppm; advance rate and reach-final are identical across all three, as
they must be — the field only exists in week 17):

| K | 18-team V1 | 18-team V2 | Δ | 229 Δ | V1 capped EV | V2 capped EV |
|---|---|---|---|---|---|---|
| 0 | 2,844 | 3,109 | +9.3% | +15.2% | $94.79 | $140.84 |
| 3 | 2,449 | 2,932 | +19.7% | +24.2% | $88.97 | $106.90 |
| 6 | 2,406 | 3,084 | +28.2% | +34.0% | $79.52 | $115.70 |

A tougher room costs everybody — both models finish worse in the final (V1 top 27.4%
→ 28.8%, V2 24.8% → 26.2%) and both lose absolute EV. But **V1 degrades far faster
than V2** (−15% vs −1% at 18 teams), so V2's edge *widens* as the field sharpens.
The prediction going in was that it would compress, on the theory that most of V2's
margin was beating bots. It was not.

Two caveats. The sharp seats are V1 and V2 themselves, so this shows the edge is not
an artefact of bot softness — it says nothing about whether V2 beats real humans, who
draft like neither model. And the `fieldStrength` percentile readout is measured
*within* the candidate pool, so it cannot detect the pool getting stronger (51.6 →
53.0 across K); the real evidence the field toughened is that both models' finishes
and EV fell.

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

1. **Resolve the 1,089-team column.** The one place the evidence is not clean: at
   Millionaire-sized finals, `V2_CORR` 0.70 edges 0.35 at all three weather settings
   (§5.3), consistently but on <20 outright wins per cell. Everything smaller says
   0.35. Needs ~10x the team-seasons aimed only at that column — nothing else in the
   report requires the extra compute, so run it narrow rather than re-running sweeps.
   **The only live threat to a constant this project relies on.**
2. **A field that drafts like neither model.** §5.3 retired bot-softness as an
   explanation for V2's edge — sharpening the field *widened* it. But the sharp seats
   are V1 and V2 themselves, so nothing here speaks to whether V2 beats real humans,
   who draft like neither. Closing this needs actual DK draft exports as field
   rosters, not more simulation.
3. **A portfolio harness, to price diversification's benefit.** §3.1 ships a cost
   with no measured return, which is exactly the position `V2_CORRELATION_WEIGHT` was
   in before the final field was built — and it failed for the same structural reason:
   the harness models one entry at a time, and the whole point of diversification is
   what happens across twenty. The build: draft N entries with exposure accumulating
   from the model's own previous drafts, then score the portfolio jointly (payout is
   summed across entries, and P(at least one extreme finish) is the thing
   diversification buys). That makes the benefit measurable and would settle whether
   1.0 is right, too high, or far too low. Until then the constant is judgement.
4. **Yahoo** — blocked on app registration at developer.yahoo.com needing Fantasy
   Sports read permission. Error is `"This application is not authorized to perform
   this action"`, which is app-level. Code side (scope, token persistence, Python
   3.9 compat) is done.
5. **Flex modelling** — TE gets a fixed 10% flex share against a 2nd-best-TE bar
   rather than a true cross-positional contest. Known approximation; the obvious fix
   measured *worse* (§4).
6. **V2 is not the default.** `/recommend` shows V1 and V2 side by side; V1 still
   drives nothing-changed behaviour. Swapping outright is premature — three real
   errors in V2 were caught by eye in its first day (stale FA team, name mismatch,
   inflated stack).
